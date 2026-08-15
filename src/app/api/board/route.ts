import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { computeStats, type BoardStats } from '@/lib/board/compute';
import { indexAnalysesByPost } from '@/lib/board/identity';
import {
  distinctPosts,
  scanCoverage,
  MAX_POSTS_SCAN,
  type DistinctPostsResult,
  type PostIdentity,
} from '@/lib/audience/posts';
import {
  readMirrorIndex,
  postMediaFor,
  mirrorCoverage,
  mirrorMediaEnabled,
} from '@/lib/ingest/media';
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

/**
 * Exactly the fields `AnalysisRow` below declares — no `select('*')` here
 * either. `ig_id` is read because it is now the JOIN: see the note above
 * indexAnalysesByPost() in src/lib/board/identity.ts for why the row id it sits
 * beside is no longer enough on its own.
 */
// prettier-ignore
const ANALYSIS_COLUMNS = 'post_id, ig_id, computed, cluster_label, explanation, grounding, model, created_at';

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
  /** The post this analysis describes. Nullable column; see identity.ts. */
  ig_id: string | null;
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

/**
 * The pre-0004 bridge, and nothing more.
 *
 * An analysis names its post directly now (`post_analyses.ig_id`, added and
 * backfilled by migration 0004), so the match no longer depends on this map.
 * Rows written before that column existed carry null, and the only place their
 * ig_id can be recovered from is the scrape rows this request already read —
 * which is a CAPPED read, and inheriting that cap is exactly the boundary the
 * column removed. So: fallback, never the rule.
 *
 * Built from the PRE-collapse rows on purpose, because the row an analysis cites
 * is usually the one the collapse discarded.
 */
function legacyIgIdByRowId(rows: readonly { id: string; ig_id: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.id, row.ig_id);
  return map;
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

    // Matched on `post_analyses.ig_id` — the column, not an inference from this
    // request's capped read. The map below is only the pre-0004 fallback.
    const analysisRows = (analysesResult.data as AnalysisRow[] | null) ?? [];
    const analyses = indexAnalysesByPost(analysisRows, allPosts, legacyIgIdByRowId(rows));

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
              /** See AnalysisLink.superseded in src/lib/board/identity.ts — the card says so, in words. */
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

    /* ------------------------------------------------------- the images --- *
     *
     * WHY THE BUCKET IS ASKED AND NOT THE ROW. Nothing in `posts` records
     * whether a thumbnail was mirrored. It could not: `posts.raw` holds the CDN
     * URL the scrape returned, that URL expires, and a row is not rewritten when
     * it does — so a card built from the row would claim an image that resolves
     * to nothing, which is the broken-image icon hard rule 2 forbids. The
     * storage listing is the only thing that knows, and it is read here, once
     * per distinct account (two, at this corpus) rather than once per card.
     *
     * IT IS READ OVER THE POSTS BEING RETURNED, not the whole population: these
     * are the cards that will ask for an image, and the counts below therefore
     * describe the view the operator is looking at. `banded` is already
     * account-filtered, so a single-account view lists one prefix.
     *
     * RULE 4. `src` is `/api/assets?path=…` — a route path, not a signed URL.
     * The signed URL is minted inside that route after requireOperator() and
     * handed to the browser as a 307 that expires in five minutes; nothing in
     * this response, and nothing in the client bundle, ever holds one.
     */
    const mirrorIndex = await readMirrorIndex(
      db,
      banded.map((post) => post.account),
    );
    const withMedia = banded.map((post) => ({
      ...post,
      media: postMediaFor(mirrorIndex, post.account, post.ig_id),
    }));
    const images = mirrorCoverage(withMedia.map((post) => post.media));

    // Counted over the whole population, not the filtered view, and by post:
    // indexAnalysesByPost() is bounded by the population it was handed, so its
    // counts are already per-post over `allPosts`.
    const analyzedCurrent = analyses.analyzed_current;
    const analyzedSuperseded = analyses.analyzed_superseded;

    return NextResponse.json({
      posts: withMedia,
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
       * The image state of the cards being returned, in the three states the
       * bucket can actually prove. `mirrored + not_mirrored + unknown` equals
       * `examined`, so none of the three is a zero standing in for an absence —
       * a listing that failed raises `unknown`, it does not shrink `mirrored`.
       *
       * `enabled` is the MIRROR_MEDIA flag as the server reads it. It is the
       * boolean, never the value of any secret, and it is what lets a card say
       * WHY it has no image: "the flag is off" and "the flag is on and this
       * post's URL had nothing left to copy" are different facts about the post.
       */
      media: {
        enabled: mirrorMediaEnabled(),
        index_complete: mirrorIndex.complete,
        index_error: mirrorIndex.error,
        examined: images.examined,
        mirrored: images.mirrored,
        not_mirrored: images.not_mirrored,
        unknown: images.unknown,
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
