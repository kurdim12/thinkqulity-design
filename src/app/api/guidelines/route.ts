import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/** GET /api/guidelines — newest version first. */
export async function GET() {
  try {
    await requireOperator();
    const { data, error } = await supabaseAdmin()
      .from('brand_guidelines')
      .select('*')
      .order('version', { ascending: false });

    if (error) throw new Error(`Could not read guidelines: ${error.message}`);
    return NextResponse.json({ guidelines: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
