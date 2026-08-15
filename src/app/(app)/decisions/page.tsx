'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import {
  PageHeader,
  EmptyState,
  ErrorState,
  LoadingBlock,
  GroundingTag,
} from '@/components/ui';
import { formatDate, formatDateTime, formatNumber } from '@/lib/date';
import { GOLD } from '@/lib/theme';
import type { BasisRef, DecisionKind, DecisionRow, DecisionStatus } from '@/lib/types/db';

/**
 * The decision ledger — every decision this system has committed to, and what
 * became of it.
 *
 * The digest screen shows one week and the open decisions that week is
 * accountable to. This screen shows the whole memory: the validated, the
 * refuted, the superseded and the ones still waiting for their date. Four
 * properties of the ledger shape everything below:
 *
 * 1. A DECISION IS JUDGED, OR IT IS STILL OPEN. There is no 'closed'. A
 *    decision nobody read the outcome of stays open and stays visible, which is
 *    the entire mechanism — so the review-due badge is the loudest thing on the
 *    row, and the default filter is the open ones.
 * 2. THE FENCE IS TWO COLUMNS NOW, NOT PROSE. `decisions.cap` and
 *    `decisions.kill_condition` are real columns as of migration 0004. They are
 *    read from those columns and rendered verbatim; nothing here parses them
 *    back out of `expected_signal`. A null renders as an em-dash and means "no
 *    cap was stated" — never "unlimited" (hard rule 2).
 * 3. THE VERDICT IS A HUMAN ACT. An operator records validated / refuted /
 *    superseded with a note. There is no path back to open, no way to edit a
 *    verdict already recorded, and nothing on this screen sends anything or
 *    marks any digest as sent (hard rule 1).
 * 4. EVERY STATEMENT CARRIES ITS RECEIPT. `basis` is the source keys the
 *    context blocks emitted and the values they rendered, VERBATIM. Expand a
 *    row to read them. The values are printed exactly as stored — never through
 *    formatNumber(), never re-rounded — because they have to equal the block
 *    line character for character.
 */

/* ------------------------------------------------------------- the responses -- */

interface LedgerDecision extends DecisionRow {
  /** Open, and its review date has arrived. Computed by the route, in Amman. */
  past_review: boolean;
}

interface DecisionsResponse {
  decisions: LedgerDecision[];
  /** Counts of the rows that were READ. Not the table's totals when truncated. */
  counts: Record<DecisionStatus, number>;
  due_for_review: number;
  truncated: boolean;
  scan_limit: number;
  /** The route's own Amman date — what `past_review` was computed against. */
  today: string;
}

/** The three verdicts an operator may record. 'extended' is not one of them. */
type Verdict = 'validated' | 'refuted' | 'superseded';

/* ----------------------------------------------------------------- helpers -- */

/**
 * The single gate between a stored value and the screen. Absent is an em-dash,
 * never 0 and never the word "undefined" (hard rule 2).
 */
function textOrDash(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.trim().length === 0 ? '—' : value;
}

/** A plain Latin number stays LTR and tabular inside an RTL page (hard rule 5). */
const LATIN_NUMERIC = /^[+-]?\d+(?:\.\d+)?$/;

const KIND_COLOURS: Record<DecisionKind, string> = {
  recommendation: 'blue',
  experiment: 'purple',
  alert: 'red',
  escalation: 'volcano',
};

const STATUS_COLOURS: Record<DecisionStatus, string> = {
  open: 'default',
  validated: 'green',
  refuted: 'red',
  superseded: 'gold',
};

const FILTERS: readonly (DecisionStatus | 'all')[] = [
  'open',
  'validated',
  'refuted',
  'superseded',
  'all',
];

const VERDICTS: readonly Verdict[] = ['validated', 'refuted', 'superseded'];

/* -------------------------------------------------------------------- basis -- */

/**
 * The receipt under a decision: the key of the block line it came from, and
 * that line's value exactly as rendered there.
 *
 * An empty basis is not automatically a fault — a hypothesis may cite nothing,
 * and the commonest honest reason is that the measurement it wanted was never
 * taken (an absence emits no key at all). So the empty case says what it is.
 */
function BasisList({ basis }: { basis: BasisRef[] }) {
  const { tt } = useLocale();

  if (basis.length === 0) {
    return (
      <span className="tq-muted" style={{ fontSize: 12 }}>
        <span className="tq-num">—</span>{' '}
        {tt('لا سند مُسجَّل مع هذا القرار.', 'No receipt is recorded with this decision.')}
      </span>
    );
  }

  return (
    <ul style={{ margin: 0, paddingInlineStart: 16, fontSize: 12, listStyle: 'none' }}>
      {basis.map((ref, index) => (
        <li key={`${ref.source_key}-${index}`} style={{ marginBlockStart: index === 0 ? 0 : 4 }}>
          {/* An ASCII dotted path: dir="ltr" keeps it readable inside an Arabic
              sentence and stops its dots reordering. */}
          <code
            dir="ltr"
            style={{
              background: 'rgba(28, 27, 25, 0.05)',
              paddingInline: 5,
              paddingBlock: 1,
              borderRadius: 4,
            }}
          >
            {ref.source_key}
          </code>{' '}
          <span className="tq-muted">=</span>{' '}
          {LATIN_NUMERIC.test(ref.value) ? (
            <span className="tq-num">{ref.value}</span>
          ) : (
            <span dir="auto">“{ref.value}”</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ the page -- */

export default function DecisionsPage() {
  const { t, tt, locale } = useLocale();
  const { notification } = App.useApp();

  const [decisions, setDecisions] = useState<LedgerDecision[]>([]);
  const [counts, setCounts] = useState<Record<DecisionStatus, number> | null>(null);
  const [dueCount, setDueCount] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scanLimit, setScanLimit] = useState<number | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [filter, setFilter] = useState<DecisionStatus | 'all'>('open');

  // The outcome recorder. `target` is the decision being judged; null closes it.
  const [target, setTarget] = useState<LedgerDecision | null>(null);
  const [verdict, setVerdict] = useState<Verdict>('validated');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; hint: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<DecisionsResponse>('/api/decisions');
      setDecisions(data.decisions ?? []);
      setCounts(data.counts);
      setDueCount(data.due_for_review);
      setTruncated(data.truncated);
      setScanLimit(data.scan_limit);
      setToday(data.today);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const kindLabel = useCallback(
    (kind: DecisionKind): string => {
      if (kind === 'recommendation') return tt('توصية', 'Recommendation');
      if (kind === 'experiment') return tt('تجربة', 'Experiment');
      if (kind === 'alert') return tt('تنبيه', 'Alert');
      return tt('تصعيد', 'Escalation');
    },
    [tt],
  );

  const statusLabel = useCallback(
    (status: DecisionStatus): string => {
      if (status === 'open') return tt('مفتوح', 'Open');
      if (status === 'validated') return tt('تأكّد', 'Validated');
      if (status === 'refuted') return tt('نُقض', 'Refuted');
      return tt('حلّ محلّه غيره', 'Superseded');
    },
    [tt],
  );

  const filterLabel = useCallback(
    (value: DecisionStatus | 'all'): string =>
      value === 'all' ? tt('الكل', 'All') : statusLabel(value),
    [statusLabel, tt],
  );

  const shown = useMemo(
    () => (filter === 'all' ? decisions : decisions.filter((d) => d.status === filter)),
    [decisions, filter],
  );

  const openRecorder = useCallback((decision: LedgerDecision) => {
    setTarget(decision);
    setVerdict('validated');
    setNote('');
    setSaveError(null);
  }, []);

  const recordOutcome = useCallback(async () => {
    if (target === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiSend<{ decision: DecisionRow }>('/api/decisions', 'PATCH', {
        id: target.id,
        status: verdict,
        outcome_note: note,
      });
      notification.success({
        message: tt('سُجِّلت النتيجة', 'Outcome recorded'),
        description: tt(
          'دُوّنت في السجل باسمها وتاريخها. لا يُعاد فتح القرار من هذه الشاشة.',
          'It is written into the ledger with its note. A decision is not reopened from this screen.',
        ),
      });
      setTarget(null);
      await load();
    } catch (err) {
      setSaveError(describeError(err));
    } finally {
      setSaving(false);
    }
  }, [target, verdict, note, notification, tt, load]);

  const columns: ColumnsType<LedgerDecision> = [
    {
      title: tt('النوع', 'Kind'),
      dataIndex: 'kind',
      key: 'kind',
      width: 130,
      render: (_: unknown, row: LedgerDecision) => (
        <Tag color={KIND_COLOURS[row.kind]} style={{ marginInlineEnd: 0 }}>
          {kindLabel(row.kind)}
        </Tag>
      ),
    },
    {
      title: tt('القرار', 'Decision'),
      dataIndex: 'statement_ar',
      key: 'statement_ar',
      width: 320,
      render: (_: unknown, row: LedgerDecision) => (
        <span dir="auto" className="tq-ar">
          {textOrDash(row.statement_ar)}
        </span>
      ),
    },
    {
      title: tt('السند', 'Grounding'),
      dataIndex: 'grounding',
      key: 'grounding',
      width: 110,
      render: (_: unknown, row: LedgerDecision) => <GroundingTag grounding={row.grounding} />,
    },
    {
      title: tt('الحالة', 'Status'),
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (_: unknown, row: LedgerDecision) => (
        <Tag color={STATUS_COLOURS[row.status]} style={{ marginInlineEnd: 0 }}>
          {statusLabel(row.status)}
        </Tag>
      ),
    },
    {
      title: tt('يُحكم عليه بعد', 'To be judged after'),
      dataIndex: 'review_after',
      key: 'review_after',
      width: 190,
      sorter: (a: LedgerDecision, b: LedgerDecision) =>
        a.review_after < b.review_after ? -1 : a.review_after > b.review_after ? 1 : 0,
      render: (_: unknown, row: LedgerDecision) => (
        <Space direction="vertical" size={2}>
          <span className="tq-num">{formatDate(row.review_after, locale)}</span>
          {row.past_review ? (
            <Tag color="red" style={{ marginInlineEnd: 0 }}>
              {tt('حان موعد مراجعته', 'Due for review')}
            </Tag>
          ) : null}
        </Space>
      ),
    },
    {
      title: tt('السقف', 'Cap'),
      dataIndex: 'cap',
      key: 'cap',
      width: 180,
      render: (_: unknown, row: LedgerDecision) => (
        // Read from the column, verbatim. Null is an em-dash: no cap was
        // stated, which is not the same as no limit.
        <span dir="auto">{textOrDash(row.cap)}</span>
      ),
    },
    {
      title: tt('شرط الإيقاف', 'Kill condition'),
      dataIndex: 'kill_condition',
      key: 'kill_condition',
      width: 200,
      render: (_: unknown, row: LedgerDecision) => (
        <span dir="auto">{textOrDash(row.kill_condition)}</span>
      ),
    },
    {
      title: tt('ما وجدته المراجعة', 'What the review found'),
      dataIndex: 'outcome_note',
      key: 'outcome_note',
      width: 260,
      render: (_: unknown, row: LedgerDecision) => (
        // Null means nobody has judged it. Unreviewed is not the same as fine,
        // so it is an em-dash and never a reassuring blank.
        <span dir="auto">{textOrDash(row.outcome_note)}</span>
      ),
    },
    {
      title: tt('تسجيل النتيجة', 'Record outcome'),
      key: 'record',
      width: 150,
      fixed: 'right',
      render: (_: unknown, row: LedgerDecision) =>
        row.status === 'open' ? (
          <Button size="small" onClick={() => openRecorder(row)}>
            {tt('سجّل', 'Record')}
          </Button>
        ) : (
          <span className="tq-muted" style={{ fontSize: 12 }}>
            {tt('حُكم عليه', 'Judged')}
          </span>
        ),
    },
  ];

  const isEmpty = !loading && !error && decisions.length === 0;

  return (
    <div className="tq-page">
      <PageHeader
        title={tt('سجل القرارات', 'Decision ledger')}
        subtitle={tt(
          'كل قرار كُتب قبل أن تُعرف نتيجته، والدليل الذي استند إليه، وتاريخ الحكم عليه، وما وجدته المراجعة.',
          'Every decision written down before its result was known — the evidence it rests on, the date it gets judged, and what the review found.',
        )}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message={tt('الحكم هنا فعل إنسان', 'The verdict here is a human act')}
        description={tt(
          'تُسجَّل النتيجة بيد المشغّل بعد أن يقرأ ما حدث فعلاً، مع ملاحظة تشرحها — حالة بلا سبب ليست مراجعة. لا يُعاد فتح قرار حُكم عليه، ولا تُعدَّل نتيجة مسجَّلة من هذه الشاشة، ولا يُرسل من هنا شيء إلى أحد.',
          'An outcome is recorded by the operator after reading what actually happened, with a note that says what it was — a status with no reason is not a review. A judged decision is not reopened, a recorded verdict is not edited from this screen, and nothing here is sent to anyone.',
        )}
      />

      {loading ? <LoadingBlock rows={6} /> : null}
      {!loading && error ? (
        <ErrorState error={error.message} hint={error.hint} onRetry={() => void load()} />
      ) : null}

      {isEmpty ? (
        <EmptyState
          description={tt(
            'لا يوجد قرار في السجل بعد. القرار يكتبه تشغيل واحد للاستراتيجي في شاشة التقرير الأسبوعي: هو ما يلتزم به التقرير، ومعه سنده وتاريخ الحكم عليه. لا شيء آخر في هذا التطبيق يكتب قراراً.',
            'No decision is on the ledger yet. A decision is written by one strategist run on the Weekly digest screen: it is what that digest commits to, carrying its evidence and the date it is to be judged on. Nothing else in this app writes one.',
          )}
          actionLabel={tt('إلى التقرير الأسبوعي', 'Go to the weekly digest')}
          href="/digest"
        />
      ) : null}

      {!loading && !error && decisions.length > 0 ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Card size="small">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
                <Descriptions.Item label={tt('قرارات مُحمَّلة', 'Decisions loaded')}>
                  <span className="tq-num">{formatNumber(decisions.length)}</span>
                </Descriptions.Item>
                <Descriptions.Item label={tt('مفتوحة', 'Open')}>
                  <span className="tq-num">{formatNumber(counts?.open ?? null)}</span>
                </Descriptions.Item>
                <Descriptions.Item label={tt('حان موعد مراجعتها', 'Due for review')}>
                  <span className="tq-num">{formatNumber(dueCount)}</span>
                </Descriptions.Item>
                <Descriptions.Item label={tt('محسوبة مقابل تاريخ', 'Computed against')}>
                  <span className="tq-num">{formatDate(today, locale)}</span>
                </Descriptions.Item>
              </Descriptions>

              <Segmented
                value={filter}
                onChange={(value) => setFilter(value as DecisionStatus | 'all')}
                options={FILTERS.map((value) => ({
                  value,
                  label: (
                    <span>
                      {filterLabel(value)}{' '}
                      <span className="tq-num">
                        {formatNumber(
                          value === 'all'
                            ? decisions.length
                            : counts === null
                              ? null
                              : counts[value],
                        )}
                      </span>
                    </span>
                  ),
                }))}
              />

              <span className="tq-muted" style={{ fontSize: 12 }}>
                {tt(
                  'المرشِّح يعمل على القراءة نفسها المعروضة أعلاه، فالأعداد المذكورة هنا هي أعداد الصفوف الموجودة تحتها بالضبط.',
                  'The filter works on the one read shown above, so the counts beside each chip are exactly the rows underneath them.',
                )}
              </span>
            </Space>
          </Card>

          {truncated ? (
            <Alert
              type="warning"
              showIcon
              message={tt('قراءة السجل بلغت سقفها', 'The ledger read filled its cap')}
              description={
                <>
                  {tt('عُرض أحدث ', 'The newest ')}
                  <span className="tq-num">{formatNumber(scanLimit)}</span>
                  {tt(
                    ' قرار فقط، وما قبلها لم تصل إليه القراءة. ما لم تصل إليه القراءة لا يُعدّ من نتيجتها، فالأعداد أعلاه أعداد المعروض لا أعداد الجدول.',
                    ' decisions are shown and the ledger continues past them. What a capped read never reached cannot be counted from its result, so the figures above are counts of what is shown, not totals of the table.',
                  )}
                </>
              }
            />
          ) : null}

          <Table<LedgerDecision>
            rowKey="id"
            columns={columns}
            dataSource={shown}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            scroll={{ x: 1500 }}
            expandable={{
              expandedRowRender: (row: LedgerDecision) => (
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <div>
                    <div className="tq-muted" style={{ fontSize: 12 }}>
                      {tt('ما يثبته أو ينفيه', 'What would prove or refute it')}
                    </div>
                    <span dir="auto">{textOrDash(row.expected_signal)}</span>
                  </div>
                  <div>
                    <div className="tq-muted" style={{ fontSize: 12 }}>
                      {tt('السند', 'The receipt')}
                    </div>
                    <BasisList basis={row.basis ?? []} />
                  </div>
                  <div className="tq-muted" style={{ fontSize: 12 }}>
                    {tt('كُتب في ', 'Written ')}
                    <span className="tq-num">{formatDateTime(row.created_at, locale)}</span>
                  </div>
                </Space>
              ),
            }}
          />

          {shown.length === 0 ? (
            <span className="tq-muted">
              {tt(
                'لا قرار بهذه الحالة ضمن المعروض.',
                'No decision in this state among the ones shown.',
              )}
            </span>
          ) : null}
        </Space>
      ) : null}

      <Modal
        open={target !== null}
        title={tt('تسجيل نتيجة قرار', 'Record the outcome of a decision')}
        okText={tt('سجّل النتيجة', 'Record it')}
        cancelText={t.common.cancel}
        confirmLoading={saving}
        okButtonProps={{ disabled: note.trim().length === 0 }}
        onCancel={() => setTarget(null)}
        onOk={() => void recordOutcome()}
        width={640}
      >
        {target === null ? null : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div
              style={{
                borderInlineStart: `3px solid ${GOLD}`,
                paddingInlineStart: 12,
              }}
            >
              <span dir="auto" className="tq-ar" style={{ fontSize: 15 }}>
                {textOrDash(target.statement_ar)}
              </span>
              <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 4 }}>
                {tt('ما يثبته أو ينفيه: ', 'What would prove or refute it: ')}
                <span dir="auto">{textOrDash(target.expected_signal)}</span>
              </div>
            </div>

            <div>
              <div style={{ marginBlockEnd: 4, fontSize: 13 }}>{tt('الحكم', 'Verdict')}</div>
              <Select<Verdict>
                value={verdict}
                onChange={(value) => setVerdict(value)}
                style={{ minWidth: 220 }}
                options={VERDICTS.map((value) => ({ value, label: statusLabel(value) }))}
              />
              <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 6 }}>
                {tt(
                  'التمديد ليس من بين الخيارات هنا. إن كان القرار يحتاج وقتاً أطول فمكان تلك الحجّة هو التقرير القادم — لا سحب تاريخ المراجعة إلى الأمام حتى لا يُحكم عليه أبداً.',
                  'Extending is deliberately not offered here. If a decision needs longer, the next digest is where that case gets made — sliding the review date forward is how a decision never gets judged at all.',
                )}
              </div>
            </div>

            <div>
              <div style={{ marginBlockEnd: 4, fontSize: 13 }}>
                {tt('ما وجدته المراجعة', 'What the review found')}
              </div>
              <Input.TextArea
                dir="auto"
                className="tq-ar"
                rows={4}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={2000}
                showCount
                placeholder={tt(
                  'ما الذي لوحظ فعلاً؟ حالة بلا سبب ليست مراجعة.',
                  'What was actually observed? A status with no reason is not a review.',
                )}
              />
            </div>

            {saveError ? <ErrorState error={saveError.message} hint={saveError.hint} /> : null}
          </Space>
        )}
      </Modal>
    </div>
  );
}
