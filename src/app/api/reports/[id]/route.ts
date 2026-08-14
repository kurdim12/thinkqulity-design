import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ReportRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  body_md: z.string().min(1).optional(),
  /**
   * 'approved' means the operator has read it. Nothing is sent anywhere — this
   * app has no delivery mechanism by design.
   */
  status: z.enum(['draft', 'approved']).optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, 'Invalid report update.');

    const { data, error } = await supabaseAdmin()
      .from('reports')
      .update(parsed.data)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new Error(`Could not update the report: ${error.message}`);
    return NextResponse.json({ report: data as ReportRow });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await params;
    const { error } = await supabaseAdmin().from('reports').delete().eq('id', id);
    if (error) throw new Error(`Could not delete the report: ${error.message}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
