import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { MissingEnvError } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { readQuality } from '@/lib/prefs.server';
import { loadAgentContext, renderContextBlocks } from '@/lib/agent/context';
import { runAgentJson } from '@/lib/agent/client';
import { runLaw, type LawReport, type LawResult } from '@/lib/brain/law';
import { retrieveCanon } from '@/lib/brain/canon/retrieve';
import { reconcile, runJudge, type JudgeVerdict } from '@/lib/brain/judge';
import type { Grounding } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const SUBJECT_TYPES = ['concept', 'storyboard', 'caption', 'freeform'] as const;
type SubjectType = (typeof SUBJECT_TYPES)[number];

const bodySchema = z.object({
  input_text: z.string().trim().min(1).max(20000),
  subject_type: z.enum(SUBJECT_TYPES).default('freeform'),
  subject_ref: z.string().uuid().nullish(),
  /**
   * 'check'   — verify the text exactly as pasted. Law is the whole verdict;
   *             the Judge is additive.
   * 'rewrite' — generate the compliant Arabic and verify THAT, with the same
   *             Law and the same Judge. The pasted text is never patched.
   */
  action: z.enum(['check', 'rewrite']).default('check'),
});

const CANON_QUERY = 'brand voice, colour usage, social copy standards';
const CANON_TAGS = ['voice', 'color', 'social', 'arabic-specific'] as const;

/* --------------------------------------------------------------- judging -- */

type JudgeStatus = 'ruled' | 'unavailable';

interface ModelFailure {
  reason: string;
  hint: string | null;
}

/** Why a model call produced no ruling, phrased as the operator's next move. */
function describeModelFailure(err: unknown): ModelFailure {
  if (err instanceof MissingEnvError) {
    return {
      reason: `No model provider key is configured (${err.key}).`,
      hint: 'Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env.local and run the check again.',
    };
  }
  if (err instanceof HttpError) return { reason: err.message, hint: err.hint ?? null };
  return {
    reason: err instanceof Error ? err.message : 'The Judge call failed.',
    hint: null,
  };
}

/** The same summary shape the Judge reads, for prompts that quote Law back. */
function lawSummary(report: LawReport): string {
  return report.results
    .map(
      (r) =>
        `- [${r.passed ? 'PASS' : r.severity === 'warning' ? 'WARN' : 'VIOLATION'}] ${r.check}: ${r.evidence}`,
    )
    .join('\n');
}

interface CheckPayload {
  id: string;
  created_at: string;
  passed: boolean;
  law_results: LawResult[];
  judge_status: JudgeStatus;
  judge_verdict: JudgeVerdict | null;
  judge_unavailable: ModelFailure | null;
  needs_human: boolean;
  canon: { chunkId: string; title: string; method: string }[];
  model: string | null;
}

/**
 * Law has already run and is final. This adds the Judge on top, records the
 * check, and returns what the screen renders.
 *
 * The Judge is allowed to be unreachable; Law is not. A text that violates Law
 * fails whether or not a model answers, which is exactly why the failing leg of
 * this screen is deterministic — no key, no credit and no network still produce
 * the same violations with the same evidence. When the Judge cannot rule we say
 * so and record it: "no ruling" is not a pass, and it is not a fail either, so
 * `passed` stays false and `needs_human` is set rather than inventing a verdict.
 */
async function verifyAndRecord(args: {
  text: string;
  law: LawReport;
  blocks: string;
  task: string;
  subjectType: SubjectType;
  subjectRef: string | null;
}): Promise<CheckPayload> {
  const canon = await retrieveCanon(CANON_QUERY, { tags: CANON_TAGS, k: 5 });

  let verdict: JudgeVerdict | null = null;
  let model: string | null = null;
  let unavailable: ModelFailure | null = null;

  try {
    const judged = await runJudge({
      candidate: args.text,
      lawReport: args.law,
      canon,
      brandBlocks: args.blocks,
      task: args.task,
    });
    // Law violations survive the Judge — `reconcile` re-fails anything the
    // model tried to wave through.
    verdict = reconcile(judged.verdict, args.law);
    model = judged.model;
  } catch (err) {
    unavailable = describeModelFailure(err);
  }

  const passed =
    verdict !== null && verdict.verdict === 'pass' && args.law.violations.length === 0;

  const { data, error } = await supabaseAdmin()
    .from('compliance_checks')
    .insert({
      subject_type: args.subjectType,
      subject_ref: args.subjectRef,
      input_text: args.text,
      law_results: args.law.results,
      // The column is NOT NULL, so a check with no ruling records the absence
      // itself. It never stores a stand-in verdict with an invented score.
      judge_verdict:
        verdict ?? {
          status: 'unavailable',
          reason: unavailable?.reason ?? 'The Judge did not rule.',
        },
      passed,
    })
    .select('id, created_at')
    .single();

  if (error) throw new Error(`Could not record the check: ${error.message}`);

  const row = data as { id: string; created_at: string };

  return {
    id: row.id,
    created_at: row.created_at,
    passed,
    law_results: args.law.results,
    judge_status: verdict === null ? 'unavailable' : 'ruled',
    judge_verdict: verdict,
    judge_unavailable: unavailable,
    needs_human: verdict === null || verdict.needs_human,
    canon: canon.map((c) => ({ chunkId: c.chunkId, title: c.documentTitle, method: c.method })),
    model,
  };
}

/* --------------------------------------------------------------- rewrite -- */

const rewriteSchema = z.object({
  /** The compliant Arabic. This, not the pasted English, is what gets checked. */
  arabic: z.string().min(1),
  register_note: z.string().min(1),
  /** Swatch NAMES referenced, never hex values. Verified by Law. */
  palette_refs: z.array(z.string()),
  dropped_claims: z.array(
    z.object({
      claim: z.string().min(1),
      treatment: z.enum(['dropped', 'hedged']),
      reason: z.string().min(1),
    }),
  ),
  grounding: z.enum(['data', 'hypothesis']),
});

type Rewrite = z.infer<typeof rewriteSchema>;

const REWRITE_SCHEMA_TEXT = `{
  "arabic": "string — the rewrite, in Arabic",
  "register_note": "string — how you matched the register, and what you could not match",
  "palette_refs": ["swatch name"],
  "dropped_claims": [{"claim": "string", "treatment": "dropped|hedged", "reason": "string"}],
  "grounding": "data|hypothesis"
}`;

/**
 * The rewriter's prompt. It is a generator, so everything it produces is
 * verified afterwards by the same Law and the same Judge that failed the input
 * — this prompt is where the *intent* is stated, not where compliance is
 * enforced. The number rule is written out at length because it is the one a
 * fluent model gets wrong most confidently: asked to lose "340% more
 * engagement", the natural move is to write a smaller, safer-sounding figure,
 * which is a brand-new invented claim wearing modesty as a disguise.
 */
const REWRITE_SYSTEM = `You are the Arabic rewriter inside ThinkQuality Studio, writing for Think
Quality Academy (Ahmad Kahtan, Amman, Jordan).

You are given an English draft that failed a compliance check, the deterministic
Law findings against it, and the brand's own data. Your job is to say what the
draft was trying to say — in Arabic, in Ahmad's register, and only the parts of
it the data actually supports.

Register:
- The <brand> block holds voice_examples: Ahmad's real captions. They are the
  target. Match their dialect (Levantine, not formal MSA), their sentence
  length, their punctuation habits and their emoji density.
- Do NOT carry the English draft's cadence across. Marketing-English translated
  clause by clause is the exact failure this rewrite exists to undo.
- Write in Arabic. A product name, handle or URL may stay in Latin script.

Numbers — the rule that matters most:
- A number may appear in your Arabic ONLY if that exact number appears in the
  data blocks you were given. Use it as it appears there.
- An unsupported figure in the draft has NO correct Arabic equivalent. Drop the
  claim, or hedge it into a sentence carrying no figure at all.
- NEVER substitute a different number, a rounder number, a range, a percentage,
  or a vaguer quantity for one you removed. A replacement figure is a new
  invented claim, and it is worse than the one you took out because it looks
  careful.
- Every claim you dropped or hedged goes in dropped_claims with its reason.

Colour:
- Refer to a colour only by its swatch NAME from the brand palette. Never write
  a hex value. List every name you used in palette_refs; if you named none,
  return an empty array.

Also:
- Add no facts about the audience, the client or performance that are not in the
  data you were given.
- No publishing or scheduling instructions. Humans post.
- grounding is "data" only when every statement in your Arabic traces to the
  provided blocks. Otherwise "hypothesis".

Return ONLY valid JSON matching the schema in the user message. No markdown, no
text before or after the JSON.`;

/* ------------------------------------------------------------------ POST -- */

/**
 * POST /api/compliance — check any text against the brand and the brain.
 *
 * This is the one place the brain runs without a generator in front of it:
 * nothing is written, the input is whatever a human pasted. Law runs first and
 * deterministically; the Judge then reads the same evidence and rules on it.
 * Law violations survive the Judge — `reconcile` re-fails anything the model
 * tried to wave through.
 *
 * `action: "rewrite"` is the second leg. It does not patch the pasted text: it
 * generates the compliant Arabic and then puts THAT through the same Law, the
 * same Judge and the same reconcile, and records it as its own check. There is
 * no retry — if the rewrite fails review, the failure is the answer and the
 * screen shows it.
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

    const { input_text, subject_type, subject_ref, action } = parsed.data;

    const ctx = await loadAgentContext();
    const blocks = renderContextBlocks(ctx);
    const swatches = ctx.brand.palette?.swatches ?? null;
    const voiceExamples = ctx.brand.voice_examples.map((v) => v.text);

    // Law on the pasted text. Pure, offline, and identical on both legs — this
    // is the report the failing leg of the demo rests on, so nothing about it
    // is allowed to depend on a model answering.
    const sourceLaw = runLaw({
      text: input_text,
      context: blocks,
      swatches,
      voiceExamples,
    });

    if (action === 'check') {
      const payload = await verifyAndRecord({
        text: input_text,
        law: sourceLaw,
        blocks,
        task: `${subject_type} submitted for compliance review`,
        subjectType: subject_type,
        subjectRef: subject_ref ?? null,
      });

      return NextResponse.json({ action, ...payload });
    }

    /* ------------------------------------------------------- rewrite leg -- */

    const swatchNames = Object.keys(swatches ?? {});
    const quality = await readQuality();

    const userMessage = [
      blocks,
      '',
      '<source_draft>',
      input_text,
      '</source_draft>',
      '',
      '<law_findings_on_source>',
      lawSummary(sourceLaw) || '(no checks applied)',
      '</law_findings_on_source>',
      '',
      '## Task',
      `Rewrite the <source_draft>, submitted as a ${subject_type}, into Arabic.`,
      'Resolve every VIOLATION listed above. A violation about a number is',
      'resolved by removing or hedging the claim — never by replacing the number.',
      'Your Arabic goes straight back through these same deterministic checks and',
      'then to the Judge. A hex value, or a figure that is not in the data, fails',
      'again — and that second failure is shown to the operator, not retried away.',
      swatchNames.length > 0
        ? `Palette swatch names you may reference: ${swatchNames.join(', ')}.`
        : 'The brand has no palette recorded, so name no colour and return an empty palette_refs.',
      voiceExamples.length > 0
        ? `<brand>.voice_examples holds ${voiceExamples.length} of Ahmad's real captions. That is the register target.`
        : '<brand>.voice_examples is empty, so the register cannot be matched against anything real. Write plainly and say so in register_note.',
      '',
      '## Response schema',
      REWRITE_SCHEMA_TEXT,
    ].join('\n');

    let rewrite: Rewrite;
    let rewriteModel: string;
    try {
      const run = await runAgentJson({
        userMessage,
        schema: rewriteSchema,
        quality,
        system: REWRITE_SYSTEM,
      });
      rewrite = run.value;
      rewriteModel = run.model;
    } catch (err) {
      if (err instanceof MissingEnvError) {
        throw new HttpError(
          503,
          `The rewrite needs a model, and no provider key is configured (${err.key}).`,
          'Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env.local. The Law findings above needed no key — they already ran.',
        );
      }
      throw err;
    }

    // The generated Arabic is treated exactly like any other candidate: it gets
    // the palette-name check too, because a rewrite that names a swatch the
    // brand does not own is a violation whoever wrote it.
    const rewriteLaw = runLaw({
      text: rewrite.arabic,
      context: blocks,
      swatches,
      voiceExamples,
      paletteReferences: rewrite.palette_refs,
    });

    const check = await verifyAndRecord({
      text: rewrite.arabic,
      law: rewriteLaw,
      blocks,
      task: `${subject_type} rewritten into Arabic from an English draft`,
      subjectType: subject_type,
      subjectRef: subject_ref ?? null,
    });

    // Swatch names resolved to the hex the brand actually records. An
    // unresolved name keeps its null — the screen renders that as an em-dash,
    // and Law has already failed it by name.
    const paletteUsed = rewrite.palette_refs.map((name) => {
      const entry = Object.entries(swatches ?? {}).find(
        ([key]) => key.trim().toLowerCase() === name.trim().toLowerCase(),
      );
      return { name, hex: entry?.[1] ?? null };
    });

    const grounding: Grounding = rewrite.grounding;

    return NextResponse.json({
      action,
      source: {
        text: input_text,
        law_results: sourceLaw.results,
      },
      rewrite: {
        arabic: rewrite.arabic,
        register_note: rewrite.register_note,
        dropped_claims: rewrite.dropped_claims,
        grounding,
        palette_used: paletteUsed,
        model: rewriteModel,
      },
      check,
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
      // law_results rides along so the history rows can be labelled with the
      // same three states as a live check: a Law violation is a fail whatever
      // the Judge did, and a row whose Judge never ruled says so instead of
      // borrowing the colour of a verdict nobody gave.
      .select('id, subject_type, input_text, passed, law_results, judge_verdict, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw new Error(`Could not read checks: ${error.message}`);
    return NextResponse.json({ checks: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
