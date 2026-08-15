import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRenderedMeasures,
  runLaw,
  sourceKeys,
  type CitedClaim,
} from '../src/lib/brain/law/index.ts';
import {
  DEFAULT_ACTION_BUDGET,
  DEFAULT_THRESHOLDS,
  collectMeasures,
  collectSourceKeys,
  renderStrategistBlocks,
  type StrategistData,
} from '../src/lib/agent/strategist/blocks.ts';
import type { BrandRow } from '../src/lib/types/db.ts';

/* =============================================================== what this ==
 * source-keys.ts is what turns "every number carries a source key" from an
 * instruction in a prompt into a rule the model cannot talk its way past. The
 * property that matters most is the ARITHMETIC one: a model handed 508 and 40
 * will offer 12.7x, which reads better than either honest sentence and is
 * unauditable. These tests hold that line, plus the two around it — a citation
 * must name a real key, and a claim calling itself data must name something.
 *
 * Two kinds of fixture appear below. The hand-written blocks string pins the
 * check's behaviour on exactly the input shape it documents. The fixtures built
 * through the REAL renderer pin something else and more important: that the
 * parser here still inverts renderMeasure() in blocks.ts. If that ever drifts,
 * this check would start passing everything, silently, which is the worst way a
 * guard can fail. Every real figure used is one of the four proven ones
 * (personal n=190 avg 508, academy n=130 avg 40, top post 33176); nothing here
 * invents a measurement about the client.
 * ========================================================================= */

const TODAY = '2026-08-15';
const SNAPSHOT_DAY = '2026-08-14';

/** Rendered exactly as blocks.ts writes it, absence line included. */
const BLOCKS = [
  '<performance>',
  'Everything below is measured over DISTINCT posts in one snapshot.',
  '[performance.personal.avg_engagement] mean engagement per post, personal account (n=190, as_of=2026-08-14) = "508"',
  '[performance.academy.avg_engagement] mean engagement per post, academy account (n=130, as_of=2026-08-14) = "40"',
  '[performance.personal.top_post.engagement] engagement on the strongest personal post (as_of=2026-08-14) = "33176"',
  '(no measurement) profiles.personal.followers — no profile snapshot has ever been recorded for this account.',
  '</performance>',
].join('\n');

const EMITTED = [
  'performance.personal.avg_engagement',
  'performance.academy.avg_engagement',
  'performance.personal.top_post.engagement',
];

function claim(where: string, grounding: 'data' | 'hypothesis', basis: CitedClaim['basis']): CitedClaim {
  return { where, grounding, basis };
}

function check(claims: CitedClaim[], blocks: string = BLOCKS, emitted: string[] = EMITTED) {
  return sourceKeys({ claims, emitted, blocks });
}

/* ------------------------------------------------------------------ a) key -- */

test('a citation that names a real key and quotes its value passes', () => {
  const r = check([
    claim('wins[0]', 'data', [
      { source_key: 'performance.personal.avg_engagement', value: '508' },
      { source_key: 'performance.academy.avg_engagement', value: '40' },
    ]),
  ]);
  assert.equal(r.passed, true);
  assert.equal(r.source, 'law');
  assert.equal(r.detail?.citations, 2);
});

test('an INVENTED source key fails and names it', () => {
  const r = check([
    claim('wins[0]', 'data', [{ source_key: 'performance.reels.growth', value: '508' }]),
  ]);
  assert.equal(r.passed, false);
  assert.equal(r.severity, 'violation');
  assert.match(r.evidence, /performance\.reels\.growth/);
  assert.match(r.evidence, /wins\[0\]/);
});

test('a key that was rendered as an ABSENCE is not a key — citing it fails', () => {
  // profiles.personal.followers appears in the blocks, by name, on a
  // "(no measurement)" line. That line emits no key precisely so a citation to
  // it cannot resolve against a hole.
  const r = check([
    claim('deltas[0]', 'data', [{ source_key: 'profiles.personal.followers', value: '0' }]),
  ]);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /profiles\.personal\.followers/);
});

test('a fabricated key fails even under grounding "hypothesis"', () => {
  const r = check([
    claim('concerns[0]', 'hypothesis', [{ source_key: 'audience.themes.pricing.n', value: '12' }]),
  ]);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /audience\.themes\.pricing\.n/);
});

/* ---------------------------------------------------------------- b) value -- */

test('THE ARITHMETIC CASE: blocks hold 508 and 40, the claim states 12.7 — fails', () => {
  const r = check([
    claim('wins[0]', 'data', [
      { source_key: 'performance.personal.avg_engagement', value: '12.7' },
    ]),
  ]);
  assert.equal(r.passed, false);
  assert.equal(r.severity, 'violation');
  assert.match(r.evidence, /12\.7/);
  assert.match(r.evidence, /508/);
});

test('a real value filed under the WRONG key fails — the key is part of the claim', () => {
  const r = check([
    claim('wins[0]', 'data', [{ source_key: 'performance.personal.avg_engagement', value: '40' }]),
  ]);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /performance\.personal\.avg_engagement/);
});

test('a rounded value fails: 33176 may not become 33000', () => {
  const r = check([
    claim('wins[0]', 'data', [
      { source_key: 'performance.personal.top_post.engagement', value: '33000' },
    ]),
  ]);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /33000/);
});

test('Arabic-Indic digits match their Western equivalents', () => {
  const r = check([
    claim('wins[0]', 'data', [
      { source_key: 'performance.personal.avg_engagement', value: '٥٠٨' },
    ]),
  ]);
  assert.equal(r.passed, true);
});

test('digit-blindness does not extend to a different number', () => {
  const r = check([
    claim('wins[0]', 'data', [
      { source_key: 'performance.personal.avg_engagement', value: '٥٠٩' },
    ]),
  ]);
  assert.equal(r.passed, false);
});

/* ------------------------------------------------------------ c) grounding -- */

test('grounding "data" with an EMPTY basis fails and names the statement', () => {
  const r = check([claim('concerns[1]', 'data', [])]);
  assert.equal(r.passed, false);
  assert.equal(r.severity, 'violation');
  assert.match(r.evidence, /concerns\[1\]/);
});

test('grounding "hypothesis" with an empty basis PASSES — by design, do not "fix" it', () => {
  const r = check([claim('concerns[0]', 'hypothesis', [])]);
  assert.equal(r.passed, true);
  assert.equal(r.detail?.hypotheses, 1);
});

test('a mixed payload passes: one sourced statement, one honest hypothesis', () => {
  const r = check([
    claim('wins[0]', 'data', [
      { source_key: 'performance.personal.top_post.engagement', value: '33176' },
    ]),
    claim('concerns[0]', 'hypothesis', []),
  ]);
  assert.equal(r.passed, true);
  assert.equal(r.detail?.claims, 2);
});

test('no claims at all is a pass, not a vacuous failure', () => {
  const r = check([]);
  assert.equal(r.passed, true);
  assert.equal(r.detail?.citations, 0);
});

/* ------------------------------------------------------------ the parser --- */

test('parseRenderedMeasures reads keys and values, and skips absence lines', () => {
  const parsed = parseRenderedMeasures(BLOCKS);
  assert.equal(parsed.size, 3);
  assert.deepEqual(parsed.get('performance.personal.avg_engagement'), ['508']);
  assert.equal(parsed.has('profiles.personal.followers'), false);
});

test('parseRenderedMeasures survives hostile input without throwing', () => {
  assert.equal(parseRenderedMeasures('').size, 0);
  assert.equal(parseRenderedMeasures('[unterminated] label = "oops').size, 0);
  assert.equal(parseRenderedMeasures('[k] label = 508').size, 0);
});

/* ------------------------------------- non-drift against the real renderer -- */

/**
 * The real 2026-08-15 state: no profile snapshot, no engagement snapshot, no
 * comments, no analyses, nothing shipped, an empty ledger. It still emits real
 * keys — counts and the run's own frame — which is exactly what makes it a
 * useful fixture here.
 */
function emptyData(): StrategistData {
  return {
    brand: null,
    guideline: null,
    profiles: { personal: null, academy: null },
    performance: {
      snapshot: null,
      accounts: { personal: null, academy: null },
      clusters: [],
      timing: [],
      posts_coverage: null,
      duplicates_collapsed: 0,
      analyses_count: null,
    },
    audience: null,
    content: { counts: { draft: 0, approved: 0, shipped: 0, rejected: 0 }, shipped: [] },
    ledger: [],
    meta: {
      today: TODAY,
      period: { from: '2026-08-09', to: TODAY },
      staleness_days: null,
      action_budget: DEFAULT_ACTION_BUDGET,
      thresholds: DEFAULT_THRESHOLDS,
    },
  };
}

/**
 * Two brand facts whose only job is to carry awkward text through the renderer:
 * one holds double quotes (which JSON.stringify escapes on the rendered line),
 * one holds Arabic-Indic digits. Neither states anything about the client.
 */
function awkwardBrand(): BrandRow {
  return {
    id: 1,
    facts: [
      { key: 'fixture_quote', value: 'قال «مرحبا» و"hello"', source: 'tests/source-keys.test.ts' },
      { key: 'fixture_digits', value: '٥٠٨', source: 'tests/source-keys.test.ts' },
    ],
    voice_examples: [],
    knowledge: [],
    assets: [],
    palette: null,
    typography: null,
    audience_notes: null,
    status: 'live',
    updated_at: `${SNAPSHOT_DAY}T00:00:00Z`,
  };
}

test('every measure the real renderer emits round-trips through this check', () => {
  const data = emptyData();
  const blocks = renderStrategistBlocks(data);
  const emitted = [...collectSourceKeys(data)];
  const measures = collectMeasures(data);

  assert.ok(measures.length > 0, 'the empty state still emits real counts');

  const r = sourceKeys({
    claims: measures.map((measure, index) =>
      claim(`wins[${index}]`, 'data', [{ source_key: measure.key, value: measure.value }]),
    ),
    emitted,
    blocks,
  });
  assert.equal(r.passed, true, r.evidence);
  assert.equal(r.detail?.citations, measures.length);
});

test('corrupting one real value is caught against the real blocks', () => {
  const data = emptyData();
  const measures = collectMeasures(data);
  const victim = measures[0];

  const r = sourceKeys({
    claims: [claim('wins[0]', 'data', [{ source_key: victim.key, value: `${victim.value}9` }])],
    emitted: [...collectSourceKeys(data)],
    blocks: renderStrategistBlocks(data),
  });
  assert.equal(r.passed, false);
  assert.match(r.evidence, new RegExp(victim.key.replace(/\./g, '\\.')));
});

test('a value containing double quotes survives the render and matches verbatim', () => {
  const data: StrategistData = { ...emptyData(), brand: awkwardBrand() };
  const blocks = renderStrategistBlocks(data);
  const quoted = 'قال «مرحبا» و"hello"';

  assert.ok(blocks.includes('\\"hello\\"'), 'the renderer escapes the quotes on the line');

  const r = sourceKeys({
    claims: [claim('wins[0]', 'data', [{ source_key: 'brand.facts.fixture_quote', value: quoted }])],
    emitted: [...collectSourceKeys(data)],
    blocks,
  });
  assert.equal(r.passed, true, r.evidence);
});

test('Arabic-Indic digits in the BLOCKS match a Western-digit citation', () => {
  const data: StrategistData = { ...emptyData(), brand: awkwardBrand() };
  const r = sourceKeys({
    claims: [claim('wins[0]', 'data', [{ source_key: 'brand.facts.fixture_digits', value: '508' }])],
    emitted: [...collectSourceKeys(data)],
    blocks: renderStrategistBlocks(data),
  });
  assert.equal(r.passed, true, r.evidence);
});

/* -------------------------------------------------------------- runLaw ----- */

test('runLaw runs source-keys when its input is supplied', () => {
  const report = runLaw({
    text: 'نص',
    swatches: null,
    sourceKeys: {
      claims: [
        claim('wins[0]', 'data', [
          { source_key: 'performance.personal.avg_engagement', value: '508' },
        ]),
      ],
      emitted: EMITTED,
      blocks: BLOCKS,
    },
  });
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 2);
  assert.ok(report.results.some((r) => r.check === 'source-keys'));
});

test('runLaw FAILS a payload whose numbers were computed rather than sourced', () => {
  const report = runLaw({
    text: 'نص',
    swatches: null,
    sourceKeys: {
      claims: [
        claim('wins[0]', 'data', [
          { source_key: 'performance.personal.avg_engagement', value: '12.7' },
        ]),
      ],
      emitted: EMITTED,
      blocks: BLOCKS,
    },
  });
  assert.equal(report.passed, false);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].check, 'source-keys');
  assert.equal(report.violations[0].source, 'law');
});

test('runLaw still skips source-keys when it is not supplied', () => {
  const report = runLaw({ text: 'نص', swatches: null });
  assert.equal(report.results.length, 1);
  assert.equal(report.results.some((r) => r.check === 'source-keys'), false);
});
