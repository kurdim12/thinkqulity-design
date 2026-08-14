/**
 * The shared post population.
 *
 * `posts` is UNIQUE (snapshot_id, ig_id) — one row PER POST PER SNAPSHOT. The
 * same Instagram post therefore gets a NEW row every time the account is
 * re-scraped, and a consumer that reads the table without collapsing on ig_id
 * is not measuring posts, it is measuring scrape rows.
 *
 * Today exactly one snapshot exists, so the 320 stored rows are 320 distinct
 * posts and the bug is invisible. After the next re-scrape those same 320 posts
 * occupy 640 rows: every average is then computed over each post twice, and
 * every timing window doubles its n while its label still says "posts". That is
 * a fabricated number arriving by arithmetic rather than by invention, which
 * makes it worse, not better — it looks computed.
 *
 * The other half of the problem is the opposite of duplication: a capped read.
 * A query that stops at MAX_POSTS_SCAN rows produces a population that is
 * merely a prefix of the truth, and a prefix reported as a total is also a
 * fabricated number. `scanCoverage()` exists so that a caller that hit the cap
 * can SAY so; the flag is meant to reach the UI, not to be logged and dropped.
 *
 * Pure functions, no I/O, no environment reads, no model — so this module runs
 * unchanged under `node --test --experimental-strip-types`, which is why the
 * one import is type-only and carries an explicit `.ts` extension, exactly as
 * the timing engine and the Law modules do.
 */

import type { PostRow } from '../types/db.ts';

/**
 * Everything the dedupe needs from a post row. Derived from PostRow, so a
 * `PostRow[]` is accepted as-is and so is a narrow select — provided the select
 * actually asks for `ig_id` and `snapshot_id`. A caller that omits them cannot
 * dedupe and will not compile, which is the point.
 *
 * `posted_at` is required but never used to pick a winner: a post's publish
 * time does not change between scrapes, so it carries no snapshot recency. It
 * is in the contract because the deduped array's whole purpose is to feed
 * `buildTiming()`, and demanding the column here means the caller cannot select
 * a population that the timing engine will silently reject afterwards.
 */
export type PostIdentity = Pick<PostRow, 'ig_id' | 'snapshot_id' | 'posted_at'>;

/**
 * The row ceiling for any full-population read of `posts`.
 *
 * 2000 is not a new number: it is the cap `/api/board` already applies
 * (src/app/api/board/route.ts). It is exported here so that every consumer
 * states the SAME cap instead of each inventing its own, and so that the number
 * a truncation notice shows the user is the number the query actually used.
 */
export const MAX_POSTS_SCAN = 2000;

export interface DistinctPostsOptions {
  /**
   * Whether `rows` is ordered newest-snapshot-first. Defaults to true, matching
   * `.order('snapshot_id')`-free callers that fetch snapshot-by-snapshot in
   * recency order, and matching the single-snapshot case where the flag cannot
   * matter. Pass false when the rows were read oldest-snapshot-first.
   */
  newestSnapshotFirst?: boolean;
}

export interface DistinctPostsResult<T> {
  /** One row per ig_id. */
  posts: T[];
  /**
   * How many rows were dropped as re-scrapes of a post already kept, i.e.
   * `rows.length - posts.length`. Returned rather than hidden so a caller can
   * report "320 posts (640 rows, 320 collapsed)" instead of quietly presenting
   * a deduped figure that does not match the row count anyone else can see.
   */
  duplicates_collapsed: number;
  /** Distinct snapshot_ids present in the input. 1 means dedupe was a no-op. */
  snapshots_seen: number;
}

/**
 * Collapses scrape rows to one row per post.
 *
 * WHICH ROW WINS — the rule, in full, because a silent choice here would be a
 * silent choice about every number downstream:
 *
 * 1. Snapshots are ranked by where they FIRST appear in `rows`: the snapshot
 *    owning the earliest row gets rank 0, the next distinct snapshot rank 1,
 *    and so on. Rank comes from the input's order, because a snapshot_id is a
 *    uuid and carries no recency of its own, and nothing else in a post row
 *    does either.
 * 2. Within one ig_id, the row from the LOWEST-ranked snapshot wins when
 *    `newestSnapshotFirst` is true (the default) — that is the most recent
 *    scrape, so likes and comments are the freshest stored. With the flag set
 *    to false the HIGHEST-ranked snapshot wins instead.
 * 3. TIE-BREAK: if two rows share both ig_id and snapshot_id — which the
 *    UNIQUE (snapshot_id, ig_id) constraint forbids, so this is defensive only
 *    — the earlier row in `rows` is kept and the later one is counted as a
 *    duplicate. Ranking by snapshot rather than by row position is what makes
 *    the result independent of any secondary ordering: `/api/board` sorts by
 *    engagement, and a plain first-row-wins rule would hand the win to
 *    whichever snapshot happened to contain the loudest post.
 *
 * The caller's ordering is preserved: winners come back in the order their
 * ig_id was first seen, so a population read `.order('engagement')` stays
 * sorted by engagement even when a later row replaced the first one.
 *
 * This function cannot verify the recency claim in (2). If `rows` is not
 * ordered by snapshot recency the collapse is still complete and still
 * deterministic — one row per ig_id, same answer every run — but which
 * snapshot's copy survives is then the caller's ordering, not this module's
 * promise. Callers order by snapshot recency, or pass the hint.
 */
export function distinctPosts<T extends PostIdentity>(
  rows: readonly T[],
  opts: DistinctPostsOptions = {},
): DistinctPostsResult<T> {
  const newestFirst = opts.newestSnapshotFirst ?? true;

  /** snapshot_id -> rank, by first appearance. */
  const snapshotRank = new Map<string, number>();
  for (const row of rows) {
    if (!snapshotRank.has(row.snapshot_id)) snapshotRank.set(row.snapshot_id, snapshotRank.size);
  }

  /** ig_id -> where its winner sits in `picked`, so order survives a swap. */
  const position = new Map<string, number>();
  const picked: { row: T; rank: number }[] = [];
  let duplicatesCollapsed = 0;

  for (const row of rows) {
    const rank = snapshotRank.get(row.snapshot_id) ?? 0;
    const at = position.get(row.ig_id);

    if (at === undefined) {
      position.set(row.ig_id, picked.length);
      picked.push({ row, rank });
      continue;
    }

    duplicatesCollapsed += 1;
    const held = picked[at];
    // Strict comparison: an equal rank keeps the row already held, which is
    // tie-break (3) above.
    const wins = newestFirst ? rank < held.rank : rank > held.rank;
    if (wins) picked[at] = { row, rank };
  }

  return {
    posts: picked.map((entry) => entry.row),
    duplicates_collapsed: duplicatesCollapsed,
    snapshots_seen: snapshotRank.size,
  };
}

/**
 * What a capped read can honestly say about its own completeness.
 *
 * `truncated` is a SUSPICION, not a measurement: a query that comes back with
 * exactly as many rows as it asked for may have left rows behind, or may have
 * landed on the boundary exactly. There is deliberately no "rows_missing"
 * field, because the count of rows a capped query never saw is unknowable from
 * the result — reporting one would invent the very number this module exists to
 * prevent. A caller renders "showing the first 2000 rows", never "2000 of N".
 */
export interface ScanCoverage {
  /** The cap the query used. */
  limit: number;
  /** Rows the query returned, BEFORE dedupe — scrape rows, not posts. */
  rows_fetched: number;
  /** True when the read filled its cap, so the population may be a prefix. */
  truncated: boolean;
}

/**
 * Flags a read that hit its row cap. `rowsFetched` is the raw row count
 * (`rows.length`) as it came back from the database — count it BEFORE
 * `distinctPosts()` collapses anything, because it is the QUERY that was
 * capped, not the post population.
 *
 * `>=` rather than `===` so that a caller passing a cap smaller than the page
 * it actually received still reports the truncation instead of hiding it. A
 * limit that is not a positive finite number falls back to MAX_POSTS_SCAN,
 * because comparing against NaN would silently answer "not truncated".
 */
export function scanCoverage(rowsFetched: number, limit: number = MAX_POSTS_SCAN): ScanCoverage {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : MAX_POSTS_SCAN;
  return {
    limit: cap,
    rows_fetched: rowsFetched,
    truncated: rowsFetched >= cap,
  };
}
