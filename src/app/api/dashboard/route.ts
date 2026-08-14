import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { EMPTY_BRAND, daysSince } from '@/lib/agent/context';
import type { BrandRow, ConceptRow, PostRow, SnapshotRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

/** Everything the Dashboard needs, in one round trip. */
export async function GET() {
  try {
    await requireOperator();
    const db = supabaseAdmin();

    const [{ data: brand }, { data: snapshots }] = await Promise.all([
      db.from('brand').select('*').eq('id', 1).maybeSingle(),
      db.from('snapshots').select('*').order('taken_on', { ascending: false }).limit(1),
    ]);

    const latest = (snapshots?.[0] as SnapshotRow | undefined) ?? null;

    const [{ data: topPosts }, { data: concepts }] = await Promise.all([
      latest
        ? db
            .from('posts')
            .select('*')
            .eq('snapshot_id', latest.id)
            .order('rank', { ascending: true })
            .limit(5)
        : Promise.resolve({ data: [] as PostRow[] }),
      db.from('concepts').select('id, status').limit(1000),
    ]);

    const counts = { draft: 0, approved: 0, shipped: 0, rejected: 0 };
    for (const row of (concepts as Pick<ConceptRow, 'id' | 'status'>[] | null) ?? []) {
      counts[row.status] += 1;
    }

    return NextResponse.json({
      brand: (brand as BrandRow | null) ?? EMPTY_BRAND,
      snapshot: latest,
      days_since_snapshot: latest ? daysSince(latest.taken_on) : null,
      top_posts: (topPosts as PostRow[] | null) ?? [],
      concept_counts: counts,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
