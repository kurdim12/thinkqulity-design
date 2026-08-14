import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadAgentContext, renderContextBlocks } from '@/lib/agent/context';
import { runLaw } from '@/lib/brain/law';
import { retrieveCanon } from '@/lib/brain/canon/retrieve';
import { reconcile, runJudge } from '@/lib/brain/judge';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const bodySchema = z.object({
  input_text: z.string().trim().min(1).max(20000),
  subject_type: z.enum(['concept', 'storyboard', 'caption', 'freeform']).default('freeform'),
  subject_ref: z.string().uuid().nullish(),
});

/**
 * POST /api/compliance — check any text against the brand and the brain.
 *
 * This is the one place the brain runs without a generator in front of it:
 * nothing is written, the input is whatever a human pasted. Law runs first and
 * deterministically; the Judge then reads the same evidence and rules on it.
 * Law violations survive the Judge — `reconcile` re-fails anything the model
 * tried to wave through.
 */
export async function POST(request: Request) {
  try {
    await requireOperator();

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid request.',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }

    const { input_text, subject_type, subject_ref } = parsed.data;

    const ctx = await loadAgentContext();
    const blocks = renderContextBlocks(ctx);

    const law = runLaw({
      text: input_text,
      context: blocks,
      swatches: ctx.brand.palette?.swatches ?? null,
      voiceExamples: ctx.brand.voice_examples.map((v) => v.text),
    });

    const canon = await retrieveCanon('brand voice, colour usage, social copy standards', {
      tags: ['voice', 'color', 'social', 'arabic-specific'],
      k: 5,
    });

    const judged = await runJudge({
      candidate: input_text,
      lawReport: law,
      canon,
      brandBlocks: blocks,
      task: `${subject_type} submitted for compliance review`,
    });

    const verdict = reconcile(judged.verdict, law);
    const passed = verdict.verdict === 'pass' && law.violations.length === 0;

    const { data, error } = await supabaseAdmin()
      .from('compliance_checks')
      .insert({
        subject_type,
        subject_ref: subject_ref ?? null,
        input_text,
        law_results: law.results,
        judge_verdict: verdict,
        passed,
      })
      .select('id, created_at')
      .single();

    if (error) throw new Error(`Could not record the check: ${error.message}`);

    const row = data as { id: string; created_at: string };

    return NextResponse.json({
      id: row.id,
      created_at: row.created_at,
      passed,
      law_results: law.results,
      judge_verdict: verdict,
      canon: canon.map((c) => ({ chunkId: c.chunkId, title: c.documentTitle, method: c.method })),
      model: judged.model,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET() {
  try {
    await requireOperator();
    const { data, error } = await supabaseAdmin()
      .from('compliance_checks')
      .select('id, subject_type, input_text, passed, judge_verdict, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw new Error(`Could not read checks: ${error.message}`);
    return NextResponse.json({ checks: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
