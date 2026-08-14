import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ConceptRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

const patchSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    hook_ar: z.string().trim().min(1).optional(),
    caption_ar: z.string().trim().min(1).optional(),
    visual_direction: z.string().trim().min(1).optional(),
    why: z.string().trim().min(1).optional(),
    format: z.enum(['reel', 'carousel', 'static', 'story']).optional(),
    status: z.enum(['draft', 'approved', 'shipped', 'rejected']).optional(),
    target_week: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    shipped_url: z.string().trim().nullable().optional(),
    pillar_id: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

/**
 * PATCH /api/concepts/{id}
 * Marking a concept `shipped` requires the Instagram URL — that URL is what
 * lets the next refresh backfill real engagement onto the concept.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await params;

    const body: unknown = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid concept update.',
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      );
    }

    const db = supabaseAdmin();

    if (parsed.data.status === 'shipped') {
      const url = parsed.data.shipped_url;
      if (url === undefined) {
        const { data: existing } = await db
          .from('concepts')
          .select('shipped_url')
          .eq('id', id)
          .maybeSingle();
        if (!(existing as { shipped_url: string | null } | null)?.shipped_url) {
          throw new HttpError(
            400,
            'A shipped concept needs the Instagram URL of the published post.',
            'Refresh matches that URL against the next export to fill in real engagement.',
          );
        }
      } else if (!url) {
        throw new HttpError(400, 'A shipped concept needs the Instagram URL of the published post.');
      }
    }

    const { data, error } = await db
      .from('concepts')
      .update(parsed.data)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new Error(`Could not update the concept: ${error.message}`);
    return NextResponse.json({ concept: data as ConceptRow });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireOperator();
    const { id } = await params;
    const { error } = await supabaseAdmin().from('concepts').delete().eq('id', id);
    if (error) throw new Error(`Could not delete the concept: ${error.message}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
