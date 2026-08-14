import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  status: z.enum(['draft', 'approved']),
});

/**
 * PATCH /api/guidelines/{id} — approve a version.
 *
 * Approval is a human act on purpose: the Judge can reject a guideline, but it
 * cannot bless one. Only the operator decides a document is fit for the client.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, 'Invalid guideline update.');

    const { data, error } = await supabaseAdmin()
      .from('brand_guidelines')
      .update({ status: parsed.data.status })
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new Error(`Could not update the guideline: ${error.message}`);
    return NextResponse.json({ guideline: data });
  } catch (err) {
    return errorResponse(err);
  }
}
