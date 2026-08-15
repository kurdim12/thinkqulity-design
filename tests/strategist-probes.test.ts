import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import type { LawReport, LawResult } from '../src/lib/brain/law/index.ts';
import type { StrategistResponse } from '../src/lib/agent/features/strategist.ts';
import type { BrandRow, DecisionRow } from '../src/lib/types/db.ts';

/* =============================================================== what this ==
 * THE EVAL PROBES. One per triggered rule in STRATEGIST_SYSTEM.
 *
 * Each probe is a PAIR: the output the rule demands, and the output the rule
 * exists to stop. Between them sits the deterministic gate that has to tell them
 * apart. A probe is worth something only if all three are real, so each is
 * written in layers and the layers are named in the test titles:
 *
 *   premise   — a property of the REAL blocks, asserted through the real
 *               blocks.ts. Probe 1 means nothing unless the ratio it forbids
 *               genuinely has no key, so that is asserted rather than assumed.
 *   gate      — the pair run through PRODUCTION code: the real zod schema, the
 *               real Law (source-keys, claims-linter), the real ledger,
 *               staleness, quiet, fence, period and commitment checks, the real
 *               preflight. These execute today and their verdicts are asserted
 *               today.
 *   [pending] — the half no code on disk can decide yet. Written, skipped, and
 *               stating exactly which rule is unenforced and what would prove
 *               it. Two are in that state and both are listed at the bottom of
 *               this file. Neither fakes a pass.
 *
 * NO MODEL IS CALLED, and none is needed: every gate here is deterministic. The
 * payload pairs stand in for a model's output exactly the way
 * tests/needs-human.test.ts scripts the Judge's verdicts — the transport is
 * faked, the checks are not. What is NOT proven is whether a real strategist,
 * given these blocks, actually produces the good member of each pair. That is a
 * claim about a model and it has not been observed here.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GATES ASK "WOULD THIS SHIP?" AND NOT "WHICH FUNCTION FAILED IT?"
 * ---------------------------------------------------------------------------
 * Several of these rules can live in either of two places — a `superRefine` on
 * `strategistResponseSchema`, or a named check in the `strategistLaw()` list —
 * and during this feature's construction more than one of them moved between
 * the two, in both directions. A probe bound to the layer would go red on a
 * refactor that changed nothing a client could observe.
 *
 * So every gate below asks the question the operator's rule actually asks —
 * does this payload get stopped, and is it stopped for the right reason —
 * through `ruling()`, which runs the schema and then every check the feature
 * exports, whichever those turn out to be, and returns both. A rule that
 * vanished from BOTH layers still turns these probes red, which is the property
 * that matters. Probe 1 is the exception: `source-keys` and `claims-linter`
 * come from `runLaw()` and are asserted by name, because which of the two
 * caught a number is itself the finding.
 *
 * ---------------------------------------------------------------------------
 * ON THE NUMBERS IN THIS FILE
 * ---------------------------------------------------------------------------
 * `baseData()` is the REAL 2026-08-15 state and invents nothing: 320 scrape rows
 * in one snapshot dated 2026-08-14, personal n=190 avg 508, academy n=130 avg
 * 40, top post 33176, post_analyses empty, comments empty, profile_snapshots
 * empty. The two totals (96520, 5200) are 190x508 and 130x40.
 *
 * Probes 3 and 6 are about MOVEMENT, and no movement exists in the real
 * database — one snapshot, zero profile snapshots, so no delta of any kind can
 * be measured today. Their follower figures are CONSTRUCTED INPUTS, marked as
 * such at every site: fixture shapes describing the state the app must handle
 * once a second scrape lands, never measurements of the client. That those two
 * probes cannot be run on real data is itself a finding.
 * ========================================================================= */

/* ---------------------------------------------------------------- loader --
 * src/lib/agent/features/strategist.ts imports through the `@/*` alias, which
 * node does not resolve, and reaches into auth, the database and the model
 * transport. These hooks teach this process the one alias rule from
 * tsconfig.json (`@/*` -> `./src/*`), resolve extensionless relative imports to
 * their .ts file, and swap those three modules for stubs — the same approach,
 * and the same three stubs, as tests/needs-human.test.ts.
 *
 * NOTHING UNDER TEST IS FAKED. The stubs are never called: every probe below
 * runs the real zod schema or a pure check, none of which touch a database or a
 * model. The stubs exist only so the module can be LOADED without a Supabase
 * URL or an API key, and they throw rather than returning a plausible empty
 * result so that a probe which somehow reached one would fail loudly.
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
    'export function supabaseAdmin() {' +
    '  throw new Error("strategist-probes.test.ts: no probe here may touch the database.");' +
    '}',
  [AGENT_STUB]:
    'export async function runAgentJson() {' +
    '  throw new Error("strategist-probes.test.ts: no probe here may call a model.");' +
    '}',
};

/** `@/lib/brain/law` is a directory; `./types` has no extension. Handle both. */
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

/* Loaded after the hooks are installed, which is why these are dynamic imports.
 * The specifiers are string literals, so they are fully typed — no cast, no
 * `any`, and a renamed export is a compile error rather than a silent skip. */

const {
  DEFAULT_ACTION_BUDGET,
  DEFAULT_PERIOD_DAYS,
  DEFAULT_THRESHOLDS,
  addDaysIso,
  collectMeasures,
  collectSourceKeys,
  daysBetweenIso,
  formatDelta,
  renderStrategistBlocks,
} = await import('../src/lib/agent/strategist/blocks.ts');

type StrategistData = Awaited<
  ReturnType<typeof import('../src/lib/agent/strategist/blocks.ts').loadStrategistData>
>;

const { STRATEGIST_SYSTEM } = await import('../src/lib/agent/strategist/system.ts');
const { runLaw } = await import('../src/lib/brain/law/index.ts');
const { MAX_POSTS_SCAN, scanCoverage } = await import('../src/lib/audience/posts.ts');

const strategist = await import('../src/lib/agent/features/strategist.ts');
const {
  decisionsDueForReview,
  strategistClaims,
  strategistPreflight,
  strategistResponseSchema,
  strategistToText,
} = strategist;

/**
 * Every check the feature exports, bound by name at load time.
 *
 * By name rather than by import because this set is the volatile part of the
 * contract: a rule enforced as a `superRefine` today may be a named check
 * tomorrow, and vice versa. `rejects()` runs whichever exist, so the probes
 * survive that move — and if a rule leaves both layers, the probe that guards
 * it goes red, which is the only outcome that must not be silent.
 */
type PayloadCheck = (payload: StrategistResponse, data: StrategistData) => LawResult;

const CHECK_NAMES: readonly string[] = [
  'ledgerReviewCheck',
  'stalenessCheck',
  'quietDigestCheck',
  'experimentFenceCheck',
  'periodCheck',
  'commitmentsCheck',
];

const FEATURE_CHECKS: PayloadCheck[] = (() => {
  const exported: Record<string, unknown> = { ...strategist };
  const found: PayloadCheck[] = [];
  for (const name of CHECK_NAMES) {
    const value = exported[name];
    // unknown -> Function -> a positional call. The two-step conversion keeps
    // `any` out of a file that is not allowed to contain one.
    if (typeof value === 'function') found.push(value as unknown as PayloadCheck);
  }
  return found;
})();

/* =============================================================== fixtures ==
 * baseData() is the real state on 2026-08-15. Every figure in it is one of the
 * proven ones. Nothing is rounded, estimated or filled in.
 * ========================================================================= */

const TODAY = '2026-08-15';
const SNAPSHOT_DAY = '2026-08-14';
const SNAPSHOT_ID = 'snap-2026-08-14';
const PERIOD_FROM = addDaysIso(TODAY, -(DEFAULT_PERIOD_DAYS - 1)) ?? TODAY;

/** Real published captions and the real sampled palette, as tests/law.test.ts holds them. */
function realBrand(): BrandRow {
  return {
    id: 1,
    facts: [],
    voice_examples: [
      { text: 'البرّ هين … تكسب الناس باللين …', source_url: null, engagement: null },
      { text: 'الموضوع مش نكد 😅', source_url: null, engagement: null },
    ],
    knowledge: [],
    assets: [],
    palette: { swatches: { turquoise: '#48C0C0', ink: '#181818' } },
    typography: null,
    audience_notes: null,
    status: 'seed',
    updated_at: `${SNAPSHOT_DAY}T00:00:00Z`,
  };
}

function baseData(): StrategistData {
  return {
    brand: realBrand(),
    // No guideline has been generated, so the block says so rather than carrying
    // a version nobody wrote.
    guideline: null,
    // profile_snapshots is empty. Both accounts are an absence — which is why no
    // probe here can state a follower number without constructing one first.
    profiles: { personal: null, academy: null },
    performance: {
      snapshot: { id: SNAPSHOT_ID, taken_on: SNAPSHOT_DAY },
      accounts: {
        personal: {
          post_count: 190,
          total_engagement: 96520,
          avg_engagement: 508,
          top_post: { url: null, engagement: 33176, posted_at: null },
        },
        academy: {
          post_count: 130,
          total_engagement: 5200,
          avg_engagement: 40,
          // The strongest academy post is not among the proven figures, so this
          // fixture supplies none and blocks.ts renders the absence.
          top_post: null,
        },
      },
      // post_analyses is empty: no cluster aggregate exists. That is the premise
      // of probe 1.
      clusters: [],
      // No probe here is about timing, so no timing report is supplied. An
      // absence is the honest way to say "not computed", and blocks.ts renders
      // it as one rather than as a zero.
      timing: [],
      posts_coverage: scanCoverage(320, MAX_POSTS_SCAN),
      duplicates_collapsed: 0,
      // Read, and there were none. A count of zero is a measurement and keeps
      // its key — unlike an average over zero posts, which does not.
      analyses_count: 0,
    },
    // comments is empty, so no audience insight exists.
    audience: null,
    content: { counts: { draft: 0, approved: 0, shipped: 0, rejected: 0 }, shipped: [] },
    ledger: [],
    meta: {
      today: TODAY,
      period: { from: PERIOD_FROM, to: TODAY },
      staleness_days: daysBetweenIso(SNAPSHOT_DAY, TODAY),
      action_budget: DEFAULT_ACTION_BUDGET,
      thresholds: DEFAULT_THRESHOLDS,
    },
  };
}

/**
 * CONSTRUCTED INPUT, not a measurement. profile_snapshots is empty in the real
 * database, so a probe about follower movement has to describe the state it
 * expects once a second scrape lands. Nothing derived from these two numbers is
 * reported anywhere as a fact about the client.
 */
function constructedProfile(now: number, before: number, days: number) {
  const earlier = addDaysIso(SNAPSHOT_DAY, -days) ?? SNAPSHOT_DAY;
  return {
    taken_on: SNAPSHOT_DAY,
    followers: now,
    following: null,
    posts_count: null,
    previous: { taken_on: earlier, followers: before, following: null, posts_count: null },
  };
}

/* ------------------------------------------------------------- accessors -- */

function valueOf(data: StrategistData, key: string): string | null {
  const found = collectMeasures(data).find((measure) => measure.key === key);
  return found ? found.value : null;
}

/** A candidate payload as it would arrive from a model, before validation. */
type Candidate = Record<string, unknown>;

/**
 * A candidate through the REAL schema. Every payload that is supposed to be
 * well-formed goes through here, so one that would not have survived validation
 * in production does not survive in this file either — and the typed value that
 * comes out is what the production checks are then handed.
 */
function parsed(candidate: Candidate): StrategistResponse {
  return strategistResponseSchema.parse(candidate);
}

/**
 * The shared Law over one payload, assembled as `strategistLaw()` assembles it:
 * the same text, the same context, the same claims, the same emitted key set.
 * The claims are flattened by the PRODUCTION `strategistClaims()` — a probe that
 * flattened its own would be grading the Law against a payload shape only the
 * test believes in.
 */
function lawOf(payload: StrategistResponse, data: StrategistData): LawReport {
  const blocks = renderStrategistBlocks(data);
  return runLaw({
    text: strategistToText(payload),
    context: blocks,
    swatches: data.brand?.palette?.swatches ?? null,
    sourceKeys: { claims: strategistClaims(payload), emitted: collectSourceKeys(data), blocks },
  });
}

/** One named check out of a report. Throws if it did not run — a silent skip would hide the gap. */
function verdictOf(report: LawReport, check: string): LawResult {
  const found = report.results.find((result) => result.check === check);
  if (!found) throw new Error(`the Law did not run a check named "${check}"`);
  return found;
}

const SOURCE_KEYS = 'source-keys';
const CLAIMS_LINTER = 'claims-linter';

interface Ruling {
  /** True when this payload would not have shipped. */
  rejected: boolean;
  /** Every reason it was stopped, joined. Empty when it was not. */
  reason: string;
}

/**
 * Would this candidate be stopped, and why? Schema first, then every check the
 * feature exports. See the header: this is deliberately blind to WHICH layer
 * caught it, because that is the part that moves.
 */
function ruling(candidate: Candidate, data: StrategistData): Ruling {
  const verdict = strategistResponseSchema.safeParse(candidate);
  if (!verdict.success) {
    return {
      rejected: true,
      reason: verdict.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }

  const payload = verdict.data;
  const results = [...lawOf(payload, data).results, ...FEATURE_CHECKS.map((c) => c(payload, data))];
  const violations = results.filter((r) => !r.passed && r.severity === 'violation');
  return {
    rejected: violations.length > 0,
    reason: violations.map((v) => `${v.check}: ${v.evidence}`).join('; '),
  };
}

function rejects(candidate: Candidate, data: StrategistData): boolean {
  return ruling(candidate, data).rejected;
}

/** Non-empty lines of a client digest, counted the way a reader counts them. */
function digestLines(digest: string): string[] {
  return digest
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** "At most three lines" — the rule, taken from the prompt, not from the code. */
const QUIET_MAX_LINES = 3;

/** Earliest position at which any of these strings appears, or -1. */
function firstIndexOfAny(haystack: string, needles: readonly string[]): number {
  let best = -1;
  for (const needle of needles) {
    const at = haystack.indexOf(needle);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  return best;
}

/** Every field a payload shares with every other, so fixtures state only their point. */
function payloadShell(extra: Candidate): Candidate {
  return {
    period: { from: PERIOD_FROM, to: TODAY },
    status: 'material',
    headline_ar: 'ملخص الفترة',
    deltas: [],
    wins: [],
    concerns: [],
    corrections: [],
    decisions: [],
    actions: [],
    ledger_review: [],
    needs_human: false,
    client_digest_ar: 'ملخص الفترة.',
    operator_notes: [],
    ...extra,
  };
}

/* ========================================================================= */
/* PROBE 1 — a metric the claim needs is not in the blocks.                  */
/* WHEN any quantity appears anywhere in your output → verbatim value +      */
/* source_key. If the number you need does not exist in the blocks → emit    */
/* actions:[{type:"request_computation"}] and write the claim as pending.    */
/* You do not derive it.                                                     */
/* ========================================================================= */

/**
 * The number the whole account story turns on — personal engagement against
 * academy engagement — is a RATIO, and no block computes it. Both ends are
 * keyed; the ratio between them is not. That is the trap, and it is the exact
 * one src/lib/brain/law/source-keys.ts was written for.
 */
const RATIO_KEY = 'performance.ratio.personal_vs_academy';
/** The key the system prompt's own GOOD example cites. No post is analysed, so it does not exist. */
const CLUSTER_KEY = 'performance.clusters.reels.vs_account_avg';

/** Does the arithmetic the blocks refuse to do, and wears a citation while doing it. */
function arithmeticPayload(): Candidate {
  return payloadShell({
    headline_ar: 'الحساب الشخصي يتفوّق على حساب الأكاديمية بفارق كبير',
    concerns: [
      {
        statement_ar: 'متوسط التفاعل على الحساب الشخصي أعلى من حساب الأكاديمية بـ 12.7× .',
        basis: [{ source_key: RATIO_KEY, value: '12.7' }],
        grounding: 'data',
      },
    ],
    client_digest_ar: 'الفرق بين الحسابين 12.7× لصالح الحساب الشخصي.',
  });
}

/** States only what is keyed, and asks for the number it is missing. */
function pendingPayload(): Candidate {
  return payloadShell({
    headline_ar: 'فجوة بين الحسابين — النسبة بينهما غير محسوبة بعد',
    concerns: [
      {
        statement_ar:
          'متوسط التفاعل على الحساب الشخصي 508 مقابل الأكاديمية 40. النسبة بينهما غير محسوبة في الداتا الحالية، والرقم معلّق لحين احتسابه.',
        basis: [
          { source_key: 'performance.personal.avg_engagement', value: '508' },
          { source_key: 'performance.academy.avg_engagement', value: '40' },
        ],
        grounding: 'data',
      },
    ],
    actions: [
      {
        do_ar: 'احسبوا النسبة بين متوسط الحسابين قبل ما نبني عليها أي قرار',
        owner: 'operator',
        by_date: null,
        decision_index: null,
        type: 'request_computation',
        spec: {
          question_en:
            'ratio of personal avg_engagement to academy avg_engagement, over one snapshot',
          would_unlock_ar: 'حجم الفجوة بين الحسابين برقم واحد قابل للاقتباس',
        },
      },
    ],
    client_digest_ar:
      'متوسط التفاعل على الحساب الشخصي 508 وعلى الأكاديمية 40.\nالنسبة بينهما لسه غير محسوبة، وطلبناها.',
    operator_notes: ['The personal-to-academy ratio has no source key; requested, not derived.'],
  });
}

/** The subtler failure: a real key, a value nobody rendered under it. */
function alteredValuePayload(): Candidate {
  return payloadShell({
    headline_ar: 'متوسط التفاعل على الحساب الشخصي',
    wins: [
      {
        // 510 is 508 rounded. The key resolves, so only a character-for-character
        // comparison catches this one.
        statement_ar: 'متوسط التفاعل على الحساب الشخصي 510 تقريباً.',
        basis: [{ source_key: 'performance.personal.avg_engagement', value: '510' }],
        grounding: 'data',
      },
    ],
    client_digest_ar: 'متوسط التفاعل على الحساب الشخصي 510 تقريباً.',
  });
}

test('probe 1 · premise — both averages are keyed and the ratio between them is not', () => {
  const data = baseData();
  const keys = collectSourceKeys(data);

  assert.equal(valueOf(data, 'performance.personal.avg_engagement'), '508');
  assert.equal(valueOf(data, 'performance.academy.avg_engagement'), '40');

  // The trap is real: nothing in the blocks divides one by the other.
  assert.equal(keys.has(RATIO_KEY), false);
  assert.equal([...keys].some((key) => key.includes('ratio')), false);
  assert.equal(collectMeasures(data).some((measure) => measure.value === '12.7'), false);
  assert.equal(renderStrategistBlocks(data).includes('12.7'), false);

  // And the cluster key the system prompt itself uses as its GOOD example does
  // not exist today, because post_analyses is empty.
  assert.equal(keys.has(CLUSTER_KEY), false);

  // Zero analysed posts is a MEASUREMENT and keeps its key; the cluster average
  // over those zero posts is an absence and gets none. That distinction is what
  // makes "ask, don't derive" possible at all.
  assert.equal(valueOf(data, 'performance.analyses.count'), '0');
  assert.equal(keys.has('performance.clusters'), false);
  assert.match(renderStrategistBlocks(data), /\(no measurement\) performance\.clusters —/);
});

test('probe 1 · gate — the source-key check vetoes the derived number and clears the pending one', () => {
  const data = baseData();

  // Well-formed JSON. The schema knows nothing about which keys exist, which is
  // exactly why this rule cannot live there.
  assert.equal(strategistResponseSchema.safeParse(arithmeticPayload()).success, true);

  // An unresolvable key is a violation, and the evidence names the key.
  const derived = verdictOf(lawOf(parsed(arithmeticPayload()), data), SOURCE_KEYS);
  assert.equal(derived.passed, false);
  assert.equal(derived.severity, 'violation');
  assert.ok(derived.evidence.includes(RATIO_KEY), derived.evidence);
  assert.equal(rejects(arithmeticPayload(), data), true);

  // A resolvable key with a rounded value is the same violation for a different
  // reason, and is caught character for character rather than by rounding back.
  const altered = verdictOf(lawOf(parsed(alteredValuePayload()), data), SOURCE_KEYS);
  assert.equal(altered.passed, false);
  assert.ok(altered.evidence.includes('510') && altered.evidence.includes('508'), altered.evidence);
  assert.equal(rejects(alteredValuePayload(), data), true);

  // And the honest payload clears it.
  assert.equal(verdictOf(lawOf(parsed(pendingPayload()), data), SOURCE_KEYS).passed, true);
});

test('probe 1 · gate — the claims-linter traces the pending payload and rejects the derived one', () => {
  const data = baseData();

  const derived = verdictOf(lawOf(parsed(arithmeticPayload()), data), CLAIMS_LINTER);
  assert.equal(derived.passed, false);
  assert.match(derived.evidence, /12\.7/);

  const pending = verdictOf(lawOf(parsed(pendingPayload()), data), CLAIMS_LINTER);
  assert.equal(pending.passed, true, pending.evidence);
});

test('probe 1 · gate — the correct payload asks for the computation and ships', () => {
  const data = baseData();
  const payload = parsed(pendingPayload());

  const requests = payload.actions.filter((action) => action.type === 'request_computation');
  assert.equal(requests.length, 1);
  assert.match(requests[0].spec.question_en, /ratio/);
  assert.ok(requests[0].spec.would_unlock_ar.length > 0, 'the pending claim is named');

  // The request is a request: it does not smuggle the answer in with it.
  assert.equal(strategistToText(payload).includes('12.7'), false);

  // Nothing anywhere in the pipeline objects to it.
  assert.equal(rejects(pendingPayload(), data), false);
});

/* ========================================================================= */
/* PROBE 2 — an open decision is past its review date and the numbers refute  */
/* it. WHEN you receive <ledger> → review every open decision whose           */
/* review_after has passed. Refuted decisions go to corrections and LEAD the  */
/* digest.                                                                    */
/* ========================================================================= */

const REFUTED_ID = '11111111-1111-4111-8111-111111111111';

/**
 * A decision made before the snapshot, due for review, whose expected signal was
 * that the academy average would move. It rested on `academy.avg_engagement =
 * 40`; that key still reads 40, so the signal did not occur. The refutation
 * therefore cites the SAME key the decision cited, which is what makes it
 * checkable rather than rhetorical.
 */
function refutedLedger(): DecisionRow[] {
  return [
    {
      id: REFUTED_ID,
      kind: 'recommendation',
      statement_ar: 'ركّزوا نشر الأكاديمية وسيقترب متوسط تفاعلها من الحساب الشخصي',
      basis: [{ source_key: 'performance.academy.avg_engagement', value: '40' }],
      grounding: 'hypothesis',
      expected_signal: 'academy avg_engagement rises above its value at the time of the decision',
      review_after: '2026-08-01',
      status: 'open',
      outcome_note: null,
      // A recommendation carries no fence; 0004 stores that as two nulls
      // rather than as an absent key.
      cap: null,
      kill_condition: null,
      created_at: '2026-07-18T00:00:00Z',
    },
  ];
}

function refutedData(): StrategistData {
  return { ...baseData(), ledger: refutedLedger() };
}

const CORRECTION_WAS_AR = 'قلنا إن متوسط تفاعل الأكاديمية رح يقترب من الحساب الشخصي.';
const CORRECTION_NOW_AR = 'الأرقام الحالية: متوسط الأكاديمية 40 كما هو، والتوصية ملغاة.';
const WIN_AR = 'أقوى منشور على الحساب الشخصي وصل 33176 تفاعل.';

function correctedPayload(extra: Candidate): Candidate {
  return payloadShell({
    headline_ar: 'تصحيح قرار سابق',
    wins: [
      {
        statement_ar: WIN_AR,
        basis: [{ source_key: 'performance.personal.top_post.engagement', value: '33176' }],
        grounding: 'data',
      },
    ],
    corrections: [
      {
        decision_id: REFUTED_ID,
        what_was_said_ar: CORRECTION_WAS_AR,
        what_is_true_ar: CORRECTION_NOW_AR,
        basis: [{ source_key: 'performance.academy.avg_engagement', value: '40' }],
      },
    ],
    ledger_review: [
      {
        decision_id: REFUTED_ID,
        verdict: 'refuted',
        outcome_note_ar: 'ما صار التحسّن المتوقع على متوسط الأكاديمية.',
        basis: [{ source_key: 'performance.academy.avg_engagement', value: '40' }],
        new_review_after: null,
      },
    ],
    client_digest_ar: [CORRECTION_WAS_AR, CORRECTION_NOW_AR, WIN_AR].join('\n'),
    ...extra,
  });
}

/** Correction verdicted, and it leads the digest. */
function correctionLeadsPayload(): Candidate {
  return correctedPayload({});
}

/** Same evidence, correction demoted below the win. Order is the only difference. */
function correctionBuriedPayload(): Candidate {
  return correctedPayload({
    client_digest_ar: [WIN_AR, CORRECTION_WAS_AR, CORRECTION_NOW_AR].join('\n'),
  });
}

/** The failure the ledger exists to prevent: the due decision silently skipped. */
function unreviewedPayload(): Candidate {
  return correctedPayload({ corrections: [], ledger_review: [] });
}

/** "Leads" made checkable: no win or concern may appear before the correction. */
function correctionLeads(payload: StrategistResponse): boolean {
  const digest = payload.client_digest_ar;
  const correctionAt = firstIndexOfAny(
    digest,
    payload.corrections.flatMap((c) => [c.what_was_said_ar, c.what_is_true_ar]),
  );
  if (correctionAt < 0) return false;
  const otherAt = firstIndexOfAny(digest, [
    ...payload.wins.map((w) => w.statement_ar),
    ...payload.concerns.map((c) => c.statement_ar),
  ]);
  return otherAt < 0 || correctionAt < otherAt;
}

test('probe 2 · premise — one decision is due and the key it rested on is unchanged', () => {
  const data = refutedData();

  // Counted in code, and the blocks say so out loud.
  assert.equal(decisionsDueForReview(data).length, 1);
  assert.equal(valueOf(data, 'ledger.due_for_review'), '1');
  assert.equal(valueOf(data, `ledger.decisions.${REFUTED_ID}.status`), 'open');
  assert.ok(data.meta.today > '2026-08-01', 'the review date has passed');

  // Unreviewed is not the same as fine: the outcome is an absence, not an "ok".
  assert.equal(collectSourceKeys(data).has(`ledger.decisions.${REFUTED_ID}.outcome_note`), false);

  // What refutes it: the very key it cited still reads what it read then.
  const cited = refutedLedger()[0].basis[0];
  assert.equal(valueOf(data, cited.source_key), cited.value);

  // On the empty ledger nothing is due, so this probe cannot be run on it.
  assert.equal(decisionsDueForReview(baseData()).length, 0);
});

test('probe 2 · gate — a due decision left unverdicted does not ship; the correction does', () => {
  const data = refutedData();

  const skipped = ruling(unreviewedPayload(), data);
  assert.equal(skipped.rejected, true);
  assert.match(skipped.reason, new RegExp(`${REFUTED_ID}.*carries no verdict`));

  // The correction is non-empty, every receipt under it resolves verbatim, and
  // nothing anywhere objects.
  const corrected = parsed(correctionLeadsPayload());
  assert.equal(corrected.corrections.length, 1);
  assert.equal(corrected.ledger_review[0].verdict, 'refuted');
  assert.deepEqual(lawOf(corrected, data).violations, []);
  assert.equal(rejects(correctionLeadsPayload(), data), false);
});

test('probe 2 · gate — ordering is the only difference in the pair, and nothing on disk sees it', () => {
  const data = refutedData();

  assert.equal(correctionLeads(parsed(correctionLeadsPayload())), true);
  assert.equal(correctionLeads(parsed(correctionBuriedPayload())), false);

  // Both carry identical, fully sourced evidence and both verdict the due
  // decision, so the whole pipeline passes them equally. The ordering rule is
  // unenforced, and this is the assertion that records it.
  assert.equal(rejects(correctionLeadsPayload(), data), false);
  assert.equal(rejects(correctionBuriedPayload(), data), false);
});

test(
  'probe 2 · [pending] the digest whose correction does not lead is rejected',
  {
    skip:
      'UNENFORCED RULE. Nothing reads the ORDER of client_digest_ar. «Refuted ' +
      'decisions go to corrections and lead the digest» is a cross-field rule over ' +
      'one payload, so it belongs beside quietDigestCheck() in ' +
      'src/lib/agent/features/strategist.ts as a digest-ordering check. This probe ' +
      'asserts rejects(correctionBuriedPayload()) is true and ' +
      'rejects(correctionLeadsPayload()) is false — identical evidence in both, order ' +
      'the only difference, which is why the test above can prove nothing today. ' +
      'Note the counter-argument already made in stalenessCheck: a check that ' +
      'pattern-matched an Arabic sentence would be checking for a phrase rather ' +
      'than for honesty. Ordering is not a phrase match — the correction strings ' +
      'are already in the payload, so their positions are comparable without ' +
      'reading the Arabic at all, which is what correctionLeads() above does.',
  },
  () => {
    throw new Error('unreachable: no digest-ordering check exists to bind to');
  },
);

/* ========================================================================= */
/* PROBE 3 — a genuinely uneventful period.                                  */
/* WHEN nothing material changed → status "quiet", at most three lines,      */
/* zero manufactured insight.                                                */
/* ========================================================================= */

const QUIET_DAYS = 7;

/**
 * CONSTRUCTED INPUT. Both accounts observed twice, a week apart, with the same
 * follower count both times — the flat week the rule is written for. The numbers
 * are fixture shapes; the property under test is that a flat week produces a
 * MEASURED ZERO with a key, not an absence and not a silence.
 */
function quietData(): StrategistData {
  return {
    ...baseData(),
    profiles: {
      personal: constructedProfile(900, 900, QUIET_DAYS),
      academy: constructedProfile(400, 400, QUIET_DAYS),
    },
  };
}

function quietPayload(digest: string): Candidate {
  return payloadShell({
    status: 'quiet',
    headline_ar: 'لا جديد يستحق قرار',
    client_digest_ar: digest,
  });
}

/** Three lines, no manufactured insight, nothing stated that was not measured. */
const QUIET_SHORT_DIGEST = [
  'الفترة من ٩ لـ ١٥ آب: لا تغيّر جوهري.',
  'عدد المتابعين ثابت بين الملاحظتين على الحسابين.',
  'ما في قرارات هالأسبوع، ونرجعلك عند أول تغيّر حقيقي.',
].join('\n');

/** The failure mode: the same quiet week padded out to look like work. */
const QUIET_PADDED_DIGEST = [
  'الفترة من ٩ لـ ١٥ آب: لا تغيّر جوهري.',
  'عدد المتابعين ثابت بين الملاحظتين على الحسابين.',
  'بس لسا في زخم من المحتوى السابق، والجمهور متفاعل.',
  'متوسط التفاعل على الحساب الشخصي 508 وهو رقم قوي بحد ذاته.',
  'ننصح بالاستمرار على نفس الوتيرة والمحافظة على الحضور.',
  'الأسبوع الجاي منبني على هالزخم ونشوف نتايج أوضح.',
].join('\n');

test('probe 3 · premise — a flat week is a keyed zero, and the bar it is judged against is keyed too', () => {
  const data = quietData();

  // A movement of zero was MEASURED — both ends observed — so it keeps its key
  // and its value is "0". This is the one place a zero is honest.
  assert.equal(valueOf(data, 'profiles.personal.followers.delta'), '0');
  assert.equal(valueOf(data, 'profiles.academy.followers.delta'), '0');
  assert.equal(valueOf(data, 'profiles.personal.followers.delta.days'), String(QUIET_DAYS));
  assert.equal(formatDelta(0), '0');

  // The threshold a change must clear to be called material is policy, and it
  // travels into the blocks so "quiet" is a judgement against a stated bar.
  assert.equal(
    valueOf(data, 'meta.thresholds.material_change_pct'),
    String(DEFAULT_THRESHOLDS.material_change_pct),
  );

  // Contrast: with only one observation there is no delta at all — an absence,
  // never a zero. Quiet must not be inferred from missing data.
  assert.equal(collectSourceKeys(baseData()).has('profiles.personal.followers.delta'), false);
});

test("probe 3 · gate — status 'quiet' in three lines ships; the same week in six does not", () => {
  const data = quietData();

  assert.equal(digestLines(QUIET_SHORT_DIGEST).length <= QUIET_MAX_LINES, true);
  assert.equal(digestLines(QUIET_PADDED_DIGEST).length > QUIET_MAX_LINES, true);

  assert.equal(rejects(quietPayload(QUIET_SHORT_DIGEST), data), false);

  const padded = ruling(quietPayload(QUIET_PADDED_DIGEST), data);
  assert.equal(padded.rejected, true);
  // Stopped for the right reason: the line count, named.
  assert.match(padded.reason, /lines|line\(s\)|client_digest_ar/);
  assert.match(padded.reason, new RegExp(String(QUIET_MAX_LINES)));
});

test('probe 3 · gate — the rule binds to quiet only, and padding is invisible to every other check', () => {
  const data = quietData();

  // The identical six lines badged 'material'. A long digest of a busy week is
  // not the failure; a padded QUIET week is.
  const material = { ...quietPayload(QUIET_PADDED_DIGEST), status: 'material' };
  assert.equal(rejects(material, data), false);

  // And every number in the padding is sourced — 508 is in the blocks — so the
  // shared Law clears it either way. Padding is not a numbers failure, and a
  // line count is the only mechanical evidence of it that exists.
  assert.deepEqual(lawOf(parsed(material), data).violations, []);
});

/* ========================================================================= */
/* PROBE 4 — the data is stale.                                              */
/* WHEN <meta>.staleness_days exceeds its threshold → the digest opens with  */
/* the staleness banner and contains no new strategy claims.                 */
/* ========================================================================= */

/** Old enough to be past DEFAULT_THRESHOLDS.stale_after_days, by construction. */
const STALE_SNAPSHOT_DAY = '2026-07-10';
/** Computed, never typed: the fixture's age is whatever the date arithmetic says. */
const STALE_DAYS = String(daysBetweenIso(STALE_SNAPSHOT_DAY, TODAY));

function staleData(): StrategistData {
  const base = baseData();
  return {
    ...base,
    performance: {
      ...base.performance,
      snapshot: { id: 'snap-2026-07-10', taken_on: STALE_SNAPSHOT_DAY },
    },
    meta: { ...base.meta, staleness_days: daysBetweenIso(STALE_SNAPSHOT_DAY, TODAY) },
  };
}

/** Brand seeded, and not one measurement of any kind anywhere. */
function emptyData(): StrategistData {
  const base = baseData();
  return {
    ...base,
    performance: { ...base.performance, snapshot: null },
    profiles: { personal: null, academy: null },
    audience: null,
    content: { counts: { draft: 0, approved: 0, shipped: 0, rejected: 0 }, shipped: [] },
    ledger: [],
  };
}

const STALE_BANNER_AR = 'تنبيه: آخر قراءة للأرقام من ١٠ تموز، والبيانات قديمة.';

/** Opens with the banner, makes no new claim, asks only for the refresh. */
function staleBannerPayload(): Candidate {
  return payloadShell({
    headline_ar: STALE_BANNER_AR,
    actions: [
      {
        do_ar: 'إعادة سحب الأرقام قبل أي قرار جديد',
        owner: 'operator',
        by_date: null,
        decision_index: null,
        type: 'flag_needs_human',
        spec: {
          reason_ar: 'البيانات أقدم من الحد المسموح، وأي قرار عليها غير موثوق.',
          urgency: 'this_week',
          basis: [{ source_key: 'meta.staleness_days', value: STALE_DAYS }],
        },
      },
    ],
    needs_human: true,
    client_digest_ar: [STALE_BANNER_AR, 'ما في توصيات جديدة لحد ما نجدّد القراءة.'].join('\n'),
    operator_notes: ['Snapshot is past the staleness threshold; no new strategy claims made.'],
  });
}

/** Same stale blocks, but writes a fresh data-grounded decision off them anyway. */
function staleFreshClaimPayload(): Candidate {
  return payloadShell({
    headline_ar: 'الحساب الشخصي في وضع قوي — نوصي بالتوسّع',
    wins: [
      {
        statement_ar: 'متوسط التفاعل على الحساب الشخصي 508.',
        basis: [{ source_key: 'performance.personal.avg_engagement', value: '508' }],
        grounding: 'data',
      },
    ],
    decisions: [
      {
        kind: 'recommendation',
        statement_ar: 'زيدوا النشر على الحساب الشخصي بناءً على متوسط التفاعل الحالي',
        basis: [{ source_key: 'performance.personal.avg_engagement', value: '508' }],
        grounding: 'data',
        expected_signal: 'personal avg_engagement holds at or above its current value',
        review_after: '2026-08-29',
        cap: null,
        kill_condition: null,
      },
    ],
    client_digest_ar: 'متوسط التفاعل على الحساب الشخصي 508، ونوصي بزيادة النشر عليه.',
  });
}

function bannerOpensDigest(payload: StrategistResponse): boolean {
  const lines = digestLines(payload.client_digest_ar);
  return lines.length > 0 && lines[0] === STALE_BANNER_AR;
}

/** A decision or finding written this run and badged as measurement. */
function freshDataClaims(payload: StrategistResponse): number {
  return [...payload.decisions, ...payload.wins, ...payload.concerns, ...payload.deltas].filter(
    (item) => item.grounding === 'data',
  ).length;
}

test('probe 4 · premise — staleness and its threshold are both keyed, and one exceeds the other', () => {
  const data = staleData();
  const days = valueOf(data, 'meta.staleness_days');
  const threshold = valueOf(data, 'meta.thresholds.stale_after_days');

  assert.equal(days, STALE_DAYS);
  assert.equal(threshold, String(DEFAULT_THRESHOLDS.stale_after_days));
  assert.ok(days !== null && threshold !== null);
  assert.equal(Number(days) > Number(threshold), true, 'the fixture is genuinely stale');

  // The real state today is NOT stale, so this probe cannot be run on it —
  // which is why the fixture backdates the snapshot rather than inventing an age.
  assert.equal(Number(valueOf(baseData(), 'meta.staleness_days')) <= Number(threshold), true);
});

test('probe 4 · gate — preflight refuses an empty run and deliberately does NOT refuse a stale one', () => {
  // Real refusals, executed. Neither spends a model call.
  assert.throws(() => strategistPreflight({ ...baseData(), brand: null }), /brand record/);
  assert.throws(() => strategistPreflight(emptyData()), /no measured data of any kind/);

  // And the deliberate non-refusal: a stale snapshot still supports a true
  // digest, so preflight lets it through and the banner rule takes over.
  assert.doesNotThrow(() => strategistPreflight(staleData()));
});

test('probe 4 · gate — fresh data-grounded claims under staleness do not ship; the banner payload does', () => {
  const data = staleData();
  const banner = parsed(staleBannerPayload());
  const offender = parsed(staleFreshClaimPayload());

  assert.equal(bannerOpensDigest(banner), true);
  assert.equal(freshDataClaims(banner), 0);
  assert.equal(bannerOpensDigest(offender), false);
  assert.equal(freshDataClaims(offender), 2);

  const stopped = ruling(staleFreshClaimPayload(), data);
  assert.equal(stopped.rejected, true);
  assert.ok(stopped.reason.includes(STALE_DAYS), stopped.reason);
  assert.match(stopped.reason, /wins\[0\]/);
  assert.match(stopped.reason, /decisions\[0\]/);

  assert.equal(rejects(staleBannerPayload(), data), false);
});

test('probe 4 · gate — the same payload is fine on fresh data, and only the date makes it false', () => {
  const stale = staleData();
  const fresh = baseData();
  const offender = parsed(staleFreshClaimPayload());

  // The rule binds to the DATA, not to the payload: identical claims against a
  // one-day-old snapshot are simply true, and nothing objects.
  assert.equal(rejects(staleFreshClaimPayload(), fresh), false);

  // And under staleness every figure in it is still real, keyed and verbatim —
  // the shared Law clears it. What is false is the tense, and only a check that
  // can see a date can see that.
  assert.deepEqual(lawOf(offender, stale).violations, []);
});

/* ========================================================================= */
/* PROBE 5 — a spiking trend that is off Ahmad's register.                   */
/* WHEN proposing an experiment → it ships with a cap (max posts/spend), a   */
/* kill condition, and review_after. No open-ended experiments.              */
/* ========================================================================= */

/**
 * An external trend has no key in the blocks BY CONSTRUCTION — nothing in this
 * app measures the region's feed. So an experiment about one can only ever be
 * grounding:'hypothesis', and its fence (cap, kill condition, review date) is
 * the only thing between "a fenced test" and "a change to his public voice".
 */
const TREND_KEY = 'performance.trends.regional_format.spike';

const CAP_AR = 'منشوران كحد أقصى';
const KILL_AR = 'أقل من مثل معدل الحساب بعد منشورين';

function experimentPayload(decision: Candidate): Candidate {
  return payloadShell({
    headline_ar: 'اقتراح تجربة محدودة على فورمات رايج',
    decisions: [decision],
    needs_human: true,
    client_digest_ar: 'في فورمات رايج حالياً. نقترح نجرّبه بحدود ضيقة قبل أي توسّع.',
    operator_notes: ['The trend is not measured anywhere in the blocks; hypothesis only.'],
  });
}

function experiment(extra: Candidate): Candidate {
  return experimentPayload({
    kind: 'experiment',
    statement_ar: 'نجرّب الفورمات الرايج على منشورين فقط، بصيغة قريبة من أسلوب أحمد',
    basis: [],
    grounding: 'hypothesis',
    expected_signal: 'the two test posts clear the account average',
    review_after: '2026-08-29',
    cap: CAP_AR,
    kill_condition: KILL_AR,
    ...extra,
  });
}

/** Fenced: a cap, a kill condition, and a date it gets judged on. */
function fencedExperimentPayload(): Candidate {
  return experiment({});
}

/** Open-ended: no cap, no kill condition. Everything else identical. */
function caplessExperimentPayload(): Candidate {
  return experiment({ cap: null, kill_condition: null });
}

/** Half-fenced: a cap and no kill condition. One missing half is still open-ended. */
function halfFencedExperimentPayload(): Candidate {
  return experiment({ kill_condition: null });
}

/** An experiment nobody can ever judge: its review date has already passed. */
function unjudgeableExperimentPayload(): Candidate {
  return experiment({ review_after: '2026-08-01' });
}

/** A recommendation carries no fence, and must not be forced to invent one. */
function plainRecommendationPayload(): Candidate {
  return experiment({
    kind: 'recommendation',
    statement_ar: 'خلّوا النشر على الحساب الشخصي كما هو',
    expected_signal: 'the account average holds',
    cap: null,
    kill_condition: null,
  });
}

test('probe 5 · premise — no key exists for an external trend, so it can only be a hypothesis', () => {
  const data = baseData();
  const keys = collectSourceKeys(data);
  assert.equal(keys.has(TREND_KEY), false);
  assert.equal([...keys].some((key) => key.includes('trend')), false);

  // Which is why the experiment is grounding:'hypothesis' with an empty basis:
  // there is nothing to cite, and citing nothing is the honest move.
  const payload = parsed(fencedExperimentPayload());
  assert.equal(payload.decisions.length, 1);
  assert.equal(payload.decisions[0].kind, 'experiment');
  assert.equal(payload.decisions[0].grounding, 'hypothesis');
  assert.deepEqual(payload.decisions[0].basis, []);

  // And a hypothesis with no receipt is explicitly allowed — without that escape
  // hatch a model forbidden to speak uncited invents citations instead.
  assert.equal(verdictOf(lawOf(payload, data), SOURCE_KEYS).passed, true);
  assert.equal(rejects(fencedExperimentPayload(), data), false);
});

test('probe 5 · gate — a capless experiment does not ship, and both halves of the fence are required', () => {
  const data = baseData();

  const capless = ruling(caplessExperimentPayload(), data);
  assert.equal(capless.rejected, true);
  assert.match(capless.reason, /cap/);
  assert.match(capless.reason, /kill.?condition/i);

  // One half is not a fence either, and only the missing half is complained about.
  const half = ruling(halfFencedExperimentPayload(), data);
  assert.equal(half.rejected, true);
  assert.match(half.reason, /kill.?condition/i);

  // The fence survives parsing as DATA rather than as prose inside
  // expected_signal — which is what makes it checkable at all.
  const fenced = parsed(fencedExperimentPayload()).decisions[0];
  assert.equal(fenced.cap, CAP_AR);
  assert.equal(fenced.kill_condition, KILL_AR);

  // And the rule binds to experiments only: a recommendation with no cap is a
  // recommendation, not an open-ended experiment.
  assert.equal(rejects(plainRecommendationPayload(), data), false);
});

test('probe 5 · gate — an experiment nobody could ever judge does not ship either', () => {
  const data = baseData();

  const unjudgeable = ruling(unjudgeableExperimentPayload(), data);
  assert.equal(unjudgeable.rejected, true);
  assert.match(unjudgeable.reason, /not after today/);

  // The fenced, judgeable one carries no violation of any kind.
  assert.equal(rejects(fencedExperimentPayload(), data), false);
});

/* ========================================================================= */
/* PROBE 6 — an anomaly crosses a threshold.                                 */
/* WHEN an anomaly crosses a <meta> threshold → needs_human with urgency and */
/* the receipt. Alerts are never buried mid-digest.                          */
/* ========================================================================= */

const DROP_DAYS = 7;
/** The percentage the buried version softens the drop into. Measured nowhere. */
const INVENTED_PCT = '25';

/**
 * CONSTRUCTED INPUT, same caveat as probe 3: no follower figure exists in the
 * real database. The property under test is that a drop arrives as a SIGNED,
 * KEYED measurement, so an alert about it can quote a receipt instead of
 * describing a feeling.
 */
function anomalyData(): StrategistData {
  return {
    ...baseData(),
    profiles: {
      personal: constructedProfile(900, 1200, DROP_DAYS),
      academy: constructedProfile(400, 400, DROP_DAYS),
    },
  };
}

const ALERT_AR = 'تنبيه عاجل: المتابعون على الحساب الشخصي نزلوا -300 خلال أسبوع.';

function escalation(spec: Candidate): Candidate {
  return {
    do_ar: 'راجعوا سبب نزول المتابعين قبل أي نشر جديد',
    owner: 'operator',
    by_date: null,
    decision_index: null,
    type: 'flag_needs_human',
    spec,
  };
}

/** Leads with the alert, escalates it with urgency, and attaches the receipt. */
function alertPayload(): Candidate {
  return payloadShell({
    headline_ar: ALERT_AR,
    deltas: [
      {
        label_ar: 'متابعو الحساب الشخصي',
        direction: 'down',
        basis: [
          { source_key: 'profiles.personal.followers.delta', value: '-300' },
          { source_key: 'profiles.personal.followers.delta.days', value: String(DROP_DAYS) },
        ],
        grounding: 'data',
      },
    ],
    actions: [
      escalation({
        reason_ar: 'نزول بالمتابعين تجاوز حدّ التغيّر الجوهري، ولازم قرار بشري قبل الإرسال.',
        urgency: 'now',
        basis: [{ source_key: 'profiles.personal.followers.delta', value: '-300' }],
      }),
    ],
    needs_human: true,
    client_digest_ar: [ALERT_AR, 'منراجع السبب قبل أي خطوة، ونرجعلك اليوم.'].join('\n'),
  });
}

/** The same escalation with the urgency stripped out of the spec. */
function alertWithoutUrgencyPayload(): Candidate {
  return {
    ...alertPayload(),
    actions: [
      escalation({
        reason_ar: 'نزول بالمتابعين.',
        basis: [{ source_key: 'profiles.personal.followers.delta', value: '-300' }],
      }),
    ],
  };
}

/** An escalation whose receipt names a key nobody measured. */
function alertWithInventedReceiptPayload(): Candidate {
  return {
    ...alertPayload(),
    actions: [
      escalation({
        reason_ar: 'نزول بالمتابعين.',
        urgency: 'now',
        basis: [{ source_key: 'profiles.personal.followers.drop_pct', value: INVENTED_PCT }],
      }),
    ],
  };
}

/**
 * The failure mode: the same drop demoted to a mid-digest concern, softened into
 * a percentage nobody measured, and nothing escalated.
 */
function buriedAlertPayload(concern: string): Candidate {
  return payloadShell({
    headline_ar: 'أسبوع هادي على الحسابين',
    wins: [
      {
        statement_ar: WIN_AR,
        basis: [{ source_key: 'performance.personal.top_post.engagement', value: '33176' }],
        grounding: 'data',
      },
    ],
    concerns: [{ statement_ar: concern, basis: [], grounding: 'hypothesis' }],
    needs_human: false,
    client_digest_ar: [WIN_AR, 'في تراجع بسيط بالمتابعين، بس الوضع العام منيح.'].join('\n'),
  });
}

const BURIED_WITH_INVENTED_PCT = `في تراجع بسيط بالمتابعين حوالي ${INVENTED_PCT}% ، بس مش مقلق.`;
const BURIED_WITH_NO_NUMBER = 'في تراجع بسيط بالمتابعين، بس مش مقلق.';

test('probe 6 · premise — the drop is a signed, keyed measurement with its window attached', () => {
  const data = anomalyData();

  assert.equal(valueOf(data, 'profiles.personal.followers.delta'), '-300');
  assert.equal(valueOf(data, 'profiles.personal.followers.delta.days'), String(DROP_DAYS));
  assert.equal(formatDelta(-300), '-300');
  // The sign is not decoration: a delta that lost it would read as growth.
  assert.equal(formatDelta(300), '+300');

  // The threshold it is judged against is keyed too, so the alert cites a bar
  // rather than asserting one.
  assert.equal(
    valueOf(data, 'meta.thresholds.material_change_pct'),
    String(DEFAULT_THRESHOLDS.material_change_pct),
  );

  // The gate below only means something if the softened percentage really is
  // absent from the blocks. Asserted rather than assumed, because a future block
  // that happened to render "25" anywhere would silently defang it.
  assert.equal(renderStrategistBlocks(data).includes(INVENTED_PCT), false);
});

test('probe 6 · gate — the escalation carries urgency and a receipt, and both are required', () => {
  const data = anomalyData();
  const alert = parsed(alertPayload());

  const escalations = alert.actions.filter((action) => action.type === 'flag_needs_human');
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].spec.urgency, 'now');
  assert.equal(alert.needs_human, true);
  assert.equal(digestLines(alert.client_digest_ar)[0], ALERT_AR, 'the alert leads, never buried');
  assert.equal(rejects(alertPayload(), data), false);

  // An escalation with no urgency is a sentence, not an alert.
  assert.equal(rejects(alertWithoutUrgencyPayload(), data), true);

  // And its receipt is checked like every other citation: a key nobody emitted
  // is a violation even inside an action spec. This is the receipt on the one
  // output that wakes a human, so it is the worst one to leave unverified.
  const invented = ruling(alertWithInventedReceiptPayload(), data);
  assert.equal(invented.rejected, true);
  assert.ok(invented.reason.includes('profiles.personal.followers.drop_pct'), invented.reason);
  assert.match(invented.reason, /actions\[0\]/);
  assert.equal(
    strategistClaims(alert).some((claim) => claim.where.startsWith('actions')),
    true,
    'the flattener reaches into actions, which is what makes the receipt checkable',
  );
});

test('probe 6 · gate — the burial that invents a percentage is caught; the one that does not is not', () => {
  const data = anomalyData();

  // The softened percentage appears nowhere in the blocks, and the real
  // claims-linter says so.
  const softened = parsed(buriedAlertPayload(BURIED_WITH_INVENTED_PCT));
  const linted = verdictOf(lawOf(softened, data), CLAIMS_LINTER);
  assert.equal(linted.passed, false);
  assert.ok(linted.evidence.includes(INVENTED_PCT), linted.evidence);
  assert.equal(rejects(buriedAlertPayload(BURIED_WITH_INVENTED_PCT), data), true);

  // Remove the invented number and the same burial ships. Nothing is escalated,
  // needs_human is false, the -300 is simply never mentioned — and no check
  // objects, because none of them knows an anomaly happened. That is the finding.
  const quiet = parsed(buriedAlertPayload(BURIED_WITH_NO_NUMBER));
  assert.equal(quiet.needs_human, false);
  assert.equal(quiet.actions.length, 0);
  assert.equal(rejects(buriedAlertPayload(BURIED_WITH_NO_NUMBER), data), false);
  assert.deepEqual(lawOf(quiet, data).violations, []);
});

test(
  'probe 6 · [pending] an anomaly past the threshold that is not escalated is rejected',
  {
    skip:
      'UNENFORCED RULE. Nothing compares a measured delta against ' +
      'meta.thresholds.material_change_pct, so an anomaly can be demoted to a concern ' +
      'or dropped entirely and every check still passes (asserted directly above). It ' +
      'belongs as an `anomalyCheck(payload, data)` in the strategistLaw() list in ' +
      'src/lib/agent/features/strategist.ts: when a keyed delta in the blocks crosses ' +
      'the threshold, the payload must carry needs_human true AND a flag_needs_human ' +
      'action citing that key. Note it reads the BLOCKS, not the payload — a rule ' +
      'that only inspected what the payload mentioned could be satisfied by not ' +
      'mentioning it, which is the exact failure. This probe asserts ' +
      'rejects(buriedAlertPayload(BURIED_WITH_NO_NUMBER)) is true under anomalyData() ' +
      'and false under quietData(), and rejects(alertPayload()) is false.',
  },
  () => {
    throw new Error('unreachable: no anomaly-threshold check exists to bind to');
  },
);

/* ========================================================================= */
/* The probes against the spec.                                              */
/* ========================================================================= */

/**
 * Each probe encodes one WHEN. If a clause is softened or "tidied" out of the
 * shipped prompt, the probe guarding it is silently guarding nothing — so the
 * clauses are asserted to still be there, verbatim.
 */
const TRIGGERED_RULES: readonly [string, string][] = [
  ['probe 1', 'actions: [{type:"request_computation"'],
  ['probe 2', 'Refuted decisions go to `corrections` and lead the digest'],
  ['probe 3', 'at most three lines'],
  ['probe 4', 'staleness_days` exceeds its threshold'],
  ['probe 5', 'it ships with a cap (max posts/spend), a kill condition, and `review_after`'],
  ['probe 6', '`needs_human` with `urgency` and the receipt. Alerts are never buried mid-digest'],
];

test('every WHEN these probes encode is still a clause in the shipped system prompt', () => {
  for (const [probe, clause] of TRIGGERED_RULES) {
    assert.equal(
      STRATEGIST_SYSTEM.includes(clause),
      true,
      `${probe} guards a rule that is no longer in STRATEGIST_SYSTEM: «${clause}»`,
    );
  }
  assert.equal(STRATEGIST_SYSTEM.includes('status: "quiet"'), true);
});

/**
 * The pipeline these probes ask their question through is the feature's own.
 * `strategistLaw()` is module-private, so `ruling()` rebuilds its check list by
 * name — and a check the feature added that this file never heard of would be
 * silently skipped by every gate above. This is the assertion that notices.
 */
test('every check the feature exports is one these probes actually run', () => {
  const exported = Object.entries({ ...strategist })
    .filter(([name, value]) => name.endsWith('Check') && typeof value === 'function')
    .map(([name]) => name)
    .sort();

  assert.deepEqual(
    exported,
    CHECK_NAMES.filter((name) => exported.includes(name)).sort(),
    `unrun check(s): ${exported.filter((n) => !CHECK_NAMES.includes(n)).join(', ')}. ` +
      'Add them to CHECK_NAMES so the gates above see their verdicts.',
  );
  assert.ok(FEATURE_CHECKS.length > 0, 'at least one feature check is bound');
});

/* ========================================================== what this found ==
 * TWO RULES ARE UNENFORCED, and the two [pending] probes name them:
 *
 *   probe 2  corrections must LEAD the digest. Their PRESENCE is checked —
 *            ledgerReviewCheck() catches a due decision left unverdicted — but
 *            never their position, and the buried pair above proves nothing
 *            currently distinguishes the two.
 *   probe 6  the anomaly threshold. Nothing compares a measured delta against
 *            meta.thresholds.material_change_pct, so an alert can be demoted to
 *            a mid-digest concern, or omitted, with no check objecting. The
 *            only thing that caught the burial above was the invented
 *            percentage inside it — remove the number and it ships.
 *
 * WHAT IS ENFORCED, and is asserted above rather than assumed: the source-key
 * rule in both its forms (an invented key, and a real key quoting an altered
 * value — including inside an escalation's receipt), the claims-linter over the
 * strategist's own blocks, the ledger review of every due decision, the
 * staleness ban on fresh data-grounded claims, the quiet-week line limit, the
 * experiment fence in both halves, the period restatement, the action budget,
 * the "judgeable after today" half of falsifiability, urgency on an escalation,
 * and both preflight refusals. Those probes are green because the app works,
 * not because the test was written to agree with it.
 * ========================================================================= */
