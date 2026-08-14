import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { CampaignRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

/** GET /api/campaigns — full plans, newest first. */
export async function GET() {
  try {
    await requireOperator();
    const { data, error } = await supabaseAdmin()
      .from('campaigns')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new Error(`Could not read campaigns: ${error.message}`);
    return NextResponse.json({ campaigns: (data as CampaignRow[] | null) ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
