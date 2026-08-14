import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { EMPTY_BRAND } from '@/lib/agent/context';
import type { BrandRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

const factSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  source: z.string().min(1),
  label_en: z.string().nullish(),
  label_ar: z.string().nullish(),
});

const voiceExampleSchema = z.object({
  text: z.string().min(1),
  source_url: z.string().nullable(),
  engagement: z.number().int().nullable(),
  note: z.string().nullish(),
});

const paletteSchema = z.object({
  swatches: z.record(z.string(), z.string()),
  note: z.string().nullish(),
});

const typographySchema = z.object({
  arabic_display: z.string().nullish(),
  arabic_body: z.string().nullish(),
  latin: z.string().nullish(),
  note: z.string().nullish(),
});

const putSchema = z.object({
  facts: z.array(factSchema).optional(),
  voice_examples: z.array(voiceExampleSchema).optional(),
  palette: paletteSchema.nullable().optional(),
  typography: typographySchema.nullable().optional(),
  audience_notes: z.string().nullable().optional(),
});

export async function GET() {
  try {
    await requireOperator();
    const { data, error } = await supabaseAdmin()
      .from('brand')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(`Could not read the Brand Brain: ${error.message}`);
    return NextResponse.json({ brand: (data as BrandRow | null) ?? EMPTY_BRAND, seeded: data !== null });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PUT /api/brand — partial update. Saving a palette with at least one swatch
 * flips brand.status to 'live': that is the moment the agent is allowed to
 * reference colours instead of writing "palette pending assets".
 */
export async function PUT(request: Request) {
  try {
    await requireOperator();
    const body: unknown = await request.json().catch(() => null);
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid Brand Brain update.',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }

    const db = supabaseAdmin();
    const { data: current } = await db.from('brand').select('*').eq('id', 1).maybeSingle();
    const existing = (current as BrandRow | null) ?? EMPTY_BRAND;

    const next = {
      facts: parsed.data.facts ?? existing.facts,
      voice_examples: parsed.data.voice_examples ?? existing.voice_examples,
      palette: parsed.data.palette !== undefined ? parsed.data.palette : existing.palette,
      typography: parsed.data.typography !== undefined ? parsed.data.typography : existing.typography,
      audience_notes:
        parsed.data.audience_notes !== undefined
          ? parsed.data.audience_notes
          : existing.audience_notes,
    };

    const hasPalette = !!next.palette && Object.keys(next.palette.swatches ?? {}).length > 0;
    const status: BrandRow['status'] = hasPalette ? 'live' : 'seed';

    const { data, error } = await db
      .from('brand')
      .upsert({ id: 1, ...next, status, updated_at: new Date().toISOString() })
      .select('*')
      .single();

    if (error) throw new Error(`Could not save the Brand Brain: ${error.message}`);
    return NextResponse.json({ brand: data as BrandRow });
  } catch (err) {
    return errorResponse(err);
  }
}
