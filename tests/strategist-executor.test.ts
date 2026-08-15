import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import type { StrategistResponse } from '../src/lib/agent/features/strategist.ts';
import type { FeatureRunOutcome } from '../src/lib/agent/features/types.ts';
import type { DigestRow, StrategistAction, StrategistPayload } from '../src/lib/types/db.ts';
import type {
  ActionResult,
  ExecutedPayload,
  ExecutionRecord,
  ExecutorDeps,
} from '../src/lib/agent/strategist/executor.ts';

/* =============================================================== what this ==
 * The executor is the ONE place where something the strategist asked for turns
 * into something that happens. Everything valuable about the strategist rests
 * on that boundary holding, so these tests hold it to four properties:
 *
 *   1. an action type outside the allow-list is REFUSED — by the contract that
 *      admits the payload, and again by the executor's own default-deny gate;
 *   2. `request_computation` OPENS A TRACKED ITEM AND COMPUTES NOTHING. The
 *      agent naming a measurement it does not have must not be a way to obtain
 *      it;
 *   3. `generate_concepts` is ROUTED to the registry, and no content crosses
 *      back into the digest;
 *   4. a digest that does not validate has NOTHING executed — the feature
 *      runner is never reached at all.
 *
 * NO MODEL IS CALLED AND NO DATABASE IS TOUCHED, and neither is needed: the
 * planner is pure, and the two impure dependencies (the feature runner and the
 * write-back) are injected. Every gate that runs below is production code —
 * the real `strategistResponseSchema`, the real route table, the real planner.
 * What is faked is the transport, exactly as tests/needs-human.test.ts and
 * tests/strategist-probes.test.ts fake theirs.
 *
 * WHAT IS NOT PROVEN HERE: that a real concepts run, reached through the real
 * registry, produces anything good. That is a claim about a model, and there is
 * no OPENROUTER_API_KEY in this environment to make it with.
 *
 * ON THE FIXTURES: not one number or claim about the client appears below. The
 * payloads are SHAPES — empty finding lists, generic Arabic strings, and the
 * three action types. A digest fixture that stated a measurement would be
 * inventing one (hard rule 2).
 * ========================================================================= */

/* ---------------------------------------------------------------- loader --
 * src/lib/agent/strategist/executor.ts imports through the `@/*` alias, which
 * node does not resolve, and reaches auth, the database, the model transport
 * and the feature registry. These hooks teach this process the one alias rule
 * from tsconfig.json (`@/*` -> `./src/*`), resolve extensionless relative
 * imports to their .ts file, and swap those four modules for stubs.
 *
 * NOTHING UNDER TEST IS FAKED. The stubs for the database and the model throw
 * rather than returning a plausible empty result, so a test that somehow
 * reached one fails loudly instead of passing quietly. The registry stub is
 * the same: the executor only touches it inside `defaultExecutorDeps()`, which
 * these tests never call — every test below injects its own runner, which is
 * what makes "the executor routed to X" an assertion rather than a guess.
 * ------------------------------------------------------------------------ */

const SRC = new URL('../src/', import.meta.url).href;

const AUTH_STUB = 'stub:lib-auth';
const DB_STUB = 'stub:lib-supabase-admin';
const AGENT_STUB = 'stub:lib-agent-client';
const REGISTRY_STUB = 'stub:lib-agent-registry';

const STUBS: Record<string, string> = {
  '@/lib/auth': AUTH_STUB,
  '@/lib/supabase/admin': DB_STUB,
  '@/lib/agent/client': AGENT_STUB,
  '@/lib/agent/features/registry': REGISTRY_STUB,
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
    '  throw new Error("strategist-executor.test.ts: no test here may touch the database.");' +
    '}',
  [AGENT_STUB]:
    'export async function runAgentJson() {' +
    '  throw new Error("strategist-executor.test.ts: no test here may call a model.");' +
    '}',
  [REGISTRY_STUB]:
    'export function getFeature() {' +
    '  throw new Error("strategist-executor.test.ts: the injected runner is what routes, not this stub.");' +
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

/* Loaded after the hooks are installed, which is why these are dynamic
 * imports. The specifiers are string literals, so everything below is fully
 * typed — a renamed export is a compile error, not a silent skip. */

const {
  ALLOWED_ACTION_TYPES,
  CONCEPTS_FEATURE_ID,
  conceptsRequest,
  executeDigestActions,
  featuresThisExecutorMayRun,
  planExecution,
  routeFor,
  runPlan,
  storedExecution,
  validateDigest,
} = await import('../src/lib/agent/strategist/executor.ts');

/**
 * The REAL registry, reached by relative path so it bypasses the stub above —
 * the hook keys on the specifier string, and `@/lib/agent/features/registry` is
 * a different string from this one. Loading it proves the feature id the route
 * table names is a feature that actually exists, which is the half of "routes
 * to the registry" that an injected runner cannot prove.
 */
const { getFeature } = await import('../src/lib/agent/features/registry.ts');

/* --------------------------------------------------------------- fixtures -- */

const TODAY = '2026-08-15';
const OPENED_AT = '2026-08-15T09:00:00.000Z';

/** Arabic that says something and measures nothing. */
const HEADLINE = 'ملخّص الأسبوع';
const CLIENT_DRAFT = 'لا جديد يستحق قراراً هذا الأسبوع.';

/** The three action types, one each, in the order the executor plans them. */
const ACTIONS: StrategistResponse['actions'] = [
  {
    type: 'generate_concepts',
    do_ar: 'اطلب أفكاراً لحساب الأكاديمية.',
    owner: 'operator',
    by_date: null,
    decision_index: null,
    spec: { account: 'academy', pillar: 'الجودة', theme: 'أسئلة المتابعين', count: 3 },
  },
  {
    type: 'request_computation',
    do_ar: 'اطلب حساب هذا الرقم قبل الأسبوع القادم.',
    owner: 'operator',
    by_date: null,
    decision_index: null,
    spec: {
      question_en: 'Median engagement per format, per account, over the last 90 days.',
      would_unlock_ar: 'مقارنة الصيغ ببعضها بدل مقارنتها بالمتوسط العام.',
    },
  },
  {
    type: 'flag_needs_human',
    do_ar: 'اقرأ التقرير قبل استخدام أي شيء منه.',
    owner: 'operator',
    by_date: null,
    decision_index: null,
    // Empty on purpose and allowed: what needs a human here is a measurement
    // that was never taken, and an absence emits no key to cite.
    spec: { reason_ar: 'البيانات ناقصة.', urgency: 'this_week', basis: [] },
  },
];

/** A payload that satisfies the strategist's real contract. */
const VALID_PAYLOAD: StrategistResponse = {
  period: { from: '2026-08-09', to: TODAY },
  status: 'quiet',
  headline_ar: HEADLINE,
  deltas: [],
  wins: [],
  concerns: [],
  corrections: [],
  decisions: [],
  actions: ACTIONS,
  ledger_review: [],
  needs_human: false,
  client_digest_ar: CLIENT_DRAFT,
  operator_notes: [],
};

/**
 * A payload shaped EXACTLY as `StrategistPayload` in src/lib/types/db.ts
 * declares it — and therefore not a valid strategist response.
 *
 * This is not a contrived corruption. `StrategistPayload` declares no
 * `actions[].type`, no `actions[].spec` and no `ledger_review`, all three of
 * which `strategistResponseSchema` requires; the gap is documented in both
 * files and reported again by this test's existence. A payload written to the
 * db.ts contract is precisely the "digest that is not validated" case, and it
 * is the one most likely to occur for real.
 */
const UNVALIDATED_PAYLOAD: StrategistPayload = {
  period: { from: '2026-08-09', to: TODAY },
  status: 'material',
  headline_ar: HEADLINE,
  deltas: [],
  wins: [],
  concerns: [],
  corrections: [],
  decisions: [],
  actions: [{ do_ar: 'افعل شيئاً.', owner: 'operator', by_date: null, decision_index: null }],
  needs_human: false,
  client_digest_ar: CLIENT_DRAFT,
  operator_notes: [],
};

/**
 * An action naming a type nobody registered. Built as a variable rather than
 * inline so the excess-property check does not reject it: the point is that
 * this shape CAN reach the column, because jsonb accepts whatever is written to
 * it, and the executor must not act on it.
 */
const ROGUE_ACTION: StrategistAction & { type: string; spec: Record<string, string> } = {
  do_ar: 'شغّل سحباً جديداً للبيانات.',
  owner: 'operator',
  by_date: null,
  decision_index: null,
  type: 'run_scrape',
  spec: { handle: 'thinkquality_academyy' },
};

const ROGUE_PAYLOAD: StrategistPayload = { ...VALID_PAYLOAD, actions: [ROGUE_ACTION] };

function digestWith(payload: StrategistPayload): DigestRow {
  return {
    id: 'digest-under-test',
    period_from: payload.period.from,
    period_to: payload.period.to,
    status: payload.status,
    payload,
    client_digest_ar: payload.client_digest_ar,
    sent: false,
    created_at: `${TODAY}T09:00:00.000Z`,
  };
}

/* ------------------------------------------------------------ the recorder -- */

/** The generated text a routed run hands back. It must not come back here. */
const SECRET_HOOK = 'هوك لا يجوز أن يعود إلى التقرير';

interface Recorder {
  deps: ExecutorDeps;
  runs: { feature: string; input: unknown }[];
  attached: { digestId: string; payload: ExecutedPayload }[];
}

/**
 * Injected dependencies that record instead of doing.
 *
 * `runFeature` returns a `FeatureRunOutcome` whose `result` carries content and
 * whose `persisted` carries ids — the two halves the executor has to treat
 * differently. `brain` is absent, which is the truth about the concepts feature
 * today: it is registered without a Design Brain config.
 */
function recorder(options: { failWith?: string } = {}): Recorder {
  const runs: { feature: string; input: unknown }[] = [];
  const attached: { digestId: string; payload: ExecutedPayload }[] = [];

  const deps: ExecutorDeps = {
    now: () => OPENED_AT,
    async runFeature(feature, input) {
      runs.push({ feature, input });
      if (options.failWith !== undefined) throw new Error(options.failWith);
      const outcome: FeatureRunOutcome = {
        feature,
        model: 'stub-model',
        attempts: 1,
        // Fixture counters for a stubbed transport, not measurements.
        usage: { input_tokens: 11, output_tokens: 7 },
        result: { concepts: [{ hook_ar: SECRET_HOOK, caption_ar: SECRET_HOOK }] },
        persisted: { inserted: [{ id: 'concept-1' }, { id: 'concept-2' }] },
      };
      return outcome;
    },
    async attach(digestId, payload) {
      attached.push({ digestId, payload });
    },
  };

  return { deps, runs, attached };
}

function resultAt(record: ExecutionRecord, index: number): ActionResult {
  const found = record.results.find((result) => result.action_index === index);
  // A throw rather than assert.ok(): the narrowing is what the callers below
  // rely on, and a plain throw narrows without depending on how the assertion
  // helper happens to be typed.
  if (!found) throw new Error(`expected a result for actions[${index}]`);
  return found;
}

/* ===================================================================== 1 === *
 * An action type outside the allow-list is refused.
 * ========================================================================= */

test('allow-list — default deny: an unlisted action type has no route', () => {
  assert.deepEqual([...ALLOWED_ACTION_TYPES], [
    'generate_concepts',
    'request_computation',
    'flag_needs_human',
  ]);

  for (const type of [
    'run_scrape',
    'scrape_posts',
    'refresh_snapshot',
    'apify_run',
    'send_digest',
    'mark_sent',
    '',
  ]) {
    assert.equal(routeFor(type), null, `"${type}" must not be routable`);
  }

  // A Record would answer these from Object.prototype and hand back something
  // truthy. The route table is a Map for exactly this reason.
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(routeFor(key), null, `"${key}" must not be routable`);
  }
});

test('allow-list — the only feature reachable from the executor is concepts', () => {
  assert.deepEqual(featuresThisExecutorMayRun(), [CONCEPTS_FEATURE_ID]);
  assert.equal(CONCEPTS_FEATURE_ID, 'concepts');

  // And it is a feature that exists: the executor cannot route to a name the
  // registry does not have. This half needs the REAL registry, above.
  const feature = getFeature(CONCEPTS_FEATURE_ID);
  if (!feature) throw new Error('the concepts feature must be registered');
  assert.equal(feature.id, CONCEPTS_FEATURE_ID);
});

test('allow-list — the executor imports nothing that can spend on a scrape (rule 14)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/lib/agent/strategist/executor.ts', import.meta.url)),
    'utf8',
  );
  const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);

  // Sanity-check the regex against a string known to be present before
  // trusting what it did NOT find.
  assert.ok(
    specifiers.includes('@/lib/agent/features/registry'),
    'the specifier scan found nothing it should have found — the regex is wrong, not the file',
  );

  const forbidden = /ingest|apify|scrape|monitor|refresh|budget/i;
  for (const specifier of specifiers) {
    assert.ok(
      !forbidden.test(specifier),
      `executor.ts imports "${specifier}", which reaches the ingestion layer`,
    );
  }
});

test('allow-list — a rogue action type is refused by the contract, and nothing runs', async () => {
  const rec = recorder();

  await assert.rejects(
    () => executeDigestActions(digestWith(ROGUE_PAYLOAD), rec.deps),
    (err: unknown) => err instanceof Error && /did not validate/.test(err.message),
  );

  assert.deepEqual(rec.runs, [], 'no feature may be reached by a payload that did not validate');
  assert.deepEqual(rec.attached, [], 'nothing may be written for a payload that did not validate');
});

/* ===================================================================== 2 === *
 * request_computation opens a tracked item and computes nothing.
 * ========================================================================= */

test('request_computation — opens a tracked item', async () => {
  const rec = recorder();
  const record = await executeDigestActions(digestWith(VALID_PAYLOAD), rec.deps);

  const result = resultAt(record, 1);
  assert.equal(result.type, 'request_computation');
  assert.equal(result.disposition, 'track');
  assert.equal(result.status, 'opened');
  assert.equal(result.run, null, 'opening a request must not run a feature');

  const item = result.tracked;
  if (item === null) throw new Error('a request_computation action must open a tracked item');
  assert.equal(item.status, 'open');
  assert.equal(item.opened_at, OPENED_AT);
  assert.equal(item.action_index, 1);
  // Verbatim, both halves: the question as asked and the claim it would unlock.
  assert.equal(item.question_en, 'Median engagement per format, per account, over the last 90 days.');
  assert.equal(item.would_unlock_ar, 'مقارنة الصيغ ببعضها بدل مقارنتها بالمتوسط العام.');
});

test('request_computation — computes nothing, and cannot', async () => {
  const rec = recorder();
  const record = await executeDigestActions(digestWith(VALID_PAYLOAD), rec.deps);
  const item = resultAt(record, 1).tracked;
  if (item === null) throw new Error('a request_computation action must open a tracked item');

  // The two fields that make "nothing was computed" a property of the stored
  // object rather than a claim about it.
  assert.equal(item.computed, false);
  assert.equal(item.answer, null);

  // And no route was taken to obtain it: the only feature run in this pass was
  // the concepts one, from a different action.
  assert.deepEqual(rec.runs.map((run) => run.feature), [CONCEPTS_FEATURE_ID]);
  assert.equal(record.counts.opened, 1);

  // The pure planner says the same thing with no dependencies at all.
  const step = planExecution(VALID_PAYLOAD, OPENED_AT)[1];
  if (step.kind !== 'track') throw new Error('actions[1] must plan as a tracked item');
  assert.equal(step.item.computed, false);
  assert.equal(step.item.answer, null);
});

test('flag_needs_human — is surfaced, and executes nothing', async () => {
  const rec = recorder();
  const record = await executeDigestActions(digestWith(VALID_PAYLOAD), rec.deps);

  const result = resultAt(record, 2);
  assert.equal(result.disposition, 'surface');
  assert.equal(result.status, 'surfaced');
  assert.equal(result.run, null);
  assert.equal(result.tracked, null);
  assert.equal(record.counts.surfaced, 1);
});

/* ===================================================================== 3 === *
 * generate_concepts routes to the registry rather than writing content.
 * ========================================================================= */

test('generate_concepts — is routed to the concepts feature, with the spec mapped', async () => {
  const rec = recorder();
  const record = await executeDigestActions(digestWith(VALID_PAYLOAD), rec.deps);

  assert.equal(rec.runs.length, 1, 'exactly one feature run, from exactly one action');
  const run = rec.runs[0];
  assert.equal(run.feature, CONCEPTS_FEATURE_ID);
  // The concepts feature's input shape, and nothing else. `pillar` is absent
  // because that feature has no input for it — see the unrouted warning below.
  assert.deepEqual(run.input, { account: 'academy', count: 3, theme: 'أسئلة المتابعين' });

  const result = resultAt(record, 0);
  assert.equal(result.status, 'ran');
  assert.equal(result.disposition, 'run_feature');
  assert.deepEqual(result.run?.persisted_ids, ['concept-1', 'concept-2']);
  assert.equal(result.run?.model, 'stub-model');
});

test('generate_concepts — no content comes back into the digest', async () => {
  const rec = recorder();
  const record = await executeDigestActions(digestWith(VALID_PAYLOAD), rec.deps);

  // The routed run produced a hook. The concepts table is where it belongs; a
  // copy in the digest payload would be a second, unreviewed home for it.
  assert.ok(
    !JSON.stringify(record).includes(SECRET_HOOK),
    'generated content must not be copied into the execution record',
  );
  const written = rec.attached[0];
  assert.ok(written);
  assert.ok(
    !JSON.stringify(written.payload.execution).includes(SECRET_HOOK),
    'generated content must not be written back onto the digest',
  );
});

test('generate_concepts — a spec field with nowhere to go is reported, never folded in', () => {
  const mapped = conceptsRequest({
    account: 'academy',
    pillar: 'الجودة',
    theme: 'أسئلة المتابعين',
    count: 3,
  });
  assert.deepEqual(mapped.unrouted, ['pillar']);
  // The pillar is NOT smuggled into the theme, which would be this module
  // writing an instruction the strategist did not write.
  assert.equal(mapped.input.theme, 'أسئلة المتابعين');

  const none = conceptsRequest({ account: 'personal', pillar: null, theme: null, count: 1 });
  assert.deepEqual(none.unrouted, []);
  assert.deepEqual(none.input, { account: 'personal', count: 1, theme: null });
});

test('generate_concepts — an unjudged run says so', async () => {
  const rec = recorder();
  const record = await executeDigestActions(digestWith(VALID_PAYLOAD), rec.deps);
  const run = resultAt(record, 0).run;
  if (run === null) throw new Error('the routed run must be summarised');

  // The concepts feature is registered without a Design Brain, so nothing
  // judged what it produced. `needs_human` is null and not false: unjudged is
  // not the same as acceptable (hard rule 2).
  assert.equal(run.brain_applied, false);
  assert.equal(run.needs_human, null);
  assert.ok(
    record.warnings.some((warning) => warning.includes('unjudged')),
    'an unjudged run must be surfaced as a warning',
  );
  assert.ok(
    record.warnings.some((warning) => warning.includes('pillar')),
    'a request field that could not be routed must be surfaced as a warning',
  );
});

test('a feature that fails is recorded, not swallowed, and the pass continues', async () => {
  const rec = recorder({ failWith: 'the model transport refused' });
  const record = await executeDigestActions(digestWith(VALID_PAYLOAD), rec.deps);

  const failed = resultAt(record, 0);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'the model transport refused');
  assert.equal(failed.run, null);
  assert.equal(record.counts.failed, 1);
  assert.equal(record.counts.ran, 0);

  // The later actions are independent requests and were still handled.
  assert.equal(record.counts.opened, 1);
  assert.equal(record.counts.surfaced, 1);
});

/* ===================================================================== 4 === *
 * A digest that is not validated cannot have its actions executed.
 * ========================================================================= */

test('a digest that does not validate has nothing executed', async () => {
  const rec = recorder();

  await assert.rejects(
    () => executeDigestActions(digestWith(UNVALIDATED_PAYLOAD), rec.deps),
    (err: unknown) => err instanceof Error && /did not validate/.test(err.message),
  );

  assert.deepEqual(rec.runs, [], 'the feature runner must never be reached');
  assert.deepEqual(rec.attached, [], 'no record may be attached');

  // The gate is the strategist's own schema, not a second copy of the rules.
  assert.throws(() => validateDigest(digestWith(UNVALIDATED_PAYLOAD)));
  const ok = validateDigest(digestWith(VALID_PAYLOAD));
  assert.equal(ok.payload.headline_ar, HEADLINE);
});

test('a digest that was already executed is refused a second pass', async () => {
  const rec = recorder();
  const first = await executeDigestActions(digestWith(VALID_PAYLOAD), rec.deps);
  const written = rec.attached[0];
  assert.ok(written);

  const again = recorder();
  await assert.rejects(
    () => executeDigestActions(digestWith(written.payload), again.deps),
    (err: unknown) => err instanceof Error && /already carries an execution record/.test(err.message),
  );
  assert.deepEqual(again.runs, [], 'a second pass must not spend again');
  assert.equal(first.counts.requested, 3);
});

/* ===================================================================== 5 === *
 * What is written back.
 * ========================================================================= */

test('the record is attached beside the fields the agent wrote, never inside them', async () => {
  const rec = recorder();
  const record = await executeDigestActions(digestWith(VALID_PAYLOAD), rec.deps);

  const written = rec.attached[0];
  assert.ok(written);
  assert.equal(written.digestId, 'digest-under-test');

  // Everything the model said is still exactly what the model said.
  assert.equal(written.payload.headline_ar, VALID_PAYLOAD.headline_ar);
  assert.equal(written.payload.client_digest_ar, VALID_PAYLOAD.client_digest_ar);
  assert.deepEqual(written.payload.actions, VALID_PAYLOAD.actions);
  assert.equal(written.payload.execution.digest_id, 'digest-under-test');
  assert.equal(written.payload.execution.executed_at, OPENED_AT);

  // And the run counted what it did, in one place.
  assert.deepEqual(record.counts, {
    requested: 3,
    ran: 1,
    opened: 1,
    surfaced: 1,
    refused: 0,
    failed: 0,
  });

  assert.notEqual(storedExecution(written.payload), null);
  assert.equal(storedExecution(VALID_PAYLOAD), null);
});

test('the plan is index-aligned with the actions the digest carries', () => {
  const steps = planExecution(VALID_PAYLOAD, OPENED_AT);
  assert.equal(steps.length, VALID_PAYLOAD.actions.length);
  steps.forEach((step, index) => {
    assert.equal(step.action_index, index);
    assert.equal(step.type, VALID_PAYLOAD.actions[index].type);
  });
  assert.deepEqual(steps.map((step) => step.kind), ['run_feature', 'track', 'surface']);
});

test('runPlan on an empty plan does nothing and says so', async () => {
  const rec = recorder();
  const record = await runPlan('digest-under-test', [], rec.deps);
  assert.deepEqual(rec.runs, []);
  assert.deepEqual(record.results, []);
  assert.deepEqual(record.counts, {
    requested: 0,
    ran: 0,
    opened: 0,
    surfaced: 0,
    refused: 0,
    failed: 0,
  });
});
