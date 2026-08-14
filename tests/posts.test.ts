import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_POSTS_SCAN,
  distinctPosts,
  scanCoverage,
  type PostIdentity,
} from '../src/lib/audience/posts.ts';
import type { PostRow } from '../src/lib/types/db.ts';

/* ------------------------------------------------------------- fixtures -- */

/**
 * A real snapshot_id is a uuid and carries no recency — which is exactly why
 * the module ranks snapshots by where they appear in the input. These ids are
 * named for readability only; nothing in the module parses them.
 */
const SNAP_3RD = 'snap-third-scrape';
const SNAP_2ND = 'snap-second-scrape';
const SNAP_1ST = 'snap-first-scrape';

interface Row extends PostIdentity {
  engagement: number;
}

/** Engagement rises between scrapes, so the winning row is identifiable. */
function row(igId: string, snapshotId: string, engagement: number): Row {
  return { ig_id: igId, snapshot_id: snapshotId, posted_at: '2026-06-10T18:00:00Z', engagement };
}

/** A complete PostRow, to prove the helper takes the real row type unmapped. */
function postRow(igId: string, snapshotId: string, engagement: number): PostRow {
  return {
    id: `${snapshotId}:${igId}`,
    snapshot_id: snapshotId,
    account: 'personal',
    ig_id: igId,
    url: `https://www.instagram.com/p/${igId}/`,
    caption: 'البرّ هين … تكسب الناس باللين …',
    media_type: 'reel',
    likes: null,
    comments: null,
    engagement,
    posted_at: '2026-06-10T18:00:00Z',
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
    owner_username: 'ahmadkahtan_',
    owner_id: null,
    is_sponsored: null,
    dimensions: null,
    raw: null,
  };
}

/* ----------------------------------------------------------------- empty -- */

test('an empty population collapses to nothing and counts nothing', () => {
  const result = distinctPosts([]);
  assert.deepEqual(result.posts, []);
  assert.equal(result.duplicates_collapsed, 0);
  assert.equal(result.snapshots_seen, 0);
});

/* ------------------------------------------------------- one snapshot --- */

test('one snapshot is a no-op — every row survives, in order', () => {
  const rows = [
    row('ig_a', SNAP_1ST, 508),
    row('ig_b', SNAP_1ST, 40),
    row('ig_c', SNAP_1ST, 33176),
  ];

  const result = distinctPosts(rows);
  assert.deepEqual(result.posts, rows);
  assert.equal(result.duplicates_collapsed, 0);
  assert.equal(result.snapshots_seen, 1);
});

/* ---------------------------------------------------- the actual defect -- */

test('the same post across three snapshots collapses to ONE row', () => {
  // The bug this module exists for: three scrapes of one post are three rows,
  // and a population that counts them counts the post three times.
  const rows = [
    row('ig_a', SNAP_3RD, 900),
    row('ig_a', SNAP_2ND, 600),
    row('ig_a', SNAP_1ST, 300),
  ];

  const result = distinctPosts(rows);
  assert.equal(result.posts.length, 1);
  assert.equal(result.duplicates_collapsed, 2);
  assert.equal(result.snapshots_seen, 3);
});

test('duplicates_collapsed is always rows.length - posts.length', () => {
  const rows = [
    row('ig_a', SNAP_2ND, 900),
    row('ig_b', SNAP_2ND, 40),
    row('ig_a', SNAP_1ST, 300),
    row('ig_b', SNAP_1ST, 20),
    row('ig_c', SNAP_1ST, 77),
  ];

  const result = distinctPosts(rows);
  assert.equal(result.posts.length, 3);
  assert.equal(result.duplicates_collapsed, rows.length - result.posts.length);
  assert.equal(result.duplicates_collapsed, 2);
  assert.equal(result.snapshots_seen, 2);
});

/* ------------------------------------------------------ which row wins --- */

test('the newest snapshot wins when the input is newest-first', () => {
  const result = distinctPosts([
    row('ig_a', SNAP_3RD, 900),
    row('ig_a', SNAP_2ND, 600),
    row('ig_a', SNAP_1ST, 300),
  ]);

  assert.equal(result.posts[0].snapshot_id, SNAP_3RD);
  assert.equal(result.posts[0].engagement, 900);
});

test('the newest snapshot still wins when the input is oldest-first and says so', () => {
  const rows = [
    row('ig_a', SNAP_1ST, 300),
    row('ig_a', SNAP_2ND, 600),
    row('ig_a', SNAP_3RD, 900),
  ];

  const told = distinctPosts(rows, { newestSnapshotFirst: false });
  assert.equal(told.posts[0].snapshot_id, SNAP_3RD);
  assert.equal(told.posts[0].engagement, 900);

  // The same rows WITHOUT the hint keep the first snapshot seen. The collapse
  // is still complete and still deterministic; only the choice of copy differs.
  const untold = distinctPosts(rows);
  assert.equal(untold.posts.length, 1);
  assert.equal(untold.duplicates_collapsed, 2);
  assert.equal(untold.posts[0].snapshot_id, SNAP_1ST);
});

test('the winner is chosen by SNAPSHOT rank, not by row position', () => {
  // Ordered by engagement, as /api/board orders it: the loudest row belongs to
  // the older snapshot, and a naive first-row-wins rule would hand it the win.
  const result = distinctPosts([
    row('ig_loud', SNAP_2ND, 33176), // rank 0 — SNAP_2ND is seen first here
    row('ig_a', SNAP_1ST, 900), // rank 1
    row('ig_a', SNAP_2ND, 508), // same post, newer snapshot, quieter row
  ]);

  assert.equal(result.posts.length, 2);
  assert.equal(result.duplicates_collapsed, 1);
  const winner = result.posts[1];
  assert.equal(winner.ig_id, 'ig_a');
  assert.equal(winner.snapshot_id, SNAP_2ND);
  assert.equal(winner.engagement, 508);
});

test('a replaced row keeps the position its post first held', () => {
  const result = distinctPosts([
    row('ig_a', SNAP_2ND, 508), // rank 0
    row('ig_b', SNAP_1ST, 40), // rank 1
    row('ig_b', SNAP_2ND, 77), // replaces ig_b in place
  ]);

  assert.deepEqual(
    result.posts.map((p) => p.ig_id),
    ['ig_a', 'ig_b'],
  );
  assert.equal(result.posts[1].engagement, 77);
});

test('a repeat inside ONE snapshot keeps the first row and is still counted', () => {
  // UNIQUE (snapshot_id, ig_id) forbids this; the tie-break is defensive.
  const result = distinctPosts([row('ig_a', SNAP_1ST, 508), row('ig_a', SNAP_1ST, 900)]);

  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].engagement, 508);
  assert.equal(result.duplicates_collapsed, 1);
  assert.equal(result.snapshots_seen, 1);
});

/* --------------------------------------------------------- the real row -- */

test('a PostRow array is accepted with no mapping', () => {
  const rows: PostRow[] = [postRow('ig_a', SNAP_2ND, 900), postRow('ig_a', SNAP_1ST, 300)];

  const result = distinctPosts(rows);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].snapshot_id, SNAP_2ND);
  assert.equal(result.posts[0].owner_username, 'ahmadkahtan_');
  assert.equal(result.duplicates_collapsed, 1);
});

/* ------------------------------------------------------------ the cap --- */

test('the cap is the one /api/board already applies', () => {
  assert.equal(MAX_POSTS_SCAN, 2000);
});

test('a read that fills its cap is flagged as truncated', () => {
  const coverage = scanCoverage(MAX_POSTS_SCAN);
  assert.equal(coverage.truncated, true);
  assert.equal(coverage.limit, MAX_POSTS_SCAN);
  assert.equal(coverage.rows_fetched, MAX_POSTS_SCAN);
});

test('a read that came back short is not flagged', () => {
  const coverage = scanCoverage(320);
  assert.equal(coverage.truncated, false);
  assert.equal(coverage.rows_fetched, 320);
  assert.equal(coverage.limit, MAX_POSTS_SCAN);
});

test('an empty read is not truncated', () => {
  assert.equal(scanCoverage(0).truncated, false);
});

test('the cap is overridable and the stated limit follows it', () => {
  const coverage = scanCoverage(50, 50);
  assert.equal(coverage.truncated, true);
  assert.equal(coverage.limit, 50);
  // A page larger than the stated cap is truncation too, not a rounding error.
  assert.equal(scanCoverage(51, 50).truncated, true);
  assert.equal(scanCoverage(49, 50).truncated, false);
});

test('an unusable limit falls back to MAX_POSTS_SCAN rather than answering false', () => {
  const coverage = scanCoverage(MAX_POSTS_SCAN, Number.NaN);
  assert.equal(coverage.limit, MAX_POSTS_SCAN);
  assert.equal(coverage.truncated, true);
  assert.equal(scanCoverage(MAX_POSTS_SCAN, 0).limit, MAX_POSTS_SCAN);
});

test('coverage counts SCRAPE ROWS, so it is measured before the collapse', () => {
  // 3 rows, 1 post. The cap applies to the query, so the number that matters
  // for truncation is 3 — the deduped 1 would hide a capped read entirely.
  const rows = [
    row('ig_a', SNAP_3RD, 900),
    row('ig_a', SNAP_2ND, 600),
    row('ig_a', SNAP_1ST, 300),
  ];

  const coverage = scanCoverage(rows.length, 3);
  assert.equal(coverage.rows_fetched, 3);
  assert.equal(coverage.truncated, true);
  assert.equal(distinctPosts(rows).posts.length, 1);
});
