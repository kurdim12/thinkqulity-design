import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { parseApifyExports } from '@/lib/ingest/apify';
import { computeDiff, todayIso } from '@/lib/snapshots';
import type { PostRow, SnapshotRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/ingest — multipart form:
 *   files:    one or more Apify Instagram-scraper JSON exports (repeatable)
 *   taken_on: optional ISO date; defaults to today
 *
 * Produces exactly one snapshot plus its ranked posts. Rejects non-Apify
 * shapes with a message the Data screen can show verbatim.
 */
export async function POST(request: Request) {
  try {
    await requireOperator();

    const form = await request.formData().catch(() => {
      throw new HttpError(400, 'Expected a multipart upload.');
    });

    const uploaded = form.getAll('files').filter((f): f is File => f instanceof File);
    if (uploaded.length === 0) {
      throw new HttpError(400, 'No files were attached.', 'Drop one or more Apify .json exports.');
    }

    const takenOnRaw = form.get('taken_on');
    const takenOn =
      typeof takenOnRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(takenOnRaw)
        ? takenOnRaw
        : todayIso();

    const files: { name: string; payload: unknown }[] = [];
    for (const file of uploaded) {
      const text = await file.text();
      try {
        files.push({ name: file.name, payload: JSON.parse(text) as unknown });
      } catch (err) {
        throw new HttpError(
          400,
          `"${file.name}" is not valid JSON.`,
          (err as Error).message.slice(0, 200),
        );
      }
    }

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
      const { data: knownIds } = await db
        .from('posts')
        .select('ig_id')
        .eq('snapshot_id', previous.id);
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
          ingested_at: new Date().toISOString(),
        },
      })
      .select('*')
      .single();

    if (snapshotError || !snapshotRow) {
      throw new Error(`Could not create the snapshot: ${snapshotError?.message ?? 'unknown error'}`);
    }

    const snapshot = snapshotRow as SnapshotRow;

    const postRows = parsed.posts.map((post, index) => ({
      snapshot_id: snapshot.id,
      account: post.account,
      ig_id: post.ig_id,
      url: post.url,
      caption: post.caption,
      media_type: post.media_type,
      likes: post.likes,
      comments: post.comments,
      engagement: post.engagement,
      posted_at: post.posted_at,
      rank: index + 1,
    }));

    const { data: insertedPosts, error: postsError } = await db
      .from('posts')
      .insert(postRows)
      .select('id');

    if (postsError) {
      // Don't leave a snapshot with no posts behind.
      await db.from('snapshots').delete().eq('id', snapshot.id);
      throw new Error(`Could not save posts: ${postsError.message}`);
    }

    return NextResponse.json({
      snapshot,
      counts: {
        posts: (insertedPosts as Pick<PostRow, 'id'>[] | null)?.length ?? postRows.length,
        personal: parsed.stats.post_count.personal,
        academy: parsed.stats.post_count.academy,
        new_since_previous: newPostCount,
        duplicates_skipped: parsed.skipped.duplicates,
        unroutable_skipped: parsed.skipped.unroutable,
      },
      files: files.map((f) => f.name),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
