import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { CampaignRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, 'Invalid campaign update.');

    const { data, error } = await supabaseAdmin()
      .from('campaigns')
      .update(parsed.data)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new Error(`Could not update the campaign: ${error.message}`);
    return NextResponse.json({ campaign: data as CampaignRow });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await params;
    const { error } = await supabaseAdmin().from('campaigns').delete().eq('id', id);
    if (error) throw new Error(`Could not delete the campaign: ${error.message}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
