import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { PostRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

/** GET /api/snapshots/{id}/posts?account=personal|academy */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await params;
    const account = new URL(request.url).searchParams.get('account');

    let query = supabaseAdmin()
      .from('posts')
      .select('*')
      .eq('snapshot_id', id)
      .order('rank', { ascending: true });

    if (account === 'personal' || account === 'academy') {
      query = query.eq('account', account);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Could not read posts: ${error.message}`);

    return NextResponse.json({ posts: (data as PostRow[] | null) ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
