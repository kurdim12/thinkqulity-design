import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ConceptRow, PillarRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

/** GET /api/concepts?status=&account= — newest first, with pillars for labels. */
export async function GET(request: Request) {
  try {
    await requireOperator();
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const account = url.searchParams.get('account');

    const db = supabaseAdmin();
    let query = db.from('concepts').select('*').order('created_at', { ascending: false });

    if (status && ['draft', 'approved', 'shipped', 'rejected'].includes(status)) {
      query = query.eq('status', status);
    }
    if (account === 'personal' || account === 'academy') {
      query = query.eq('account', account);
    }

    const [{ data, error }, { data: pillars }] = await Promise.all([
      query,
      db.from('pillars').select('*'),
    ]);

    if (error) throw new Error(`Could not read concepts: ${error.message}`);

    return NextResponse.json({
      concepts: (data as ConceptRow[] | null) ?? [],
      pillars: (pillars as PillarRow[] | null) ?? [],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
