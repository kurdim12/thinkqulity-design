import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const BUCKET = 'brand-assets';
/** Long enough to render a gallery, short enough that a leaked link is inert. */
const TTL_SECONDS = 300;

/**
 * GET /api/assets?path=… — redirects to a short-lived signed URL.
 *
 * The bucket is private: these are the client's decks and unpublished creative.
 * Because this route redirects rather than returning the URL, no signed link
 * ever appears in the client bundle or in page source — the browser follows it
 * and it expires in five minutes.
 */
export async function GET(request: Request) {
  try {
    await requireOperator();

    const path = new URL(request.url).searchParams.get('path');
    if (!path) throw new HttpError(400, 'Missing asset path.');

    // The path comes from a query string, so treat it as hostile: no traversal,
    // no absolute paths, no reaching into another bucket.
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
      throw new HttpError(400, 'Invalid asset path.');
    }

    const { data, error } = await supabaseAdmin()
      .storage.from(BUCKET)
      .createSignedUrl(path, TTL_SECONDS);

    if (error || !data?.signedUrl) {
      throw new HttpError(404, `No such asset: ${path}`, error?.message);
    }

    return NextResponse.redirect(data.signedUrl, {
      status: 307,
      headers: { 'cache-control': 'private, max-age=60' },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
