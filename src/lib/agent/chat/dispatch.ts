import { MissingEnvError, positiveIntEnv, type EnvKey } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { featureIds, getFeature } from '@/lib/agent/features/registry';
import type { FeatureRunOutcome } from '@/lib/agent/features/types';
import { rateFor, unpricedReason } from '@/lib/agent/rates';
import {
  CapUnavailableError,
  ammanDayStart,
  ammanIsoDate,
  ammanNextDayStart,
  readCapState,
} from '@/lib/mcp/tools';
import type { Quality } from '@/lib/prefs';
import type { Grounding, ChatToolCallRecord } from '@/lib/types/db';
import type { ChatToolResult, ChatToolSpec, ToolParameterSchema } from './run';

/**
 * ===========================================================================
 * THE DISPATCHER — HARD RULE 17, AND THE CAP THAT MAKES RULE 18 REAL
 * ===========================================================================
 *
 * RULE 17: DELIVERABLES ARE NOT WRITTEN IN CHAT.
 *
 * A concept, a campaign, a report, a guideline or a storyboard is produced by
 * the feature that already owns it — with that feature's Law → Judge → one
 * retry gate intact (defineFeature, src/lib/agent/features/types.ts) — and comes
 * back here as a CARD. Chat prose deliberately skips the Judge (see the header
 * of ./run.ts); that is only safe because a deliverable never travels through
 * chat prose in the first place. This module is the boundary that makes that
 * true, and it makes it true STRUCTURALLY rather than by instruction:
 *
 *   `dispatchResult()` returns a `ChatToolResult` whose `content` is a fixed
 *   set of scalars — feature id, artefact ids, counts, verdict flags — and
 *   whose `card` is built from `FeatureRunOutcome.persisted` only. NOTHING
 *   reads `outcome.result`. The deliverable's own words are not in scope in
 *   this file, so the model that reads the tool result cannot be handed them to
 *   paraphrase, and a future edit that wants to leak them has to add a field on
 *   purpose rather than forget a rule.
 *
 * RULE 18: NO NEW SPEND PATHS, AND A CAP THAT ACTUALLY BOUNDS SPEND.
 *
 * Nothing here scrapes, mirrors or touches Apify: this module imports no module
 * under src/lib/ingest/, and the only thing it can run is a registry feature
 * chosen from a closed tuple. What it CAN do is spend on a model, so it is
 * capped — and the cap is the one from
 * supabase/migrations/0005_mcp_reservations.sql, reused rather than reinvented:
 *
 *   * THE ATOM IS THE SAME. `mcp_reserve_units` — one UPDATE that tests the
 *     limit and moves the counter under the lock of the row it is testing. This
 *     module issues that RPC and nothing else; there is no read-then-act pair
 *     anywhere in this file, because a read followed by an act is not a gate.
 *   * THE COUNTER IS THE SAME ROW. `mcp_cap_days.reserved_units` for the Amman
 *     day. Chat dispatches and MCP calls come out of ONE pool, which is correct:
 *     they are the same money on the same provider key. What differs is the
 *     CEILING each caller is tested against — `p_limit` is a parameter of the
 *     atom, so CHAT_DAILY_GENERATION_CAP binds chat and MCP_DAILY_GENERATION_CAP
 *     binds an external token, over one shared ledger. Whichever is tighter
 *     refuses its own caller first, and neither can hand out units the other has
 *     already taken.
 *   * THE WINDOW IS THE SAME. `ammanDayStart` / `ammanIsoDate` are IMPORTED from
 *     src/lib/mcp/tools.ts, not restated here. A third definition of "today"
 *     that disagreed at a midnight boundary would split the shared row — which
 *     is precisely the failure 0005's `p_day` parameter exists to prevent.
 *   * UNITS ARE TAKEN BEFORE THE FIRST CALL THAT CAN BILL. `runDispatch()`
 *     reserves, then runs the feature. Not the other way round, and not
 *     "reserve then check": spend precedes the artefact, so a cap that counts
 *     artefacts cannot bound it.
 *
 * -- WHAT IS DUPLICATED, AND WHY IT IS THE TS AND NOT THE ATOM ---------------
 * `reserveUnits()` and `settleReservation()` below are a second TypeScript
 * wrapper over the SAME two RPCs; the originals are module-private in
 * src/lib/mcp/tools.ts and that file is outside this task's scope. The thing
 * that must not be duplicated — the check-and-increment statement — is not
 * duplicated: both wrappers call the one function in the database. The durable
 * fix is to lift the reservation client into src/lib/cap/reservations.ts and
 * have both callers import it; that is a change to a file this task does not
 * own, and it is reported rather than made.
 *
 * -- ONE BLOCKING PREREQUISITE, STATED HERE SO IT CANNOT BE MISSED ----------
 * `mcp_reservations.tool` carries a CHECK constraint that 0005 wrote as
 * `tool in ('check_compliance','generate_concepts')`, and 0005 says in terms
 * that "a future spending tool needs its own migration -- until then this
 * constraint refuses the reservation, which fails CLOSED." CHAT_RESERVING_TOOL
 * is exactly that future tool. Until a migration adds it to the constraint, the
 * insert inside `mcp_reserve_units` raises, the whole function rolls back —
 * including the increment to `mcp_cap_days`, so no units leak — the RPC returns
 * an error, and `reserveUnits()` turns that into `CapUnavailableError`, which
 * this module answers with a structured refusal and NO model call. Refusing
 * every dispatch is the wrong product behaviour and the right safety behaviour;
 * it is not a state to work around in code.
 * ===========================================================================
 */

/* ============================================================ what may run == */

/**
 * The features chat may dispatch. A CLOSED TUPLE, not a lookup into the
 * registry: the model supplies this string, and a caller-supplied string that
 * indexes a registry is one refactor away from being a target parameter. Rule 14
 * and rule 19 are the same instinct — a caller picks a verb, it does not name a
 * thing to run.
 *
 * TWO REGISTERED FEATURES ARE DELIBERATELY ABSENT, and the reasons are
 * different:
 *
 *   `strategist` — its data is what the chat's own context blocks are rendered
 *   from (see ./run.ts). Dispatching it would pay a model to re-derive what the
 *   model has already been shown.
 *
 *   `gaps` — its `persist()` writes no row and returns three counts. A card is a
 *   REFERENCE, and rule 17 forbids the chat from carrying the content instead,
 *   so a dispatched gap analysis would leave the operator holding nothing: no
 *   artefact to open and no text they are allowed to be given. A feature has to
 *   persist something to be dispatchable, and this list is where that is
 *   enforced.
 *
 * Membership in the registry is asserted in tests/chat-cap.test.ts, so a feature
 * renamed in registry.ts breaks a test rather than becoming a silent 404 at the
 * moment an operator asks for it.
 */
export const CHAT_DISPATCHABLE = [
  'concepts',
  'campaign',
  'report',
  'guideline',
  'storyboard',
  'audience',
] as const;

export type DispatchableFeature = (typeof CHAT_DISPATCHABLE)[number];

export function isDispatchable(value: string): value is DispatchableFeature {
  return (CHAT_DISPATCHABLE as readonly string[]).includes(value);
}

/** The name the model calls. One tool, one verb, no target parameter. */
export const CHAT_DISPATCH_TOOL = 'dispatch_feature';

/* ================================================================= the cap == */

export const CHAT_CAP_ENV_KEY: EnvKey = 'CHAT_DAILY_GENERATION_CAP';

/**
 * The built-in ceiling when CHAT_DAILY_GENERATION_CAP is unset.
 *
 * A POLICY CHOICE, NOT A MEASUREMENT — stated that way so it is never mistaken
 * for a sourced constant. Twelve model-backed generations is a working session
 * for the operator and small enough that a runaway loop costs a rounding error.
 * It sits deliberately above MCP's default of ten: this surface is the
 * operator's own, behind `requireOperator()`, while that one is a bearer token
 * that could leak. Operators who want a different number set the env var.
 */
export const DEFAULT_CHAT_DAILY_GENERATION_CAP = 12;

export function chatDailyGenerationCap(): number {
  return positiveIntEnv(CHAT_CAP_ENV_KEY, DEFAULT_CHAT_DAILY_GENERATION_CAP);
}

const AMMAN_TIME_ZONE = 'Asia/Amman';

const CHAT_CAP_UNIT = 'model-backed generations per Asia/Amman day';

/**
 * The chat's view of the shared day window.
 *
 * `used` is the DURABLE floor — finished work recorded in the tables
 * `readCapState()` counts — and it is deliberately the same measure MCP uses, so
 * the operator's own browser generations squeeze chat out of the same ceiling.
 *
 * THE HONEST LIMITATION, stated rather than buried: those tables are `concepts`
 * and `compliance_checks`, so a dispatched campaign or report leaves no row the
 * durable count can see. That does NOT leave the window unbounded — every
 * dispatch takes units from `mcp_cap_days.reserved_units`, which is what the
 * atom actually tests against — it only means the durable floor understates
 * finished work for features with no counted table. The fix is an origin column
 * and a wider count, which is a migration this task does not own.
 */
export interface ChatCapState {
  limit: number;
  unit: string;
  used: number;
  remaining: number;
  time_zone: string;
  /** ISO instant of the Amman midnight this window opened at. */
  window_start: string;
  /** ISO instant of the next Amman midnight — when the window rolls over. */
  resets_at: string;
  /** The Amman calendar date the window resets into. */
  resets_on: string;
  /** The Amman calendar day the reserved units come out of. */
  amman_day: string;
  env_key: EnvKey;
  /** Per-table durable counts, so `used` can be checked rather than believed. */
  counted: Record<string, number>;
  /** Hard rule 12 — every quantity above names what produced it. */
  source_keys: Record<string, string>;
}

/**
 * The chat's cap, built on MCP's counting and MCP's window but with CHAT's
 * ceiling.
 *
 * `readCapState()` is reused for the count and the window instants; its `limit`,
 * `remaining` and limit-related source keys are MCP's and are deliberately NOT
 * carried through — a refusal that named the wrong ceiling would be a wrong
 * number on an operator's screen, which is the one thing this app does not do.
 */
export async function readChatCapState(now: Date = new Date()): Promise<ChatCapState> {
  const shared = await readCapState(now);
  const limit = chatDailyGenerationCap();
  // ONE instant, measured once: `resets_at` and `resets_on` must be the same
  // boundary, not two boundaries computed either side of a midnight.
  const resetsAt = ammanNextDayStart(now);

  return {
    limit,
    unit: CHAT_CAP_UNIT,
    used: shared.used,
    remaining: Math.max(0, limit - shared.used),
    time_zone: AMMAN_TIME_ZONE,
    window_start: ammanDayStart(now).toISOString(),
    resets_at: resetsAt.toISOString(),
    resets_on: ammanIsoDate(resetsAt),
    amman_day: ammanIsoDate(now),
    env_key: CHAT_CAP_ENV_KEY,
    counted: shared.counted,
    source_keys: {
      'chat_cap.limit': `env:${CHAT_CAP_ENV_KEY} (default ${DEFAULT_CHAT_DAILY_GENERATION_CAP} when unset)`,
      'chat_cap.used': shared.source_keys['cap.used'] ?? 'durable rows created since the window opened',
      'chat_cap.window_start': `midnight ${AMMAN_TIME_ZONE} on the day of the request`,
      'chat_cap.resets_at': `the next midnight ${AMMAN_TIME_ZONE}`,
      'chat_cap.reserved': 'mcp_cap_days.reserved_units for chat_cap.amman_day',
    },
  };
}

/* ==================================================== the reservation client */

/**
 * The tool name this surface reserves under.
 *
 * A DIFFERENT NAME against the SAME atom — 0005's intended extension point — so
 * the operator reading `mcp_reservations` can see where the day went rather than
 * only that it is gone. Reusing 'generate_concepts' for a dispatched campaign
 * would put a false row in that ledger, which is the same sin as a false number
 * on a screen.
 *
 * See the header: until a migration adds this name to the CHECK constraint on
 * `mcp_reservations.tool`, every reservation is refused and every dispatch fails
 * closed.
 */
export const CHAT_RESERVING_TOOL = 'chat_dispatch';

export interface ChatReservation {
  id: string;
  tool: string;
  units: number;
  amman_day: string;
  /** Units held for that day AFTER this grant. */
  reserved_after: number;
}

export interface ChatReservationRefused {
  amman_day: string;
  /** Units already held for that day, including requests still running. */
  reserved_now: number;
}

export type ChatReservationAttempt =
  | { granted: true; reservation: ChatReservation }
  | { granted: false; refusal: ChatReservationRefused };

/**
 * How a reservation ended. 0005's vocabulary, unchanged:
 *   spent    — a billed request provably went out.
 *   unproven — it failed and nothing proves it billed nothing.
 *   released — it failed before anything could bill.
 * Only `released` returns units.
 */
export type ChatReservationOutcome = 'spent' | 'unproven' | 'released';

export interface ChatSettlement {
  reservation_id: string;
  units: number;
  outcome: ChatReservationOutcome;
  reason: string;
  /** What the database recorded. 'already_settled' when it had settled before. */
  recorded: string;
  units_released: number;
  /** Non-null when settling itself failed. The units then stay consumed. */
  error: string | null;
}

/** 0005 returns exactly one row from mcp_reserve_units, granted or not. */
function readGrantRow(data: unknown): {
  granted: boolean;
  reservation_id: string | null;
  units_reserved_today: number;
} {
  if (!Array.isArray(data) || data.length !== 1) {
    throw new CapUnavailableError(
      `mcp_reserve_units returned ${Array.isArray(data) ? data.length : 0} rows where exactly ` +
        'one is expected, so the reservation is treated as not taken.',
    );
  }
  const row: unknown = data[0];
  if (typeof row !== 'object' || row === null) {
    throw new CapUnavailableError('mcp_reserve_units returned a row that is not an object.');
  }
  const record = row as Record<string, unknown>;
  const granted = record.granted;
  const id = record.reservation_id;
  const held = record.units_reserved_today;

  if (typeof granted !== 'boolean' || !(typeof held === 'number' && Number.isInteger(held))) {
    throw new CapUnavailableError(
      'mcp_reserve_units returned a row missing `granted` or `units_reserved_today`.',
    );
  }
  return {
    granted,
    reservation_id: typeof id === 'string' && id.length > 0 ? id : null,
    units_reserved_today: held,
  };
}

/**
 * Take `units`, atomically, or come back refused.
 *
 * The Amman day is the APP'S, not the database's: 0005 declares `p_day` as a
 * required parameter and never calls now(). One round trip, and the database
 * decides — there is no total read into this process and written back.
 */
async function reserveUnits(args: {
  units: number;
  cap: ChatCapState;
  now: Date;
}): Promise<ChatReservationAttempt> {
  const day = ammanIsoDate(args.now);

  const { data, error } = await supabaseAdmin().rpc('mcp_reserve_units', {
    p_day: day,
    p_tool: CHAT_RESERVING_TOOL,
    p_units: args.units,
    p_limit: args.cap.limit,
    p_durable_used: args.cap.used,
  });

  // FAIL CLOSED: a reservation that could not be taken is not a reservation
  // that succeeded. This is also the branch the missing CHECK-constraint
  // migration lands in — see the header.
  if (error) {
    throw new CapUnavailableError(
      `Reserving ${args.units} unit(s) for ${CHAT_RESERVING_TOOL} failed: ${error.message}`,
    );
  }

  const row = readGrantRow(data ?? []);
  if (!row.granted || row.reservation_id === null) {
    return {
      granted: false,
      refusal: { amman_day: day, reserved_now: row.units_reserved_today },
    };
  }

  return {
    granted: true,
    reservation: {
      id: row.reservation_id,
      tool: CHAT_RESERVING_TOOL,
      units: args.units,
      amman_day: day,
      reserved_after: row.units_reserved_today,
    },
  };
}

/**
 * Reconcile one reservation. NEVER THROWS.
 *
 * By the time this runs the paid work has already happened and the operator must
 * still get an answer, so a failure here is reported rather than raised. A
 * settlement that did not land leaves the row `reserved` and the units consumed
 * — the direction that costs a request rather than money.
 */
async function settleReservation(
  reservation: ChatReservation,
  outcome: ChatReservationOutcome,
  reason: string,
): Promise<ChatSettlement> {
  const base = {
    reservation_id: reservation.id,
    units: reservation.units,
    outcome,
    reason,
  };

  try {
    const { data, error } = await supabaseAdmin().rpc('mcp_settle_reservation', {
      p_reservation: reservation.id,
      p_status: outcome,
      p_note: reason,
    });
    if (error) throw new Error(error.message);

    const row: unknown = Array.isArray(data) && data.length > 0 ? data[0] : null;
    const record =
      typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null;
    const recorded = record !== null && typeof record.settled_status === 'string'
      ? record.settled_status
      : 'no_row_returned';
    const released =
      record !== null && typeof record.units_released === 'number' ? record.units_released : 0;

    return { ...base, recorded, units_released: released, error: null };
  } catch (err) {
    return {
      ...base,
      recorded: 'not_settled',
      units_released: 0,
      error: err instanceof Error ? err.message : 'The settlement failed.',
    };
  }
}

/**
 * THE RELEASE RULE, in one place.
 *
 * Units go back ONLY when the failure provably never left this process.
 * `MissingEnvError` is that proof and, in this dispatcher, the only one:
 * `requireEnv` throws before any request is built, and nothing in `runDispatch`
 * can bill before `deps.runFeature()` — there is no Canon retrieval, no
 * embedding and no second provider on this path, so there is no earlier step to
 * weigh (contrast `SpendLedger` in src/lib/mcp/tools.ts, where check_compliance
 * embeds first).
 *
 * EVERYTHING ELSE IS `unproven`, INCLUDING FAILURES THAT PROBABLY COST NOTHING.
 * `defineFeature.run()` parses its input and may run a `preflight` before it
 * calls a model, so an HttpError from it can mean "refused before spending" —
 * but this dispatcher cannot see which, and 'spent' would be a claim about a
 * request nobody observed. 0005 has a status for exactly this and it is
 * `unproven`; both it and 'spent' leave the window consumed, so the cap behaves
 * identically and only the operator's ledger reads honestly. The cost is that a
 * malformed dispatch input burns a unit. Over-counting costs the caller a
 * request; under-counting costs the operator money.
 */
export function provablyUnspent(err: unknown): boolean {
  return err instanceof MissingEnvError;
}

/* ================================================================== inputs == */

interface DispatchRequest {
  feature: DispatchableFeature;
  input: Record<string, unknown>;
}

/**
 * What the model asked for, or a stated reason it could not be read.
 *
 * `arguments` is the RAW STRING the model emitted (see `ChatToolCallRecord`),
 * so unparseable JSON is a case rather than a crash.
 */
function readRequest(raw: string): { ok: true; request: DispatchRequest } | { ok: false; why: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, why: 'The arguments were not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, why: 'The arguments must be a JSON object.' };
  }

  const record = parsed as Record<string, unknown>;
  const feature = record.feature;
  if (typeof feature !== 'string' || !isDispatchable(feature)) {
    return {
      ok: false,
      why:
        `"${typeof feature === 'string' ? feature : String(feature)}" is not a feature this chat ` +
        `can dispatch. Choose one of: ${CHAT_DISPATCHABLE.join(', ')}.`,
    };
  }

  const input = record.input;
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    return { ok: false, why: '"input" must be a JSON object when it is present.' };
  }

  return {
    ok: true,
    request: { feature, input: (input as Record<string, unknown> | undefined) ?? {} },
  };
}

/**
 * How many cap units this dispatch takes.
 *
 * ONE per dispatch, except where the input carries a positive integer `count` —
 * then it is that count, which is what `generate_concepts` already charges for a
 * batch (src/lib/mcp/tools.ts). Two paths that produce the same eight concepts
 * must not disagree about what eight concepts cost.
 *
 * Deliberately NOT clamped. A `count` larger than the day's ceiling is refused
 * by the cap check below, before the RPC — fail closed rather than quietly
 * charge for fewer than were asked for.
 */
export function unitsFor(input: Record<string, unknown>): number {
  const count = input.count;
  return typeof count === 'number' && Number.isInteger(count) && count > 0 ? count : 1;
}

/* ================================================================== output == */

/**
 * A CARD IS A REFERENCE. Every field below is a scalar, an id or a verdict; none
 * of them can carry the deliverable's prose. `outcome.result` is never read in
 * this file — the artefact lives in the feature's own table, behind the gate
 * that produced it.
 */
export interface DispatchCard extends Record<string, unknown> {
  kind: 'dispatch';
  feature: DispatchableFeature;
  label: string;
  /** Where the operator opens it. A path, never the artefact. */
  href: string;
  /** Row ids the feature persisted, when its shape is one this reads. */
  ids: string[];
  /** How the ids were found, so an empty list is readable. */
  persisted_shape: PersistedShape;
  /** True when the feature's own Judge failed it or could not rule. */
  needs_human: boolean;
  /** Null when the feature is not brain-gated — never `true` for "no gate ran". */
  law_passed: boolean | null;
  attempts: number;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  /** Null = unpriced (hard rule 15). Never 0-for-unknown. */
  est_usd: number | null;
  unpriced_reason: string | null;
  cap_units: number;
  reservation: Record<string, unknown>;
}

/** Six decimals, not cents: one dispatch can honestly cost less than a cent. */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function priceOf(
  model: string,
  usage: { input_tokens: number; output_tokens: number },
): { est_usd: number | null; unpriced_reason: string | null } {
  const rate = rateFor(model);
  if (rate === null) return { est_usd: null, unpriced_reason: unpricedReason(model) };
  return {
    est_usd: roundUsd(
      (usage.input_tokens * rate.in) / 1_000_000 + (usage.output_tokens * rate.out) / 1_000_000,
    ),
    unpriced_reason: null,
  };
}

/**
 * How the ids on a card were found.
 *
 *   rows   — the persisted value was itself an array of rows carrying ids.
 *   row    — it was one row carrying an id.
 *   nested — one or more of its properties held a row, or an array of rows.
 *   none   — nothing in it carried a string id.
 *
 * `none` is a FACT ABOUT THE READ, not about the database: `gaps` persists
 * counts and no rows, so `none` there is correct and complete. It never means
 * "no rows were written" — it means this dispatcher could not name any.
 */
export type PersistedShape = 'rows' | 'row' | 'nested' | 'none';

function idOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Ids of an array of rows, or null when `value` is not such an array. */
function idsOfRows(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const entry of value) {
    const id = idOf(entry);
    if (id === null) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * The ids a feature persisted.
 *
 * ONE LEVEL OF SCAN, because that is exactly how deep the features put them:
 * `{ inserted: ConceptRow[] }`, `{ campaign: CampaignRow }`,
 * `{ report: ReportRow }`, `{ guideline: … }`, `{ concept: ConceptRow, … }`,
 * `{ insight: … }`. A deeper walk would start finding `id` fields inside
 * payloads that are not rows, and a hardcoded per-feature map would drift
 * silently the first time a `persist()` is edited.
 *
 * It never invents an id and never counts one it did not see.
 */
export function readPersisted(persisted: unknown): { ids: string[]; shape: PersistedShape } {
  const asRows = idsOfRows(persisted);
  if (asRows !== null && asRows.length > 0) return { ids: asRows, shape: 'rows' };

  const asRow = idOf(persisted);
  if (asRow !== null) return { ids: [asRow], shape: 'row' };

  if (typeof persisted === 'object' && persisted !== null && !Array.isArray(persisted)) {
    const found: string[] = [];
    for (const value of Object.values(persisted as Record<string, unknown>)) {
      const nestedRows = idsOfRows(value);
      if (nestedRows !== null) {
        found.push(...nestedRows);
        continue;
      }
      const nestedRow = idOf(value);
      if (nestedRow !== null) found.push(nestedRow);
    }
    if (found.length > 0) return { ids: found, shape: 'nested' };
  }

  return { ids: [], shape: 'none' };
}

/**
 * Where an operator opens what was just made. Paths only; no artefact text.
 *
 * Every value is a screen that exists under src/app/(app)/. `storyboard` points
 * at /concepts because that is where its artefact lands — it persists a concept
 * row and its frames, not a screen of its own.
 */
const FEATURE_HREF: Record<DispatchableFeature, string> = {
  concepts: '/concepts',
  campaign: '/campaigns',
  report: '/reports',
  guideline: '/guideline',
  storyboard: '/concepts',
  audience: '/audience',
};

function reservationReport(
  reservation: ChatReservation,
  settlement: ChatSettlement | null,
): Record<string, unknown> {
  return {
    id: reservation.id,
    tool: reservation.tool,
    units: reservation.units,
    amman_day: reservation.amman_day,
    reserved_after: reservation.reserved_after,
    taken_before: 'the first call in this dispatch that could be billed',
    outcome: settlement === null ? 'reserved' : settlement.outcome,
    reason: settlement === null ? 'Still open.' : settlement.reason,
    recorded: settlement === null ? null : settlement.recorded,
    units_released: settlement === null ? 0 : settlement.units_released,
    settlement_error: settlement === null ? null : settlement.error,
  };
}

/* =============================================================== refusals == */

export const CHAT_CAP_REACHED = 'chat_daily_generation_cap_reached';
export const CHAT_CAP_UNKNOWN = 'chat_daily_generation_cap_unknown';
export const DISPATCH_INVALID = 'dispatch_invalid_arguments';
export const DISPATCH_FAILED = 'dispatch_failed';

/**
 * A refusal is a TOOL RESULT, not a thrown error.
 *
 * Two reasons, and both are rules. Rule 18 asks for a STRUCTURED refusal, so it
 * is JSON a caller can branch on rather than a sentence to regex. And ./run.ts
 * feeds every tool result into the lint context, so a refusal that names the cap
 * and the reset instant is a SOURCE for those values — the model may quote them
 * to the operator and the claims-linter will pass them. A refusal thrown as an
 * exception would reach the operator as prose the linter would then have to
 * strip numbers out of.
 */
function refusal(payload: Record<string, unknown>): ChatToolResult {
  return { content: JSON.stringify(payload, null, 2) };
}

function capRefusal(cap: ChatCapState, requested: number, reserved_now: number | null): ChatToolResult {
  return refusal({
    refusal: CHAT_CAP_REACHED,
    tool: CHAT_DISPATCH_TOOL,
    requested,
    cap,
    reserved_now,
    reason:
      `The daily cap of ${cap.limit} ${cap.unit} has no room for ${requested} more` +
      (reserved_now === null
        ? ` (${cap.used} used since ${cap.window_start}).`
        : `: ${reserved_now} unit(s) are already reserved for ${cap.amman_day} ` +
          `(${cap.time_zone}) by work that has run or is running.`),
    resets_at: cap.resets_at,
    what_you_can_do: [
      `Wait until ${cap.resets_at} (${cap.resets_on}, ${cap.time_zone}), when the window rolls over and the count returns to zero.`,
      `Ask the operator to raise ${cap.env_key}; it is a deployment variable, not a code change.`,
      'Answer from the blocks and the lookups in the meantime — neither calls a model, and neither is capped.',
    ],
    note:
      reserved_now === null
        ? 'Refused against the durable count, before any reservation was attempted.'
        : 'Refused by the atomic reservation, before any paid call. Units are taken in one ' +
          'check-and-increment statement under a row lock, so simultaneous requests cannot ' +
          'each pass the same check.',
    grounding: 'data' satisfies Grounding,
  });
}

/* ============================================================ the tool spec */

const DISPATCH_SCHEMA: ToolParameterSchema = {
  type: 'object',
  properties: {
    feature: {
      type: 'string',
      enum: [...CHAT_DISPATCHABLE],
      description:
        'Which studio feature produces this deliverable. There is no free-form target: only these names run.',
    },
    input: {
      type: 'object',
      description:
        "The feature's own input object, e.g. { count, theme, account } for concepts. Omit it to take the feature's defaults. It is validated by the feature, not here.",
    },
  },
  required: ['feature'],
  additionalProperties: false,
};

const DISPATCH_DESCRIPTION = `Hand a deliverable to the studio feature that owns it, and get back a card.

Use this whenever the operator asks for concepts, a campaign, a report, a brand
guideline, a storyboard, a gap analysis or an audience read. The feature runs
with its own review gate — Law, then Judge, then one retry — and writes the
result to its own table. You get a REFERENCE: ids, counts and verdict flags.

WHAT YOU MUST NOT DO WITH IT
- Do not write the deliverable yourself, before or after calling this. A concept
  or a caption composed in the message has passed no review; that is the whole
  reason this tool exists.
- Do not restate or reconstruct what the card contains. You did not receive it:
  this tool returns no deliverable text at all, by construction.
- You may add ONE line of framing around the card. That is the budget.

PARAMETERS
- feature (required). One of the listed names. Nothing else runs.
- input (optional object). The feature's own arguments, e.g. { "count": 3,
  "account": "academy" } for concepts. Omitted fields take the feature's
  defaults. Invalid input is refused BY THE FEATURE, after a cap unit has been
  taken — so pass what the operator actually asked for rather than guessing.

COST
Each dispatch reserves cap units BEFORE any paid work: one unit, or "count"
units when the input names a count. The units come out of the same Asia/Amman
day window the rest of the studio spends against.

REFUSAL SHAPES — always a JSON object with a "refusal" key, never prose:
- "dispatch_invalid_arguments" — unknown feature or unreadable arguments.
  Nothing ran and no unit was taken.
- "chat_daily_generation_cap_reached" — the day has no room. The payload names
  the limit, what has been used, the env var that moves it, and the exact
  instant it resets. Tell the operator those figures; they are sourced by this
  result. Do not retry before the reset; retrying cannot succeed.
- "chat_daily_generation_cap_unknown" — the cap could not be counted or the
  units could not be reserved, so nothing model-backed was attempted.
- "dispatch_failed" — the feature itself failed. The payload says whether the
  reserved units were returned.

SIDE EFFECTS
Reserves cap units, then creates rows in the feature's own table as drafts for a
human. It reads no Instagram data, triggers no scrape and spends nothing on
Apify — no scraping code is reachable from here.`;

export function dispatchToolSpec(): ChatToolSpec {
  return {
    name: CHAT_DISPATCH_TOOL,
    description: DISPATCH_DESCRIPTION,
    parameters: DISPATCH_SCHEMA,
  };
}

/* ==================================================================== deps == */

/**
 * The impure edges, injectable.
 *
 * WHAT INJECTION DOES NOT MOVE: the ORDER. `runDispatch` reserves and then runs,
 * and no dependency can reorder that — a fake can only observe it. That is what
 * lets tests/chat-cap.test.ts prove "the reservation came first" from an
 * execution log rather than from a reading of this source, and it is the only
 * way any of this runs in a repository with no model key.
 */
export interface DispatchDeps {
  readCap(now: Date): Promise<ChatCapState>;
  reserve(args: { units: number; cap: ChatCapState; now: Date }): Promise<ChatReservationAttempt>;
  settle(
    reservation: ChatReservation,
    outcome: ChatReservationOutcome,
    reason: string,
  ): Promise<ChatSettlement>;
  runFeature(feature: DispatchableFeature, input: unknown, quality: Quality): Promise<FeatureRunOutcome>;
}

export function defaultDispatchDeps(): DispatchDeps {
  return {
    readCap: (now) => readChatCapState(now),
    reserve: (args) => reserveUnits(args),
    settle: (reservation, outcome, reason) => settleReservation(reservation, outcome, reason),
    runFeature: async (feature, input, quality) => {
      const runnable = getFeature(feature);
      if (!runnable) {
        // Unreachable while CHAT_DISPATCHABLE is a subset of the registry, which
        // tests/chat-cap.test.ts asserts. Stated rather than assumed because the
        // units are already held by the time this could fire.
        throw new Error(
          `The registry has no feature "${feature}". Registered: ${featureIds().join(', ')}.`,
        );
      }
      return runnable.run(input, quality);
    },
  };
}

/* ===================================================================== run == */

export interface RunDispatchArgs {
  call: ChatToolCallRecord;
  quality: Quality;
  /** ONE instant for the whole dispatch: the window counted and the day the
   *  units come out of must be the same day. */
  now?: Date;
  deps?: DispatchDeps;
}

/**
 * One dispatch, from the model's tool call to a card reference.
 *
 * NEVER writes deliverable text into its result, and never spends before it has
 * reserved. Both are properties of this function body, in this order:
 *
 *   read arguments → read cap → reserve → run feature → settle → card
 *
 * A refusal at any step is returned as a structured `ChatToolResult`, not
 * thrown: ./run.ts feeds tool results into the lint context, so a refusal that
 * names a number is a source for that number and the model may relay it.
 */
export async function runDispatch(args: RunDispatchArgs): Promise<ChatToolResult> {
  const deps = args.deps ?? defaultDispatchDeps();
  const now = args.now ?? new Date();

  const read = readRequest(args.call.arguments);
  if (!read.ok) {
    // Refused before the cap is even read: nothing ran, so nothing is charged.
    return refusal({
      refusal: DISPATCH_INVALID,
      tool: CHAT_DISPATCH_TOOL,
      reason: read.why,
      dispatchable: [...CHAT_DISPATCHABLE],
      note: 'Nothing was generated and no cap unit was taken.',
      grounding: 'data' satisfies Grounding,
    });
  }

  const { feature, input } = read.request;
  const units = unitsFor(input);

  let cap: ChatCapState;
  try {
    cap = await deps.readCap(now);
  } catch (err) {
    if (err instanceof CapUnavailableError) {
      return refusal({
        refusal: CHAT_CAP_UNKNOWN,
        tool: CHAT_DISPATCH_TOOL,
        reason: err.message,
        detail: err.detail,
        note: 'An uncounted window is treated as unknown, never as zero, so nothing was generated.',
        grounding: 'data' satisfies Grounding,
      });
    }
    throw err;
  }

  // A cheap early refusal against the durable count, checked against what this
  // dispatch would ADD rather than merely against whether any room is left.
  //
  // IT IS NOT THE GATE. It is a read, and a read cannot bound spend — N
  // concurrent isolates each pass it. The gate is the reservation below.
  if (cap.used + units > cap.limit) {
    return capRefusal(cap, units, null);
  }

  /* -- THE RESERVATION. Before `deps.runFeature`, which is this dispatch's
   * first call that can bill. One statement decides; simultaneous requests
   * contend on one row and at most `limit` units are ever handed out. ------ */
  let attempt: ChatReservationAttempt;
  try {
    attempt = await deps.reserve({ units, cap, now });
  } catch (err) {
    if (err instanceof CapUnavailableError) {
      return refusal({
        refusal: CHAT_CAP_UNKNOWN,
        tool: CHAT_DISPATCH_TOOL,
        reason: err.message,
        detail: err.detail,
        note:
          'The units could not be reserved, so nothing model-backed was attempted. A reservation ' +
          'that could not be taken is never treated as one that succeeded.',
        grounding: 'data' satisfies Grounding,
      });
    }
    throw err;
  }

  if (!attempt.granted) {
    return capRefusal(cap, units, attempt.refusal.reserved_now);
  }

  const reservation = attempt.reservation;

  /* -- THE PAID CALL ------------------------------------------------------- */
  let outcome: FeatureRunOutcome;
  try {
    outcome = await deps.runFeature(feature, input, args.quality);
  } catch (err) {
    const unspent = provablyUnspent(err);
    const reason = err instanceof Error ? err.message : 'The feature failed.';
    const settlement = await deps.settle(
      reservation,
      unspent ? 'released' : 'unproven',
      unspent
        ? `Nothing was billed: the call was refused inside this process before any request was built, and no earlier step in this dispatch could have billed. (${reason})`
        : `The dispatch failed and nothing proves it billed nothing, so the units stay consumed. (${reason})`,
    );

    return refusal({
      refusal: DISPATCH_FAILED,
      tool: CHAT_DISPATCH_TOOL,
      feature,
      reason,
      units_returned: settlement.units_released,
      note: unspent
        ? 'Nothing left this process, so nothing was spent and the reserved units were returned to the window.'
        : 'It cannot be proven that nothing was billed, so the reserved units stay consumed rather than be refunded on a claim nothing supports.',
      reservation: reservationReport(reservation, settlement),
      cap,
      grounding: 'data' satisfies Grounding,
    });
  }

  // The feature answered: the money is gone. Settled before the card is built,
  // so the accounting is right even if anything below were to fail.
  const settlement = await deps.settle(
    reservation,
    'spent',
    `${feature} ran to completion, so a billed model call went out.`,
  );

  const persisted = readPersisted(outcome.persisted);
  const price = priceOf(outcome.model, outcome.usage);

  const card: DispatchCard = {
    kind: 'dispatch',
    feature,
    label: feature,
    href: FEATURE_HREF[feature],
    ids: persisted.ids,
    persisted_shape: persisted.shape,
    needs_human: outcome.brain?.needsHuman ?? false,
    // Null, not `true`: a feature with no brain config ran no Law here, and
    // reporting "passed" for a gate that never ran would be a fabricated verdict.
    law_passed: outcome.brain ? outcome.brain.law.passed : null,
    attempts: outcome.attempts,
    model: outcome.model,
    usage: outcome.usage,
    est_usd: price.est_usd,
    unpriced_reason: price.unpriced_reason,
    cap_units: units,
    reservation: reservationReport(reservation, settlement),
  };

  /**
   * WHAT THE MODEL IS TOLD. Scalars and ids — every number here is sourced by
   * this very result, so the model may quote them and the claims-linter will
   * pass them. There is no deliverable text to leak because none was read.
   */
  const content = [
    `DISPATCHED: ${feature} → card`,
    `artefacts_created: ${persisted.ids.length}`,
    persisted.ids.length > 0 ? `ids: ${persisted.ids.join(', ')}` : 'ids: (the feature reported none)',
    `needs_human: ${card.needs_human}`,
    `cap_units_used: ${units}`,
    `open_it_at: ${card.href}`,
    '',
    'The deliverable itself is NOT in this result and was never read by the chat.',
    'It was produced and reviewed by the feature that owns it and is on the card.',
    'Add at most one line of framing. Do not restate, summarise or reconstruct its contents.',
  ].join('\n');

  return {
    content,
    source_keys: [`dispatch.${feature}`],
    card,
  };
}

/**
 * The `ToolExecutor` branch for this one tool, ready to hand to `runAgentChat`.
 *
 * Exported so the route composes rather than re-implements: a second call site
 * that forgot to pass `quality`, or that called `deps.runFeature` directly, would
 * be a second spend path — which is exactly what rule 18 forbids.
 */
export function dispatchExecutor(quality: Quality, deps?: DispatchDeps) {
  return (call: ChatToolCallRecord): Promise<ChatToolResult> =>
    runDispatch({ call, quality, deps });
}
