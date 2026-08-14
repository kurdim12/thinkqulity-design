import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { HttpError } from '@/lib/auth';
import type { FrameLike } from '@/lib/brain/law';
import type { ConceptRow } from '@/lib/types/db';
import { defineFeature, type BrainReport } from './types';

const inputSchema = z.object({
  concept_id: z.string().uuid(),
  frames: z.number().int().min(3).max(10).default(5),
});

type Input = z.infer<typeof inputSchema>;

export const frameSchema = z.object({
  order: z.number().int().min(1),
  scene_beat_ar: z.string().min(1),
  overlay_ar: z.string(),
  shot_direction: z.string().min(1),
  duration_s: z.number().min(0.5).max(60),
  /** A NAME from brand.palette, never a hex — Law enforces that it resolves. */
  palette_ref: z.string().nullable(),
});

const storyboardResponseSchema = z.object({
  warnings: z.array(z.string()),
  frames: z.array(frameSchema).min(3),
});

type StoryboardResponse = z.infer<typeof storyboardResponseSchema>;

/**
 * A storyboard Ahmad can film from.
 *
 * No image generation, by decision: Arabic text inside generated images is
 * still mangled, so the frames are rendered by code in his real palette and
 * real typeface. `palette_ref` is a swatch NAME rather than a hex so the brand
 * stays the single source of colour — Law rejects any name that doesn't exist.
 */
export const storyboardFeature = defineFeature<Input, StoryboardResponse>({
  id: 'storyboard',
  label: 'Storyboard',
  contextBlocks: ['brand', 'knowledge', 'latest_snapshot', 'pillars'],
  inputSchema,
  schema: storyboardResponseSchema,
  maxTokens: 16000,

  brain: {
    task: 'storyboard for a reel',
    toText: (result) =>
      result.frames
        .map(
          (f) =>
            `${f.order}. [${f.duration_s}s · ${f.shot_direction} · ${f.palette_ref ?? 'no palette ref'}]\n${f.scene_beat_ar}\nOverlay: ${f.overlay_ar}`,
        )
        .join('\n\n'),
    frames: (result) => result.frames as FrameLike[],
    paletteReferences: (result) => result.frames.map((f) => f.palette_ref),
    canonQuery: () => 'storyboard structure, shot direction, on-screen text in social video',
    canonTags: ['social', 'layout', 'arabic-specific'],
  },

  buildPrompt(input, ctx) {
    const swatches = Object.keys(ctx.brand.palette?.swatches ?? {});
    return [
      '## Task',
      `Turn concept ${input.concept_id} into a ${input.frames}-frame storyboard Ahmad can film from.`,
      '',
      'Per frame:',
      '- scene_beat_ar: what happens, in Arabic, one or two sentences.',
      '- overlay_ar: the on-screen Arabic text for that frame. Keep it short enough to read on a phone. Empty string if the frame carries no text.',
      '- shot_direction: framing and camera in English (e.g. "tight crop, eye level, static").',
      '- duration_s: seconds, realistic for the beat.',
      `- palette_ref: one of these swatch NAMES — ${swatches.length > 0 ? swatches.join(', ') : '(no palette recorded)'} — or null. Never a hex value.`,
      '',
      'Frame 1 must earn the scroll-stop in under two seconds. Order runs 1..N with no gaps.',
      'Do NOT describe an image to be generated — describe a shot to be filmed.',
      '',
      '## Response schema',
      '{"warnings":["string"],"frames":[{"order":1,"scene_beat_ar":"string","overlay_ar":"string","shot_direction":"string","duration_s":3,"palette_ref":"string|null"}]}',
    ].join('\n');
  },

  async persist(result, input, _ctx, brain?: BrainReport) {
    const db = supabaseAdmin();

    const frames = [...result.frames].sort((a, b) => a.order - b.order);

    const { data, error } = await db
      .from('concepts')
      .update({ frames })
      .eq('id', input.concept_id)
      .select('*')
      .single();

    if (error) throw new HttpError(404, `Could not attach the storyboard: ${error.message}`);

    return {
      concept: data as ConceptRow,
      frames,
      needs_human: brain?.needsHuman ?? false,
    };
  },
});
