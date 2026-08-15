'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Space, Tag } from 'antd';
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
import { formatDate, formatDateTime, formatNumber } from '@/lib/date';
import { GOLD } from '@/lib/theme';
import type {
  Account,
  BasisRef,
  DecisionKind,
  DecisionRow,
  DigestRow,
  DigestStatus,
  ProposedDecision,
  StrategistAction,
  StrategistCorrection,
  StrategistDelta,
  StrategistFinding,
  StrategistPayload,
} from '@/lib/types/db';

/**
 * The Digest screen — one week's strategist run, and the ledger it is
 * accountable to.
 *
 * Four properties of the underlying feature shape everything below, and each one
 * is a thing this screen must not quietly undo:
 *
 * 1. EVERY CLAIM CARRIES ITS RECEIPT. A delta, a win, a concern, a correction
 *    and a decision each travel with `basis: BasisRef[]` — a `source_key` the
 *    context blocks emitted and the value they rendered under it, VERBATIM. So
 *    every statement here renders its basis beside it, and the value is printed
 *    exactly as stored: never through formatNumber(), never re-rounded, never
 *    localised. `BasisRef.value` is a string precisely so nothing downstream can
 *    recompute it (see src/lib/types/db.ts), and this screen is downstream.
 * 2. A QUIET WEEK IS AN ANSWER, NOT A FAILURE. `status: 'quiet'` means the
 *    period was read and nothing material moved. It is the state most likely to
 *    be misread as "the app is broken", so it gets a deliberate, composed
 *    treatment that says out loud why the lists are short — and the empty
 *    sections under it say "nothing was added to fill this", not "no data".
 * 3. CORRECTIONS LEAD. The strategist's contract is that a decision the data has
 *    since contradicted is named in the same digest that supersedes it. Being
 *    wrong in public is the mechanism, so corrections are the first content
 *    block on the page — above deltas, above wins.
 * 4. THIS APP SENDS NOTHING. `client_digest_ar` is a draft. There is no control
 *    on this screen that writes `digests.sent`, and there is not meant to be:
 *    the route has no path that writes it either (hard rule 1). The flag is
 *    displayed as the stored fact it is, and the copy says who moves it.
 *
 * Escalations sit above all of that. `needs_human` is a boolean on the payload;
 * the URGENCY and the receipt live on `flag_needs_human` actions — that split is
 * documented at length in src/lib/agent/features/strategist.ts as a known
 * conflict between two documents in the repo. This screen renders both halves
 * together, at the top, sorted so `now` leads. An alert nobody sees is a
 * sentence nobody read.
 */

/* ------------------------------------------------------- the stored payload -- */

/**
 * `digests.payload` holds the agent's response VERBATIM, and that response
 * carries three fields `StrategistPayload` does not declare — `actions[].type`
 * and `.spec`, `decisions[].cap` and `.kill_condition`, and `ledger_review[]`.
 * They are not speculative: `strategistResponseSchema` requires every one of
 * them, and a payload reaches the table only by passing that schema, so a stored
 * row always has them. The mismatch is a known gap in db.ts, reported by the
 * feature agent and reported again below rather than patched from here.
 *
 * They are declared as REQUIRED for that reason. What guards the runtime is not
 * the type but `textOrDash()`: every one of these values is rendered through it,
 * so a row that somehow lacks one renders an em-dash instead of the word
 * "undefined" (hard rule 2).
 */

interface ConceptRequestSpec {
  account: Account;
  pillar: string | null;
  theme: string | null;
  count: number;
}

interface ComputationRequestSpec {
  question_en: string;
  would_unlock_ar: string;
}

/** The escalation channel: the urgency and the receipt `needs_human` cannot carry. */
interface HumanFlagSpec {
  reason_ar: string;
  urgency: 'now' | 'this_week';
  basis: BasisRef[];
}

interface ConceptRequestAction extends StrategistAction {
  type: 'generate_concepts';
  spec: ConceptRequestSpec;
}

interface ComputationRequestAction extends StrategistAction {
  type: 'request_computation';
  spec: ComputationRequestSpec;
}

interface HumanFlagAction extends StrategistAction {
  type: 'flag_needs_human';
  spec: HumanFlagSpec;
}

/** Exactly the three the schema's discriminated union admits. */
type StoredAction = ConceptRequestAction | ComputationRequestAction | HumanFlagAction;

/** A proposed decision with its fence. Null on both is a recommendation, not a gap. */
interface StoredDecision extends ProposedDecision {
  cap: string | null;
  kill_condition: string | null;
}

/**
 * A verdict this run passed on a past decision. 'extended' keeps the decision
 * open and moves its date — it is deliberately not a `DecisionStatus`, so a
 * decision can never leave the open list without someone having read its outcome.
 */
interface StoredLedgerReview {
  decision_id: string;
  verdict: 'validated' | 'refuted' | 'superseded' | 'extended';
  outcome_note_ar: string;
  basis: BasisRef[];
  new_review_after: string | null;
}

interface StoredPayload extends Omit<StrategistPayload, 'actions' | 'decisions'> {
  actions: StoredAction[];
  decisions: StoredDecision[];
  ledger_review: StoredLedgerReview[];
}

interface StoredDigest extends Omit<DigestRow, 'payload'> {
  payload: StoredPayload;
}

/* ------------------------------------------------------------ the responses -- */

/** An open decision, plus the flag the route computes against today's date. */
interface LedgerDecision extends DecisionRow {
  /** Its review date has arrived and no verdict has been recorded. */
  past_review: boolean;
}

/** Whether a run would be refused, computed by the route without spending. */
interface Readiness {
  can_run: boolean;
  error: string | null;
  hint: string | null;
}

/**
 * The route's spend ceiling. `usd` is null and stays null until a verified
 * per-token rate is reachable from that module — so this screen renders an
 * em-dash and the route's own reason, never a dollar figure nobody verified.
 */
interface DigestEstimate {
  model: string;
  calls: { agent_ceiling: number; judge_ceiling: number };
  chars: {
    agent_prompt: number;
    judge_prompt: number;
    candidate_allowance: number;
    judge_overhead_allowance: number;
  };
  input_tokens_ceiling: number;
  output_tokens_ceiling: number;
  chars_per_token: number;
  usd: number | null;
  /** The published rates the ceiling was multiplied by. Null when unpriced. */
  rate_in_per_mtok: number | null;
  rate_out_per_mtok: number | null;
  unpriced_reason: string | null;
}

interface DigestGetResponse {
  digest: StoredDigest | null;
  /** OPEN decisions only, newest review date last. Never the closed ones. */
  decisions: LedgerDecision[];
  /** The open-ledger read filled its cap, so the list above is a prefix of it. */
  decisions_truncated: boolean;
  due_for_review: number;
  /** The route's own date, in Amman — the date `past_review` was computed against. */
  today: string;
  readiness: Readiness | null;
  estimate: DigestEstimate | null;
}

/**
 * The half of POST's response this screen reads. The route returns the whole
 * feature outcome — the payload, the Law report, the Judge's verdict, token
 * usage. Everything that describes the STORED digest is read back through GET
 * instead, so exactly one code path renders it whether or not this session
 * generated it.
 */
interface DigestRunResponse {
  model: string;
  attempts: number;
  persisted: {
    decisions_written: number;
    ledger_updated: number;
    /** Ledger writes that failed after the digest was stored. Never swallowed. */
    ledger_write_errors: string[];
    /** Always false: this path REQUESTS actions, it does not run them. */
    actions_executed: boolean;
    needs_human: boolean;
    judge_score: number | null;
  };
}

/* ----------------------------------------------------------------- helpers -- */

/**
 * The single gate between a stored value and the screen. Absent is an em-dash,
 * never 0 and never the word "undefined" (hard rule 2). It does not format, it
 * does not trim meaning — it only decides whether there is anything to show.
 */
function textOrDash(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const trimmed = value.trim();
  return trimmed.length === 0 ? '—' : value;
}

/**
 * A basis value that is a plain Latin number gets `.tq-num` so it stays LTR and
 * tabular inside an RTL page (hard rule 5). The TEXT is untouched either way —
 * this picks a wrapper, never a format. A value must equal, character for
 * character, what the context block rendered; running it through formatNumber()
 * would insert separators and break the equality the whole feature rests on.
 */
const LATIN_NUMERIC = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * The fence, recovered from where it is stored.
 *
 * `decisions` has no column for a cap or a kill condition, so persistStrategist()
 * appends them to `expected_signal` under ASCII, code-owned labels — precisely
 * so the halves can be told apart later by something other than a human reading
 * Arabic. This is the reader for that format and it MIRRORS `fencedSignal()` in
 * src/lib/agent/features/strategist.ts: if that writer changes, this reader
 * drifts silently. The durable fix is two additive columns; that is reported,
 * not improvised here.
 *
 * A decision written before the fence existed simply has neither label, and both
 * halves come back null — an em-dash, not an invented cap.
 */
const CAP_LABEL = '[cap] ';
const KILL_LABEL = '[kill_condition] ';

interface FencedSignal {
  signal: string;
  cap: string | null;
  kill_condition: string | null;
}

/**
 * NOT exported. Next.js validates the export surface of a page module against a
 * fixed allow-list (default, metadata, dynamic, revalidate …) and rejects
 * anything else — the 2026-08-15 CI build failed with
 * `"splitFencedSignal" is not a valid Page export field`.
 *
 * `tsc --noEmit` cannot catch this: the rule lives in the types Next generates
 * into `.next/`, which do not exist until `next build` runs. Only a real build
 * sees it. If a helper in a page or route file needs to be shared or tested,
 * move it to `src/lib/` — do not export it from here.
 */
function splitFencedSignal(stored: string): FencedSignal {
  const signal: string[] = [];
  const cap: string[] = [];
  const kill: string[] = [];
  let target = signal;
  let sawCap = false;
  let sawKill = false;

  for (const line of stored.split('\n')) {
    if (line.startsWith(CAP_LABEL)) {
      sawCap = true;
      target = cap;
      cap.push(line.slice(CAP_LABEL.length));
      continue;
    }
    if (line.startsWith(KILL_LABEL)) {
      sawKill = true;
      target = kill;
      kill.push(line.slice(KILL_LABEL.length));
      continue;
    }
    // Continuation lines belong to whichever half opened last, so a multi-line
    // cap survives the round trip instead of being read back as the signal.
    target.push(line);
  }

  const capText = cap.join('\n').trim();
  const killText = kill.join('\n').trim();
  return {
    signal: signal.join('\n').trim(),
    cap: sawCap && capText.length > 0 ? capText : null,
    kill_condition: sawKill && killText.length > 0 ? killText : null,
  };
}

const KIND_COLOURS: Record<DecisionKind, string> = {
  recommendation: 'blue',
  experiment: 'purple',
  alert: 'red',
  escalation: 'volcano',
};

function useKindLabel(): (kind: DecisionKind) => string {
  const { tt } = useLocale();
  return (kind: DecisionKind) => {
    if (kind === 'recommendation') return tt('توصية', 'Recommendation');
    if (kind === 'experiment') return tt('تجربة', 'Experiment');
    if (kind === 'alert') return tt('تنبيه', 'Alert');
    return tt('تصعيد', 'Escalation');
  };
}

/* ------------------------------------------------------------------- basis -- */

/**
 * The receipt under a claim: the key of the block line it came from, and that
 * line's value exactly as it was rendered there.
 *
 * An empty basis is not automatically a fault — a hypothesis is allowed to cite
 * nothing, and the honest reason for one is often that the measurement it wanted
 * was never taken (an absence emits no key at all, so there is nothing to cite).
 * So the empty case states what it is and does not editorialise.
 */
function BasisList({ basis }: { basis: BasisRef[] }) {
  const { tt } = useLocale();

  if (basis.length === 0) {
    return (
      <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 6 }}>
        <span className="tq-num">—</span>{' '}
        {tt('لا سند مُسجَّل مع هذه العبارة.', 'No receipt is recorded with this statement.')}
      </div>
    );
  }

  return (
    <ul
      style={{
        margin: 0,
        marginBlockStart: 6,
        paddingInlineStart: 16,
        fontSize: 12,
        listStyle: 'none',
      }}
    >
      {basis.map((ref, index) => (
        <li key={`${ref.source_key}-${index}`} style={{ marginBlockStart: index === 0 ? 0 : 4 }}>
          {/* The key is an ASCII dotted path. dir="ltr" isolates it so it reads
              correctly inside an Arabic sentence and cannot reorder its dots. */}
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
          {/* VERBATIM. Not formatted, not localised, not re-rounded — it has to
              equal the block line character for character. */}
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

/* ------------------------------------------------------------- escalations -- */

/**
 * Everything that needs a human, above everything else on the page.
 *
 * Two things land here and they are not the same thing:
 *   - `payload.needs_human` — a boolean meaning "do not send this until someone
 *     reads it". Its reason lives in `operator_notes`, so the notes are rendered
 *     INSIDE this block rather than at the bottom of the page where the reason
 *     for an alert would be, definitionally, buried.
 *   - `flag_needs_human` actions — each carrying an urgency and a receipt. These
 *     are sorted so `now` leads `this_week`.
 *
 * The alert escalates to `error` when anything is due now, and stays `warning`
 * otherwise. Nothing here is a control: reading is the action.
 */
function Escalations({
  needsHuman,
  flags,
  operatorNotes,
}: {
  needsHuman: boolean;
  flags: HumanFlagAction[];
  operatorNotes: string[];
}) {
  const { tt, locale } = useLocale();

  const sorted = useMemo(
    () =>
      [...flags].sort((a, b) => {
        if (a.spec.urgency === b.spec.urgency) return 0;
        return a.spec.urgency === 'now' ? -1 : 1;
      }),
    [flags],
  );

  if (!needsHuman && sorted.length === 0) return null;

  const anyNow = sorted.some((flag) => flag.spec.urgency === 'now');

  return (
    <Alert
      type={anyNow ? 'error' : 'warning'}
      showIcon
      style={{ marginBlockEnd: 16 }}
      message={
        needsHuman
          ? tt(
              'هذا التقرير لا يُرسل قبل أن يقرأه إنسان',
              'This digest is not to be sent until a human reads it',
            )
          : tt('يحتاج انتباه إنسان', 'Needs a human')
      }
      description={
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {sorted.map((flag, index) => (
            <div
              key={`flag-${index}`}
              style={{
                borderInlineStart: '3px solid currentColor',
                paddingInlineStart: 10,
              }}
            >
              <Space wrap size={8} align="center">
                <Tag
                  color={flag.spec.urgency === 'now' ? 'red' : 'orange'}
                  style={{ marginInlineEnd: 0 }}
                >
                  {flag.spec.urgency === 'now' ? tt('الآن', 'Now') : tt('هذا الأسبوع', 'This week')}
                </Tag>
                <span className="tq-muted" style={{ fontSize: 12 }}>
                  {flag.owner === 'operator' ? tt('المشغّل', 'Operator') : tt('العميل', 'Client')}
                </span>
                {flag.by_date === null ? null : (
                  <span className="tq-muted" style={{ fontSize: 12 }}>
                    {tt('بحلول ', 'by ')}
                    <span className="tq-num">{formatDate(flag.by_date, locale)}</span>
                  </span>
                )}
              </Space>
              <ArabicText style={{ fontWeight: 600, marginBlockStart: 4 }}>
                {textOrDash(flag.spec.reason_ar)}
              </ArabicText>
              <ArabicText style={{ fontSize: 13 }}>{textOrDash(flag.do_ar)}</ArabicText>
              <BasisList basis={flag.spec.basis} />
            </div>
          ))}

          {/* The reason for the flag, where the flag is — not at the foot of the
              page. `operator_notes` is where the prompt tells the agent to put
              it, and it is operator-only: it is never part of the client draft. */}
          {needsHuman && operatorNotes.length > 0 ? (
            <div>
              <strong style={{ fontSize: 13 }}>
                {tt('ملاحظات المشغّل — لا تُرسل للعميل', 'Operator notes — never sent to the client')}
              </strong>
              <ul style={{ margin: 0, marginBlockStart: 4, paddingInlineStart: 18 }}>
                {operatorNotes.map((note, index) => (
                  <li key={`note-${index}`} dir="auto" className="tq-ar" style={{ fontSize: 13 }}>
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {needsHuman && sorted.length === 0 && operatorNotes.length === 0 ? (
            <span>
              {tt(
                'رُفعت الراية دون أن يُكتب سبب معها. اقرأ التقرير كاملاً قبل استخدام أي شيء منه.',
                'The flag was raised with no reason recorded beside it. Read the whole digest before using any of it.',
              )}
            </span>
          ) : null}
        </Space>
      }
    />
  );
}

/* ------------------------------------------------------------- quiet state -- */

/**
 * A quiet week, designed to look like a decision rather than a failure.
 *
 * This is the state most likely to be misread. Everything on the page is short,
 * most lists are empty, and the reflex reading is "it didn't work". So the quiet
 * digest gets its own composed panel — gold rule, a plain title, and copy that
 * says the shape of the page IS the finding: the period was read, nothing
 * material moved, and nothing was written to fill the space.
 *
 * The line limit that enforces this is a policy constant owned by the feature
 * module (server-side), so it is described here in words rather than restated as
 * a number that could drift out of step with the check that enforces it.
 */
function QuietNotice() {
  const { tt } = useLocale();
  return (
    <div
      style={{
        borderInlineStart: `3px solid ${GOLD}`,
        background: 'rgba(201, 162, 39, 0.07)',
        paddingInline: 16,
        paddingBlock: 14,
        borderRadius: 8,
      }}
    >
      <div style={{ fontWeight: 600, marginBlockEnd: 6 }}>
        {tt('أسبوع هادئ — وهذا هو النظام يعمل', 'A quiet week — this is the system working')}
      </div>
      <div className="tq-muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
        {tt(
          'قُرئت الفترة كاملة ولم يتحرّك فيها ما يستحق قراراً. التقرير قصير لأن النتيجة قصيرة: القوائم أدناه فارغة لأنها فارغة فعلاً، لا لأن شيئاً فشل في التحميل، ولم يُضَف إليها شيء لملء الفراغ. الأسابيع الهادئة الصادقة هي ما يجعل الأسبوع الصاخب مسموعاً.',
          'The whole period was read and nothing material moved in it. The digest is short because the finding is short: the lists below are empty because they were empty, not because something failed to load, and nothing was written to fill them. Honest quiet weeks are what make a loud week land.',
        )}
      </div>
    </div>
  );
}

function DigestStatusTag({ status }: { status: DigestStatus }) {
  const { tt } = useLocale();
  if (status === 'quiet') {
    return (
      <Tag color="gold" style={{ marginInlineEnd: 0 }}>
        {tt('هادئ — عن قصد', 'Quiet — deliberate')}
      </Tag>
    );
  }
  return (
    <Tag color="blue" style={{ marginInlineEnd: 0 }}>
      {tt('فيه ما يستحق', 'Material')}
    </Tag>
  );
}

/* ------------------------------------------------------ statements & lists -- */

/**
 * What an empty section says. Under a quiet digest the emptiness is the point,
 * so it is named as such; under a material one it is simply what was recorded.
 * Neither wording implies a failure, and neither prints a zero.
 */
function useEmptyCopy(status: DigestStatus | null): string {
  const { tt } = useLocale();
  if (status === 'quiet') {
    return tt(
      'لا شيء هنا — ولم يُكتب شيء لملء الفراغ.',
      'Nothing here — and nothing was written to fill the space.',
    );
  }
  return tt('لم يُسجَّل شيء في هذا القسم.', 'Nothing was recorded in this section.');
}

function Statement({
  text,
  basis,
  grounding,
  accent,
  lead,
}: {
  text: string;
  basis: BasisRef[];
  grounding?: 'data' | 'hypothesis';
  accent?: string;
  lead?: React.ReactNode;
}) {
  return (
    <div
      style={
        accent
          ? { borderInlineStart: `3px solid ${accent}`, paddingInlineStart: 12 }
          : undefined
      }
    >
      {lead ? <div style={{ marginBlockEnd: 4 }}>{lead}</div> : null}
      <ArabicText style={{ fontSize: 15 }}>{textOrDash(text)}</ArabicText>
      {grounding ? (
        <div style={{ marginBlockStart: 4 }}>
          <GroundingTag grounding={grounding} />
        </div>
      ) : null}
      <BasisList basis={basis} />
    </div>
  );
}

function DeltaRow({ delta }: { delta: StrategistDelta }) {
  const { tt } = useLocale();
  // Neutral by design: "up" is not automatically good — followers up and unfollows
  // up are the same arrow. The direction is stated; the judgement is not.
  const arrow = delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→';
  const word =
    delta.direction === 'up'
      ? tt('ارتفاع', 'Up')
      : delta.direction === 'down'
        ? tt('انخفاض', 'Down')
        : tt('ثبات', 'Flat');

  return (
    <Statement
      text={delta.label_ar}
      basis={delta.basis}
      grounding={delta.grounding}
      lead={
        <Tag style={{ marginInlineEnd: 0 }}>
          <span aria-hidden="true">{arrow}</span> {word}
        </Tag>
      }
    />
  );
}

/* -------------------------------------------------------------- the ledger -- */

/**
 * One decision as the ledger stores it: what was decided, what would prove it,
 * when it is to be judged, and whether that date has passed with nobody having
 * judged it. `past_review` is computed by the route against its own Amman date,
 * not in the browser — a decision must not become "due" because a reader's
 * laptop clock is in another timezone.
 */
function LedgerDecisionRow({ decision }: { decision: LedgerDecision }) {
  const { tt, locale } = useLocale();
  const kindLabel = useKindLabel();
  const fence = useMemo(
    () => splitFencedSignal(decision.expected_signal),
    [decision.expected_signal],
  );

  return (
    <div
      style={{
        borderInlineStart: `3px solid ${decision.past_review ? '#cf1322' : 'var(--tq-line)'}`,
        paddingInlineStart: 12,
      }}
    >
      <Space wrap size={8} align="center">
        <Tag color={KIND_COLOURS[decision.kind]} style={{ marginInlineEnd: 0 }}>
          {kindLabel(decision.kind)}
        </Tag>
        <GroundingTag grounding={decision.grounding} />
        {decision.past_review ? (
          <Tag color="red" style={{ marginInlineEnd: 0 }}>
            {tt('حان موعد مراجعته', 'Due for review')}
          </Tag>
        ) : null}
      </Space>

      <ArabicText style={{ fontSize: 15, marginBlockStart: 6 }}>
        {textOrDash(decision.statement_ar)}
      </ArabicText>

      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} style={{ marginBlockStart: 8 }}>
        <Descriptions.Item label={tt('ما يثبته أو ينفيه', 'What would prove or refute it')}>
          <span dir="auto">{textOrDash(fence.signal)}</span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('السقف', 'Cap')}>
          <span dir="auto">{textOrDash(fence.cap)}</span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('شرط الإيقاف', 'Kill condition')}>
          <span dir="auto">{textOrDash(fence.kill_condition)}</span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('يُحكم عليه بعد', 'To be judged after')}>
          <span className="tq-num">{formatDate(decision.review_after, locale)}</span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('كُتب في', 'Written')}>
          <span className="tq-num">{formatDateTime(decision.created_at, locale)}</span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('ما وجدته المراجعة', 'What the review found')}>
          {/* Null means nobody has judged it. Unreviewed is not the same as fine,
              so it is an em-dash and never a reassuring blank. */}
          <span dir="auto">{textOrDash(decision.outcome_note)}</span>
        </Descriptions.Item>
      </Descriptions>

      <BasisList basis={decision.basis ?? []} />
    </div>
  );
}

/** A decision as this digest proposed it, before the ledger gave it an id. */
function ProposedDecisionRow({ decision, index }: { decision: StoredDecision; index: number }) {
  const { tt, locale } = useLocale();
  const kindLabel = useKindLabel();

  return (
    <div style={{ borderInlineStart: '3px solid var(--tq-line)', paddingInlineStart: 12 }}>
      <Space wrap size={8} align="center">
        <Tag style={{ marginInlineEnd: 0 }}>
          #<span className="tq-num">{formatNumber(index + 1)}</span>
        </Tag>
        <Tag color={KIND_COLOURS[decision.kind]} style={{ marginInlineEnd: 0 }}>
          {kindLabel(decision.kind)}
        </Tag>
        <GroundingTag grounding={decision.grounding} />
      </Space>

      <ArabicText style={{ fontSize: 15, marginBlockStart: 6 }}>
        {textOrDash(decision.statement_ar)}
      </ArabicText>

      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} style={{ marginBlockStart: 8 }}>
        <Descriptions.Item label={tt('ما يثبته أو ينفيه', 'What would prove or refute it')}>
          <span dir="auto">{textOrDash(decision.expected_signal)}</span>
        </Descriptions.Item>
        {/* A cap and a kill condition are REQUIRED of an experiment and checked
            in code; on any other kind, null is the honest value and renders as
            an em-dash rather than as an absence of care. */}
        <Descriptions.Item label={tt('السقف', 'Cap')}>
          <span dir="auto">{textOrDash(decision.cap)}</span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('شرط الإيقاف', 'Kill condition')}>
          <span dir="auto">{textOrDash(decision.kill_condition)}</span>
        </Descriptions.Item>
        <Descriptions.Item label={tt('يُحكم عليه بعد', 'To be judged after')}>
          <span className="tq-num">{formatDate(decision.review_after, locale)}</span>
        </Descriptions.Item>
      </Descriptions>

      <BasisList basis={decision.basis} />
    </div>
  );
}

/* ------------------------------------------------------------ the estimate -- */

/**
 * Hard rule 9: estimate before spend. The route measures the very strings the
 * run would send and returns a CEILING, in tokens, with the assumption that
 * converts characters to tokens stated beside it.
 *
 * `usd` is null and the route says why in `unpriced_reason`. That reason is
 * rendered verbatim, in English, in both locales: it names files and a symbol,
 * and a translated paraphrase of a system fact is a worse artefact than an
 * untranslated one.
 */
function EstimateDetail({ estimate }: { estimate: DigestEstimate }) {
  const { tt } = useLocale();
  return (
    <ul style={{ margin: 0, marginBlockStart: 8, paddingInlineStart: 18, fontSize: 12 }}>
      <li>
        {tt('سقف وليس عرض سعر — كل خطوة تُقرَّب لأعلى.', 'A ceiling, not a quote — every step rounds up.')}
      </li>
      <li>
        {tt('النموذج: ', 'Model: ')}
        {estimate.model}
        {tt(' — بحد أقصى ', ' — at most ')}
        <span className="tq-num">{formatNumber(estimate.calls.agent_ceiling)}</span>
        {tt(' نداء للوكيل و', ' agent call(s) and ')}
        <span className="tq-num">{formatNumber(estimate.calls.judge_ceiling)}</span>
        {tt(' نداء للحَكَم، شاملة إعادة المحاولة الواحدة.', ' judge pass(es), the single retry included.')}
      </li>
      <li>
        {tt('سقف الإدخال: ', 'Input ceiling: ')}
        <span className="tq-num">{formatNumber(estimate.input_tokens_ceiling)}</span>
        {tt(' رمز — و سقف الإخراج: ', ' tokens — output ceiling: ')}
        <span className="tq-num">{formatNumber(estimate.output_tokens_ceiling)}</span>
        {tt(' رمز.', ' tokens.')}
      </li>
      <li>
        {tt('محسوبة من ', 'Computed from ')}
        <span className="tq-num">{formatNumber(estimate.chars.agent_prompt)}</span>
        {tt(
          ' محرف مقيسة من نصّ الطلب نفسه ÷ ',
          ' characters measured from the prompt itself ÷ ',
        )}
        <span className="tq-num">{formatNumber(estimate.chars_per_token)}</span>
        {tt(
          ' محرف لكل رمز — وهذا المقسوم افتراض لا قياس.',
          ' characters per token — that divisor is an assumption, not a measurement.',
        )}
      </li>
      {/*
        THE FIGURE IS READ FROM `estimate.usd`, NOT PRINTED AS A GLYPH.

        This line used to render a literal em-dash with no reference to
        `estimate.usd` at all, so the moment the route learned to price a run
        the screen would still have shown "—" — a quantity the surface asserted
        rather than sourced, which is exactly what hard rule 12 forbids. The
        em-dash is now a CONSEQUENCE of `usd === null`, and when it appears the
        route's own reason appears with it (hard rule 2: absent is an em-dash
        with its reason, never 0 and never an unexplained dash).
      */}
      <li>
        {tt('سقف التكلفة بالدولار: ', 'Cost ceiling in dollars: ')}
        {estimate.usd === null ? (
          <>
            <span className="tq-num">—</span>
            {estimate.unpriced_reason === null ? null : <> — {estimate.unpriced_reason}</>}
          </>
        ) : (
          <>
            <span className="tq-num">${estimate.usd.toFixed(2)}</span>
            {estimate.rate_in_per_mtok === null || estimate.rate_out_per_mtok === null ? null : (
              <>
                {tt(' — بسعر ', ' — at ')}
                <span className="tq-num">${estimate.rate_in_per_mtok}</span>
                {tt(' إدخال و', ' in and ')}
                <span className="tq-num">${estimate.rate_out_per_mtok}</span>
                {tt(
                  ' إخراج لكل مليون رمز، من الأسعار المنشورة في src/lib/agent/rates.ts.',
                  ' out per million tokens, from the published rates in src/lib/agent/rates.ts.',
                )}
              </>
            )}
          </>
        )}
      </li>
    </ul>
  );
}

/* ---------------------------------------------------------------- the page -- */

export default function DigestPage() {
  const { tt, t, locale } = useLocale();
  // `modal` from App.useApp() rather than the static Modal.* API: the static one
  // renders outside this React tree, where useLocale() has no provider and the
  // confirm body would throw. This one inherits the app's context.
  const { notification, message, modal } = App.useApp();

  const [digest, setDigest] = useState<StoredDigest | null>(null);
  const [decisions, setDecisions] = useState<LedgerDecision[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [dueCount, setDueCount] = useState<number | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [estimating, setEstimating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<{ message: string; hint: string | null } | null>(null);
  // Run-scoped, and labelled as such on screen: the Judge's verdict and the
  // ledger write errors belong to the run that just happened and are not stored
  // on the digest row, so they cannot be shown for a digest this session did not
  // generate. Both are cleared the moment the next run starts.
  const [runReview, setRunReview] = useState<{
    needs_human: boolean;
    judge_score: number | null;
    attempts: number;
  } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // No `?estimate=1` here: assembling the blocks is the heaviest read in the
      // app — the same one the run performs — and a page load is not a spend.
      const data = await apiGet<DigestGetResponse>('/api/digest');
      setDigest(data.digest);
      setDecisions(data.decisions ?? []);
      setTruncated(data.decisions_truncated);
      setDueCount(data.due_for_review);
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

  const runDigest = useCallback(async () => {
    setGenerating(true);
    setGenError(null);
    setRunReview(null);
    setWarnings([]);
    try {
      // Deliberately no body. The route's estimate is computed from the DEFAULT
      // period and action budget, so sending overrides here would price one run
      // and perform another. One shape in, one shape estimated.
      const res = await apiSend<DigestRunResponse>('/api/digest', 'POST', {});
      setRunReview({
        needs_human: res.persisted.needs_human,
        judge_score: res.persisted.judge_score,
        attempts: res.attempts,
      });
      // Ledger writes that failed AFTER the digest row was stored. The run is a
      // fact by then, so these are reported rather than thrown — and reported
      // means on the screen, not in a log.
      setWarnings(res.persisted.ledger_write_errors ?? []);
      notification.success({
        message: tt('تم تشغيل التقرير', 'Digest generated'),
        description: tt(
          `بواسطة النموذج ${res.model}. كُتب ${formatNumber(res.persisted.decisions_written)} قرار في السجل، وحُدِّث ${formatNumber(res.persisted.ledger_updated)} قرار سابق. لم يُنفَّذ أي إجراء.`,
          `Generated with ${res.model}. ${formatNumber(res.persisted.decisions_written)} decision(s) written to the ledger and ${formatNumber(res.persisted.ledger_updated)} past decision(s) updated. No action was executed.`,
        ),
      });
      // Everything on screen is read back from the stored row through the same
      // GET a plain page load uses, so there is no path where a run shows
      // something a reload would not.
      await load();
    } catch (err) {
      setGenError(describeError(err));
    } finally {
      setGenerating(false);
    }
  }, [tt, notification, load]);

  /**
   * Hard rule 9, as a flow: ask the route what a run would cost and whether it
   * would be refused at all, show both, and only then offer to spend.
   *
   * A refusal is not an error to be dismissed — it is the answer, with a hint
   * attached — so it lands on the page's own error surface rather than in a
   * modal the reader closes and forgets.
   */
  const startRun = useCallback(async () => {
    setEstimating(true);
    setGenError(null);
    try {
      const preflight = await apiGet<DigestGetResponse>('/api/digest?estimate=1');

      if (preflight.readiness !== null && !preflight.readiness.can_run) {
        setGenError({
          message:
            preflight.readiness.error ??
            tt('لا يمكن تشغيل التقرير الآن.', 'The digest cannot be run right now.'),
          hint: preflight.readiness.hint,
        });
        return;
      }

      const estimate = preflight.estimate;
      if (estimate === null) {
        // No estimate, no spend. Rule 9 is a rule, not a preference.
        setGenError({
          message: tt(
            'لم يُرجِع الفحص المسبق أي تقدير للتكلفة، فلن يبدأ التشغيل.',
            'The pre-flight returned no cost estimate, so the run was not started.',
          ),
          hint: tt(
            'التقدير يسبق الإنفاق دائماً. حاول مرة أخرى، وإن تكرّر فالمسار المسؤول هو GET /api/digest?estimate=1.',
            'An estimate always precedes a spend. Try again; if it repeats, the path responsible is GET /api/digest?estimate=1.',
          ),
        });
        return;
      }

      modal.confirm({
        title: tt('تشغيل التقرير الأسبوعي', 'Run the weekly digest'),
        width: 640,
        content: (
          <div>
            <div>
              {tt(
                'يشغّل هذا الاستراتيجي مرّة واحدة على الفترة المنتهية اليوم، ويكتب تقريراً جديداً ويضيف قراراته إلى السجل. لا يستبدل التقرير المُخزَّن، ولا يرسل شيئاً إلى أحد.',
                'This runs the strategist once over the period ending today, writes a NEW digest, and appends the decisions it commits to onto the ledger. It does not replace the stored digest, and it sends nothing to anyone.',
              )}
            </div>
            {preflight.readiness === null ? (
              <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
                {tt(
                  'لم يُبلَّغ عن جاهزية التشغيل مع هذا التقدير، فقد يُرفض التشغيل عند بدئه.',
                  'Readiness was not reported alongside this estimate, so the run may still be refused when it starts.',
                )}
              </div>
            ) : null}
            <EstimateDetail estimate={estimate} />
          </div>
        ),
        okText: tt('تشغيل', 'Run'),
        cancelText: t.common.cancel,
        onOk: () => {
          void runDigest();
        },
      });
    } catch (err) {
      setGenError(describeError(err));
    } finally {
      setEstimating(false);
    }
  }, [modal, tt, t, runDigest]);

  const handleCopy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        message.success(t.common.copied);
      } catch {
        message.error(
          tt(
            'تعذّر النسخ إلى الحافظة. حدّد النص وانسخه يدوياً.',
            'Could not copy to the clipboard. Select the text and copy it by hand.',
          ),
        );
      }
    },
    [message, t, tt],
  );

  const payload = digest?.payload ?? null;
  const emptyCopy = useEmptyCopy(payload?.status ?? null);

  const humanFlags = useMemo<HumanFlagAction[]>(
    () =>
      (payload?.actions ?? []).filter(
        (action): action is HumanFlagAction => action.type === 'flag_needs_human',
      ),
    [payload],
  );

  /** Everything except the escalations, which are rendered in full at the top. */
  const otherActions = useMemo(
    () => (payload?.actions ?? []).filter((action) => action.type !== 'flag_needs_human'),
    [payload],
  );

  /**
   * `ledger_review` is one of the fields THIS FILE declares and `StrategistPayload`
   * does not, so this file defends it: a row without it renders an absent section
   * rather than throwing on `.length` and taking the whole screen down. The arrays
   * the foundation's own type declares are read as declared — defending those here
   * would be this screen second-guessing a contract it does not own.
   */
  const ledgerReview = useMemo<StoredLedgerReview[]>(
    () => payload?.ledger_review ?? [],
    [payload],
  );

  const headerExtra = (
    <Button
      type="primary"
      loading={estimating || generating}
      disabled={loading}
      onClick={() => void startRun()}
    >
      {digest === null ? tt('تشغيل التقرير', 'Run the digest') : tt('تشغيل تقرير جديد', 'Run a new digest')}
    </Button>
  );

  return (
    <div className="tq-page">
      <PageHeader
        title={tt('التقرير الأسبوعي', 'Weekly digest')}
        subtitle={tt(
          'ما تحرّك، وما قُرِّر بناءً عليه، وتاريخ الحكم على كل قرار. كل عبارة معها سندها.',
          'What moved, what was decided because of it, and the date each decision gets judged. Every statement carries its receipt.',
        )}
        extra={headerExtra}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message={tt('هذا التطبيق لا يرسل شيئاً', 'This app sends nothing')}
        description={tt(
          'المسودة الموجّهة للعميل تُكتب هنا وتُنسخ يدوياً. لا يوجد في هذه الشاشة زر إرسال، ولا يكتب التطبيق علامة «أُرسل» على أي تقرير — يسجّلها إنسان بعد أن يرسل فعلاً. والإجراءات المطلوبة أدناه طلبات موجَّهة لإنسان، لا شيء ينفّذها لأن الوكيل طلبها.',
          'The client-facing draft is written here and copied out by hand. There is no send control on this screen, and this app never writes the “sent” flag on a digest — a human records that after actually sending it. The actions below are requests addressed to a human; nothing executes them because the agent asked.',
        )}
      />

      {genError ? <ErrorState error={genError.message} hint={genError.hint} /> : null}

      {/* The Judge's verdict on the run that just happened, stated before the
          findings it is a verdict on. It is not stored on the digest row, so the
          wording says whose verdict it is and that a reload will not show it. */}
      {runReview?.needs_human ? (
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
              <span className="tq-num">{formatNumber(runReview.judge_score)}</span>
              {tt(' · محاولات: ', ' · attempts: ')}
              <span className="tq-num">{formatNumber(runReview.attempts)}</span>
              {tt(
                '. هذا الحكم يخصّ ذلك التشغيل ولا يُحفظ مع التقرير، فلن يظهر بعد إعادة تحميل الصفحة.',
                '. This verdict belongs to that run and is not stored with the digest, so it will not appear after a page reload.',
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

      {/* Escalations first — above the digest, above the ledger, above everything
          that could push them below the fold. */}
      {!loading && !error && payload !== null ? (
        <Escalations
          needsHuman={payload.needs_human}
          flags={humanFlags}
          operatorNotes={payload.operator_notes ?? []}
        />
      ) : null}

      {!loading && !error && digest === null && decisions.length === 0 ? (
        <EmptyState
          description={tt(
            'لا يوجد تقرير أسبوعي بعد. يُنتجه تشغيل واحد للاستراتيجي على الفترة المنتهية اليوم: يقرأ سجل العلامة، أحدث لقطة تفاعل، تحليل الجمهور، ما نُشر فعلاً، وسجل القرارات — ثم يكتب التقرير والقرارات التي يلتزم بها. يُقدَّر قبل تشغيله.',
            'No weekly digest exists yet. One is produced by a single strategist run over the period ending today: it reads the brand record, the newest engagement snapshot, the audience insight, what has actually shipped, and the decision ledger — then writes the digest and the decisions it commits to. It is estimated before it is run.',
          )}
          actionLabel={tt('تشغيل التقرير', 'Run the digest')}
          onAction={() => void startRun()}
        />
      ) : null}

      {!loading && !error && (digest !== null || decisions.length > 0) ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {digest !== null && payload !== null ? (
            <>
              {/* -------------------------------------------- headline & status -- */}
              <Card size="small">
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Space wrap size={8} align="center">
                    <DigestStatusTag status={payload.status} />
                    <span className="tq-muted" style={{ fontSize: 12 }}>
                      <span className="tq-num">{formatDate(digest.period_from, locale)}</span>
                      {' → '}
                      <span className="tq-num">{formatDate(digest.period_to, locale)}</span>
                    </span>
                  </Space>

                  <ArabicText style={{ fontSize: 19, fontWeight: 600, lineHeight: 1.8 }}>
                    {textOrDash(payload.headline_ar)}
                  </ArabicText>

                  {payload.status === 'quiet' ? <QuietNotice /> : null}

                  <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
                    <Descriptions.Item label={tt('أُنشئ في', 'Generated')}>
                      <span className="tq-num">{formatDateTime(digest.created_at, locale)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('قرارات هذا التقرير', 'Decisions this digest made')}>
                      <span className="tq-num">{formatNumber(payload.decisions.length)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('إجراءات مطلوبة', 'Actions requested')}>
                      <span className="tq-num">{formatNumber(payload.actions.length)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('مسجَّل كمُرسَل', 'Recorded as sent')}>
                      {digest.sent ? tt('نعم', 'Yes') : tt('لا', 'No')}
                    </Descriptions.Item>
                  </Descriptions>
                </Space>
              </Card>

              {/* ------------------------------------------------- corrections -- */}
              {/* First, by contract. A decision the data has since contradicted is
                  named in the same digest that supersedes it, and it leads. */}
              <Card
                size="small"
                title={tt('التصحيحات', 'Corrections')}
                extra={
                  <span className="tq-muted" style={{ fontSize: 12 }}>
                    {tt(
                      'تتصدّر التقرير عمداً — الاعتراف بالخطأ علناً هو الآلية نفسها.',
                      'These lead the digest by design — being wrong in public is the mechanism.',
                    )}
                  </span>
                }
                style={{ borderColor: payload.corrections.length > 0 ? GOLD : undefined }}
              >
                {payload.corrections.length === 0 ? (
                  <span className="tq-muted">
                    {tt(
                      'لم يُصحَّح شيء في هذا التقرير.',
                      'Nothing was corrected in this digest.',
                    )}
                  </span>
                ) : (
                  <Space direction="vertical" size={20} style={{ width: '100%' }}>
                    {payload.corrections.map((correction: StrategistCorrection, index: number) => (
                      <div
                        key={`correction-${index}`}
                        style={{ borderInlineStart: `3px solid ${GOLD}`, paddingInlineStart: 12 }}
                      >
                        <div className="tq-muted" style={{ fontSize: 12 }}>
                          {tt('قيل سابقاً', 'What was said')}
                        </div>
                        <ArabicText style={{ fontSize: 14 }}>
                          {textOrDash(correction.what_was_said_ar)}
                        </ArabicText>

                        <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
                          {tt('والصواب', 'What is true')}
                        </div>
                        <ArabicText style={{ fontSize: 15, fontWeight: 600 }}>
                          {textOrDash(correction.what_is_true_ar)}
                        </ArabicText>

                        {correction.decision_id === null ? null : (
                          <div style={{ fontSize: 12, marginBlockStart: 6 }}>
                            <span className="tq-muted">{tt('القرار المُصحَّح: ', 'Decision corrected: ')}</span>
                            <code dir="ltr">{correction.decision_id}</code>
                          </div>
                        )}

                        <BasisList basis={correction.basis} />
                      </div>
                    ))}
                  </Space>
                )}
              </Card>

              {/* ------------------------------------------------------ deltas -- */}
              <Card size="small" title={tt('ما تحرّك', 'What moved')}>
                {payload.deltas.length === 0 ? (
                  <span className="tq-muted">{emptyCopy}</span>
                ) : (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    {payload.deltas.map((delta: StrategistDelta, index: number) => (
                      <DeltaRow key={`delta-${index}`} delta={delta} />
                    ))}
                  </Space>
                )}
              </Card>

              {/* -------------------------------------------- wins & concerns -- */}
              <Card size="small" title={tt('ما نجح', 'Wins')}>
                {payload.wins.length === 0 ? (
                  <span className="tq-muted">{emptyCopy}</span>
                ) : (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    {payload.wins.map((win: StrategistFinding, index: number) => (
                      <Statement
                        key={`win-${index}`}
                        text={win.statement_ar}
                        basis={win.basis}
                        grounding={win.grounding}
                        accent="#389e0d"
                      />
                    ))}
                  </Space>
                )}
              </Card>

              <Card size="small" title={tt('ما يقلق', 'Concerns')}>
                {payload.concerns.length === 0 ? (
                  <span className="tq-muted">{emptyCopy}</span>
                ) : (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    {payload.concerns.map((concern: StrategistFinding, index: number) => (
                      <Statement
                        key={`concern-${index}`}
                        text={concern.statement_ar}
                        basis={concern.basis}
                        grounding={concern.grounding}
                        accent="#d4380d"
                      />
                    ))}
                  </Space>
                )}
              </Card>

              {/* --------------------------------------- decisions this digest -- */}
              <Card
                size="small"
                title={tt('قرارات هذا التقرير', 'Decisions this digest made')}
                extra={
                  <span className="tq-muted" style={{ fontSize: 12 }}>
                    {tt(
                      'تُكتب في السجل المفتوح أدناه، ويُحكم عليها في تاريخها.',
                      'These are written onto the open ledger below, and judged on their date.',
                    )}
                  </span>
                }
              >
                {payload.decisions.length === 0 ? (
                  <span className="tq-muted">{emptyCopy}</span>
                ) : (
                  <Space direction="vertical" size={20} style={{ width: '100%' }}>
                    {payload.decisions.map((decision: StoredDecision, index: number) => (
                      <ProposedDecisionRow
                        key={`proposed-${index}`}
                        decision={decision}
                        index={index}
                      />
                    ))}
                  </Space>
                )}
              </Card>

              {/* ----------------------------------------- verdicts on the past -- */}
              {ledgerReview.length > 0 ? (
                <Card size="small" title={tt('أحكام على قرارات سابقة', 'Verdicts on past decisions')}>
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    {ledgerReview.map((review: StoredLedgerReview, index: number) => (
                      <div
                        key={`review-${index}`}
                        style={{
                          borderInlineStart: '3px solid var(--tq-line)',
                          paddingInlineStart: 12,
                        }}
                      >
                        <Space wrap size={8} align="center">
                          <Tag style={{ marginInlineEnd: 0 }}>
                            {review.verdict === 'validated'
                              ? tt('تأكّد', 'Validated')
                              : review.verdict === 'refuted'
                                ? tt('نُقض', 'Refuted')
                                : review.verdict === 'superseded'
                                  ? tt('حلّ محلّه غيره', 'Superseded')
                                  : tt('مُدِّد', 'Extended')}
                          </Tag>
                          <code dir="ltr" style={{ fontSize: 11 }}>
                            {review.decision_id}
                          </code>
                          {review.new_review_after === null ? null : (
                            <span className="tq-muted" style={{ fontSize: 12 }}>
                              {tt('موعد جديد: ', 'New date: ')}
                              <span className="tq-num">
                                {formatDate(review.new_review_after, locale)}
                              </span>
                            </span>
                          )}
                        </Space>
                        <ArabicText style={{ marginBlockStart: 4 }}>
                          {textOrDash(review.outcome_note_ar)}
                        </ArabicText>
                        <BasisList basis={review.basis} />
                      </div>
                    ))}
                  </Space>
                </Card>
              ) : null}

              {/* ----------------------------------------------------- actions -- */}
              <Card
                size="small"
                title={tt('إجراءات مطلوبة من إنسان', 'Actions requested of a human')}
                extra={
                  <span className="tq-muted" style={{ fontSize: 12 }}>
                    {tt('طلبات — لا ينفّذها هذا التطبيق.', 'Requests — this app executes none of them.')}
                  </span>
                }
              >
                {otherActions.length === 0 ? (
                  <span className="tq-muted">
                    {humanFlags.length > 0
                      ? tt(
                          'كل ما طُلب هو تصعيد، وهو معروض في أعلى الصفحة.',
                          'Everything requested was an escalation, and it is shown at the top of the page.',
                        )
                      : emptyCopy}
                  </span>
                ) : (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    {otherActions.map((action, index) => (
                      <div
                        key={`action-${index}`}
                        style={{
                          borderInlineStart: '3px solid var(--tq-line)',
                          paddingInlineStart: 12,
                        }}
                      >
                        <Space wrap size={8} align="center">
                          <Tag style={{ marginInlineEnd: 0 }}>
                            {action.type === 'generate_concepts'
                              ? tt('توليد أفكار', 'Generate concepts')
                              : tt('حساب مطلوب', 'Computation requested')}
                          </Tag>
                          <span className="tq-muted" style={{ fontSize: 12 }}>
                            {action.owner === 'operator' ? tt('المشغّل', 'Operator') : tt('العميل', 'Client')}
                          </span>
                          {action.by_date === null ? null : (
                            <span className="tq-muted" style={{ fontSize: 12 }}>
                              {tt('بحلول ', 'by ')}
                              <span className="tq-num">{formatDate(action.by_date, locale)}</span>
                            </span>
                          )}
                          {action.decision_index === null ? null : (
                            <Tag style={{ marginInlineEnd: 0 }}>
                              {tt('قرار ', 'decision ')}#
                              <span className="tq-num">
                                {formatNumber(action.decision_index + 1)}
                              </span>
                            </Tag>
                          )}
                        </Space>

                        <ArabicText style={{ marginBlockStart: 4 }}>
                          {textOrDash(action.do_ar)}
                        </ArabicText>

                        {action.type === 'generate_concepts' ? (
                          <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 4 }}>
                            {tt('الحساب: ', 'Account: ')}
                            {action.spec.account === 'personal'
                              ? t.common.personal
                              : t.common.academy}
                            {' · '}
                            {tt('المحور: ', 'Pillar: ')}
                            <span dir="auto">{textOrDash(action.spec.pillar)}</span>
                            {' · '}
                            {tt('الموضوع: ', 'Theme: ')}
                            <span dir="auto">{textOrDash(action.spec.theme)}</span>
                            {' · '}
                            {tt('العدد: ', 'Count: ')}
                            <span className="tq-num">{formatNumber(action.spec.count)}</span>
                          </div>
                        ) : (
                          <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 4 }}>
                            <div>
                              {tt('المطلوب حسابه: ', 'To be computed: ')}
                              <span dir="auto">{textOrDash(action.spec.question_en)}</span>
                            </div>
                            <div>
                              {tt('وسيتيح: ', 'Which would unlock: ')}
                              <span dir="auto">{textOrDash(action.spec.would_unlock_ar)}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </Space>
                )}
              </Card>

              {/* ---------------------------------------- operator notes (rest) -- */}
              {/* When needs_human is set these already appear inside the escalation
                  at the top; repeating them there and here would train a reader to
                  skim both. */}
              {!payload.needs_human && payload.operator_notes.length > 0 ? (
                <Card
                  size="small"
                  title={tt('ملاحظات المشغّل', 'Operator notes')}
                  extra={
                    <span className="tq-muted" style={{ fontSize: 12 }}>
                      {tt('لا تُرسل للعميل أبداً.', 'Never sent to the client.')}
                    </span>
                  }
                >
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {payload.operator_notes.map((note: string, index: number) => (
                      <li key={`op-note-${index}`} dir="auto" className="tq-ar">
                        {note}
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}

              {/* ------------------------------------------------ client draft -- */}
              <Card
                size="small"
                title={tt('مسودة رسالة العميل', 'The client draft')}
                extra={
                  <Button
                    size="small"
                    onClick={() => void handleCopy(digest.client_digest_ar)}
                    disabled={digest.client_digest_ar.trim().length === 0}
                  >
                    {t.common.copy}
                  </Button>
                }
              >
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  {/* Shaped like the message it becomes: one bubble, its own line
                      breaks preserved, measured narrow so it reads the way it will
                      read on a phone. `dir="auto"` because it is Arabic that may
                      carry a Latin handle or link inside it. */}
                  <div
                    dir="auto"
                    className="tq-ar"
                    style={{
                      maxInlineSize: 520,
                      whiteSpace: 'pre-wrap',
                      background: '#FFFFFF',
                      border: '1px solid var(--tq-line)',
                      borderRadius: 14,
                      paddingInline: 16,
                      paddingBlock: 12,
                      fontSize: 14,
                    }}
                  >
                    {textOrDash(digest.client_digest_ar)}
                  </div>

                  <Alert
                    type="info"
                    showIcon
                    message={tt('مسودة — لم تُرسل', 'A draft — not sent')}
                    description={tt(
                      'لا يرسل هذا التطبيق هذه الرسالة ولا أي رسالة أخرى، ولا يضع عليها علامة «أُرسلت». انسخها وأرسلها بنفسك من حسابك، ثم سجّل ذلك يدوياً إن أردت.',
                      'This app does not send this message or any other, and it never marks it as sent. Copy it and send it yourself, from your own account; recording that afterwards is a human act performed outside this product.',
                    )}
                  />

                  <span className="tq-muted" style={{ fontSize: 12 }}>
                    {tt('حالة «أُرسل» المُخزَّنة: ', 'The stored “sent” flag reads: ')}
                    <strong>{digest.sent ? tt('نعم', 'Yes') : tt('لا', 'No')}</strong>
                    {tt(
                      ' — لا يوجد في هذا التطبيق أي مسار يكتب هذه القيمة، ولا زر يغيّرها.',
                      ' — there is no path in this app that writes that value, and no control here that changes it.',
                    )}
                  </span>
                </Space>
              </Card>
            </>
          ) : null}

          {/* ----------------------------------------------------- the ledger -- */}
          <Card
            size="small"
            title={tt('السجل المفتوح', 'The open ledger')}
            extra={
              <span className="tq-muted" style={{ fontSize: 12 }}>
                {tt(
                  'القرارات المفتوحة فقط — القرار الذي لم يقرأ أحد نتيجته يبقى مفتوحاً وظاهراً.',
                  'Open decisions only — a decision nobody read the outcome of stays open and stays visible.',
                )}
              </span>
            }
          >
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
                <Descriptions.Item label={tt('قرارات مفتوحة', 'Open decisions')}>
                  <span className="tq-num">{formatNumber(decisions.length)}</span>
                </Descriptions.Item>
                <Descriptions.Item label={tt('حان موعد مراجعتها', 'Due for review')}>
                  <span className="tq-num">{formatNumber(dueCount)}</span>
                </Descriptions.Item>
                <Descriptions.Item label={tt('محسوبة مقابل تاريخ', 'Computed against')}>
                  <span className="tq-num">{formatDate(today, locale)}</span>
                </Descriptions.Item>
              </Descriptions>

              {truncated ? (
                <Alert
                  type="warning"
                  showIcon
                  message={tt('قراءة السجل بلغت سقفها', 'The ledger read filled its cap')}
                  description={tt(
                    'ما يظهر هنا بداية السجل المفتوح وليس كلّه. ما لم تصل إليه القراءة لا يمكن عدّه من نتيجتها، فلا يُذكر له رقم.',
                    'What is shown here is the beginning of the open ledger, not all of it. What a capped read never reached cannot be counted from its result, so no figure is given for it.',
                  )}
                />
              ) : null}

              {decisions.length === 0 ? (
                <span className="tq-muted">
                  {tt(
                    'لا قرار مفتوح. لم يُسجَّل بعد أي قرار يُنتظر الحكم عليه.',
                    'No open decision. Nothing has been written down that is waiting to be judged.',
                  )}
                </span>
              ) : (
                <Space direction="vertical" size={20} style={{ width: '100%' }}>
                  {decisions.map((decision) => (
                    <LedgerDecisionRow key={decision.id} decision={decision} />
                  ))}
                </Space>
              )}
            </Space>
          </Card>
        </Space>
      ) : null}
    </div>
  );
}
