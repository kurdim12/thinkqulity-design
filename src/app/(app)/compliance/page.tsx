'use client';

import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Col, Collapse, Input, Row, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import { PageHeader, EmptyState, ErrorState, LoadingBlock, GroundingTag } from '@/components/ui';
import { formatDateTime } from '@/lib/date';
import type { Grounding } from '@/lib/types/db';

type SubjectType = 'concept' | 'storyboard' | 'caption' | 'freeform';

interface LawResult {
  check: string;
  passed: boolean;
  evidence: string;
  source: 'law';
  severity: 'violation' | 'warning';
  detail?: Record<string, unknown>;
}

interface JudgeViolation {
  rule: string;
  evidence: string;
  source: string;
}

interface JudgeVerdict {
  verdict: 'pass' | 'fail';
  score: number;
  violations: JudgeViolation[];
  fixes: string[];
  needs_human: boolean;
}

/** What the Judge left behind when it could not rule. Never a stand-in verdict. */
interface JudgeUnavailable {
  reason: string;
  hint: string | null;
}

/**
 * What is stored in compliance_checks.judge_verdict: either a real verdict, or
 * the recorded absence of one. Rows written before the Judge could be absent
 * carry the verdict shape, so the discriminator is the missing `status` field.
 */
type StoredVerdict = JudgeVerdict | { status: 'unavailable'; reason: string };

function isRuledVerdict(value: StoredVerdict | null | undefined): value is JudgeVerdict {
  return value !== null && value !== undefined && !('status' in value);
}

interface ComplianceCheck {
  id: string;
  passed: boolean;
  law_results: LawResult[];
  judge_status: 'ruled' | 'unavailable';
  judge_verdict: JudgeVerdict | null;
  judge_unavailable: JudgeUnavailable | null;
  needs_human: boolean;
  created_at: string;
}

interface DroppedClaim {
  claim: string;
  treatment: 'dropped' | 'hedged';
  reason: string;
}

/** A swatch the rewrite named. `hex` is null when the name resolves to nothing. */
interface PaletteUse {
  name: string;
  hex: string | null;
}

interface RewriteResponse {
  source: { text: string; law_results: LawResult[] };
  rewrite: {
    arabic: string;
    register_note: string;
    dropped_claims: DroppedClaim[];
    grounding: Grounding;
    palette_used: PaletteUse[];
    model: string;
  };
  check: ComplianceCheck;
}

interface ComplianceHistoryRow {
  id: string;
  subject_type: SubjectType;
  input_text: string;
  passed: boolean;
  created_at: string;
  law_results: LawResult[] | null;
  judge_verdict: StoredVerdict | null;
}

interface ComplianceListResponse {
  checks: ComplianceHistoryRow[];
}

const SUBJECT_TYPES: SubjectType[] = ['freeform', 'concept', 'storyboard', 'caption'];

function hasLawViolation(results: LawResult[] | null | undefined): boolean {
  return (results ?? []).some((r) => !r.passed && r.severity === 'violation');
}

/**
 * Three states, not two. A Law violation is a fail whatever the Judge said or
 * failed to say; a clean text whose Judge never ruled is neither passed nor
 * failed, and saying "PASS" there would manufacture exactly the confidence this
 * screen exists to withhold.
 */
function VerdictTag({
  passed,
  lawFailed,
  ruled,
  size = 'default',
}: {
  passed: boolean;
  lawFailed: boolean;
  ruled: boolean;
  size?: 'default' | 'large';
}) {
  const { tt } = useLocale();
  const style = size === 'large' ? { fontSize: 16, padding: '4px 12px' } : undefined;

  if (lawFailed) {
    return (
      <Tag color="red" style={style}>
        {tt('غير مطابق', 'FAIL')}
      </Tag>
    );
  }
  if (!ruled) {
    return (
      <Tag color="orange" style={style}>
        {tt('قانون فقط', 'LAW ONLY')}
      </Tag>
    );
  }
  return (
    <Tag color={passed ? 'green' : 'red'} style={style}>
      {passed ? tt('مطابق', 'PASS') : tt('غير مطابق', 'FAIL')}
    </Tag>
  );
}

/** Every Law row with its evidence visible — no click required to read it. */
function LawRows({ results }: { results: LawResult[] }) {
  const { tt } = useLocale();

  if (results.length === 0) {
    return (
      <div className="tq-muted" style={{ fontSize: 12 }}>
        {tt(
          'لا نتائج قانون محفوظة لهذا الفحص. شغّل الفحص من جديد لتوليدها.',
          'No Law results are stored for this check. Run the check again to produce them.',
        )}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {results.map((r, i) => (
        <div
          key={`${r.check}-${i}`}
          style={{ paddingInlineStart: 10, borderInlineStart: '3px solid var(--tq-line)' }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{r.check}</span>
            <Tag color={r.passed ? 'green' : r.severity === 'warning' ? 'orange' : 'red'}>
              {r.passed ? 'PASS' : r.severity.toUpperCase()}
            </Tag>
          </div>
          <div dir="auto" className="tq-ar" style={{ fontSize: 13 }}>
            {r.evidence}
          </div>
          <div className="tq-muted" style={{ fontSize: 12 }}>
            {r.detail?.heuristic
              ? tt('إرشادي — ليس حكماً', 'Heuristic — not a verdict')
              : tt('فحص حتمي', 'Deterministic check')}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The pasted draft and the generated Arabic, in the same frame. */
function TextPanel({
  heading,
  text,
  arabic,
}: {
  heading: string;
  text: string;
  arabic: boolean;
}) {
  return (
    <div>
      <h4 style={{ margin: '0 0 8px' }}>{heading}</h4>
      <div
        dir="auto"
        className={arabic ? 'tq-ar' : undefined}
        style={{
          whiteSpace: 'pre-wrap',
          background: 'var(--tq-paper)',
          border: '1px solid var(--tq-line)',
          borderRadius: 8,
          padding: 12,
          minHeight: 96,
        }}
      >
        {text}
      </div>
    </div>
  );
}

export default function CompliancePage() {
  const { tt, locale } = useLocale();
  const { notification } = App.useApp();

  const [history, setHistory] = useState<ComplianceHistoryRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [inputText, setInputText] = useState('');
  const [subjectType, setSubjectType] = useState<SubjectType>('freeform');
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<{ message: string; hint: string | null } | null>(null);

  const [result, setResult] = useState<ComplianceCheck | null>(null);

  const [rewrite, setRewrite] = useState<RewriteResponse | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteError, setRewriteError] = useState<{ message: string; hint: string | null } | null>(
    null,
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<ComplianceListResponse>('/api/compliance');
      setHistory(data.checks);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCheck = async (text: string, type: SubjectType) => {
    if (!text.trim()) return;
    setChecking(true);
    setCheckError(null);
    setRewriteError(null);
    setRewrite(null);
    try {
      const res = await apiSend<ComplianceCheck>('/api/compliance', 'POST', {
        action: 'check',
        input_text: text,
        subject_type: type,
        subject_ref: null,
      });
      setResult(res);
      load();
    } catch (err) {
      setCheckError(describeError(err));
    } finally {
      setChecking(false);
    }
  };

  const handleCheck = () => runCheck(inputText, subjectType);

  /**
   * The second leg. It does not patch the pasted English — it asks for the
   * compliant Arabic and then shows that Arabic going through the same Law and
   * the same Judge. A failing rewrite is a real outcome: it is rendered, not
   * retried away.
   */
  const handleRewrite = async () => {
    if (!inputText.trim()) return;
    setRewriting(true);
    setRewriteError(null);
    try {
      const res = await apiSend<RewriteResponse>('/api/compliance', 'POST', {
        action: 'rewrite',
        input_text: inputText,
        subject_type: subjectType,
        subject_ref: null,
      });
      setRewrite(res);
      if (res.check.needs_human) {
        notification.warning({
          message: tt('النسخة العربية تحتاج مراجعة بشرية', 'The Arabic rewrite needs human review'),
        });
      }
      load();
    } catch (err) {
      setRewriteError(describeError(err));
    } finally {
      setRewriting(false);
    }
  };

  const handleHistoryRowClick = (row: ComplianceHistoryRow) => {
    setInputText(row.input_text);
    setSubjectType(row.subject_type);
    setRewrite(null);
    setRewriteError(null);

    const stored = row.judge_verdict;
    const ruled = isRuledVerdict(stored);
    setResult({
      id: row.id,
      passed: row.passed,
      law_results: row.law_results ?? [],
      judge_status: ruled ? 'ruled' : 'unavailable',
      judge_verdict: ruled ? stored : null,
      judge_unavailable: ruled
        ? null
        : {
            reason:
              stored?.reason ??
              tt('لم يُسجَّل حكم لهذا الفحص.', 'No ruling was recorded for this check.'),
            hint: null,
          },
      needs_human: ruled ? stored.needs_human : true,
      created_at: row.created_at,
    });
  };

  const columns: ColumnsType<ComplianceHistoryRow> = [
    {
      title: tt('التاريخ', 'Date'),
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: string) => <span className="tq-num">{formatDateTime(v, locale)}</span>,
    },
    {
      title: tt('النوع', 'Subject'),
      dataIndex: 'subject_type',
      key: 'subject_type',
    },
    {
      title: tt('النتيجة', 'Result'),
      dataIndex: 'passed',
      key: 'passed',
      render: (_: unknown, row: ComplianceHistoryRow) => (
        <VerdictTag
          passed={row.passed}
          lawFailed={hasLawViolation(row.law_results)}
          ruled={isRuledVerdict(row.judge_verdict)}
        />
      ),
    },
    {
      title: tt('الدرجة', 'Score'),
      dataIndex: ['judge_verdict', 'score'],
      key: 'score',
      render: (_: unknown, row: ComplianceHistoryRow) => (
        <span className="tq-num">
          {isRuledVerdict(row.judge_verdict) ? `${row.judge_verdict.score}/100` : '—'}
        </span>
      ),
    },
    {
      title: tt('مقتطف', 'Excerpt'),
      dataIndex: 'input_text',
      key: 'input_text',
      render: (v: string) => (
        <span dir="auto" className="tq-ar">
          {v.slice(0, 60)}
          {v.length > 60 ? '…' : ''}
        </span>
      ),
    },
  ];

  const fixes = result?.judge_verdict?.fixes ?? [];

  return (
    <div className="tq-page">
      <PageHeader
        title={tt('فاحص الالتزام', 'Compliance Checker')}
        subtitle={tt(
          'الصق نصاً ليمرّ على دليل العلامة وعلى القانون، ويعود بحكم وأدلّته. النص وحده — لا الصور.',
          "Paste text and it goes through the brand guideline and the Law, then comes back with a verdict and the evidence for it. Text only, not images.",
        )}
      />

      <Card style={{ marginBlockEnd: 16 }}>
        <Input.TextArea
          dir="auto"
          rows={8}
          className="tq-ar"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={tt('الصق النص هنا…', 'Paste text here…')}
          style={{ marginBlockEnd: 12 }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Select
            value={subjectType}
            onChange={(v: SubjectType) => setSubjectType(v)}
            style={{ minWidth: 160 }}
            options={SUBJECT_TYPES.map((s) => ({ value: s, label: s }))}
          />
          <Button type="primary" loading={checking} onClick={handleCheck} disabled={!inputText.trim()}>
            {tt('فحص', 'Check')}
          </Button>
        </div>
      </Card>

      {checkError ? <ErrorState error={checkError.message} hint={checkError.hint} /> : null}

      {result ? (
        <Card style={{ marginBlockEnd: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBlockEnd: 16 }}>
            <VerdictTag
              passed={result.passed}
              lawFailed={hasLawViolation(result.law_results)}
              ruled={result.judge_status === 'ruled'}
              size="large"
            />
            <span className="tq-num" style={{ fontSize: 16 }}>
              {result.judge_verdict ? `${result.judge_verdict.score}/100` : '—'}
            </span>
          </div>

          {result.judge_unavailable ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBlockEnd: 16 }}
              message={tt('لم يصدر القاضي حكماً — القانون وحده', 'The Judge did not rule — Law only')}
              description={
                <>
                  <div>{result.judge_unavailable.reason}</div>
                  <div className="tq-muted" style={{ fontSize: 12 }}>
                    {result.judge_unavailable.hint ??
                      tt(
                        'نتائج القانون أدناه حتمية ولا تحتاج نموذجاً.',
                        'The Law results below are deterministic and need no model.',
                      )}
                  </div>
                </>
              }
            />
          ) : null}

          <Collapse
            items={[
              ...result.law_results.map((r, i) => ({
                key: `law-${i}`,
                label: (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span>{r.check}</span>
                    <Tag color={r.passed ? 'green' : r.severity === 'warning' ? 'orange' : 'red'}>
                      {r.passed ? 'PASS' : r.severity.toUpperCase()}
                    </Tag>
                  </div>
                ),
                children: (
                  <div>
                    <div dir="auto" className="tq-ar">
                      {r.evidence}
                    </div>
                    <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
                      {tt('فحص حتمي', 'Deterministic check')}
                    </div>
                    {r.detail?.heuristic ? (
                      <div className="tq-muted" style={{ fontSize: 12 }}>
                        {tt('إرشادي — ليس حكماً', 'Heuristic — not a verdict')}
                      </div>
                    ) : null}
                  </div>
                ),
              })),
              ...(result.judge_verdict?.violations ?? []).map((v, i) => ({
                key: `judge-${i}`,
                label: v.rule,
                children: (
                  <div>
                    <div dir="auto" className="tq-ar" style={{ marginBlockEnd: 8 }}>
                      {v.evidence}
                    </div>
                    <Tag>{v.source}</Tag>
                  </div>
                ),
              })),
            ]}
          />

          {fixes.length > 0 ? (
            <div style={{ marginBlockStart: 16 }}>
              <h4>{tt('الإصلاحات المقترحة', 'Suggested fixes')}</h4>
              <ol dir="auto" className="tq-ar" style={{ paddingInlineStart: 20 }}>
                {fixes.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ol>
            </div>
          ) : null}

          <div style={{ marginBlockStart: 16 }}>
            <Button type="primary" loading={rewriting} onClick={handleRewrite} disabled={!inputText.trim()}>
              {tt('اكتبها بالعربية بصيغة أحمد', "Rewrite in Ahmad's Arabic")}
            </Button>
            <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
              {tt(
                'النص العربي يولّده النموذج، ثم يمر على نفس القانون ونفس القاضي — ونتيجته تُعرض كما هي، حتى لو رسب.',
                'The Arabic is model-generated, then put through the same Law and the same Judge — and its result is shown as it comes back, including a failure.',
              )}
            </div>
          </div>

          {rewriteError ? (
            <div style={{ marginBlockStart: 16 }}>
              <ErrorState error={rewriteError.message} hint={rewriteError.hint} />
            </div>
          ) : null}

          {result.needs_human ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBlockStart: 16 }}
              message={tt('يحتاج مراجعة بشرية', 'Needs human review')}
            />
          ) : null}
        </Card>
      ) : null}

      {rewrite ? (
        <Card
          style={{ marginBlockEnd: 16 }}
          title={tt('قبل / بعد — الإنجليزية تدخل، عربية أحمد تخرج', 'Before / after — English in, his Arabic out')}
          extra={<Tag>{rewrite.rewrite.model}</Tag>}
        >
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <TextPanel
                  heading={tt('قبل — النص كما لُصق', 'Before — the text as pasted')}
                  text={rewrite.source.text}
                  arabic={false}
                />
                <LawRows results={rewrite.source.law_results} />
              </Space>
            </Col>

            <Col xs={24} lg={12}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <TextPanel
                  heading={tt('بعد — النسخة العربية المولَّدة', 'After — the generated Arabic')}
                  text={rewrite.rewrite.arabic}
                  arabic
                />
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <VerdictTag
                    passed={rewrite.check.passed}
                    lawFailed={hasLawViolation(rewrite.check.law_results)}
                    ruled={rewrite.check.judge_status === 'ruled'}
                  />
                  <span className="tq-num">
                    {rewrite.check.judge_verdict ? `${rewrite.check.judge_verdict.score}/100` : '—'}
                  </span>
                  <GroundingTag grounding={rewrite.rewrite.grounding} />
                </div>
                <LawRows results={rewrite.check.law_results} />

                {rewrite.check.judge_unavailable ? (
                  <Alert
                    type="warning"
                    showIcon
                    message={tt(
                      'لم يصدر القاضي حكماً على النسخة العربية',
                      'The Judge did not rule on the Arabic',
                    )}
                    description={
                      <>
                        <div>{rewrite.check.judge_unavailable.reason}</div>
                        {rewrite.check.judge_unavailable.hint ? (
                          <div className="tq-muted" style={{ fontSize: 12 }}>
                            {rewrite.check.judge_unavailable.hint}
                          </div>
                        ) : null}
                      </>
                    }
                  />
                ) : null}

                {(rewrite.check.judge_verdict?.violations ?? []).length > 0 ? (
                  <div>
                    <h4 style={{ margin: '0 0 8px' }}>
                      {tt('مخالفات القاضي على النسخة العربية', "The Judge's violations on the Arabic")}
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {(rewrite.check.judge_verdict?.violations ?? []).map((v, i) => (
                        <div
                          key={`rewrite-judge-${i}`}
                          style={{
                            paddingInlineStart: 10,
                            borderInlineStart: '3px solid var(--tq-gold)',
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{v.rule}</div>
                          <div dir="auto" className="tq-ar" style={{ fontSize: 13 }}>
                            {v.evidence}
                          </div>
                          <Tag>{v.source}</Tag>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </Space>
            </Col>
          </Row>

          <div style={{ marginBlockStart: 20 }}>
            <h4 style={{ margin: '0 0 8px' }}>
              {tt('ادّعاءات أُسقطت أو خُفِّفت', 'Claims dropped or hedged')}
            </h4>
            {rewrite.rewrite.dropped_claims.length === 0 ? (
              <div className="tq-muted" style={{ fontSize: 13 }}>
                {tt(
                  'لم يُبلّغ النموذج عن إسقاط أي ادّعاء. صفوف القانون أعلاه هي ما يحسم ذلك.',
                  'The model reported dropping no claim. The Law rows above are what settle that.',
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {rewrite.rewrite.dropped_claims.map((c, i) => (
                  <div
                    key={`dropped-${i}`}
                    style={{ paddingInlineStart: 10, borderInlineStart: '3px solid var(--tq-line)' }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span dir="auto" className="tq-ar" style={{ fontWeight: 600, fontSize: 13 }}>
                        {c.claim}
                      </span>
                      <Tag color={c.treatment === 'dropped' ? 'red' : 'orange'}>
                        {c.treatment === 'dropped' ? tt('أُسقط', 'dropped') : tt('خُفِّف', 'hedged')}
                      </Tag>
                    </div>
                    <div dir="auto" className="tq-ar" style={{ fontSize: 13 }}>
                      {c.reason}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginBlockStart: 20 }}>
            <h4 style={{ margin: '0 0 8px' }}>
              {tt('ألوان اللوحة المُستخدمة', 'Palette swatches used')}
            </h4>
            {rewrite.rewrite.palette_used.length === 0 ? (
              <div className="tq-muted" style={{ fontSize: 13 }}>
                {tt(
                  'لم تُسمِّ النسخة العربية أي لون من اللوحة.',
                  'The Arabic rewrite named no palette colour.',
                )}
              </div>
            ) : (
              <Space wrap size={12}>
                {rewrite.rewrite.palette_used.map((p) => (
                  <span
                    key={p.name}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                  >
                    {p.hex ? (
                      <span
                        aria-hidden
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 4,
                          background: p.hex,
                          border: '1px solid var(--tq-line)',
                        }}
                      />
                    ) : null}
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                    <span className="tq-num" style={{ fontSize: 13 }}>
                      {p.hex ?? '—'}
                    </span>
                  </span>
                ))}
              </Space>
            )}
          </div>

          <div style={{ marginBlockStart: 20 }}>
            <h4 style={{ margin: '0 0 8px' }}>{tt('ملاحظة الصياغة', 'Register note')}</h4>
            <div dir="auto" className="tq-ar" style={{ fontSize: 13 }}>
              {rewrite.rewrite.register_note}
            </div>
          </div>

          {rewrite.check.needs_human ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBlockStart: 20 }}
              message={tt('النسخة العربية تحتاج مراجعة بشرية', 'The Arabic rewrite needs human review')}
              description={tt(
                'لا تُنشر قبل أن يقرأها إنسان.',
                'Do not publish it until a human has read it.',
              )}
            />
          ) : null}
        </Card>
      ) : null}

      {loading ? <LoadingBlock rows={4} /> : null}
      {!loading && error ? <ErrorState error={error.message} hint={error.hint} onRetry={load} /> : null}
      {!loading && !error && history && history.length === 0 ? (
        <EmptyState
          title={tt('لا فحوصات بعد', 'Nothing checked yet')}
          description={tt(
            'كل فحص يبقى هنا بحكمه ودرجته ومقتطفه، فيمكنك فتحه من جديد ومقارنة صياغتين على القانون نفسه.',
            'Every check stays here with its verdict, its score and its excerpt, so you can reopen one and put two wordings through the same Law.',
          )}
          hint={tt('الصق نصاً في الأعلى واضغط فحص.', 'Paste text above and press Check.')}
        />
      ) : null}
      {!loading && !error && history && history.length > 0 ? (
        <Table<ComplianceHistoryRow>
          rowKey="id"
          columns={columns}
          dataSource={history}
          pagination={{ pageSize: 10 }}
          onRow={(row) => ({ onClick: () => handleHistoryRowClick(row), style: { cursor: 'pointer' } })}
        />
      ) : null}
    </div>
  );
}
