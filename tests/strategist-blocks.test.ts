import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK_TAGS,
  DEFAULT_ACTION_BUDGET,
  DEFAULT_THRESHOLDS,
  buildStrategistBlocks,
  collectMeasures,
  collectSourceKeys,
  formatDelta,
  formatQuantity,
  keySegment,
  renderStrategistBlocks,
  uniqueSegments,
  type ClusterAggregate,
  type ProfileObservation,
  type StrategistData,
} from '../src/lib/agent/strategist/blocks.ts';
import { buildTiming, type TimingPost, type TimingResult } from '../src/lib/audience/timing.ts';
import type { AudienceInsightRow, BrandRow, DecisionRow } from '../src/lib/types/db.ts';

/* =============================================================== what this ==
 * blocks.ts is the contract between the data and the agent: every quantity the
 * strategist may speak arrives with a key, and everything that was NOT measured
 * arrives named, keyless, and explained. These tests hold that contract to two
 * properties that would otherwise erode silently:
 *
 *   1. the keys the agent SEES are exactly the keys collectSourceKeys() hands
 *      the Law check — neither side may drift;
 *   2. an absent measurement produces NO key and no zero.
 *
 * The fixtures are SHAPES, not claims. Where a real figure appears it is one of
 * the four proven ones (personal n=190 avg 508, academy n=130 avg 40, top post
 * 33176) or a value the timing engine computed here from the synthetic posts
 * below. Nothing in this file invents a measurement about the client.
 * ========================================================================= */

/* ------------------------------------------------------------- extraction -- */

/** A rendered measure always begins with its key in square brackets. */
const KEY_LINE = /^\[([^\]]+)\]/;
/** An absence always begins with these words and never carries a key. */
const ABSENCE_LINE = /^\(no measurement\) (\S+) — /;

function renderedKeys(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const match = KEY_LINE.exec(line);
    return match ? [match[1]] : [];
  });
}

function absenceNames(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const match = ABSENCE_LINE.exec(line);
    return match ? [match[1]] : [];
  });
}

function valueOf(data: StrategistData, key: string): string | null {
  const found = collectMeasures(data).find((measure) => measure.key === key);
  return found ? found.value : null;
}

/* --------------------------------------------------------------- fixtures -- */

const TODAY = '2026-08-15';
const SNAPSHOT_DAY = '2026-08-14';

/** Amman is UTC+3, so 17:00Z is 20:00 local — a real evening bucket. */
function timingPost(hourUtc: string, engagement: number, account: 'personal' | 'academy' = 'personal'): TimingPost {
  return { account, posted_at: `2026-06-10T${hourUtc}:00:00Z`, engagement };
}

/**
 * Twelve synthetic posts: six loud in the evening, six quiet in the morning.
 * Every timing figure in the full fixture is computed from these by the real
 * engine, so no window, average or n in this file was typed by hand.
 */
const SYNTHETIC_POSTS: TimingPost[] = [
  ...Array.from({ length: 6 }, () => timingPost('17', 900)),
  ...Array.from({ length: 6 }, () => timingPost('06', 100)),
];

function personalTiming(): TimingResult {
  return buildTiming(SYNTHETIC_POSTS, { account: 'personal' });
}

/** No academy post in the synthetic set, so this report has total_n 0. */
function academyTiming(): TimingResult {
  return buildTiming(SYNTHETIC_POSTS, { account: 'academy' });
}

/** The real sampled palette and real captions, as tests/law.test.ts uses them. */
function fullBrand(): BrandRow {
  return {
    id: 1,
    facts: [
      { key: 'positioning', value: 'أكاديمية تدريب', source: 'brand.facts' },
      // A synthetic fact whose only job is to carry Arabic-Indic digits through
      // the renderer untouched. It states nothing about the client.
      { key: 'fixture_digits', value: '٣٤٠٪', source: 'tests/strategist-blocks.test.ts' },
    ],
    voice_examples: [
      { text: 'البرّ هين … تكسب الناس باللين …', source_url: null, engagement: 508 },
      { text: 'الموضوع مش نكد 😅', source_url: null, engagement: null },
    ],
    knowledge: [{ title: 'Workshop', source: 'Workshop 2.pdf', kind: 'pdf', content: 'محتوى' }],
    assets: [],
    palette: { swatches: { turquoise: '#48C0C0', ink: '#181818' } },
    typography: { arabic_display: null, arabic_body: null, latin: null },
    audience_notes: 'ملاحظات',
    status: 'live',
    updated_at: `${SNAPSHOT_DAY}T00:00:00Z`,
  };
}

function fullProfiles(): Record<'personal' | 'academy', ProfileObservation | null> {
  return {
    personal: {
      taken_on: SNAPSHOT_DAY,
      followers: 1200,
      following: 300,
      posts_count: 190,
      previous: { taken_on: '2026-08-07', followers: 1150, following: 300, posts_count: 188 },
    },
    // Deliberately one-sided: the academy has a single observation, so its
    // delta must not exist rather than being computed against nothing.
    academy: {
      taken_on: SNAPSHOT_DAY,
      followers: 400,
      following: 120,
      posts_count: 130,
      previous: null,
    },
  };
}

function fullClusters(): ClusterAggregate[] {
  return [
    { label: 'reels', account: 'personal', n: 40, avg_engagement: 1016, vs_account_avg: 2 },
    // Same label on the other account: the key minter must not let one key
    // name two clusters.
    { label: 'reels', account: 'academy', n: 20, avg_engagement: 40, vs_account_avg: 1 },
    // An Arabic label, to prove a non-Latin cluster keeps an identity.
    { label: 'دروس', account: 'academy', n: 10, avg_engagement: null, vs_account_avg: null },
  ];
}

function fullAudience(): AudienceInsightRow {
  return {
    id: 'insight-1',
    generated_from: null,
    themes: [
      {
        label: 'التسعير',
        n: 12,
        quotes: [{ text: 'كم السعر؟', post_id: 'post-1', post_url: null }],
        grounding: 'data',
      },
    ],
    questions: [{ text: 'متى الدورة القادمة؟', post_id: 'post-1', post_url: null, asked_count: 7 }],
    register_notes: 'عامية أردنية',
    timing: null,
    grounding: 'data',
    created_at: `${SNAPSHOT_DAY}T00:00:00Z`,
  };
}

function fullLedger(): DecisionRow[] {
  return [
    {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'recommendation',
      statement_ar: 'انشر المحتوى المسائي على الحساب الشخصي',
      basis: [{ source_key: 'performance.personal.avg_engagement', value: '508' }],
      grounding: 'data',
      expected_signal: 'academy average moves toward the personal average',
      review_after: '2026-08-01',
      status: 'open',
      outcome_note: null,
      created_at: '2026-07-18T00:00:00Z',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'experiment',
      statement_ar: 'جرّب كاروسيل تعليمي',
      basis: [],
      grounding: 'hypothesis',
      expected_signal: 'carousel beats the account average',
      review_after: '2026-09-30',
      status: 'validated',
      outcome_note: 'أثبت التجربة',
      created_at: '2026-07-20T00:00:00Z',
    },
  ];
}

/** All seven blocks populated. */
function fullData(): StrategistData {
  return {
    brand: fullBrand(),
    guideline: { version: 1, status: 'draft', created_at: `${SNAPSHOT_DAY}T00:00:00Z` },
    profiles: fullProfiles(),
    performance: {
      snapshot: { id: 'snap-1', taken_on: SNAPSHOT_DAY },
      accounts: {
        // The four proven figures. 96520 is 190 x 508 and 5200 is 130 x 40 —
        // both derived from the canonical pair, neither invented.
        personal: {
          post_count: 190,
          total_engagement: 96520,
          avg_engagement: 508,
          top_post: { url: null, engagement: 33176, posted_at: '2026-06-10T17:00:00Z' },
        },
        academy: {
          post_count: 130,
          total_engagement: 5200,
          avg_engagement: 40,
          top_post: { url: null, engagement: 400, posted_at: null },
        },
      },
      clusters: fullClusters(),
      timing: [personalTiming(), academyTiming()],
      posts_coverage: { limit: 2000, rows_fetched: 320, truncated: false },
      duplicates_collapsed: 0,
      analyses_count: 70,
    },
    audience: fullAudience(),
    content: {
      counts: { draft: 3, approved: 2, shipped: 2, rejected: 1 },
      shipped: [
        {
          id: 'concept-1',
          title: 'Shipped and measured',
          account: 'personal',
          format: 'reel',
          shipped_url: 'https://www.instagram.com/p/AAA/',
          shipped_engagement: 508,
        },
        {
          id: 'concept-2',
          title: 'Shipped, never read back',
          account: 'academy',
          format: 'carousel',
          shipped_url: null,
          shipped_engagement: null,
        },
      ],
    },
    ledger: fullLedger(),
    meta: {
      today: TODAY,
      period: { from: '2026-08-09', to: TODAY },
      staleness_days: 1,
      action_budget: DEFAULT_ACTION_BUDGET,
      thresholds: DEFAULT_THRESHOLDS,
    },
  };
}

/**
 * The database as it actually stands on 2026-08-15: one snapshot of 320 posts,
 * and profile_snapshots, comments and post_analyses all empty.
 */
function todayData(): StrategistData {
  const full = fullData();
  return {
    ...full,
    profiles: { personal: null, academy: null },
    performance: {
      ...full.performance,
      clusters: [],
      analyses_count: 0,
      timing: [academyTiming(), academyTiming()],
    },
    audience: null,
  };
}

/** Nothing ingested at all. */
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

/* ------------------------------------------------------- keys and render -- */

test('every key the agent is shown is a key collectSourceKeys returns', () => {
  const data = fullData();
  const rendered = renderedKeys(renderStrategistBlocks(data));
  const collected = collectSourceKeys(data);

  assert.ok(rendered.length > 0, 'the full fixture should render measures');
  for (const key of rendered) {
    assert.ok(collected.has(key), `rendered key "${key}" is not collectable`);
  }
});

test('every key collectSourceKeys returns is a key the agent was shown', () => {
  const data = fullData();
  const rendered = new Set(renderedKeys(renderStrategistBlocks(data)));

  for (const key of collectSourceKeys(data)) {
    assert.ok(rendered.has(key), `collected key "${key}" was never rendered`);
  }
});

test('no key names two things', () => {
  const keys = collectMeasures(fullData()).map((measure) => measure.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('the same cluster label on two accounts gets two distinct keys', () => {
  const keys = collectSourceKeys(fullData());
  assert.ok(keys.has('performance.clusters.reels.n'));
  assert.ok(keys.has('performance.clusters.reels_2.n'));
  // …and each says which account it belongs to, so neither is ambiguous.
  assert.equal(valueOf(fullData(), 'performance.clusters.reels.account'), 'personal');
  assert.equal(valueOf(fullData(), 'performance.clusters.reels_2.account'), 'academy');
});

/* ----------------------------------------------- exhaustive over 7 blocks -- */

test('collectSourceKeys is exhaustive over a fixture with all seven blocks populated', () => {
  const data = fullData();
  const text = renderStrategistBlocks(data);
  const keys = collectSourceKeys(data);

  assert.equal(BLOCK_TAGS.length, 7);
  for (const tag of BLOCK_TAGS) {
    assert.ok(text.includes(`<${tag}>`), `missing block <${tag}>`);
    assert.ok(text.includes(`</${tag}>`), `unclosed block <${tag}>`);
    const namespace = [...keys].filter((key) => key.startsWith(`${tag}.`));
    assert.ok(namespace.length > 0, `block <${tag}> emitted no source_key`);
  }

  // One representative key from each block, so a silently emptied block fails.
  for (const key of [
    'brand.facts.positioning',
    'brand.guideline.version',
    'profiles.personal.followers',
    'profiles.personal.followers.delta',
    'performance.personal.avg_engagement',
    'performance.timing.personal.windows.1.n',
    'audience.themes.التسعير.n',
    'content_state.counts.approved',
    'content_state.shipped.backfill.pending',
    'ledger.counts.open',
    'ledger.due_for_review',
    'meta.action_budget',
  ]) {
    assert.ok(keys.has(key), `expected key "${key}"`);
  }
});

test('blocks are rendered in the documented order, behind the contract', () => {
  const text = renderStrategistBlocks(fullData());
  assert.ok(text.startsWith('<blocks_contract>'));
  const positions = BLOCK_TAGS.map((tag) => text.indexOf(`<${tag}>`));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `block ${BLOCK_TAGS[i]} is out of order`);
  }
});

/* ---------------------------------------------------------- absent ≠ zero -- */

test('an absent measurement emits NO key and renders as absent rather than 0', () => {
  const data = todayData();
  const text = renderStrategistBlocks(data);
  const keys = collectSourceKeys(data);

  // profile_snapshots is empty: no follower key exists at all.
  assert.equal(keys.has('profiles.personal.followers'), false);
  assert.equal(keys.has('profiles.academy.followers'), false);
  assert.ok(absenceNames(text).includes('profiles.personal'));
  assert.ok(/\(no measurement\) profiles\.personal — .*has ever been recorded/.test(text));

  // post_analyses is empty: no cluster aggregate exists.
  assert.equal(
    [...keys].some((key) => key.startsWith('performance.clusters.')),
    false,
  );
  assert.ok(absenceNames(text).includes('performance.clusters'));

  // comments is empty: nothing about what the audience says exists.
  assert.equal(
    [...keys].some((key) => key.startsWith('audience.')),
    false,
  );
  assert.ok(absenceNames(text).includes('audience'));

  // …and nowhere does an absence arrive dressed as a zero.
  assert.equal(text.includes('[profiles.personal.followers]'), false);
  assert.equal(text.includes('[audience.themes'), false);
});

test('the timing engine reporting overall_avg 0 is published as an absence, not an average', () => {
  const quiet = academyTiming();
  // timing.ts is explicit: overall_avg is 0 ONLY when total_n is 0, and a
  // consumer must branch rather than present that 0 as a measurement.
  assert.equal(quiet.total_n, 0);
  assert.equal(quiet.overall_avg, 0);

  const data = todayData();
  const keys = collectSourceKeys(data);
  assert.equal(keys.has('performance.timing.academy.overall_avg'), false);
  // The count itself is a real measurement and keeps its key with the value 0.
  assert.equal(valueOf(data, 'performance.timing.academy.total_n'), '0');
  assert.ok(absenceNames(renderStrategistBlocks(data)).includes('performance.timing.academy.overall_avg'));
});

test('a shipped concept with no backfilled result has no engagement key', () => {
  const data = fullData();
  const keys = collectSourceKeys(data);

  assert.equal(valueOf(data, 'content_state.shipped.1.engagement'), '508');
  assert.equal(keys.has('content_state.shipped.2.engagement'), false);
  assert.ok(absenceNames(renderStrategistBlocks(data)).includes('content_state.shipped.2.engagement'));
  // Counting how many are unmeasured IS a measurement, and keeps its key.
  assert.equal(valueOf(data, 'content_state.shipped.backfill.measured'), '1');
  assert.equal(valueOf(data, 'content_state.shipped.backfill.pending'), '1');
});

test('a single dated observation produces no delta', () => {
  const data = fullData();
  const keys = collectSourceKeys(data);

  assert.equal(valueOf(data, 'profiles.personal.followers.delta'), '+50');
  assert.equal(keys.has('profiles.academy.followers.delta'), false);
  assert.ok(absenceNames(renderStrategistBlocks(data)).includes('profiles.academy.followers.delta'));
});

test('the name of an absent thing is never a key', () => {
  for (const data of [fullData(), todayData(), emptyData()]) {
    const text = renderStrategistBlocks(data);
    const keys = collectSourceKeys(data);
    const names = absenceNames(text);
    assert.ok(names.length > 0, 'every fixture has something it did not measure');
    for (const name of names) {
      assert.equal(keys.has(name), false, `"${name}" is absent yet resolves as a key`);
    }
  }
});

/* --------------------------------------------------------------- verbatim -- */

test('a value containing Arabic-Indic digits survives verbatim', () => {
  const data = fullData();
  assert.equal(valueOf(data, 'brand.facts.fixture_digits'), '٣٤٠٪');
  // …and reaches the agent unescaped, between the quotes, on its own line.
  assert.ok(renderStrategistBlocks(data).includes('[brand.facts.fixture_digits]'));
  assert.ok(renderStrategistBlocks(data).includes('= "٣٤٠٪"'));
});

test('Arabic text and emoji survive the render intact', () => {
  const data = fullData();
  assert.equal(valueOf(data, 'brand.voice_examples.2'), 'الموضوع مش نكد 😅');
  assert.ok(renderStrategistBlocks(data).includes('الموضوع مش نكد 😅'));
});

test('an Arabic cluster label keeps an identity of its own', () => {
  assert.equal(keySegment('دروس'), 'دروس');
  assert.ok(collectSourceKeys(fullData()).has('performance.clusters.دروس.n'));
});

test('every measured value renders on exactly one line', () => {
  const data = fullData();
  const lines = renderStrategistBlocks(data).split('\n');
  assert.equal(renderedKeys(renderStrategistBlocks(data)).length, collectMeasures(data).length);
  for (const line of lines) assert.equal(line.includes('\n'), false);
});

/* ------------------------------------------------- no unkeyed quantities -- */

test('prose carries no digit — every number in the blocks has a key in front of it', () => {
  for (const data of [fullData(), todayData(), emptyData()]) {
    for (const line of renderStrategistBlocks(data).split('\n')) {
      // A measure line is allowed digits: that is the point of it.
      if (KEY_LINE.test(line)) continue;
      // An absence line is two halves. The NAME may carry an index or an id —
      // it is structure, and it is precisely the name of a thing that has no
      // value. Only the reason after the dash is prose, and prose may not
      // carry a quantity, because a number loose in prose is quotable with no
      // key behind it.
      const reason = ABSENCE_LINE.test(line) ? line.split(' — ').slice(1).join(' — ') : line;
      assert.equal(
        /[\d٠-٩]/.test(reason),
        false,
        `an unkeyed line carries a number, so it could be quoted without a source: ${line}`,
      );
    }
  }
});

/* ----------------------------------------- the real state of the database -- */

test("today's real state produces a coherent block set with no fabricated zeros", () => {
  const data = emptyData();
  const text = renderStrategistBlocks(data);
  const keys = collectSourceKeys(data);

  // Every block is still present and still says something.
  for (const tag of BLOCK_TAGS) assert.ok(text.includes(`<${tag}>`));

  // Nothing was measured, so no performance, profile or audience key exists.
  for (const prefix of ['performance.', 'profiles.', 'audience.', 'brand.']) {
    assert.equal(
      [...keys].some((key) => key.startsWith(prefix)),
      false,
      `an empty database should emit no ${prefix}* key`,
    );
  }

  // …but the counts that WERE taken keep their keys and their honest zeros: a
  // count of nothing is a measurement, an average over nothing is not.
  assert.equal(valueOf(data, 'content_state.counts.draft'), '0');
  assert.equal(valueOf(data, 'ledger.counts.open'), '0');
  assert.equal(valueOf(data, 'ledger.due_for_review'), '0');
  assert.equal(valueOf(data, 'meta.today'), TODAY);

  // No average, ratio or follower figure exists anywhere.
  for (const key of keys) {
    assert.equal(/avg_engagement$|vs_account_avg$|followers$/.test(key), false, key);
  }
  assert.equal(keys.has('meta.staleness_days'), false);
  assert.ok(absenceNames(text).includes('meta.staleness_days'));
});

test('the real snapshot state keeps its measured figures and drops the rest', () => {
  const data = todayData();
  const keys = collectSourceKeys(data);

  assert.equal(valueOf(data, 'performance.personal.avg_engagement'), '508');
  assert.equal(valueOf(data, 'performance.academy.avg_engagement'), '40');
  assert.equal(valueOf(data, 'performance.personal.top_post.engagement'), '33176');
  assert.equal(valueOf(data, 'performance.analyses.count'), '0');
  assert.equal(keys.has('profiles.personal.followers'), false);
});

test('a sample size travels with the average it belongs to', () => {
  const data = todayData();
  const measure = collectMeasures(data).find(
    (candidate) => candidate.key === 'performance.personal.avg_engagement',
  );
  assert.ok(measure);
  assert.equal(measure.n, 190);
  assert.equal(measure.as_of, SNAPSHOT_DAY);
  assert.ok(renderStrategistBlocks(data).includes('(n=190, as_of=2026-08-14)'));
});

/* ------------------------------------------------------ ledger arithmetic -- */

test('the ledger counts what is due for review, in code', () => {
  const data = fullData();
  // One open decision whose review date has passed; the validated one is not due.
  assert.equal(valueOf(data, 'ledger.due_for_review'), '1');
  assert.equal(valueOf(data, 'ledger.counts.open'), '1');
  assert.equal(valueOf(data, 'ledger.counts.validated'), '1');
  assert.equal(valueOf(data, 'ledger.counts.refuted'), '0');
});

test('a past decision carries its evidence back into context under its own key', () => {
  const data = fullData();
  const key = 'ledger.decisions.11111111-1111-4111-8111-111111111111.basis.performance_personal_avg_engagement';
  assert.equal(valueOf(data, key), '508');
});

test('an unreviewed decision has no outcome, and says so', () => {
  const data = fullData();
  const keys = collectSourceKeys(data);
  const base = 'ledger.decisions.11111111-1111-4111-8111-111111111111';
  assert.equal(keys.has(`${base}.outcome_note`), false);
  assert.ok(
    absenceNames(renderStrategistBlocks(data)).includes(`${base}.outcome_note`),
  );
});

/* --------------------------------------------------------------- helpers -- */

test('a quantity renders once, in one form', () => {
  assert.equal(formatQuantity(508), '508');
  assert.equal(formatQuantity(507.9736842105263), '507.97');
  // No thousands separators: the claims-linter traces a number by string match.
  assert.equal(formatQuantity(33176), '33176');
  assert.equal(formatQuantity(Number.NaN), null);
  assert.equal(formatQuantity(Number.POSITIVE_INFINITY), null);
});

test('a delta keeps its sign', () => {
  assert.equal(formatDelta(50), '+50');
  assert.equal(formatDelta(-7), '-7');
  assert.equal(formatDelta(0), '0');
});

test('key segments collapse separators and drop punctuation', () => {
  assert.equal(keySegment('Best Windows'), 'best_windows');
  assert.equal(keySegment('performance.personal.avg'), 'performance_personal_avg');
  assert.equal(keySegment('!!!'), '');
});

test('a colliding segment is disambiguated rather than allowed to overwrite', () => {
  assert.deepEqual(uniqueSegments(['reels', 'reels', 'reels']), ['reels', 'reels_2', 'reels_3']);
  assert.deepEqual(uniqueSegments(['!!!']), ['item_1']);
});

test('the action budget the blocks state is the one the code defaults to', () => {
  assert.equal(DEFAULT_ACTION_BUDGET, 3);
  assert.equal(valueOf(fullData(), 'meta.action_budget'), '3');
  assert.equal(
    valueOf(fullData(), 'meta.thresholds.min_cluster_n'),
    String(DEFAULT_THRESHOLDS.min_cluster_n),
  );
});

test('render and collect read the same block list', () => {
  const data = fullData();
  const blocks = buildStrategistBlocks(data);
  const fromBlocks = blocks.flatMap((block) => block.measures.map((measure) => measure.key));
  assert.deepEqual(fromBlocks, collectMeasures(data).map((measure) => measure.key));
  assert.deepEqual(fromBlocks, renderedKeys(renderStrategistBlocks(data)));
});
