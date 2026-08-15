import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* =============================================================== what this ==
 * The chat may DISPATCH a deliverable (hard rule 17) and dispatching costs
 * money, so hard rule 18 applies: no new spend path, and over cap a STRUCTURED
 * refusal naming the cap and the reset time.
 *
 * That cap is not a new one. It is the atomic reservation from
 * supabase/migrations/0005_mcp_reservations.sql — the same `mcp_reserve_units`
 * statement, the same `mcp_cap_days` row, the same Amman window — reached under
 * a different tool name, which is the extension point 0005 documents. Two
 * lessons from the audit that produced 0005 are the properties under test here,
 * and neither can be established by reading the source:
 *
 *   1. A CAP THAT COUNTS OUTCOMES CANNOT BOUND SPEND, because spend precedes the
 *      outcome. So the units must be RESERVED BEFORE the first call that can
 *      bill. That is an ordering claim, and it is asserted from an ORDERED
 *      EXECUTION LOG — with both indices checked non-negative, so a run where
 *      neither operation happened cannot pass by comparing -1 to -1.
 *   2. A READ-THEN-ACT CHECK IS NOT A GATE. Proven here the way tests/mcp.test.ts
 *      proves it: the same scenario is run twice, once against a fake that
 *      decides and writes in one uninterrupted run and once against a fake that
 *      models the defect, and the defective one is asserted to OVERSPEND. A test
 *      that cannot fail against the bug is not evidence.
 *
 * Plus the reconciliation rule, which is the other half of finding 1: units go
 * back only when the failure PROVES nothing was billed. A failure that cannot
 * prove it keeps them.
 *
 * WHAT IS PROVEN HERE, TODAY, WITH NO MODEL KEY:
 *   - the over-cap refusal is a structured object naming the limit, the env var,
 *     what is used, and the exact instant the window resets;
 *   - the reservation is taken before the dispatch fires, in execution order;
 *   - a MissingEnvError failure releases its units; an HttpError one does not;
 *   - a refused dispatch never reaches the feature at all;
 *   - the dispatchable list is a subset of the real registry;
 *   - a dispatch result carries NO deliverable text — rule 17, as a property of
 *     the returned object rather than an instruction in a prompt.
 *
 * WHAT IS NOT PROVEN HERE:
 *   Postgres's isolation. node is single-threaded and the database is a fake, so
 *   this file proves the half that lives in TypeScript: one round trip, never a
 *   read-then-act pair, and a refusal honoured. The database's half is argued
 *   and measured in 0005 itself.
 *
 *   Also not proven: that the reservation SUCCEEDS against the live database.
 *   `mcp_reservations.tool` still carries 0005's CHECK constraint
 *   (`tool in ('check_compliance','generate_concepts')`), so until a migration
 *   adds CHAT_RESERVING_TOOL the real RPC raises, the function rolls back, and
 *   every dispatch fails closed through the `chat_daily_generation_cap_unknown`
 *   branch — which is tested below, deliberately, because it is the state this
 *   deployment is actually in.
 * ========================================================================= */

/* ---------------------------------------------------------------- loader --
 * Same approach as tests/mcp.test.ts and tests/needs-human.test.ts: app modules
 * import through the `@/*` alias, which node does not resolve, and a few reach
 * into Supabase or next/server. These hooks teach this process the one alias
 * rule from tsconfig (`@/*` -> `./src/*`), resolve extensionless relative
 * imports, and swap two modules for stubs.
 *
 * `@/lib/env` is NOT stubbed: the cap's default and its env override are env
 * behaviour, so the real module runs and the tests move process.env instead.
 * ------------------------------------------------------------------------ */

const SRC = new URL('../src/', import.meta.url).href;

const AUTH_STUB = 'stub:lib-auth';
const DB_STUB = 'stub:lib-supabase-admin';
const AGENT_STUB = 'stub:lib-agent-client';

const STUBS: Record<string, string> = {
  '@/lib/auth': AUTH_STUB,
  '@/lib/supabase/admin': DB_STUB,
  '@/lib/agent/client': AGENT_STUB,
};

const STUB_SOURCE: Record<string, string> = {
  [AUTH_STUB]:
    'export class HttpError extends Error {' +
    '  constructor(status, message, hint) {' +
    '    super(message);' +
    '    this.name = "HttpError";' +
    '    this.status = status;' +
    '    this.hint = hint;' +
    '  }' +
    '}',
  [DB_STUB]:
    'let factory = null;' +
    'export function __setDb(fn) { factory = fn; }' +
    'export function supabaseAdmin() {' +
    '  if (!factory) throw new Error("chat-cap.test.ts: no fake database installed.");' +
    '  return factory();' +
    '}',
  [AGENT_STUB]:
    'export async function runAgentJson() {' +
    '  throw new Error("chat-cap.test.ts: no model may be called.");' +
    '}' +
    'export function modelFor() { return "stub — no model was called"; }' +
    'export function resolveProvider() { return "openrouter"; }',
};

function tsFile(base: string): string | null {
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub) return { url: stub, shortCircuit: true };

    if (specifier.startsWith('@/')) {
      const url = tsFile(new URL(specifier.slice(2), SRC).href);
      if (url) return { url, shortCircuit: true };
    }

    const parent = context.parentURL;
    if (specifier.startsWith('.') && parent?.startsWith('file:') && !/\.[a-z]+$/i.test(specifier)) {
      const url = tsFile(new URL(specifier, parent).href);
      if (url) return { url, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = STUB_SOURCE[url];
    if (source) return { format: 'module', shortCircuit: true, source };
    return nextLoad(url, context);
  },
});

/* =========================================================== the fake ledger ==
 *
 * Stands in for 0005: the same predicate, the same return shape, the same
 * settle-once guard. `atomic` mode decides and writes in ONE synchronous run
 * with no await between them — this harness's stand-in for one statement under a
 * row lock. `read_then_act` mode reads the total, yields, and acts on the stale
 * number; that mode is not a convenience, it is the defect, kept executable so
 * the parallel test can be shown to detect it.
 * ========================================================================== */

interface FakeReservation {
  id: string;
  day: string;
  tool: string;
  units: number;
  status: 'reserved' | 'spent' | 'unproven' | 'released';
  note: string | null;
}

interface FakeState {
  /** Per-table durable `count: 'exact'` answers, read by readCapState(). */
  counts: Record<string, number | null>;
  reservations: FakeReservation[];
  reservedByDay: Map<string, number>;
  /** The highest the counter ever held. The safety property is about the PEAK. */
  peakByDay: Map<string, number>;
  reserveMode: 'atomic' | 'read_then_act';
  /** Set to fail every RPC, modelling the missing CHECK-constraint migration. */
  rpcError: string | null;
  /** Every database touch, RPC and feature run, IN ORDER. */
  ops: string[];
  /** How many times a dispatched feature was actually run. */
  featureRuns: number;
}

function freshState(): FakeState {
  return {
    counts: { concepts: 0, compliance_checks: 0 },
    reservations: [],
    reservedByDay: new Map<string, number>(),
    peakByDay: new Map<string, number>(),
    reserveMode: 'atomic',
    rpcError: null,
    ops: [],
    featureRuns: 0,
  };
}

let state = freshState();

interface RpcReply {
  data: unknown;
  error: { message: string } | null;
}

let reservationSeq = 0;

function holdUnits(day: string, units: number): void {
  const after = (state.reservedByDay.get(day) ?? 0) + units;
  state.reservedByDay.set(day, after);
  state.peakByDay.set(day, Math.max(state.peakByDay.get(day) ?? 0, after));
}

function grantReply(day: string, tool: string, units: number): RpcReply {
  holdUnits(day, units);
  reservationSeq += 1;
  const id = `fake-reservation-${reservationSeq}`;
  state.reservations.push({ id, day, tool, units, status: 'reserved', note: null });
  return {
    data: [{ granted: true, reservation_id: id, units_reserved_today: state.reservedByDay.get(day) ?? units }],
    error: null,
  };
}

function refusedReply(day: string): RpcReply {
  return {
    data: [{ granted: false, reservation_id: null, units_reserved_today: state.reservedByDay.get(day) ?? 0 }],
    error: null,
  };
}

async function fakeReserve(args: Record<string, unknown>): Promise<RpcReply> {
  const day = String(args.p_day);
  const tool = String(args.p_tool);
  const units = Number(args.p_units);
  const limit = Number(args.p_limit);
  const durableUsed = Number(args.p_durable_used);

  // greatest(reserved_units, p_durable_used) + p_units <= p_limit — 0005's
  // predicate, evaluated on the value being written.
  const fits = (held: number): boolean => Math.max(held, durableUsed) + units <= limit;

  if (state.reserveMode === 'read_then_act') {
    const stale = state.reservedByDay.get(day) ?? 0;
    // The yield is the whole defect: every caller decides on a number that was
    // true before any of them wrote.
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (!fits(stale)) return refusedReply(day);
    return grantReply(day, tool, units);
  }

  const held = state.reservedByDay.get(day) ?? 0;
  if (!fits(held)) return refusedReply(day);
  return grantReply(day, tool, units);
}

function fakeSettle(args: Record<string, unknown>): RpcReply {
  const id = String(args.p_reservation);
  const status = String(args.p_status);
  const note = args.p_note === null || args.p_note === undefined ? null : String(args.p_note);

  if (status !== 'spent' && status !== 'unproven' && status !== 'released') {
    return { data: null, error: { message: `mcp_settle_reservation: bad status "${status}"` } };
  }

  const row = state.reservations.find((r) => r.id === id) ?? null;
  // 0005's `and status = 'reserved'` guard. Settling twice changes nothing, so
  // units can never be refunded twice.
  if (row === null || row.status !== 'reserved') {
    return { data: [{ settled_status: 'already_settled', units_released: 0 }], error: null };
  }

  row.status = status;
  row.note = note;

  if (status === 'released') {
    const held = state.reservedByDay.get(row.day) ?? 0;
    state.reservedByDay.set(row.day, Math.max(0, held - row.units));
    return { data: [{ settled_status: status, units_released: row.units }], error: null };
  }

  return { data: [{ settled_status: status, units_released: 0 }], error: null };
}

async function fakeRpc(fn: string, args: Record<string, unknown>): Promise<RpcReply> {
  state.ops.push(`rpc:${fn}`);
  // Latency BEFORE the decision, so parallel callers genuinely interleave here
  // instead of each running to completion in its own turn.
  await new Promise((resolve) => setTimeout(resolve, 1));

  if (state.rpcError !== null) return { data: null, error: { message: state.rpcError } };
  if (fn === 'mcp_reserve_units') return fakeReserve(args);
  if (fn === 'mcp_settle_reservation') return fakeSettle(args);
  return { data: null, error: { message: `chat-cap.test.ts: no fake for rpc "${fn}"` } };
}

/* --------------------------------------------------------- the fake tables -- */

interface Settled {
  then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown): Promise<unknown>;
}

interface FakeQuery extends Settled {
  select(columns?: unknown, options?: unknown): FakeQuery;
  gte(...args: unknown[]): FakeQuery;
}

function isCountRequest(options: unknown): boolean {
  return typeof options === 'object' && options !== null && 'count' in options;
}

/**
 * Enough of a PostgREST builder for the one read `readCapState()` performs.
 * What it models faithfully is the shape of a `head: true, count: 'exact'`
 * reply, because the fail-closed branch turns on `count` being null rather than
 * a number.
 */
function query(table: string): FakeQuery {
  let counting = false;
  const q: FakeQuery = {
    select: (_columns, options) => {
      if (isCountRequest(options)) counting = true;
      return q;
    },
    gte: () => q,
    then: (onFulfilled, onRejected) =>
      Promise.resolve(
        counting
          ? {
              data: null,
              // NOT `?? 0`: a configured `null` is the fail-closed case, and
              // collapsing it here would make that test assert the opposite of
              // what it says.
              count: table in state.counts ? state.counts[table] : 0,
              error: null,
            }
          : { data: [], error: null },
      ).then(onFulfilled, onRejected),
  };
  return q;
}

interface DbStubModule {
  __setDb(factory: () => unknown): void;
}

const dbStub = (await import('@/lib/supabase/admin')) as unknown as DbStubModule;

dbStub.__setDb(() => ({
  from: (table: string) => {
    state.ops.push(`from:${table}`);
    return query(table);
  },
  rpc: (fn: string, args: Record<string, unknown>) => fakeRpc(fn, args),
}));

/* --------------------------------------------------------- modules under test */

const { MissingEnvError } = await import('../src/lib/env.ts');
const { HttpError } = await import('@/lib/auth');
const { featureIds } = await import('../src/lib/agent/features/registry.ts');

const {
  CHAT_CAP_ENV_KEY,
  CHAT_CAP_REACHED,
  CHAT_CAP_UNKNOWN,
  CHAT_DISPATCHABLE,
  CHAT_DISPATCH_TOOL,
  CHAT_RESERVING_TOOL,
  DEFAULT_CHAT_DAILY_GENERATION_CAP,
  DISPATCH_FAILED,
  DISPATCH_INVALID,
  chatDailyGenerationCap,
  defaultDispatchDeps,
  dispatchToolSpec,
  provablyUnspent,
  readChatCapState,
  readPersisted,
  runDispatch,
  unitsFor,
} = await import('../src/lib/agent/chat/dispatch.ts');

type FeatureOutcome = Awaited<ReturnType<ReturnType<typeof defaultDispatchDeps>['runFeature']>>;

/* ------------------------------------------------------------------ helpers -- */

function reset(): void {
  state = freshState();
  reservationSeq = 0;
  delete process.env.CHAT_DAILY_GENERATION_CAP;
  delete process.env.MCP_DAILY_GENERATION_CAP;
}

/** The index of an operation in the ordered log, or -1. */
function opIndex(op: string): number {
  return state.ops.indexOf(op);
}

/** Units currently held across every day in the fake ledger. */
function unitsHeld(): number {
  let total = 0;
  for (const held of state.reservedByDay.values()) total += held;
  return total;
}

/** The highest the counter ever reached. The safety property is about the PEAK,
 *  not the value it happens to settle at. */
function peakHeld(): number {
  let peak = 0;
  for (const held of state.peakByDay.values()) peak = Math.max(peak, held);
  return peak;
}

function call(args: Record<string, unknown>, id = 'call_1') {
  return { id, name: CHAT_DISPATCH_TOOL, arguments: JSON.stringify(args) };
}

/** What a feature that ran successfully hands back. Deliberately dull. */
function outcomeFor(feature: string): FeatureOutcome {
  return {
    feature,
    model: 'stub — no model was called',
    attempts: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
    // The DELIVERABLE. Nothing in dispatch.ts may read this, and one test below
    // proves nothing does.
    result: { caption_ar: 'نصّ المخرج السرّي الذي يجب ألّا يظهر في المحادثة' },
    persisted: { inserted: [{ id: 'row-1' }, { id: 'row-2' }] },
  };
}

/**
 * The real `runDispatch`, driven by fakes for the three impure edges. The ORDER
 * is not injectable — it is the body of `runDispatch` — so the log below is a
 * record of what executed, not of what these fakes chose.
 */
function deps(runFeature: (feature: string) => Promise<FeatureOutcome>) {
  const real = defaultDispatchDeps();
  return {
    readCap: real.readCap,
    reserve: real.reserve,
    settle: real.settle,
    runFeature: async (feature: string): Promise<FeatureOutcome> => {
      state.ops.push('feature:run');
      state.featureRuns += 1;
      return runFeature(feature);
    },
  };
}

function payloadOf(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  assert.ok(typeof parsed === 'object' && parsed !== null, 'a refusal is a JSON object');
  return parsed as Record<string, unknown>;
}

/* ============================================================ the tool shape */

test('every dispatchable feature is really in the registry', () => {
  reset();
  const registered = featureIds();
  for (const feature of CHAT_DISPATCHABLE) {
    assert.ok(
      registered.includes(feature),
      `"${feature}" is offered to the model but is not registered: ${registered.join(', ')}`,
    );
  }
  // The list is closed, so the model cannot name a target of its own.
  const schema = dispatchToolSpec().parameters;
  const feature = (schema.properties ?? {}).feature as { enum?: unknown };
  assert.deepEqual(feature.enum, [...CHAT_DISPATCHABLE]);
  assert.equal(schema.additionalProperties, false);
});

/* ================================================================== the cap */

test('the over-cap refusal names the cap AND the instant it resets', async () => {
  reset();
  process.env.CHAT_DAILY_GENERATION_CAP = '3';
  // The day's durable work has already filled the window.
  state.counts.concepts = 3;

  const result = await runDispatch({
    call: call({ feature: 'concepts', input: { count: 1 } }),
    quality: 'standard',
    now: new Date('2026-08-15T09:00:00.000Z'),
    deps: deps(async () => {
      throw new Error('the feature must not run when the cap has refused');
    }),
  });

  assert.equal(result.card, undefined, 'a refusal carries no card');
  const payload = payloadOf(result.content);

  assert.equal(payload.refusal, CHAT_CAP_REACHED, 'the refusal is structured, not prose');

  const cap = payload.cap as Record<string, unknown>;
  assert.equal(cap.limit, 3, 'it names the cap that refused');
  assert.equal(cap.used, 3, 'and what has been used against it');
  assert.equal(cap.env_key, CHAT_CAP_ENV_KEY, 'and the variable that moves it');

  // THE RESET TIME, and it is the real Amman midnight rather than UTC's.
  const resetsAt = cap.resets_at;
  assert.equal(typeof resetsAt, 'string');
  assert.equal(payload.resets_at, resetsAt, 'the reset instant is named at the top level too');
  assert.equal(
    new Date(String(resetsAt)).toISOString(),
    // 2026-08-16 00:00 in Amman (UTC+3) is 2026-08-15T21:00Z.
    '2026-08-15T21:00:00.000Z',
    'the window resets at local midnight in Amman, not at UTC midnight',
  );
  assert.equal(cap.resets_on, '2026-08-16');
  assert.equal(cap.time_zone, 'Asia/Amman');

  // The reason a human reads carries both facts in words.
  const reason = String(payload.reason);
  assert.match(reason, /daily cap of 3/);
  const actions = payload.what_you_can_do;
  assert.ok(Array.isArray(actions));
  assert.ok(
    actions.some((line) => typeof line === 'string' && line.includes(String(resetsAt))),
    'and tells the caller when to come back',
  );

  // Nothing ran, and nothing was reserved.
  assert.equal(state.featureRuns, 0);
  assert.equal(opIndex('rpc:mcp_reserve_units'), -1, 'refused before the ledger was touched');
});

test('the cap default holds, and the env var overrides it', async () => {
  reset();
  assert.equal(chatDailyGenerationCap(), DEFAULT_CHAT_DAILY_GENERATION_CAP);
  process.env.CHAT_DAILY_GENERATION_CAP = '4';
  assert.equal(chatDailyGenerationCap(), 4);
  // Unparseable falls back rather than becoming 0 — a misspelt cap must never
  // read as "no generations allowed" or as "no limit".
  process.env.CHAT_DAILY_GENERATION_CAP = '4.5';
  assert.equal(chatDailyGenerationCap(), DEFAULT_CHAT_DAILY_GENERATION_CAP);

  process.env.CHAT_DAILY_GENERATION_CAP = '9';
  const cap = await readChatCapState(new Date('2026-08-15T09:00:00.000Z'));
  assert.equal(cap.limit, 9);
  assert.equal(cap.remaining, 9);
  assert.equal(cap.amman_day, '2026-08-15');
  assert.equal(cap.env_key, CHAT_CAP_ENV_KEY);
  // Hard rule 12: every quantity above names what produced it.
  assert.ok(cap.source_keys['chat_cap.limit'].includes(CHAT_CAP_ENV_KEY));
  assert.ok(cap.source_keys['chat_cap.used'].length > 0);
});

test('an uncountable window is unknown, never zero — nothing is generated', async () => {
  reset();
  // The fail-closed case: the count came back empty.
  state.counts.concepts = null;

  const result = await runDispatch({
    call: call({ feature: 'report', input: { month: '2026-08' } }),
    quality: 'standard',
    deps: deps(async () => {
      throw new Error('the feature must not run when the cap could not be counted');
    }),
  });

  const payload = payloadOf(result.content);
  assert.equal(payload.refusal, CHAT_CAP_UNKNOWN);
  assert.match(String(payload.note), /never as zero/);
  assert.equal(state.featureRuns, 0);
  assert.equal(opIndex('rpc:mcp_reserve_units'), -1);
});

test('a reservation the ledger refuses fails CLOSED — this is today’s real state', async () => {
  reset();
  // What the live database does until a migration adds CHAT_RESERVING_TOOL to
  // the CHECK constraint on mcp_reservations.tool: the insert raises, the whole
  // function rolls back, and the RPC comes back an error.
  state.rpcError =
    'new row for relation "mcp_reservations" violates check constraint "mcp_reservations_tool_check"';

  const result = await runDispatch({
    call: call({ feature: 'campaign' }),
    quality: 'standard',
    deps: deps(async () => {
      throw new Error('the feature must not run when the units could not be reserved');
    }),
  });

  const payload = payloadOf(result.content);
  assert.equal(payload.refusal, CHAT_CAP_UNKNOWN, 'an untaken reservation is never a taken one');
  // `reason` is CapUnavailableError's own sentence; `detail` is what actually
  // went wrong, and it is carried through rather than swallowed — an operator
  // debugging this needs the constraint name, not a category.
  assert.match(String(payload.detail), /mcp_reservations_tool_check/);
  assert.match(String(payload.detail), new RegExp(CHAT_RESERVING_TOOL));
  assert.match(String(payload.note), /could not be reserved/);
  assert.equal(state.featureRuns, 0, 'and no model call was made');
  assert.equal(unitsHeld(), 0, 'and no units leaked into the window');
});

/* ================================================== the ordering: rule 18 == */

test('the units are RESERVED BEFORE the dispatch fires', async () => {
  reset();
  process.env.CHAT_DAILY_GENERATION_CAP = '10';

  const result = await runDispatch({
    call: call({ feature: 'concepts', input: { count: 2 } }),
    quality: 'standard',
    deps: deps(async (feature) => outcomeFor(feature)),
  });

  assert.ok(result.card, 'the happy path returns a card');

  const reserved = opIndex('rpc:mcp_reserve_units');
  const ran = opIndex('feature:run');

  // Both checked non-negative FIRST. Without this the assertion below would
  // pass vacuously on a run where neither operation ever happened: -1 < -1 is
  // false, but -1 < 0 is true, and either way nothing would have been proven.
  assert.ok(reserved >= 0, 'the reservation RPC was actually issued');
  assert.ok(ran >= 0, 'the feature actually ran');
  assert.ok(
    reserved < ran,
    `the reservation must precede the paid call; log was: ${state.ops.join(' → ')}`,
  );

  // Spend precedes the artefact, so the units are taken for what was ASKED,
  // not for what came back.
  assert.equal(unitsFor({ count: 2 }), 2);
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].units, 2);
  assert.equal(state.reservations[0].tool, CHAT_RESERVING_TOOL);
  assert.equal(state.reservations[0].status, 'spent', 'a completed run keeps its units');
  assert.equal(unitsHeld(), 2);
});

test('N parallel dispatches against a cap of N hand out exactly N units', async () => {
  reset();
  process.env.CHAT_DAILY_GENERATION_CAP = '3';

  const attempts = Array.from({ length: 8 }, () =>
    runDispatch({
      call: call({ feature: 'concepts' }),
      quality: 'standard',
      deps: deps(async (feature) => outcomeFor(feature)),
    }),
  );
  const results = await Promise.all(attempts);

  const granted = results.filter((r) => r.card !== undefined).length;
  assert.equal(granted, 3, 'exactly the cap ran');
  assert.equal(state.featureRuns, 3, 'and the model was reached exactly that many times');
  assert.equal(peakHeld(), 3, 'the counter never rose above the cap');

  for (const result of results) {
    if (result.card !== undefined) continue;
    const payload = payloadOf(result.content);
    assert.equal(payload.refusal, CHAT_CAP_REACHED);
    assert.equal(typeof payload.resets_at, 'string', 'every refusal names the reset instant');
  }
});

test('the same test DETECTS the read-then-act defect it exists to rule out', async () => {
  reset();
  process.env.CHAT_DAILY_GENERATION_CAP = '3';
  // The pre-0005 gate: read the total, yield, act on the stale number.
  state.reserveMode = 'read_then_act';

  await Promise.all(
    Array.from({ length: 8 }, () =>
      runDispatch({
        call: call({ feature: 'concepts' }),
        quality: 'standard',
        deps: deps(async (feature) => outcomeFor(feature)),
      }),
    ),
  );

  assert.ok(
    peakHeld() > 3,
    'a read-then-act gate must OVERSPEND here; if it does not, the assertion above proves nothing',
  );
});

/* =========================================== reconciliation: release or not */

test('a PROVEN-UNSPENT failure returns its units to the window', async () => {
  reset();
  process.env.CHAT_DAILY_GENERATION_CAP = '5';

  // requireEnv throws before any request is built, and nothing in a dispatch can
  // bill before the feature runs — so this failure PROVES nothing was spent.
  assert.equal(provablyUnspent(new MissingEnvError('OPENROUTER_API_KEY')), true);

  const result = await runDispatch({
    call: call({ feature: 'guideline' }),
    quality: 'standard',
    deps: deps(async () => {
      throw new MissingEnvError('OPENROUTER_API_KEY');
    }),
  });

  const payload = payloadOf(result.content);
  assert.equal(payload.refusal, DISPATCH_FAILED);
  assert.equal(payload.units_returned, 1);

  const reservation = payload.reservation as Record<string, unknown>;
  assert.equal(reservation.outcome, 'released');
  assert.equal(reservation.units_released, 1);
  assert.equal(state.reservations[0].status, 'released');
  assert.equal(unitsHeld(), 0, 'the window is whole again');
});

test('an UNPROVABLE failure keeps its units — the units stay consumed', async () => {
  reset();
  process.env.CHAT_DAILY_GENERATION_CAP = '5';

  // A 502 from the provider may have been billed; a 400 from the feature's own
  // input parse may not have been. This dispatcher cannot see which, and
  // "unproven" is the honest status for exactly that.
  assert.equal(provablyUnspent(new HttpError(502, 'OpenRouter returned 502')), false);

  const result = await runDispatch({
    call: call({ feature: 'guideline' }),
    quality: 'standard',
    deps: deps(async () => {
      throw new HttpError(502, 'OpenRouter returned 502');
    }),
  });

  const payload = payloadOf(result.content);
  assert.equal(payload.refusal, DISPATCH_FAILED);
  assert.equal(payload.units_returned, 0);

  const reservation = payload.reservation as Record<string, unknown>;
  assert.equal(reservation.outcome, 'unproven');
  assert.match(String(payload.note), /cannot be proven/);
  assert.equal(state.reservations[0].status, 'unproven');
  assert.equal(unitsHeld(), 1, 'over-counting costs a request; under-counting costs money');
});

test('settling twice cannot refund the same units twice', async () => {
  reset();
  process.env.CHAT_DAILY_GENERATION_CAP = '5';

  await runDispatch({
    call: call({ feature: 'guideline' }),
    quality: 'standard',
    deps: deps(async () => {
      throw new MissingEnvError('OPENROUTER_API_KEY');
    }),
  });
  assert.equal(unitsHeld(), 0);

  const real = defaultDispatchDeps();
  const again = await real.settle(
    {
      id: state.reservations[0].id,
      tool: CHAT_RESERVING_TOOL,
      units: 1,
      amman_day: state.reservations[0].day,
      reserved_after: 0,
    },
    'released',
    'a second settlement of the same reservation',
  );

  assert.equal(again.recorded, 'already_settled');
  assert.equal(again.units_released, 0);
  assert.equal(unitsHeld(), 0, 'and the window did not go negative or gain free units');
});

/* ================================================== rule 17: no deliverable */

test('a dispatch result carries a REFERENCE, never the deliverable', async () => {
  reset();
  process.env.CHAT_DAILY_GENERATION_CAP = '5';

  const secret = 'نصّ المخرج السرّي الذي يجب ألّا يظهر في المحادثة';
  const result = await runDispatch({
    call: call({ feature: 'campaign' }),
    quality: 'standard',
    deps: deps(async (feature) => outcomeFor(feature)),
  });

  assert.ok(result.card, 'a successful dispatch returns a card');

  // The trap is real: the deliverable text exists in the outcome the feature
  // returned, so a dispatcher that read `result` would leak it here.
  assert.equal(outcomeFor('campaign').result !== null, true);
  assert.equal(
    result.content.includes(secret),
    false,
    'the tool result the model reads contains no deliverable text',
  );
  assert.equal(
    JSON.stringify(result.card).includes(secret),
    false,
    'and neither does the card',
  );
  assert.match(result.content, /Do not restate/);

  // What it DOES carry: ids and scalars.
  assert.deepEqual(result.card.ids, ['row-1', 'row-2']);
  assert.equal(result.card.kind, 'dispatch');
  assert.equal(result.card.feature, 'campaign');
  assert.equal(result.card.cap_units, 1);
  // Hard rule 15: an unpriced model is null and says why — never 0.
  assert.equal(result.card.est_usd, null);
  assert.equal(typeof result.card.unpriced_reason, 'string');
});

test('the persisted shapes the real features return are read, and none is invented', () => {
  reset();
  assert.deepEqual(readPersisted({ inserted: [{ id: 'a' }, { id: 'b' }] }), {
    ids: ['a', 'b'],
    shape: 'nested',
  });
  assert.deepEqual(readPersisted({ campaign: { id: 'c1', name: 'x' } }), {
    ids: ['c1'],
    shape: 'nested',
  });
  assert.deepEqual(readPersisted({ report: { id: 'r1' } }), { ids: ['r1'], shape: 'nested' });
  assert.deepEqual(readPersisted({ id: 'one' }), { ids: ['one'], shape: 'row' });
  assert.deepEqual(readPersisted([{ id: 'a' }]), { ids: ['a'], shape: 'rows' });
  // `gaps` persists counts and no rows. "none" is a fact about the read.
  assert.deepEqual(readPersisted({ gaps: 3, grounded: 2 }), { ids: [], shape: 'none' });
  assert.deepEqual(readPersisted(null), { ids: [], shape: 'none' });
});

/* ================================================= refusals that cost nothing */

test('an unknown feature is refused before the cap is even read', async () => {
  reset();

  for (const args of [{ feature: 'strategist' }, { feature: 'gaps' }, { feature: 'anything' }]) {
    const result = await runDispatch({
      call: call(args),
      quality: 'standard',
      deps: deps(async () => {
        throw new Error('nothing may run for an unknown feature');
      }),
    });
    const payload = payloadOf(result.content);
    assert.equal(payload.refusal, DISPATCH_INVALID, `"${args.feature}" is not dispatchable`);
    assert.match(String(payload.note), /no cap unit was taken/);
  }

  assert.equal(state.ops.length, 0, 'not one database call was made');
});

test('unparseable arguments are a case, not a crash', async () => {
  reset();
  const result = await runDispatch({
    call: { id: 'call_1', name: CHAT_DISPATCH_TOOL, arguments: '{"feature": "conce' },
    quality: 'standard',
    deps: deps(async () => {
      throw new Error('nothing may run');
    }),
  });
  const payload = payloadOf(result.content);
  assert.equal(payload.refusal, DISPATCH_INVALID);
  assert.match(String(payload.reason), /not valid JSON/);
  assert.equal(state.ops.length, 0);
});
