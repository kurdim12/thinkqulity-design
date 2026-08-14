import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  campaignResponseSchema,
  CAMPAIGN_SCHEMA_TEXT,
  type CampaignResponse,
} from '@/lib/agent/schemas';
import type { CampaignRow } from '@/lib/types/db';
import { defineFeature } from './types';

const inputSchema = z.object({
  objective: z.string().trim().min(4).max(500),
  timeframe: z.string().trim().min(2).max(120),
  name: z.string().trim().max(160).nullish(),
});

type Input = z.infer<typeof inputSchema>;

export const campaignFeature = defineFeature<Input, CampaignResponse>({
  id: 'campaign',
  label: 'Campaign plan',
  contextBlocks: ['brand', 'latest_snapshot', 'pillars', 'recent_concepts'],
  inputSchema,
  schema: campaignResponseSchema,
  maxTokens: 14000,

  buildPrompt(input) {
    return [
      `## Task`,
      `Design one campaign.`,
      `Objective: "${input.objective}".`,
      `Timeframe: "${input.timeframe}".`,
      `pillar_mix must name pillars from <pillars>; if that block is empty, propose working pillar names and label the campaign's grounding accordingly in each flagship concept.`,
      `cadence describes rhythm (e.g. "2 reels + 1 carousel per week"), not clock times — you have no timing data unless the snapshot contains it.`,
      `measurement_plan.pull_method must describe how a human collects the numbers, since this app never touches the Instagram API.`,
      ``,
      `## Response schema`,
      CAMPAIGN_SCHEMA_TEXT,
    ].join('\n');
  },

  async persist(result, input) {
    const db = supabaseAdmin();
    const name = input.name?.trim() || result.objective.slice(0, 120);

    const { data, error } = await db
      .from('campaigns')
      .insert({
        name,
        objective: result.objective,
        plan: {
          objective: result.objective,
          audience_segment: result.audience_segment,
          pillar_mix: result.pillar_mix,
          cadence: result.cadence,
          flagship_concepts: result.flagship_concepts,
          measurement_plan: result.measurement_plan,
          warnings: result.warnings,
        },
        status: 'draft',
      })
      .select('*')
      .single();

    if (error) throw new Error(`Could not save campaign: ${error.message}`);
    return { campaign: data as CampaignRow };
  },
});
