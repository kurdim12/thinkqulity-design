/* ============================================================================
 * Pillar C — the MCP server's whole surface: auth, the tool allow-list, the
 * daily spend cap and its atomic reservation, and the JSON-RPC dispatcher.
 *
 * The route module (src/app/api/mcp/route.ts) is a four-line adapter over
 * `handleMcpRequest`. Everything that decides anything lives here, so it can be
 * executed by `node --test` without a Next.js runtime — the auth path in
 * particular is the kind of code that must be provable, not merely reviewable.
 *
 * ---------------------------------------------------------------------------
 * HOW HARD RULE 14 IS ENFORCED STRUCTURALLY
 *
 * Rule 14: external callers cannot spend freely; no MCP tool may trigger a
 * scrape or any Apify spend. This is not left to "no tool calls it". Three
 * mechanisms, in increasing order of strength:
 *
 *   1. THE REGISTRY IS A CLOSED ALLOW-LIST, NOT A LOOKUP. `MCP_TOOL_NAMES` is a
 *      four-member readonly tuple, `McpToolName` is its element union, and
 *      `TOOLS` is typed `Record<McpToolName, McpTool>`. That record is total
 *      (a missing name is a compile error) and closed (a name outside the
 *      tuple has no key to reach). Dispatch passes a caller-supplied string
 *      through `isToolName`, which tests membership of the TUPLE — not of the
 *      record — before anything indexes the record, so `__proto__`,
 *      `constructor` and every other inherited key resolve to nothing. There is
 *      no dynamic import, no name-to-path mapping, and no module specifier or
 *      request URL built from anything a caller sent. (The only URLs in this
 *      file are inside prose a human reads — openrouter.ai in a "how to fix
 *      it" hint — and nothing fetches them.)
 *
 *   2. THE IMPORT GRAPH DOES NOT CONTAIN THE SPEND. Nothing under
 *      `src/lib/ingest/` — the Apify client, the budget guard, the mirror — is
 *      imported by this module, or by anything this module imports,
 *      transitively. That is an executable claim, not a comment:
 *      tests/mcp.test.ts walks the real import graph from this file and fails
 *      if any module under `src/lib/ingest/` becomes reachable. A future edit
 *      that adds a scrape three imports away breaks the test, not just taste.
 *
 *   3. NO TOOL TAKES A TARGET. No input schema in this file has a url, path,
 *      endpoint, handle, actor or feature parameter. A caller cannot name a
 *      thing to call; it can only pick one of four verbs and fill in scalars
 *      that are range-checked here.
 *
 * What is NOT claimed: that the four tools are free. Two of them call a model,
 * and that is what the daily cap below exists to bound.
 * ========================================================================== */

import { z } from 'zod';
import { MissingEnvError, optionalEnv, positiveIntEnv, type EnvKey } from '@/lib/env';
import { HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { agentContextEvidence, loadAgentContext, renderContextBlocks } from '@/lib/agent/context';
import { runLaw, type LawReport, type LawResult } from '@/lib/brain/law';
import { retrieveCanon, type CanonHit } from '@/lib/brain/canon/retrieve';
import { reconcile, runJudge, type JudgeVerdict } from '@/lib/brain/judge';
import { conceptsFeature } from '@/lib/agent/features/concepts';
import { accountSchema, conceptsResponseSchema } from '@/lib/agent/schemas';
import type { Quality } from '@/lib/prefs';
import type { BrandRow, DigestRow, Grounding } from '@/lib/types/db';

/* ============================================================ server identity */

export const MCP_SERVER_NAME = 'thinkquality-studio';

/** Mirrors package.json "version". See the note at its use site in `initialize`. */
export const MCP_SERVER_VERSION = '1.0.0';

/**
 * Protocol versions this server can speak, newest first. `initialize`
 * negotiates: if the client names one of these we answer with it, otherwise we
 * answer with the newest we support and let the client decide whether to
 * proceed. Echoing an unknown version back would be a lie about capability.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;

/**
 * The model tier external callers get. FIXED, and not a parameter: choosing the
 * expensive tier is a spend decision, and rule 14 says an external caller does
 * not get to make one. The operator's own quality switch (a cookie read by
 * `readQuality()`) is deliberately not consulted either — an MCP request
 * carries no operator session, so borrowing one would attribute a stranger's
 * spend to whoever last used the browser.
 */
const MCP_QUALITY: Quality = 'standard';

/* ==================================================================== auth ==
 *
 * The token never appears in a log line, an error message, a thrown Error, or a
 * response body — not in full, not truncated, not hashed. The only facts this
 * module will state about it are "configured" and "not configured".
 * ========================================================================== */

const encoder = new TextEncoder();

/**
 * Byte-for-byte equality in time that does not depend on WHERE the first
 * difference is.
 *
 * WHY NOT `===`. String comparison in V8 returns at the first differing byte.
 * That turns a secret into a search: an attacker who can time responses tries
 * every first byte, keeps the one that took measurably longer, moves to the
 * second, and recovers an n-byte token in ~256n requests instead of 256^n. The
 * effect is small per request and entirely recoverable by averaging over many
 * — which is exactly what an attacker with a network and patience has.
 *
 * WHY THE LENGTH CHECK IS FIRST, AND WHY THAT IS NOT THE SAME LEAK. Comparing
 * lengths does reveal whether a guess is the right LENGTH. That is a far
 * cheaper fact than the bytes, and it is one the attacker can obtain anyway
 * from any correctly-sized comparison; more importantly, a fixed-length loop
 * over mismatched buffers would either read out of bounds or silently compare
 * only a prefix, and a prefix comparison is a real vulnerability rather than a
 * theoretical one. So: length decides fast, and then EVERY byte is examined
 * with no early exit, accumulating differences into one integer.
 *
 * The loop cannot be short-circuited by the engine — `diff` depends on every
 * iteration and is only inspected after the loop ends.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

export type AuthFailure = 'not_configured' | 'missing' | 'invalid';

export interface AuthResult {
  ok: boolean;
  /** Null when ok. Never contains any part of either token. */
  failure: AuthFailure | null;
  message: string | null;
}

const AUTH_OK: AuthResult = { ok: true, failure: null, message: null };

/**
 * `Authorization: Bearer <MCP_ACCESS_TOKEN>`, or nothing.
 *
 * An unset MCP_ACCESS_TOKEN is a CLOSED door: every call is refused, including
 * a call that presents an empty bearer token. There is no development bypass,
 * no default token and no "allow when unconfigured" branch — the failure mode
 * of a missing secret must be that the feature is off, never that the feature
 * is open.
 */
export function authorize(request: Request): AuthResult {
  const expected = optionalEnv('MCP_ACCESS_TOKEN');
  if (expected === null) {
    return {
      ok: false,
      failure: 'not_configured',
      message:
        'This deployment has no MCP access token bound, so the MCP endpoint accepts nothing. ' +
        'An operator sets it with: wrangler secret put MCP_ACCESS_TOKEN',
    };
  }

  const header = request.headers.get('authorization');
  if (header === null) {
    return { ok: false, failure: 'missing', message: 'Missing Authorization header.' };
  }

  // Split rather than slice-and-trim so that "Bearer" with no token, or a
  // different scheme, is rejected as malformed instead of compared as a token.
  const match = /^Bearer[ ]+(.+)$/.exec(header);
  if (!match) {
    return {
      ok: false,
      failure: 'missing',
      message: 'Authorization header must be of the form: Bearer <token>',
    };
  }

  const presented = match[1];
  if (!constantTimeEquals(presented, expected)) {
    return { ok: false, failure: 'invalid', message: 'Invalid MCP access token.' };
  }

  return AUTH_OK;
}

/* ============================================================ the Amman day ==
 *
 * The cap resets at midnight in Amman, because that is the day the studio and
 * the client both live in. Jordan's civil time is what defines the window, not
 * UTC and not the caller's clock.
 * ========================================================================== */

const AMMAN_TIME_ZONE = 'Asia/Amman';

/**
 * RESTATED CONSTANT, NAMED AS SUCH: src/lib/agent/features/strategist.ts holds
 * its own `AMMAN_TIME_ZONE` and its own `todayInAmman()`. Importing that module
 * for one string would pull the entire strategist — its blocks, its ledger
 * reads and its prompt — into the MCP graph for no benefit. The duplication is
 * a deliberate trade and the durable fix is a shared `src/lib/date.ts` export.
 */
const AMMAN_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: AMMAN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  // h23, not hour12:false — the latter renders midnight as "24" in some locale
  // data, which would put the window boundary a day out.
  hourCycle: 'h23',
});

interface ZonedClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function ammanClock(at: Date): ZonedClock {
  const parts = AMMAN_CLOCK.formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value;
    const parsed = value === undefined ? Number.NaN : Number(value);
    if (!Number.isFinite(parsed)) {
      // Unreachable with a working Intl. Throwing beats guessing: a window
      // boundary that is quietly an hour or a day out is exactly the class of
      // wrong number this app refuses to produce.
      throw new Error(`Could not read the ${type} of the current time in ${AMMAN_TIME_ZONE}.`);
    }
    return parsed;
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * The zone's UTC offset at `at`, in milliseconds, derived rather than assumed.
 *
 * Jordan has observed permanent UTC+3 since 2022, but nothing here hardcodes
 * that: the offset is measured by formatting the instant in Amman and reading
 * the gap back. A tzdata change, or a deployment to a runtime with different
 * zone data, moves this number rather than silently invalidating the window.
 */
function ammanOffsetMs(at: Date): number {
  const c = ammanClock(at);
  const asIfUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  // The formatter has no milliseconds, so the instant is floored to the second
  // on both sides of the subtraction.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which the Amman day containing `at` began. */
export function ammanDayStart(at: Date): Date {
  const c = ammanClock(at);
  return new Date(Date.UTC(c.year, c.month - 1, c.day) - ammanOffsetMs(at));
}

/**
 * The instant at which the Amman day containing `at` ends — i.e. when the cap
 * resets.
 *
 * Computed in two passes on purpose. The first pass uses today's offset, which
 * is wrong by exactly the offset change if one falls on that boundary; the
 * second re-measures the offset AT the candidate instant and re-derives it, so
 * the answer is the true local midnight either way. `Date.UTC` handles the
 * month and year rollover, so no calendar arithmetic is written by hand.
 */
export function ammanNextDayStart(at: Date): Date {
  const c = ammanClock(at);
  const midnight = Date.UTC(c.year, c.month - 1, c.day + 1);
  const firstPass = midnight - ammanOffsetMs(at);
  return new Date(midnight - ammanOffsetMs(new Date(firstPass)));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` for the Amman day containing `at`. Latin digits, always. */
export function ammanIsoDate(at: Date): string {
  const c = ammanClock(at);
  return `${c.year}-${pad2(c.month)}-${pad2(c.day)}`;
}

/* ============================================================== the day cap ==
 *
 * Hard rule 14: external callers cannot spend freely.
 * ========================================================================== */

/**
 * The built-in ceiling when MCP_DAILY_GENERATION_CAP is unset.
 *
 * THIS IS A POLICY CHOICE, NOT A MEASUREMENT, and it is stated that way so it
 * is never mistaken for a sourced constant of the kind rule 15 governs. Ten
 * model-backed generations is enough for an external assistant to be useful in
 * a working session and small enough that a leaked token costs a rounding
 * error rather than a bill. Operators who want a different number set the env
 * var; nobody has to edit code to tighten it.
 */
export const DEFAULT_DAILY_GENERATION_CAP = 10;

const CAP_ENV_KEY: EnvKey = 'MCP_DAILY_GENERATION_CAP';

export function dailyGenerationCap(): number {
  return positiveIntEnv(CAP_ENV_KEY, DEFAULT_DAILY_GENERATION_CAP);
}

/**
 * The two tables a model-backed MCP call leaves a durable row in.
 *
 * WHAT THIS COUNT IS, AND WHAT IT IS NOT. It is the durable record of FINISHED
 * work in the window, and it is the floor the reservation gate is measured
 * against. It is NOT, on its own, the thing that bounds spend — it cannot be,
 * because the artefact is written after the money is gone. The bound is the
 * atomic reservation further down this file; this count keeps the operator's
 * own browser work squeezing external callers out of the same ceiling.
 *
 * WHY DURABLE ROWS AND NOT A COUNTER. On Cloudflare Workers there is no process
 * to hold a counter in: every request may land on a fresh isolate, so an
 * in-memory tally resets to zero at an interval nobody controls and the cap
 * becomes decoration. Rows in Postgres survive the isolate, the deployment and
 * the region.
 *
 * WHY THESE TWO. They are the rows the two model-backed tools actually create:
 * `generate_concepts` inserts into `concepts`, and `check_compliance` records
 * its ruling in `compliance_checks` — the same ledger /api/compliance writes
 * to. Counting the artefact rather than the intent means a call that spent
 * money is counted even if this process died before it could report back.
 *
 * THE HONEST LIMITATION. Neither table records WHO created a row, so the count
 * includes the operator's own work in the browser. The cap therefore
 * OVER-counts, which for a spend guard is the safe direction to be wrong: it
 * can only refuse earlier, never allow more. The durable fix is an origin
 * column, which is a migration this task is scoped out of adding.
 */
const CAP_SOURCE_TABLES = ['concepts', 'compliance_checks'] as const;

const CAP_UNIT =
  'model-backed generations per Asia/Amman day, counted as rows created in ' +
  CAP_SOURCE_TABLES.join(' + ');

export interface CapState {
  limit: number;
  unit: string;
  used: number;
  remaining: number;
  time_zone: string;
  /** ISO instant of the Amman midnight the window opened at. */
  window_start: string;
  /** ISO instant of the next Amman midnight — when `used` returns to 0. */
  resets_at: string;
  /** The Amman calendar date the window resets into. */
  resets_on: string;
  env_key: EnvKey;
  /** Per-table counts, so `used` can be checked rather than believed. */
  counted: Record<string, number>;
  /**
   * Hard rule 12 — every quantity above names the computation that produced
   * it, so a caller can inspect the key rather than trust the number.
   */
  source_keys: Record<string, string>;
}

/**
 * The cap could not be counted, so no model call may be made.
 *
 * A separate class because the FAIL-CLOSED behaviour is the whole point: if the
 * count comes back null or the read errors, the answer is "unknown", and an
 * unknown usage must never be read as zero usage. Treating a failed count as
 * "0 used" would turn a database hiccup into an open spending door.
 */
export class CapUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super('The daily generation cap could not be counted, so nothing was generated.');
    this.name = 'CapUnavailableError';
    this.detail = detail;
  }
}

async function countSince(table: string, windowStartIso: string): Promise<number> {
  const { count, error } = await supabaseAdmin()
    .from(table)
    .select('id', { count: 'exact', head: true })
    .gte('created_at', windowStartIso);

  if (error) throw new CapUnavailableError(`Counting ${table} failed: ${error.message}`);
  if (count === null || !Number.isFinite(count)) {
    throw new CapUnavailableError(
      `Counting ${table} returned no count. An uncounted window is treated as unknown, never as zero.`,
    );
  }
  return count;
}

export async function readCapState(now: Date = new Date()): Promise<CapState> {
  const limit = dailyGenerationCap();
  const windowStart = ammanDayStart(now);
  const resetsAt = ammanNextDayStart(now);
  const windowStartIso = windowStart.toISOString();

  const counts = await Promise.all(CAP_SOURCE_TABLES.map((t) => countSince(t, windowStartIso)));

  const counted: Record<string, number> = {};
  CAP_SOURCE_TABLES.forEach((table, i) => {
    counted[table] = counts[i];
  });

  const used = counts.reduce((sum, n) => sum + n, 0);

  return {
    limit,
    unit: CAP_UNIT,
    used,
    // Never negative: a window that already exceeded the cap (because the
    // operator generated in the browser) reports 0 remaining, not -4.
    remaining: Math.max(0, limit - used),
    time_zone: AMMAN_TIME_ZONE,
    window_start: windowStartIso,
    resets_at: resetsAt.toISOString(),
    resets_on: ammanIsoDate(resetsAt),
    env_key: CAP_ENV_KEY,
    counted,
    source_keys: {
      'cap.limit': `env:${CAP_ENV_KEY} (default ${DEFAULT_DAILY_GENERATION_CAP} when unset)`,
      'cap.used': CAP_SOURCE_TABLES.map(
        (t) => `count(${t}.created_at >= cap.window_start)`,
      ).join(' + '),
      'cap.window_start': `midnight ${AMMAN_TIME_ZONE} on the day of the request`,
      'cap.resets_at': `the next midnight ${AMMAN_TIME_ZONE}`,
    },
  };
}

export const CAP_REACHED = 'daily_generation_cap_reached';
export const CAP_UNKNOWN = 'daily_generation_cap_unknown';

/**
 * The over-cap answer. A SHAPED RESPONSE, not an error string: it names the
 * cap, what has been used, which env var moves it, the exact instant it
 * resets, and what the caller can do instead — so a caller can branch on
 * `refusal` and act, rather than regex a sentence.
 */
function capRefusal(cap: CapState, requested: number | null): Record<string, unknown> {
  return {
    refusal: CAP_REACHED,
    requested,
    cap,
    reason:
      `The daily cap of ${cap.limit} ${cap.unit} has been reached ` +
      `(${cap.used} used since ${cap.window_start}).`,
    what_you_can_do: [
      `Wait until ${cap.resets_at} (${cap.resets_on}, ${cap.time_zone}), when the window rolls over and the count returns to zero.`,
      `Ask the operator to raise ${cap.env_key}; it is a deployment variable, not a code change.`,
      'Use get_brand_facts and get_latest_digest in the meantime — neither calls a model, and neither is capped.',
    ],
    // Every figure above was counted or read from configuration; none was
    // asserted by a model.
    grounding: 'data' satisfies Grounding,
  };
}

function capUnknownRefusal(err: CapUnavailableError): Record<string, unknown> {
  return {
    refusal: CAP_UNKNOWN,
    reason: err.message,
    detail: err.detail,
    what_you_can_do: [
      'Retry once — this is usually a transient database read.',
      'If it persists, the operator should check the Supabase service-role binding.',
    ],
    note: 'An uncounted window is treated as unknown, never as zero, so nothing was generated.',
    grounding: 'data' satisfies Grounding,
  };
}

/* ======================================================== model unavailable ==
 *
 * A model that cannot be reached is a fact to report, not a reason to invent a
 * verdict. Same distinction /api/compliance draws: "no ruling" is neither a
 * pass nor a fail.
 * ========================================================================== */

interface ModelFailure {
  reason: string;
  hint: string | null;
  /**
   * Whether THIS ONE CALL could have cost anything. `false` means this call was
   * refused inside the process before its request was built.
   *
   * ITS SCOPE, WHICH IS FINDING 1. This is a fact about one call and about
   * nothing else in the request. It is NOT a claim that the request billed
   * nothing: by the time the Judge fails, check_compliance has already
   * retrieved Canon, and Canon retrieval embeds the query — a billed request
   * on a DIFFERENT provider key when EMBEDDING_PROVIDER=openai. Reading this
   * `false` as "the whole request was free" is precisely what let a paid
   * embedding escape the cap and repeat without limit.
   *
   * Whether a request may RELEASE its reserved units is therefore not decided
   * here. It is decided by `reconcileSpend()`, which reads this flag AND the
   * `SpendLedger` of every step that ran before the failure.
   */
  spent: boolean;
}

function describeModelFailure(err: unknown): ModelFailure {
  if (err instanceof MissingEnvError) {
    return {
      reason: `No model provider key is configured (${err.key}).`,
      hint:
        'An operator sets OPENROUTER_API_KEY (openrouter.ai/keys), or ANTHROPIC_API_KEY with ' +
        'AI_PROVIDER=anthropic. Until then every model-backed answer here is deterministic-only.',
      // requireEnv throws before any network call, so nothing was spent.
      spent: false,
    };
  }
  if (err instanceof HttpError) {
    return { reason: err.message, hint: err.hint ?? null, spent: true };
  }
  return {
    reason: err instanceof Error ? err.message : 'The model call failed.',
    hint: null,
    // Unknown failures are assumed to have cost something. Conservative in the
    // direction that protects the budget.
    spent: true,
  };
}

/* ================================================= the atomic reservation ====
 *
 * WHY A COUNTING CAP COULD NOT BOUND SPEND, twice over.
 *
 *   1. SPEND PRECEDES THE ARTEFACT. check_compliance called retrieveCanon()
 *      BEFORE it wrote the row that counted. retrieveCanon -> embed() ->
 *      openaiEmbed() is a fetch to a paid embeddings endpoint on a DIFFERENT
 *      key from the one the Judge uses. With no Judge key configured the Judge
 *      threw locally, `ruling.spent` was false, no row was written, and the
 *      count never moved — while the embedding had already been paid for. The
 *      same hole is open with a working Judge key: anything that fails between
 *      the embedding and the insert spends without counting.
 *
 *   2. READ-THEN-ACT IS NOT ATOMIC. `if (cap.used + count > cap.limit)` reads,
 *      then the feature acts. On a runtime whose model is concurrent isolates,
 *      N simultaneous requests each observe the same `used`, each pass, and
 *      each spend. A leaked token was bounded by socket speed, not by the cap.
 *
 * The fix is not a better count. It is to stop paying for work before the
 * accounting for it exists: RESERVE the units atomically BEFORE the first call
 * that can bill, do the work, then reconcile.
 *
 * WHAT COUNTS AS ATOMIC HERE. One statement that both tests the limit and moves
 * the counter, under the lock of the row it is testing — see
 * supabase/migrations/0005_mcp_reservations.sql, which quotes the statement and
 * argues why the locking is sound rather than advisory. Nothing in this file
 * reads a total and then writes it back; there is one round trip, and the
 * database decides.
 * ========================================================================== */

/**
 * The tools that can spend, and therefore must reserve.
 *
 * Mirrors the CHECK constraint on `mcp_reservations.tool`. A name the two
 * disagree on is rejected by the database, so a future spending tool that
 * forgets its migration is refused rather than let through — fail-closed, the
 * same way an unset MCP_ACCESS_TOKEN is. get_brand_facts and get_latest_digest
 * are absent because they call no model and take no units.
 */
export const RESERVING_TOOLS = ['check_compliance', 'generate_concepts'] as const;

export type ReservingTool = (typeof RESERVING_TOOLS)[number];

/**
 * How a reservation ended.
 *
 *   spent    — a billed request provably went out.
 *   unproven — the request failed and nothing PROVES it billed nothing.
 *   released — the request failed before anything could bill.
 *
 * Only `released` returns units. `unproven` exists because it is the honest
 * answer far more often than either of the others, and collapsing it into
 * `released` is exactly the conflation that produced finding 1.
 */
export type ReservationOutcome = 'spent' | 'unproven' | 'released';

/**
 * What may already have been billed inside THIS request.
 *
 * A step that may bill announces itself here BEFORE it runs — before, because a
 * fetch that throws halfway has still been sent, so announcing afterwards would
 * miss exactly the failures that matter. Units are released only when this
 * ledger is empty AND the failing call itself provably never left the process.
 */
class SpendLedger {
  private readonly entries: string[] = [];

  /** Call IMMEDIATELY BEFORE a step that may issue a billed request. */
  mayBill(step: string): void {
    this.entries.push(step);
  }

  /** Oldest first. Empty is a proof, not an assumption. */
  billableSteps(): string[] {
    return [...this.entries];
  }
}

interface Reconciliation {
  outcome: ReservationOutcome;
  /** Why, in words, recorded on the reservation row for the operator to read. */
  reason: string;
}

/**
 * THE RELEASE RULE, in one place so it cannot drift between tools.
 *
 * Release only when BOTH hold: no earlier step in this request announced that
 * it might bill, and the failure itself provably never left the process.
 * Anything else keeps the units. Over-counting costs the caller a request;
 * under-counting costs the operator money, so when in doubt the units stay.
 *
 * `failure === null` means the paid call completed, which is a spend.
 */
function reconcileSpend(ledger: SpendLedger, failure: ModelFailure | null): Reconciliation {
  if (failure === null) {
    return {
      outcome: 'spent',
      reason: 'The model call completed, so a billed request went out.',
    };
  }

  if (failure.spent) {
    return {
      outcome: 'spent',
      reason: `The call may have been billed before it failed: ${failure.reason}`,
    };
  }

  const earlier = ledger.billableSteps();
  if (earlier.length === 0) {
    return {
      outcome: 'released',
      reason:
        'Nothing was billed: the call was refused inside this process before any request ' +
        `was built, and no earlier step in this request could have billed. (${failure.reason})`,
    };
  }

  return {
    outcome: 'unproven',
    reason:
      `The failing call itself billed nothing (${failure.reason}), but ${earlier.length} ` +
      `earlier step(s) in this request could have: ${earlier.join('; ')}. The units stay ` +
      'consumed rather than be refunded on a claim nothing proves.',
  };
}

/* ------------------------------------------------------- the two RPC calls -- */

/** 0005 returns exactly one row from mcp_reserve_units, granted or not. */
const reservationGrantSchema = z.array(
  z.object({
    granted: z.boolean(),
    reservation_id: z.string().min(1).nullable(),
    units_reserved_today: z.number().int().nonnegative(),
  }),
);

const settlementSchema = z.array(
  z.object({
    settled_status: z.string().min(1),
    units_released: z.number().int().nonnegative(),
  }),
);

export interface Reservation {
  id: string;
  tool: ReservingTool;
  units: number;
  /** The Amman calendar day the units came out of. */
  amman_day: string;
  /** Units held for that day AFTER this grant. */
  reserved_after: number;
}

interface ReservationRefused {
  amman_day: string;
  /** Units already held for that day — the number `cap` cannot report, because
   *  `cap` counts finished work and these requests may still be running. */
  reserved_now: number;
}

type ReservationAttempt =
  | { granted: true; reservation: Reservation }
  | { granted: false; refusal: ReservationRefused };

/**
 * Take `units` for `tool`, atomically, or come back refused.
 *
 * The Amman day is the APP'S, not the database's: 0005 declares `p_day` as a
 * required parameter and never calls now(), so the window the units come out of
 * is the same window `cap` was counted over. Two definitions of "today" that
 * disagree at a midnight boundary would be a cap that resets twice or not at
 * all.
 */
async function reserveUnits(args: {
  tool: ReservingTool;
  units: number;
  cap: CapState;
  now: Date;
}): Promise<ReservationAttempt> {
  const day = ammanIsoDate(args.now);

  const { data, error } = await supabaseAdmin().rpc('mcp_reserve_units', {
    p_day: day,
    p_tool: args.tool,
    p_units: args.units,
    p_limit: args.cap.limit,
    p_durable_used: args.cap.used,
  });

  // FAIL CLOSED, exactly as the count does: a reservation that could not be
  // taken is not a reservation that succeeded.
  if (error) {
    throw new CapUnavailableError(
      `Reserving ${args.units} unit(s) for ${args.tool} failed: ${error.message}`,
    );
  }

  const rows = reservationGrantSchema.parse(data ?? []);
  if (rows.length !== 1) {
    throw new CapUnavailableError(
      `mcp_reserve_units returned ${rows.length} rows where exactly one is expected, ` +
        'so the reservation is treated as not taken.',
    );
  }

  const row = rows[0];
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
      tool: args.tool,
      units: args.units,
      amman_day: day,
      reserved_after: row.units_reserved_today,
    },
  };
}

export interface Settlement {
  reservation_id: string;
  units: number;
  outcome: ReservationOutcome;
  reason: string;
  /** What the database recorded. 'already_settled' when it had settled before. */
  recorded: string;
  units_released: number;
  /** Non-null when settling itself failed. The units then stay consumed. */
  error: string | null;
}

/**
 * Reconcile one reservation. NEVER THROWS.
 *
 * By the time this runs the paid work has already happened and the caller must
 * still get its answer, so a failure here is reported in the payload rather
 * than raised. A settlement that did not land leaves the row `reserved` and the
 * units consumed — the direction that costs a request rather than money.
 */
async function settleReservation(
  reservation: Reservation,
  outcome: ReservationOutcome,
  reason: string,
): Promise<Settlement> {
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

    const rows = settlementSchema.parse(data ?? []);
    const row = rows.length > 0 ? rows[0] : null;
    return {
      ...base,
      recorded: row === null ? 'no_row_returned' : row.settled_status,
      units_released: row === null ? 0 : row.units_released,
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      recorded: 'not_settled',
      units_released: 0,
      error: err instanceof Error ? err.message : 'The settlement failed.',
    };
  }
}

/** The reservation as a caller sees it: what was taken, and what became of it. */
function reservationReport(
  reservation: Reservation,
  settlement: Settlement | null,
): Record<string, unknown> {
  return {
    id: reservation.id,
    tool: reservation.tool,
    units: reservation.units,
    amman_day: reservation.amman_day,
    reserved_after: reservation.reserved_after,
    taken_before: 'the first call in this request that could be billed',
    outcome: settlement === null ? 'reserved' : settlement.outcome,
    reason: settlement === null ? 'Still open.' : settlement.reason,
    recorded: settlement === null ? null : settlement.recorded,
    units_released: settlement === null ? 0 : settlement.units_released,
    settlement_error: settlement === null ? null : settlement.error,
  };
}

/**
 * The over-cap answer when the ATOMIC gate refused.
 *
 * Deliberately the same `refusal` code as the counted gate — it is the same
 * fact, and a caller should not have to learn a second string to handle it —
 * with `gate` naming which of the two said no and `reserved_now` naming how
 * much of the window is held by requests that have run or are still running.
 */
function reservationRefusal(
  cap: CapState,
  requested: number,
  refused: ReservationRefused,
): Record<string, unknown> {
  return {
    ...capRefusal(cap, requested),
    gate: 'reservation',
    reserved_now: refused.reserved_now,
    reason:
      `The daily cap of ${cap.limit} ${cap.unit} has no room for ${requested} more: ` +
      `${refused.reserved_now} unit(s) are already reserved for ${refused.amman_day} ` +
      `(${AMMAN_TIME_ZONE}) by requests that have run or are running.`,
    note:
      'Refused by the atomic reservation, before any paid call. Units are taken in one ' +
      'check-and-increment statement under a row lock, so simultaneous requests cannot ' +
      'each pass the same check.',
  };
}

/* ==================================================== shared brain plumbing ==*/

/**
 * TWO HALVES, AND ONLY ONE OF THEM IS EVIDENCE — the same split
 * `ChatToolResult` keeps in ../agent/chat/run.ts.
 *
 * `blocks` is what a MODEL reads: the Judge, and the rewrite prompt. It carries
 * the captions and the workshop corpus because a ruling about register cannot
 * be made without them.
 *
 * `evidence` is what the LAW may trace a number back to: the declared
 * quantities of those same blocks and nothing else. Handing `blocks` to
 * `runLaw` as `context` — which this file did until now — made every caption
 * excerpt, every model-written hook and every free-text brand fact a source for
 * a figure about the client's accounts, to an EXTERNAL caller who cannot see
 * the blocks and cannot check.
 */
interface BrainContext {
  blocks: string;
  evidence: string;
  swatches: Record<string, string> | null;
  voiceExamples: string[];
}

async function loadBrainContext(): Promise<BrainContext> {
  const ctx = await loadAgentContext();
  return {
    blocks: renderContextBlocks(ctx),
    evidence: agentContextEvidence(ctx),
    swatches: ctx.brand.palette?.swatches ?? null,
    voiceExamples: ctx.brand.voice_examples.map((v) => v.text),
  };
}

function lawSummary(report: LawReport): Record<string, unknown> {
  return {
    passed: report.passed,
    violation_count: report.violations.length,
    warning_count: report.warnings.length,
    results: report.results satisfies LawResult[],
  };
}

function canonSummary(hits: CanonHit[]): Record<string, unknown>[] {
  return hits.map((c) => ({
    chunk_id: c.chunkId,
    document_title: c.documentTitle,
    method: c.method,
    score: Number(c.score.toFixed(3)),
  }));
}

type JudgeStatus = 'ruled' | 'unavailable' | 'refused_daily_cap';

interface JudgeOutcome {
  status: JudgeStatus;
  verdict: JudgeVerdict | null;
  model: string | null;
  unavailable: ModelFailure | null;
  /**
   * True when the JUDGE call may actually have been billed. Scoped to the
   * Judge, like ModelFailure.spent — it says nothing about the Canon retrieval
   * that ran before it. See reconcileSpend().
   */
  spent: boolean;
}

async function judge(args: {
  candidate: string;
  law: LawReport;
  canon: CanonHit[];
  blocks: string;
  task: string;
}): Promise<JudgeOutcome> {
  try {
    const ruled = await runJudge({
      candidate: args.candidate,
      lawReport: args.law,
      canon: args.canon,
      brandBlocks: args.blocks,
      task: args.task,
    });
    return {
      status: 'ruled',
      // Law violations survive the Judge — reconcile re-fails anything the
      // model tried to wave through.
      verdict: reconcile(ruled.verdict, args.law),
      model: ruled.model,
      unavailable: null,
      spent: true,
    };
  } catch (err) {
    const failure = describeModelFailure(err);
    return {
      status: 'unavailable',
      verdict: null,
      model: null,
      unavailable: failure,
      spent: failure.spent,
    };
  }
}

/* =========================================================== tool contracts ==*/

/** MCP's `content` block. Text only — this server returns no binary. */
interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  structuredContent: Record<string, unknown>;
  /**
   * Reserved for protocol-level trouble. A refusal is NOT an error: an
   * over-cap answer is a correct, actionable response, and flagging it
   * `isError` would push callers into retry loops against a wall.
   */
  isError?: boolean;
}

/** Every tool answers in the same envelope: readable text, machine-readable twin. */
function result(payload: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

interface McpTool {
  name: string;
  title: string;
  description: string;
  /** JSON Schema, as `tools/list` must publish it. */
  inputSchema: Record<string, unknown>;
  /**
   * MCP behaviour hints. They are advisory to clients by spec, so nothing here
   * relies on them — they restate, for a reader, what the code enforces.
   */
  annotations: Record<string, unknown>;
  /** Zod is what actually guards the handler. The JSON Schema above is a copy
   *  for the client; this is the one that runs. */
  run(args: unknown): Promise<ToolResult>;
}

function invalidArgs(name: string, error: z.ZodError): ToolResult {
  return result(
    {
      refusal: 'invalid_arguments',
      tool: name,
      issues: error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
      })),
      note: 'Nothing was generated and nothing was counted against the daily cap.',
    },
    true,
  );
}

/* ------------------------------------------------------- 1. check_compliance */

const CHECK_SUBJECTS = ['concept', 'storyboard', 'caption', 'freeform'] as const;

const checkComplianceInput = z.object({
  text: z.string().trim().min(1).max(20000),
  subject: z.enum(CHECK_SUBJECTS).default('freeform'),
});

const CHECK_COMPLIANCE_DESCRIPTION = `Check a piece of text against Think Quality Academy's brand rules and return a verdict.

Runs two things over the text you paste, in this order:
  1. THE LAW — deterministic checks that call no model: hex colours written into
     copy, palette names the brand does not own, numbers that appear nowhere in
     the brand's data, and Arabic register scored against the client's real
     captions. The Law always runs, even with no model key configured, and its
     violations are final — the Judge cannot overrule one.
  2. THE JUDGE — a model reading the same evidence plus retrieved brand canon.
     It can only add violations, never remove a Law violation.

WHEN TO USE IT
- Before showing the client any Arabic caption, hook, storyboard or concept that
  was drafted outside this studio.
- To find out WHY something was rejected: every violation carries its evidence
  and its source ("law", "canon:<chunk_id>" or "brand:<field>").

WHEN NOT TO USE IT
- Do not use it to rewrite text. It judges; it does not edit. Nothing you pass
  is modified, and no corrected version is returned.
- Do not use it to check anything that is not client-facing brand copy — it
  scores Arabic register against this one client's captions, so a verdict on
  unrelated text is meaningless rather than merely unhelpful.
- Do not treat "passed": true as permission to publish. This studio never
  publishes; a human posts.

PARAMETERS
- text (string, required, 1–20000 characters after trimming). The exact text to
  judge. Send it verbatim, in whatever script it is written in; do not
  translate, tidy or summarise it first — the register check reads the real
  characters and a cleaned-up copy produces a verdict about the copy.
- subject (optional, one of: concept, storyboard, caption, freeform; default
  "freeform"). What kind of thing the text is. It sets the Judge's framing and
  is recorded on the stored check.

WHAT COMES BACK
{ "passed", "needs_human", "law": {...}, "judge": {...}, "canon": [...],
  "reservation": {...}, "cap": {...} }
"passed" is true only when the Judge ruled pass AND the Law found no violation.
"reservation" says how many cap units this call took, when they were taken, and
what became of them ("spent", "unproven" or "released").

COST — READ THIS BEFORE RETRYING
One cap unit is reserved BEFORE any paid work begins, because the brand-canon
lookup embeds your text and that embedding is billed on its own provider key.
The unit is therefore consumed even when the Judge cannot rule, and it is
returned only when the call can prove nothing was billed. A call that comes
back with judge.status "unavailable" HAS used a unit. Retrying it will use
another one and produce the same answer.

REFUSAL SHAPES — always a shaped object with a "refusal" key, never prose:
- "invalid_arguments" — text was empty or over length. Nothing ran.
- "daily_generation_cap_reached" — the Judge is a model call and the day's cap
  is spent. The LAW RESULTS ARE STILL RETURNED in full: judge.status is
  "refused_daily_cap" and the payload names the cap, what used it, and the
  exact instant it resets. "gate" says whether the day's finished work filled
  the cap or whether other in-flight requests hold the remaining units. Read
  the Law verdict; it is deterministic and complete on its own.
- "daily_generation_cap_unknown" — the cap could not be counted or the units
  could not be reserved, so nothing model-backed was attempted. Retry once.
If no model provider key is configured at all, this is not a refusal: you get
judge.status "unavailable" with the reason, alongside the full Law verdict —
and, per COST above, one unit consumed.

SIDE EFFECTS
Reserves one cap unit, then records the check in the studio's compliance ledger
when — and only when — the Judge actually ran. The reservation is what bounds
spend; the ledger row is the record of the ruling. It reads no Instagram data,
triggers no scrape, and changes no brand data.`;

const checkComplianceTool: McpTool = {
  name: 'check_compliance',
  title: 'Check text against the brand Law and Judge',
  description: CHECK_COMPLIANCE_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        minLength: 1,
        maxLength: 20000,
        description:
          'The exact text to judge, verbatim and untranslated. 1–20000 characters after trimming.',
      },
      subject: {
        type: 'string',
        enum: [...CHECK_SUBJECTS],
        default: 'freeform',
        description: 'What kind of thing the text is. Sets the Judge’s framing.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  annotations: {
    title: 'Check text against the brand Law and Judge',
    // It appends one audit row and mutates nothing else.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },

  async run(args) {
    const parsed = checkComplianceInput.safeParse(args ?? {});
    if (!parsed.success) return invalidArgs('check_compliance', parsed.error);
    const { text, subject } = parsed.data;

    // ONE instant for the whole request: the window `cap` is counted over and
    // the day the reserved units come out of must be the same day.
    const now = new Date();

    let cap: CapState;
    try {
      cap = await readCapState(now);
    } catch (err) {
      if (err instanceof CapUnavailableError) return result(capUnknownRefusal(err), true);
      throw err;
    }

    const { blocks, evidence, swatches, voiceExamples } = await loadBrainContext();

    // Deterministic, offline, and unconditional. This half of the answer does
    // not depend on a model answering, on a key existing, or on the cap.
    // `evidence`, never `blocks` — see BrainContext.
    const law = runLaw({ text, context: evidence, swatches, voiceExamples });

    if (cap.remaining <= 0) {
      return result({
        tool: 'check_compliance',
        subject,
        passed: false,
        needs_human: true,
        law: lawSummary(law),
        judge: {
          status: 'refused_daily_cap' satisfies JudgeStatus,
          verdict: null,
          model: null,
          ...capRefusal(cap, 1),
        },
        canon: [],
        recorded: null,
        cap,
        note: 'The Law ran and is complete. Only the model-backed Judge was refused.',
        grounding: 'data' satisfies Grounding,
      });
    }

    /* -- THE RESERVATION, AND WHY IT IS HERE -----------------------------
     * BEFORE retrieveCanon, not after it. Canon retrieval embeds the query,
     * and that embedding is a billed request on a different provider key when
     * EMBEDDING_PROVIDER=openai. This file deliberately does not import the
     * embedder to find out which provider is configured: it does not need to,
     * because taking the unit first bounds the spend either way, and a gate
     * that has to know how its callee is configured is a gate that goes stale.
     * ------------------------------------------------------------------ */
    let attempt: ReservationAttempt;
    try {
      attempt = await reserveUnits({ tool: 'check_compliance', units: 1, cap, now });
    } catch (err) {
      if (err instanceof CapUnavailableError) return result(capUnknownRefusal(err), true);
      throw err;
    }

    if (!attempt.granted) {
      return result({
        tool: 'check_compliance',
        subject,
        passed: false,
        needs_human: true,
        law: lawSummary(law),
        judge: {
          status: 'refused_daily_cap' satisfies JudgeStatus,
          verdict: null,
          model: null,
          ...reservationRefusal(cap, 1, attempt.refusal),
        },
        canon: [],
        recorded: null,
        cap,
        note: 'The Law ran and is complete. Only the model-backed Judge was refused.',
        grounding: 'data' satisfies Grounding,
      });
    }

    const reservation = attempt.reservation;
    const ledger = new SpendLedger();

    // Announced BEFORE the call. From here on nothing in this request can prove
    // it billed nothing, so nothing in this request may release these units.
    ledger.mayBill(
      'canon retrieval, which embeds the query (a billed request when EMBEDDING_PROVIDER=openai)',
    );

    const canon = await retrieveCanon('brand voice, colour usage, social copy standards', {
      tags: ['voice', 'color', 'social', 'arabic-specific'],
      k: 5,
    });

    const ruling = await judge({
      candidate: text,
      law,
      canon,
      blocks,
      task: `${subject} submitted for compliance review by an external MCP caller`,
    });

    const passed =
      ruling.verdict !== null && ruling.verdict.verdict === 'pass' && law.violations.length === 0;

    /* -- RECONCILE -------------------------------------------------------
     * Settled before the ledger row is written, so the accounting is right
     * even if that insert fails. `ruling.unavailable` is scoped to the Judge;
     * reconcileSpend weighs it against everything that ran earlier, which is
     * why a Judge that refused locally AFTER a Canon embedding settles
     * `unproven` rather than releasing.
     * ------------------------------------------------------------------ */
    const reconciled = reconcileSpend(ledger, ruling.unavailable);
    const settlement = await settleReservation(reservation, reconciled.outcome, reconciled.reason);

    // The compliance_checks row is the RULING ledger — the same one
    // /api/compliance writes — and is written exactly when a Judge call may
    // have been billed. It is no longer the unit of account: the reservation
    // above is, and it was taken before any of this could cost anything.
    let recorded: { id: string; created_at: string } | null = null;
    if (ruling.spent) {
      const { data, error } = await supabaseAdmin()
        .from('compliance_checks')
        .insert({
          subject_type: subject,
          subject_ref: null,
          input_text: text,
          law_results: law.results,
          // The column is NOT NULL, so a check with no ruling records the
          // absence itself rather than a stand-in verdict with an invented
          // score.
          judge_verdict: ruling.verdict ?? {
            status: 'unavailable',
            reason: ruling.unavailable?.reason ?? 'The Judge did not rule.',
          },
          passed,
        })
        .select('id, created_at')
        .single();

      if (error) throw new Error(`Could not record the check: ${error.message}`);
      recorded = data as { id: string; created_at: string };
    }

    return result({
      tool: 'check_compliance',
      subject,
      passed,
      // No ruling is not a pass. A human decides.
      needs_human: ruling.verdict === null || ruling.verdict.needs_human,
      law: lawSummary(law),
      judge: {
        status: ruling.status,
        verdict: ruling.verdict,
        model: ruling.model,
        unavailable: ruling.unavailable,
      },
      canon: canonSummary(canon),
      recorded,
      reservation: reservationReport(reservation, settlement),
      cap: await readCapState(),
      grounding: 'data' satisfies Grounding,
    });
  },
};

/* ------------------------------------------------------ 2. generate_concepts */

const generateConceptsInput = z.object({
  count: z.number().int().min(1).max(8).default(3),
  theme: z.string().trim().max(300).nullish(),
  account: accountSchema.default('academy'),
});

/** The persisted half of the concepts feature, re-validated rather than cast. */
const persistedConceptsSchema = z.object({
  inserted: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      format: z.string(),
      status: z.string(),
      account: z.string().nullable(),
    }),
  ),
});

const GENERATE_CONCEPTS_DESCRIPTION = `Generate Instagram post concepts for Think Quality Academy, grounded in the account's own data and reviewed by the brand's Law and Judge before you see them.

Each concept comes back with an Arabic hook, an Arabic caption, a visual
direction, the reason it was proposed, and a "grounding" of "data" (every claim
traces to the account's real numbers) or "hypothesis" (it does not). Concepts are
saved as DRAFTS in the studio for a human to review. Nothing is scheduled and
nothing is posted — this studio has no write access to Instagram at all.

WHEN TO USE IT
- The operator or the client wants new post ideas for one of the two accounts.
- You want ideas that are anchored to what actually performed, rather than
  generic social-media advice.

WHEN NOT TO USE IT
- Do NOT use it to ship content. Everything it returns is a draft awaiting a
  human; treat a returned concept as a proposal, never as approved copy.
- Do NOT call it repeatedly to "get a better one". It is capped, each call
  spends real money, and the cap is shared with the operator's own work — a
  retry loop locks the studio's own team out for the rest of the day.
- Do NOT use it to check existing text. That is check_compliance.
- It cannot fetch fresh Instagram data. It reasons over the latest snapshot the
  studio has already ingested; if that snapshot is stale, the concepts are
  grounded in stale numbers and say so through "grounding".

PARAMETERS
- count (optional integer, 1–8, default 3). How many concepts to produce. This
  is also how many cap units the call consumes, so ask for what you will read.
  Values outside 1–8 are refused, not clamped.
- theme (optional string, up to 300 characters, may be null). An angle to work
  from, e.g. a campaign or a topic. Omit it and the model picks angles the data
  supports rather than inventing a theme.
- account (optional, "personal" or "academy", default "academy"). Which of the
  two Instagram accounts the concepts are for. They behave very differently and
  a concept written for one is usually wrong for the other.
There is deliberately no model or quality parameter: the tier is fixed so an
external caller cannot escalate spend.

WHAT COMES BACK
{ "concepts": [...], "stored": {...}, "law": {...}, "judge": {...},
  "passed", "needs_human", "usage", "reservation": {...}, "cap": {...} }
"needs_human" is true whenever the Judge failed the batch or could not rule.
Concepts are stored regardless — as drafts, flagged — because hiding rejected
work from the operator is worse than showing it with its verdict attached.

REFUSAL SHAPES — always a shaped object with a "refusal" key, never prose:
- "invalid_arguments" — count out of range, theme too long, unknown account.
  Nothing ran and nothing was counted.
- "daily_generation_cap_reached" — returned BEFORE any model call when the day
  has no room for "count" more. The payload names the limit, what has been used,
  the env var that moves it, and the exact instant it resets. "gate" says which
  check refused: "reservation" means other requests in this same window already
  hold the units, so the answer can differ from what "cap" alone suggests. Do
  not retry before the reset; retrying cannot succeed.
- "model_unavailable" — no model provider key is configured on this deployment.
  The reserved units are RELEASED here, because this refusal happens inside the
  process before the first call that could bill — "reservation.outcome" says
  "released" and proves it. This needs an operator, not a retry.

SIDE EFFECTS
Reserves "count" cap units before any paid work, then inserts draft concept
rows. Reads no Instagram data, triggers no scrape and spends nothing on Apify —
it cannot: no scraping code is reachable from here.`;

const generateConceptsTool: McpTool = {
  name: 'generate_concepts',
  title: 'Generate reviewed post concepts',
  description: GENERATE_CONCEPTS_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
        default: 3,
        description:
          'How many concepts to produce, 1–8. Also how many daily cap units the call consumes. Out-of-range values are refused, not clamped.',
      },
      theme: {
        type: ['string', 'null'],
        maxLength: 300,
        description:
          'Optional angle to work from, up to 300 characters. Omit for angles the data supports.',
      },
      account: {
        type: 'string',
        enum: ['personal', 'academy'],
        default: 'academy',
        description:
          'Which Instagram account the concepts are for. The two accounts behave very differently.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: {
    title: 'Generate reviewed post concepts',
    readOnlyHint: false,
    // It only ever appends drafts.
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },

  async run(args) {
    const parsed = generateConceptsInput.safeParse(args ?? {});
    if (!parsed.success) return invalidArgs('generate_concepts', parsed.error);
    const { count, theme, account } = parsed.data;

    // ONE instant for the whole request, as in check_compliance.
    const now = new Date();

    let cap: CapState;
    try {
      cap = await readCapState(now);
    } catch (err) {
      if (err instanceof CapUnavailableError) return result(capUnknownRefusal(err), true);
      throw err;
    }

    // A cheap early refusal against the durable count, kept because it answers
    // without touching the reservation ledger and because it is checked against
    // what this call would ADD rather than merely against whether any room is
    // left: asking for 5 with 2 remaining is refused up front, not half-served.
    //
    // IT IS NOT THE GATE. It is a read, and a read cannot bound spend — N
    // concurrent isolates each pass it. The gate is the reservation below.
    if (cap.used + count > cap.limit) {
      return result(capRefusal(cap, count));
    }

    /* -- THE RESERVATION ---------------------------------------------------
     * Taken before conceptsFeature.run(), which is this tool's first paid call.
     * One statement decides; twenty simultaneous requests contend on one row
     * and at most `limit` units are ever handed out.
     * -------------------------------------------------------------------- */
    let attempt: ReservationAttempt;
    try {
      attempt = await reserveUnits({ tool: 'generate_concepts', units: count, cap, now });
    } catch (err) {
      if (err instanceof CapUnavailableError) return result(capUnknownRefusal(err), true);
      throw err;
    }

    if (!attempt.granted) {
      return result(reservationRefusal(cap, count, attempt.refusal));
    }

    const reservation = attempt.reservation;
    const ledger = new SpendLedger();

    let outcome: Awaited<ReturnType<typeof conceptsFeature.run>>;
    try {
      outcome = await conceptsFeature.run({ count, theme, account }, MCP_QUALITY);
    } catch (err) {
      const failure = describeModelFailure(err);
      const reconciled = reconcileSpend(ledger, failure);
      const settlement = await settleReservation(reservation, reconciled.outcome, reconciled.reason);

      if (!failure.spent) {
        return result(
          {
            refusal: 'model_unavailable',
            reason: failure.reason,
            hint: failure.hint,
            // The ledger is empty here — conceptsFeature.run() is the FIRST
            // call in this request that could bill — so a local refusal really
            // does prove nothing was spent, and the units go back. That is a
            // proof about this position in this tool, not a property of
            // `spent: false` in general.
            note:
              reconciled.outcome === 'released'
                ? 'Nothing left this process, so nothing was spent and the reserved units were returned to the window.'
                : 'The failing call left nothing, but an earlier step in this request could have billed, so the reserved units stay consumed.',
            reservation: reservationReport(reservation, settlement),
            cap,
            grounding: 'data' satisfies Grounding,
          },
          true,
        );
      }
      throw err;
    }

    // The model answered: the money is gone. Settled here, before the review
    // leg below, so the ledger records the spend even if the review throws.
    const settlement = await settleReservation(
      reservation,
      'spent',
      'conceptsFeature.run() completed, so a billed model call went out.',
    );

    // Re-validated against the feature's own schema rather than cast: the
    // outcome is typed `unknown` at this boundary and a cast here would be a
    // claim about a shape nobody checked.
    const concepts = conceptsResponseSchema.parse(outcome.result);
    const stored = persistedConceptsSchema.parse(outcome.persisted);

    /* -- the brain gate ----------------------------------------------------
     * The concepts feature is not opted into the Design Brain (it declares no
     * `brain` config), so /api/generate/concepts returns unreviewed drafts to
     * an operator who can see them on screen. An external caller cannot, so the
     * gate is applied HERE, with the same modules defineFeature() uses: the
     * real runLaw, the real Canon retrieval, the real runJudge, the real
     * reconcile. This costs one extra context read, which is stated rather than
     * hidden.
     *
     * NO SECOND RESERVATION IS TAKEN. The review is part of the request the
     * caller already reserved `count` units for, and the tool's own description
     * says `count` is what the call consumes — charging again here would make
     * that documentation false. It is covered rather than uncounted: the units
     * were taken before any of it could bill, which is the property finding 1
     * was about.
     * -------------------------------------------------------------------- */
    const { blocks, evidence, swatches, voiceExamples } = await loadBrainContext();
    const candidate = conceptsToText(concepts);

    // `evidence`, never `blocks` — see BrainContext. This one matters twice
    // over: the concepts the Law is reading were generated FROM these blocks,
    // so a hook that echoed a caption's figure would otherwise source itself.
    const law = runLaw({ text: candidate, context: evidence, swatches, voiceExamples });

    const canon = await retrieveCanon(
      'post concept structure, hook, caption, social copy standards',
      { tags: ['voice', 'social', 'arabic-specific'], k: 5 },
    );

    const ruling = await judge({
      candidate,
      law,
      canon,
      blocks,
      task: `batch of ${concepts.concepts.length} post concepts for the ${account} account`,
    });

    const passed =
      ruling.verdict !== null && ruling.verdict.verdict === 'pass' && law.violations.length === 0;

    return result({
      tool: 'generate_concepts',
      requested: { count, theme: theme ?? null, account },
      concepts: concepts.concepts,
      warnings: concepts.warnings,
      stored: {
        ids: stored.inserted.map((c) => c.id),
        status: 'draft',
        note: 'Saved as drafts for a human to review. Nothing is scheduled and nothing is posted.',
      },
      law: lawSummary(law),
      judge: {
        status: ruling.status,
        verdict: ruling.verdict,
        model: ruling.model,
        unavailable: ruling.unavailable,
      },
      canon: canonSummary(canon),
      passed,
      needs_human: ruling.verdict === null || ruling.verdict.verdict === 'fail' || ruling.verdict.needs_human,
      model: outcome.model,
      usage: outcome.usage,
      reservation: reservationReport(reservation, settlement),
      cap: await readCapState(),
      grounding: 'data' satisfies Grounding,
    });
  },
};

/** The concepts flattened for Law and Judge, the way every brain-gated feature
 *  flattens its own result. */
function conceptsToText(response: z.infer<typeof conceptsResponseSchema>): string {
  const body = response.concepts
    .map((c, i) =>
      [
        `${i + 1}. ${c.title} [${c.format}${c.pillar === null ? '' : ` · ${c.pillar}`}]`,
        c.hook_ar,
        c.caption_ar,
        `Visual: ${c.visual_direction}`,
        `Why: ${c.why}`,
        `Grounding: ${c.grounding}${c.needs_calibration ? ' · needs calibration' : ''}`,
      ].join('\n'),
    )
    .join('\n\n');

  return response.warnings.length > 0
    ? `${body}\n\nWarnings:\n${response.warnings.map((w) => `- ${w}`).join('\n')}`
    : body;
}

/* -------------------------------------------------------- 3. get_brand_facts */

const getBrandFactsInput = z.object({}).strict();

const GET_BRAND_FACTS_DESCRIPTION = `Read the verified facts the studio holds about Think Quality Academy, each with the source it came from.

Read-only. Calls no model, costs nothing, and does not count against the daily
generation cap.

WHEN TO USE IT
- BEFORE writing or judging anything about this client. Every fact carries a
  "source" field; quote facts from here rather than recalling them.
- To find out whether a claim you are about to make is actually supported. If a
  number is not in this list, the studio has not verified it.

WHEN NOT TO USE IT
- Do not use it as a general knowledge lookup about the client. It returns what
  has been verified and written down, which is deliberately narrower than what
  is true.
- Do not treat an empty "facts" array as "this client has no facts". It means
  none have been recorded yet. Absent is not zero, and it is never filled in
  with a plausible guess.
- Do not use the palette to write colour values into copy. Swatch NAMES are
  returned and hex values are deliberately withheld: brand copy references a
  colour by name, and the Law fails any output containing a raw hex.

PARAMETERS
None. The tool takes an empty object; any property is rejected.

WHAT COMES BACK
{ "facts": [{ "key", "value", "source", "label_en", "label_ar" }],
  "palette_swatch_names", "typography", "audience_notes", "status",
  "updated_at", "counts", "source_keys" }
"status" is "seed" (still being assembled) or "live" (palette recorded).
"counts" reports how many voice examples, knowledge documents and brand assets
exist WITHOUT returning their contents — those are the client's own writing and
files, and this tool does not hand them out.

REFUSAL SHAPES
- "invalid_arguments" — an argument was supplied. This tool takes none.
There is no cap refusal: nothing here is capped.

SIDE EFFECTS
None. One database read.`;

const getBrandFactsTool: McpTool = {
  name: 'get_brand_facts',
  title: 'Read the verified brand facts and their sources',
  description: GET_BRAND_FACTS_DESCRIPTION,
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  annotations: {
    title: 'Read the verified brand facts and their sources',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  async run(args) {
    const parsed = getBrandFactsInput.safeParse(args ?? {});
    if (!parsed.success) return invalidArgs('get_brand_facts', parsed.error);

    const { data, error } = await supabaseAdmin()
      .from('brand')
      .select('*')
      .eq('id', 1)
      .maybeSingle();

    if (error) throw new Error(`Could not read the Brand Brain: ${error.message}`);
    const brand = data as BrandRow | null;

    if (brand === null) {
      return result({
        tool: 'get_brand_facts',
        facts: [],
        // Absent, not zero, and not an invented placeholder.
        note: 'The Brand Brain has not been seeded on this deployment, so there are no verified facts to report.',
        grounding: 'data' satisfies Grounding,
      });
    }

    return result({
      tool: 'get_brand_facts',
      status: brand.status,
      updated_at: brand.updated_at,
      facts: brand.facts.map((f) => ({
        key: f.key,
        value: f.value,
        source: f.source,
        label_en: f.label_en ?? null,
        label_ar: f.label_ar ?? null,
      })),
      // Names only. See the description: a hex in client copy is a Law
      // violation, so handing an external generator the hexes would be handing
      // it the violation.
      palette_swatch_names: Object.keys(brand.palette?.swatches ?? {}),
      palette_note: brand.palette?.note ?? null,
      typography: brand.typography,
      audience_notes: brand.audience_notes,
      counts: {
        facts: brand.facts.length,
        voice_examples: brand.voice_examples.length,
        knowledge_documents: brand.knowledge.length,
        assets: brand.assets.length,
      },
      source_keys: {
        'counts.facts': 'length(brand.facts)',
        'counts.voice_examples': 'length(brand.voice_examples)',
        'counts.knowledge_documents': 'length(brand.knowledge)',
        'counts.assets': 'length(brand.assets)',
        'palette_swatch_names': 'keys(brand.palette.swatches)',
      },
      withheld: {
        voice_examples: "the client's own captions, counted here but not returned",
        knowledge_documents: "the client's own documents, counted here but not returned",
        palette_hex_values: 'names are returned instead; a hex in copy is a Law violation',
      },
      grounding: 'data' satisfies Grounding,
    });
  },
};

/* ------------------------------------------------------ 4. get_latest_digest */

const getLatestDigestInput = z.object({}).strict();

const GET_LATEST_DIGEST_DESCRIPTION = `Read the most recent strategist digest: what changed on the two accounts over a period, what it means, and the decisions written down to be judged later.

Read-only. Calls no model, costs nothing, and does not count against the daily
generation cap. It returns a digest that already exists; it does not run the
strategist.

WHEN TO USE IT
- To answer "what is going on with the accounts right now" with the studio's own
  latest analysis instead of a fresh guess.
- To see which decisions are open and what evidence each rests on. Every claim
  in the payload carries a "basis" naming the source key and the value verbatim.

WHEN NOT TO USE IT
- Do not use it to produce a new digest. There is no tool for that here, on
  purpose: running the strategist is an operator action taken in the studio.
- Do not present "client_digest_ar" to anyone as if it had been sent. "sent" is
  a field a human sets by hand AFTER actually sending it; this server cannot
  and will not change it.
- Do not read a null digest as "nothing happened". It means no digest has been
  generated on this deployment yet.

PARAMETERS
None. The tool takes an empty object; any property is rejected.

WHAT COMES BACK
{ "digest": { "id", "period_from", "period_to", "status", "payload",
              "client_digest_ar", "sent", "created_at" } | null }
"status" is "material" (the period contained real movement) or "quiet" (it did
not — a short honest digest rather than a padded one).

REFUSAL SHAPES
- "invalid_arguments" — an argument was supplied. This tool takes none.
There is no cap refusal: nothing here is capped.

SIDE EFFECTS
None. One database read. In particular it never marks a digest as sent.`;

const getLatestDigestTool: McpTool = {
  name: 'get_latest_digest',
  title: 'Read the latest strategist digest',
  description: GET_LATEST_DIGEST_DESCRIPTION,
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  annotations: {
    title: 'Read the latest strategist digest',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  async run(args) {
    const parsed = getLatestDigestInput.safeParse(args ?? {});
    if (!parsed.success) return invalidArgs('get_latest_digest', parsed.error);

    const { data, error } = await supabaseAdmin()
      .from('digests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw new Error(`Could not read digests: ${error.message}`);
    const digest = (data as DigestRow[] | null)?.[0] ?? null;

    if (digest === null) {
      return result({
        tool: 'get_latest_digest',
        digest: null,
        // Absent, not empty, and not a zero-filled stand-in.
        note: 'No digest has been generated on this deployment yet.',
        grounding: 'data' satisfies Grounding,
      });
    }

    return result({
      tool: 'get_latest_digest',
      digest: {
        id: digest.id,
        period_from: digest.period_from,
        period_to: digest.period_to,
        status: digest.status,
        payload: digest.payload,
        client_digest_ar: digest.client_digest_ar,
        sent: digest.sent,
        created_at: digest.created_at,
      },
      note: '"sent" is set by a human after actually sending the digest. This server never writes it.',
      grounding: 'data' satisfies Grounding,
    });
  },
};

/* ================================================== the closed allow-list ====
 *
 * Four names, fixed at compile time. See the header for why this is the shape
 * it is. Adding a fifth means editing this tuple, which means editing this
 * file, which means the diff shows up in review — as opposed to a registry that
 * accretes entries from elsewhere in the tree.
 * ========================================================================== */

export const MCP_TOOL_NAMES = [
  'check_compliance',
  'generate_concepts',
  'get_brand_facts',
  'get_latest_digest',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Total over McpToolName: a name in the tuple with no entry is a compile error. */
const TOOLS: Record<McpToolName, McpTool> = {
  check_compliance: checkComplianceTool,
  generate_concepts: generateConceptsTool,
  get_brand_facts: getBrandFactsTool,
  get_latest_digest: getLatestDigestTool,
};

function isToolName(name: string): name is McpToolName {
  // Membership of the frozen tuple, NOT a property lookup on the record — so a
  // caller cannot reach `constructor`, `__proto__` or any inherited key.
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** The tools as `tools/list` publishes them. Handlers are not exposed. */
export function listTools(): Record<string, unknown>[] {
  return MCP_TOOL_NAMES.map((name) => {
    const tool = TOOLS[name];
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    };
  });
}

/* ============================================================== JSON-RPC 2.0 ==*/

type JsonRpcId = string | number | null;

const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

function rpcResult(id: JsonRpcId, value: Record<string, unknown>): Response {
  return Response.json({ jsonrpc: '2.0', id, result: value });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
  data?: Record<string, unknown>,
): Response {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } },
    { status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(body: Record<string, unknown>): JsonRpcId {
  const id = body.id;
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null;
}

function negotiateProtocol(params: Record<string, unknown> | null): string {
  const asked = params?.protocolVersion;
  if (typeof asked === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)) {
    return asked;
  }
  // We answer with the newest we actually speak rather than echoing something
  // we do not — a client that cannot live with it disconnects, which is the
  // spec's intent and is better than a silent mismatch.
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * The whole endpoint: authorise, parse, dispatch.
 *
 * Written against the platform `Request`/`Response` rather than `NextResponse`
 * so this module has no Next.js import at all — which is what lets
 * tests/mcp.test.ts execute the real auth and dispatch paths under
 * `node --test`. Next route handlers may return a plain `Response`;
 * `NextResponse` is a subclass of it.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const auth = authorize(request);
  if (!auth.ok) {
    // 401 for every failure mode, including "the server has no token bound".
    // Distinguishing them by status code would tell an unauthenticated caller
    // something about the deployment's configuration; the message says enough
    // for an honest operator and nothing useful to anyone else.
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERRORS.invalidRequest, message: auth.message ?? 'Unauthorized.' },
      },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, JSON_RPC_ERRORS.parse, 'Request body is not valid JSON.', 400);
  }

  if (Array.isArray(body)) {
    return rpcError(
      null,
      JSON_RPC_ERRORS.invalidRequest,
      'Batched requests are not supported. Send one JSON-RPC request per HTTP request.',
      400,
    );
  }

  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(
      null,
      JSON_RPC_ERRORS.invalidRequest,
      'Expected a JSON-RPC 2.0 request object with "jsonrpc": "2.0" and a "method" string.',
      400,
    );
  }

  const id = readId(body);
  const method = body.method;
  const params = isRecord(body.params) ? body.params : null;

  // A notification carries no id and expects no response body.
  if (method.startsWith('notifications/')) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiateProtocol(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: MCP_SERVER_NAME,
          title: 'ThinkQuality Studio',
          // RESTATED CONSTANT: package.json's "version". MCP requires a string
          // here and this module cannot import package.json without pulling a
          // file from outside src/ into the Worker bundle. If package.json is
          // bumped and this is not, the number goes stale — named rather than
          // invented, and deliberately not a made-up "4.0.0" that would match
          // nothing at all.
          version: MCP_SERVER_VERSION,
        },
        instructions:
          'Read-only analysis studio for one Instagram client. Four tools, no more. ' +
          'Nothing here publishes, schedules, scrapes or spends on data collection. ' +
          'Model-backed tools share one daily cap; read get_brand_facts before writing anything.',
      });

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: listTools() });

    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string') {
        return rpcError(id, JSON_RPC_ERRORS.invalidParams, 'tools/call requires a "name" string.');
      }
      if (!isToolName(name)) {
        return rpcError(
          id,
          JSON_RPC_ERRORS.methodNotFound,
          `Unknown tool "${name}". This server exposes exactly ${MCP_TOOL_NAMES.length}: ${MCP_TOOL_NAMES.join(', ')}.`,
        );
      }

      try {
        return rpcResult(id, { ...(await TOOLS[name].run(params?.arguments)) });
      } catch (err) {
        // Reported as a tool-level error, not a protocol error: the call was
        // well-formed and the caller needs to see what failed. No stack, no
        // env value, no token — ever.
        return rpcResult(id, {
          ...result(
            {
              refusal: 'tool_failed',
              tool: name,
              reason: err instanceof Error ? err.message : 'The tool failed.',
            },
            true,
          ),
        });
      }
    }

    default:
      return rpcError(
        id,
        JSON_RPC_ERRORS.methodNotFound,
        `Unsupported method "${method}". This server implements initialize, ping, tools/list and tools/call.`,
      );
  }
}
