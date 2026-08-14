import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { retrieveCanon, CANON_TAGS } from '@/lib/brain/canon/retrieve';
import { embeddingProvider, embeddingDimension } from '@/lib/brain/canon/embed';

export const dynamic = 'force-dynamic';

/**
 * GET /api/canon?q=…&tags=voice,color — inspect what retrieval actually returns.
 *
 * Exists so the Canon is auditable rather than a black box: the operator can
 * see exactly which verbatim passage informed a generation, and from which
 * document.
 */
export async function GET(request: Request) {
  try {
    await requireOperator();
    const params = new URL(request.url).searchParams;
    const q = params.get('q');
    const tags = params.get('tags')?.split(',').filter(Boolean);

    const db = supabaseAdmin();
    const [{ count: documents }, { count: chunks }] = await Promise.all([
      db.from('canon_documents').select('id', { count: 'exact', head: true }),
      db.from('canon_chunks').select('id', { count: 'exact', head: true }),
    ]);

    const hits = q ? await retrieveCanon(q, { tags, k: 6 }) : [];

    return NextResponse.json({
      documents: documents ?? 0,
      chunks: chunks ?? 0,
      embedder: { provider: embeddingProvider(), dimension: embeddingDimension() },
      taxonomy: CANON_TAGS,
      query: q,
      hits,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
