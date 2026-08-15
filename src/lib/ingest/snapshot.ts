import { supabaseAdmin } from '@/lib/supabase/admin';
import { parseApifyExports, type ParsedPost } from '@/lib/ingest/apify';
import { computeDiff, todayIso } from '@/lib/snapshots';
import type { PostRow, SnapshotRow } from '@/lib/types/db';

/**
 * How many post rows go to Postgres in one insert.
 *
 * THE SAME DOUBLE RESIDENCY THE RAW STEP HAS. Every row carries its complete
 * `raw` item, and supabase-js serialises the array it is handed into one JSON
 * request body — so a single insert of a whole import holds the mapped rows AND
 * a full serialised copy of the entire payload at the same time, on top of the
 * parsed dataset the caller is still holding. That is three copies of the same
 * data in a 128 MB Cloudflare Workers isolate, where going over is Error 1102:
 * uncatchable, isolate discarded.
 *
 * Chunking bounds the serialised copy to 250 rows however large the import is.
 * It also bounds the `.select('id')` read-back, which previously returned one
 * row object per inserted post purely to be counted.
 */
const INSERT_CHUNK = 250;

/**
 * One parsed post as the `posts` table stores it.
 *
 * `rank` is passed in rather than derived, because the chunked insert below
 * must keep the parser's global engagement ordering: rank 1 is the highest
 * engagement in the whole import, not the highest in its chunk.
 */
function toPostRow(post: ParsedPost, snapshotId: string, rank: number) {
  return {
    snapshot_id: snapshotId,
    account: post.account,
    ig_id: post.ig_id,
    url: post.url,
    caption: post.caption,
    media_type: post.media_type,
    likes: post.likes,
    comments: post.comments,
    engagement: post.engagement,
    posted_at: post.posted_at,
    rank,
    // --- 0002_v3_ingestion: fields the actor returned all along. Absent ones
    // are null, never 0 — an unknown play count is unknown (hard rule 2).
    video_play_count: post.video_play_count,
    video_view_count: post.video_view_count,
    video_duration: post.video_duration,
    product_type: post.product_type,
    location_name: post.location_name,
    location_id: post.location_id,
    hashtags: post.hashtags,
    mentions: post.mentions,
    first_comment: post.first_comment,
    owner_username: post.owner_username,
    owner_id: post.owner_id,
    is_sponsored: post.is_sponsored,
    dimensions: post.dimensions,
    // Hard rule 8: the complete item is stored, so a field this mapping does
    // not surface yet is re-processable without re-scraping.
    raw: post.raw,
  };
}

export interface SnapshotResult {
  snapshot: SnapshotRow;
  counts: {
    posts: number;
    personal: number;
    academy: number;
    new_since_previous: number;
    duplicates_skipped: number;
    unroutable_skipped: number;
    profiles_skipped: number;
    unrecognised_skipped: number;
  };
  /**
   * One readable line per skip reason, straight from the parser. Surfaced so a
   * dropped item is visible to whoever ran the ingest instead of only living in
   * raw_meta — a scrape once lost 12 items with nothing said about it.
   */
  warnings: string[];
  files: string[];
}

/**
 * Turns one or more Apify payloads into a snapshot plus its ranked posts.
 *
 * Shared by the manual upload (/api/ingest) and the automated monitor
 * (/api/monitor) so both produce byte-identical snapshots — a monitored pull
 * and a hand-dropped file are indistinguishable downstream, which is what makes
 * the two interchangeable.
 */
export async function createSnapshotFrom(
  files: { name: string; payload: unknown }[],
  takenOn: string = todayIso(),
  source: string = 'upload',
): Promise<SnapshotResult> {
  const parsed = parseApifyExports(files);
  const db = supabaseAdmin();

  const { data: prevRows, error: prevError } = await db
    .from('snapshots')
    .select('*')
    .order('taken_on', { ascending: false })
    .limit(1);
  if (prevError) throw new Error(`Could not read previous snapshots: ${prevError.message}`);

  const previous = (prevRows?.[0] as SnapshotRow | undefined) ?? null;

  let newPostCount = parsed.posts.length;
  if (previous) {
    const { data: knownIds } = await db.from('posts').select('ig_id').eq('snapshot_id', previous.id);
    const known = new Set((knownIds ?? []).map((r) => (r as { ig_id: string }).ig_id));
    newPostCount = parsed.posts.filter((p) => !known.has(p.ig_id)).length;
  }

  const stats = {
    ...parsed.stats,
    diff_vs_prev: previous ? computeDiff(previous, parsed.stats, newPostCount) : null,
  };

  const { data: snapshotRow, error: snapshotError } = await db
    .from('snapshots')
    .insert({
      taken_on: takenOn,
      stats,
      raw_meta: {
        files: files.map((f) => f.name),
        usernames: parsed.usernames,
        skipped: parsed.skipped,
        warnings: parsed.warnings,
        source,
        ingested_at: new Date().toISOString(),
      },
    })
    .select('*')
    .single();

  if (snapshotError || !snapshotRow) {
    throw new Error(`Could not create the snapshot: ${snapshotError?.message ?? 'unknown error'}`);
  }

  const snapshot = snapshotRow as SnapshotRow;

  // Chunked, so the row array and the JSON body built from it stay bounded no
  // matter how large the import is. The rows for a chunk are built inside the
  // loop rather than up front: a full postRows array would be one more complete
  // copy of the payload alive alongside `parsed.posts`.
  let inserted = 0;
  for (let start = 0; start < parsed.posts.length; start += INSERT_CHUNK) {
    const chunk = parsed.posts
      .slice(start, start + INSERT_CHUNK)
      .map((post, offset) => toPostRow(post, snapshot.id, start + offset + 1));

    const { data: insertedPosts, error: postsError } = await db
      .from('posts')
      .insert(chunk)
      .select('id');

    if (postsError) {
      // Don't leave a snapshot with a partial set of posts behind. The
      // snapshot_id foreign key is ON DELETE CASCADE, so dropping the snapshot
      // also drops whatever chunks already landed: an import is all or nothing.
      await db.from('snapshots').delete().eq('id', snapshot.id);
      throw new Error(`Could not save posts: ${postsError.message}`);
    }

    // The ids are counted and then dropped; nothing downstream needs them.
    inserted += (insertedPosts as Pick<PostRow, 'id'>[] | null)?.length ?? chunk.length;
  }

  return {
    snapshot,
    counts: {
      posts: inserted,
      personal: parsed.stats.post_count.personal,
      academy: parsed.stats.post_count.academy,
      new_since_previous: newPostCount,
      duplicates_skipped: parsed.skipped.duplicates,
      unroutable_skipped: parsed.skipped.unroutable,
      profiles_skipped: parsed.skipped.profiles,
      unrecognised_skipped: parsed.skipped.unrecognised,
    },
    warnings: parsed.warnings,
    files: files.map((f) => f.name),
  };
}
