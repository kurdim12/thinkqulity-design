import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { readQuality } from '@/lib/prefs.server';
import { runAgentJson, modelFor } from '@/lib/agent/client';
import { computeFor, computeStats } from '@/lib/board/compute';
import { loadAgentContext } from '@/lib/agent/context';
import type { PostRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Rough published rates, USD per million tokens. Null model → null estimate. */
const RATES: Record<string, { in: number; out: number }> = {
  'openai/gpt-5.6-terra': { in: 1, out: 6 },
  'openai/gpt-5.6-sol': { in: 5, out: 30 },
  'anthropic/claude-sonnet-5': { in: 2, out: 10 },
  'anthropic/claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5': { in: 5, out: 25 },
  'google/gemini-3.7-flash': { in: 0.375, out: 1.875 },
};

const TOKENS_IN_PER_POST = 700;
const TOKENS_OUT_PER_POST = 130;

function estimateUsd(model: string, posts: number): number | null {
  const rate = RATES[model];
  if (!rate) return null;
  const cost =
    (posts * TOKENS_IN_PER_POST * rate.in) / 1_000_000 +
    (posts * TOKENS_OUT_PER_POST * rate.out) / 1_000_000;
  return Number(cost.toFixed(3));
}

const analysisSchema = z.object({
  warnings: z.array(z.string()),
  analyses: z
    .array(
      z.object({
        post_id: z.string(),
        cluster_label: z.string().min(1),
        explanation_ar: z.string().min(1),
        grounding: z.enum(['data', 'hypothesis']),
      }),
    )
    .min(1),
});

async function progress() {
  const db = supabaseAdmin();
  const [{ count: total }, { count: analyzed }] = await Promise.all([
    db.from('posts').select('id', { count: 'exact', head: true }),
    db.from('post_analyses').select('id', { count: 'exact', head: true }),
  ]);
  return { total: total ?? 0, analyzed: analyzed ?? 0, remaining: (total ?? 0) - (analyzed ?? 0) };
}

export async function GET() {
  try {
    await requireOperator();
    const quality = await readQuality();
    const p = await progress();
    return NextResponse.json({ ...p, estimate_usd: estimateUsd(modelFor(quality), p.remaining) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/board/analyze — analyse the next chunk of unanalysed posts.
 *
 * Chunked and resumable on purpose: 320 posts will not fit in one request, and
 * a failure halfway through must not lose the work already done. Call it until
 * `remaining` reaches zero.
 *
 * The division of labour is the same as everywhere else in this app: the
 * comparatives are computed here in code from real rows, and the model is only
 * ever asked to name the pattern. It is explicitly forbidden from telling a
 * causal story about a single post — with n=1 that is astrology, not analysis.
 */
export async function POST(request: Request) {
  try {
    await requireOperator();
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { limit?: unknown };
    const limit =
      typeof body.limit === 'number' && body.limit > 0 && body.limit <= 50
        ? Math.floor(body.limit)
        : 25;

    const quality = await readQuality();
    const db = supabaseAdmin();

    const [{ data: postRows, error }, { data: doneRows }] = await Promise.all([
      db.from('posts').select('*').order('engagement', { ascending: false }).limit(2000),
      db.from('post_analyses').select('post_id'),
    ]);
    if (error) throw new Error(`Could not read posts: ${error.message}`);

    const allPosts = (postRows as PostRow[] | null) ?? [];
    const done = new Set(((doneRows as { post_id: string }[] | null) ?? []).map((r) => r.post_id));
    const pending = allPosts.filter((p) => !done.has(p.id)).slice(0, limit);

    if (pending.length === 0) {
      const state = await progress();
      // `analyzed` is this batch's count; `analyzed_total` is the running total.
      return NextResponse.json({
        analyzed: 0,
        failed: 0,
        remaining: state.remaining,
        total: state.total,
        analyzed_total: state.analyzed,
      });
    }

    const stats = computeStats(allPosts);
    const ctx = await loadAgentContext();

    const rows = pending.map((post) => ({
      post,
      computed: computeFor(post, allPosts, stats),
    }));

    const listing = rows
      .map(
        ({ post, computed }) =>
          `id: ${post.id}\naccount: ${post.account} · format: ${post.media_type ?? 'unknown'}\n` +
          `engagement: ${post.engagement} (×${computed.vs_account_avg} account avg, ×${computed.vs_format_avg} format avg, P${computed.percentile})\n` +
          `caption: ${post.caption ? post.caption.slice(0, 400) : '(none)'}`,
      )
      .join('\n\n---\n\n');

    const run = await runAgentJson({
      quality,
      maxTokens: 16000,
      schema: analysisSchema,
      userMessage: [
        '<posts_to_analyse>',
        listing,
        '</posts_to_analyse>',
        '',
        '## Task',
        'For each post, give a cluster_label and a short explanation, in Arabic.',
        '',
        'Rules specific to this task:',
        '- cluster_label groups the post with others like it by subject and angle (e.g. «سؤال سلوكي», «اقتباس شعري»). Reuse labels across posts — that is the point of a cluster.',
        '- explanation_ar explains the PATTERN the post belongs to, not the post. A causal story about one post is forbidden: with a single data point you cannot know why it performed, and saying so anyway is exactly the fabrication this app exists to prevent.',
        '- Refer to the cluster when explaining: "منشورات هذا النمط تميل إلى…".',
        '- Set grounding to "data" only when the comparatives above support the claim. Otherwise "hypothesis".',
        '- Do not restate the engagement numbers; they are already computed and displayed.',
        '- Return one entry per post id, using the ids exactly as given.',
        '',
        '## Response schema',
        '{"warnings":["string"],"analyses":[{"post_id":"string","cluster_label":"string","explanation_ar":"string","grounding":"data|hypothesis"}]}',
      ].join('\n'),
    });

    const byId = new Map(rows.map((r) => [r.post.id, r.computed]));
    const inserts = run.value.analyses
      .filter((a) => byId.has(a.post_id))
      .map((a) => ({
        post_id: a.post_id,
        computed: byId.get(a.post_id) as unknown as Record<string, number | null>,
        cluster_label: a.cluster_label,
        explanation: a.explanation_ar,
        grounding: a.grounding,
        model: run.model,
      }));

    if (inserts.length > 0) {
      const { error: insertError } = await db
        .from('post_analyses')
        .upsert(inserts, { onConflict: 'post_id' });
      if (insertError) throw new Error(`Could not save analyses: ${insertError.message}`);
    }

    const state = await progress();
    return NextResponse.json({
      analyzed: inserts.length,
      failed: pending.length - inserts.length,
      warnings: run.value.warnings,
      remaining: state.remaining,
      total: state.total,
      analyzed_total: state.analyzed,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
