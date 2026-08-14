import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { computeStats, type BoardStats } from '@/lib/board/compute';
import {
  distinctPosts,
  scanCoverage,
  MAX_POSTS_SCAN,
  type DistinctPostsResult,
  type PostIdentity,
} from '@/lib/audience/posts';
import type { PostRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

/* ------------------------------------------------------------- what we read --
 *
 * `select('*')` is how `raw` got onto this screen. Migration 0002 added
 * `posts.raw jsonb` — the complete Apify item — and no code had to acknowledge
 * it, so `*` quietly began serialising the entire scrape payload of every post
 * to the browser. `monitor` sets `addParentData: true`, so each of those items
 * also embeds the parent profile blob (biography, latestPosts,
 * displayResources). Today every stored row predates 0002 and `raw` is null, so
 * the defect weighs nothing; on the first load after the first monitor run it is
 * the whole response. `raw` is sacred in the TABLE (hard rule 8) and has no
 * business in a list response that nothing on this screen reads.
 *
 * The list below is therefore exactly what this route returns, and it is one
 * string LITERAL on purpose: PostgREST parses the column list at the type level,
 * and a value merely typed `string` — a concatenation, a `join()` — resolves to
 * an error type rather than to rows.
 */
// prettier-ignore
const BOARD_POST_COLUMNS = 'id, snapshot_id, account, ig_id, url, caption, media_type, likes, comments, engagement, posted_at, rank, first_comment, video_play_count';

/** Exactly the fields `AnalysisRow` below declares — no `select('*')` here either. */
// prettier-ignore
const ANALYSIS_COLUMNS = 'post_id, computed, cluster_label, explanation, grounding, model, created_at';

/** Splits `'a, b, c'` into the union `'a' | 'b' | 'c'`. */
type SplitColumns<S extends string> = S extends `${infer Head}, ${infer Rest}`
  ? Head | SplitColumns<Rest>
  : S;

/** A post row as this route reads it: the columns above, and nothing else. */
type BoardPostRow = Pick<PostRow, SplitColumns<typeof BOARD_POST_COLUMNS> & keyof PostRow>;

/**
 * The guard the old `select('*')` did not need and this one does.
 *
 * A typo in the column list would otherwise cost a field silently — PostgREST
 * would not return it and `Pick` would quietly drop it from the row type. This
 * makes that a BUILD failure instead. It has no runtime job beyond existing.
 */
const COLUMNS_ARE_POST_FIELDS: SplitColumns<typeof BOARD_POST_COLUMNS> extends keyof PostRow
  ? true
  : never = true;
void COLUMNS_ARE_POST_FIELDS;

/**
 * `computeStats` is declared over `PostRow`, but reads only `account`,
 * `media_type` and `engagement` (src/lib/board/compute.ts:25-41) — all three are
 * in the select list above. Narrowing what it accepts is what lets the row type
 * stay honest about the columns actually read, instead of widening the rows to a
 * `PostRow` and claiming a `raw` this query deliberately did not fetch.
 * src/lib/board/compute.ts is outside this task's scope; the durable fix is to
 * declare its parameters as the subset they use.
 */
const statsOf = computeStats as (posts: readonly BoardPostRow[]) => BoardStats;

interface AnalysisRow {
  post_id: string;
  computed: Record<string, number | null>;
  cluster_label: string | null;
  explanation: string | null;
  grounding: 'data' | 'hypothesis';
  model: string | null;
  created_at: string;
}

const BANDS: Record<string, (percentile: number) => boolean> = {
  top10: (p) => p >= 90,
  top25: (p) => p >= 75,
  median: (p) => p >= 40 && p <= 60,
  bottom25: (p) => p <= 25,
};

/**
 * Snapshot rows read when ranking scrape recency. The read is newest-first, so
 * this cap can only ever drop snapshots that would have lost the comparison.
 */
const MAX_SNAPSHOTS_SCAN = 200;

/** Sorts a row whose snapshot is not in the ranking behind every ranked one. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Scrape recency as a rank: newest snapshot 0, the one before it 1, and so on.
 *
 * A post row carries no timestamp of its own — `posted_at` is when the post was
 * published, identical in every re-scrape — so the only place scrape recency
 * lives is `snapshots.taken_on`. distinctPosts() ranks snapshots by the order
 * rows reach it, which puts that ordering on the caller: this is that ordering.
 * Without it the board's read is `.order('engagement')`, and the freshest copy
 * of a post would be whichever snapshot happened to hold the loudest row.
 */
async function snapshotRecencyRank(): Promise<Map<string, number>> {
  const { data, error } = await supabaseAdmin()
    .from('snapshots')
    .select('id')
    .order('taken_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(MAX_SNAPSHOTS_SCAN);
  if (error) throw new Error(`Could not read snapshots: ${error.message}`);

  const rank = new Map<string, number>();
  for (const row of (data as { id: string }[] | null) ?? []) {
    if (!rank.has(row.id)) rank.set(row.id, rank.size);
  }
  return rank;
}

/**
 * One row per post, newest scrape winning. The recency sort is what makes the
 * winner deterministic; `Array.prototype.sort` is stable, so rows from the same
 * snapshot keep the order the query returned them in.
 */
function collapseToPosts<T extends PostIdentity>(
  rows: readonly T[],
  rank: Map<string, number>,
): DistinctPostsResult<T> {
  const byRecency = [...rows].sort(
    (a, b) => (rank.get(a.snapshot_id) ?? UNRANKED) - (rank.get(b.snapshot_id) ?? UNRANKED),
  );
  return distinctPosts(byRecency);
}

/**
 * Loudest first, which is the order the board displays and the order the
 * recency sort above destroyed. The ig_id tie-break is there so two posts on
 * equal engagement land in the same order on every request — Postgres promises
 * no order within a tie, and neither does the collapse.
 */
function byEngagement<T extends PostIdentity & { engagement: number }>(posts: readonly T[]): T[] {
  return [...posts].sort(
    (a, b) =>
      b.engagement - a.engagement || (a.ig_id < b.ig_id ? -1 : a.ig_id > b.ig_id ? 1 : 0),
  );
}

/* ------------------------------------------- an analysis follows the POST --- */

/** An analysis, resolved to the post it describes rather than the row it cites. */
interface AnalysisLink {
  analysis: AnalysisRow;
  /**
   * True when the analysis was written against an EARLIER scrape of this post.
   * A different fact from "never analysed", and the whole point of the index
   * below: conflating the two is what re-charges the operator for work already
   * paid for.
   */
  superseded: boolean;
}

/** `Date.parse` of an unusable timestamp is NaN; sort such a row oldest. */
function millis(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/** An analysis on the row now shown beats one on a superseded row; then newest. */
function beats(candidate: AnalysisLink, held: AnalysisLink): boolean {
  if (candidate.superseded !== held.superseded) return held.superseded;
  return millis(candidate.analysis.created_at) > millis(held.analysis.created_at);
}

/**
 * Analyses keyed by the POST they describe, not by the scrape row they cite.
 *
 * `post_analyses.post_id` references `posts.id` — the ROW. `posts` is UNIQUE
 * (snapshot_id, ig_id), so a re-scrape gives every post a second row with a NEW
 * uuid, and distinctPosts() hands the win to that new row. Keyed by row id, an
 * analysis written before the re-scrape therefore matches nothing: the card
 * reads "not analysed yet", the count reads 0, and the estimate re-quotes the
 * whole board for work that is sitting in `post_analyses` unshown.
 *
 * So the row id is resolved to an ig_id first — through the rows THIS request
 * read, before the collapse, because the row an analysis cites is usually the
 * one that lost it — and the ig_id is what the board matches on. No migration:
 * the join already exists in memory, and the column that would carry it
 * (`post_analyses.ig_id`) would have to be backfilled from exactly this map.
 *
 * `unresolved` counts analyses whose row was not in the read at all — a
 * truncated scan, or a deleted row. Returned rather than folded into "not
 * analysed", because an analysis this route could not place is not the same
 * fact as a post that has none.
 */
function indexAnalysesByPost(
  analyses: readonly AnalysisRow[],
  igIdByRowId: ReadonlyMap<string, string>,
  winnerRowIds: ReadonlySet<string>,
): { byIgId: Map<string, AnalysisLink>; unresolved: number } {
  const byIgId = new Map<string, AnalysisLink>();
  let unresolved = 0;

  for (const analysis of analyses) {
    const igId = igIdByRowId.get(analysis.post_id);
    if (igId === undefined) {
      unresolved += 1;
      continue;
    }
    const link: AnalysisLink = { analysis, superseded: !winnerRowIds.has(analysis.post_id) };
    const held = byIgId.get(igId);
    if (held === undefined || beats(link, held)) byIgId.set(igId, link);
  }

  return { byIgId, unresolved };
}

/** GET /api/board?account=&format=&band= — every post with its analysis. */
export async function GET(request: Request) {
  try {
    await requireOperator();
    const params = new URL(request.url).searchParams;
    const account = params.get('account');
    const format = params.get('format');
    const band = params.get('band');

    const db = supabaseAdmin();

    const [rank, postsResult, analysesResult] = await Promise.all([
      snapshotRecencyRank(),
      db
        .from('posts')
        .select(BOARD_POST_COLUMNS)
        .order('engagement', { ascending: false })
        .limit(MAX_POSTS_SCAN),
      db.from('post_analyses').select(ANALYSIS_COLUMNS),
    ]);

    if (postsResult.error) throw new Error(`Could not read posts: ${postsResult.error.message}`);
    // A swallowed error here used to render as "nothing is analysed", which is
    // the same screen a real empty table produces — and, now that the analysed
    // count drives `remaining`, the same screen that quotes the operator for the
    // whole board. A failed read is stated, never mistaken for an empty one.
    if (analysesResult.error) {
      throw new Error(`Could not read analyses: ${analysesResult.error.message}`);
    }

    // Two units, and they are not the same number. `posts` is UNIQUE
    // (snapshot_id, ig_id), so what comes back is scrape ROWS: a re-scraped post
    // occupies one row per snapshot. computeStats() over those rows would put
    // every re-scraped post into its own account average twice and shift every
    // percentile with it — arithmetic on a doubled population is a fabricated
    // number that merely looks computed. So the row count is measured for the
    // response, the rows are collapsed to posts, and everything below this line
    // runs on posts.
    const rows = (postsResult.data as BoardPostRow[] | null) ?? [];
    const coverage = scanCoverage(rows.length, MAX_POSTS_SCAN);
    const population = collapseToPosts(rows, rank);
    const allPosts = byEngagement(population.posts);

    // Built from the PRE-collapse rows: the row an analysis cites is usually the
    // one the collapse discarded, and that row is the only place its ig_id is.
    const igIdByRowId = new Map<string, string>();
    for (const row of rows) igIdByRowId.set(row.id, row.ig_id);

    const analysisRows = (analysesResult.data as AnalysisRow[] | null) ?? [];
    const winnerRowIds = new Set(allPosts.map((post) => post.id));
    const analyses = indexAnalysesByPost(analysisRows, igIdByRowId, winnerRowIds);

    const stats = statsOf(allPosts);

    let posts = allPosts;
    if (account === 'personal' || account === 'academy') {
      posts = posts.filter((p) => p.account === account);
    }
    if (format) posts = posts.filter((p) => (p.media_type ?? 'unknown') === format);

    const decorated = posts.map((post) => {
      const link = analyses.byIgId.get(post.ig_id) ?? null;
      return {
        ...post,
        analysis: link
          ? {
              computed: link.analysis.computed,
              cluster_label: link.analysis.cluster_label,
              explanation: link.analysis.explanation,
              grounding: link.analysis.grounding,
              model: link.analysis.model,
              /**
               * When the comparatives beside this card's LIVE engagement figure
               * were computed. They are frozen at that moment; the engagement is
               * not. Undated they read as current, which they are not.
               */
              created_at: link.analysis.created_at,
              /** See AnalysisLink.superseded — the card says so, in words. */
              superseded: link.superseded,
            }
          : null,
      };
    });

    const banded =
      band && BANDS[band]
        ? decorated.filter((p) => {
            const percentile = p.analysis?.computed?.percentile;
            return typeof percentile === 'number' && BANDS[band](percentile);
          })
        : decorated;

    // Counted over the whole population, not the filtered view, and by post.
    let analyzedCurrent = 0;
    let analyzedSuperseded = 0;
    for (const post of allPosts) {
      const link = analyses.byIgId.get(post.ig_id);
      if (link === undefined) continue;
      if (link.superseded) analyzedSuperseded += 1;
      else analyzedCurrent += 1;
    }

    return NextResponse.json({
      posts: banded,
      totals: {
        posts: allPosts.length,
        /** Posts carrying an analysis, resolved through ig_id — see above. */
        analyzed: analyzedCurrent + analyzedSuperseded,
        /** …of which the analysis was written against the row now displayed. */
        analyzed_current: analyzedCurrent,
        /** …and of which it was written against an earlier scrape of the post. */
        analyzed_superseded: analyzedSuperseded,
        account_avg: {
          personal: stats.accountAvg.personal > 0 ? Math.round(stats.accountAvg.personal) : null,
          academy: stats.accountAvg.academy > 0 ? Math.round(stats.accountAvg.academy) : null,
        },
      },
      /** What was read from `post_analyses`, and what could not be placed. */
      analyses: {
        rows_read: analysisRows.length,
        unresolved: analyses.unresolved,
      },
      /**
       * What the population above actually is, in both units, so the screen can
       * say it. `truncated` means the read filled its cap and the population is a
       * prefix — never rendered as a total. Same fields as /api/audience reports.
       */
      population: {
        rows_fetched: coverage.rows_fetched,
        limit: coverage.limit,
        truncated: coverage.truncated,
        distinct: population.posts.length,
        duplicates_collapsed: population.duplicates_collapsed,
        snapshots_seen: population.snapshots_seen,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
