import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MIN_GROUP_N,
  MAX_COMPOSITION_TAGS,
  TEXT_COVERAGE_BANDS,
  TEXT_CLEAN_BANDS,
  TEXT_HEAVY_BANDS,
  TEXT_UNASSIGNED_BANDS,
  buildVisualAnalytics,
  collectSourceKeys,
  facetReports,
  type AnalyticsFeature,
  type AnalyticsPost,
  type FacetReport,
  type GroupStat,
  type VisualAnalytics,
  type WithheldGroup,
} from '../src/lib/vision/analytics.ts';
import type { Account } from '../src/lib/types/db.ts';

/* ================================================================ what this ==
 *
 * Two things are proven here, and the line between them matters because one of
 * them can be executed today and the other cannot.
 *
 * PART A — src/lib/vision/analytics.ts, in full, with no model and no network.
 *   Every aggregate is checked against a fixture whose average was worked out
 *   by hand and written into the assertion, so a change to the arithmetic
 *   fails here rather than shipping a plausible number. The three properties
 *   the brief singles out each get their own test: low-n groups are EXCLUDED
 *   rather than caveated, a group with no members yields ABSENCE rather than
 *   zero, and the result is a function of the data alone rather than of the
 *   order the rows arrived in.
 *
 * PART B — the parts of /api/visual that do not need a model: the rule 15 cost
 *   ceiling and the refusal it produces. The route is driven through its real
 *   GET and POST with a fake database, a storage layer that throws if it is
 *   touched, and a global `fetch` that throws if it is called. So "a run that
 *   cannot be priced spends nothing" is asserted rather than asserted-about:
 *   if the block ever stopped working, the stubs would raise instead of the
 *   assertion merely reading differently.
 *
 * WHAT IS NOT PROVEN HERE, and no test in this file pretends otherwise: the
 *   vision call itself. Describing an image needs a vision-capable model, and
 *   there is no OPENROUTER_API_KEY in this environment. The prompt, the
 *   response schema, the contradiction check and the insert are WRITTEN AND
 *   TYPECHECKED, and they are unexecuted. What would prove them is one POST
 *   against a real key with at least one mirrored object in the bucket — and
 *   the bucket is empty today, because posts.raw is null for all 320 stored
 *   rows and their Instagram CDN URLs have long expired.
 */

/* ============================================================ PART A setup == */

const SNAPSHOT = 'snapshot-newest';

function post(
  igId: string,
  engagement: number,
  account: Account = 'personal',
  snapshotId: string = SNAPSHOT,
): AnalyticsPost {
  return {
    ig_id: igId,
    snapshot_id: snapshotId,
    // A real instant, so the shape is honest; nothing in this module reads it.
    posted_at: '2026-06-10T18:00:00Z',
    account,
    engagement,
  };
}

/**
 * A DESCRIBED feature row. `model` is non-null by default because that is what
 * makes a row count as read — a row with every descriptive column filled in and
 * `model: null` is not a description, and one test below turns exactly that
 * knob.
 */
function feature(igId: string, over: Partial<AnalyticsFeature> = {}): AnalyticsFeature {
  return {
    ig_id: igId,
    has_face: null,
    text_coverage: null,
    logo_present: null,
    composition_tags: null,
    model: 'test-model',
    ...over,
  };
}

function groupByKey(report: FacetReport, key: string): GroupStat | undefined {
  return report.groups.find((group) => group.key === key);
}

function withheldByKey(report: FacetReport, key: string): WithheldGroup | undefined {
  return report.withheld.find((group) => group.key === key);
}

/** The group named, or a failed assertion. Keeps every test free of `!`. */
function requireGroup(report: FacetReport, key: string): GroupStat {
  const group = groupByKey(report, key);
  assert.ok(group !== undefined, `expected a reported group "${key}" on facet ${report.facet}`);
  return group;
}

function requireWithheld(report: FacetReport, key: string): WithheldGroup {
  const group = withheldByKey(report, key);
  assert.ok(group !== undefined, `expected a withheld group "${key}" on facet ${report.facet}`);
  return group;
}

/**
 * Every number that appears anywhere in a report, so a test can assert that a
 * particular value is nowhere in the payload at all — which is a stronger claim
 * than "the field I looked at was null".
 */
function everyNumber(value: unknown, found: number[] = []): number[] {
  if (typeof value === 'number') found.push(value);
  else if (Array.isArray(value)) for (const item of value) everyNumber(item, found);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) everyNumber(item, found);
  }
  return found;
}

/* ================================================== A1 — the headline split == */

test('face vs no-face: hand-computed averages, with n, and the multiple', () => {
  const posts = [
    post('f1', 100),
    post('f2', 200),
    post('f3', 300),
    post('f4', 400),
    post('f5', 500),
    post('n1', 10),
    post('n2', 20),
    post('n3', 30),
    post('n4', 40),
    post('n5', 50),
  ];
  const features = [
    ...['f1', 'f2', 'f3', 'f4', 'f5'].map((id) => feature(id, { has_face: true })),
    ...['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => feature(id, { has_face: false })),
  ];

  const report = buildVisualAnalytics(posts, features);

  // 1500 / 5 = 300 and 150 / 5 = 30; the corpus is 1650 / 10 = 165.
  assert.equal(report.population.described, 10);
  assert.equal(report.population.overall_avg_engagement, 165);

  const withFace = requireGroup(report.face, 'with_face');
  assert.equal(withFace.n, 5);
  assert.equal(withFace.avg_engagement, 300);
  // 300 / 165 = 1.8181…, rounded to 1.82 — NOT (300 rounded) / (165 rounded)
  // computed a second time, which is how a ratio drifts off the two figures a
  // reader can see on screen.
  assert.equal(withFace.multiple_vs_overall, 1.82);
  assert.deepEqual(withFace.accounts, { personal: 5, academy: 0 });

  const withoutFace = requireGroup(report.face, 'without_face');
  assert.equal(withoutFace.n, 5);
  assert.equal(withoutFace.avg_engagement, 30);
  assert.equal(withoutFace.multiple_vs_overall, 0.18); // 30 / 165 = 0.1818…

  // Fixed vocabularies come back in declared order, whichever group won.
  assert.deepEqual(
    report.face.groups.map((group) => group.key),
    ['with_face', 'without_face'],
  );
  assert.equal(report.face.domain, 'fixed');
  assert.equal(report.face.partition, true);
  assert.equal(report.face.unassigned, 0);
  assert.equal(report.face.min_group_n, MIN_GROUP_N);
});

test('has_face null is its own group, never folded into "without a face"', () => {
  const posts = [
    ...Array.from({ length: 5 }, (_unused, index) => post(`f${index}`, 100)),
    ...Array.from({ length: 5 }, (_unused, index) => post(`u${index}`, 900)),
  ];
  const features = [
    ...Array.from({ length: 5 }, (_unused, index) => feature(`f${index}`, { has_face: true })),
    // Described rows whose face could not be determined.
    ...Array.from({ length: 5 }, (_unused, index) => feature(`u${index}`, { has_face: null })),
  ];

  const report = buildVisualAnalytics(posts, features);

  assert.equal(requireGroup(report.face, 'with_face').n, 5);
  assert.equal(requireGroup(report.face, 'unknown').n, 5);
  // The load-bearing assertion: the five undetermined posts did NOT land here.
  assert.equal(requireWithheld(report.face, 'without_face').n, 0);
});

/* =========================================== A2 — the floor, and what it does */

test('a group below the floor is excluded, and no average for it exists anywhere', () => {
  const posts = [
    // Four is one short of MIN_GROUP_N, and they are loud enough that including
    // them would visibly move the report.
    ...Array.from({ length: 4 }, (_unused, index) => post(`f${index}`, 10_000)),
    ...Array.from({ length: 6 }, (_unused, index) => post(`n${index}`, 100)),
  ];
  const features = [
    ...Array.from({ length: 4 }, (_unused, index) => feature(`f${index}`, { has_face: true })),
    ...Array.from({ length: 6 }, (_unused, index) => feature(`n${index}`, { has_face: false })),
  ];

  const report = buildVisualAnalytics(posts, features);

  assert.equal(groupByKey(report.face, 'with_face'), undefined);
  const withheld = requireWithheld(report.face, 'with_face');
  assert.equal(withheld.n, 4);
  assert.deepEqual(withheld.accounts, { personal: 4, academy: 0 });
  // A withheld group has a size and no average — not a null average, no average.
  assert.equal('avg_engagement' in withheld, false);
  assert.equal('multiple_vs_overall' in withheld, false);
  // 10000 is the excluded group's average. It must not appear in the payload at
  // all, under any key, in any facet.
  assert.equal(everyNumber(report).includes(10_000), false);

  // The floor is reported, so a surface can say WHY the group is missing.
  assert.equal(report.face.min_group_n, MIN_GROUP_N);
  assert.equal(report.min_group_n, MIN_GROUP_N);

  // The reported side is unaffected: 6 posts at 100 each.
  assert.equal(requireGroup(report.face, 'without_face').avg_engagement, 100);
});

test('the floor is configurable, and a lowered floor lets the same group through', () => {
  const posts = Array.from({ length: 4 }, (_unused, index) => post(`f${index}`, 200));
  const features = posts.map((row) => feature(row.ig_id, { has_face: true }));

  assert.equal(groupByKey(buildVisualAnalytics(posts, features).face, 'with_face'), undefined);

  const loosened = buildVisualAnalytics(posts, features, { minGroupN: 4 });
  assert.equal(requireGroup(loosened.face, 'with_face').n, 4);
  assert.equal(loosened.min_group_n, 4);
  // …and the report says which floor produced it, rather than leaving a reader
  // to assume the default was in force.
  assert.equal(loosened.face.min_group_n, 4);
});

/* ============================================ A3 — absence is not a zero ==== */

test('an empty corpus reports absence, never zero', () => {
  const report = buildVisualAnalytics([], []);

  assert.equal(report.population.described, 0);
  assert.equal(report.population.posts, 0);
  // The one that matters: an average over nothing is null. A 0 here would be a
  // fabricated measurement — "this account averages zero engagement".
  assert.equal(report.population.overall_avg_engagement, null);

  for (const facet of facetReports(report)) {
    assert.deepEqual(facet.groups, [], `${facet.facet} reported a group from nothing`);
  }

  // The fixed vocabularies still account for themselves, at n = 0.
  assert.deepEqual(
    report.face.withheld.map((group) => group.key).sort(),
    ['unknown', 'with_face', 'without_face'],
  );
  for (const group of report.face.withheld) {
    assert.equal(group.n, 0);
    assert.equal('avg_engagement' in group, false);
  }
  // An OBSERVED vocabulary has nothing to withhold: a tag nobody used is not a
  // group with no members, it is not a group.
  assert.deepEqual(report.composition_tag.withheld, []);
  assert.equal(report.composition_tag.domain, 'observed');
});

test('a group with no members carries a count and no average', () => {
  const posts = Array.from({ length: 6 }, (_unused, index) => post(`n${index}`, 50));
  const features = posts.map((row) => feature(row.ig_id, { has_face: false }));

  const report = buildVisualAnalytics(posts, features);

  const empty = requireWithheld(report.face, 'with_face');
  assert.equal(empty.n, 0);
  assert.equal('avg_engagement' in empty, false);
  // It still has a key, so a surface can render the row and put an em-dash in
  // the average column rather than omitting the row and implying it never
  // existed.
  assert.equal(empty.source_key, 'visual.face.with_face');
});

test('a multiple against a zero baseline is null, not Infinity and not zero', () => {
  // Every post has zero engagement, so the corpus average is a real, measured 0.
  const posts = Array.from({ length: 6 }, (_unused, index) => post(`z${index}`, 0));
  const features = posts.map((row) => feature(row.ig_id, { has_face: true }));

  const report = buildVisualAnalytics(posts, features);

  assert.equal(report.population.overall_avg_engagement, 0);
  const group = requireGroup(report.face, 'with_face');
  assert.equal(group.avg_engagement, 0);
  assert.equal(group.multiple_vs_overall, null);
  assert.equal(everyNumber(report).some((value) => !Number.isFinite(value)), false);
});

/* ================================ A4 — the arithmetic is order-independent === */

test('the report is a function of the data, not of the row order', () => {
  const posts = [
    post('a', 100),
    post('b', 200, 'academy'),
    post('c', 300),
    post('d', 400, 'academy'),
    post('e', 500),
    post('f', 600),
    post('g', 700, 'academy'),
    post('h', 800),
    post('i', 900),
    post('j', 1000),
  ];
  const features = posts.map((row, index) =>
    feature(row.ig_id, {
      has_face: index % 2 === 0,
      logo_present: index % 3 === 0,
      text_coverage: TEXT_COVERAGE_BANDS[index % TEXT_COVERAGE_BANDS.length],
      composition_tags: index % 2 === 0 ? ['بورتريه'] : ['نص على خلفية', 'بورتريه'],
    }),
  );

  const forwards = buildVisualAnalytics(posts, features);
  const backwards = buildVisualAnalytics([...posts].reverse(), [...features].reverse());
  // A rotation as well as a reversal: a reversal alone would not catch a rule
  // that happened to be symmetric.
  const rotated = buildVisualAnalytics(
    [...posts.slice(4), ...posts.slice(0, 4)],
    [...features.slice(7), ...features.slice(0, 7)],
  );

  // Engagements are integers, so the sums are exact and the comparison is a
  // statement about the algorithm rather than about floating-point addition.
  assert.deepEqual(backwards, forwards);
  assert.deepEqual(rotated, forwards);
});

/* =============================================== A5 — the collapse, defended = */

test('a post re-scraped into a second snapshot is counted once', () => {
  const posts = [
    // Newest snapshot first — distinctPosts()' documented contract, and the
    // order every caller in this app reads rows in.
    post('same', 900, 'personal', 'snapshot-newest'),
    post('same', 100, 'personal', 'snapshot-older'),
    ...Array.from({ length: 5 }, (_unused, index) =>
      post(`other${index}`, 100, 'personal', 'snapshot-newest'),
    ),
  ];
  const features = [
    feature('same', { has_face: true }),
    ...Array.from({ length: 5 }, (_unused, index) => feature(`other${index}`, { has_face: false })),
  ];

  const report = buildVisualAnalytics(posts, features);

  assert.equal(report.population.posts_in, 7);
  assert.equal(report.population.duplicates_collapsed, 1);
  assert.equal(report.population.posts, 6);
  assert.equal(report.population.described, 6);
  // The newer row won, so the collapsed post carries 900 and not 100.
  // (900 + 5 x 100) / 6 = 233.33…
  assert.equal(report.population.overall_avg_engagement, 233.33);
});

/* ================================================= A6 — who is measured ====== */

test('a feature with no model is mirrored work, not described work', () => {
  const posts = Array.from({ length: 6 }, (_unused, index) => post(`p${index}`, 100));
  const features = [
    ...Array.from({ length: 3 }, (_unused, index) => feature(`p${index}`, { has_face: true })),
    // Rows the mirror created and no model has read: every column null.
    ...Array.from({ length: 3 }, (_unused, index) => feature(`p${index + 3}`, { model: null })),
  ];

  const report = buildVisualAnalytics(posts, features);

  assert.equal(report.population.features_in, 6);
  assert.equal(report.population.features_undescribed, 3);
  assert.equal(report.population.described, 3);
  assert.equal(report.population.undescribed, 3);
  // The three unread rows did not become three "unknown face" posts, which is
  // what would have quietly happened had `model` been ignored.
  assert.equal(requireWithheld(report.face, 'unknown').n, 0);
});

test('an orphaned feature and an out-of-account feature are counted apart', () => {
  const posts = [post('p1', 100, 'personal'), post('a1', 40, 'academy')];
  const features = [
    feature('p1', { has_face: true }),
    feature('a1', { has_face: false }),
    feature('ghost', { has_face: true }),
  ];

  const all = buildVisualAnalytics(posts, features);
  assert.equal(all.population.features_unmatched, 1);
  assert.equal(all.population.features_other_account, 0);
  assert.equal(all.population.described, 2);

  const personal = buildVisualAnalytics(posts, features, { account: 'personal' });
  // The academy row is not an orphan — its post exists, it is simply out of
  // scope. Reporting it as unmatched would look like a data fault.
  assert.equal(personal.population.features_unmatched, 1);
  assert.equal(personal.population.features_other_account, 1);
  assert.equal(personal.population.described, 1);
  assert.equal(personal.account, 'personal');
});

test('an unreadable engagement is dropped, never measured as zero', () => {
  const posts = [
    ...Array.from({ length: 5 }, (_unused, index) => post(`p${index}`, 100)),
    post('broken', Number.NaN),
  ];
  const features = [
    ...Array.from({ length: 5 }, (_unused, index) => feature(`p${index}`, { has_face: true })),
    feature('broken', { has_face: true }),
  ];

  const report = buildVisualAnalytics(posts, features);

  assert.equal(report.population.engagement_unreadable, 1);
  assert.equal(report.population.described, 5);
  // 5 x 100 / 5. A sixth post read as 0 would have produced 83.33.
  assert.equal(report.population.overall_avg_engagement, 100);
  assert.equal(requireGroup(report.face, 'with_face').n, 5);
});

/* ============================================ A7 — the account confound ====== */

test('the account filter is what separates a face effect from an account effect', () => {
  // The shape of the real corpus: the face is on personal, the designs are on
  // academy, and personal out-performs academy by an order of magnitude.
  const posts = [
    ...Array.from({ length: 5 }, (_unused, index) => post(`p${index}`, 500, 'personal')),
    ...Array.from({ length: 5 }, (_unused, index) => post(`a${index}`, 40, 'academy')),
  ];
  const features = [
    ...Array.from({ length: 5 }, (_unused, index) => feature(`p${index}`, { has_face: true })),
    ...Array.from({ length: 5 }, (_unused, index) => feature(`a${index}`, { has_face: false })),
  ];

  const both = buildVisualAnalytics(posts, features);
  const withFace = requireGroup(both.face, 'with_face');
  assert.equal(withFace.avg_engagement, 500);
  assert.equal(requireGroup(both.face, 'without_face').avg_engagement, 40);
  // Nothing is hidden and nothing is judged — but the mix is on the row, so a
  // reader can see that the comparison is one account against the other.
  assert.deepEqual(withFace.accounts, { personal: 5, academy: 0 });
  assert.deepEqual(requireGroup(both.face, 'without_face').accounts, { personal: 0, academy: 5 });

  const personalOnly = buildVisualAnalytics(posts, features, { account: 'personal' });
  assert.equal(personalOnly.population.posts, 5);
  assert.equal(requireGroup(personalOnly.face, 'with_face').n, 5);
  // Within personal there is no comparison to make, and the report says so by
  // withholding rather than by reporting a face effect that rests on nothing.
  assert.equal(requireWithheld(personalOnly.face, 'without_face').n, 0);
});

/* ============================================= A8 — text: bands and the split = */

test('the clean/heavy split covers every band exactly once', () => {
  const assigned = [...TEXT_CLEAN_BANDS, ...TEXT_HEAVY_BANDS, ...TEXT_UNASSIGNED_BANDS];
  assert.deepEqual([...assigned].sort(), [...TEXT_COVERAGE_BANDS].sort());
  assert.equal(new Set(assigned).size, assigned.length, 'a band is in two lists');
  // The middle band is deliberately in neither side of the split.
  assert.deepEqual([...TEXT_UNASSIGNED_BANDS], ['moderate']);
});

test('text coverage: per-band averages, and the split that refuses the middle', () => {
  const engagementFor: Record<string, number> = { none: 10, light: 20, moderate: 30, heavy: 40 };
  const posts: AnalyticsPost[] = [];
  const features: AnalyticsFeature[] = [];
  for (const band of TEXT_COVERAGE_BANDS) {
    for (let index = 0; index < 5; index += 1) {
      const igId = `${band}${index}`;
      posts.push(post(igId, engagementFor[band]));
      features.push(feature(igId, { text_coverage: band }));
    }
  }

  const report = buildVisualAnalytics(posts, features);

  // (5x10 + 5x20 + 5x30 + 5x40) / 20 = 500 / 20 = 25.
  assert.equal(report.population.overall_avg_engagement, 25);

  assert.deepEqual(
    report.text_coverage.groups.map((group) => [group.key, group.n, group.avg_engagement]),
    [
      ['none', 5, 10],
      ['light', 5, 20],
      ['moderate', 5, 30],
      ['heavy', 5, 40],
    ],
  );
  assert.equal(requireGroup(report.text_coverage, 'heavy').multiple_vs_overall, 1.6);
  assert.equal(requireGroup(report.text_coverage, 'none').multiple_vs_overall, 0.4);
  // Both catch-alls exist and are empty, so a vocabulary drift would show up as
  // a non-zero off_vocabulary rather than as missing rows.
  assert.equal(requireWithheld(report.text_coverage, 'unknown').n, 0);
  assert.equal(requireWithheld(report.text_coverage, 'off_vocabulary').n, 0);

  // clean = none + light = 10 posts, (50 + 100) / 10 = 15.
  assert.equal(requireGroup(report.text_density, 'clean').n, 10);
  assert.equal(requireGroup(report.text_density, 'clean').avg_engagement, 15);
  assert.equal(requireGroup(report.text_density, 'heavy').n, 5);
  assert.equal(requireGroup(report.text_density, 'heavy').avg_engagement, 40);
  // The five moderate posts are on neither side, and are counted saying so.
  assert.equal(report.text_density.unassigned, 5);
  assert.equal(
    requireGroup(report.text_density, 'clean').n + requireGroup(report.text_density, 'heavy').n,
    report.population.described - report.text_density.unassigned,
  );
});

test('a band nobody declared lands in off_vocabulary, apart from a missing one', () => {
  const posts = [
    ...Array.from({ length: 5 }, (_unused, index) => post(`x${index}`, 100)),
    ...Array.from({ length: 5 }, (_unused, index) => post(`y${index}`, 100)),
  ];
  const features = [
    // A model that answered "medium" instead of "moderate".
    ...Array.from({ length: 5 }, (_unused, index) =>
      feature(`x${index}`, { text_coverage: 'medium' }),
    ),
    ...Array.from({ length: 5 }, (_unused, index) =>
      feature(`y${index}`, { text_coverage: null }),
    ),
  ];

  const report = buildVisualAnalytics(posts, features);

  assert.equal(requireGroup(report.text_coverage, 'off_vocabulary').n, 5);
  assert.equal(requireGroup(report.text_coverage, 'unknown').n, 5);
  // Neither is a side of the split.
  assert.equal(report.text_density.unassigned, 10);
  assert.deepEqual(report.text_density.groups, []);
});

/* ========================================== A9 — composition tags, multi-label */

test('composition tags: per-tag averages over a multi-label column', () => {
  const rows: [string, number, string[]][] = [
    ['a', 100, ['بورتريه']],
    ['b', 200, ['بورتريه']],
    ['c', 300, ['بورتريه', 'نص']],
    ['d', 400, ['بورتريه', 'نص']],
    ['e', 500, ['بورتريه', 'نص']],
    ['f', 600, ['نص']],
    ['g', 700, ['نص']],
    ['h', 800, []],
  ];
  const posts = rows.map(([igId, engagement]) => post(igId, engagement));
  const features = rows.map(([igId, , tags]) => feature(igId, { composition_tags: tags }));

  const report = buildVisualAnalytics(posts, features);

  // 3600 / 8 = 450.
  assert.equal(report.population.overall_avg_engagement, 450);

  const portrait = requireGroup(report.composition_tag, 'بورتريه');
  assert.equal(portrait.n, 5);
  assert.equal(portrait.avg_engagement, 300); // 1500 / 5
  assert.equal(portrait.multiple_vs_overall, 0.67); // 300 / 450 = 0.666…

  const text = requireGroup(report.composition_tag, 'نص');
  assert.equal(text.n, 5);
  assert.equal(text.avg_engagement, 500); // 2500 / 5
  assert.equal(text.multiple_vs_overall, 1.11); // 500 / 450 = 1.111…

  // Ranked: strongest average first, whatever order the rows arrived in.
  assert.deepEqual(
    report.composition_tag.groups.map((group) => group.key),
    ['نص', 'بورتريه'],
  );

  // The n's sum to 10 over a population of 8, and the report says why: this
  // facet is not a partition, so nothing may render these as shares of a whole.
  assert.equal(portrait.n + text.n, 10);
  assert.equal(report.composition_tag.partition, false);
  assert.equal(report.population.described, 8);
  // The untagged post is counted, not silently dropped.
  assert.equal(report.composition_tag.unassigned, 1);
});

test('a tag repeated on one post counts that post once, and the cap holds', () => {
  const posts = Array.from({ length: 5 }, (_unused, index) => post(`p${index}`, 100));
  const tooMany = Array.from({ length: MAX_COMPOSITION_TAGS + 3 }, (_unused, i) => `tag${i}`);
  const features = posts.map((row) =>
    // The same tag three times, then more distinct tags than the cap allows.
    feature(row.ig_id, { composition_tags: ['مكرر', 'مكرر', ' مكرر ', ...tooMany] }),
  );

  const report = buildVisualAnalytics(posts, features);

  const repeated = requireGroup(report.composition_tag, 'مكرر');
  assert.equal(repeated.n, 5, 'a duplicated tag counted its post more than once');
  // The cap counts DISTINCT tags, and the repeat plus the first five of `tooMany`
  // fill it — so the tags past the cap contribute nothing at all.
  const kept = report.composition_tag.groups.length + report.composition_tag.withheld.length;
  assert.equal(kept, MAX_COMPOSITION_TAGS);
  assert.equal(groupByKey(report.composition_tag, `tag${MAX_COMPOSITION_TAGS + 2}`), undefined);
  assert.equal(withheldByKey(report.composition_tag, `tag${MAX_COMPOSITION_TAGS + 2}`), undefined);
});

test('a blank or whitespace tag is not a group', () => {
  const posts = Array.from({ length: 5 }, (_unused, index) => post(`p${index}`, 100));
  const features = posts.map((row) => feature(row.ig_id, { composition_tags: ['', '   '] }));

  const report = buildVisualAnalytics(posts, features);

  assert.deepEqual(report.composition_tag.groups, []);
  assert.deepEqual(report.composition_tag.withheld, []);
  // Every post carried only unusable tags, so every post is unassigned.
  assert.equal(report.composition_tag.unassigned, 5);
});

/* ============================================ A10 — hard rule 12, the keys === */

test('every quantity is filed under a key, and no key is used twice', () => {
  const posts = Array.from({ length: 6 }, (_unused, index) => post(`p${index}`, 100 * (index + 1)));
  // All six carry a face, so `with_face` is REPORTED while `without_face` and
  // `unknown` are WITHHELD — the fixture needs both kinds of group present,
  // because the point of the test is that they are filed differently.
  const features = posts.map((row) =>
    feature(row.ig_id, {
      has_face: true,
      logo_present: true,
      text_coverage: 'light',
      composition_tags: ['بورتريه'],
    }),
  );

  const report = buildVisualAnalytics(posts, features);
  const keys = collectSourceKeys(report);

  assert.equal(new Set(keys).size, keys.length, 'a source key is used twice');
  assert.ok(keys.includes('visual.face.with_face.n'));
  assert.ok(keys.includes('visual.face.with_face.avg_engagement'));
  assert.ok(keys.includes('visual.face.with_face.multiple_vs_overall'));
  // A withheld group is filed under a key for its COUNT and under none for an
  // average, because there is no average to cite.
  assert.ok(keys.includes('visual.face.unknown.n'));
  assert.equal(keys.includes('visual.face.unknown.avg_engagement'), false);

  for (const facet of facetReports(report)) {
    for (const group of [...facet.groups, ...facet.withheld]) {
      assert.equal(group.source_key, `visual.${facet.facet}.${group.key}`);
      assert.equal(group.facet, facet.facet);
    }
  }
});

/* ============================================================ PART B setup ==
 *
 * The route is a Next module: it imports next/server, the auth gate, the
 * service-role client, the cookie-backed quality preference and the agent
 * client, none of which can run here. Node's module hooks swap those five for
 * stubs, and everything else — @/lib/env, @/lib/agent/provider, the REAL rate
 * table in @/lib/agent/rates, @/lib/audience/posts and the analytics module
 * above — runs unmodified. The rate table in particular is deliberately real:
 * a stubbed price would make the cost assertions below assert nothing.
 *
 * @/lib/ingest/media is stubbed for a different reason and it is worth naming:
 * that module is being edited by another agent as this is written, and a test
 * of THIS route should not go red because a neighbouring file is mid-save. The
 * stub reproduces mirrorPathFor()'s id shape and path exactly; if that ever
 * diverges, this file is where to fix it.
 */

const SRC = new URL('../src/', import.meta.url).href;

const NEXT_STUB = 'stub:next-server';
const AUTH_STUB = 'stub:lib-auth';
const DB_STUB = 'stub:lib-supabase-admin';
const PREFS_STUB = 'stub:lib-prefs-server';
const AGENT_STUB = 'stub:lib-agent-client';
const MEDIA_STUB = 'stub:lib-ingest-media';

const STUBS: Record<string, string> = {
  'next/server': NEXT_STUB,
  '@/lib/auth': AUTH_STUB,
  '@/lib/supabase/admin': DB_STUB,
  '@/lib/prefs.server': PREFS_STUB,
  '@/lib/agent/client': AGENT_STUB,
  '@/lib/ingest/media': MEDIA_STUB,
};

const STUB_SOURCE: Record<string, string> = {
  [NEXT_STUB]:
    'export const NextResponse = {' +
    '  json(body, init) {' +
    '    return { status: (init && init.status) || 200, body };' +
    '  },' +
    '};',
  [AUTH_STUB]:
    'export class HttpError extends Error {' +
    '  constructor(status, message, hint) {' +
    '    super(message);' +
    '    this.name = "HttpError";' +
    '    this.status = status;' +
    '    this.hint = hint;' +
    '  }' +
    '}' +
    'export async function requireOperator() { return { email: "operator@test" }; }' +
    'export function errorResponse(err) {' +
    '  const status = typeof err?.status === "number" ? err.status : 500;' +
    '  return { status, body: { error: err?.message ?? "Unexpected", hint: err?.hint ?? null } };' +
    '}',
  [DB_STUB]:
    'let factory = null;' +
    'export function __setDb(fn) { factory = fn; }' +
    'export function supabaseAdmin() {' +
    '  if (!factory) throw new Error("visual-analytics.test.ts: no fake database installed.");' +
    '  return factory();' +
    '}',
  [PREFS_STUB]: 'export async function readQuality() { return "standard"; }',
  [AGENT_STUB]:
    'export function extractJson() {' +
    '  throw new Error("visual-analytics.test.ts: extractJson was reached, so a model response was parsed.");' +
    '}',
  [MEDIA_STUB]:
    'export const MAX_OBJECT_BYTES = 4 * 1024 * 1024;' +
    'export function mirrorPathFor(account, igId) {' +
    '  return /^[A-Za-z0-9_-]{1,64}$/.test(igId) ? `post-media/${account}/${igId}` : null;' +
    '}',
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

/* ------------------------------------------------------------ the fake db -- */

interface QueryResult {
  data: unknown[];
  error: { message: string } | null;
}

interface FakeQuery {
  select(columns?: string): FakeQuery;
  order(column: string, opts?: { ascending: boolean }): FakeQuery;
  limit(count: number): FakeQuery;
  upsert(rows: unknown, opts?: { onConflict: string }): Promise<{ error: null }>;
  then(
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): Promise<unknown>;
}

interface DbState {
  rows: Record<string, unknown[]>;
  /** Object names per account prefix, i.e. what the bucket listing returns. */
  objects: Record<string, string[]>;
  upserts: unknown[];
  /** Every storage read attempted. A blocked run must leave this empty. */
  downloads: string[];
  /** Set true to make any download throw — proves no bandwidth was spent. */
  downloadsForbidden: boolean;
}

const state: DbState = {
  rows: {},
  objects: {},
  upserts: [],
  downloads: [],
  downloadsForbidden: false,
};

function fakeQuery(table: string): FakeQuery {
  const query: FakeQuery = {
    select: () => query,
    order: () => query,
    limit: () => query,
    upsert: (rows) => {
      state.upserts.push(rows);
      return Promise.resolve({ error: null });
    },
    then: (onFulfilled, onRejected) =>
      Promise.resolve({ data: state.rows[table] ?? [], error: null }).then(onFulfilled, onRejected),
  };
  return query;
}

interface DbStubModule {
  __setDb(factory: () => unknown): void;
}

const dbStub = (await import('@/lib/supabase/admin')) as unknown as DbStubModule;

dbStub.__setDb(() => ({
  from: (table: string) => fakeQuery(table),
  storage: {
    from: () => ({
      list: (prefix: string) =>
        Promise.resolve({
          data: (state.objects[prefix] ?? []).map((name) => ({ name })),
          error: null,
        }),
      download: (path: string) => {
        state.downloads.push(path);
        if (state.downloadsForbidden) {
          throw new Error(`visual-analytics.test.ts: a blocked run downloaded ${path}.`);
        }
        return Promise.resolve({ data: null, error: { message: 'not stored in this fixture' } });
      },
    }),
  },
}));

/**
 * Every network call is a test failure. Nothing below should reach a model, and
 * a stub that quietly answered would let "nothing was spent" pass while it was.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('visual-analytics.test.ts: the route called fetch, so a model was reached.');
};
void realFetch;

const route = await import('../src/app/api/visual/route.ts');

interface RouteResponse {
  status: number;
  body: Record<string, unknown>;
}

interface Estimate {
  usd: number | null;
  model: string;
  images: number;
  requests: number;
  prompt_chars: number;
  text_input_tokens: number;
  image_input_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number;
  chars_per_token: number;
  resolution_tier: string | null;
  visual_tokens_per_image_max: number | null;
  rate_in_per_mtok: number | null;
  rate_out_per_mtok: number | null;
  source: { url: string; read_on: string };
  unpriced_reason: string | null;
}

/** Puts N mirrored, undescribed personal posts in front of the route. */
function givenMirroredPosts(count: number): void {
  state.rows = {
    snapshots: [{ id: SNAPSHOT }],
    posts: Array.from({ length: count }, (_unused, index) => ({
      id: `row-${index}`,
      snapshot_id: SNAPSHOT,
      account: 'personal',
      ig_id: `ig${index}`,
      posted_at: '2026-06-10T18:00:00Z',
      engagement: 1000 - index,
    })),
    visual_features: [],
  };
  state.objects = {
    'post-media/personal': Array.from({ length: count }, (_unused, index) => `ig${index}`),
    'post-media/academy': [],
  };
  state.upserts = [];
  state.downloads = [];
}

function useModel(model: string | null): void {
  if (model === null) delete process.env.AI_MODEL_STANDARD;
  else process.env.AI_MODEL_STANDARD = model;
}

/** The pricing arithmetic, recomputed here from the estimate's own token counts. */
function priceOf(estimate: Estimate): number {
  const input = estimate.input_tokens ?? 0;
  const rateIn = estimate.rate_in_per_mtok ?? 0;
  const rateOut = estimate.rate_out_per_mtok ?? 0;
  const exact = (input * rateIn) / 1_000_000 + (estimate.output_tokens * rateOut) / 1_000_000;
  return Math.ceil(Number((exact * 100).toFixed(6))) / 100;
}

test.beforeEach(() => {
  process.env.AI_PROVIDER = 'openrouter';
  process.env.OPENROUTER_API_KEY = 'test-key-not-used-because-fetch-throws';
  state.downloadsForbidden = false;
  useModel(null);
});

/* =========================== B1 — rule 15: unsourced means unpriced means no == */

test('GET: the default OpenRouter model has no verified vision accounting, so nothing is priced', async () => {
  givenMirroredPosts(3);
  useModel(null); // openai/gpt-5.6-luna, the app default

  const response = (await route.GET()) as unknown as RouteResponse;
  const estimate = response.body.estimate as Estimate;
  const spend = response.body.spend as { allowed: boolean; reason: string | null };

  assert.equal(response.status, 200);
  assert.equal(estimate.model, 'openai/gpt-5.6-luna');
  // The per-TOKEN price for this model IS verified in rates.ts…
  assert.equal(estimate.rate_in_per_mtok, 0.1);
  assert.equal(estimate.rate_out_per_mtok, 0.6);
  // …and the per-IMAGE accounting is not, which alone is enough to block.
  assert.equal(estimate.visual_tokens_per_image_max, null);
  assert.equal(estimate.resolution_tier, null);
  assert.equal(estimate.image_input_tokens, null);
  assert.equal(estimate.input_tokens, null);
  // Null, never 0. A $0.00 ceiling would read as "this is free".
  assert.equal(estimate.usd, null);
  assert.equal(spend.allowed, false);
  assert.ok(typeof spend.reason === 'string' && spend.reason.length > 0);
  assert.ok(spend.reason?.includes('gpt-5.6-luna'), 'the refusal names the model');
  assert.ok(spend.reason?.includes('VISION_TIERS'), 'the refusal names the fix');
});

test('POST: a run that cannot be priced is refused before a byte is downloaded', async () => {
  givenMirroredPosts(3);
  useModel(null);
  // From here on, touching storage is an exception rather than a soft failure.
  state.downloadsForbidden = true;

  const response = (await route.POST(
    new Request('http://localhost/api/visual', { method: 'POST', body: '{}' }),
  )) as unknown as RouteResponse;

  assert.equal(response.status, 409);
  assert.equal(response.body.blocked, true);
  assert.ok(typeof response.body.error === 'string');
  // The three assertions that make this a spend test rather than a status test:
  // nothing was downloaded, nothing was written, and `fetch` — which throws —
  // was never reached.
  assert.deepEqual(state.downloads, []);
  assert.deepEqual(state.upserts, []);
  // The queue is still reported, so the operator sees what is waiting.
  assert.equal(response.body.remaining, 3);
  assert.equal(response.body.mirrored, 3);
  assert.equal(response.body.described_total, 0);
});

test('the refusal is the model, not the fixture: priced, the same POST reaches storage', async () => {
  // THE NEGATIVE CONTROL for the test above. An "and nothing was downloaded"
  // assertion is worthless if nothing would have been downloaded anyway. Same
  // route, same fixture, same three mirrored posts — only the model changes,
  // from one with no verified vision accounting to one with a sourced tier.
  givenMirroredPosts(3);
  useModel('anthropic/claude-opus-5');

  const response = (await route.POST(
    new Request('http://localhost/api/visual', { method: 'POST', body: '{}' }),
  )) as unknown as RouteResponse;

  assert.notEqual(response.status, 409);
  assert.equal(response.status, 200);
  assert.equal(response.body.blocked, undefined);
  // Three objects were reached for, where the blocked run reached for none.
  assert.deepEqual(state.downloads, [
    'post-media/personal/ig0',
    'post-media/personal/ig1',
    'post-media/personal/ig2',
  ]);
  // This fixture stores no bytes, so all three fail at the storage read — which
  // is the point: the run got past the price gate and stopped at the first real
  // obstacle, without ever reaching a model (`fetch` throws if it is called).
  assert.equal(response.body.described, 0);
  assert.equal(response.body.failed, 3);
  assert.deepEqual(state.upserts, []);
  // A failed image is not marked done: it is still in the queue for the next
  // call, which is what makes the route resumable rather than lossy.
  assert.equal(response.body.remaining, 3);
});

/* =================================== B2 — the sourced constant, and the price = */

test('GET: a model with a verified tier prices the run, and the arithmetic holds', async () => {
  givenMirroredPosts(3);
  useModel('anthropic/claude-opus-5');

  const response = (await route.GET()) as unknown as RouteResponse;
  const estimate = response.body.estimate as Estimate;
  const spend = response.body.spend as { allowed: boolean; reason: string | null };

  assert.equal(estimate.images, 3);
  assert.equal(estimate.requests, 3, 'one model call per image');
  // THE SOURCED CONSTANT: 4784 visual tokens is the high-resolution tier
  // ceiling on the vendor page the route quotes, read 2026-08-15.
  assert.equal(estimate.resolution_tier, 'high');
  assert.equal(estimate.visual_tokens_per_image_max, 4784);
  assert.equal(estimate.image_input_tokens, 3 * 4784);
  // …and the receipt travels with it.
  assert.ok(estimate.source.url.startsWith('https://'));
  assert.equal(estimate.source.read_on, '2026-08-15');

  // The prompt is fixed per request, so its characters scale exactly with the
  // image count — measured off the real strings, not assumed per-image.
  assert.equal(estimate.prompt_chars % estimate.images, 0);
  assert.equal(estimate.chars_per_token, 2);
  assert.equal(estimate.text_input_tokens, Math.ceil(estimate.prompt_chars / 2));
  assert.equal(estimate.input_tokens, estimate.text_input_tokens + 3 * 4784);

  // The real published rates for claude-opus-5, from src/lib/agent/rates.ts.
  assert.equal(estimate.rate_in_per_mtok, 5);
  assert.equal(estimate.rate_out_per_mtok, 25);
  assert.equal(estimate.usd, priceOf(estimate));
  assert.ok((estimate.usd ?? 0) > 0);
  assert.equal(estimate.unpriced_reason, null);
  assert.equal(spend.allowed, true);
  assert.equal(spend.reason, null);
});

test('GET: the tier is read from the model, not hard-coded', async () => {
  givenMirroredPosts(1);

  useModel('anthropic/claude-opus-5');
  const high = ((await route.GET()) as unknown as RouteResponse).body.estimate as Estimate;

  useModel('claude-haiku-4-5');
  const standard = ((await route.GET()) as unknown as RouteResponse).body.estimate as Estimate;

  assert.equal(high.visual_tokens_per_image_max, 4784);
  assert.equal(standard.visual_tokens_per_image_max, 1568);
  assert.equal(standard.resolution_tier, 'standard');
  // Two different ceilings from two different models: the lookup is real. A
  // single hard-coded number would pass the previous test and fail this one.
  assert.notEqual(high.visual_tokens_per_image_max, standard.visual_tokens_per_image_max);
  // haiku is cheaper per token AND cheaper per image, so it must price lower.
  assert.ok((standard.usd ?? 0) < (high.usd ?? 0));
});

test('GET: the ceiling grows with the queue, and an empty queue costs nothing', async () => {
  useModel('anthropic/claude-opus-5');

  givenMirroredPosts(1);
  const one = ((await route.GET()) as unknown as RouteResponse).body.estimate as Estimate;

  givenMirroredPosts(6);
  const six = ((await route.GET()) as unknown as RouteResponse).body.estimate as Estimate;

  assert.ok((six.usd ?? 0) > (one.usd ?? 0));
  assert.equal(six.images, 6);

  // Nothing mirrored: the honest reading of today's database, where posts.raw
  // is null for every stored row and the bucket is therefore empty.
  state.objects = { 'post-media/personal': [], 'post-media/academy': [] };
  const empty = (await route.GET()) as unknown as RouteResponse;
  const estimate = empty.body.estimate as Estimate;
  assert.equal(empty.body.remaining, 0);
  assert.equal(empty.body.mirrored, 0);
  assert.equal(empty.body.not_mirrored, 6);
  assert.equal(estimate.images, 0);
  // Zero images really do cost zero — this is the one place a 0 is a
  // measurement rather than an absence, and the run is allowed.
  assert.equal(estimate.usd, 0);
  assert.equal((empty.body.spend as { allowed: boolean }).allowed, true);
});

/* ================================================= B3 — the queue, by ig_id == */

test('a post already described is not queued again, however its row id moved', async () => {
  useModel('anthropic/claude-opus-5');
  givenMirroredPosts(4);
  // The description points at an ig_id, and at a row id that no longer exists —
  // which is exactly what a re-scrape produces.
  state.rows.visual_features = [
    { ig_id: 'ig0', storage_path: 'post-media/personal/ig0', model: 'claude-opus-5' },
    // A mirrored row that no model has read yet must NOT suppress its post.
    { ig_id: 'ig1', storage_path: 'post-media/personal/ig1', model: null },
  ];

  const response = (await route.GET()) as unknown as RouteResponse;

  assert.equal(response.body.mirrored, 4);
  assert.equal(response.body.described_total, 1);
  assert.equal(response.body.remaining, 3);
  assert.equal((response.body.estimate as Estimate).images, 3);
});

test('a re-scraped post is one post, not two, in the queue and in the price', async () => {
  useModel('anthropic/claude-opus-5');
  givenMirroredPosts(2);
  // The same two posts, observed again in an older snapshot.
  state.rows.snapshots = [{ id: SNAPSHOT }, { id: 'snapshot-older' }];
  state.rows.posts = [
    ...(state.rows.posts as unknown[]),
    {
      id: 'row-old-0',
      snapshot_id: 'snapshot-older',
      account: 'personal',
      ig_id: 'ig0',
      posted_at: '2026-06-10T18:00:00Z',
      engagement: 1,
    },
    {
      id: 'row-old-1',
      snapshot_id: 'snapshot-older',
      account: 'personal',
      ig_id: 'ig1',
      posted_at: '2026-06-10T18:00:00Z',
      engagement: 1,
    },
  ];

  const response = (await route.GET()) as unknown as RouteResponse;
  const population = response.body.population as { distinct: number; duplicates_collapsed: number };

  assert.equal(population.duplicates_collapsed, 2);
  assert.equal(population.distinct, 2);
  assert.equal(response.body.total, 2);
  assert.equal(response.body.remaining, 2);
  // The estimate is priced over posts, so a re-scrape cannot double the quote.
  assert.equal((response.body.estimate as Estimate).images, 2);
});

/* ============================================== B4 — the provider it refuses == */

test('POST: a non-OpenRouter provider is refused, not silently attempted', async () => {
  givenMirroredPosts(3);
  useModel('claude-opus-5');
  process.env.AI_PROVIDER = 'anthropic';
  state.downloadsForbidden = true;

  const response = (await route.POST(
    new Request('http://localhost/api/visual', { method: 'POST', body: '{}' }),
  )) as unknown as RouteResponse;

  assert.equal(response.status, 501);
  assert.ok(String(response.body.error).includes('anthropic'));
  assert.deepEqual(state.downloads, []);
  assert.deepEqual(state.upserts, []);
});

/* ================================================ B5 — the two layers agree == */

test('the vocabularies the prompt offers are the ones the analytics can group', () => {
  // A band the route asked for and this module had never heard of would land
  // silently in off_vocabulary, and a whole group's worth of posts would go
  // missing from the split. The two files share one declaration, and this is
  // the assertion that says so out loud.
  const posts = TEXT_COVERAGE_BANDS.flatMap((band) =>
    Array.from({ length: MIN_GROUP_N }, (_unused, index) => post(`${band}-${index}`, 100)),
  );
  const features = posts.map((row) => {
    const band = TEXT_COVERAGE_BANDS.find((candidate) => row.ig_id.startsWith(candidate));
    return feature(row.ig_id, { text_coverage: band ?? null });
  });

  const report: VisualAnalytics = buildVisualAnalytics(posts, features);

  assert.equal(requireWithheld(report.text_coverage, 'off_vocabulary').n, 0);
  assert.equal(requireWithheld(report.text_coverage, 'unknown').n, 0);
  assert.equal(report.text_coverage.groups.length, TEXT_COVERAGE_BANDS.length);
});
