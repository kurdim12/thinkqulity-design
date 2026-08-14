import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { createSnapshotFrom } from '@/lib/ingest/snapshot';
import { todayIso } from '@/lib/snapshots';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/ingest — multipart form:
 *   files:    one or more Apify Instagram-scraper JSON exports (repeatable)
 *   taken_on: optional ISO date; defaults to today
 *
 * Produces exactly one snapshot plus its ranked posts. Rejects non-Apify
 * shapes with a message the Data screen can show verbatim.
 *
 * THIS ROUTE OWNS THE UPLOAD, NOT THE SNAPSHOT. Everything below reads the
 * multipart body and turns it into `{ name, payload }[]`; the snapshot itself is
 * built by createSnapshotFrom(), the same call /api/monitor makes.
 *
 * It used to own a hand-copied duplicate of that logic instead, and the copy
 * stopped being updated at migration 0002. Three guarantees were missing from
 * every hand-uploaded snapshot as a result, and none of them were visible from
 * this file:
 *   - `posts.raw` was never written, so hard rule 8 did not hold on this path —
 *     an upload was mapped and the complete item discarded.
 *   - none of the 0002 v3 columns were written, so `first_comment`,
 *     `video_play_count` and `owner_username` were null for uploaded data and
 *     the Board widgets that read them could only ever render an em-dash.
 *   - `parsed.warnings` was dropped, so a skipped item left no trace — the
 *     silent-loss guarantee that exists because a scrape once lost 12 items
 *     without saying so.
 *
 * The parameterisation the two callers genuinely need is the `source` argument,
 * which is the only thing that differs: 'upload' here, 'monitor' there. It lands
 * in `snapshots.raw_meta.source`, so a row records which gesture produced it.
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

    /**
     * SnapshotResult is returned whole. Its `snapshot`, `counts` and `files`
     * members are exactly the contract this route already had, with the same
     * names and types, so the Data screen keeps working untouched. It adds
     * `warnings`, `counts.profiles_skipped` and `counts.unrecognised_skipped` —
     * additive, and the first of those is the whole point: a dropped item is now
     * something this response can show instead of something only raw_meta knows.
     */
    return NextResponse.json(await createSnapshotFrom(files, takenOn, 'upload'));
  } catch (err) {
    return errorResponse(err);
  }
}
