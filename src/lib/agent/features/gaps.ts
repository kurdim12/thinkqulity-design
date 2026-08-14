import { z } from 'zod';
import { HttpError } from '@/lib/auth';
import { daysSince } from '@/lib/agent/context';
import {
  accountSchema,
  gapsResponseSchema,
  GAPS_SCHEMA_TEXT,
  type GapsResponse,
} from '@/lib/agent/schemas';
import { defineFeature } from './types';

const inputSchema = z.object({
  account: accountSchema.default('academy'),
  focus: z.string().trim().max(300).nullish(),
});

type Input = z.infer<typeof inputSchema>;

/**
 * "Monitor the account and tell me what's missing."
 *
 * The interesting half is what it is forbidden to do: a gap is only a finding
 * if it can be traced to a snapshot field, a pillar, or something in Ahmad's
 * own material. Everything else is labelled a hypothesis. Without that rule a
 * gap analysis becomes a horoscope — plausible, confident, unfalsifiable.
 */
export const gapsFeature = defineFeature<Input, GapsResponse>({
  id: 'gaps',
  label: 'Account gap analysis',
  contextBlocks: ['brand', 'knowledge', 'latest_snapshot', 'pillars', 'recent_concepts'],
  inputSchema,
  schema: gapsResponseSchema,
  maxTokens: 20000,

  preflight(_input, ctx) {
    if (!ctx.latestSnapshot) {
      throw new HttpError(
        409,
        'There is nothing to analyse yet — no engagement data has been ingested.',
        'Run the monitor on the Data screen, or upload an Apify export, then try again.',
      );
    }
  },

  buildPrompt(input, ctx) {
    const age = daysSince(ctx.latestSnapshot?.taken_on);
    const focus = input.focus?.trim();

    return [
      `## Task`,
      `Analyse the ${input.account} account and report the gaps — what is missing, weak, or inconsistent.`,
      focus ? `Pay particular attention to: "${focus}".` : '',
      ``,
      `The snapshot is ${age === null ? 'of unknown age' : `${age} days old`}. Say so if that limits what you can conclude.`,
      ``,
      `Rules specific to this task:`,
      `- Compare what <knowledge> says Ahmad teaches against what <latest_snapshot> shows he actually posts. A subject he trains on but never posts about is the most valuable kind of gap.`,
      `- "evidence" must name the field, pillar or source document the gap rests on — e.g. "top_format.academy = Image across 12 posts; no reels in the snapshot" or "قوة القصة is central in Workshop 2.pdf but no post in the snapshot tells a story".`,
      `- If you cannot point to something in the blocks, set grounding to "hypothesis" and say plainly that it is a guess worth testing.`,
      `- Do NOT infer posting frequency or timing gaps unless the snapshot carries posted_at values that support it.`,
      `- Do NOT claim a competitor comparison. You have no competitor data.`,
      `- Rank by severity: what is costing the most reach or trust comes first.`,
      ``,
      `## Response schema`,
      GAPS_SCHEMA_TEXT,
    ]
      .filter(Boolean)
      .join('\n');
  },

  // Analysis, not artefacts: nothing is written. Findings are read, argued
  // with, and turned into concepts by a human deciding they are right.
  async persist(result) {
    return {
      gaps: result.gaps.length,
      grounded: result.gaps.filter((g) => g.grounding === 'data').length,
      hypotheses: result.gaps.filter((g) => g.grounding === 'hypothesis').length,
    };
  },
});
