'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Segmented,
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
  ArabicText,
  GroundingTag,
  WarningList,
} from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/date';
import { GOLD } from '@/lib/theme';
import type { Account, AudienceInsightRow, TimingCell, TimingReport } from '@/lib/types/db';

/**
 * The Audience screen — what the comment corpus says, and when the posts that
 * attracted it went out.
 *
 * Two provenance rules shape everything here:
 *
 * - Themes, questions and register come from the model and are verified against
 *   the stored comments server-side. Each theme carries its own `n` and its own
 *   grounding tag, and every quote is rendered verbatim with the post it came
 *   from. A quote whose post has no URL still renders — the link is simply
 *   absent, as an em-dash (hard rule 2).
 * - The heatmap is arithmetic, not opinion (hard rule 11). Every figure in it is
 *   computed by buildTiming() from posted_at x engagement, and each cell's n
 *   travels with it into the tooltip, the aria-label and the text table.
 */

type AudienceScope = Account | 'all';

/**
 * The `timing` jsonb carries three keys beyond TimingReport, added by
 * buildTiming()/persist(). They are optional here because a row written before
 * they existed would not have them — an absent one renders as an em-dash rather
 * than a guess.
 */
interface StoredTiming extends TimingReport {
  min_window_n?: number;
  time_zone?: string;
  /** The model may NAME the shape; every number beside it is computed in code. */
  pattern_name_ar?: string | null;
}

interface AudienceInsight extends Omit<AudienceInsightRow, 'timing'> {
  timing: StoredTiming | null;
}

/**
 * One capped read of `posts`, in BOTH units. The table is UNIQUE
 * (snapshot_id, ig_id), so its rows are post-per-snapshot and a row count is not
 * a post count — `duplicates_collapsed` is how many rows were re-scrapes of a
 * post already counted. `truncated` means the query filled its cap, so the
 * figures are a prefix of the table; a prefix shown as a total is a fabricated
 * number, which is why the flag is rendered rather than logged and dropped.
 *
 * There is deliberately no "rows missing" figure anywhere below: what a capped
 * query never saw is unknowable from its result, so the notice says "the first
 * N rows", never "N of M".
 */
interface AudiencePopulationScan {
  rows_fetched: number;
  limit: number;
  truncated: boolean;
  /** Rows left once re-scrapes were collapsed. */
  posts: number;
  duplicates_collapsed: number;
  snapshots_seen: number;
}

/**
 * Everything the STORED report covers: the scope it was read under, the corpus
 * that reached the model, and the two separate reads of `posts` — one that gave
 * the quotes their source links, one the timing grid was computed over. They are
 * reported separately because they measure different things and can diverge.
 *
 * These are recorded when the insight is generated and read back with it. They
 * are never recomputed on load: a read of `posts` performed today describes
 * today's rows, and wrapping stored numbers in a population that is not theirs
 * would be a fabricated frame around honest figures.
 */
interface AudienceReportPopulation {
  account: AudienceScope;
  comments: {
    /** Comments that reached the model, after unattributed ones were dropped. */
    read: number;
    cap: number;
    truncated: boolean;
    /** Read but left out: no post to hang a quote's provenance on. */
    unattributed: number;
  };
  post_index: AudiencePopulationScan;
  timing_posts: AudiencePopulationScan;
}

interface AudienceGetResponse {
  insight: AudienceInsight | null;
  /** null means "not counted", not "none" — it renders as an em-dash. */
  comments: number | null;
  /** null for a row stored before the population was recorded — stated, not filled in. */
  population: AudienceReportPopulation | null;
  hint: string | null;
}

/**
 * The half of POST's response this screen reads. The route returns more — token
 * usage, and the run's own corpus and post-index blocks. Everything that
 * describes the stored report is read back through GET instead, so exactly one
 * code path renders it whether or not this session generated it.
 */
interface AudienceGenerateResponse {
  model: string;
  result: { warnings: string[] };
  persisted: {
    /** Everything verification threw away, verbatim. Shown, never swallowed. */
    dropped: string[];
    needs_human: boolean;
    judge_score: number | null;
  };
  corpus: { size: number };
  /** Set when this run's coverage could not be written onto the stored row. */
  population_storage_error: string | null;
}

/* -------------------------------------------------------------- constants -- */

const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

/** 0 = Sunday, matching TimingCell.weekday. */
const WEEKDAYS: { ar: string; en: string; arShort: string; enShort: string }[] = [
  { ar: 'الأحد', en: 'Sunday', arShort: 'أحد', enShort: 'Sun' },
  { ar: 'الاثنين', en: 'Monday', arShort: 'اثنين', enShort: 'Mon' },
  { ar: 'الثلاثاء', en: 'Tuesday', arShort: 'ثلاثاء', enShort: 'Tue' },
  { ar: 'الأربعاء', en: 'Wednesday', arShort: 'أربعاء', enShort: 'Wed' },
  { ar: 'الخميس', en: 'Thursday', arShort: 'خميس', enShort: 'Thu' },
  { ar: 'الجمعة', en: 'Friday', arShort: 'جمعة', enShort: 'Fri' },
  { ar: 'السبت', en: 'Saturday', arShort: 'سبت', enShort: 'Sat' },
];

/** GOLD as "r, g, b" so cell fills can vary alpha without re-declaring the hex. */
function hexToRgbTriplet(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

const GOLD_RGB = hexToRgbTriplet(GOLD);

/**
 * "No posts here" and "posts here, but they did poorly" are different facts, so
 * they must not share a visual language. An empty cell is hatched and outlined
 * in a dashed line with no fill at all; a measured cell always carries a solid
 * fill and a solid border, even at the bottom of the ramp.
 */
const EMPTY_CELL_STYLE: React.CSSProperties = {
  background:
    'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(28, 27, 25, 0.1) 3px, rgba(28, 27, 25, 0.1) 4px)',
  border: '1px dashed rgba(28, 27, 25, 0.28)',
};

const MEASURED_CELL_BORDER = '1px solid rgba(28, 27, 25, 0.08)';

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/* ------------------------------------------------------------- the heatmap -- */

interface TimingRow {
  key: string;
  weekday: number;
  hour: number;
  n: number;
  avg_engagement: number | null;
}

function TimingHeatmap({ timing }: { timing: StoredTiming }) {
  const { tt, locale, isRTL } = useLocale();

  /**
   * The ramp's low end has to sit beside the low label. Those labels flank the
   * bar in DOM order, so <html dir="rtl"> flips them — and a physical `to right`
   * would not flip with them, leaving the legend reading backwards in the
   * primary locale. There is no logical direction keyword for gradients, so the
   * axis is resolved from the page direction instead.
   */
  const rampAxis = isRTL ? 'to left' : 'to right';

  /** Never assume the array order — index it by (weekday, hour). */
  const grid = useMemo(() => {
    const rows: (TimingCell | null)[][] = Array.from({ length: DAYS_PER_WEEK }, () =>
      Array.from({ length: HOURS_PER_DAY }, () => null),
    );
    for (const cell of timing.cells) {
      if (cell.weekday < 0 || cell.weekday >= DAYS_PER_WEEK) continue;
      if (cell.hour < 0 || cell.hour >= HOURS_PER_DAY) continue;
      rows[cell.weekday][cell.hour] = cell;
    }
    return rows;
  }, [timing.cells]);

  /** The ramp is anchored to the measured extremes, so it never invents a top. */
  const { minAvg, maxAvg, measuredCells } = useMemo(() => {
    const averages: number[] = [];
    for (const cell of timing.cells) {
      if (cell.n > 0 && cell.avg_engagement !== null) averages.push(cell.avg_engagement);
    }
    if (averages.length === 0) return { minAvg: null, maxAvg: null, measuredCells: 0 };
    return {
      minAvg: Math.min(...averages),
      maxAvg: Math.max(...averages),
      measuredCells: averages.length,
    };
  }, [timing.cells]);

  const bestHours = useMemo(() => {
    const hours = new Set<number>();
    for (const window of timing.best_windows) {
      const [start, end] = window.hours;
      for (let hour = start; hour < end; hour += 1) hours.add(hour % HOURS_PER_DAY);
    }
    return hours;
  }, [timing.best_windows]);

  const fillFor = useCallback(
    (avg: number): string => {
      if (minAvg === null || maxAvg === null) return `rgba(${GOLD_RGB}, 0.6)`;
      const span = maxAvg - minAvg;
      // A single measured value is the whole ramp; it is not a "low" reading.
      const t = span > 0 ? (avg - minAvg) / span : 1;
      return `rgba(${GOLD_RGB}, ${(0.18 + 0.82 * t).toFixed(3)})`;
    },
    [minAvg, maxAvg],
  );

  const describeCell = useCallback(
    (weekday: number, hour: number, cell: TimingCell | null): string => {
      const day = locale === 'ar' ? WEEKDAYS[weekday].ar : WEEKDAYS[weekday].en;
      const when = `${day} ${hourLabel(hour)}`;
      if (cell === null) {
        return tt(`${when} — غير مُبلَّغ عنها`, `${when} — not reported`);
      }
      if (cell.n === 0 || cell.avg_engagement === null) {
        return tt(`${when} — لا منشورات`, `${when} — no posts`);
      }
      return tt(
        `${when} — ${formatNumber(cell.n)} منشور، متوسط التفاعل ${formatNumber(cell.avg_engagement)}`,
        `${when} — ${formatNumber(cell.n)} post(s), average engagement ${formatNumber(cell.avg_engagement)}`,
      );
    },
    [locale, tt],
  );

  const tableRows = useMemo<TimingRow[]>(
    () =>
      timing.cells.map((cell) => ({
        key: `${cell.weekday}-${cell.hour}`,
        weekday: cell.weekday,
        hour: cell.hour,
        n: cell.n,
        avg_engagement: cell.avg_engagement,
      })),
    [timing.cells],
  );

  const columns: ColumnsType<TimingRow> = [
    {
      title: tt('اليوم', 'Day'),
      dataIndex: 'weekday',
      key: 'weekday',
      render: (_: unknown, row: TimingRow) =>
        WEEKDAYS[row.weekday]
          ? tt(WEEKDAYS[row.weekday].ar, WEEKDAYS[row.weekday].en)
          : '—',
    },
    {
      title: tt('الساعة', 'Hour'),
      dataIndex: 'hour',
      key: 'hour',
      render: (_: unknown, row: TimingRow) => <span className="tq-num">{hourLabel(row.hour)}</span>,
      sorter: (a: TimingRow, b: TimingRow) => a.hour - b.hour,
    },
    {
      title: tt('عدد المنشورات (n)', 'Posts (n)'),
      dataIndex: 'n',
      key: 'n',
      render: (_: unknown, row: TimingRow) => <span className="tq-num">{formatNumber(row.n)}</span>,
      sorter: (a: TimingRow, b: TimingRow) => a.n - b.n,
    },
    {
      title: tt('متوسط التفاعل', 'Average engagement'),
      dataIndex: 'avg_engagement',
      key: 'avg_engagement',
      render: (_: unknown, row: TimingRow) => (
        <span className="tq-num">{formatNumber(row.avg_engagement)}</span>
      ),
      // An unmeasured cell has no average at all, so it sorts below every
      // measured one rather than being treated as a zero.
      sorter: (a: TimingRow, b: TimingRow) =>
        (a.avg_engagement ?? Number.NEGATIVE_INFINITY) -
        (b.avg_engagement ?? Number.NEGATIVE_INFINITY),
    },
  ];

  const hasMeasurements = timing.total_n > 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} bordered>
        <Descriptions.Item label={tt('متوسط التفاعل العام', 'Overall average')}>
          {/* total_n === 0 makes overall_avg a placeholder zero, not a measurement. */}
          <span className="tq-num">
            {hasMeasurements ? formatNumber(timing.overall_avg) : '—'}
          </span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('المنشورات المقيسة (n)', 'Posts measured (n)')}>
          <span className="tq-num">{formatNumber(timing.total_n)}</span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('المنطقة الزمنية', 'Time zone')}>
          <span className="tq-num">{timing.time_zone ?? '—'}</span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('أدنى n للنافذة', 'Minimum n per window')}>
          <span className="tq-num">
            {timing.min_window_n === undefined ? '—' : formatNumber(timing.min_window_n)}
          </span>
        </Descriptions.Item>
      </Descriptions>

      <div>
        <strong>{tt('أفضل النوافذ', 'Best windows')}</strong>
        <div style={{ marginBlockStart: 8 }}>
          {timing.best_windows.length === 0 ? (
            <span className="tq-muted">
              {timing.min_window_n === undefined
                ? tt(
                    'لا توجد نافذة تتجاوز المتوسط العام بعدد منشورات كافٍ.',
                    'No window beats the overall average on enough posts.',
                  )
                : tt(
                    `لا توجد نافذة تتجاوز المتوسط العام وتستند إلى ${formatNumber(timing.min_window_n)} منشور على الأقل.`,
                    `No window beats the overall average while resting on at least ${formatNumber(timing.min_window_n)} post(s).`,
                  )}
            </span>
          ) : (
            <Space wrap size={8}>
              {timing.best_windows.map((window) => (
                <Tag key={window.label} color="gold" style={{ marginInlineEnd: 0, paddingBlock: 2 }}>
                  <span className="tq-num">{window.label}</span>
                  {' · '}
                  <span className="tq-num">×{window.multiple_vs_overall}</span>
                  {' · '}
                  <span className="tq-num">n = {formatNumber(window.n)}</span>
                  {' · '}
                  <span className="tq-num">
                    {tt('متوسط', 'avg')} {formatNumber(window.avg_engagement)}
                  </span>
                </Tag>
              ))}
            </Space>
          )}
        </div>
      </div>

      {/* The hour axis is data, so it stays LTR in both locales — 00 on the
          start edge, 23 on the end edge, whichever way the page reads. */}
      <div style={{ overflowX: 'auto', paddingBlockEnd: 4 }}>
        <div
          dir="ltr"
          role="group"
          aria-label={tt(
            'خريطة حرارية: ساعة النشر × يوم الأسبوع، مرجّحة بمتوسط التفاعل.',
            'Heatmap: posting hour by weekday, weighted by average engagement.',
          )}
          style={{
            display: 'grid',
            gridTemplateColumns: `56px repeat(${HOURS_PER_DAY}, minmax(26px, 1fr))`,
            gap: 2,
            minWidth: 700,
          }}
        >
          <div aria-hidden="true" />
          {Array.from({ length: HOURS_PER_DAY }, (_, hour) => (
            <div
              key={`hour-${hour}`}
              aria-hidden="true"
              style={{
                fontSize: 10,
                textAlign: 'center',
                paddingBlockEnd: 2,
                fontWeight: bestHours.has(hour) ? 700 : 400,
                borderBlockEnd: bestHours.has(hour) ? `2px solid ${GOLD}` : '2px solid transparent',
              }}
            >
              <span className="tq-num">{String(hour).padStart(2, '0')}</span>
            </div>
          ))}

          {grid.map((row, weekday) => (
            <div key={`row-${weekday}`} style={{ display: 'contents' }}>
              <div
                dir="auto"
                aria-hidden="true"
                style={{
                  fontSize: 11,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  paddingInlineEnd: 6,
                }}
              >
                {tt(WEEKDAYS[weekday].arShort, WEEKDAYS[weekday].enShort)}
              </div>
              {row.map((cell, hour) => {
                const measured = cell !== null && cell.n > 0 && cell.avg_engagement !== null;
                const label = describeCell(weekday, hour, cell);
                return (
                  <div
                    key={`cell-${weekday}-${hour}`}
                    role="img"
                    aria-label={label}
                    title={label}
                    style={{
                      height: 26,
                      borderRadius: 3,
                      ...(measured && cell !== null && cell.avg_engagement !== null
                        ? {
                            background: fillFor(cell.avg_engagement),
                            border: MEASURED_CELL_BORDER,
                          }
                        : EMPTY_CELL_STYLE),
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <Space wrap size={16} align="center">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            aria-hidden="true"
            style={{ width: 18, height: 18, borderRadius: 3, ...EMPTY_CELL_STYLE }}
          />
          <span className="tq-muted" style={{ fontSize: 12 }}>
            {tt('لا منشورات في هذه الخانة', 'No posts in this cell')}
          </span>
        </span>

        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="tq-num" style={{ fontSize: 12 }}>
            {minAvg === null ? '—' : formatNumber(minAvg)}
          </span>
          <span
            aria-hidden="true"
            style={{
              width: 96,
              height: 12,
              borderRadius: 3,
              border: MEASURED_CELL_BORDER,
              background: `linear-gradient(${rampAxis}, rgba(${GOLD_RGB}, 0.18), rgba(${GOLD_RGB}, 1))`,
            }}
          />
          <span className="tq-num" style={{ fontSize: 12 }}>
            {maxAvg === null ? '—' : formatNumber(maxAvg)}
          </span>
          <span className="tq-muted" style={{ fontSize: 12 }}>
            {tt('متوسط التفاعل للخانة', 'Average engagement per cell')}
          </span>
        </span>

        <span className="tq-muted" style={{ fontSize: 12 }}>
          <span className="tq-num">{formatNumber(measuredCells)}</span>
          {' / '}
          <span className="tq-num">{formatNumber(timing.cells.length)}</span>{' '}
          {tt('خانة فيها منشورات', 'cells carry posts')}
        </span>
      </Space>

      {/* A colour grid is unreadable to a screen reader and unreadable across a
          room, so the same numbers are also available as plain rows. */}
      <Collapse
        size="small"
        items={[
          {
            key: 'table',
            label: tt(
              'المكافئ النصي — كل خانة كصف في جدول',
              'Text equivalent — every cell as a table row',
            ),
            children: (
              <Table<TimingRow>
                size="small"
                rowKey="key"
                columns={columns}
                dataSource={tableRows}
                pagination={{ pageSize: HOURS_PER_DAY, showSizeChanger: false }}
              />
            ),
          },
        ]}
      />
    </Space>
  );
}

/* ------------------------------------------------- what the report covers -- */

function scopeLabel(scope: AudienceScope, tt: (ar: string, en: string) => string): string {
  if (scope === 'personal') return tt('شخصي', 'Personal');
  if (scope === 'academy') return tt('أكاديمية', 'Academy');
  return tt('الكل', 'All');
}

/** The four figures of one capped read of `posts`, in both units. */
function PopulationScan({ title, scan }: { title: string; scan: AudiencePopulationScan }) {
  const { tt } = useLocale();
  return (
    <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} title={title}>
      <Descriptions.Item label={tt('صفوف قُرئت', 'Scrape rows read')}>
        <span className="tq-num">{formatNumber(scan.rows_fetched)}</span>
      </Descriptions.Item>
      <Descriptions.Item label={tt('منشورات بعد الدمج', 'Posts after collapsing')}>
        <span className="tq-num">{formatNumber(scan.posts)}</span>
      </Descriptions.Item>
      <Descriptions.Item label={tt('إعادات سحب مدموجة', 'Re-scrapes collapsed')}>
        <span className="tq-num">{formatNumber(scan.duplicates_collapsed)}</span>
      </Descriptions.Item>
      <Descriptions.Item label={tt('لقطات مرئية', 'Snapshots seen')}>
        <span className="tq-num">{formatNumber(scan.snapshots_seen)}</span>
      </Descriptions.Item>
    </Descriptions>
  );
}

/**
 * The frame around every number on this screen: what the stored report was
 * computed over.
 *
 * It renders on a plain page load, not only after a Generate, because that is
 * when it matters most — the reader of a stored report never saw the run. When
 * the row predates the recording of its population, the block says so with an
 * em-dash and a sentence; it never omits itself, and it never fills the gap with
 * a population measured today, which would describe a different set of rows.
 */
function ReportCoverage({ population }: { population: AudienceReportPopulation | null }) {
  const { tt } = useLocale();
  const title = tt('ما يغطّيه هذا التقرير', 'What this report covers');

  if (population === null) {
    return (
      <Card size="small" title={title}>
        <div className="tq-num" style={{ fontSize: 20, lineHeight: 1.2 }}>
          —
        </div>
        <span className="tq-muted">
          {tt(
            'هذا التقرير مُخزَّن دون تسجيل التعليقات والمنشورات التي حُسب عليها، فما يغطّيه غير معروف. أعِد التحليل ليُسجَّل مع النتيجة الجديدة.',
            'This stored report does not record the comments and posts it was computed over, so what it covers is unknown. Regenerate it and the population will be recorded with the new result.',
          )}
        </span>
      </Card>
    );
  }

  // One line per read that filled its cap, each naming its OWN cap: the two
  // reads are separate queries and nothing guarantees they were capped alike.
  const truncatedReads: React.ReactNode[] = [];
  if (population.post_index.truncated) {
    truncatedReads.push(
      <li key="post-index">
        {tt('فهرس المنشورات: أول ', 'The post index: the first ')}
        <span className="tq-num">{formatNumber(population.post_index.limit)}</span>
        {tt(' صف فقط.', ' rows only.')}
      </li>,
    );
  }
  if (population.timing_posts.truncated) {
    truncatedReads.push(
      <li key="timing-posts">
        {tt('منشورات جدول التوقيت: أول ', "The timing grid's posts: the first ")}
        <span className="tq-num">{formatNumber(population.timing_posts.limit)}</span>
        {tt(' صف فقط.', ' rows only.')}
      </li>,
    );
  }

  return (
    <Card size="small" title={title}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 4 }}
          title={tt('التعليقات التي قرأها هذا التقرير', 'The comments this report read')}
        >
          <Descriptions.Item label={tt('النطاق', 'Account scope')}>
            {scopeLabel(population.account, tt)}
          </Descriptions.Item>
          <Descriptions.Item label={tt('تعليقات قُرئت', 'Comments read')}>
            <span className="tq-num">{formatNumber(population.comments.read)}</span>
          </Descriptions.Item>
          <Descriptions.Item label={tt('سقف القراءة', 'Read cap')}>
            <span className="tq-num">{formatNumber(population.comments.cap)}</span>
          </Descriptions.Item>
          <Descriptions.Item label={tt('اقتُطع', 'Truncated')}>
            {population.comments.truncated ? tt('نعم', 'Yes') : tt('لا', 'No')}
          </Descriptions.Item>
          <Descriptions.Item label={tt('بلا منشور مصدر', 'Without a source post')}>
            <span className="tq-num">{formatNumber(population.comments.unattributed)}</span>
          </Descriptions.Item>
        </Descriptions>

        {/* Two separate reads of `posts`, reported separately because they
            measure different things and can diverge: one gives the quotes
            their source links, the other is what the heatmap rests on. */}
        <PopulationScan
          title={tt(
            'فهرس المنشورات الذي رُبطت به التعليقات',
            'The post index the comments were joined against',
          )}
          scan={population.post_index}
        />

        {/* The read the grid was computed FROM. How many of these posts carried
            a usable time and engagement — and so ended up measured — is the
            grid's own "Posts measured (n)". */}
        <PopulationScan
          title={tt(
            'قراءة المنشورات التي حُسب منها جدول التوقيت',
            'The post read the timing grid was computed from',
          )}
          scan={population.timing_posts}
        />

        {/* A read that filled its cap may be a prefix of the table, so it is
            stated. The wording is "the first N rows" and never "N of M":
            what a capped query never saw cannot be counted from its result. */}
        {truncatedReads.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={tt('قراءة مقتطعة للمنشورات', 'A post read was truncated')}
            description={
              <>
                <div>
                  {tt(
                    'بلغت القراءة سقفها، فما ظهر أعلاه ليس الجدول كاملاً:',
                    'The read filled its cap, so the figures above are not the whole table:',
                  )}
                </div>
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>{truncatedReads}</ul>
                <div>
                  {tt(
                    'التعليقات المعلّقة على منشورات خارج هذا السقف ليست في هذا التحليل.',
                    'Comments hanging off posts beyond that cap are not in this analysis.',
                  )}
                </div>
              </>
            }
          />
        ) : null}
      </Space>
    </Card>
  );
}

/**
 * The same fact, restated where the grid is actually read. A reader who scrolls
 * to the heatmap should not have to scroll back up to learn what it rests on —
 * and a grid whose population was never recorded says that here rather than
 * letting its cells imply one.
 *
 * The figures below are the READ the grid was computed from, not the count of
 * posts that ended up measured in it: buildTiming() drops a post with no usable
 * posting time or engagement, and filters by account. That surviving count is
 * `total_n`, rendered by the grid itself as "Posts measured (n)" — so this line
 * points at it instead of implying the two numbers are the same.
 */
function TimingPopulationLine({ population }: { population: AudienceReportPopulation | null }) {
  const { tt } = useLocale();

  if (population === null) {
    return (
      <span className="tq-muted" style={{ fontSize: 12 }}>
        <span className="tq-num">—</span>{' '}
        {tt(
          'هذا التقرير مُخزَّن دون تسجيل قراءة المنشورات التي حُسبت منها هذه الشبكة، فحجمها غير معروف هنا.',
          'This stored report does not record the post read this grid was computed from, so its size is unknown here.',
        )}
      </span>
    );
  }

  const scan = population.timing_posts;
  return (
    <span className="tq-muted" style={{ fontSize: 12 }}>
      {tt('تستند هذه الشبكة إلى قراءة ', 'This grid rests on a read of ')}
      <span className="tq-num">{formatNumber(scan.posts)}</span>
      {tt(' منشوراً — ', ' post(s) — ')}
      <span className="tq-num">{formatNumber(scan.rows_fetched)}</span>
      {tt(' صفاً بعد دمج ', ' scrape row(s) with ')}
      <span className="tq-num">{formatNumber(scan.duplicates_collapsed)}</span>
      {scan.truncated ? (
        <>
          {tt(' إعادة سحب، وهي أول ', ' re-scrape(s) collapsed, and only the first ')}
          <span className="tq-num">{formatNumber(scan.limit)}</span>
          {tt(' صف فقط، لا الجدول كاملاً. ', ' rows of the table, not all of it. ')}
        </>
      ) : (
        tt(' إعادة سحب. ', ' re-scrape(s) collapsed. ')
      )}
      {tt(
        'وكم منها حمل وقت نشر وتفاعلاً صالحين هو «المنشورات المقيسة (n)» أدناه.',
        'How many of those carried a usable posting time and engagement figure is “Posts measured (n)” below.',
      )}
    </span>
  );
}

/* ---------------------------------------------------------------- the page -- */

export default function AudiencePage() {
  const { tt, locale } = useLocale();
  const { notification } = App.useApp();

  const [insight, setInsight] = useState<AudienceInsight | null>(null);
  const [comments, setComments] = useState<number | null>(null);
  // What the STORED insight covers. It travels with the insight, from the same
  // GET, so the figures and the frame around them can never come from different
  // reads — and a plain page load carries it exactly as a Generate does.
  const [population, setPopulation] = useState<AudienceReportPopulation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [scope, setScope] = useState<AudienceScope>('all');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<{ message: string; hint: string | null } | null>(null);
  // Run-scoped, and labelled as such on screen: neither the agent's warnings nor
  // the Judge's verdict is stored on the row, so neither can be shown for a
  // report this session did not generate. They are cleared the moment the next
  // run starts, so a failed re-run cannot leave the previous run's verdict
  // standing beside its error.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [review, setReview] = useState<{ needs_human: boolean; judge_score: number | null } | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<AudienceGetResponse>('/api/audience');
      setInsight(data.insight);
      setComments(data.comments);
      setPopulation(data.population);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setGenError(null);
    // Both of these describe ONE run. Clearing them before the next one starts
    // is what stops a failed re-run from showing the previous run's verdict and
    // warnings underneath its error message.
    setReview(null);
    setWarnings([]);
    try {
      const res = await apiSend<AudienceGenerateResponse>('/api/audience', 'POST', {
        account: scope,
      });
      setReview({
        needs_human: res.persisted.needs_human,
        judge_score: res.persisted.judge_score,
      });
      // The agent's own warnings and everything verification dropped, together —
      // plus a failure to record what this run covered, which is a fact about
      // the report and belongs on screen rather than in a log.
      setWarnings([
        ...(res.result.warnings ?? []),
        ...(res.persisted.dropped ?? []),
        ...(res.population_storage_error === null ? [] : [res.population_storage_error]),
      ]);
      notification.success({
        message: tt('تم تحليل الجمهور', 'Audience analysed'),
        description: tt(
          `بواسطة النموذج ${res.model} على ${formatNumber(res.corpus.size)} تعليق.`,
          `Generated with ${res.model} over ${formatNumber(res.corpus.size)} comment(s).`,
        ),
      });
      // The insight AND the population it covers are both read back from the
      // stored row, through the same GET a plain page load uses. Nothing on this
      // screen is rendered from a run-only copy of the numbers, so there is no
      // path where a Generate shows something a reload would not.
      await load();
    } catch (err) {
      setGenError(describeError(err));
    } finally {
      setGenerating(false);
    }
  }, [scope, tt, notification, load]);

  const themes = insight?.themes ?? [];
  const questions = insight?.questions ?? [];

  const headerExtra = (
    <Space wrap size={8} align="center">
      <Segmented
        options={[
          { label: tt('الكل', 'All'), value: 'all' },
          { label: tt('شخصي', 'Personal'), value: 'personal' },
          { label: tt('أكاديمية', 'Academy'), value: 'academy' },
        ]}
        value={scope}
        onChange={(value) => setScope(value as AudienceScope)}
      />
      <Button type="primary" loading={generating} onClick={() => void handleGenerate()}>
        {insight === null ? tt('تحليل', 'Generate') : tt('إعادة التحليل', 'Regenerate')}
      </Button>
    </Space>
  );

  return (
    <div className="tq-page">
      <PageHeader
        title={tt('الجمهور', 'Audience')}
        subtitle={tt(
          'ما يقوله الجمهور فعلاً — اقتباسات حرفية وأرقام محسوبة، بلا ملفات أفراد.',
          'What the audience actually says — verbatim quotes and computed figures, no individual profiles.',
        )}
        extra={headerExtra}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message={tt('تحليل تجميعي فقط', 'Aggregate analysis only')}
        description={tt(
          'الجمهور مجموعة وليس قائمة أهداف: لا ملفات لمعلّقين، ولا تتبّع أفراد. الأسماء لا تغادر قاعدة البيانات.',
          'The audience is a group, not a target list: no per-commenter profiles, no individual tracking. Handles never leave the database.',
        )}
      />

      {genError ? <ErrorState error={genError.message} hint={genError.hint} /> : null}

      {/* The Judge's verdict, stated before the findings it is a verdict on.
          `judge_score` is null when the run carried no score — an em-dash, not
          a zero, because "not scored" and "scored zero" are different facts.
          The verdict belongs to the run that just happened and is not stored on
          the row, so the wording says whose verdict it is and that it will not
          survive a reload, rather than reading as a standing property of the
          report. */}
      {review?.needs_human ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBlockEnd: 16 }}
          message={tt(
            'التشغيل الذي جرى الآن يحتاج مراجعة بشرية',
            'The run you just made needs human review',
          )}
          description={
            <>
              {tt('درجة الحكم: ', 'Judge score: ')}
              <span className="tq-num">{formatNumber(review.judge_score)}</span>
              {tt(
                '. هذا الحكم يخصّ هذا التشغيل ولا يُحفظ مع التقرير، فلن يظهر بعد إعادة تحميل الصفحة. راجع المحاور والاقتباسات قبل استخدامها.',
                '. This verdict belongs to that run and is not stored with the report, so it will not appear after a page reload. Read the themes and quotes before using them.',
              )}
            </>
          }
        />
      ) : null}

      <WarningList warnings={warnings} />

      {loading ? <LoadingBlock rows={6} /> : null}
      {!loading && error ? (
        <ErrorState error={error.message} hint={error.hint} onRetry={() => void load()} />
      ) : null}

      {!loading && !error && insight === null && comments === 0 ? (
        <EmptyState
          description={tt(
            'لا توجد تعليقات مُخزّنة بعد، فلا شيء لتحليله. شغّل سحب التعليقات في شاشة البيانات — القراءة فقط — ثم عد وحلّل.',
            'No comments are stored yet, so there is nothing to analyse. Run a comment scrape on the Data screen — it only reads — then generate the analysis here.',
          )}
          actionLabel={tt('إلى البيانات', 'Go to Data')}
          href="/data"
        />
      ) : null}

      {!loading && !error && insight === null && comments !== 0 ? (
        <EmptyState
          description={
            comments === null
              ? tt(
                  'تعذّر قراءة عدد التعليقات، ولم يُنشأ أي تحليل للجمهور بعد. شغّل التحليل، أو راجع سحب التعليقات في شاشة البيانات.',
                  'The comment count could not be read, and no audience analysis has been generated yet. Run the analysis, or check the comment scrape on the Data screen.',
                )
              : tt(
                  'التعليقات مُخزّنة، لكن لم يُنشأ أي تحليل للجمهور بعد.',
                  'Comments are stored, but no audience analysis has been generated yet.',
                )
          }
          actionLabel={tt('تحليل الجمهور', 'Analyse the audience')}
          onAction={() => void handleGenerate()}
        />
      ) : null}

      {!loading && !error && insight !== null ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Card size="small">
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
              <Descriptions.Item label={tt('أُنشئ في', 'Generated')}>
                <span className="tq-num">{formatDateTime(insight.created_at, locale)}</span>
              </Descriptions.Item>
              <Descriptions.Item label={tt('التأسيس', 'Grounding')}>
                <GroundingTag grounding={insight.grounding} />
              </Descriptions.Item>
              <Descriptions.Item label={tt('محاور', 'Themes')}>
                <span className="tq-num">{formatNumber(themes.length)}</span>
              </Descriptions.Item>
              <Descriptions.Item label={tt('تعليقات مُخزّنة', 'Comments stored')}>
                <span className="tq-num">{formatNumber(comments)}</span>
              </Descriptions.Item>
            </Descriptions>
          </Card>

          {/* Stated for every stored report, not only for a run this session
              made. It is the frame around every figure below it: a reader who
              arrives at a stored insight never saw the run that produced it. */}
          <ReportCoverage population={population} />

          <Card size="small" title={tt('المحاور المتكرّرة', 'Recurring themes')}>
            {themes.length === 0 ? (
              <span className="tq-muted">
                {tt(
                  'لم ينجُ أي محور من التحقق من الاقتباسات. أعد التحليل بعد سحب تعليقات أحدث.',
                  'No theme survived quote verification. Regenerate after scraping fresher comments.',
                )}
              </span>
            ) : (
              <Space direction="vertical" size={20} style={{ width: '100%' }}>
                {themes.map((theme, themeIndex) => (
                  <div key={`${theme.label}-${themeIndex}`}>
                    <Space wrap size={8} align="center">
                      <ArabicText style={{ fontWeight: 600, fontSize: 15 }}>
                        {theme.label}
                      </ArabicText>
                      <Tag style={{ marginInlineEnd: 0 }}>
                        n = <span className="tq-num">{formatNumber(theme.n)}</span>
                      </Tag>
                      <GroundingTag grounding={theme.grounding} />
                    </Space>

                    {theme.quotes.length === 0 ? (
                      <div className="tq-muted" style={{ marginBlockStart: 8 }}>
                        —
                      </div>
                    ) : (
                      theme.quotes.map((quote, quoteIndex) => (
                        <blockquote
                          key={`${theme.label}-quote-${quoteIndex}`}
                          style={{
                            margin: 0,
                            marginBlockStart: 8,
                            paddingInlineStart: 12,
                            borderInlineStart: `3px solid ${GOLD}`,
                          }}
                        >
                          <div dir="auto" className="tq-ar">
                            {quote.text}
                          </div>
                          <div style={{ fontSize: 12, marginBlockStart: 2 }}>
                            {quote.post_url ? (
                              <a href={quote.post_url} target="_blank" rel="noopener noreferrer">
                                {tt('المنشور المصدر', 'Source post')}
                              </a>
                            ) : (
                              <span className="tq-muted">—</span>
                            )}
                          </div>
                        </blockquote>
                      ))
                    )}
                  </div>
                ))}
              </Space>
            )}
          </Card>

          <Card size="small" title={tt('الأسئلة التي يسألونه إياها', 'Questions his audience asks him')}>
            {questions.length === 0 ? (
              <span className="tq-muted">
                {tt(
                  'لم يُتحقّق من أي سؤال حرفياً في التعليقات المُخزّنة.',
                  'No question was verified verbatim against the stored comments.',
                )}
              </span>
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {questions.map((question, questionIndex) => (
                  <div key={`question-${questionIndex}`}>
                    <div dir="auto" className="tq-ar">
                      {question.text}
                    </div>
                    <Space wrap size={8} style={{ marginBlockStart: 4 }}>
                      <Tag style={{ marginInlineEnd: 0 }}>
                        {tt('سُئل', 'asked')}{' '}
                        <span className="tq-num">×{formatNumber(question.asked_count)}</span>
                      </Tag>
                      {question.post_url ? (
                        <a href={question.post_url} target="_blank" rel="noopener noreferrer">
                          {tt('المنشور المصدر', 'Source post')}
                        </a>
                      ) : (
                        <span className="tq-muted">—</span>
                      )}
                    </Space>
                  </div>
                ))}
              </Space>
            )}
          </Card>

          <Card size="small" title={tt('ملاحظات الأسلوب واللغة', 'Register notes')}>
            {insight.register_notes ? (
              <ArabicText>{insight.register_notes}</ArabicText>
            ) : (
              <span className="tq-muted">—</span>
            )}
          </Card>

          <Card
            size="small"
            title={tt('توقيت النشر × التفاعل', 'Posting time x engagement')}
            extra={
              <span className="tq-muted" style={{ fontSize: 12 }}>
                {tt(
                  'محسوب في الكود من posted_at × التفاعل — لا يقوله النموذج.',
                  'Computed in code from posted_at x engagement — never asserted by the model.',
                )}
              </span>
            }
          >
            {insight.timing === null ? (
              <span className="tq-muted">
                {tt(
                  'حُفظ هذا التحليل بلا تقرير توقيت. أعد التحليل لحساب الشبكة من المنشورات المُخزّنة.',
                  'This insight was stored without a timing report. Regenerate it to compute the grid from the stored posts.',
                )}
              </span>
            ) : (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <TimingPopulationLine population={population} />
                {insight.timing.pattern_name_ar ? (
                  <div>
                    <ArabicText style={{ fontWeight: 600 }}>
                      {insight.timing.pattern_name_ar}
                    </ArabicText>
                    <span className="tq-muted" style={{ fontSize: 12 }}>
                      {tt(
                        'الاسم من النموذج؛ كل رقم بجانبه محسوب من قاعدة البيانات.',
                        'The name is the model’s; every number beside it is computed from the database.',
                      )}
                    </span>
                  </div>
                ) : null}
                <TimingHeatmap timing={insight.timing} />
              </Space>
            )}
          </Card>
        </Space>
      ) : null}
    </div>
  );
}
