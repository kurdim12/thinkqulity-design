import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ReportRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

/** GET /api/reports — newest month first. */
export async function GET() {
  try {
    await requireOperator();
    const { data, error } = await supabaseAdmin()
      .from('reports')
      .select('*')
      .order('month', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Could not read reports: ${error.message}`);
    return NextResponse.json({ reports: (data as ReportRow[] | null) ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
