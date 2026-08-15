import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrandRow, DigestRow } from '../src/lib/types/db.ts';

/* =============================================================== what this ==
 * Pillar C is a door onto the studio that is not the browser. Three properties
 * decide whether that door is safe, and all three are provable here with no
 * model key and no network:
 *
 *   1. IT IS SHUT BY DEFAULT. No token, a wrong token, or an unconfigured
 *      server all produce 401. An unset secret is a closed door, never an open
 *      one — and that branch is tested explicitly, because it is the one a
 *      "convenient" future edit is most likely to invert.
 *   2. IT IS EXACTLY FOUR TOOLS WIDE. tools/list is asserted against the
 *      registry tuple, so a fifth tool cannot appear without this test failing.
 *   3. IT CANNOT SPEND. Hard rule 14 is enforced by the import graph, so it is
 *      tested by WALKING the real import graph from the route and the tool
 *      module and asserting nothing under src/lib/ingest/ is reachable. That is
 *      a claim about the code as it is, not about anyone's intentions.
 *
 * Plus the cap: refused BEFORE any model call, with a shaped payload that names
 * the limit and the instant it resets — and refused fail-closed when the count
 * itself cannot be read, because an uncounted window read as zero is an open
 * spending door.
 *
 * ---------------------------------------------------------------------------
 * AND THE RESERVATION, which is the cap's actual bound.
 *
 * Counting artefacts cannot bound spend, because the spend happens first. The
 * tools therefore RESERVE units atomically before the first call that can bill
 * and reconcile afterwards. What is asserted here:
 *   - the reservation is taken BEFORE the paid step, proven by the ORDER of the
 *     real operations the tools perform, not by reading the source;
 *   - a failure that provably billed nothing releases its units;
 *   - a failure that cannot prove it billed nothing does NOT release them;
 *   - N parallel calls against a cap of N hand out exactly N units.
 *
 * WHAT THE PARALLEL TEST CAN AND CANNOT PROVE. node is single-threaded and the
 * database here is a fake, so this file cannot prove Postgres's isolation. It
 * proves the half that lives in TypeScript: the tools take units through ONE
 * round trip and never a read-then-act pair, and they honour a refusal. To show
 * the test can actually detect the defect, the same scenario is run against a
 * fake that models the OLD read-then-act gate and asserted to OVERSPEND.
 * Postgres's half is proven by the statement in
 * supabase/migrations/0005_mcp_reservations.sql, run against the real database
 * with genuinely concurrent connections.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PROVEN HERE, TODAY, WITH NO MODEL KEY:
 *   - every auth branch, including the unconfigured-server branch;
 *   - the JSON-RPC surface: initialize, ping, tools/list, tools/call, unknown
 *     method, unknown tool, bad JSON, batched arrays, notifications;
 *   - the real Law running inside check_compliance against the real brand
 *     fixture, and being returned in full when the Judge is refused;
 *   - both cap refusals, with no model call made — asserted by a transport
 *     stub that throws if it is ever reached;
 *   - the Amman day window: resets_at really is local midnight;
 *   - get_brand_facts and get_latest_digest end to end.
 *
 * WHAT IS NOT PROVEN HERE:
 *   the happy path of generate_concepts and of the check_compliance Judge leg.
 *   Both need a real model, and OPENROUTER_API_KEY / ANTHROPIC_API_KEY exist in
 *   .env.local as empty placeholders, which optionalEnv() reads as absent. The
 *   code around them is exercised — argument validation, the cap gate, the
 *   no-key refusal shape — but no model has ruled on anything. Written, not
 *   observed.
 * ========================================================================= */

/* ---------------------------------------------------------------- loader --
 * Same approach as tests/needs-human.test.ts: app modules import through the
 * `@/*` alias, which node does not resolve, and a few reach into next/server or
 * Supabase. These hooks teach this process the one alias rule from tsconfig
 * (`@/*` -> `./src/*`), resolve extensionless relative imports, and swap three
 * modules for stubs.
 *
 * `@/lib/env` is NOT stubbed. The env layer is half of what is under test here
 * — "unset means closed" is an env-reading behaviour — so the real module runs
 * and the tests move process.env instead.
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
    '  if (!factory) throw new Error("mcp.test.ts: no fake database installed.");' +
    '  return factory();' +
    '}',
  [AGENT_STUB]:
    'let handler = null;' +
    'export function __setAgentHandler(fn) { handler = fn; }' +
    'export async function runAgentJson(args) {' +
    '  if (!handler) throw new Error("mcp.test.ts: no fake agent installed.");' +
    '  return handler(args);' +
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

/* ------------------------------------------------------------- fake data -- */

/** The real sampled palette, as recorded in tests/law.test.ts. */
const SWATCHES = {
  turquoise: '#48C0C0',
  turquoise_light: '#78D8D8',
  mint: '#60D8C0',
  sky: '#60C0D8',
  ink: '#181818',
  charcoal: '#303030',
  paper: '#F0F0F0',
  ember: '#D84800',
};

/** Real captions from the account, trimmed. Engagement unknown here, so null. */
const VOICE = [
  'الموضوع مش نكد 😅',
  '#مش بالعناد … موده ورحمه ،، لتسكنوا اليها …',
  'أمر ما لقيت من ألم الهوى …!',
  'اخطر وأصعب من الخيانه الظاهره …',
  'البرّ هين … تكسب الناس باللين …',
];

const BRAND: BrandRow = {
  id: 1,
  facts: [
    {
      key: 'city',
      value: 'Amman',
      source: 'tests/mcp.test.ts fixture',
      label_en: 'City',
      label_ar: 'المدينة',
    },
  ],
  voice_examples: VOICE.map((text) => ({ text, source_url: null, engagement: null })),
  knowledge: [],
  assets: [],
  palette: { swatches: SWATCHES, note: 'Sampled from published creatives.' },
  typography: null,
  audience_notes: 'ملاحظات الجمهور غير مكتملة.',
  status: 'live',
  updated_at: new Date(0).toISOString(),
};

const DIGEST: DigestRow = {
  id: '00000000-0000-4000-8000-000000000001',
  period_from: '2026-08-01',
  period_to: '2026-08-14',
  status: 'quiet',
  payload: {
    period: { from: '2026-08-01', to: '2026-08-14' },
    status: 'quiet',
    headline_ar: 'لا حركة تُذكر في هذه الفترة.',
    deltas: [],
    wins: [],
    concerns: [],
    corrections: [],
    decisions: [],
    actions: [],
    needs_human: false,
    client_digest_ar: 'أسبوع هادئ.',
    operator_notes: [],
  },
  client_digest_ar: 'أسبوع هادئ.',
  sent: false,
  created_at: new Date(0).toISOString(),
};

/* ------------------------------------------------------------- fake tables -- */

interface FakeReservation {
  id: string;
  day: string;
  tool: string;
  units: number;
  status: 'reserved' | 'spent' | 'unproven' | 'released';
  note: string | null;
}

interface FakeState {
  /** Per-table `count: 'exact'` answers. null models a count that came back
   *  empty — the fail-closed case. */
  counts: Record<string, number | null>;
  rows: Record<string, unknown[]>;
  inserts: { table: string; rows: unknown }[];
  /** Rows of the fake `mcp_reservations`. */
  reservations: FakeReservation[];
  /** The fake `mcp_cap_days.reserved_units`, per Amman day. */
  reservedByDay: Map<string, number>;
  /** The highest value that counter ever held, per day. The safety property a
   *  reservation exists to have is about the PEAK, not the final value. */
  peakByDay: Map<string, number>;
  /** Whether the fake reserve is atomic or models the pre-0005 defect. */
  reserveMode: 'atomic' | 'read_then_act';
  /** Every RPC the module made, with its arguments. */
  rpcs: { fn: string; args: Record<string, unknown> }[];
  /** Every database touch and model call, IN ORDER. This is what makes
   *  "the reservation came first" a fact about execution rather than a reading
   *  of the source. */
  ops: string[];
}

function freshState(): FakeState {
  return {
    counts: { concepts: 0, compliance_checks: 0 },
    rows: {
      brand: [BRAND],
      digests: [DIGEST],
      canon_chunks: [],
      snapshots: [],
      posts: [],
      pillars: [],
      concepts: [],
    },
    inserts: [],
    reservations: [],
    reservedByDay: new Map<string, number>(),
    peakByDay: new Map<string, number>(),
    reserveMode: 'atomic',
    rpcs: [],
    ops: [],
  };
}

let state = freshState();

interface Settled {
  then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown): Promise<unknown>;
}

interface FakeQuery extends Settled {
  select(columns?: unknown, options?: unknown): FakeQuery;
  eq(...args: unknown[]): FakeQuery;
  gte(...args: unknown[]): FakeQuery;
  order(...args: unknown[]): FakeQuery;
  limit(...args: unknown[]): FakeQuery;
  overlaps(...args: unknown[]): FakeQuery;
  insert(rows: unknown): FakeQuery;
  maybeSingle(): Settled;
  single(): Settled;
}

function settled(value: unknown): Settled {
  return { then: (onFulfilled, onRejected) => Promise.resolve(value).then(onFulfilled, onRejected) };
}

function isCountRequest(options: unknown): boolean {
  return typeof options === 'object' && options !== null && 'count' in options;
}

/**
 * Enough of a PostgREST builder for the reads and the one insert this endpoint
 * performs. Filters are no-ops: `.gte('created_at', …)` is Postgres's job, and
 * faking it would only be testing the fake. What the fake DOES model faithfully
 * is the shape of a `head: true, count: 'exact'` reply, because the fail-closed
 * branch turns on `count` being null rather than a number.
 */
function query(table: string, rows: unknown[]): FakeQuery {
  let counting = false;

  const q: FakeQuery = {
    select: (_columns, options) => {
      if (isCountRequest(options)) counting = true;
      return q;
    },
    eq: () => q,
    gte: () => q,
    order: () => q,
    limit: () => q,
    overlaps: () => q,
    insert: (inserted) => {
      state.inserts.push({ table, rows: inserted });
      const list = Array.isArray(inserted) ? inserted : [inserted];
      return query(
        table,
        list.map((row, i) =>
          typeof row === 'object' && row !== null
            ? { ...row, id: `fake-${table}-${i}`, created_at: new Date(0).toISOString() }
            : row,
        ),
      );
    },
    maybeSingle: () => settled({ data: rows.length > 0 ? rows[0] : null, error: null }),
    single: () => settled({ data: rows.length > 0 ? rows[0] : null, error: null }),
    then: (onFulfilled, onRejected) =>
      Promise.resolve(
        counting
          ? {
              data: null,
              // NOT `?? 0`: a configured `null` is the fail-closed case under
              // test, and collapsing it to zero here would quietly make that
              // test assert the opposite of what it says.
              count: table in state.counts ? state.counts[table] : 0,
              error: null,
            }
          : { data: rows, error: null },
      ).then(onFulfilled, onRejected),
  };

  return q;
}

/* ------------------------------------------------- the fake reservation store --
 *
 * Stands in for supabase/migrations/0005_mcp_reservations.sql: the same
 * predicate, the same return shape, the same settle-once guard.
 *
 * `atomic` mode decides and writes in ONE synchronous run with no await between
 * them — this harness's stand-in for one statement under a row lock.
 * `read_then_act` mode reads the total, yields, and acts on the stale number.
 * That second mode is not a convenience: it is the defect, kept executable so
 * the parallel test below can be shown to detect it rather than merely pass.
 * ---------------------------------------------------------------------------- */

interface RpcReply {
  data: unknown;
  error: { message: string } | null;
}

const SETTLE_STATUSES = ['spent', 'unproven', 'released'] as const;
type SettleStatus = (typeof SETTLE_STATUSES)[number];

function isSettleStatus(value: string): value is SettleStatus {
  return (SETTLE_STATUSES as readonly string[]).includes(value);
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
    data: [
      {
        granted: true,
        reservation_id: id,
        units_reserved_today: state.reservedByDay.get(day) ?? units,
      },
    ],
    error: null,
  };
}

function refusedReply(day: string): RpcReply {
  return {
    data: [
      {
        granted: false,
        reservation_id: null,
        units_reserved_today: state.reservedByDay.get(day) ?? 0,
      },
    ],
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

  if (!isSettleStatus(status)) {
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
  state.rpcs.push({ fn, args });

  // Latency BEFORE the decision, so parallel callers genuinely interleave here
  // instead of each running to completion in its own turn.
  await new Promise((resolve) => setTimeout(resolve, 1));

  if (fn === 'mcp_reserve_units') return fakeReserve(args);
  if (fn === 'mcp_settle_reservation') return fakeSettle(args);
  return { data: null, error: { message: `mcp.test.ts: no fake for rpc "${fn}"` } };
}

function unitsHeld(): number {
  let total = 0;
  for (const held of state.reservedByDay.values()) total += held;
  return total;
}

function peakHeld(): number {
  let peak = 0;
  for (const held of state.peakByDay.values()) peak = Math.max(peak, held);
  return peak;
}

interface DbStubModule {
  __setDb(factory: () => unknown): void;
}

interface FakeAgentArgs {
  userMessage: string;
  system?: string;
  schema: { parse(value: unknown): unknown };
}

interface AgentStubModule {
  __setAgentHandler(handler: (args: FakeAgentArgs) => Promise<unknown>): void;
}

const dbStub = (await import('@/lib/supabase/admin')) as unknown as DbStubModule;
const agentStub = (await import('@/lib/agent/client')) as unknown as AgentStubModule;

dbStub.__setDb(() => ({
  from: (table: string) => {
    state.ops.push(`from:${table}`);
    return query(table, state.rows[table] ?? []);
  },
  rpc: (fn: string, args: Record<string, unknown>) => fakeRpc(fn, args),
}));

/* --------------------------------------------------------- modules under test */

const { MissingEnvError } = await import('../src/lib/env.ts');

/**
 * Every model call is a test failure unless a test says otherwise. The cap
 * tests below rest on "no model was called", and a stub that quietly returned
 * something would let that assertion pass while the spend happened.
 *
 * It throws the real MissingEnvError, which is also this repo's honest state:
 * no provider key is configured, so this is what a run does today.
 */
let modelCalls = 0;

/**
 * What the model call fails with. The default is this repo's honest state — no
 * provider key — and a test that needs a failure which MAY have been billed
 * (rather than one refused locally) replaces it.
 */
let agentFailure: () => Error = () => new MissingEnvError('OPENROUTER_API_KEY');

agentStub.__setAgentHandler(async () => {
  modelCalls += 1;
  // Recorded in the same ordered log as the database touches, so "the units
  // were reserved before the model was called" is checkable.
  state.ops.push('agent:call');
  throw agentFailure();
});

const {
  MCP_TOOL_NAMES,
  DEFAULT_DAILY_GENERATION_CAP,
  ammanDayStart,
  ammanNextDayStart,
  constantTimeEquals,
  dailyGenerationCap,
  handleMcpRequest,
  listTools,
} = await import('../src/lib/mcp/tools.ts');
const route = await import('../src/app/api/mcp/route.ts');

/* ------------------------------------------------------------------ helpers -- */

const TOKEN = 'tq-mcp-test-token-6f3a91c4';

function reset(): void {
  state = freshState();
  modelCalls = 0;
  agentFailure = () => new MissingEnvError('OPENROUTER_API_KEY');
  process.env.MCP_ACCESS_TOKEN = TOKEN;
  delete process.env.MCP_DAILY_GENERATION_CAP;
}

/** The reservation block every spending tool now returns. */
interface ReservationReport {
  id: string;
  tool: string;
  units: number;
  amman_day: string;
  reserved_after: number;
  outcome: string;
  reason: string;
  recorded: string | null;
  units_released: number;
  settlement_error: string | null;
}

function reservationOf(payload: Record<string, unknown>): ReservationReport {
  const raw = payload.reservation;
  assert.ok(typeof raw === 'object' && raw !== null, 'the tool reports its reservation');
  return raw as ReservationReport;
}

/** The index of an operation in the ordered log, or -1. */
function opIndex(op: string): number {
  return state.ops.indexOf(op);
}

function post(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request('https://studio.example/api/mcp', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function rpc(method: string, params?: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) };
}

interface RpcEnvelope {
  jsonrpc?: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function json(response: Response): Promise<RpcEnvelope> {
  return (await response.json()) as RpcEnvelope;
}

interface ToolCallResult {
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

/** The tool payload out of a tools/call envelope, with the shape checked. */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  const response = await handleMcpRequest(post(rpc('tools/call', { name, arguments: args }), TOKEN));
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.ok(body.result, `tools/call ${name} returned an error envelope: ${JSON.stringify(body.error)}`);
  const result = body.result as unknown as ToolCallResult;
  // Every tool answers in the same envelope, and the text half is the JSON
  // half — a caller reading either gets the same numbers.
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result;
}

/* ==================================================================== auth == */

test('no Authorization header is 401, and no tool runs', async () => {
  reset();
  const response = await handleMcpRequest(post(rpc('tools/list')));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');

  const body = await json(response);
  assert.ok(body.error, 'a 401 still answers in the JSON-RPC error shape');
  assert.match(body.error.message, /Missing Authorization header/);
  assert.equal(body.result, undefined, 'no tools are listed to an unauthenticated caller');
  assert.equal(modelCalls, 0);
});

test('a wrong token is 401 and the response reveals nothing about the real one', async () => {
  reset();
  const response = await handleMcpRequest(post(rpc('tools/list'), 'not-the-token'));
  assert.equal(response.status, 401);

  const raw = JSON.stringify(await json(response));
  assert.match(raw, /Invalid MCP access token/);
  // The whole point. Neither the real token nor any prefix of it appears
  // anywhere in what we send back — not in the message, not in a hint, not in
  // a "did you mean" comparison.
  assert.equal(raw.includes(TOKEN), false);
  assert.equal(raw.includes(TOKEN.slice(0, 6)), false);
  assert.equal(raw.includes('not-the-token'), false, 'nor the presented one');
});

test('a token of the right length but wrong bytes is still 401', async () => {
  reset();
  const sameLength = 'x'.repeat(TOKEN.length);
  assert.equal(sameLength.length, TOKEN.length);
  const response = await handleMcpRequest(post(rpc('tools/list'), sameLength));
  assert.equal(response.status, 401);
});

test('a malformed Authorization scheme is 401, not a comparison', async () => {
  reset();
  const request = new Request('https://studio.example/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${TOKEN}` },
    body: JSON.stringify(rpc('tools/list')),
  });
  const response = await handleMcpRequest(request);
  assert.equal(response.status, 401);
  assert.match((await json(response)).error?.message ?? '', /Bearer <token>/);
});

test('an UNSET MCP_ACCESS_TOKEN closes the door rather than opening it', async () => {
  reset();
  delete process.env.MCP_ACCESS_TOKEN;

  // Every plausible way in, including the empty token an "unset means empty"
  // bug would let through.
  for (const attempt of [undefined, '', TOKEN, 'anything']) {
    const response = await handleMcpRequest(post(rpc('tools/list'), attempt));
    assert.equal(response.status, 401, `token ${JSON.stringify(attempt)} must not be accepted`);
    assert.match((await json(response)).error?.message ?? '', /no MCP access token bound/);
  }
  assert.equal(modelCalls, 0);
});

test('a blank MCP_ACCESS_TOKEN is unset, not a valid empty secret', async () => {
  reset();
  // optionalEnv() treats whitespace as absent; the endpoint must inherit that
  // rather than compare against "   ".
  process.env.MCP_ACCESS_TOKEN = '   ';
  const response = await handleMcpRequest(post(rpc('tools/list'), '   '));
  assert.equal(response.status, 401);
  assert.match((await json(response)).error?.message ?? '', /no MCP access token bound/);
});

test('constantTimeEquals: equal, unequal, and length-mismatched', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abd'), false);
  assert.equal(constantTimeEquals('abc', 'abcd'), false);
  assert.equal(constantTimeEquals('', ''), true);
  assert.equal(constantTimeEquals('', 'a'), false);
  // Multi-byte input: the comparison is over UTF-8 bytes, so two different
  // Arabic strings of equal character length are still distinguished.
  assert.equal(constantTimeEquals('مرحبا', 'مرحبا'), true);
  assert.equal(constantTimeEquals('مرحبا', 'مرحبأ'), false);
});

/* =========================================================== the four tools == */

test('tools/list answers with exactly four tools, and they are the registry', async () => {
  reset();
  const response = await handleMcpRequest(post(rpc('tools/list'), TOKEN));
  assert.equal(response.status, 200);

  const body = await json(response);
  assert.ok(body.result);
  const tools = body.result.tools as { name: string }[] | undefined;
  assert.ok(tools, 'tools/list returns a tools array');

  assert.equal(tools.length, 4, 'the v1 surface is deliberately four tools wide');
  assert.equal(MCP_TOOL_NAMES.length, 4);

  const names = tools.map((t) => t.name);
  assert.deepEqual(names, [...MCP_TOOL_NAMES]);
  assert.deepEqual(names, [
    'check_compliance',
    'generate_concepts',
    'get_brand_facts',
    'get_latest_digest',
  ]);
  // No duplicates hiding a fifth behind a repeated name.
  assert.equal(new Set(names).size, 4);
});

test('every tool description carries the house standard', () => {
  for (const tool of listTools()) {
    const description = tool.description;
    const name = tool.name;
    assert.equal(typeof description, 'string');
    assert.ok(typeof name === 'string');
    const text = String(description);

    assert.match(text, /WHEN TO USE IT/, `${String(name)} says when to use it`);
    assert.match(text, /WHEN NOT TO USE IT/, `${String(name)} says when NOT to use it`);
    assert.match(text, /PARAMETERS/, `${String(name)} documents its parameters`);
    assert.match(text, /REFUSAL SHAPES?/, `${String(name)} documents its refusal shapes`);
    assert.match(text, /SIDE EFFECTS/, `${String(name)} states its side effects`);
    // Long enough to have actually said something. 600 is a floor, not a target.
    assert.ok(text.length > 600, `${String(name)} description is too thin to prevent misuse`);
  }
});

test('no tool input schema lets a caller name a target to call', () => {
  // Hard rule 14, third mechanism: a caller can pick a verb and fill in
  // scalars, but cannot point the server at anything.
  const forbidden = /\b(url|uri|endpoint|host|actor|webhook|handle|profile|path|feature|command)\b/i;

  for (const tool of listTools()) {
    const schema = tool.inputSchema;
    assert.ok(typeof schema === 'object' && schema !== null);
    const shape = schema as { type?: unknown; properties?: unknown; additionalProperties?: unknown };
    assert.equal(shape.type, 'object');
    assert.equal(shape.additionalProperties, false, `${String(tool.name)} rejects unknown properties`);

    const properties = shape.properties;
    assert.ok(typeof properties === 'object' && properties !== null);
    for (const key of Object.keys(properties)) {
      assert.equal(forbidden.test(key), false, `${String(tool.name)}.${key} names a target`);
    }
  }
});

test('an unknown tool name is refused by name, not resolved', async () => {
  reset();
  for (const name of ['run_scrape', 'refresh', 'constructor', '__proto__', 'toString']) {
    const response = await handleMcpRequest(post(rpc('tools/call', { name, arguments: {} }), TOKEN));
    const body = await json(response);
    assert.ok(body.error, `"${name}" must not resolve to anything`);
    assert.equal(body.error.code, -32601);
    assert.match(body.error.message, /exactly 4/);
  }
  assert.equal(modelCalls, 0);
});

/* =============================================================== JSON-RPC == */

test('initialize negotiates a protocol version and advertises tools', async () => {
  reset();
  const known = await json(
    await handleMcpRequest(post(rpc('initialize', { protocolVersion: '2025-03-26' }), TOKEN)),
  );
  assert.equal(known.result?.protocolVersion, '2025-03-26', 'a supported version is honoured');

  const unknown = await json(
    await handleMcpRequest(post(rpc('initialize', { protocolVersion: '1999-01-01' }), TOKEN)),
  );
  // Not echoed back: claiming a version we do not speak is a lie about
  // capability.
  assert.notEqual(unknown.result?.protocolVersion, '1999-01-01');
  assert.equal(unknown.result?.capabilities !== undefined, true);
});

test('ping, bad JSON, batched arrays and unknown methods each answer in shape', async () => {
  reset();

  assert.deepEqual((await json(await handleMcpRequest(post(rpc('ping'), TOKEN)))).result, {});

  const parseError = await handleMcpRequest(post('{not json', TOKEN));
  assert.equal(parseError.status, 400);
  assert.equal((await json(parseError)).error?.code, -32700);

  const batched = await handleMcpRequest(post([rpc('ping'), rpc('ping')], TOKEN));
  assert.equal(batched.status, 400);
  const batchedBody = await json(batched);
  assert.equal(batchedBody.error?.code, -32600);
  assert.match(batchedBody.error?.message ?? '', /Batched/);

  const unknownMethod = await handleMcpRequest(post(rpc('resources/list'), TOKEN));
  assert.equal((await json(unknownMethod)).error?.code, -32601);

  const notification = await handleMcpRequest(
    post({ jsonrpc: '2.0', method: 'notifications/initialized' }, TOKEN),
  );
  assert.equal(notification.status, 202);

  assert.equal(modelCalls, 0);
});

test('GET is answered with an explicit 405 rather than a framework error', async () => {
  const response = route.GET();
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
});

test('the route module is a pass-through to the tested handler', async () => {
  reset();
  const viaRoute = await route.POST(post(rpc('tools/list'), TOKEN));
  const body = await json(viaRoute);
  assert.equal(viaRoute.status, 200);
  const tools = body.result?.tools as unknown[] | undefined;
  assert.ok(tools);
  assert.equal(tools.length, 4);
});

/* ============================================================== the day cap == */

test('the cap default is conservative and the env var overrides it', () => {
  reset();
  assert.equal(dailyGenerationCap(), DEFAULT_DAILY_GENERATION_CAP);

  process.env.MCP_DAILY_GENERATION_CAP = '25';
  assert.equal(dailyGenerationCap(), 25);

  // A value that is set but not a positive integer falls back rather than
  // becoming 0 — a cap of 0 would silently disable the tool, and a negative one
  // is not an intent anybody has.
  for (const bad of ['0', '-3', '2.5', 'ten', '']) {
    process.env.MCP_DAILY_GENERATION_CAP = bad;
    assert.equal(dailyGenerationCap(), DEFAULT_DAILY_GENERATION_CAP, `"${bad}" must not become a cap`);
  }
});

test('the cap window really is the Amman day', () => {
  const now = new Date();
  const start = ammanDayStart(now);
  const next = ammanNextDayStart(now);

  assert.ok(start.getTime() <= now.getTime(), 'the window opened at or before now');
  assert.ok(next.getTime() > now.getTime(), 'the window has not closed yet');

  const clock = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Amman',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const at = (d: Date): string => {
    const parts = clock.formatToParts(d);
    const read = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? '';
    return `${read('hour')}:${read('minute')}:${read('second')}`;
  };

  // Both boundaries are local midnight in Amman — not UTC midnight, and not an
  // assumed +03:00 offset.
  assert.equal(at(start), '00:00:00');
  assert.equal(at(next), '00:00:00');

  const span = next.getTime() - start.getTime();
  assert.ok(span >= 23 * 3_600_000 && span <= 25 * 3_600_000, 'one civil day long');
});

test('over cap: generate_concepts is refused BEFORE any model call, in a shaped payload', async () => {
  reset();
  process.env.MCP_DAILY_GENERATION_CAP = '4';
  // Three concepts and one compliance check already recorded today. Both
  // tables count, which is what makes the ceiling a real spend ceiling.
  state.counts.concepts = 3;
  state.counts.compliance_checks = 1;

  const result = await callTool('generate_concepts', { count: 3 });
  const payload = result.structuredContent;

  // A refusal is a correct answer, not a protocol error — a caller that
  // retries on isError would hammer a wall.
  assert.equal(result.isError, undefined);
  assert.equal(payload.refusal, 'daily_generation_cap_reached');
  assert.equal(payload.requested, 3);

  const cap = payload.cap as Record<string, unknown>;
  assert.equal(cap.limit, 4, 'the refusal names the cap');
  assert.equal(cap.used, 4);
  assert.equal(cap.remaining, 0);
  assert.equal(cap.env_key, 'MCP_DAILY_GENERATION_CAP', 'and names the var that moves it');
  assert.deepEqual(cap.counted, { concepts: 3, compliance_checks: 1 });
  assert.equal(cap.time_zone, 'Asia/Amman');

  // And when it resets — an instant, not a vague sentence.
  const resetsAt = new Date(String(cap.resets_at));
  assert.equal(Number.isNaN(resetsAt.getTime()), false);
  assert.ok(resetsAt.getTime() > Date.now());
  assert.match(String(cap.resets_on), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(String(payload.reason), /daily cap of 4/);
  const nextSteps = payload.what_you_can_do as string[] | undefined;
  assert.ok(nextSteps && nextSteps.length > 0, 'the refusal is actionable, not just a "no"');
  assert.ok(nextSteps.some((s) => s.includes(String(cap.resets_at))));

  // The whole point of checking before the call.
  assert.equal(modelCalls, 0, 'nothing was spent to discover the cap was reached');
  assert.equal(state.inserts.length, 0, 'and nothing was written');
});

test('the cap is checked against what the call would ADD, not merely against zero', async () => {
  reset();
  process.env.MCP_DAILY_GENERATION_CAP = '5';
  state.counts.concepts = 3;
  state.counts.compliance_checks = 0;

  // 3 used, 5 allowed: room for 2. Asking for 3 is refused up front rather
  // than half-served.
  const refused = await callTool('generate_concepts', { count: 3 });
  assert.equal(refused.structuredContent.refusal, 'daily_generation_cap_reached');
  assert.equal((refused.structuredContent.cap as Record<string, unknown>).remaining, 2);
  assert.equal(modelCalls, 0);

  // Asking for 2 passes the gate and reaches the model — which in this process
  // has no key, so it comes back as the no-key refusal, not as a cap refusal.
  const allowed = await callTool('generate_concepts', { count: 2 });
  assert.equal(allowed.structuredContent.refusal, 'model_unavailable');
  assert.equal(modelCalls, 1, 'the gate opened');
});

test('a cap that cannot be counted is fail-closed, never read as zero', async () => {
  reset();
  process.env.MCP_DAILY_GENERATION_CAP = '10';
  // The read came back with no count. Treating that as "0 used" would open the
  // door precisely when the guard is broken.
  state.counts.concepts = null;

  const result = await callTool('generate_concepts', { count: 1 });
  assert.equal(result.structuredContent.refusal, 'daily_generation_cap_unknown');
  assert.equal(result.isError, true);
  assert.match(String(result.structuredContent.note), /never as zero/);
  assert.equal(modelCalls, 0);
  assert.equal(state.inserts.length, 0);
});

test('invalid arguments are refused before the cap is even read', async () => {
  reset();
  for (const args of [{ count: 0 }, { count: 9 }, { count: 2.5 }, { account: 'nobody' }]) {
    const result = await callTool('generate_concepts', args);
    assert.equal(result.structuredContent.refusal, 'invalid_arguments');
    assert.equal(result.isError, true);
    assert.match(String(result.structuredContent.note), /nothing was counted/);
  }
  assert.equal(modelCalls, 0);
});

/* ================================================= tools that need no model == */

test('check_compliance returns the full Law verdict when the Judge is capped out', async () => {
  reset();
  process.env.MCP_DAILY_GENERATION_CAP = '1';
  state.counts.concepts = 1;

  // The demo's off-brand draft: a hex value in copy, and a metric the brand's
  // data does not contain.
  const result = await callTool('check_compliance', {
    text: 'Use #FF0000 as the accent and promise 340% more engagement.',
    subject: 'caption',
  });
  const payload = result.structuredContent;

  const judge = payload.judge as Record<string, unknown>;
  assert.equal(judge.status, 'refused_daily_cap');
  assert.equal(judge.refusal, 'daily_generation_cap_reached');
  assert.equal((judge.cap as Record<string, unknown>).limit, 1);

  // The deterministic half is complete regardless. This is the property the
  // failing leg of the demo rests on.
  const law = payload.law as Record<string, unknown>;
  assert.equal(law.passed, false);
  assert.ok(Number(law.violation_count) > 0, 'the Law caught the hex and/or the invented figure');
  const results = law.results as { check: string; passed: boolean }[];
  assert.ok(results.some((r) => r.check === 'palette-claims' && !r.passed));

  assert.equal(payload.passed, false);
  assert.equal(payload.needs_human, true, 'no ruling is not a pass');
  assert.equal(payload.recorded, null, 'nothing was recorded, because nothing was spent');
  assert.equal(modelCalls, 0);
  assert.equal(state.inserts.length, 0);
});

/**
 * WHAT THIS TEST USED TO ASSERT, AND WHY THAT WAS WRONG.
 *
 * It was called "check_compliance with no model key records nothing and
 * consumes no cap unit", and it asserted exactly that: no ledger row, and no
 * cap movement. It passed. It was also a description of the hole.
 *
 * By the time the Judge throws MissingEnvError, check_compliance has already
 * called retrieveCanon(), which embeds the query — a BILLED request, on a
 * different provider key from the one the Judge wanted. The old code read the
 * Judge's `spent: false` as a statement about the whole request, wrote no row,
 * and moved no counter. So with a judge key absent and an embedding key
 * present, every call bought one embedding and cost the caller nothing: the
 * cap never moved, and the loop could run forever.
 *
 * A test that passes on a hole is worse than no test, because it is cited as
 * evidence the hole is not there. The correct behaviour, asserted below: the
 * unit is taken BEFORE the retrieval, and it is NOT given back, because
 * nothing in this request can prove the embedding was not billed.
 */
test('check_compliance with no model key still CONSUMES its unit, because the Canon embedding may have been billed', async () => {
  reset();
  const result = await callTool('check_compliance', { text: 'نص عربي بسيط للتجربة.' });
  const payload = result.structuredContent;

  const judge = payload.judge as Record<string, unknown>;
  assert.equal(judge.status, 'unavailable');
  assert.equal(judge.verdict, null);
  assert.match(String((judge.unavailable as Record<string, unknown>).reason), /No model provider key/);

  assert.equal(modelCalls, 1, 'the Judge was attempted');
  // The ruling ledger still records nothing: no Judge ran, so there is no
  // verdict to record. That part was always right.
  assert.equal(payload.recorded, null);
  assert.equal(state.inserts.length, 0);
  assert.equal(payload.needs_human, true);

  // What changed. The unit was taken, and it stayed taken.
  const reservation = reservationOf(payload);
  assert.equal(reservation.units, 1);
  assert.equal(reservation.outcome, 'unproven', 'not "released" — nothing proves the embedding was free');
  assert.equal(reservation.units_released, 0);
  assert.equal(reservation.settlement_error, null);
  assert.match(reservation.reason, /earlier step/);
  assert.equal(unitsHeld(), 1, 'the window really is one unit poorer');

  // And the reason is named on the row, so an operator reading the ledger sees
  // WHY the unit went rather than only that it did.
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].status, 'unproven');
  assert.match(String(state.reservations[0].note), /canon retrieval/i);
});

/* ================================================== the atomic reservation == */

test('the unit is reserved BEFORE the Canon embedding, not after the ruling', async () => {
  reset();
  await callTool('check_compliance', { text: 'نص عربي بسيط للتجربة.' });

  const reserved = opIndex('rpc:mcp_reserve_units');
  const canon = opIndex('from:canon_chunks');

  // Both must have happened, or the ordering claim would be vacuous — the same
  // sanity check the import walker does before its negative assertion.
  assert.ok(reserved >= 0, 'a reservation was taken');
  assert.ok(canon >= 0, 'Canon was retrieved, so there was something to be early to');
  assert.ok(
    reserved < canon,
    `the reservation must precede the embedding; ops were: ${state.ops.join(' -> ')}`,
  );

  // retrieveCanon -> embed() is the billed step. The reservation is also ahead
  // of the model call itself, which is the weaker of the two orderings.
  const agent = opIndex('agent:call');
  assert.ok(agent >= 0);
  assert.ok(reserved < agent);

  // One round trip decided it. A read followed by a write is the bug, not the
  // fix, so there is exactly one reserve call per tool call.
  const reserves = state.rpcs.filter((r) => r.fn === 'mcp_reserve_units');
  assert.equal(reserves.length, 1);
  assert.equal(reserves[0].args.p_units, 1);
  assert.equal(reserves[0].args.p_limit, DEFAULT_DAILY_GENERATION_CAP);
  // The day comes from the app's Amman clock, not from the database's now().
  assert.match(String(reserves[0].args.p_day), /^\d{4}-\d{2}-\d{2}$/);
});

test('generate_concepts reserves before its first paid call', async () => {
  reset();
  await callTool('generate_concepts', { count: 2 });

  const reserved = opIndex('rpc:mcp_reserve_units');
  const agent = opIndex('agent:call');
  assert.ok(reserved >= 0 && agent >= 0);
  assert.ok(reserved < agent, `ops were: ${state.ops.join(' -> ')}`);

  const reserves = state.rpcs.filter((r) => r.fn === 'mcp_reserve_units');
  assert.equal(reserves.length, 1);
  assert.equal(reserves[0].args.p_units, 2, 'count units, not one');
});

test('a PROVEN-unspent failure releases its units', async () => {
  reset();
  // conceptsFeature.run() is the FIRST call in this tool that could bill, and
  // MissingEnvError means requireEnv refused before a request was built. So
  // here — and only because of that position — "nothing was billed" is a proof
  // rather than a hope.
  const payload = (await callTool('generate_concepts', { count: 3 })).structuredContent;

  assert.equal(payload.refusal, 'model_unavailable');
  const reservation = reservationOf(payload);
  assert.equal(reservation.units, 3);
  assert.equal(reservation.outcome, 'released');
  assert.equal(reservation.units_released, 3);
  assert.equal(unitsHeld(), 0, 'the units went back to the window');
  assert.equal(state.reservations[0].status, 'released');
  assert.match(String(payload.note), /returned to the window/);
});

test('an UNPROVABLE failure does not release, and the two cases are distinguished', async () => {
  reset();

  // check_compliance: the Judge also fails locally with MissingEnvError, and
  // its ModelFailure.spent is also false — the identical flag that used to
  // decide this. The difference is entirely the step that ran before it.
  const compliance = reservationOf(
    (await callTool('check_compliance', { text: 'نص عربي بسيط للتجربة.' })).structuredContent,
  );
  assert.equal(compliance.outcome, 'unproven');
  assert.equal(compliance.units_released, 0);

  // Same process, same error, same spent:false — opposite outcome, because
  // position in the request is what decides it.
  const concepts = reservationOf(
    (await callTool('generate_concepts', { count: 1 })).structuredContent,
  );
  assert.equal(concepts.outcome, 'released');
  assert.equal(concepts.units_released, 1);

  // Net: the compliance unit stayed, the concepts unit came back.
  assert.equal(unitsHeld(), 1);
});

test('a failure that MAY have been billed is settled spent, and never released', async () => {
  reset();
  const authStub = (await import('@/lib/auth')) as unknown as {
    HttpError: new (status: number, message: string, hint?: string) => Error;
  };
  // An HTTP failure from the provider: the request left the process, so it may
  // have been charged for.
  agentFailure = () => new authStub.HttpError(502, 'The provider returned 502.');

  const response = await handleMcpRequest(
    post(rpc('tools/call', { name: 'generate_concepts', arguments: { count: 2 } }), TOKEN),
  );
  const body = await json(response);
  const payload = (body.result as unknown as ToolCallResult).structuredContent;

  // The tool re-throws, so the caller sees tool_failed — and the units are gone.
  assert.equal(payload.refusal, 'tool_failed');
  assert.equal(unitsHeld(), 2, 'a maybe-billed failure keeps its units');
  assert.equal(state.reservations.length, 1);
  assert.equal(state.reservations[0].status, 'spent');
});

test('settling twice cannot refund the same units twice', async () => {
  reset();
  await callTool('generate_concepts', { count: 2 });
  assert.equal(unitsHeld(), 0, 'released once');

  // 0005 guards the settle with `and status = 'reserved'`. Replaying the same
  // settlement must change nothing — a second refund would be money invented.
  const reservationId = state.reservations[0].id;
  const replay = await fakeRpc('mcp_settle_reservation', {
    p_reservation: reservationId,
    p_status: 'released',
    p_note: 'replayed',
  });
  assert.deepEqual(replay.data, [{ settled_status: 'already_settled', units_released: 0 }]);
  assert.equal(unitsHeld(), 0, 'still zero — the second release refunded nothing');
  assert.equal(state.reservations[0].status, 'released');
  assert.notEqual(state.reservations[0].note, 'replayed', 'the replay did not overwrite the real reason');
});

test('the reservation gate refuses in a shaped payload that names what is held', async () => {
  reset();
  process.env.MCP_DAILY_GENERATION_CAP = '2';
  // A maybe-billed failure, so the first call's units stay held.
  const authStub = (await import('@/lib/auth')) as unknown as {
    HttpError: new (status: number, message: string, hint?: string) => Error;
  };
  agentFailure = () => new authStub.HttpError(502, 'The provider returned 502.');

  await handleMcpRequest(
    post(rpc('tools/call', { name: 'generate_concepts', arguments: { count: 2 } }), TOKEN),
  );
  assert.equal(unitsHeld(), 2, 'the window is now full');

  // The durable count is still 0 — no rows were written — so the cheap
  // pre-check passes and only the atomic gate can refuse this.
  assert.equal(state.counts.concepts, 0);
  const refused = await callTool('generate_concepts', { count: 1 });
  const payload = refused.structuredContent;

  assert.equal(payload.refusal, 'daily_generation_cap_reached', 'the same code a caller already handles');
  assert.equal(payload.gate, 'reservation', 'and it says which gate said no');
  assert.equal(payload.reserved_now, 2);
  const cap = payload.cap as Record<string, unknown>;
  assert.equal(cap.limit, 2, 'the refusal names the cap');
  assert.equal(cap.time_zone, 'Asia/Amman');
  assert.match(String(cap.resets_at), /^\d{4}/, 'and the instant it resets');
  const nextSteps = payload.what_you_can_do as string[] | undefined;
  assert.ok(nextSteps && nextSteps.some((s) => s.includes(String(cap.resets_at))));
  assert.equal(modelCalls, 1, 'the refused call reached no model');
});

test('a reservation that cannot be taken is fail-closed, never treated as taken', async () => {
  reset();
  // The RPC itself errors. An unreservable window must refuse, exactly as an
  // uncountable one does — anything else opens the door when the guard breaks.
  dbStub.__setDb(() => ({
    from: (table: string) => {
      state.ops.push(`from:${table}`);
      return query(table, state.rows[table] ?? []);
    },
    rpc: async (fn: string) => {
      state.ops.push(`rpc:${fn}`);
      if (fn === 'mcp_reserve_units') return { data: null, error: { message: 'connection reset' } };
      return { data: [], error: null };
    },
  }));

  const result = await callTool('generate_concepts', { count: 1 });
  assert.equal(result.structuredContent.refusal, 'daily_generation_cap_unknown');
  assert.equal(result.isError, true);
  assert.equal(modelCalls, 0, 'nothing was spent while the guard was down');

  // Put the working fake back for everything after this.
  dbStub.__setDb(() => ({
    from: (table: string) => {
      state.ops.push(`from:${table}`);
      return query(table, state.rows[table] ?? []);
    },
    rpc: (fn: string, args: Record<string, unknown>) => fakeRpc(fn, args),
  }));
});

/* ------------------------------------------------------------ concurrency -- */

/**
 * N parallel requests against a cap of N.
 *
 * READ THE HEADER for what this can and cannot prove: node is single-threaded
 * and the database is a fake, so Postgres's isolation is NOT under test here.
 * What is under test is the half that lives in this repo — that the tools take
 * their units in one round trip, honour a refusal, and never hand out more than
 * the cap however the calls interleave. The sensitivity of that claim is
 * established by the second test below, which runs the identical scenario
 * against a fake that models the old read-then-act gate and watches it
 * overspend.
 */
test('twenty parallel requests against a cap of 10 hand out exactly 10 units', async () => {
  reset();
  process.env.MCP_DAILY_GENERATION_CAP = '10';
  const authStub = (await import('@/lib/auth')) as unknown as {
    HttpError: new (status: number, message: string, hint?: string) => Error;
  };
  // Maybe-billed, so no reservation gives its units back mid-race and the
  // ceiling is the only thing that can stop the twentieth caller.
  agentFailure = () => new authStub.HttpError(502, 'The provider returned 502.');

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      handleMcpRequest(post(rpc('tools/call', { name: 'generate_concepts', arguments: { count: 1 } }), TOKEN)),
    ),
  );

  const payloads = await Promise.all(
    results.map(async (response) => {
      const body = await json(response);
      return (body.result as unknown as ToolCallResult).structuredContent;
    }),
  );

  const refusedByCap = payloads.filter((p) => p.refusal === 'daily_generation_cap_reached').length;
  const granted = payloads.filter((p) => p.refusal !== 'daily_generation_cap_reached').length;

  assert.equal(granted, 10, 'exactly the cap got through');
  assert.equal(refusedByCap, 10, 'and the rest were refused');
  assert.equal(unitsHeld(), 10, 'ten units are held, not twenty');
  assert.equal(peakHeld(), 10, 'and the counter never went above the cap at any instant');
  assert.equal(modelCalls, 10, 'exactly ten model calls were made');
  assert.equal(state.reservations.length, 10);
});

test('the same race with the OLD read-then-act gate overspends — so the test can detect the defect', async () => {
  reset();
  process.env.MCP_DAILY_GENERATION_CAP = '10';
  state.reserveMode = 'read_then_act';
  const authStub = (await import('@/lib/auth')) as unknown as {
    HttpError: new (status: number, message: string, hint?: string) => Error;
  };
  agentFailure = () => new authStub.HttpError(502, 'The provider returned 502.');

  await Promise.all(
    Array.from({ length: 20 }, () =>
      handleMcpRequest(post(rpc('tools/call', { name: 'generate_concepts', arguments: { count: 1 } }), TOKEN)),
    ),
  );

  // Every caller decided on a total that was true before any of them wrote, so
  // every caller passed. This is finding 2, executable. The assertion is `>`
  // rather than an exact number because how far past the cap it gets depends on
  // scheduling — which is itself the point: the old gate bounded nothing.
  assert.ok(
    unitsHeld() > 10,
    `a read-then-act gate must overspend, but only ${unitsHeld()} units were handed out`,
  );
  assert.ok(modelCalls > 10);
});

test('the finding, exactly: cap 10 and twenty parallel requests for 8 cannot buy 160', async () => {
  reset();
  process.env.MCP_DAILY_GENERATION_CAP = '10';
  const authStub = (await import('@/lib/auth')) as unknown as {
    HttpError: new (status: number, message: string, hint?: string) => Error;
  };
  agentFailure = () => new authStub.HttpError(502, 'The provider returned 502.');

  await Promise.all(
    Array.from({ length: 20 }, () =>
      handleMcpRequest(post(rpc('tools/call', { name: 'generate_concepts', arguments: { count: 8 } }), TOKEN)),
    ),
  );

  // 8 fits in 10; a second 8 does not. One caller gets through, the other
  // nineteen are refused, and 160 generations are not bought.
  assert.equal(unitsHeld(), 8);
  assert.equal(peakHeld(), 8);
  assert.equal(modelCalls, 1);
  assert.ok(unitsHeld() <= 10, 'never past the cap');
});

/* ------------------------------------------- the tools that spend nothing -- */

test('get_brand_facts and get_latest_digest reserve nothing and hold no units', async () => {
  reset();
  await callTool('get_brand_facts');
  await callTool('get_latest_digest');

  assert.deepEqual(state.rpcs, [], 'a read-only tool takes no reservation');
  assert.equal(unitsHeld(), 0);
  assert.equal(state.reservations.length, 0);
  assert.equal(modelCalls, 0);
});

test('get_brand_facts returns facts with sources, and withholds what it should', async () => {
  reset();
  const payload = (await callTool('get_brand_facts')).structuredContent;

  const facts = payload.facts as { key: string; value: string; source: string }[];
  assert.equal(facts.length, 1);
  assert.equal(facts[0].key, 'city');
  assert.equal(facts[0].source, 'tests/mcp.test.ts fixture', 'every fact carries its source');

  // Swatch NAMES, never hex — handing an external generator the hexes would be
  // handing it the Law violation.
  assert.deepEqual(payload.palette_swatch_names, Object.keys(SWATCHES));
  assert.equal(JSON.stringify(payload).includes('#48C0C0'), false);

  // Counted, not returned: the client's own captions are not handed out.
  const counts = payload.counts as Record<string, number>;
  assert.equal(counts.voice_examples, VOICE.length);
  assert.equal(JSON.stringify(payload).includes(VOICE[0]), false);

  assert.equal(payload.grounding, 'data');
  assert.equal(modelCalls, 0);
});

test('an empty Brand Brain reports absence rather than inventing facts', async () => {
  reset();
  state.rows.brand = [];
  const payload = (await callTool('get_brand_facts')).structuredContent;
  assert.deepEqual(payload.facts, []);
  assert.match(String(payload.note), /has not been seeded/);
});

test('get_latest_digest reads the newest digest and never marks it sent', async () => {
  reset();
  const payload = (await callTool('get_latest_digest')).structuredContent;
  const digest = payload.digest as Record<string, unknown>;
  assert.equal(digest.id, DIGEST.id);
  assert.equal(digest.status, 'quiet');
  assert.equal(digest.sent, false);
  assert.equal(state.inserts.length, 0, 'read-only');
  assert.equal(modelCalls, 0);

  state.rows.digests = [];
  const empty = (await callTool('get_latest_digest')).structuredContent;
  assert.equal(empty.digest, null, 'absent, not an empty stand-in');
  assert.match(String(empty.note), /No digest has been generated/);
});

test('the read-only tools take no arguments and say so by refusing them', async () => {
  reset();
  for (const name of ['get_brand_facts', 'get_latest_digest']) {
    const result = await callTool(name, { account: 'academy' });
    assert.equal(result.structuredContent.refusal, 'invalid_arguments');
    assert.equal(result.isError, true);
  }
});

/* ================================== rule 14, proven against the import graph == */

/**
 * The module graph, walked for real.
 *
 * Regexes are sanity-checked against a known-present string before any empty
 * result is trusted: `assertWalkerWorks` below fails if the walk cannot even
 * find modules we know are imported, so "no ingest module is reachable" can
 * never be an artefact of a walker that found nothing at all.
 */
const PROJECT_ROOT = new URL('../', import.meta.url);

const IMPORT_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      found.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return found;
}

/** Project-relative path, or null for an external package. */
function resolveInternal(specifier: string, fromUrl: string): string | null {
  let baseUrl: string | null = null;
  if (specifier.startsWith('@/')) {
    baseUrl = new URL(specifier.slice(2), new URL('src/', PROJECT_ROOT).href).href;
  } else if (specifier.startsWith('.')) {
    baseUrl = new URL(specifier, fromUrl).href;
  }
  if (baseUrl === null) return null;

  const withoutExt = baseUrl.replace(/\.ts$/, '');
  for (const candidate of [`${withoutExt}.ts`, `${withoutExt}.tsx`, `${withoutExt}/index.ts`]) {
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

function walk(entryUrls: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entryUrls];

  while (queue.length > 0) {
    const url = queue.pop();
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);

    const source = readFileSync(fileURLToPath(url), 'utf8');
    for (const specifier of specifiersIn(source)) {
      const resolved = resolveInternal(specifier, url);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return seen;
}

function relative(url: string): string {
  return url.slice(PROJECT_ROOT.href.length);
}

const MCP_ENTRIES = [
  new URL('src/app/api/mcp/route.ts', PROJECT_ROOT).href,
  new URL('src/lib/mcp/tools.ts', PROJECT_ROOT).href,
];

test('the import walker actually finds things (sanity check before the negative)', () => {
  const reachable = new Set([...walk(MCP_ENTRIES)].map(relative));

  // If any of these are missing, the walker is broken and every "not
  // reachable" assertion below would be meaningless.
  for (const expected of [
    'src/lib/mcp/tools.ts',
    'src/lib/agent/features/concepts.ts',
    'src/lib/agent/features/types.ts',
    'src/lib/brain/law/index.ts',
    'src/lib/brain/judge.ts',
    'src/lib/env.ts',
  ]) {
    assert.ok(reachable.has(expected), `the walker should reach ${expected}`);
  }
  assert.ok(reachable.size > 15, 'the walk found a real graph, not a stub');

  // And the thing we are about to say is unreachable must exist, or the claim
  // is vacuous.
  const ingest = readdirSync(fileURLToPath(new URL('src/lib/ingest/', PROJECT_ROOT)));
  assert.ok(ingest.includes('apify.ts'), 'src/lib/ingest/apify.ts is the spend module');
  assert.ok(ingest.length >= 5);
});

test('hard rule 14: nothing that can scrape or spend is reachable from any MCP tool', () => {
  const reachable = [...walk(MCP_ENTRIES)].map(relative);

  const ingest = reachable.filter((p) => p.startsWith('src/lib/ingest/'));
  assert.deepEqual(
    ingest,
    [],
    `MCP must not be able to reach the ingestion layer, but it reaches: ${ingest.join(', ')}`,
  );

  // Nor any other API route: a tool that could import a route handler could
  // call one, and the scrape, refresh and monitor routes are route handlers.
  const routes = reachable.filter(
    (p) => p.startsWith('src/app/api/') && p !== 'src/app/api/mcp/route.ts',
  );
  assert.deepEqual(routes, [], `MCP must not reach other routes, but it reaches: ${routes.join(', ')}`);

  // And no reachable module names the ingestion layer in an import at all,
  // which catches a specifier the resolver could not resolve.
  for (const url of walk(MCP_ENTRIES)) {
    for (const specifier of specifiersIn(readFileSync(fileURLToPath(url), 'utf8'))) {
      assert.equal(
        /(^|\/)lib\/ingest\//.test(specifier),
        false,
        `${relative(url)} imports ${specifier}`,
      );
    }
  }
});

test('the tool module contains no scrape, spend, publish or send vocabulary', () => {
  // A blunt instrument on purpose, and sanity-checked: the same reader finds
  // the words that ARE there, so an empty result for the words that must not be
  // is a real absence rather than a broken search.
  const source = readFileSync(fileURLToPath(new URL('src/lib/mcp/tools.ts', PROJECT_ROOT)), 'utf8');
  assert.match(source, /check_compliance/, 'the reader can see this file');
  assert.match(source, /MCP_ACCESS_TOKEN/);

  // Executable identifiers, not prose: the rule 14 comments legitimately
  // discuss scraping, so only call-shaped and import-shaped uses are hunted.
  for (const pattern of [
    /\bapify\w*\s*\(/i,
    /\brunScrape\w*\s*\(/i,
    /\bmirror\w*\s*\(/i,
    /from\s*['"][^'"]*apify[^'"]*['"]/i,
    /\.update\s*\(\s*\{[^}]*\bsent\b/,
  ]) {
    assert.equal(pattern.test(source), false, `tools.ts must not contain ${String(pattern)}`);
  }

  // The MCP module never logs. A token in a log line is a token on disk.
  assert.equal(/\bconsole\.\w+\s*\(/.test(source), false, 'the MCP module never logs');
});
