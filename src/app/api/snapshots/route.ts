import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { PillarRow, SnapshotRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

/** GET /api/snapshots — newest first, plus the current pillars for context. */
export async function GET() {
  try {
    await requireOperator();
    const db = supabaseAdmin();

    const [{ data: snapshots, error }, { data: pillars }] = await Promise.all([
      db.from('snapshots').select('*').order('taken_on', { ascending: false }).limit(50),
      db.from('pillars').select('*').order('avg_engagement', { ascending: false }),
    ]);

    if (error) throw new Error(`Could not read snapshots: ${error.message}`);

    return NextResponse.json({
      snapshots: (snapshots as SnapshotRow[] | null) ?? [],
      pillars: (pillars as PillarRow[] | null) ?? [],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
