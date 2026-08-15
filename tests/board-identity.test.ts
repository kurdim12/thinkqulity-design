import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  indexAnalysesByPost,
  resolveIgId,
  type AnalysisIdentity,
  type AnalysisIndex,
  type AnalysisLink,
  type PostIdentityRow,
} from '../src/lib/board/identity.ts';
import { MAX_POSTS_SCAN, distinctPosts, type PostIdentity } from '../src/lib/audience/posts.ts';
import {
  PUBLISHED_RATES,
  SONNET_5_INTRO,
  normaliseModel,
  rateFor,
} from '../src/lib/agent/rates.ts';

/* =============================================================== what this ==
 * THE SEVENTH-SNAPSHOT BOUNDARY, and the proof that it is gone.
 *
 * An analysis is stored against `post_analyses.post_id`, which is a `posts.id`
 * — a scrape ROW, not a post. `posts` is UNIQUE (snapshot_id, ig_id), so every
 * re-scrape mints a new row with a new uuid for the same post, and the board
 * displays the newest one. Matching by row id therefore loses the analysis on
 * the first re-scrape.
 *
 * The previous fix resolved the row id to an ig_id through the rows the request
 * had just read — correct, and bounded. That read is capped at MAX_POSTS_SCAN =
 * 2000 rows, and one snapshot of these two accounts is 320 posts, so from the
 * SEVENTH snapshot (7 x 320 = 2240 rows) the read no longer covers the history.
 * The rows it drops are the quietest, and the quietest copy of a post is its
 * OLDEST — which is exactly the row an old analysis cites. Every one of those
 * analyses read as "never analysed", so its post was queued and the model was
 * paid a second time to describe it.
 *
 * Migration 0004 added `post_analyses.ig_id`. The match now reads that column,
 * so it no longer depends on which rows a capped scan happened to include.
 *
 * WHAT IS PROVEN HERE, WITH NO DATABASE AND NO MODEL: the matching rule itself,
 * which is a pure function over two arrays. The simulation below runs at the
 * real numbers — 320 posts, 7 snapshots, the real MAX_POSTS_SCAN — and measures
 * the old damage from the fixture rather than asserting a remembered figure.
 *
 * WHAT IS NOT PROVEN HERE: that Postgres returns the rows this fixture assumes,
 * or that the two routes are correct end to end. The last section reads the
 * route sources and checks only that they are WIRED to this module — a wiring
 * check on text, which is worth exactly what it claims and no more.
 *
 * The engagement figures in the fixtures are synthetic and stand for nothing
 * measured about either account: they exist to make the ordering legible. The
 * only real numbers used are the proven ones — 320 posts in a snapshot, and
 * MAX_POSTS_SCAN as the module exports it.
 * ========================================================================= */

/* ------------------------------------------------------------- helpers -- */

/** Map.get without a non-null assertion: stops here, naming what was missing. */
function linkFor<A>(index: AnalysisIndex<A>, igId: string): AnalysisLink<A> {
  const found = index.byIgId.get(igId);
  if (found === undefined) assert.fail(`no analysis is indexed for post ${igId}`);
  return found;
}

/** A stored analysis: the two ids, and when it was written. */
function analysis(postId: string, igId: string | null, createdAt: string): AnalysisIdentity {
  return { post_id: postId, ig_id: igId, created_at: createdAt };
}

/** A row of the collapsed population: the winning scrape row, and its post. */
function post(id: string, igId: string): PostIdentityRow {
  return { id, ig_id: igId };
}

/* ------------------------------------------------- the one-post statements -- */

test('a post re-scraped into a newer snapshot still counts as analysed', () => {
  // Analysed while snapshot 1 was current; snapshot 2 then re-scraped the post
  // and won the collapse, so the row the board displays is a row the analysis
  // has never heard of.
  const index = indexAnalysesByPost(
    [analysis('row-snap1-igA', 'igA', '2026-08-14T09:00:00Z')],
    [post('row-snap2-igA', 'igA')],
  );

  assert.equal(index.byIgId.size, 1);
  assert.equal(index.unresolved, 0);
  assert.equal(linkFor(index, 'igA').analysis.post_id, 'row-snap1-igA');
});

test('an analysis written against an earlier scrape is superseded, not missing', () => {
  const index = indexAnalysesByPost(
    [analysis('row-snap1-igA', 'igA', '2026-08-14T09:00:00Z')],
    [post('row-snap2-igA', 'igA')],
  );

  // Two different facts, and the whole reason they are counted apart: the work
  // is done and shown, only its stored comparatives are frozen at the older
  // population. Folding it into "not analysed" is what re-charges the operator.
  assert.equal(linkFor(index, 'igA').superseded, true);
  assert.equal(index.analyzed_current, 0);
  assert.equal(index.analyzed_superseded, 1);
});

test('an analysis on the row now displayed is current', () => {
  const index = indexAnalysesByPost(
    [analysis('row-snap2-igA', 'igA', '2026-08-15T09:00:00Z')],
    [post('row-snap2-igA', 'igA')],
  );

  assert.equal(linkFor(index, 'igA').superseded, false);
  assert.equal(index.analyzed_current, 1);
  assert.equal(index.analyzed_superseded, 0);
});

test('a post with no analysis is absent from the index — never a zero entry', () => {
  const index = indexAnalysesByPost([], [post('row-snap1-igA', 'igA')]);

  assert.equal(index.byIgId.has('igA'), false);
  assert.equal(index.byIgId.size, 0);
  assert.equal(index.analyzed_current, 0);
  assert.equal(index.analyzed_superseded, 0);
  assert.equal(index.unresolved, 0);
});

/* ---------------------------------------------------- the cap, in isolation -- */

test('a row beyond the scan cap no longer orphans its analysis', () => {
  // The map is EMPTY: this is a read that did not contain the cited row at all,
  // which is what a capped scan produces once the history outgrows it. Before
  // the ig_id column that was an unresolved analysis and a re-queued post.
  const index = indexAnalysesByPost(
    [analysis('row-that-fell-out-of-the-read', 'igA', '2026-08-14T09:00:00Z')],
    [post('row-snap7-igA', 'igA')],
    new Map<string, string>(),
  );

  assert.equal(index.byIgId.size, 1);
  assert.equal(index.unresolved, 0);
  assert.equal(linkFor(index, 'igA').superseded, true);
});

test('WITHOUT the column, that same analysis is orphaned — the defect, stated', () => {
  // The pre-0004 row: `ig_id` is null, so the only route back to the post is the
  // capped read, and the capped read does not have the row.
  const index = indexAnalysesByPost(
    [analysis('row-that-fell-out-of-the-read', null, '2026-08-14T09:00:00Z')],
    [post('row-snap7-igA', 'igA')],
    new Map<string, string>(),
  );

  assert.equal(index.byIgId.size, 0);
  assert.equal(index.unresolved, 1);
});

test('a pre-0004 analysis still resolves while its row is inside the read', () => {
  const index = indexAnalysesByPost(
    [analysis('row-snap1-igA', null, '2026-08-14T09:00:00Z')],
    [post('row-snap2-igA', 'igA')],
    new Map([['row-snap1-igA', 'igA']]),
  );

  assert.equal(index.byIgId.size, 1);
  assert.equal(index.unresolved, 0);
});

test('the stored column beats the legacy map when both are present', () => {
  // If they ever disagree, the column is the one that was written next to the
  // insert; the map is an inference. A wrong inference must not win.
  const index = indexAnalysesByPost(
    [analysis('row-1', 'igTruth', '2026-08-14T09:00:00Z')],
    [post('row-9', 'igTruth'), post('row-8', 'igWrong')],
    new Map([['row-1', 'igWrong']]),
  );

  assert.equal(index.byIgId.has('igTruth'), true);
  assert.equal(index.byIgId.has('igWrong'), false);
});

test('an empty ig_id is treated as absent, not as a post', () => {
  // '' is not an Instagram id. Matching on it would collapse every such row onto
  // one imaginary post — a fabricated grouping arriving by accident.
  assert.equal(resolveIgId(analysis('row-1', '', '2026-08-14T09:00:00Z')), null);
  assert.equal(resolveIgId(analysis('row-1', '', '2026-08-14T09:00:00Z'), new Map([['row-1', 'igA']])), 'igA');
});

/* ------------------------------------------------------------- unresolved -- */

test('an analysis for a post outside this population is counted, not silently dropped', () => {
  const index = indexAnalysesByPost(
    [
      analysis('row-a', 'igA', '2026-08-14T09:00:00Z'),
      analysis('row-gone', 'igDeleted', '2026-08-14T09:00:00Z'),
      analysis('row-gone-2', 'igDeleted', '2026-08-14T10:00:00Z'),
    ],
    [post('row-a', 'igA')],
  );

  assert.equal(index.byIgId.size, 1);
  // Counted per ANALYSIS, so two analyses of one departed post read as two.
  assert.equal(index.unresolved, 2);
});

/* ---------------------------------------------------------- which one wins -- */

test('an analysis on the displayed row beats a newer one on a superseded row', () => {
  const index = indexAnalysesByPost(
    [
      analysis('row-snap2-igA', 'igA', '2026-08-10T09:00:00Z'),
      analysis('row-snap1-igA', 'igA', '2026-08-15T09:00:00Z'),
    ],
    [post('row-snap2-igA', 'igA')],
  );

  assert.equal(linkFor(index, 'igA').analysis.post_id, 'row-snap2-igA');
  assert.equal(linkFor(index, 'igA').superseded, false);
  assert.equal(index.byIgId.size, 1);
});

test('between two superseded analyses the newer one is shown', () => {
  const index = indexAnalysesByPost(
    [
      analysis('row-snap1-igA', 'igA', '2026-08-10T09:00:00Z'),
      analysis('row-snap2-igA', 'igA', '2026-08-12T09:00:00Z'),
    ],
    [post('row-snap3-igA', 'igA')],
  );

  assert.equal(linkFor(index, 'igA').analysis.created_at, '2026-08-12T09:00:00Z');
  assert.equal(index.analyzed_superseded, 1);
});

test('an unusable timestamp sorts oldest instead of winning by accident', () => {
  const index = indexAnalysesByPost(
    [
      analysis('row-broken', 'igA', 'not a date'),
      analysis('row-dated', 'igA', '2026-08-10T09:00:00Z'),
    ],
    [post('row-snap3-igA', 'igA')],
  );

  assert.equal(linkFor(index, 'igA').analysis.post_id, 'row-dated');
});

test('two analyses written in the same millisecond land the same way either order', () => {
  // PostgREST promises no order within a tie. Without the last tie-break the
  // card could change between refreshes with nothing behind the change.
  const a = analysis('row-aaa', 'igA', '2026-08-14T09:00:00Z');
  const b = analysis('row-bbb', 'igA', '2026-08-14T09:00:00Z');
  const population = [post('row-snap9-igA', 'igA')];

  assert.equal(linkFor(indexAnalysesByPost([a, b], population), 'igA').analysis.post_id, 'row-aaa');
  assert.equal(linkFor(indexAnalysesByPost([b, a], population), 'igA').analysis.post_id, 'row-aaa');
});

/* ========================================================================== *
 * THE SIMULATION — seven snapshots, at the real numbers.
 * ========================================================================== */

/** Proven: one snapshot of these two accounts is 320 posts (2026-08-14). */
const POSTS_PER_SNAPSHOT = 320;

/** The scrape at which 320 posts stop fitting inside MAX_POSTS_SCAN. */
const SNAPSHOTS = 7;

interface ScrapeRow extends PostIdentity {
  id: string;
  engagement: number;
}

/**
 * Engagement is SYNTHETIC here and describes neither account. It only has to
 * satisfy the one property the defect depends on and that real engagement also
 * has: a post's counters accumulate, so its OLDEST copy is its quietest, and a
 * read ordered loudest-first drops old copies before new ones.
 */
function scrapeRow(postIndex: number, snapshot: number): ScrapeRow {
  const igId = `ig_${String(postIndex).padStart(4, '0')}`;
  return {
    id: `row_s${snapshot}_${igId}`,
    ig_id: igId,
    snapshot_id: `snapshot_${snapshot}`,
    posted_at: '2026-06-10T18:00:00Z',
    engagement: 500 + postIndex + 40 * snapshot,
  };
}

/** Every row the table would hold after `SNAPSHOTS` scrapes. */
function allScrapeRows(): ScrapeRow[] {
  const rows: ScrapeRow[] = [];
  for (let snapshot = 1; snapshot <= SNAPSHOTS; snapshot += 1) {
    for (let postIndex = 0; postIndex < POSTS_PER_SNAPSHOT; postIndex += 1) {
      rows.push(scrapeRow(postIndex, snapshot));
    }
  }
  return rows;
}

/** `.order('engagement', { ascending: false }).limit(MAX_POSTS_SCAN)`, in memory. */
function cappedRead(rows: readonly ScrapeRow[]): ScrapeRow[] {
  return [...rows]
    .sort((a, b) => b.engagement - a.engagement || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_POSTS_SCAN);
}

/** What the routes do next: newest snapshot first, then collapse to posts. */
function collapse(read: readonly ScrapeRow[]): ScrapeRow[] {
  const byRecency = [...read].sort(
    (a, b) => Number(b.snapshot_id.slice('snapshot_'.length)) - Number(a.snapshot_id.slice('snapshot_'.length)),
  );
  return distinctPosts(byRecency).posts;
}

/** The map the old code matched on: only the rows the capped read returned. */
function readRowMap(read: readonly ScrapeRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of read) map.set(row.id, row.ig_id);
  return map;
}

test('the fixture really does outgrow the cap, and still holds every post', () => {
  const rows = allScrapeRows();
  assert.equal(rows.length, POSTS_PER_SNAPSHOT * SNAPSHOTS);
  assert.equal(rows.length > MAX_POSTS_SCAN, true);

  const read = cappedRead(rows);
  assert.equal(read.length, MAX_POSTS_SCAN);

  // Every post is still REPRESENTED in the read — what the cap dropped is old
  // copies, not posts. That is what makes this a test about orphaned analyses
  // rather than about a truncated population, which is a separate fact the
  // routes already report as `population.truncated`.
  const population = collapse(read);
  assert.equal(population.length, POSTS_PER_SNAPSHOT);
});

test('every post analysed once at snapshot 1 is STILL analysed at snapshot 7', () => {
  const read = cappedRead(allScrapeRows());
  const population = collapse(read);

  // One analysis per post, all written when snapshot 1 was the only scrape.
  const analyses = Array.from({ length: POSTS_PER_SNAPSHOT }, (_, i) => {
    const row = scrapeRow(i, 1);
    return analysis(row.id, row.ig_id, '2026-08-14T09:00:00Z');
  });

  const index = indexAnalysesByPost(analyses, population, readRowMap(read));

  assert.equal(index.byIgId.size, POSTS_PER_SNAPSHOT);
  assert.equal(index.unresolved, 0);
  // All 320 were written against snapshot 1; snapshot 7 won every collapse.
  assert.equal(index.analyzed_superseded, POSTS_PER_SNAPSHOT);
  assert.equal(index.analyzed_current, 0);

  // The line that decides re-spend, exactly as POST /api/board/analyze runs it.
  const pending = population.filter((p) => !index.byIgId.has(p.ig_id));
  assert.equal(pending.length, 0);
});

test('the analysed count does not double across snapshots', () => {
  const read = cappedRead(allScrapeRows());
  const population = collapse(read);

  // The same 320 posts analysed at snapshot 1 AND again at snapshot 4 — two
  // rows in post_analyses per post, because post_id is unique per scrape row.
  const analyses = [1, 4].flatMap((snapshot) =>
    Array.from({ length: POSTS_PER_SNAPSHOT }, (_, i) => {
      const row = scrapeRow(i, snapshot);
      return analysis(row.id, row.ig_id, `2026-08-1${snapshot}T09:00:00Z`);
    }),
  );

  assert.equal(analyses.length, POSTS_PER_SNAPSHOT * 2);

  const index = indexAnalysesByPost(analyses, population, readRowMap(read));

  // 640 analyses, 320 posts. The count is POSTS, and one winner each.
  assert.equal(index.byIgId.size, POSTS_PER_SNAPSHOT);
  assert.equal(index.analyzed_current + index.analyzed_superseded, POSTS_PER_SNAPSHOT);
  assert.equal(index.unresolved, 0);
});

test('the old row-id match loses analyses at snapshot 7 — measured, not remembered', () => {
  const read = cappedRead(allScrapeRows());
  const population = collapse(read);
  const rowMap = readRowMap(read);

  const rows = Array.from({ length: POSTS_PER_SNAPSHOT }, (_, i) => scrapeRow(i, 1));

  // How many snapshot-1 rows the capped read left behind. Counted from the
  // fixture; no figure here is asserted from memory.
  const orphaned = rows.filter((row) => !rowMap.has(row.id)).length;
  assert.equal(orphaned > 0, true);

  // The pre-0004 world: post_analyses had no ig_id, so this is all there was.
  const legacy = indexAnalysesByPost(
    rows.map((row) => analysis(row.id, null, '2026-08-14T09:00:00Z')),
    population,
    rowMap,
  );
  assert.equal(legacy.unresolved, orphaned);
  assert.equal(legacy.byIgId.size, POSTS_PER_SNAPSHOT - orphaned);

  // Those unresolved analyses are posts that would be queued and PAID FOR again.
  const legacyPending = population.filter((p) => !legacy.byIgId.has(p.ig_id));
  assert.equal(legacyPending.length, orphaned);

  // The same analyses, with the column 0004 added and backfilled.
  const current = indexAnalysesByPost(
    rows.map((row) => analysis(row.id, row.ig_id, '2026-08-14T09:00:00Z')),
    population,
    rowMap,
  );
  assert.equal(current.unresolved, 0);
  assert.equal(current.byIgId.size, POSTS_PER_SNAPSHOT);
  assert.equal(population.filter((p) => !current.byIgId.has(p.ig_id)).length, 0);
});

test('the match no longer needs the read at all', () => {
  // The strongest form of the claim: hand the index an EMPTY legacy map, i.e.
  // resolve with no knowledge of any scrape row, and nothing changes.
  const read = cappedRead(allScrapeRows());
  const population = collapse(read);
  const analyses = Array.from({ length: POSTS_PER_SNAPSHOT }, (_, i) => {
    const row = scrapeRow(i, 1);
    return analysis(row.id, row.ig_id, '2026-08-14T09:00:00Z');
  });

  const withRead = indexAnalysesByPost(analyses, population, readRowMap(read));
  const withoutRead = indexAnalysesByPost(analyses, population, new Map<string, string>());

  assert.equal(withoutRead.byIgId.size, withRead.byIgId.size);
  assert.equal(withoutRead.unresolved, withRead.unresolved);
  assert.equal(withoutRead.analyzed_current, withRead.analyzed_current);
  assert.equal(withoutRead.analyzed_superseded, withRead.analyzed_superseded);
});

/* ========================================================================== *
 * THE RATE TABLE — moved out of the route, unchanged.
 * ========================================================================== */

test('the published rates are the ones that were read from the price pages', () => {
  // Value-drift guard for a table that quotes the operator money. These are the
  // figures the route carried before the move; nothing was recalculated.
  assert.deepEqual(PUBLISHED_RATES['claude-opus-5'], { in: 5, out: 25 });
  assert.deepEqual(PUBLISHED_RATES['claude-sonnet-5'], { in: 3, out: 15 });
  assert.deepEqual(PUBLISHED_RATES['claude-haiku-4-5'], { in: 1, out: 5 });
  assert.deepEqual(PUBLISHED_RATES['gpt-5.6-luna'], { in: 0.1, out: 0.6 });
  assert.deepEqual(PUBLISHED_RATES['qwen3.7-plus'], { in: 0.32, out: 1.28 });
  assert.deepEqual(PUBLISHED_RATES['gemini-3.7-flash'], { in: 0.38, out: 1.88 });
  assert.deepEqual(PUBLISHED_RATES['deepseek-v4-pro-0813'], { in: 0.43, out: 0.87 });
  assert.deepEqual(PUBLISHED_RATES['qwen3.7-flash'], { in: 0.03, out: 0.13 });
  assert.deepEqual(PUBLISHED_RATES['gpt-5.6-terra'], { in: 1, out: 6 });
  assert.deepEqual(PUBLISHED_RATES['gpt-5.6-sol'], { in: 5, out: 30 });
  assert.equal(Object.keys(PUBLISHED_RATES).length, 10);
});

test('an unverified model is priced at null, never at a guess', () => {
  // Hard rule 15. A plausible number here is worse than no number, because it
  // would reach the operator wearing a dollar sign.
  assert.equal(rateFor('some-model-nobody-has-priced'), null);
  assert.equal(rateFor('openai/gpt-4o'), null);
  assert.equal(rateFor(''), null);
});

test('an OpenRouter id and a bare id resolve to the same rate', () => {
  assert.equal(normaliseModel('anthropic/claude-opus-5'), 'claude-opus-5');
  assert.equal(normaliseModel('  ANTHROPIC/Claude-Opus-5  '), 'claude-opus-5');
  assert.deepEqual(rateFor('anthropic/claude-opus-5'), PUBLISHED_RATES['claude-opus-5']);
});

test('the Sonnet introductory rate is stored with its expiry and applied by it', () => {
  assert.deepEqual(SONNET_5_INTRO.rate, { in: 2, out: 10 });
  assert.equal(SONNET_5_INTRO.through, '2026-08-31');

  // Written against the expiry rather than against today, so this assertion
  // stays true on both sides of it — the discount lapsing is not a test failure.
  const today = new Date().toISOString().slice(0, 10);
  const expected =
    today <= SONNET_5_INTRO.through ? SONNET_5_INTRO.rate : PUBLISHED_RATES['claude-sonnet-5'];
  assert.deepEqual(rateFor('claude-sonnet-5'), expected);
});

/* ========================================================================== *
 * WIRING — that the routes actually use the module tested above.
 *
 * This reads source text. It cannot prove behaviour and does not claim to; it
 * exists because a route that quietly went back to matching on post_id would
 * leave every test above passing while the operator paid twice.
 * ========================================================================== */

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

const BOARD_ROUTE = 'src/app/api/board/route.ts';
const ANALYZE_ROUTE = 'src/app/api/board/analyze/route.ts';

test('both routes match through the identity module', () => {
  for (const path of [BOARD_ROUTE, ANALYZE_ROUTE]) {
    const text = source(path);
    assert.equal(text.includes("from '@/lib/board/identity'"), true, `${path} imports identity`);
    assert.equal(text.includes('indexAnalysesByPost('), true, `${path} calls the index`);
  }
});

test('both routes read post_analyses.ig_id', () => {
  assert.equal(
    source(BOARD_ROUTE).includes("const ANALYSIS_COLUMNS = 'post_id, ig_id,"),
    true,
    'the board selects ig_id',
  );
  assert.equal(
    source(ANALYZE_ROUTE).includes("const ANALYSIS_IDENTITY_COLUMNS = 'post_id, ig_id, created_at'"),
    true,
    'the analyser selects ig_id',
  );
  // The bare select this change replaced. If it comes back, the boundary does.
  assert.equal(source(ANALYZE_ROUTE).includes(".select('post_id')"), false);
});

test('the analyser writes ig_id on every analysis it stores', () => {
  const text = source(ANALYZE_ROUTE);
  assert.equal(text.includes('ig_id: target.ig_id'), true);
  // post_id stays: it is a real FK and the only record of which scrape the
  // stored comparatives were computed against.
  assert.equal(text.includes('post_id: a.post_id'), true);
});

test('the rate table has left the route and is imported from the lib', () => {
  const text = source(ANALYZE_ROUTE);
  assert.equal(text.includes("from '@/lib/agent/rates'"), true);
  assert.equal(text.includes('const PUBLISHED_RATES'), false);
  assert.equal(text.includes('const SONNET_5_INTRO'), false);
});
