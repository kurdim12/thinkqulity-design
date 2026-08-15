import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrandRow, PostRow, ProfileSnapshotRow } from '../src/lib/types/db.ts';

/* =============================================================== what this ==
 * The chat agent's whole reach into this studio is five tools. Four properties
 * decide whether that reach is safe, and all four are provable here with no
 * model key, no network and no Supabase:
 *
 *   1. IT IS EXACTLY FIVE TOOLS WIDE, AND A NAME OUTSIDE THE TUPLE RESOLVES TO
 *      NOTHING — including the names every JavaScript object answers for free
 *      (`__proto__`, `constructor`, `toString`). Same for the dispatchable
 *      features and the five stat lookups: three closed lists, one pattern,
 *      each tested against the keys that would slip past a lookup table.
 *   2. IT CANNOT SPEND ON DATA COLLECTION. Hard rule 18 is enforced by the
 *      import graph, so it is tested by WALKING the real import graph from both
 *      new modules and asserting nothing under src/lib/ingest/ is reachable.
 *      The walker is sanity-checked FIRST against modules we know are there, so
 *      "nothing was found" can never be an artefact of a walker that finds
 *      nothing at all.
 *   3. AN ABSENT MEASUREMENT COMES BACK AS AN ABSENCE, NEVER AS ZERO.
 *      profile_snapshots, comments and post_analyses are empty on this
 *      deployment, so this is the common case rather than the edge case, and
 *      the lookups are executed for real against empty tables to prove it.
 *   4. ROWS COME BACK VERBATIM. search_posts is asserted character-for-
 *      character against an Arabic caption containing an emoji and a number —
 *      the number in particular, because a caption is TEXT and this file
 *      asserts the tool says so out loud.
 *
 * Plus the guarantee this file adds to a dispatch: an AUDIENCE ANALYSIS CAN
 * NEVER RUN ON A CORPUS THE MODEL WROTE. The comments come from the database or
 * the dispatch is refused — before a cap unit is reserved.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT TEST
 *
 * `dispatch_feature` is implemented in src/lib/agent/chat/dispatch.ts and is
 * covered end to end by tests/chat-cap.test.ts: its atomic reservation, its
 * settlement, its parallel safety, its card. Duplicating those assertions here
 * would mean two tests that can disagree about one mechanism. What IS asserted
 * here is only the seam — that tools.ts publishes the dispatcher's own spec,
 * routes to it, and cannot reorder it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS FAKED, AND WHAT IS NOT
 *
 * Faked: the database, the two model-dependent injections (`retrieveCanon`,
 * `runJudge`), and the dispatcher's own impure edges. Nothing else. In
 * particular the LAW IS THE REAL LAW — `runLaw` runs unstubbed against the real
 * sampled palette and real captions from the account, so when this file asserts
 * that a hex in a caption was caught, a real deterministic check caught it. The
 * allow-lists, the cap read, the Amman day boundary, the filters, the corpus
 * loader and the absence shapes are all production code.
 *
 * WHAT IS NOT PROVEN HERE: that a real model calls these tools well, or that a
 * real Judge rules correctly. No provider key is usable in this repository. The
 * claim tested is the one that matters if the model behaves badly — that a bad
 * call reaches nothing it should not.
 * ========================================================================= */

/* ---------------------------------------------------------------- loader --
 * Same approach as tests/mcp.test.ts and tests/chat-lint.test.ts. `@/*` is a
 * tsconfig alias node does not resolve, and a few modules reach into
 * next/server or build a Supabase client. These hooks teach this process the
 * alias rule, resolve extensionless relative imports, and swap three modules
 * for stubs.
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
    '  if (!factory) throw new Error("chat-tools.test.ts: no fake database installed.");' +
    '  return factory();' +
    '}',
  [AGENT_STUB]:
    'let calls = 0;' +
    'export function __modelCalls() { return calls; }' +
    'export function __resetModelCalls() { calls = 0; }' +
    'export async function runAgentJson() {' +
    '  calls += 1;' +
    '  throw new Error("chat-tools.test.ts: a model call escaped. No tool may reach a model in this file.");' +
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
      source: 'tests/chat-tools.test.ts fixture',
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

const SNAPSHOT = { id: 'snap-1', taken_on: '2026-08-14' };

/**
 * The caption the verbatim assertion is made against.
 *
 * It carries an emoji, an ellipsis, Arabic punctuation AND a number, all
 * deliberately: the number is what makes "a caption is text, not a
 * measurement" a testable claim rather than a slogan.
 */
const TRICKY_CAPTION = 'الموضوع مش نكد 😅 … خصم ٥٠٠ دينار ،، بس مش هيك';

function post(overrides: Partial<PostRow> & Pick<PostRow, 'id' | 'ig_id' | 'account' | 'engagement'>): PostRow {
  return {
    snapshot_id: SNAPSHOT.id,
    url: `https://instagram.com/p/${overrides.ig_id}`,
    caption: null,
    media_type: 'Image',
    likes: null,
    comments: null,
    posted_at: '2026-08-01T20:00:00.000Z',
    rank: null,
    video_play_count: null,
    video_view_count: null,
    video_duration: null,
    product_type: null,
    location_name: null,
    location_id: null,
    hashtags: null,
    mentions: null,
    first_comment: null,
    owner_username: null,
    owner_id: null,
    is_sponsored: null,
    dimensions: null,
    raw: null,
    ...overrides,
  };
}

/**
 * Six posts, five personal and one academy, with the personal averages chosen
 * so the arithmetic is checkable by hand: 600 + 500 + 400 + 300 + 200 = 2000
 * over 5 posts = 400 exactly.
 */
const POSTS: PostRow[] = [
  post({
    id: 'p1',
    ig_id: 'aaa',
    account: 'personal',
    engagement: 600,
    caption: TRICKY_CAPTION,
    likes: 550,
    comments: 50,
    media_type: 'Video',
    posted_at: '2026-08-01T20:30:00.000Z',
  }),
  post({ id: 'p2', ig_id: 'bbb', account: 'personal', engagement: 500, caption: 'نص عادي' }),
  post({ id: 'p3', ig_id: 'ccc', account: 'personal', engagement: 400, caption: null }),
  post({ id: 'p4', ig_id: 'ddd', account: 'personal', engagement: 300, caption: 'خصم على الدورة' }),
  post({
    id: 'p5',
    ig_id: 'eee',
    account: 'personal',
    engagement: 200,
    caption: 'مساء الخير',
    posted_at: '2026-08-05T21:00:00.000Z',
  }),
  post({ id: 'p6', ig_id: 'fff', account: 'academy', engagement: 40, caption: 'دورة جديدة' }),
];

/* ------------------------------------------------------------ fake tables -- */

interface FakeState {
  rows: Record<string, unknown[]>;
  /** Per-table `count: 'exact'` answers. null models the fail-closed case. */
  counts: Record<string, number | null>;
  inserts: { table: string; rows: unknown }[];
  /** Every table touched, in order. */
  ops: string[];
  /** Tables whose read should fail, to exercise the failure paths. */
  failReads: Set<string>;
}

/**
 * The tables the shared cap counts (src/lib/mcp/tools.ts, reused by
 * ./dispatch.ts). Listed here so a count of null — the fail-closed case — can be
 * configured per table rather than guessed at.
 */
const COUNTED_TABLES = ['concepts', 'compliance_checks'];

function freshState(): FakeState {
  const counts: Record<string, number | null> = {};
  for (const table of COUNTED_TABLES) counts[table] = 0;
  return {
    rows: {
      brand: [BRAND],
      brand_guidelines: [],
      snapshots: [SNAPSHOT],
      posts: POSTS,
      post_analyses: [],
      profile_snapshots: [],
      comments: [],
      pillars: [],
      concepts: [],
    },
    counts,
    inserts: [],
    ops: [],
    failReads: new Set<string>(),
  };
}

let state = freshState();

interface Settled {
  then(
    onFulfilled: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
}

interface FakeQuery extends Settled {
  select(columns?: unknown, options?: unknown): FakeQuery;
  eq(...args: unknown[]): FakeQuery;
  gte(...args: unknown[]): FakeQuery;
  in(...args: unknown[]): FakeQuery;
  order(...args: unknown[]): FakeQuery;
  limit(...args: unknown[]): FakeQuery;
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
 * Enough of a PostgREST builder for the reads these tools perform. Filters are
 * mostly no-ops — `.eq('snapshot_id', …)` is Postgres's job and faking it would
 * only be testing the fake. What IS modelled faithfully is the shape of a
 * `head: true, count: 'exact'` reply, because the cap's fail-closed branch
 * turns on `count` being null rather than a number.
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
    in: () => q,
    order: () => q,
    limit: () => q,
    insert: (inserted) => {
      state.inserts.push({ table, rows: inserted });
      const list = Array.isArray(inserted) ? inserted : [inserted];
      return query(
        table,
        list.map((row, index) =>
          typeof row === 'object' && row !== null
            ? { ...row, id: `fake-${table}-${index}`, created_at: new Date(0).toISOString() }
            : row,
        ),
      );
    },
    // `.maybeSingle()` and `.single()` return ONE ROW OR NULL, not the array —
    // modelled faithfully because a fake that handed back an array here would
    // let a caller that mishandles the row shape pass its test.
    maybeSingle: () => settled(one()),
    single: () => settled(one()),
    then: (onFulfilled, onRejected) => Promise.resolve(reply()).then(onFulfilled, onRejected),
  };

  function one(): unknown {
    const answer = reply();
    if (typeof answer !== 'object' || answer === null) return answer;
    const record = answer as { data: unknown; error: unknown };
    if (record.error !== null) return record;
    const data = Array.isArray(record.data) ? (record.data[0] ?? null) : record.data;
    return { data, error: null };
  }

  function reply(): unknown {
    if (state.failReads.has(table)) {
      return { data: null, count: null, error: { message: `fake failure reading ${table}` } };
    }
    if (counting) {
      return {
        data: null,
        // NOT `?? 0`: a configured null is the fail-closed case under test, and
        // collapsing it to zero here would make that test assert the opposite
        // of what it says.
        count: table in state.counts ? state.counts[table] : 0,
        error: null,
      };
    }
    return { data: rows, error: null };
  }

  return q;
}

const fakeDb = {
  from: (table: string) => {
    state.ops.push(table);
    return query(table, state.rows[table] ?? []);
  },
};

interface DbStubModule {
  __setDb(factory: () => unknown): void;
}

interface AgentStubModule {
  __modelCalls(): number;
  __resetModelCalls(): void;
}

const dbStub = (await import('@/lib/supabase/admin')) as unknown as DbStubModule;
const agentStub = (await import('@/lib/agent/client')) as unknown as AgentStubModule;
dbStub.__setDb(() => fakeDb);

/* --------------------------------------------------------- modules under test */

const { MissingEnvError } = await import('../src/lib/env.ts');

const {
  CHAT_TOOL_NAMES,
  CHAT_DISPATCHABLE,
  CHAT_DISPATCH_TOOL,
  chatToolSpecs,
  createChatToolExecutor,
  isChatToolName,
  isDispatchable,
  loadAudienceCorpus,
} = await import('../src/lib/agent/chat/tools.ts');

const { STAT_LOOKUP_NAMES, isStatLookupName, runStatLookup, statLookupCatalogue } = await import(
  '../src/lib/agent/chat/stats.ts'
);

/* `dispatch_feature` is IMPLEMENTED in ./dispatch.ts and covered end to end by
 * tests/chat-cap.test.ts — its reservation, its settlement, its card. Imported
 * here only to assert that tools.ts publishes THAT spec rather than a second
 * one of its own, and to type the dependencies the corpus guard composes with. */
const { dispatchToolSpec: dispatchSpec, readChatCapState } = await import(
  '../src/lib/agent/chat/dispatch.ts'
);

type ToolDeps = Parameters<typeof createChatToolExecutor>[0];
type DispatchDeps = NonNullable<ToolDeps['dispatchDeps']>;
type FeatureOutcome = Awaited<ReturnType<DispatchDeps['runFeature']>>;
type CanonRetriever = NonNullable<ToolDeps['retrieveCanon']>;
type JudgeRunner = NonNullable<ToolDeps['runJudge']>;
type Db = ToolDeps['db'];

/** The fake stands in for a SupabaseClient at the one call shape these use. */
const db = fakeDb as unknown as Db;

/* ------------------------------------------------------------------ helpers -- */

interface Recorder {
  featureCalls: { id: string; input: unknown }[];
  judgeCalls: number;
  canonCalls: number;
  /** Dispatcher steps, in order, so "reserve came first" is checkable. */
  dispatchOps: string[];
}

let recorder: Recorder = { featureCalls: [], judgeCalls: 0, canonCalls: 0, dispatchOps: [] };

function reset(): void {
  state = freshState();
  recorder = { featureCalls: [], judgeCalls: 0, canonCalls: 0, dispatchOps: [] };
  agentStub.__resetModelCalls();
  delete process.env.CHAT_DAILY_GENERATION_CAP;
}

/** The brand context the Law reads. Injected so no database round trip is
 *  needed for the deterministic half — the Law itself is NOT faked. */
const brandContext = async () => ({
  blocks: '<performance>personal avg_engagement 400 over 5 posts</performance>',
  swatches: SWATCHES,
  voiceExamples: VOICE,
});

/** Canon that returns nothing, which is this deployment's honest state. */
const emptyCanon: CanonRetriever = async () => {
  recorder.canonCalls += 1;
  return [];
};

/** The Judge as it behaves here today: no provider key, so no ruling. */
const unavailableJudge: JudgeRunner = async () => {
  recorder.judgeCalls += 1;
  throw new MissingEnvError('OPENROUTER_API_KEY');
};

function passingJudge(): JudgeRunner {
  return async () => {
    recorder.judgeCalls += 1;
    return {
      verdict: { verdict: 'pass', score: 5, violations: [], fixes: [], needs_human: false },
      model: 'fake-judge',
    };
  };
}

/**
 * A fake `DispatchDeps`.
 *
 * `dispatch_feature` is implemented in src/lib/agent/chat/dispatch.ts and tested
 * there (tests/chat-cap.test.ts covers its reservation, its settlement and its
 * card). What is under test HERE is only what this file adds: that the tool is
 * published and routed at all, that the allow-list still refuses through the
 * delegation, and that an audience corpus can never come from the model.
 *
 * The fake records the dispatcher's steps in order, so "the corpus substitution
 * did not reorder reserve-before-run" is checked rather than assumed.
 */
function dispatchDeps(
  overrides: Partial<DispatchDeps> = {},
  outcome: { result?: unknown; persisted?: unknown; brain?: FeatureOutcome['brain'] } = {},
): DispatchDeps {
  return {
    readCap: async (now) => {
      recorder.dispatchOps.push('readCap');
      return readChatCapState(now);
    },
    reserve: async (args) => {
      recorder.dispatchOps.push('reserve');
      return {
        granted: true,
        reservation: {
          id: 'fake-reservation-1',
          tool: 'chat_dispatch',
          units: args.units,
          amman_day: args.cap.amman_day,
          reserved_after: args.units,
        },
      };
    },
    settle: async (reservation, status, reason) => {
      recorder.dispatchOps.push(`settle:${status}`);
      return {
        reservation_id: reservation.id,
        units: reservation.units,
        outcome: status,
        reason,
        recorded: status,
        units_released: status === 'released' ? reservation.units : 0,
        error: null,
      };
    },
    runFeature: async (feature, input) => {
      recorder.dispatchOps.push('runFeature');
      recorder.featureCalls.push({ id: feature, input });
      return {
        feature,
        model: 'fake-model',
        attempts: 1,
        usage: { input_tokens: 10, output_tokens: 20 },
        result: outcome.result ?? {},
        persisted: outcome.persisted ?? { inserted: [{ id: 'artefact-1' }] },
        ...(outcome.brain ? { brain: outcome.brain } : {}),
      };
    },
    ...overrides,
  };
}

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    db,
    quality: 'standard',
    loadBrandContext: brandContext,
    retrieveCanon: emptyCanon,
    runJudge: unavailableJudge,
    dispatchDeps: dispatchDeps(),
    ...overrides,
  };
}

let callSeq = 0;

/** Runs one tool through the real executor, exactly as run.ts would. */
async function callRaw(
  name: string,
  args: unknown,
  overrides: Partial<ToolDeps> = {},
): Promise<{ content: string; card?: Record<string, unknown>; source_keys?: string[] }> {
  callSeq += 1;
  const execute = createChatToolExecutor(deps(overrides));
  return execute({
    id: `call_${callSeq}`,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  });
}

/**
 * The JSON payload of a tool result.
 *
 * Every tool in THIS file answers in JSON, and so does every dispatch REFUSAL. A
 * successful dispatch answers in plain text on purpose — see dispatch.ts — so
 * those cases use `callRaw` instead.
 */
async function callTool(
  name: string,
  args: unknown,
  overrides: Partial<ToolDeps> = {},
): Promise<Record<string, unknown>> {
  const result = await callRaw(name, args, overrides);
  const parsed: unknown = JSON.parse(result.content);
  assert.ok(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    'this result is expected to be a JSON object',
  );
  const payload = parsed as Record<string, unknown>;
  // The card, when there is one, is what the UI renders in its own right.
  if (result.card) payload.__card = result.card;
  return payload;
}

/* ====================================================== 1. the closed lists ==*/

test('the surface is exactly five tools, and they are the tuple', () => {
  reset();
  const specs = chatToolSpecs();
  assert.equal(specs.length, 5, 'the v4.1 chat surface is deliberately five tools wide');
  assert.equal(CHAT_TOOL_NAMES.length, 5);
  assert.deepEqual(
    specs.map((spec) => spec.name),
    [...CHAT_TOOL_NAMES],
  );
  assert.deepEqual(specs.map((spec) => spec.name), [
    'get_stats',
    'search_posts',
    'get_brand',
    'run_compliance',
    'dispatch_feature',
  ]);
  // No duplicate hiding a sixth behind a repeated name.
  assert.equal(new Set(specs.map((spec) => spec.name)).size, 5);
});

test('an unknown tool name resolves to nothing — including the inherited keys', async () => {
  reset();
  for (const name of [
    '__proto__',
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'run_scrape',
    'apify',
    'get_statss',
    '',
  ]) {
    assert.equal(isChatToolName(name), false, `"${name}" must not be a tool name`);

    const payload = await callTool(name, {});
    assert.equal(payload.refusal, 'unknown_tool', `"${name}" must not resolve to a tool`);
    assert.deepEqual(payload.available, [...CHAT_TOOL_NAMES]);
    const card = payload.__card as Record<string, unknown> | undefined;
    assert.ok(card, 'a refusal is a card the UI can render, never prose');
    assert.equal(card.kind, 'tool_failure');
  }

  // Nothing was read, nothing was written, and no model was reached.
  assert.deepEqual(state.ops, [], 'an unknown tool touches no table');
  assert.equal(state.inserts.length, 0);
  assert.equal(agentStub.__modelCalls(), 0);
  assert.equal(recorder.featureCalls.length, 0);
});

test('the same closed-list discipline guards the stat lookups and the features', () => {
  reset();
  for (const name of ['__proto__', 'constructor', 'toString', 'valueOf', '']) {
    assert.equal(isStatLookupName(name), false, `"${name}" is not a lookup`);
    assert.equal(isDispatchable(name), false, `"${name}" is not dispatchable`);
  }
  assert.equal(STAT_LOOKUP_NAMES.length, 5);
  assert.ok(CHAT_DISPATCHABLE.length > 0, 'the dispatchable list is not empty');
  // The catalogue the model reads is built FROM the tuple, so it cannot drift.
  assert.deepEqual(
    statLookupCatalogue().map((entry) => entry.name),
    [...STAT_LOOKUP_NAMES],
  );
});

test('every tool description carries the house standard', () => {
  for (const spec of chatToolSpecs()) {
    const text = spec.description;

    // Every tool, whoever wrote it: what it takes, how it refuses, what it
    // changes, and a stated boundary on misuse.
    assert.match(text, /PARAMETERS/, `${spec.name} documents its parameters`);
    assert.match(text, /REFUSAL SHAPES?/, `${spec.name} documents its refusal shapes`);
    assert.match(text, /SIDE EFFECTS/, `${spec.name} states its side effects`);
    assert.match(
      text,
      /Do NOT|Do not|MUST NOT/,
      `${spec.name} says what it must not be used for`,
    );
    // Long enough to have actually said something. 600 is a floor, not a target.
    assert.ok(text.length > 600, `${spec.name} description is too thin to prevent misuse`);

    /* The four tools THIS file authors also carry the MCP heading dialect, so
     * the two surfaces read the same way. dispatch_feature is exempt because it
     * is written in src/lib/agent/chat/dispatch.ts, which uses its own headings
     * ("WHAT YOU MUST NOT DO WITH IT") to say the same things — asserted above.
     * Forcing its wording from here would be this file editing a file it does
     * not own. */
    if (spec.name === CHAT_DISPATCH_TOOL) continue;
    assert.match(text, /WHEN TO USE IT/, `${spec.name} says when to use it`);
    assert.match(text, /WHEN NOT TO USE IT/, `${spec.name} says when NOT to use it`);
  }
});

test('no tool parameter lets the model name a target to call', () => {
  /* Hard rule 18, third mechanism. `feature` is deliberately absent from this
   * list because dispatch_feature must have one — and it is checked separately
   * below, where the point is that it is a CLOSED ENUM rather than a free
   * string. Every other target-shaped word is forbidden outright. */
  const forbidden = /\b(url|uri|endpoint|host|actor|webhook|handle|profile|path|table|command|sql|query)\b/i;

  for (const spec of chatToolSpecs()) {
    const schema = spec.parameters;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false, `${spec.name} rejects unknown properties`);
    const properties = schema.properties ?? {};
    for (const key of Object.keys(properties)) {
      assert.equal(forbidden.test(key), false, `${spec.name}.${key} names a target`);
    }
  }

  // The one parameter that names a thing to run is an enum, not a string.
  const dispatch = chatToolSpecs().find((spec) => spec.name === 'dispatch_feature');
  assert.ok(dispatch);
  const featureProp = (dispatch.parameters.properties ?? {}).feature as
    | { enum?: unknown }
    | undefined;
  assert.ok(featureProp, 'dispatch_feature publishes its feature parameter');
  assert.deepEqual(featureProp.enum, [...CHAT_DISPATCHABLE]);

  // And get_stats' lookup is the same shape.
  const stats = chatToolSpecs().find((spec) => spec.name === 'get_stats');
  assert.ok(stats);
  const lookupProp = (stats.parameters.properties ?? {}).lookup as { enum?: unknown } | undefined;
  assert.ok(lookupProp);
  assert.deepEqual(lookupProp.enum, [...STAT_LOOKUP_NAMES]);
});

/* ============================================ 2. absence, not zero (rule 19) ==*/

test('a lookup with no data returns an ABSENCE, and states no quantity at all', async () => {
  reset();
  // profile_snapshots is empty on this deployment. This is the common case.
  assert.deepEqual(state.rows.profile_snapshots, []);

  const outcome = await runStatLookup(db, 'follower_history', { account: 'all' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const result = outcome.result;
  assert.equal(result.status, 'absent');
  assert.deepEqual(result.values, [], 'no value is emitted for something never measured');
  assert.equal(result.absences.length, 2, 'one absence per account asked for');

  for (const absence of result.absences) {
    assert.match(absence.what, /^profiles\.(personal|academy)$/);
    assert.match(absence.reason, /no profile snapshot has ever been recorded/);
    // Hard rule 2, tested rather than trusted: the absence never offers a
    // stand-in number, and it says what to render instead.
    assert.match(absence.reason, /em-dash/);
    assert.ok(absence.what_would_produce_it.length > 0, 'an absence says what would create it');
    assert.equal(/\d/.test(absence.reason), false, 'an absence reason states no digit');
  }

  // The whole payload contains no zero masquerading as a follower count.
  const serialised = JSON.stringify(result);
  assert.equal(/"value"\s*:\s*"0"/.test(serialised), false, 'absent never becomes 0');
});

test('cluster aggregates are absent too, and say which screen would create them', async () => {
  reset();
  assert.deepEqual(state.rows.post_analyses, [], 'post_analyses is empty on this deployment');

  const outcome = await runStatLookup(db, 'cluster_aggregates', {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  assert.equal(outcome.result.status, 'absent');
  assert.deepEqual(outcome.result.values, []);
  assert.equal(outcome.result.absences.length, 1);
  const absence = outcome.result.absences[0];
  assert.equal(absence.what, 'performance.clusters');
  assert.match(absence.reason, /hypothesis, not a measurement/);
  assert.match(absence.what_would_produce_it, /Board screen/);
});

test('a lookup WITH data emits values that carry their key, their n and their date', async () => {
  reset();
  const outcome = await runStatLookup(db, 'account_averages', { account: 'personal' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const result = outcome.result;
  assert.equal(result.status, 'measured');

  const byKey = new Map(result.values.map((value) => [value.source_key, value]));

  // 600+500+400+300+200 = 2000 over 5 posts = 400. Checkable by hand on purpose.
  const average = byKey.get('performance.personal.avg_engagement');
  assert.ok(average, 'the average is emitted under the key the strategist blocks use');
  assert.equal(average.value, '400');
  assert.equal(average.n, 5, 'hard rule 11: the sample size travels with the figure');
  assert.equal(average.as_of, SNAPSHOT.taken_on);
  assert.equal(typeof average.value, 'string', 'a value is TEXT, never a number type');

  assert.equal(byKey.get('performance.personal.total_engagement')?.value, '2000');
  assert.equal(byKey.get('performance.personal.post_count')?.value, '5');
  assert.deepEqual(result.measured_over, {
    snapshot_id: SNAPSHOT.id,
    taken_on: SNAPSHOT.taken_on,
  });

  // The academy account was not asked for, so it is neither measured nor
  // invented — it is simply absent from the answer.
  assert.equal(byKey.has('performance.academy.avg_engagement'), false);
});

test('the two accounts are never blended, and the gap is a ratio that names itself', async () => {
  reset();
  const outcome = await runStatLookup(db, 'account_averages', { account: 'all' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const byKey = new Map(outcome.result.values.map((value) => [value.source_key, value]));
  assert.equal(byKey.get('performance.personal.avg_engagement')?.value, '400');
  assert.equal(byKey.get('performance.academy.avg_engagement')?.value, '40');
  // 400 / 40 = 10. A ratio, labelled as one — not a combined mean, which would
  // belong to neither account.
  assert.equal(byKey.get('performance.gap.personal_vs_academy')?.value, '10');

  for (const key of byKey.keys()) {
    assert.equal(/^performance\.(personal|academy|gap)\./.test(key), true, `unexpected key ${key}`);
  }
});

test('an unknown lookup is refused BY NAME with the catalogue, and offers the escape hatch', async () => {
  reset();
  for (const name of ['__proto__', 'constructor', 'followers', 'select * from posts', '']) {
    const outcome = await runStatLookup(db, name, {});
    assert.equal(outcome.ok, false, `"${name}" must not resolve to a computation`);
    if (outcome.ok) return;
    assert.equal(outcome.refusal, 'unknown_lookup');
    assert.deepEqual(outcome.available, [...STAT_LOOKUP_NAMES]);
    assert.match(outcome.reason, /no free-SQL tool and no raw-table tool/);
    // Rule 19's second half: a missing computation is answered by saying so and
    // offering a request_computation item.
    assert.ok(outcome.what_you_can_do.some((step) => step.includes('request_computation')));
  }
  assert.deepEqual(state.ops, [], 'an unknown lookup reads nothing');
});

test('a lookup parameter outside its range is refused, not clamped', async () => {
  reset();
  for (const params of [{ limit: 0 }, { limit: 99 }, { limit: 2.5 }, { account: 'nobody' }, { table: 'posts' }]) {
    const outcome = await runStatLookup(db, 'top_posts', params);
    assert.equal(outcome.ok, false, `${JSON.stringify(params)} must be refused`);
    if (outcome.ok) return;
    assert.equal(outcome.refusal, 'invalid_params');
    assert.ok(outcome.issues.length > 0, 'the issues are itemised by path');
  }
});

/* =============================================== 3. search_posts, verbatim ==*/

test('search_posts returns rows VERBATIM, character for character', async () => {
  reset();
  const payload = await callTool('search_posts', { account: 'personal', limit: 5 });

  const rows = payload.rows as Record<string, unknown>[];
  assert.equal(rows.length, 5);

  const top = rows[0];
  // The whole point: not shortened, not translated, not normalised. The emoji,
  // the ellipsis, the Arabic comma and the Arabic-Indic digits all survive.
  assert.equal(top.caption, TRICKY_CAPTION);
  assert.equal(String(top.caption).includes('😅'), true);
  assert.equal(String(top.caption).includes('٥٠٠'), true);
  assert.equal(top.url, 'https://instagram.com/p/aaa');
  assert.equal(top.engagement, 600);
  assert.equal(top.likes, 550);
  assert.equal(top.comments, 50);
  assert.equal(top.media_type, 'Video');
  assert.equal(top.ig_id, 'aaa');
  assert.equal(top.account, 'personal');

  // A missing like count stays null. Zero would be a measurement.
  assert.equal(rows[1].likes, null);
  assert.equal(rows[1].comments, null);
  assert.equal(rows[2].caption, null, 'a post with no caption reports null, not ""');

  assert.equal(payload.matched, 5);
  assert.equal(payload.returned, 5);
  assert.equal(agentStub.__modelCalls(), 0, 'search_posts calls no model');

  // And it says out loud what a caption is, because the claims-linter cannot
  // tell a metric from a number the client typed into a caption.
  assert.match(String(payload.note), /not a measurement/);
});

test('search_posts filters are named, bounded, and applied without touching the database', async () => {
  reset();

  const contains = await callTool('search_posts', { contains: 'خصم' });
  const containsRows = (contains.rows as Record<string, unknown>[]).map((row) => row.ig_id);
  assert.deepEqual(containsRows, ['aaa', 'ddd'], 'substring match, case-insensitive, in code');

  const byType = await callTool('search_posts', { media_type: 'video' });
  assert.equal((byType.rows as unknown[]).length, 1, 'media_type matches case-insensitively');

  const floor = await callTool('search_posts', { min_engagement: 500 });
  assert.equal((floor.rows as unknown[]).length, 2);

  const recent = await callTool('search_posts', { order: 'recent', limit: 2 });
  const recentIds = (recent.rows as Record<string, unknown>[]).map((row) => row.ig_id);
  assert.deepEqual(recentIds, ['eee', 'aaa'], 'the only other ordering that exists');

  // Nothing matched is an ANSWER, not a refusal, and it says so.
  const none = await callTool('search_posts', { contains: 'zzzz-no-such-text' });
  assert.equal(none.refusal, undefined);
  assert.deepEqual(none.rows, []);
  assert.equal(none.matched, 0);

  // A filter the schema does not know is refused rather than ignored.
  const bad = await callTool('search_posts', { limit: 500, caption_like: '%' });
  assert.equal(bad.refusal, 'invalid_arguments');
});

test('with no snapshot, search_posts reports an absence rather than an empty result', async () => {
  reset();
  state.rows.snapshots = [];
  const payload = await callTool('search_posts', {});
  const absence = payload.absence as Record<string, unknown>;
  assert.ok(absence, 'no snapshot is an absence, not "no posts match"');
  assert.match(String(absence.reason), /no engagement snapshot has been ingested/);
  assert.deepEqual(payload.rows, []);
});

/* ========================================= 4. dispatch_feature, DELEGATED ==*/

test('dispatch_feature is published from the dispatcher, not re-declared here', () => {
  reset();
  const spec = chatToolSpecs().find((each) => each.name === CHAT_DISPATCH_TOOL);
  assert.ok(spec, 'the fifth tool is on the surface');

  /* The spec must be the dispatcher's own, field for field. A second
   * description maintained here would drift from the code that actually
   * enforces the cap, and the model would be told rules nothing applies. */
  assert.deepEqual(spec, dispatchSpec());
  assert.equal(spec.name, 'dispatch_feature');
});

test('dispatch_feature refuses a feature outside the allow-list, and runs nothing', async () => {
  reset();
  /* 'gaps' and 'strategist' are REGISTERED features — getFeature() resolves
   * both — and they are refused anyway, which is what makes this a test of the
   * allow-list rather than of the registry. */
  for (const feature of [
    'gaps',
    'strategist',
    '__proto__',
    'constructor',
    'toString',
    'run_scrape',
    'ingest',
    '',
  ]) {
    assert.equal(isDispatchable(feature), false, `"${feature}" must not be dispatchable`);

    const payload = await callTool(CHAT_DISPATCH_TOOL, { feature });
    assert.equal(payload.refusal, 'dispatch_invalid_arguments', `"${feature}" must not dispatch`);
    assert.deepEqual(payload.dispatchable, [...CHAT_DISPATCHABLE]);
    assert.match(String(payload.note), /no cap unit was taken/);
  }

  assert.equal(recorder.featureCalls.length, 0, 'no feature ran');
  assert.deepEqual(recorder.dispatchOps, [], 'not even the cap was read');
  assert.equal(state.inserts.length, 0, 'nothing was written');
  assert.equal(agentStub.__modelCalls(), 0, 'no model was reached');
});

test('an allowed dispatch reaches the dispatcher, in its order, and returns a reference', async () => {
  reset();
  const result = await callRaw(CHAT_DISPATCH_TOOL, {
    feature: 'concepts',
    input: { count: 1, account: 'academy' },
  });

  // The dispatcher's own order, observed rather than read off its source. The
  // corpus guard in tools.ts must not be able to reorder it.
  assert.deepEqual(recorder.dispatchOps, ['readCap', 'reserve', 'runFeature', 'settle:spent']);
  assert.equal(recorder.featureCalls.length, 1);
  assert.equal(recorder.featureCalls[0].id, 'concepts');

  // Rule 17: a card is a REFERENCE. The result names ids and counts; the
  // deliverable's own words are never read by this surface at all.
  const card = result.card;
  assert.ok(card, 'a dispatch answers with a card');
  assert.equal(card.kind, 'dispatch');
  assert.equal(card.feature, 'concepts');
  assert.match(result.content, /DISPATCHED: concepts/);
  assert.match(result.content, /The deliverable itself is NOT in this result/);
});

/* ================================ 5. the corpus a model must never supply ==*/

test('audience NEVER takes its corpus from the model — with no comments it refuses', async () => {
  reset();
  assert.deepEqual(state.rows.comments, [], 'comments is empty on this deployment');

  /* The attack this prevents: a model hands the audience feature comments IT
   * wrote, and the analysis quotes invented Arabic back to the operator as
   * "what the audience said". The feature's schema would have ACCEPTED them —
   * it requires a non-empty array and cannot tell who wrote it. */
  const payload = await callTool(CHAT_DISPATCH_TOOL, {
    feature: 'audience',
    input: {
      account: 'all',
      comments: [
        { id: 'made-up-1', post_id: 'p1', post_url: null, text: 'تعليق مخترع من النموذج' },
        { id: 'made-up-2', post_id: 'p1', post_url: null, text: 'تعليق آخر مخترع' },
      ],
    },
  });

  assert.equal(payload.refusal, 'no_corpus');
  assert.equal(recorder.featureCalls.length, 0, 'the feature never ran on an invented corpus');
  // Refused before the dispatcher, so no unit was reserved for a run that could
  // not have happened.
  assert.deepEqual(recorder.dispatchOps, []);
  assert.match(String(payload.note), /no cap unit was reserved/);

  const absence = payload.absence as Record<string, unknown>;
  assert.match(String(absence.reason), /invent its own corpus/);
  assert.match(String(absence.what_would_produce_it), /Comments screen/);

  // The invented text is not echoed back into the context the reply is linted
  // against, which would hand it a source it has not earned.
  assert.equal(JSON.stringify(payload).includes('تعليق مخترع'), false);
});

test('when comments DO exist, the corpus is the database own rows and the model input is discarded', async () => {
  reset();
  state.rows.comments = [
    { id: 'c1', post_id: 'p1', text_content: 'تعليق حقيقي من قاعدة البيانات' },
    { id: 'c2', post_id: 'p2', text_content: 'تعليق حقيقي آخر' },
    // A blank comment is dropped rather than passed on as an empty string.
    { id: 'c3', post_id: 'p2', text_content: '   ' },
  ];

  await callRaw(CHAT_DISPATCH_TOOL, {
    feature: 'audience',
    input: {
      account: 'all',
      comments: [{ id: 'made-up-1', post_id: 'p1', post_url: null, text: 'تعليق مخترع' }],
    },
  });

  assert.equal(recorder.featureCalls.length, 1);
  const input = recorder.featureCalls[0].input as {
    account: string;
    comments: { id: string; post_url: string | null }[];
  };
  assert.equal(input.account, 'all');
  assert.deepEqual(
    input.comments.map((comment) => comment.id),
    ['c1', 'c2'],
    'the corpus is exactly what the database held — the blank one dropped, the invented one gone',
  );
  assert.equal(
    JSON.stringify(input).includes('made-up-1'),
    false,
    'nothing the model supplied reached the feature',
  );
  // The permalink is filled from the database, not from what the model claimed.
  assert.equal(input.comments[0].post_url, 'https://instagram.com/p/aaa');

  // And the substitution did not move the reservation.
  assert.deepEqual(recorder.dispatchOps, ['readCap', 'reserve', 'runFeature', 'settle:spent']);
});

test('the corpus loader reads only real rows, and returns nothing rather than inventing one', async () => {
  reset();
  state.rows.comments = [
    { id: 'c1', post_id: 'p1', text_content: 'على حساب أحمد' },
    { id: 'c2', post_id: 'p6', text_content: 'على حساب الأكاديمية' },
    { id: 'c3', post_id: 'p1', text_content: '' },
    { id: 'c4', post_id: 'p1', text_content: null },
  ];

  const all = await loadAudienceCorpus(db, 'all');
  assert.deepEqual(
    all.map((comment) => comment.id),
    ['c1', 'c2'],
    'a blank and a null comment are dropped, never passed on as something someone said',
  );

  // With no snapshot there is no population, so there is no corpus — an empty
  // array, not an invented one.
  state.rows.snapshots = [];
  assert.deepEqual(await loadAudienceCorpus(db, 'all'), []);
});

/* ===================================================== 6. run_compliance ====*/

test('run_compliance runs the REAL Law, and a refused Judge is not a pass', async () => {
  reset();
  const payload = await callTool('run_compliance', {
    text: 'Use #FF0000 as the accent and promise 340% more engagement.',
    subject: 'caption',
  });

  const law = payload.law as Record<string, unknown>;
  assert.equal(law.passed, false);
  assert.ok(Number(law.violation_count) > 0);
  const results = law.results as { check: string; passed: boolean }[];
  assert.ok(results.some((result) => result.check === 'palette-claims' && !result.passed));

  const judge = payload.judge as Record<string, unknown>;
  assert.equal(judge.status, 'unavailable');
  assert.equal(judge.verdict, null);
  assert.equal(payload.passed, false);
  assert.equal(payload.needs_human, true, 'no ruling is not a pass');

  // The ledger records RULINGS. No Judge ran, so there is nothing to file.
  assert.equal(payload.recorded, null);
  assert.equal(state.inserts.length, 0);

  const card = payload.__card as Record<string, unknown>;
  assert.equal(card.kind, 'compliance');
  assert.equal(card.needs_human, true);
});

test('a clean text with a ruling Judge passes, and the check is filed once', async () => {
  reset();
  const payload = await callTool(
    'run_compliance',
    { text: 'الموضوع مش نكد، والدورة بتفرق معك.' },
    { runJudge: passingJudge() },
  );

  assert.equal(payload.passed, true);
  assert.equal(payload.needs_human, false);
  const recorded = payload.recorded as { id: string; created_at: string } | null;
  assert.ok(recorded, 'a ruling is filed in the compliance ledger');
  assert.equal(typeof recorded.id, 'string', 'and the row it filed comes back as a row');
  assert.equal(state.inserts.length, 1);
  assert.equal(state.inserts[0].table, 'compliance_checks');
});

test('over cap, run_compliance still returns the whole deterministic verdict', async () => {
  reset();
  // The same window and the same ceiling the dispatcher uses, so a day spent on
  // dispatches closes this tool too.
  process.env.CHAT_DAILY_GENERATION_CAP = '2';
  state.counts.concepts = 1;
  state.counts.compliance_checks = 1;

  const payload = await callTool('run_compliance', {
    text: 'Use #FF0000 as the accent.',
    subject: 'caption',
  });

  assert.equal(payload.refusal, 'daily_generation_cap_reached');
  const judge = payload.judge as Record<string, unknown>;
  assert.equal(judge.status, 'refused_daily_cap');

  const cap = payload.cap as Record<string, unknown>;
  assert.equal(cap.limit, 2, 'the refusal names the cap it was measured against');
  assert.equal(cap.used, 2);
  assert.equal(cap.remaining, 0);
  assert.equal(cap.time_zone, 'Asia/Amman');
  assert.equal(cap.env_key, 'CHAT_DAILY_GENERATION_CAP');

  // An instant, not a mood.
  const resetsAt = new Date(String(cap.resets_at));
  assert.equal(Number.isNaN(resetsAt.getTime()), false);
  assert.ok(resetsAt.getTime() > Date.now());
  assert.match(String(cap.resets_on), /^\d{4}-\d{2}-\d{2}$/);
  const steps = payload.what_you_can_do as string[];
  assert.ok(steps.some((step) => step.includes(String(cap.resets_at))), 'and it is actionable');

  // The half that needs no key, no credit and no network is complete.
  const law = payload.law as Record<string, unknown>;
  assert.equal(law.passed, false);
  assert.ok(Number(law.violation_count) > 0, 'the Law ran anyway');
  assert.match(String(payload.note), /Only the model-backed Judge was refused/);
  assert.equal(recorder.judgeCalls, 0, 'and no model was reached');
  assert.equal(state.inserts.length, 0);
});

test('a cap run_compliance cannot count is fail-closed, never read as zero', async () => {
  reset();
  // The read came back with no count. Treating that as "0 used" would open the
  // door precisely when the guard is broken.
  state.counts.concepts = null;

  const payload = await callTool('run_compliance', { text: 'نص عربي بسيط للتجربة.' });
  assert.equal(payload.refusal, 'daily_generation_cap_unknown');
  assert.match(String(payload.note), /never as zero/);
  assert.equal(recorder.judgeCalls, 0, 'nothing model-backed was attempted');
  assert.equal(state.inserts.length, 0);
});

/* ===================================================== 8. failure honesty ===*/

test('a failed read becomes a structured failure card, never a swallowed error', async () => {
  reset();
  state.failReads.add('posts');

  const payload = await callTool('search_posts', {});
  assert.equal(payload.refusal, 'tool_failed');
  assert.match(String(payload.reason), /fake failure reading posts/);
  assert.match(String(payload.note), /No rows were invented/);
  const card = payload.__card as Record<string, unknown>;
  assert.equal(card.kind, 'tool_failure');
  assert.equal(card.tool, 'search_posts');
});

test('unparseable tool arguments are refused in shape rather than guessed at', async () => {
  reset();
  const execute = createChatToolExecutor(deps());
  const result = await execute({ id: 'c1', name: 'get_stats', arguments: '{not json' });
  const payload = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(payload.refusal, 'invalid_arguments');
  assert.ok(result.card, 'and it is a card');
  assert.deepEqual(state.ops, [], 'nothing was read');
});

test('get_stats hands the source keys back so the turn can be audited', async () => {
  reset();
  const execute = createChatToolExecutor(deps());
  const result = await execute({
    id: 'c1',
    name: 'get_stats',
    arguments: JSON.stringify({ lookup: 'account_averages', params: { account: 'academy' } }),
  });
  assert.ok(result.source_keys);
  assert.ok(result.source_keys.includes('performance.academy.avg_engagement'));
  // A stat lookup gets no card: its numbers belong in the sentence that cites
  // them, not in a panel beside it.
  assert.equal(result.card, undefined);
});

test('a get_brand section returns its own source, and withholds the palette hexes', async () => {
  reset();
  const facts = await callTool('get_brand', { section: 'facts' });
  const rows = facts.facts as { key: string; source: string }[];
  assert.equal(rows[0].key, 'city');
  assert.equal(rows[0].source, 'tests/chat-tools.test.ts fixture', 'every fact carries its source');

  const palette = await callTool('get_brand', { section: 'palette' });
  assert.deepEqual(palette.swatch_names, Object.keys(SWATCHES));
  // Handing a generator the hexes would be handing it the Law violation.
  assert.equal(JSON.stringify(palette).includes('#48C0C0'), false);

  // No guideline has been generated, so this is an absence, not a version of 0.
  const guideline = await callTool('get_brand', { section: 'guideline' });
  const absence = guideline.absence as Record<string, unknown>;
  assert.ok(absence);
  assert.equal(guideline.version, undefined);
  assert.match(String(absence.what_would_produce_it), /Guideline screen/);

  const bad = await callTool('get_brand', { section: 'everything' });
  assert.equal(bad.refusal, 'invalid_arguments');
});

/* ============================== 9. rule 18, proven against the import graph ==*/

/**
 * The module graph, walked for real.
 *
 * The walker is sanity-checked against modules we KNOW are imported before any
 * empty result is trusted, so "no ingest module is reachable" can never be an
 * artefact of a walker that found nothing at all.
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

const CHAT_ENTRIES = [
  new URL('src/lib/agent/chat/tools.ts', PROJECT_ROOT).href,
  new URL('src/lib/agent/chat/stats.ts', PROJECT_ROOT).href,
];

test('the import walker actually finds things (sanity check before the negative)', () => {
  const reachable = new Set([...walk(CHAT_ENTRIES)].map(relative));

  // If any of these is missing the walker is broken, and every "not reachable"
  // assertion below would be meaningless.
  for (const expected of [
    'src/lib/agent/chat/tools.ts',
    'src/lib/agent/chat/stats.ts',
    'src/lib/agent/features/registry.ts',
    'src/lib/agent/features/concepts.ts',
    'src/lib/agent/features/strategist.ts',
    'src/lib/brain/law/index.ts',
    'src/lib/brain/judge.ts',
    'src/lib/audience/posts.ts',
    'src/lib/audience/timing.ts',
    'src/lib/env.ts',
  ]) {
    assert.ok(reachable.has(expected), `the walker should reach ${expected}`);
  }
  assert.ok(reachable.size > 20, 'the walk found a real graph, not a stub');

  // And the thing we are about to call unreachable must exist, or the claim is
  // vacuous.
  const ingest = readdirSync(fileURLToPath(new URL('src/lib/ingest/', PROJECT_ROOT)));
  assert.ok(ingest.includes('apify.ts'), 'src/lib/ingest/apify.ts is the spend module');
  assert.ok(ingest.length >= 5);

  // Prove the walker WOULD find it: from a module that really does import the
  // ingestion layer, it is reachable. A negative from a walker that cannot
  // produce the positive is worth nothing.
  const scrapeSide = walk([new URL('src/app/api/monitor/route.ts', PROJECT_ROOT).href]);
  const found = [...scrapeSide].map(relative).filter((path) => path.startsWith('src/lib/ingest/'));
  assert.ok(found.length > 0, 'the walker can see the ingestion layer when it is genuinely there');
});

test('hard rule 18: nothing that can scrape or spend is reachable from any chat tool', () => {
  const reachable = [...walk(CHAT_ENTRIES)].map(relative);

  const ingest = reachable.filter((path) => path.startsWith('src/lib/ingest/'));
  assert.deepEqual(
    ingest,
    [],
    `chat tools must not reach the ingestion layer, but they reach: ${ingest.join(', ')}`,
  );

  // Nor any API route: a tool that could import a route handler could call one,
  // and the scrape, refresh, monitor and comments routes are route handlers.
  const routes = reachable.filter((path) => path.startsWith('src/app/api/'));
  assert.deepEqual(routes, [], `chat tools must not reach routes, but they reach: ${routes.join(', ')}`);

  /* THE MCP SERVER IS REACHABLE, AND ON PURPOSE — but only one module of it.
   *
   * src/lib/agent/chat/dispatch.ts imports the Amman-day helpers and the daily
   * counter from src/lib/mcp/tools.ts so that chat dispatches and MCP calls come
   * out of ONE reservation ledger: they are the same money on the same provider
   * key, and two ledgers would each hand out the whole day. The cost of that
   * decision is that this graph now contains the module holding
   * MCP_ACCESS_TOKEN's comparison. Nothing here calls it, and the assertion is
   * pinned to exactly one file so a NEW mcp module appearing in the chat graph
   * fails this test rather than arriving quietly. */
  const mcp = reachable.filter((path) => path.startsWith('src/lib/mcp/'));
  assert.deepEqual(
    mcp,
    ['src/lib/mcp/tools.ts'],
    `the only MCP module chat may reach is the shared cap; it reaches: ${mcp.join(', ')}`,
  );

  // And no reachable module names the ingestion layer in an import at all,
  // which catches a specifier the resolver could not resolve.
  for (const url of walk(CHAT_ENTRIES)) {
    for (const specifier of specifiersIn(readFileSync(fileURLToPath(url), 'utf8'))) {
      assert.equal(
        /(^|\/)lib\/ingest\//.test(specifier),
        false,
        `${relative(url)} imports ${specifier}`,
      );
    }
  }
});

test('the tool modules contain no scrape, spend or publish vocabulary', () => {
  for (const file of ['src/lib/agent/chat/tools.ts', 'src/lib/agent/chat/stats.ts']) {
    const source = readFileSync(fileURLToPath(new URL(file, PROJECT_ROOT)), 'utf8');

    // Sanity check FIRST: the same reader finds words that ARE there, so an
    // empty result for the words that must not be is a real absence rather than
    // a broken search.
    assert.match(source, /export/, `the reader can see ${file}`);

    for (const pattern of [
      /\bapify\w*\s*\(/i,
      /\brunScrape\w*\s*\(/i,
      /\bmirror\w*\s*\(/i,
      /from\s*['"][^'"]*apify[^'"]*['"]/i,
      /from\s*['"][^'"]*lib\/ingest[^'"]*['"]/i,
      /\.update\s*\(\s*\{[^}]*\bsent\b/,
    ]) {
      assert.equal(pattern.test(source), false, `${file} must not contain ${String(pattern)}`);
    }
  }

  /* Every table these modules read is named by a LITERAL at the call site —
   * the property that makes "there is no raw-table tool" checkable rather than
   * promised. A table name assembled from a parameter would be exactly the
   * escape hatch rule 19 forbids.
   *
   * NO IDENTIFIER IS ALLOWED in that position. Every table these two modules
   * read is spelled out, so there is nowhere for a caller-chosen name to enter. */
  for (const file of ['src/lib/agent/chat/tools.ts', 'src/lib/agent/chat/stats.ts']) {
    const source = readFileSync(fileURLToPath(new URL(file, PROJECT_ROOT)), 'utf8');
    const froms = [...source.matchAll(/\.from\(([^)]*)\)/g)].map((match) => match[1].trim());
    assert.ok(froms.length > 0, `${file} does read tables, so this check is not vacuous`);
    for (const argument of froms) {
      assert.match(
        argument,
        /^'[a-z_]+'$/,
        `${file} builds a table name from something other than a literal: ${argument}`,
      );
    }
  }
});

test('neither module contains a control byte', () => {
  // Hard rule 7: a NUL byte makes grep classify a file as binary and silently
  // withhold matches, which would hide anything a later scan went looking for.
  for (const file of ['src/lib/agent/chat/tools.ts', 'src/lib/agent/chat/stats.ts']) {
    const source = readFileSync(fileURLToPath(new URL(file, PROJECT_ROOT)), 'utf8');
    const control = [...source].filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 && char !== '\n' && char !== '\r' && char !== '\t';
    });
    assert.equal(control.length, 0, `${file} contains ${control.length} control byte(s)`);
  }
});
