import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { scanCoverage, MAX_POSTS_SCAN } from '@/lib/audience/posts';
import type { PostRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

/**
 * A post row as this route returns it: every `posts` column except `raw`.
 *
 * `raw` is the complete Apify item (hard rule 8 stores it on ingest), and it is
 * the one column with no size ceiling — the monitor sets `addParentData: true`,
 * so each item also embeds the parent profile blob with its biography,
 * latestPosts and displayResources. It is sacred in the TABLE; it has no
 * business in a list response that two screens fetch on every snapshot change.
 * Nothing reads it here, so it is not selected here.
 *
 * The v3 scalar columns ARE selected. They are small, and the alternative —
 * narrowing to only the twelve fields the current tables happen to render —
 * would set a trap for whoever next wires first_comment or video_play_count
 * into the Dashboard: the column would silently arrive undefined.
 */
type SnapshotPostRow = Omit<PostRow, 'raw'>;

/**
 * The select list.
 *
 * It is ONE unbroken literal on purpose. PostgREST parses the column list at
 * type level, so the value has to keep its literal type: splitting it across
 * concatenated pieces widens it to `string`, and the query then resolves to an
 * error type instead of to rows. Same reason it is not built from an array.
 */
// prettier-ignore
const POST_COLUMNS = 'id, snapshot_id, account, ig_id, url, caption, media_type, likes, comments, engagement, posted_at, rank, video_play_count, video_view_count, video_duration, product_type, location_name, location_id, hashtags, mentions, first_comment, owner_username, owner_id, is_sponsored, dimensions';

/** The column names in `POST_COLUMNS`, as a union, so they can be checked. */
type SplitColumns<S extends string> = S extends `${infer Head}, ${infer Rest}`
  ? Head | SplitColumns<Rest>
  : S;

/** `true` only when the two unions are identical in BOTH directions. */
type AssertSameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * The guard that was missing.
 *
 * `select('*')` is why `raw` arrived here uninvited: migration 0002 added
 * fourteen columns and no code had to acknowledge any of them. This assertion
 * makes the next such migration a BUILD failure instead of a silent payload —
 * add a column to PostRow and the union stops matching, so it must be either
 * listed above or deliberately excluded from SnapshotPostRow. It is a
 * compile-time check with no runtime job beyond existing.
 */
const COLUMNS_MATCH_ROW: AssertSameKeys<
  SplitColumns<typeof POST_COLUMNS>,
  keyof SnapshotPostRow
> = true;
void COLUMNS_MATCH_ROW;

/**
 * GET /api/snapshots/{id}/posts?account=personal|academy
 *
 * One snapshot's posts, ranked. `posts` is UNIQUE (snapshot_id, ig_id) and this
 * filters on one snapshot_id, so the rows returned are one-per-post by
 * construction and no dedupe happens here — the Dashboard still runs
 * distinctPosts() over them, which is why `ig_id`, `snapshot_id` and
 * `posted_at` stay in the select list.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await params;
    const account = new URL(request.url).searchParams.get('account');

    let query = supabaseAdmin()
      .from('posts')
      .select(POST_COLUMNS)
      .eq('snapshot_id', id)
      .order('rank', { ascending: true })
      // The read used to have no ceiling at all. MAX_POSTS_SCAN is the cap every
      // other full-population read of `posts` states, so the number this route
      // reports is the number /api/board and /api/audience already use. Ordering
      // by rank first makes the prefix deterministic AND makes it the useful
      // half: rank 1 is the highest-engagement post, so a truncated read drops
      // the quietest posts rather than an arbitrary slice.
      .limit(MAX_POSTS_SCAN);

    if (account === 'personal' || account === 'academy') {
      query = query.eq('account', account);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Could not read posts: ${error.message}`);

    const posts = (data as SnapshotPostRow[] | null) ?? [];

    return NextResponse.json({
      posts,
      /**
       * What that read actually covered. `truncated` means it filled its cap and
       * `posts` is a PREFIX of the snapshot — a screen renders "the first 2000"
       * and never "2000 of N", because what a capped query did not see is not
       * knowable from its result. Reported rather than hidden: a count presented
       * as a total when it is a prefix is a fabricated number.
       *
       * There is no separate post count here because there is nothing to
       * collapse — see the note above the handler.
       */
      population: scanCoverage(posts.length, MAX_POSTS_SCAN),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
