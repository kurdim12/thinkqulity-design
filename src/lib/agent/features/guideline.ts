import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { REQUIRED_SECTIONS, TBD_AR, type GuidelineSection } from '@/lib/brain/law';
import { defineFeature, type BrainReport } from './types';

const inputSchema = z.object({
  note: z.string().trim().max(500).nullish(),
});

type Input = z.infer<typeof inputSchema>;

const sectionSchema = z.object({
  key: z.enum(REQUIRED_SECTIONS),
  title_ar: z.string().min(1),
  lines: z
    .array(
      z.object({
        text: z.string().min(1),
        /** Where this line came from. Empty source is a Law violation. */
        source: z.string().min(1),
      }),
    )
    .min(1),
});

const guidelineResponseSchema = z.object({
  warnings: z.array(z.string()),
  sections: z.array(sectionSchema).min(1),
});

type GuidelineResponse = z.infer<typeof guidelineResponseSchema>;

/**
 * A brand guideline built from the brand's own evidence.
 *
 * Canon supplies the *shape* — what a serious guideline contains and how its
 * sections are usually framed. Every word of content comes from Think Quality's
 * own data, and every line names where it came from. Where the data does not
 * exist, the section says so rather than inventing something plausible: an
 * invented guideline is worse than no guideline, because it gets followed.
 */
export const guidelineFeature = defineFeature<Input, GuidelineResponse>({
  id: 'guideline',
  label: 'Brand guideline',
  contextBlocks: ['brand', 'knowledge', 'canon', 'latest_snapshot', 'pillars'],
  inputSchema,
  schema: guidelineResponseSchema,
  maxTokens: 24000,

  brain: {
    task: 'brand guideline',
    toText: (result) =>
      result.sections
        .map((s) => `## ${s.title_ar}\n${s.lines.map((l) => `- ${l.text} [${l.source}]`).join('\n')}`)
        .join('\n\n'),
    guidelineSections: (result) => result.sections as GuidelineSection[],
    canonQuery: () =>
      'what a brand guideline contains: structure, voice section, colour section, typography, logo usage, social, Arabic specifics',
    canonTags: ['structure', 'voice', 'color', 'typography', 'logo-usage', 'social', 'arabic-specific'],
  },

  buildPrompt(input, ctx) {
    const note = input.note?.trim();
    return [
      '## Task',
      'Write the brand guideline for Think Quality Academy.',
      note ? `Operator note: "${note}".` : '',
      '',
      `Produce exactly these sections, in this order: ${REQUIRED_SECTIONS.join(', ')}.`,
      'title_ar is the section heading in Arabic.',
      '',
      'Rules specific to this document:',
      '- Use <canon> for STRUCTURE and PRINCIPLE only — what belongs in each section, how such sections are framed. Never copy another brand\'s content, wording, colours or examples into this guideline.',
      '- Every line\'s `source` names where it came from: "brand.palette (sampled from 14 published creatives)", "brand.voice_examples", "brand.facts: positioning", "knowledge: Workshop 2.pdf", "snapshot 2026-08-14", or "canon:<chunk_id>" when the line states a general principle.',
      `- If a section has no supporting data, write ONE line whose text begins «${TBD_AR}» and then names exactly what would fill it, sourced as "gap". Never invent a value to fill a section.`,
      '- The colour section must use the real sampled palette and say it was sampled, not chosen.',
      '- The typography section must say the typeface is unconfirmed if brand.typography records it as such.',
      '- Voice lines must quote the real voice examples, with their real engagement.',
      '- Write section content in Arabic. Source strings stay in English.',
      '',
      `Snapshot available: ${ctx.latestSnapshot?.taken_on ?? 'none'}.`,
      '',
      '## Response schema',
      `{"warnings":["string"],"sections":[{"key":"${REQUIRED_SECTIONS[0]}","title_ar":"string","lines":[{"text":"string","source":"string"}]}]}`,
    ]
      .filter(Boolean)
      .join('\n');
  },

  async persist(result, _input, _ctx, brain?: BrainReport) {
    const db = supabaseAdmin();

    const { data: latest } = await db
      .from('brand_guidelines')
      .select('version')
      .order('version', { ascending: false })
      .limit(1);

    const version = ((latest?.[0] as { version: number } | undefined)?.version ?? 0) + 1;

    const { data, error } = await db
      .from('brand_guidelines')
      .insert({
        version,
        sections: result.sections,
        // A guideline that failed review is stored as a draft, never approved.
        status: 'draft',
      })
      .select('*')
      .single();

    if (error) throw new Error(`Could not save the guideline: ${error.message}`);

    return {
      guideline: data,
      needs_human: brain?.needsHuman ?? false,
      judge_score: brain?.judge.score ?? null,
    };
  },
});
