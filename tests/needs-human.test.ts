import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JudgeVerdict } from '../src/lib/brain/judge.ts';
import type { GuidelineSection } from '../src/lib/brain/law/index.ts';
import type { BrandRow } from '../src/lib/types/db.ts';

/* =============================================================== what this ==
 * The Law -> Judge -> one-retry cycle lives in defineFeature()
 * (src/lib/agent/features/types.ts). Its last branch is the one that matters
 * most and is the hardest to see: when the SECOND review still fails, the run
 * is stored, flagged `needsHuman`, and surfaced — never silently shipped.
 *
 * These tests execute that real cycle, on the real `guideline` feature, with
 * the real Law, the real Judge module and the real Canon retriever. Two things
 * are faked, and only two:
 *
 *   1. the model transport (`@/lib/agent/client` -> runAgentJson). Every reply
 *      is still validated by the REAL zod schema the caller passed, so a
 *      fixture or a verdict that would not have survived a real run does not
 *      survive here either.
 *   2. the database (`@/lib/supabase/admin`), which returns fixture rows.
 *
 * Everything between them is production code: defineFeature's retry cycle,
 * runLaw, runJudge's prompt assembly, reconcile(), retrieveCanon() and the
 * keyless local embedder.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PROVEN HERE, TODAY, WITH NO KEY:
 *   - the fixture passes every deterministic Law check, so the failure cannot
 *     be coming from the Law half;
 *   - a failing review triggers exactly one retry — the judge is called twice,
 *     never three times;
 *   - two failed verdicts produce needsHuman: true, and persist() surfaces it;
 *   - a verdict that passes is not retried, and does not need a human.
 *
 * WHAT IS NOT PROVEN HERE:
 *   whether a REAL Judge, reading a real Canon passage, actually fails this
 *   fixture twice. That is a claim about a model, and no model key is usable
 *   here — OPENROUTER_API_KEY and ANTHROPIC_API_KEY exist in .env.local as
 *   empty placeholders, which optionalEnv() reads as absent — so it has not
 *   been observed. The fixture and its reasoning are written down in
 *   refs/needs-human-fixture.json so that run is a single command once a key
 *   exists. Until then: the branch is proven, the model's behaviour is not.
 * ========================================================================= */

/* ---------------------------------------------------------------- loader --
 * Same approach as tests/ingest.test.ts: app modules import through the `@/*`
 * alias, which node does not resolve, and a few of them reach into next/server
 * or Supabase. These hooks teach this process the one alias rule from
 * tsconfig.json (`@/*` -> `./src/*`), resolve extensionless relative imports
 * to their .ts (or /index.ts) file, and swap three modules for stubs.
 *
 * Only resolution and those three modules are faked. Everything under test is
 * the real module.
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
  // Both stubs below are pure delegators: the behaviour lives in this file, in
  // TypeScript, rather than inside a generated source string.
  [DB_STUB]:
    'let factory = null;' +
    'export function __setDb(fn) { factory = fn; }' +
    'export function supabaseAdmin() {' +
    '  if (!factory) throw new Error("needs-human.test.ts: no fake database installed.");' +
    '  return factory();' +
    '}',
  [AGENT_STUB]:
    'let handler = null;' +
    'export function __setAgentHandler(fn) { handler = fn; }' +
    'export async function runAgentJson(args) {' +
    '  if (!handler) throw new Error("needs-human.test.ts: no fake agent installed.");' +
    '  return handler(args);' +
    '}',
};

/** `@/lib/brain/law` is a directory; `./embed` has no extension. Handle both. */
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

/* ------------------------------------------------------------- the stubs -- */

interface FakeResult {
  data: unknown;
  error: null;
}

interface FakeThenable {
  then(
    onFulfilled: (value: FakeResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
}

interface FakeQuery extends FakeThenable {
  select(...args: unknown[]): FakeQuery;
  eq(...args: unknown[]): FakeQuery;
  order(...args: unknown[]): FakeQuery;
  limit(...args: unknown[]): FakeQuery;
  overlaps(...args: unknown[]): FakeQuery;
  insert(rows: unknown): FakeQuery;
  maybeSingle(): FakeThenable;
  single(): FakeThenable;
}

function settled(data: unknown): FakeThenable {
  return {
    then: (onFulfilled, onRejected) =>
      Promise.resolve({ data, error: null }).then(onFulfilled, onRejected),
  };
}

/**
 * Enough of a PostgREST builder for the reads this cycle performs. Filters are
 * deliberately no-ops — `.overlaps('tags', …)` is Postgres's job, not the
 * cycle's, and faking it would only be testing the fake.
 */
function query(rows: unknown[]): FakeQuery {
  const q: FakeQuery = {
    select: () => q,
    eq: () => q,
    order: () => q,
    limit: () => q,
    overlaps: () => q,
    insert: (inserted) => query(Array.isArray(inserted) ? inserted : [inserted]),
    maybeSingle: () => settled(rows.length > 0 ? rows[0] : null),
    single: () => settled(rows.length > 0 ? rows[0] : null),
    then: (onFulfilled, onRejected) =>
      Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected),
  };
  return q;
}

interface DbStubModule {
  __setDb(factory: () => unknown): void;
}

interface FakeAgentArgs {
  userMessage: string;
  system?: string;
  /** The real zod schema the caller passed. Fake replies are validated by it. */
  schema: { parse(value: unknown): unknown };
}

interface FakeAgentReply {
  value: unknown;
  model: string;
  provider: string;
  attempts: number;
  usage: { input_tokens: number; output_tokens: number };
}

interface AgentStubModule {
  __setAgentHandler(handler: (args: FakeAgentArgs) => Promise<FakeAgentReply>): void;
}

const dbStub = (await import('@/lib/supabase/admin')) as unknown as DbStubModule;
const agentStub = (await import('@/lib/agent/client')) as unknown as AgentStubModule;

/* ------------------------------------------------------------- fixtures -- */

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

/** Real captions from the account, trimmed. Engagement is unknown here, so null. */
const VOICE = [
  'الموضوع مش نكد 😅',
  '#مش بالعناد … موده ورحمه ،، لتسكنوا اليها …',
  'أمر ما لقيت من ألم الهوى …!',
  'اخطر وأصعب من الخيانه الظاهره …',
  'البرّ هين … تكسب الناس باللين …',
];

const BRAND: BrandRow = {
  id: 1,
  facts: [],
  voice_examples: VOICE.map((text) => ({ text, source_url: null, engagement: null })),
  knowledge: [],
  assets: [],
  palette: { swatches: SWATCHES, note: 'Sampled from published creatives.' },
  typography: null,
  audience_notes: 'ملاحظات الجمهور غير مكتملة.',
  status: 'seed',
  updated_at: new Date(0).toISOString(),
};

/**
 * The Canon passage the fixture breaks, read from the real Canon document
 * rather than retyped — if refs/guideline-anatomy.md loses the section, this
 * test fails loudly instead of quietly grading against nothing.
 */
const ANATOMY = readFileSync(new URL('../refs/guideline-anatomy.md', import.meta.url), 'utf8');

function anatomySection(heading: string): string {
  const section = ANATOMY.split(/\n(?=## )/).find((part) => part.startsWith(`## ${heading}`));
  if (!section) {
    throw new Error(`refs/guideline-anatomy.md no longer contains a «${heading}» section.`);
  }
  return section.trim();
}

const CANON_DOCUMENT = {
  title: 'Anatomy of a brand guideline',
  source_url: null,
  kind: 'internal',
  license_note: 'Retrieval only.',
};

const { embed } = await import('../src/lib/brain/canon/embed.ts');

const CANON_CONTENT = [
  { id: 'canon-chunk-voice', tags: ['voice', 'structure'], content: anatomySection('Voice') },
  {
    id: 'canon-chunk-owes',
    tags: ['structure'],
    content: anatomySection('What every section owes the reader'),
  },
];

// The real keyless local embedder — the same vectors ingest:canon would write.
const CANON_VECTORS = await embed(CANON_CONTENT.map((c) => c.content));

const CANON_ROWS = CANON_CONTENT.map((chunk, i) => ({
  id: chunk.id,
  document_id: 'canon-doc-anatomy',
  content: chunk.content,
  tags: chunk.tags,
  embedding: JSON.stringify(CANON_VECTORS[i]),
  canon_documents: CANON_DOCUMENT,
}));

dbStub.__setDb(() => ({
  from: (table: string) =>
    query(
      (
        {
          brand: [BRAND],
          canon_chunks: CANON_ROWS,
          // Absent, not zero: no snapshot has been ingested in this fixture.
          snapshots: [],
          posts: [],
          pillars: [],
          concepts: [],
          brand_guidelines: [],
        } as Record<string, unknown[]>
      )[table] ?? [],
    ),
}));

/** The engineered candidate. See refs/needs-human-fixture.json for the reasoning. */
interface Fixture {
  candidate: { warnings: string[]; sections: GuidelineSection[] };
}

const parsedFixture: unknown = JSON.parse(
  readFileSync(new URL('../refs/needs-human-fixture.json', import.meta.url), 'utf8'),
);
const FIXTURE = parsedFixture as Fixture;

/* ------------------------------------------------------- the scripted judge -- */

const { JUDGE_SYSTEM } = await import('../src/lib/brain/judge.ts');
const { guidelineFeature } = await import('../src/lib/agent/features/guideline.ts');

interface Recorded {
  kind: 'generator' | 'judge';
  userMessage: string;
}

function reply(value: unknown): FakeAgentReply {
  return {
    value,
    model: 'stub — no model was called',
    provider: 'stub',
    attempts: 1,
    // No request left this process, so nothing was spent. These zeros are real.
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Installs a fake transport that hands the generator the fixture every time —
 * the model "cannot fix" a fault it cannot see — and hands the Judge the given
 * verdicts in order. The Judge is identified by its own system prompt, which
 * is how the real runJudge calls the client.
 *
 * A judge call beyond the scripted verdicts throws, so a cycle that retried
 * more than once would fail here rather than pass quietly.
 */
function script(verdicts: JudgeVerdict[]): Recorded[] {
  const calls: Recorded[] = [];
  let judged = 0;

  agentStub.__setAgentHandler(async (args) => {
    const isJudge = args.system === JUDGE_SYSTEM;
    calls.push({ kind: isJudge ? 'judge' : 'generator', userMessage: args.userMessage });

    if (!isJudge) return reply(args.schema.parse(FIXTURE.candidate));

    const verdict: JudgeVerdict | undefined = verdicts[judged];
    judged += 1;
    if (!verdict) {
      throw new Error(
        `The judge was called ${judged} time(s); this cycle is only allowed ${verdicts.length}.`,
      );
    }
    return reply(args.schema.parse(verdict));
  });

  return calls;
}

/** Scores below are scripted stand-ins for a model's judgement, not measurements. */
function failingVerdict(): JudgeVerdict {
  return {
    verdict: 'fail',
    score: 30,
    violations: [
      {
        rule: 'Every section states a rule with no reason and no example',
        evidence: '«الصوت دافئ وموثوق ومهني» is an adjective about the voice, not an example of it.',
        source: `canon:${CANON_ROWS[1].id}`,
      },
    ],
    fixes: ['Quote the real captions in brand.voice_examples instead of describing them.'],
    // false on purpose: needsHuman must come from the SECOND FAILURE, not from
    // the Judge asking for a human. That disjunct is covered by its own test.
    needs_human: false,
  };
}

function passingVerdict(needsHuman = false): JudgeVerdict {
  return {
    verdict: 'pass',
    score: 80,
    violations: [],
    fixes: [],
    needs_human: needsHuman,
  };
}

interface Persisted {
  needs_human: boolean;
  judge_score: number | null;
}

/* ============================================================== the tests == */

test('the fixture is invisible to the Law — no deterministic check can veto it', async () => {
  const calls = script([passingVerdict()]);
  const outcome = await guidelineFeature.run({}, 'high');
  const brain = outcome.brain;
  assert.ok(brain, 'the guideline feature is opted into the brain');

  // The crux. If the Law could see the fault, reconcile() would force `fail`
  // mechanically and the needs_human test below would be proving the Law
  // branch, not the Judge branch.
  assert.equal(brain.law.violations.length, 0);
  assert.equal(brain.law.passed, true);

  const byCheck = new Map(brain.law.results.map((r) => [r.check, r]));
  assert.equal(byCheck.get('guideline-structure')?.passed, true);
  assert.equal(byCheck.get('palette-claims')?.passed, true);
  assert.equal(byCheck.get('claims-linter')?.passed, true);

  // register-score may score the fixture low. It is a warning by design and
  // never a veto, so it does not make the fault Law-visible either.
  for (const warning of brain.law.warnings) assert.equal(warning.severity, 'warning');

  // A passing verdict is not retried: one generation, one review.
  assert.deepEqual(calls.map((c) => c.kind), ['generator', 'judge']);
  assert.equal(outcome.attempts, 1);
  assert.equal(brain.needsHuman, false);
});

test('the Judge is given the Canon passage the fixture breaks, and the Law PASS lines', async () => {
  const calls = script([passingVerdict()]);
  await guidelineFeature.run({}, 'high');

  const judgeCall = calls.find((c) => c.kind === 'judge');
  assert.ok(judgeCall, 'the judge was called');
  assert.match(judgeCall.userMessage, /What every section owes the reader/);
  assert.match(judgeCall.userMessage, new RegExp(`canon:${CANON_ROWS[1].id}`));
  assert.match(judgeCall.userMessage, /<law_results>/);
  assert.match(judgeCall.userMessage, /\[PASS\] guideline-structure/);
});

test('two failed verdicts: the judge runs exactly twice and needs_human is surfaced', async () => {
  const calls = script([failingVerdict(), failingVerdict()]);
  const outcome = await guidelineFeature.run({}, 'high');
  const brain = outcome.brain;
  assert.ok(brain, 'the guideline feature is opted into the brain');

  // FAIL -> retry -> FAIL. Exactly one retry, never a second.
  assert.deepEqual(calls.map((c) => c.kind), ['generator', 'judge', 'generator', 'judge']);
  assert.equal(calls.filter((c) => c.kind === 'judge').length, 2);
  assert.equal(outcome.attempts, 2);

  // The failure is the Judge's alone.
  assert.equal(brain.law.violations.length, 0);
  assert.equal(brain.judge.verdict, 'fail');
  assert.equal(brain.judge.needs_human, false, 'the Judge did not ask for a human');
  assert.equal(brain.needsHuman, true, 'the second failure asks for one');

  // Grounded in Canon, and the cited chunk is in the report the operator reads.
  assert.match(brain.judge.violations[0].source, /^canon:/);
  assert.ok(brain.canon.some((c) => c.chunkId === CANON_ROWS[1].id));
  assert.equal(brain.canon[0].method, 'vector');

  // The rejection actually reached the second generation.
  const retryPrompt = calls[2].userMessage;
  assert.match(retryPrompt, /Your previous attempt was rejected in review/);
  assert.match(retryPrompt, /no reason and no example/);
  assert.match(retryPrompt, /Quote the real captions/);

  // And it survives persistence — stored, flagged, surfaced.
  const persisted = outcome.persisted as Persisted;
  assert.equal(persisted.needs_human, true);
  assert.equal(persisted.judge_score, brain.judge.score);
});

test('a verdict that passes on retry does not need a human', async () => {
  const calls = script([failingVerdict(), passingVerdict()]);
  const outcome = await guidelineFeature.run({}, 'high');
  const brain = outcome.brain;
  assert.ok(brain, 'the guideline feature is opted into the brain');

  assert.equal(calls.filter((c) => c.kind === 'judge').length, 2);
  assert.equal(outcome.attempts, 2);
  assert.equal(brain.judge.verdict, 'pass');
  assert.equal(brain.needsHuman, false);
  assert.equal((outcome.persisted as Persisted).needs_human, false);
});

test('a passing Judge that asks for a human is honoured without a retry', async () => {
  const calls = script([passingVerdict(true)]);
  const outcome = await guidelineFeature.run({}, 'high');
  const brain = outcome.brain;
  assert.ok(brain, 'the guideline feature is opted into the brain');

  assert.equal(calls.filter((c) => c.kind === 'judge').length, 1);
  assert.equal(outcome.attempts, 1);
  assert.equal(brain.judge.verdict, 'pass');
  assert.equal(brain.needsHuman, true);
  assert.equal((outcome.persisted as Persisted).needs_human, true);
});
