import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CONCEPT_FEWSHOT } from '@/lib/agent/system';
import {
  accountSchema,
  conceptsResponseSchema,
  CONCEPT_SCHEMA_TEXT,
  type ConceptsResponse,
} from '@/lib/agent/schemas';
import type { ConceptRow } from '@/lib/types/db';
import { defineFeature } from './types';

const inputSchema = z.object({
  count: z.number().int().min(1).max(8).default(3),
  theme: z.string().trim().max(300).nullish(),
  account: accountSchema.default('academy'),
});

type Input = z.infer<typeof inputSchema>;

export const conceptsFeature = defineFeature<Input, ConceptsResponse>({
  id: 'concepts',
  label: 'Post concepts',
  contextBlocks: ['brand', 'latest_snapshot', 'pillars', 'recent_concepts'],
  inputSchema,
  schema: conceptsResponseSchema,
  maxTokens: 12000,

  buildPrompt(input) {
    const theme = input.theme?.trim();
    return [
      `## Task`,
      `Produce exactly ${input.count} post concept${input.count === 1 ? '' : 's'} for the ${input.account} account.`,
      theme ? `Theme to work from: "${theme}".` : 'No theme was given — choose angles the data supports.',
      `Do not repeat a hook that already appears in <recent_concepts>.`,
      ``,
      `## Response schema`,
      CONCEPT_SCHEMA_TEXT,
      ``,
      `## Example of the expected shape and grounding honesty`,
      CONCEPT_FEWSHOT,
    ].join('\n');
  },

  async persist(result, input) {
    const db = supabaseAdmin();

    // Map the agent's pillar *name* onto a pillar id, when one matches.
    const { data: pillars } = await db.from('pillars').select('id, name_ar, name_en');
    const byName = new Map<string, string>();
    for (const p of pillars ?? []) {
      const row = p as { id: string; name_ar: string; name_en: string | null };
      byName.set(row.name_ar.trim().toLowerCase(), row.id);
      if (row.name_en) byName.set(row.name_en.trim().toLowerCase(), row.id);
    }

    const rows = result.concepts.map((c) => ({
      title: c.title,
      pillar_id: c.pillar ? byName.get(c.pillar.trim().toLowerCase()) ?? null : null,
      format: c.format,
      hook_ar: c.hook_ar,
      caption_ar: c.caption_ar,
      visual_direction: c.visual_direction,
      why: c.why,
      grounding: c.grounding,
      status: 'draft' as const,
      account: input.account,
    }));

    const { data, error } = await db.from('concepts').insert(rows).select('*');
    if (error) throw new Error(`Could not save concepts: ${error.message}`);
    return { inserted: (data as ConceptRow[]) ?? [] };
  },
});
