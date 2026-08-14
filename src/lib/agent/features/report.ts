import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { HttpError } from '@/lib/auth';
import { daysSince } from '@/lib/agent/context';
import {
  reportResponseSchema,
  REPORT_SCHEMA_TEXT,
  type ReportResponse,
} from '@/lib/agent/schemas';
import type { ReportRow } from '@/lib/types/db';
import { defineFeature } from './types';

/** A report older than this describes a state of the world we can't vouch for. */
export const MAX_SNAPSHOT_AGE_DAYS = 45;

const inputSchema = z.object({
  /** First day of the month being reported on, ISO date. */
  month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date, e.g. 2026-08-01'),
});

type Input = z.infer<typeof inputSchema>;

export const reportFeature = defineFeature<Input, ReportResponse>({
  id: 'report',
  label: 'Client report',
  contextBlocks: ['brand', 'latest_snapshot', 'pillars', 'recent_concepts'],
  inputSchema,
  schema: reportResponseSchema,
  maxTokens: 16000,

  preflight(_input, ctx) {
    if (!ctx.latestSnapshot) {
      throw new HttpError(
        409,
        'No snapshot has been ingested, so there is nothing to report on.',
        'Upload an Apify export on the Data screen, then run Refresh.',
      );
    }
    const age = daysSince(ctx.latestSnapshot.taken_on);
    if (age !== null && age > MAX_SNAPSHOT_AGE_DAYS) {
      throw new HttpError(
        409,
        `The latest snapshot is ${age} days old (taken ${ctx.latestSnapshot.taken_on}). A client report needs data no older than ${MAX_SNAPSHOT_AGE_DAYS} days.`,
        'Ingest a fresh Apify export on the Data screen, run Refresh, then generate the report.',
      );
    }
  },

  buildPrompt(input, ctx) {
    return [
      `## Task`,
      `Write the monthly client report for ${input.month}, in Arabic, as markdown in body_md.`,
      `Latest snapshot available: ${ctx.latestSnapshot?.taken_on ?? 'none'}.`,
      `Structure: ما حدث هذا الشهر · ما نجح ولماذا · ما لم ينجح · التوصية للشهر القادم.`,
      `Every number you write must be copied from <latest_snapshot>. If a number the section wants is absent, say so in words instead of estimating.`,
      `Address Ahmad directly and professionally. No emoji. No posting schedule.`,
      ``,
      `## Response schema`,
      REPORT_SCHEMA_TEXT,
    ].join('\n');
  },

  async persist(result, input) {
    const db = supabaseAdmin();
    const { data, error } = await db
      .from('reports')
      .insert({ month: input.month, body_md: result.body_md, status: 'draft' })
      .select('*')
      .single();

    if (error) throw new Error(`Could not save report: ${error.message}`);
    return { report: data as ReportRow };
  },
});
