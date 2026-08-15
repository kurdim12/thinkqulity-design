'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Dropdown,
  Input,
  Popover,
  Row,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { MoreOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import { PageHeader, ErrorState, LoadingBlock, ArabicText } from '@/components/ui';
import { ConceptCard } from '@/components/ConceptCard';
import { formatDateTime, formatNumber } from '@/lib/date';
import { GOLD } from '@/lib/theme';
import type { ChatMessageRow, ConceptRow, ConversationRow, PillarRow } from '@/lib/types/db';

/**
 * ===========================================================================
 * THE CHAT SCREEN — the one place where the buffering is visible
 * ===========================================================================
 *
 * Four properties of the surface underneath shape everything below, and each is
 * a thing this screen must not quietly undo.
 *
 * 1. NOTHING STREAMS, AND THAT IS THE FEATURE (hard rule 16). `runAgentChat`
 *    returns a FINISHED reply — it has no way to emit a partial one — and
 *    /api/chat has no way to forward what it never receives. So the wait is
 *    real and it is deliberate. The typing indicator therefore states the
 *    INVARIANT ("the reply is written in full and its numbers are checked
 *    before any of it appears") rather than a fake progress narrative: the
 *    route sends no progress events, so a UI that said "now linting…" would be
 *    inventing a stage it cannot observe — on the one screen whose entire point
 *    is that nothing unverified is shown.
 *
 * 2. THE TRANSCRIPT IS READ BACK FROM THE ROWS, NEVER FROM THE POST RESPONSE.
 *    A send is followed by `GET /api/chat?id=…`, exactly as the Audience and
 *    Digest screens reload after a generate. One code path renders a turn
 *    whether or not this session produced it, so there is no state a reload
 *    would not reproduce. It is also the only way to see TOOL ROWS: the POST
 *    body returns `tools[].card` but not `tools[].content`, and the content is
 *    the refusal payloads, the cap figures and the stat values this screen
 *    renders.
 *
 * 3. EVERY NUMBER ON SCREEN NAMES WHERE IT CAME FROM (hard rule 12). Stat
 *    values are rendered VERBATIM — never through formatNumber() — because
 *    ./stats.ts formats them with the same `formatQuantity()` the context
 *    blocks use, and the claims-linter matches the reply against that text by
 *    string. Re-formatting `507.97` into `507.97` would be luck; re-formatting
 *    it into `508` would make this screen disagree with the linter that cleared
 *    it. Row fields that are JSON numbers (a post's engagement) are formatted
 *    like every other screen, because nothing lints those.
 *
 * 4. AN ABSENCE IS AN ANSWER. Most lookups have no measurement on this
 *    deployment; a lookup that says so is working, not failing. Absences get
 *    the same visual weight as values, and never a zero.
 *
 * WHAT THIS SCREEN CANNOT DO, STATED WHERE THE OPERATOR MEETS IT
 * `/api/chat` exposes GET and POST and nothing else — there is no route that
 * renames or deletes a conversation. Both controls are therefore present and
 * DISABLED, each naming the missing route, rather than absent (which would read
 * as an oversight) or present and broken (which would be a lie). Adding them is
 * a change to a file this task does not own.
 */

/* ============================================================== responses == */

/**
 * Declared as the ROUTE actually answers, and no wider. `apiGet`/`apiSend` do
 * `return payload as T` with no runtime validation, so a field declared here
 * that the route never sends is `undefined` at runtime and invisible to tsc.
 */
interface ChatListResponse {
  conversations: ConversationRow[];
}

interface ChatThreadResponse {
  conversation: ConversationRow;
  messages: ChatMessageRow[];
}

/**
 * POST returns a great deal more — the reply, the cards, the law report, the
 * token usage, the history window. Only the conversation id is read, because
 * everything else is re-read from the stored rows a moment later (see 2 above).
 * Declaring the rest would be declaring fields this screen never uses.
 */
interface ChatPostResponse {
  conversation_id: string;
}

interface ConceptsResponse {
  concepts: ConceptRow[];
  pillars: PillarRow[];
}

/* ================================================================ mirrors == */

/**
 * MIRRORS `UNSOURCED_CHIP` in src/lib/agent/chat/run.ts, character for
 * character. That module is the right owner of the constant and the wrong
 * import for a client component: it pulls in the Anthropic SDK, `requireEnv`
 * and the provider layer, none of which belong in a browser bundle.
 *
 * The drift is bounded and it fails SAFE. run.ts writes this marker INTO the
 * delivered text, so if the two strings ever disagree the marker still reaches
 * the screen — it simply renders as plain text instead of as a chip. A mismatch
 * costs the styling, never the disclosure. (The durable fix is to lift the
 * constant into a dependency-free leaf module; that is reported, not improvised
 * from here.)
 */
const UNSOURCED_CHIP = '«رقم غير موثّق — حُذف»';

/**
 * MIRRORS `CHAT_CAP_REACHED` (src/lib/agent/chat/dispatch.ts) and `CAP_REACHED`
 * (src/lib/agent/chat/tools.ts), for the same bundling reason. Drift here means
 * a cap refusal is rendered by the generic refusal panel instead of the cap
 * panel — the refusal is still shown in full, and the composer is not disabled.
 * That direction costs a warning, not a wrong figure.
 */
const CAP_REACHED_REFUSALS: readonly string[] = [
  'chat_daily_generation_cap_reached',
  'daily_generation_cap_reached',
];

/**
 * The named computations in src/lib/agent/chat/stats.ts (`STAT_LOOKUP_NAMES`),
 * restated for the same reason. These are LABELS on the starter questions and
 * nothing more: this screen sends a question, the model picks the lookup. A name
 * that drifted here would print a wrong label; it cannot cause a wrong query,
 * because no query is issued from this file.
 */
const LOOKUP_ACCOUNT_AVERAGES = 'account_averages';
const LOOKUP_TIMING_WINDOWS = 'timing_windows';
const LOOKUP_FOLLOWER_HISTORY = 'follower_history';

/* ================================================== reading unknown records ==
 *
 * `cards` is `Record<string, unknown>[]` and a tool row's `content` is a JSON
 * string, so everything below is narrowed at runtime. No `any`, no assertion:
 * a field that is not the expected type reads as absent, and absent renders as
 * an em-dash rather than as the word "undefined".
 * ========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function readStrings(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function readRecords(source: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

/** The `source_keys` map a cap payload carries: key → what produced the figure. */
function readSourceKeyMap(source: Record<string, unknown>): Record<string, string> {
  const raw = readRecord(source, 'source_keys');
  if (raw === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** A tool row's stored content, parsed. Null when it is not a JSON object. */
function parseToolPayload(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // run.ts writes a one-line `TOOL ERROR (name): reason` string when an
    // executor throws. It is not JSON and it is not a failure to parse it —
    // it is rendered verbatim by the caller.
    return null;
  }
}

/* ================================================================== chips == */

/**
 * A quantity with its provenance one tap away (hard rule 12).
 *
 * `click` rather than hover, and `focus` beside it: a source key that only a
 * mouse can reach is a source key half the operators cannot check.
 */
function Sourced({
  children,
  source,
  note,
}: {
  children: React.ReactNode;
  /** The key, path or column that resolves the figure. Rendered LTR. */
  source: string;
  note?: string;
}) {
  const { tt } = useLocale();
  return (
    <Popover
      trigger={['click', 'focus']}
      placement="top"
      content={
        <div style={{ maxInlineSize: 320 }}>
          <div className="tq-muted" style={{ fontSize: 11 }}>
            {tt('مصدر هذا الرقم', 'Where this figure comes from')}
          </div>
          <code dir="ltr" style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {source}
          </code>
          {note ? (
            <div className="tq-muted" style={{ fontSize: 11, marginBlockStart: 6 }}>
              {note}
            </div>
          ) : null}
        </div>
      }
    >
      <span
        role="button"
        tabIndex={0}
        style={{ cursor: 'pointer', borderBlockEnd: `1px dotted ${GOLD}` }}
        aria-label={tt(`اعرض مصدر الرقم: ${source}`, `Reveal the source of this figure: ${source}`)}
      >
        {children}
      </span>
    </Popover>
  );
}

interface StatValueShape {
  source_key: string;
  label: string;
  value: string;
  n: number | null;
  as_of: string | null;
}

function readStatValues(payload: Record<string, unknown>): StatValueShape[] {
  const out: StatValueShape[] = [];
  for (const entry of readRecords(payload, 'values')) {
    const source_key = readString(entry, 'source_key');
    const value = entry.value;
    if (source_key === null || typeof value !== 'string') continue;
    out.push({
      source_key,
      label: readString(entry, 'label') ?? source_key,
      value,
      n: readNumber(entry, 'n'),
      as_of: readString(entry, 'as_of'),
    });
  }
  return out;
}

interface AbsenceShape {
  what: string;
  reason: string;
  what_would_produce_it: string | null;
}

function readAbsences(payload: Record<string, unknown>): AbsenceShape[] {
  const out: AbsenceShape[] = [];
  for (const key of ['absences', 'absence']) {
    const entries = key === 'absence' ? [readRecord(payload, 'absence')] : readRecords(payload, key);
    for (const entry of entries) {
      if (entry === null) continue;
      const what = readString(entry, 'what');
      const reason = readString(entry, 'reason');
      if (what === null || reason === null) continue;
      out.push({
        what,
        reason,
        what_would_produce_it: readString(entry, 'what_would_produce_it'),
      });
    }
  }
  return out;
}

/**
 * One measured quantity. The value is printed EXACTLY as the lookup wrote it —
 * see note 3 in the header. `n` and `as_of` travel with it because a mean
 * without its sample size is a claim wearing a measurement's clothes.
 */
function StatChip({ stat }: { stat: StatValueShape }) {
  const { tt, locale } = useLocale();
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        border: '1px solid var(--tq-line)',
        borderInlineStartWidth: 3,
        borderInlineStartColor: GOLD,
        borderRadius: 8,
        paddingInline: 10,
        paddingBlock: 5,
        background: '#fff',
      }}
    >
      <span className="tq-muted" style={{ fontSize: 11 }}>
        {stat.label}
      </span>
      <Sourced
        source={stat.source_key}
        note={tt(
          'القيمة منسوخة حرفياً كما حسبها الاستعلام — بلا إعادة تقريب ولا تنسيق.',
          'The value is reproduced exactly as the lookup computed it — never re-rounded, never re-formatted.',
        )}
      >
        {/* VERBATIM. Not formatNumber(). */}
        <span className="tq-num" style={{ fontSize: 15, fontWeight: 600 }}>
          {stat.value}
        </span>
      </Sourced>
      {stat.n === null ? null : (
        <span className="tq-muted" style={{ fontSize: 11 }}>
          n = <span className="tq-num">{formatNumber(stat.n)}</span>
        </span>
      )}
      {stat.as_of === null ? null : (
        <span className="tq-muted" style={{ fontSize: 11 }}>
          <span className="tq-num">{formatDateTime(stat.as_of, locale)}</span>
        </span>
      )}
    </span>
  );
}

/** What was NOT measured, with the same weight as what was. Never a zero. */
function AbsenceRow({ absence }: { absence: AbsenceShape }) {
  const { tt } = useLocale();
  return (
    <div style={{ borderInlineStart: '3px dashed var(--tq-line)', paddingInlineStart: 10 }}>
      <Space wrap size={8} align="baseline">
        <span className="tq-num" style={{ fontSize: 15 }}>
          —
        </span>
        <code dir="ltr" style={{ fontSize: 12 }}>
          {absence.what}
        </code>
        <Tag style={{ marginInlineEnd: 0 }}>{tt('لا قياس', 'No measurement')}</Tag>
      </Space>
      <div dir="auto" style={{ fontSize: 13, marginBlockStart: 2 }}>
        {absence.reason}
      </div>
      {absence.what_would_produce_it ? (
        <div className="tq-muted" style={{ fontSize: 12 }}>
          {tt('ما يُنتجه: ', 'What would produce it: ')}
          {absence.what_would_produce_it}
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================== the cap ==== */

interface CapNotice {
  refusal: string;
  reason: string | null;
  limit: number | null;
  unit: string | null;
  used: number | null;
  resets_at: string | null;
  resets_on: string | null;
  time_zone: string | null;
  env_key: string | null;
  what_you_can_do: string[];
  source_keys: Record<string, string>;
}

/** A cap refusal, if this payload is one. Both refusal shapes carry `cap`. */
function readCapNotice(payload: Record<string, unknown>): CapNotice | null {
  const refusal = readString(payload, 'refusal');
  if (refusal === null || !CAP_REACHED_REFUSALS.includes(refusal)) return null;
  const cap = readRecord(payload, 'cap');
  return {
    refusal,
    reason: readString(payload, 'reason'),
    limit: cap === null ? null : readNumber(cap, 'limit'),
    unit: cap === null ? null : readString(cap, 'unit'),
    used: cap === null ? null : readNumber(cap, 'used'),
    resets_at: cap === null ? null : readString(cap, 'resets_at'),
    resets_on: cap === null ? null : readString(cap, 'resets_on'),
    time_zone: cap === null ? null : readString(cap, 'time_zone'),
    env_key: cap === null ? null : readString(cap, 'env_key'),
    what_you_can_do: readStrings(payload, 'what_you_can_do'),
    source_keys: cap === null ? {} : readSourceKeyMap(cap),
  };
}

/**
 * Whether a cap refusal still binds.
 *
 * The comparison is against the BROWSER's clock, which is why the panel says
 * the instant out loud rather than only "expired". An unreadable or absent
 * `resets_at` counts as STILL IN FORCE — the same direction ./dispatch.ts
 * chooses when it cannot prove a spend: over-refusing costs the operator a
 * request, under-refusing costs them money.
 */
function capStillBinds(notice: CapNotice): boolean {
  if (notice.resets_at === null) return true;
  const resets = Date.parse(notice.resets_at);
  if (Number.isNaN(resets)) return true;
  return resets > Date.now();
}

function CapPanel({ notice }: { notice: CapNotice }) {
  const { tt, locale } = useLocale();
  const keyFor = (name: string): string => notice.source_keys[name] ?? name;

  return (
    <Alert
      type="warning"
      showIcon
      message={tt('بلغ سقف التوليد اليومي', 'The daily generation cap is reached')}
      description={
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {notice.reason ? <div>{notice.reason}</div> : null}

          <Space wrap size={12}>
            <span style={{ fontSize: 12 }}>
              {tt('السقف: ', 'Limit: ')}
              <Sourced source={keyFor('chat_cap.limit')}>
                <span className="tq-num">{formatNumber(notice.limit)}</span>
              </Sourced>
              {notice.unit ? <span className="tq-muted"> {notice.unit}</span> : null}
            </span>
            <span style={{ fontSize: 12 }}>
              {tt('المستهلَك: ', 'Used: ')}
              <Sourced source={keyFor('chat_cap.used')}>
                <span className="tq-num">{formatNumber(notice.used)}</span>
              </Sourced>
            </span>
            <span style={{ fontSize: 12 }}>
              {tt('يُصفَّر في: ', 'Resets at: ')}
              <Sourced source={keyFor('chat_cap.resets_at')}>
                <span className="tq-num">{formatDateTime(notice.resets_at, locale)}</span>
              </Sourced>
              {notice.time_zone ? <span className="tq-muted"> ({notice.time_zone})</span> : null}
            </span>
            {notice.env_key ? (
              <span className="tq-muted" style={{ fontSize: 12 }}>
                {tt('المتغيّر: ', 'Variable: ')}
                <code dir="ltr">{notice.env_key}</code>
              </span>
            ) : null}
          </Space>

          {notice.what_you_can_do.length > 0 ? (
            <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }}>
              {notice.what_you_can_do.map((line, index) => (
                <li key={`cap-do-${index}`}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Space>
      }
    />
  );
}

/* ============================================================ tool results == */

/** A refusal that is not the cap: unknown lookup, bad arguments, a failed read. */
function RefusalPanel({ payload }: { payload: Record<string, unknown> }) {
  const { tt } = useLocale();
  const refusal = readString(payload, 'refusal') ?? 'refusal';
  const reason = readString(payload, 'reason');
  const note = readString(payload, 'note');
  const actions = readStrings(payload, 'what_you_can_do');
  const available = readStrings(payload, 'available');
  const issues = readRecords(payload, 'issues');

  return (
    <Alert
      type="warning"
      showIcon
      message={
        <Space size={8} wrap align="center">
          <span>{tt('رُفض الطلب', 'The request was refused')}</span>
          <code dir="ltr" style={{ fontSize: 12 }}>
            {refusal}
          </code>
        </Space>
      }
      description={
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {reason ? <div dir="auto">{reason}</div> : null}
          {note ? (
            <div className="tq-muted" style={{ fontSize: 12 }}>
              {note}
            </div>
          ) : null}
          {issues.length > 0 ? (
            <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }}>
              {issues.map((issue, index) => (
                <li key={`issue-${index}`}>
                  <code dir="ltr">{readString(issue, 'path') ?? '(root)'}</code>
                  {' — '}
                  {readString(issue, 'message') ?? '—'}
                </li>
              ))}
            </ul>
          ) : null}
          {available.length > 0 ? (
            <div className="tq-muted" style={{ fontSize: 12 }}>
              {tt('المتاح: ', 'Available: ')}
              <code dir="ltr">{available.join(', ')}</code>
            </div>
          ) : null}
          {actions.length > 0 ? (
            <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }}>
              {actions.map((line, index) => (
                <li key={`action-${index}`}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Space>
      }
    />
  );
}

/** The posts `search_posts` returned, verbatim. Behind a fold — they are long. */
function SearchPostsPanel({ payload }: { payload: Record<string, unknown> }) {
  const { tt, locale } = useLocale();
  const rows = readRecords(payload, 'rows');
  const matched = readNumber(payload, 'matched');
  const returned = readNumber(payload, 'returned');

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap size={12} style={{ fontSize: 12 }}>
        <span>
          {tt('طابقت: ', 'Matched: ')}
          <Sourced source="search_posts.matched">
            <span className="tq-num">{formatNumber(matched)}</span>
          </Sourced>
        </span>
        <span>
          {tt('أُعيدت: ', 'Returned: ')}
          <Sourced source="search_posts.returned">
            <span className="tq-num">{formatNumber(returned)}</span>
          </Sourced>
        </span>
      </Space>

      {rows.length === 0 ? (
        <span className="tq-muted" style={{ fontSize: 12 }}>
          {tt(
            'لم يطابق أي منشور هذه المرشّحات. هذا جواب، لا عطل.',
            'No post matched these filters. That is an answer, not a fault.',
          )}
        </span>
      ) : (
        <Collapse
          size="small"
          items={[
            {
              key: 'rows',
              label: tt('المنشورات كما هي مخزّنة', 'The posts, exactly as stored'),
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {rows.map((row, index) => {
                    const url = readString(row, 'url');
                    const caption = readString(row, 'caption');
                    const postedAt = readString(row, 'posted_at');
                    return (
                      <div
                        key={`post-${readString(row, 'ig_id') ?? index}`}
                        style={{
                          borderInlineStart: '3px solid var(--tq-line)',
                          paddingInlineStart: 10,
                        }}
                      >
                        <Space wrap size={8} style={{ fontSize: 12 }}>
                          <Tag style={{ marginInlineEnd: 0 }}>
                            {readString(row, 'account') ?? '—'}
                          </Tag>
                          <span>
                            {tt('التفاعل: ', 'Engagement: ')}
                            <span className="tq-num">
                              {formatNumber(readNumber(row, 'engagement'))}
                            </span>
                          </span>
                          <span className="tq-muted">
                            <span className="tq-num">{formatDateTime(postedAt, locale)}</span>
                          </span>
                          {url ? (
                            <a href={url} target="_blank" rel="noopener noreferrer">
                              {tt('المنشور', 'Post')}
                            </a>
                          ) : (
                            <span className="tq-muted">—</span>
                          )}
                        </Space>
                        <div dir="auto" className="tq-ar" style={{ fontSize: 13 }}>
                          {caption ?? '—'}
                        </div>
                      </div>
                    );
                  })}
                </Space>
              ),
            },
          ]}
        />
      )}

      <span className="tq-muted" style={{ fontSize: 11 }}>
        {tt(
          'رقم داخل تعليق أو تعليق مصوَّر هو نصّ كتبه العميل، وليس قياساً.',
          'A number inside a caption is text the client wrote, never a measurement.',
        )}
      </span>
    </Space>
  );
}

/**
 * One tool row, rendered by what it actually contains.
 *
 * The raw payload is always reachable under a fold. A tool result is half of
 * what the reply was linted against, so hiding it entirely would leave an audit
 * trail nobody can audit.
 */
function ToolRow({ row }: { row: ChatMessageRow }) {
  const { tt } = useLocale();
  const call = row.tool_calls?.[0] ?? null;
  const name = call?.name ?? tt('أداة', 'tool');
  const payload = parseToolPayload(row.content);

  const capNotice = payload === null ? null : readCapNotice(payload);
  const refusal = payload === null ? null : readString(payload, 'refusal');
  const stats = payload === null ? [] : readStatValues(payload);
  const absences = payload === null ? [] : readAbsences(payload);
  const notes = payload === null ? [] : readStrings(payload, 'notes');
  const isSearch = payload !== null && readString(payload, 'tool') === 'search_posts';

  return (
    <div
      style={{
        borderInlineStart: `3px solid ${GOLD}`,
        paddingInlineStart: 12,
        marginBlock: 4,
      }}
    >
      <Space wrap size={8} align="center" style={{ marginBlockEnd: 6 }}>
        <span className="tq-muted" style={{ fontSize: 11 }}>
          {tt('نفّذ', 'Ran')}
        </span>
        <code dir="ltr" style={{ fontSize: 12, fontWeight: 600 }}>
          {name}
        </code>
      </Space>

      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {capNotice ? <CapPanel notice={capNotice} /> : null}
        {capNotice === null && refusal !== null ? <RefusalPanel payload={payload ?? {}} /> : null}

        {stats.length > 0 ? (
          <Space wrap size={8}>
            {stats.map((stat) => (
              <StatChip key={stat.source_key} stat={stat} />
            ))}
          </Space>
        ) : null}

        {absences.length > 0 ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {absences.map((absence, index) => (
              <AbsenceRow key={`absence-${absence.what}-${index}`} absence={absence} />
            ))}
          </Space>
        ) : null}

        {isSearch && payload !== null ? <SearchPostsPanel payload={payload} /> : null}

        {notes.length > 0 ? (
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }} className="tq-muted">
            {notes.map((note, index) => (
              <li key={`note-${index}`}>{note}</li>
            ))}
          </ul>
        ) : null}

        {payload === null ? (
          // run.ts's `TOOL ERROR (name): reason` string, or anything else that is
          // not JSON. Shown verbatim — a failure is never paraphrased here.
          <div
            dir="auto"
            style={{ fontSize: 12, whiteSpace: 'pre-wrap', color: '#a8071a' }}
          >
            {row.content}
          </div>
        ) : (
          <Collapse
            size="small"
            items={[
              {
                key: 'raw',
                label: (
                  <span className="tq-muted" style={{ fontSize: 12 }}>
                    {tt(
                      'ما رآه النموذج من هذه الأداة، حرفياً',
                      'What the model received from this tool, verbatim',
                    )}
                  </span>
                ),
                children: (
                  <pre
                    dir="ltr"
                    style={{
                      margin: 0,
                      fontSize: 11,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxBlockSize: 320,
                      overflow: 'auto',
                    }}
                  >
                    {row.content}
                  </pre>
                ),
              },
            ]}
          />
        )}
      </Space>
    </div>
  );
}

/* ================================================================== cards == */

/**
 * The concepts a dispatch produced, rendered by the SAME component the Concepts
 * board uses — not a second version of it.
 *
 * This does not breach hard rule 17. The card carries ids, never prose; the
 * concept text is read from the `concepts` table through the operator's own
 * authenticated route, exactly as /concepts reads it. The chat never carried the
 * deliverable, and this screen never asks it to.
 */
function DispatchedConcepts({
  ids,
  concepts,
  pillars,
  error,
}: {
  ids: string[];
  concepts: Map<string, ConceptRow>;
  pillars: PillarRow[];
  error: string | null;
}) {
  const { tt, locale } = useLocale();

  const pillarName = useCallback(
    (pillarId: string | null): string | null => {
      if (pillarId === null) return null;
      const pillar = pillars.find((each) => each.id === pillarId);
      if (!pillar) return null;
      return locale === 'ar' ? pillar.name_ar : pillar.name_en ?? pillar.name_ar;
    },
    [pillars, locale],
  );

  if (error !== null) {
    return (
      <div className="tq-muted" style={{ fontSize: 12 }}>
        {tt('تعذّرت قراءة الأفكار المحفوظة: ', 'The stored concepts could not be read: ')}
        {error}
      </div>
    );
  }

  return (
    <Row gutter={[12, 12]}>
      {ids.map((id) => {
        const concept = concepts.get(id);
        if (!concept) {
          return (
            <Col xs={24} key={id}>
              <div className="tq-muted" style={{ fontSize: 12 }}>
                <code dir="ltr">{id}</code>{' '}
                {tt(
                  '— أبلغت الميزة عن هذا المعرّف ولم يظهر في قراءة الأفكار. افتحه من شاشة الأفكار.',
                  '— the feature reported this id and it was not in the concepts read. Open it on the Concepts screen.',
                )}
              </div>
            </Col>
          );
        }
        return (
          <Col xs={24} xl={12} key={id}>
            <ConceptCard concept={concept} pillarName={pillarName(concept.pillar_id)} compact />
          </Col>
        );
      })}
    </Row>
  );
}

/**
 * A dispatched deliverable, as the REFERENCE it is.
 *
 * Every field here is a scalar the dispatcher put on the card; none of them can
 * carry the artefact's words. `law_passed: null` means the feature ran no brain
 * gate — it is rendered as an em-dash, never as "passed".
 */
function DispatchCardView({
  card,
  concepts,
  pillars,
  conceptsError,
}: {
  card: Record<string, unknown>;
  concepts: Map<string, ConceptRow>;
  pillars: PillarRow[];
  conceptsError: string | null;
}) {
  const { tt } = useLocale();
  const feature = readString(card, 'feature') ?? readString(card, 'label') ?? '—';
  const href = readString(card, 'href');
  const ids = readStrings(card, 'ids');
  const shape = readString(card, 'persisted_shape');
  const needsHuman = readBoolean(card, 'needs_human') ?? false;
  const lawPassed = readBoolean(card, 'law_passed');
  const capUnits = readNumber(card, 'cap_units');
  const estUsd = readNumber(card, 'est_usd');
  const unpriced = readString(card, 'unpriced_reason');
  const rendersConcepts = feature === 'concepts' || feature === 'storyboard';

  return (
    <Card
      size="small"
      style={{ borderColor: GOLD }}
      title={
        <Space wrap size={8} align="center">
          <Tag color="gold" style={{ marginInlineEnd: 0 }}>
            {tt('أُنجزت بواسطة الميزة', 'Produced by the feature')}
          </Tag>
          <code dir="ltr" style={{ fontSize: 13 }}>
            {feature}
          </code>
        </Space>
      }
      extra={
        href ? (
          <Link href={href}>
            <Button size="small">{tt('افتحها', 'Open it')}</Button>
          </Link>
        ) : null
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space wrap size={12} style={{ fontSize: 12 }}>
          <span>
            {tt('عناصر أُنشئت: ', 'Artefacts created: ')}
            <Sourced source="dispatch_card.ids">
              <span className="tq-num">{formatNumber(ids.length)}</span>
            </Sourced>
          </span>
          <span>
            {tt('وحدات من السقف: ', 'Cap units taken: ')}
            <Sourced source="dispatch_card.cap_units">
              <span className="tq-num">{formatNumber(capUnits)}</span>
            </Sourced>
          </span>
          <span>
            {tt('التكلفة التقديرية: ', 'Estimated cost: ')}
            <Sourced
              source="dispatch_card.est_usd"
              note={
                unpriced ??
                tt(
                  'خالٍ يعني غير مُسعَّر، لا مجاني.',
                  'Null means unpriced, never free.',
                )
              }
            >
              <span className="tq-num">{estUsd === null ? '—' : `$${estUsd}`}</span>
            </Sourced>
          </span>
          <span>
            {tt('القانون: ', 'Law: ')}
            {lawPassed === null ? (
              <Tooltip
                title={tt(
                  'لم تمرّ هذه الميزة ببوابة قانون، فلا يوجد حكم — ولا يُكتب «مرّت» عن بوابة لم تعمل.',
                  'This feature runs no Law gate, so there is no verdict — and "passed" is never written for a gate that did not run.',
                )}
              >
                <span className="tq-num">—</span>
              </Tooltip>
            ) : (
              <Tag color={lawPassed ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>
                {lawPassed ? tt('مرّ', 'PASSED') : tt('رسب', 'FAILED')}
              </Tag>
            )}
          </span>
          {shape === 'none' ? (
            <span className="tq-muted">
              {tt(
                'لم تُسمِّ الميزة أي معرّف — وهذا وصف للقراءة، لا نفي لوجود صفوف.',
                'The feature named no id — that is a fact about the read, not a claim that nothing was written.',
              )}
            </span>
          ) : null}
        </Space>

        {needsHuman ? (
          <Alert
            type="warning"
            showIcon
            message={tt('يحتاج مراجعة بشرية قبل الاستخدام', 'Needs a human read before use')}
          />
        ) : null}

        {rendersConcepts && ids.length > 0 ? (
          <DispatchedConcepts
            ids={ids}
            concepts={concepts}
            pillars={pillars}
            error={conceptsError}
          />
        ) : null}

        <span className="tq-muted" style={{ fontSize: 11 }}>
          {tt(
            'النصّ نفسه لم يمرّ عبر الدردشة إطلاقاً: أنتجته الميزة التي تملكه، بعد بوابتها كاملة.',
            'The text itself never travelled through the chat: the feature that owns it produced it, behind its own full gate.',
          )}
        </span>
      </Space>
    </Card>
  );
}

/**
 * A compliance check, as a REFERENCE to the stored ruling.
 *
 * The Compliance screen's own verdict renderer is defined inside its
 * `page.tsx`, where Next's export allow-list forbids exporting it — so it
 * cannot be imported here, and a copy of it would be exactly the second version
 * this screen is not allowed to build. The stored flags are therefore rendered
 * as the facts they are, and the full ruling is one link away, where the
 * component that owns it lives. Lifting that renderer into `src/components/` is
 * reported rather than done from here.
 */
function ComplianceCardView({ card }: { card: Record<string, unknown> }) {
  const { tt } = useLocale();
  const subject = readString(card, 'subject') ?? '—';
  const passed = readBoolean(card, 'passed');
  const lawPassed = readBoolean(card, 'law_passed');
  const judgeStatus = readString(card, 'judge_status');
  const violations = readNumber(card, 'violation_count');
  const needsHuman = readBoolean(card, 'needs_human') ?? false;
  const checkId = readString(card, 'check_id');

  const yesNo = (value: boolean | null): React.ReactNode =>
    value === null ? <span className="tq-num">—</span> : value ? tt('نعم', 'Yes') : tt('لا', 'No');

  return (
    <Card
      size="small"
      title={
        <Space wrap size={8} align="center">
          <span>{tt('فحص التزام', 'Compliance check')}</span>
          <code dir="ltr" style={{ fontSize: 12 }}>
            {subject}
          </code>
        </Space>
      }
      extra={
        <Link href="/compliance">
          <Button size="small">{tt('الحكم الكامل', 'The full ruling')}</Button>
        </Link>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap size={12} style={{ fontSize: 12 }}>
          <span>
            {tt('مطابق: ', 'Passed: ')}
            {yesNo(passed)}
          </span>
          <span>
            {tt('القانون: ', 'Law: ')}
            {yesNo(lawPassed)}
          </span>
          <span>
            {tt('القاضي: ', 'Judge: ')}
            <code dir="ltr">{judgeStatus ?? '—'}</code>
          </span>
          <span>
            {tt('مخالفات القانون: ', 'Law violations: ')}
            <Sourced source="compliance_card.violation_count">
              <span className="tq-num">{formatNumber(violations)}</span>
            </Sourced>
          </span>
        </Space>

        {needsHuman ? (
          <Alert type="warning" showIcon message={tt('يحتاج مراجعة بشرية', 'Needs human review')} />
        ) : null}

        <span className="tq-muted" style={{ fontSize: 11 }}>
          {checkId ? (
            <>
              {tt('السجل: ', 'Ledger row: ')}
              <code dir="ltr">{checkId}</code>
            </>
          ) : (
            tt(
              'لم يُسجَّل صفّ لهذا الفحص — يُكتب السجل حين يصدر القاضي حكماً فقط.',
              'No ledger row was written for this check — one is written only when the Judge actually rules.',
            )
          )}
        </span>
      </Space>
    </Card>
  );
}

function ToolFailureCardView({ card }: { card: Record<string, unknown> }) {
  const { tt } = useLocale();
  return (
    <Alert
      type="error"
      showIcon
      message={
        <Space wrap size={8} align="center">
          <span>{tt('فشلت أداة', 'A tool failed')}</span>
          <code dir="ltr" style={{ fontSize: 12 }}>
            {readString(card, 'tool') ?? '—'}
          </code>
          <code dir="ltr" style={{ fontSize: 12 }}>
            {readString(card, 'refusal') ?? '—'}
          </code>
        </Space>
      }
      description={
        <div dir="auto">
          {readString(card, 'reason') ?? tt('لم يُسجَّل سبب.', 'No reason was recorded.')}
        </div>
      }
    />
  );
}

/** A card kind this screen does not know. Shown raw rather than dropped. */
function UnknownCardView({ card }: { card: Record<string, unknown> }) {
  const { tt } = useLocale();
  return (
    <Collapse
      size="small"
      items={[
        {
          key: 'unknown',
          label: (
            <span className="tq-muted" style={{ fontSize: 12 }}>
              {tt(
                'بطاقة بنوع لا تعرفه هذه الشاشة — معروضة كما هي بدل إخفائها',
                'A card of a kind this screen does not know — shown as it is rather than hidden',
              )}
            </span>
          ),
          children: (
            <pre
              dir="ltr"
              style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {JSON.stringify(card, null, 2)}
            </pre>
          ),
        },
      ]}
    />
  );
}

function CardView({
  card,
  concepts,
  pillars,
  conceptsError,
}: {
  card: Record<string, unknown>;
  concepts: Map<string, ConceptRow>;
  pillars: PillarRow[];
  conceptsError: string | null;
}) {
  const kind = readString(card, 'kind');
  if (kind === 'dispatch') {
    return (
      <DispatchCardView
        card={card}
        concepts={concepts}
        pillars={pillars}
        conceptsError={conceptsError}
      />
    );
  }
  if (kind === 'compliance') return <ComplianceCardView card={card} />;
  if (kind === 'tool_failure') return <ToolFailureCardView card={card} />;
  return <UnknownCardView card={card} />;
}

/* =============================================================== the reply == */

/**
 * The delivered text, with the strip marker made visible where it stands.
 *
 * run.ts puts `UNSOURCED_CHIP` INTO the text, in place of a number it could not
 * source. This splits on that exact marker and renders a chip at each seam, so
 * the removal is legible rather than a run of Arabic guillemets a reader skims
 * past. Everything between the seams is the model's text, untouched.
 */
function ReplyBody({ text }: { text: string }) {
  const { tt } = useLocale();
  const segments = text.split(UNSOURCED_CHIP);

  return (
    <ArabicText style={{ whiteSpace: 'pre-wrap', fontSize: 15 }}>
      {segments.map((segment, index) => (
        <span key={`segment-${index}`}>
          {index === 0 ? null : (
            <Tooltip
              title={tt(
                'ذكر هذا الموضع رقماً لا يظهر في أي مصدر قُدِّم للنموذج، فحُذف قبل التسليم.',
                'A number stood here that appears in no source the model was given, so it was removed before delivery.',
              )}
            >
              <mark
                dir="rtl"
                style={{
                  background: 'rgba(207, 19, 34, 0.10)',
                  border: '1px solid rgba(207, 19, 34, 0.45)',
                  color: '#a8071a',
                  borderRadius: 6,
                  paddingInline: 6,
                  paddingBlock: 1,
                  fontSize: 13,
                  fontWeight: 600,
                  unicodeBidi: 'isolate',
                  whiteSpace: 'nowrap',
                }}
              >
                {UNSOURCED_CHIP}
              </mark>
            </Tooltip>
          )}
          {segment}
        </span>
      ))}
    </ArabicText>
  );
}

/**
 * What the gate did to this turn.
 *
 * The REMOVED NUMBERS ARE NEVER PRINTED. `law_report.stripped` holds them
 * verbatim, and putting them back on the screen would undo the only thing the
 * strip accomplished. The count is reported — it is a fact about the report,
 * not a claim about the accounts — and the values stay in the row for an audit
 * that goes to the database.
 */
function LawFooter({ row }: { row: ChatMessageRow }) {
  const { tt } = useLocale();
  const report = row.law_report;

  return (
    <Space wrap size={12} style={{ fontSize: 11, marginBlockStart: 8 }} className="tq-muted">
      {report === null ? (
        <span>
          {tt(
            'لا تقرير فحص محفوظ مع هذا الدور.',
            'No lint report is stored with this turn.',
          )}
        </span>
      ) : (
        <>
          <span>
            {report.passed
              ? tt('مرّ فحص الأرقام', 'Numbers checked')
              : tt('لم يمرّ فحص الأرقام', 'The number check did not pass')}
          </span>
          {report.repaired ? (
            <span>
              {tt(
                'أُعيدت صياغته مرة واحدة قبل التسليم',
                'Rewritten once before delivery',
              )}
            </span>
          ) : null}
          {report.stripped.length > 0 ? (
            <span style={{ color: '#a8071a' }}>
              <Sourced
                source="chat_messages.law_report.stripped"
                note={tt(
                  'الأرقام المحذوفة محفوظة في الصف للمراجعة، ولا تُطبع هنا: طباعتها تُبطل الحذف نفسه.',
                  'The removed numbers are kept on the row for an audit and are deliberately not printed here: printing them would undo the removal.',
                )}
              >
                <span className="tq-num">{formatNumber(report.stripped.length)}</span>
              </Sourced>{' '}
              {tt('رقم حُذف', 'number(s) removed')}
            </span>
          ) : null}
        </>
      )}

      <span>
        {tt('التكلفة التقديرية: ', 'Estimated cost: ')}
        <Sourced
          source="chat_messages.est_usd"
          note={tt(
            'خالٍ يعني غير مُسعَّر — لا سعر منشور مُتحقَّق منه للنموذج الذي أجاب. لا يعني مجاناً، ولا يُعرض صفراً.',
            'Null means unpriced — no verified published rate exists for the model that answered. It never means free, and it is never shown as zero.',
          )}
        >
          <span className="tq-num">{row.est_usd === null ? '—' : `$${row.est_usd}`}</span>
        </Sourced>
      </span>
    </Space>
  );
}

/* ============================================================== the bubbles = */

function UserBubble({ text, pending }: { text: string; pending?: boolean }) {
  const { tt } = useLocale();
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxInlineSize: '80%',
          background: 'rgba(201, 162, 39, 0.12)',
          border: '1px solid rgba(201, 162, 39, 0.35)',
          borderRadius: 12,
          paddingInline: 14,
          paddingBlock: 10,
        }}
      >
        <div dir="auto" className="tq-ar" style={{ whiteSpace: 'pre-wrap', fontSize: 15 }}>
          {text}
        </div>
        {pending ? (
          <div className="tq-muted" style={{ fontSize: 11, marginBlockStart: 4 }}>
            {tt('سُجِّل قبل تشغيل النموذج', 'Recorded before the model ran')}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantBubble({
  row,
  concepts,
  pillars,
  conceptsError,
}: {
  row: ChatMessageRow;
  concepts: Map<string, ConceptRow>;
  pillars: PillarRow[];
  conceptsError: string | null;
}) {
  const { tt } = useLocale();
  const cards = row.cards ?? [];
  const hasText = row.content.trim().length > 0;

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div
        style={{
          maxInlineSize: '92%',
          inlineSize: cards.length > 0 ? '92%' : undefined,
          background: '#fff',
          border: '1px solid var(--tq-line)',
          borderRadius: 12,
          paddingInline: 14,
          paddingBlock: 10,
        }}
      >
        {hasText ? (
          <ReplyBody text={row.content} />
        ) : (
          <span className="tq-muted" style={{ fontSize: 13 }}>
            {tt(
              'بلا نصّ — البطاقة أدناه هي الرد.',
              'No prose — the card below is the answer.',
            )}
          </span>
        )}

        {cards.length > 0 ? (
          <Space direction="vertical" size={12} style={{ width: '100%', marginBlockStart: 12 }}>
            {cards.map((card, index) => (
              <CardView
                key={`card-${row.id}-${index}`}
                card={card}
                concepts={concepts}
                pillars={pillars}
                conceptsError={conceptsError}
              />
            ))}
          </Space>
        ) : null}

        <LawFooter row={row} />
      </div>
    </div>
  );
}

/* ====================================================== the typing indicator = */

/**
 * The wait, made to read as deliberate rather than broken.
 *
 * It states the INVARIANT and not a stage. The route emits no progress events,
 * so "reading the blocks…", "linting…" would be a fabricated narrative on the
 * one screen built to prove nothing unverified is displayed. What IS true at
 * every instant of the wait is the sentence below, so that is what it says.
 *
 * The elapsed count is measured HERE, by this browser, since the send — its
 * provenance is written next to it rather than implied.
 */
function ThinkingBubble({ pulse, elapsed }: { pulse: number; elapsed: number }) {
  const { tt } = useLocale();
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div
        style={{
          maxInlineSize: '92%',
          background: '#fff',
          border: `1px solid ${GOLD}`,
          borderRadius: 12,
          paddingInline: 14,
          paddingBlock: 10,
        }}
      >
        <Space size={10} align="center">
          <span aria-hidden="true" style={{ display: 'inline-flex', gap: 5 }}>
            {[0, 1, 2].map((dot) => (
              <span
                key={`dot-${dot}`}
                style={{
                  inlineSize: 7,
                  blockSize: 7,
                  borderRadius: '50%',
                  background: GOLD,
                  opacity: dot === pulse ? 1 : 0.28,
                  transition: 'opacity 220ms linear',
                }}
              />
            ))}
          </span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{tt('يفكّر…', 'Thinking…')}</span>
        </Space>

        <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 6, lineHeight: 1.9 }}>
          {tt(
            'يُكتب الرد كاملاً ثم تُفحص كل أرقامه مقابل المصادر قبل أن يظهر أي حرف منه. الانتظار مقصود: رقم يُعرض ثم يُسحب أسوأ من رد بطيء.',
            'The reply is written in full and every number in it is checked against the sources before a single character appears. The wait is deliberate: a number shown and then retracted is worse than a slow answer.',
          )}
        </div>

        <div className="tq-muted" style={{ fontSize: 11, marginBlockStart: 6 }}>
          <span className="tq-num">{formatNumber(elapsed)}</span>{' '}
          {tt(
            'ثانية منذ الإرسال — بحسب ساعة هذا المتصفّح، لا الخادم.',
            'second(s) since you pressed send — by this browser’s clock, not the server’s.',
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================== the starters = */

interface Starter {
  ar: string;
  en: string;
  /** The named computation in stats.ts that answers it. A label, not a call. */
  lookup: string;
}

/**
 * Three questions this deployment can actually answer today — two of them
 * measured, one of them not.
 *
 * The follower question is here ON PURPOSE. `profile_snapshots` is empty, so the
 * honest reply is that the measurement does not exist and what a profile pull
 * would create. That is the discipline working in public, and it is a better
 * first impression than a demo that only shows the happy path.
 */
const STARTERS: readonly Starter[] = [
  {
    ar: 'شو الفرق بين الحساب الشخصي وحساب الأكاديمية بالأرقام؟',
    en: 'What is the gap between the personal account and the academy account, in numbers?',
    lookup: LOOKUP_ACCOUNT_AVERAGES,
  },
  {
    ar: 'أي ساعات الأسبوع بتوصل منشوراته لأكثر تفاعل؟',
    en: 'Which hours of the week do his posts actually land in?',
    lookup: LOOKUP_TIMING_WINDOWS,
  },
  {
    ar: 'كم متابع عند الحسابين، وكم تغيّر العدد؟',
    en: 'How many followers do the two accounts have, and how has that changed?',
    lookup: LOOKUP_FOLLOWER_HISTORY,
  },
];

/* ================================================================= the page = */

export default function ChatPage() {
  const { tt, locale } = useLocale();
  const { notification } = App.useApp();

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<{ message: string; hint: string | null } | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<{ message: string; hint: string | null } | null>(
    null,
  );

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [sendError, setSendError] = useState<{ message: string; hint: string | null } | null>(null);

  const [pulse, setPulse] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  const [conceptIndex, setConceptIndex] = useState<Map<string, ConceptRow>>(new Map());
  const [pillars, setPillars] = useState<PillarRow[]>([]);
  const [conceptsError, setConceptsError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  /* ---- the conversations ------------------------------------------------- */

  const loadConversations = useCallback(async (): Promise<ConversationRow[]> => {
    setListError(null);
    try {
      const data = await apiGet<ChatListResponse>('/api/chat');
      const rows = data.conversations ?? [];
      setConversations(rows);
      return rows;
    } catch (err) {
      setListError(describeError(err));
      return [];
    } finally {
      setListLoading(false);
    }
  }, []);

  /* ---- one thread, read back from the rows -------------------------------- */

  /**
   * A dispatch card names concept ids and nothing else — by design. The rows
   * themselves are read from `/api/concepts`, the same route the Concepts board
   * uses, so the card stays a reference and the operator still sees the work.
   * A failure here is reported on the card, not thrown: the turn happened.
   */
  const loadConceptsFor = useCallback(async (rows: ChatMessageRow[]) => {
    const wanted = new Set<string>();
    for (const row of rows) {
      for (const card of row.cards ?? []) {
        if (readString(card, 'kind') !== 'dispatch') continue;
        const feature = readString(card, 'feature');
        if (feature !== 'concepts' && feature !== 'storyboard') continue;
        for (const id of readStrings(card, 'ids')) wanted.add(id);
      }
    }
    if (wanted.size === 0) return;

    setConceptsError(null);
    try {
      const data = await apiGet<ConceptsResponse>('/api/concepts');
      setConceptIndex(new Map((data.concepts ?? []).map((concept) => [concept.id, concept])));
      setPillars(data.pillars ?? []);
    } catch (err) {
      setConceptsError(describeError(err).message);
    }
  }, []);

  const loadThread = useCallback(
    async (id: string) => {
      setThreadLoading(true);
      setThreadError(null);
      try {
        const data = await apiGet<ChatThreadResponse>(`/api/chat?id=${encodeURIComponent(id)}`);
        const rows = data.messages ?? [];
        setMessages(rows);
        await loadConceptsFor(rows);
      } catch (err) {
        setThreadError(describeError(err));
      } finally {
        setThreadLoading(false);
      }
    },
    [loadConceptsFor],
  );

  useEffect(() => {
    void (async () => {
      const rows = await loadConversations();
      const newest = rows[0];
      if (newest) {
        setActiveId(newest.id);
        await loadThread(newest.id);
      }
    })();
  }, [loadConversations, loadThread]);

  /* ---- the wait ----------------------------------------------------------- */

  useEffect(() => {
    if (!sending) return;
    const startedAt = Date.now();
    setPulse(0);
    setElapsed(0);
    const timer = window.setInterval(() => {
      setPulse((current) => (current + 1) % 3);
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 450);
    return () => window.clearInterval(timer);
  }, [sending]);

  /** The newest turn, always in view — including the moment the wait begins. */
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, sending, pendingText]);

  /* ---- the cap ------------------------------------------------------------ */

  /**
   * Derived from THIS conversation's stored tool rows and from nothing else.
   * No route exposes the cap to a browser, so the only honest source is a
   * refusal the operator has actually been handed.
   */
  const capNotice = useMemo<CapNotice | null>(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const row = messages[index];
      if (row.role !== 'tool') continue;
      const payload = parseToolPayload(row.content);
      if (payload === null) continue;
      const notice = readCapNotice(payload);
      if (notice !== null) return notice;
    }
    return null;
  }, [messages]);

  const overCap = capNotice !== null && capStillBinds(capNotice);

  /* ---- sending ------------------------------------------------------------ */

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (message.length === 0 || sending || overCap) return;

      setSending(true);
      setSendError(null);
      setPendingText(message);
      setDraft('');

      try {
        const res = await apiSend<ChatPostResponse>('/api/chat', 'POST', {
          conversation_id: activeId,
          message,
        });
        setActiveId(res.conversation_id);
        // Everything is read back from the stored rows through the same GET a
        // plain page load uses, so a send can show nothing a reload would not.
        await loadThread(res.conversation_id);
        await loadConversations();
      } catch (err) {
        const described = describeError(err);
        setSendError(described);
        notification.error({
          message: tt('لم يكتمل هذا الدور', 'That turn did not complete'),
          description: described.message,
        });
        // The route records the operator's message BEFORE the model runs, so a
        // failed turn may still have left it on the record. Re-reading is how
        // this screen finds out rather than guesses.
        await loadConversations();
        if (activeId !== null) await loadThread(activeId);
      } finally {
        setPendingText(null);
        setSending(false);
      }
    },
    [activeId, sending, overCap, loadThread, loadConversations, notification, tt],
  );

  const startNew = useCallback(() => {
    // No row is created here. The route opens the conversation on the first
    // POST and titles it from the operator's own first line, so an abandoned
    // "New" leaves nothing behind to clean up.
    setActiveId(null);
    setMessages([]);
    setThreadError(null);
    setSendError(null);
    setDraft('');
  }, []);

  const selectConversation = useCallback(
    (id: string) => {
      if (id === activeId) return;
      setActiveId(id);
      setMessages([]);
      setSendError(null);
      void loadThread(id);
    },
    [activeId, loadThread],
  );

  /* ---- render ------------------------------------------------------------- */

  const unavailableItems = useMemo(
    () => [
      {
        key: 'rename',
        disabled: true,
        label: (
          <span style={{ fontSize: 12 }}>
            {tt(
              'إعادة التسمية — لا مسار لها في /api/chat',
              'Rename — /api/chat has no route for it',
            )}
          </span>
        ),
      },
      {
        key: 'delete',
        disabled: true,
        label: (
          <span style={{ fontSize: 12 }}>
            {tt('الحذف — لا مسار له في /api/chat', 'Delete — /api/chat has no route for it')}
          </span>
        ),
      },
    ],
    [tt],
  );

  const composerDisabledReason = overCap
    ? tt(
        'بلغ سقف التوليد اليومي، فالإرسال موقوف حتى يُصفَّر السقف.',
        'The daily generation cap is reached, so sending is held until the window rolls over.',
      )
    : null;

  const conversationPane = (
    <Card
      size="small"
      title={tt('المحادثات', 'Conversations')}
      extra={
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={startNew}>
          {tt('جديدة', 'New')}
        </Button>
      }
      styles={{ body: { padding: 8 } }}
    >
      {listLoading ? <LoadingBlock rows={3} /> : null}
      {!listLoading && listError ? (
        <ErrorState
          error={listError.message}
          hint={listError.hint}
          onRetry={() => void loadConversations()}
        />
      ) : null}

      {!listLoading && !listError ? (
        <div style={{ maxBlockSize: 'min(56vh, 560px)', overflowY: 'auto' }}>
          {conversations.length === 0 ? (
            <div className="tq-muted" style={{ fontSize: 12, padding: 8 }}>
              {tt(
                'لا محادثات بعد. تُفتح المحادثة عند أول رسالة، ويصير عنوانها أول سطر كتبته — لا ملخّصاً يولّده نموذج.',
                'No conversations yet. One opens on your first message, and its title is your own first line — never a model-written summary.',
              )}
            </div>
          ) : (
            conversations.map((conversation) => {
              const selected = conversation.id === activeId;
              return (
                <div
                  key={conversation.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    borderRadius: 8,
                    paddingInline: 8,
                    paddingBlock: 6,
                    marginBlockEnd: 2,
                    background: selected ? 'rgba(201, 162, 39, 0.14)' : undefined,
                    borderInlineStart: `3px solid ${selected ? GOLD : 'transparent'}`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => selectConversation(conversation.id)}
                    aria-current={selected ? 'true' : undefined}
                    style={{
                      flex: 1,
                      minInlineSize: 0,
                      textAlign: 'start',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      font: 'inherit',
                      color: 'inherit',
                    }}
                  >
                    <div
                      dir="auto"
                      className="tq-ar"
                      style={{
                        fontSize: 13,
                        fontWeight: selected ? 600 : 400,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {conversation.title ?? (
                        <span className="tq-muted">
                          <span className="tq-num">—</span>{' '}
                          {tt('بلا عنوان مسجَّل', 'No title recorded')}
                        </span>
                      )}
                    </div>
                    <div className="tq-muted tq-num" style={{ fontSize: 11 }}>
                      {formatDateTime(conversation.created_at, locale)}
                    </div>
                  </button>

                  <Dropdown menu={{ items: unavailableItems }} trigger={['click']}>
                    <Button
                      type="text"
                      size="small"
                      icon={<MoreOutlined />}
                      aria-label={tt('خيارات المحادثة', 'Conversation options')}
                    />
                  </Dropdown>
                </div>
              );
            })
          )}
        </div>
      ) : null}

      <div className="tq-muted" style={{ fontSize: 11, padding: 8, lineHeight: 1.8 }}>
        {tt(
          'إعادة التسمية والحذف معطّلتان لأن /api/chat لا يقبل غير GET وPOST — لا شيء مخفيّ هنا، المسار غير موجود بعد.',
          'Rename and delete are disabled because /api/chat accepts only GET and POST — nothing is hidden here, the route does not exist yet.',
        )}
      </div>
    </Card>
  );

  const emptyPane = (
    <div style={{ paddingBlock: 24, paddingInline: 8 }}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBlockEnd: 6 }}>
        {tt('اسأل عن الحسابين', 'Ask about the two accounts')}
      </div>
      <div className="tq-muted" style={{ fontSize: 13, lineHeight: 1.9, marginBlockEnd: 16 }}>
        {tt(
          'كل رقم في الجواب مأخوذ حرفياً من مصدر يحمل مفتاحه. وأكثر القياسات غير موجودة على هذا التثبيت بعد، فجواب «لا قياس حتى الآن» جواب صحيح لا عطل — وهو ما يجعل الأرقام الموجودة تستحق التصديق.',
          'Every number in an answer is quoted verbatim from a source that carries its key. Most measurements do not exist on this deployment yet, so “no measurement yet” is a correct answer rather than a fault — and it is what makes the figures that do exist worth believing.',
        )}
      </div>

      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {STARTERS.map((starter) => (
          <button
            key={starter.lookup}
            type="button"
            disabled={sending || overCap}
            onClick={() => void send(locale === 'ar' ? starter.ar : starter.en)}
            style={{
              width: '100%',
              textAlign: 'start',
              background: '#fff',
              border: '1px solid var(--tq-line)',
              borderInlineStartWidth: 3,
              borderInlineStartColor: GOLD,
              borderRadius: 10,
              paddingInline: 14,
              paddingBlock: 12,
              cursor: sending || overCap ? 'not-allowed' : 'pointer',
              font: 'inherit',
              color: 'inherit',
              opacity: sending || overCap ? 0.55 : 1,
            }}
          >
            <div dir="auto" className="tq-ar" style={{ fontSize: 14 }}>
              {locale === 'ar' ? starter.ar : starter.en}
            </div>
            <div className="tq-muted" style={{ fontSize: 11, marginBlockStart: 4 }}>
              {tt('الحساب المسمّى: ', 'The named computation: ')}
              <code dir="ltr">{starter.lookup}</code>
            </div>
          </button>
        ))}
      </Space>
    </div>
  );

  const messagePane = (
    <Card size="small" styles={{ body: { padding: 12 } }}>
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-busy={sending}
        aria-label={tt('نص المحادثة', 'Conversation transcript')}
        style={{
          maxBlockSize: 'min(58vh, 620px)',
          minBlockSize: 260,
          overflowY: 'auto',
          paddingInline: 4,
        }}
      >
        {threadLoading ? <LoadingBlock rows={5} /> : null}
        {!threadLoading && threadError ? (
          <ErrorState
            error={threadError.message}
            hint={threadError.hint}
            onRetry={() => {
              if (activeId !== null) void loadThread(activeId);
            }}
          />
        ) : null}

        {!threadLoading && !threadError && messages.length === 0 && pendingText === null
          ? emptyPane
          : null}

        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          {messages.map((row) => {
            if (row.role === 'user') return <UserBubble key={row.id} text={row.content} />;
            if (row.role === 'tool') return <ToolRow key={row.id} row={row} />;
            return (
              <AssistantBubble
                key={row.id}
                row={row}
                concepts={conceptIndex}
                pillars={pillars}
                conceptsError={conceptsError}
              />
            );
          })}

          {pendingText !== null ? <UserBubble text={pendingText} pending /> : null}
          {sending ? <ThinkingBubble pulse={pulse} elapsed={elapsed} /> : null}
        </Space>
      </div>

      {sendError ? (
        <div style={{ marginBlockStart: 12 }}>
          <ErrorState error={sendError.message} hint={sendError.hint} />
        </div>
      ) : null}

      {capNotice !== null ? (
        <div style={{ marginBlockStart: 12 }}>
          <CapPanel notice={capNotice} />
        </div>
      ) : null}

      <div style={{ marginBlockStart: 12 }}>
        <Input.TextArea
          dir="auto"
          className="tq-ar"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send(draft);
            }
          }}
          autoSize={{ minRows: 2, maxRows: 8 }}
          maxLength={8000}
          disabled={sending}
          placeholder={tt(
            'اسأل عن الحسابين، أو اطلب عملاً من إحدى الميزات…',
            'Ask about the accounts, or ask a feature to produce something…',
          )}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            marginBlockStart: 8,
          }}
        >
          <Tooltip title={composerDisabledReason ?? ''}>
            <span style={{ display: 'inline-block' }}>
              <Button
                type="primary"
                icon={<SendOutlined />}
                loading={sending}
                disabled={sending || overCap || draft.trim().length === 0}
                onClick={() => void send(draft)}
              >
                {tt('إرسال', 'Send')}
              </Button>
            </span>
          </Tooltip>

          <span className="tq-muted" style={{ fontSize: 11 }}>
            {composerDisabledReason ??
              tt(
                'Ctrl+Enter للإرسال. الرد يصل كاملاً بعد فحص أرقامه — لا يظهر حرف قبل ذلك.',
                'Ctrl+Enter sends. The reply arrives whole, after its numbers are checked — nothing appears before that.',
              )}
          </span>
        </div>
      </div>
    </Card>
  );

  return (
    <div className="tq-page">
      <PageHeader
        title={tt('الدردشة', 'Chat')}
        subtitle={tt(
          'اسأل، أو اطلب من الميزة أن تنتج العمل. كل رقم يُنطق من مصدره أو لا يُنطق.',
          'Ask, or have a feature produce the work. A quantity is spoken from its source or not at all.',
        )}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message={tt('الردود تصل كاملة، لا حرفاً حرفاً', 'Replies arrive whole, not character by character')}
        description={tt(
          'يُكتب كل رد بالكامل ثم تُفحص أرقامه مقابل الكتل ونتائج الأدوات قبل تسليمه. والقابل للتسليم — الأفكار والحملات والتقارير والأدلة — لا يُكتب هنا: تُنتجه الميزة التي تملكه ببوابتها كاملة، ويظهر هنا كبطاقة.',
          'Every reply is written in full and its numbers are checked against the blocks and the tool results before it is delivered. And a deliverable — concepts, campaigns, reports, guidelines — is never written here: the feature that owns it produces it behind its own full gate, and it arrives as a card.',
        )}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8} xl={7}>
          {conversationPane}
        </Col>
        <Col xs={24} lg={16} xl={17}>
          {messagePane}
        </Col>
      </Row>

      <Typography.Paragraph className="tq-muted" style={{ fontSize: 11, marginBlockStart: 16 }}>
        {tt(
          'لا ترسل هذه الشاشة شيئاً إلى أحد، ولا تنشر شيئاً. كل ما يُنتَج هنا مسودّة لإنسان يقرأها.',
          'This screen sends nothing to anyone and publishes nothing. Everything produced here is a draft for a human to read.',
        )}
      </Typography.Paragraph>
    </div>
  );
}
