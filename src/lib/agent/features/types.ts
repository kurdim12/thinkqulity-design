import type { z } from 'zod';
import { HttpError } from '@/lib/auth';
import { loadAgentContext, renderContextBlocks, type AgentContext } from '@/lib/agent/context';
import { runAgentJson, type Quality } from '@/lib/agent/client';
import { runLaw, type FrameLike, type GuidelineSection, type LawReport } from '@/lib/brain/law';
import { retrieveCanon, type CanonHit } from '@/lib/brain/canon/retrieve';
import { reconcile, runJudge, type JudgeVerdict } from '@/lib/brain/judge';

/**
 * A feature is one thing the agent can be asked to do. Adding a capability =
 * one file in this folder + one entry in registry.ts (+ a nav entry if it needs
 * its own screen). See README → "Adding a feature".
 */

/**
 * Opting a feature into the Design Brain. The agent generates; the brain
 * constrains and vetoes. Omit this and the feature behaves exactly as it did
 * in v1 — every existing feature keeps working untouched.
 */
export interface BrainConfig<TInput, TResult> {
  /** Everything the output says, flattened so Law and Judge can read it. */
  toText(result: TResult): string;
  /** What this is, in the Judge's words: "post concept", "brand guideline". */
  task: string;
  paletteReferences?(result: TResult): (string | null | undefined)[];
  frames?(result: TResult): FrameLike[];
  guidelineSections?(result: TResult): GuidelineSection[];
  /** What to look up in Canon. Structure and principle only. */
  canonQuery?(input: TInput): string;
  canonTags?: readonly string[];
}

export interface BrainReport {
  law: LawReport;
  judge: JudgeVerdict;
  canon: { chunkId: string; documentTitle: string; score: number; method: string }[];
  attempts: number;
  /** True when the second attempt still failed. Surfaces as "needs review". */
  needsHuman: boolean;
}

export interface AgentFeature<TInput, TResult> {
  id: string;
  label: string;
  /** Which context blocks this feature relies on — documentation for humans. */
  contextBlocks: readonly string[];
  /** Input is parsed from an untrusted request body, so the schema's *input*
   *  side is `unknown` — this is what lets a field carry a zod default. */
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  schema: z.ZodType<TResult>;
  maxTokens?: number;
  brain?: BrainConfig<TInput, TResult>;
  /** Throw HttpError here to refuse before spending a model call. */
  preflight?(input: TInput, ctx: AgentContext): void;
  buildPrompt(input: TInput, ctx: AgentContext): string;
  /** Writes the validated result to Postgres. Returns whatever the UI needs. */
  persist(
    result: TResult,
    input: TInput,
    ctx: AgentContext,
    brain?: BrainReport,
  ): Promise<unknown>;
}

export interface FeatureRunOutcome {
  feature: string;
  model: string;
  attempts: number;
  usage: { input_tokens: number; output_tokens: number };
  result: unknown;
  persisted: unknown;
  brain?: BrainReport;
}

/** Type-erased handle so the registry can hold features with different shapes. */
export interface RunnableFeature {
  id: string;
  label: string;
  contextBlocks: readonly string[];
  hasBrain: boolean;
  run(rawInput: unknown, quality: Quality): Promise<FeatureRunOutcome>;
}

export function defineFeature<TInput, TResult>(
  feature: AgentFeature<TInput, TResult>,
): RunnableFeature {
  return {
    id: feature.id,
    label: feature.label,
    contextBlocks: feature.contextBlocks,
    hasBrain: Boolean(feature.brain),

    async run(rawInput, quality) {
      const parsedInput = feature.inputSchema.safeParse(rawInput ?? {});
      if (!parsedInput.success) {
        throw new HttpError(
          400,
          'Invalid request body.',
          parsedInput.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
        );
      }

      const input = parsedInput.data;
      const ctx = await loadAgentContext();
      feature.preflight?.(input, ctx);

      const blocks = renderContextBlocks(ctx);
      const baseMessage = [blocks, '', feature.buildPrompt(input, ctx)].join('\n');

      const run = await runAgentJson({
        userMessage: baseMessage,
        schema: feature.schema,
        quality,
        maxTokens: feature.maxTokens,
      });

      const brainCfg = feature.brain;
      if (!brainCfg) {
        const persisted = await feature.persist(run.value, input, ctx);
        return {
          feature: feature.id,
          model: run.model,
          attempts: run.attempts,
          usage: run.usage,
          result: run.value,
          persisted,
        };
      }

      /* ------------------------------------------------------------ brain -- */

      const canon: CanonHit[] = brainCfg.canonQuery
        ? await retrieveCanon(brainCfg.canonQuery(input), { tags: brainCfg.canonTags, k: 6 })
        : [];

      const voiceExamples = ctx.brand.voice_examples.map((v) => v.text);
      const swatches = ctx.brand.palette?.swatches ?? null;

      const review = async (candidate: TResult) => {
        const text = brainCfg.toText(candidate);
        const law = runLaw({
          text,
          context: blocks,
          swatches,
          voiceExamples,
          paletteReferences: brainCfg.paletteReferences?.(candidate),
          frames: brainCfg.frames?.(candidate),
          guidelineSections: brainCfg.guidelineSections?.(candidate),
        });
        const judged = await runJudge({
          candidate: text,
          lawReport: law,
          canon,
          brandBlocks: blocks,
          task: brainCfg.task,
        });
        return { text, law, verdict: reconcile(judged.verdict, law), usage: judged.usage };
      };

      let value = run.value;
      let attempts = 1;
      let outcome = await review(value);
      let usage = {
        input_tokens: run.usage.input_tokens + outcome.usage.input_tokens,
        output_tokens: run.usage.output_tokens + outcome.usage.output_tokens,
      };

      // Exactly one retry. Looping on a model that keeps failing burns money
      // and converges on nothing; a second failure is a human's problem.
      if (outcome.verdict.verdict === 'fail') {
        const complaint = outcome.verdict.violations
          .map((v) => `- ${v.rule} (${v.source}): ${v.evidence}`)
          .join('\n');
        const fixes = outcome.verdict.fixes.map((f) => `- ${f}`).join('\n');

        const retryMessage = [
          baseMessage,
          '',
          '## Your previous attempt was rejected in review',
          'Violations:',
          complaint || '- (none itemised)',
          fixes ? `\nRequested fixes:\n${fixes}` : '',
          '',
          'Rewrite it so every violation above is resolved. Do not restate the',
          'rejected output. Return only the corrected JSON object.',
        ].join('\n');

        const retry = await runAgentJson({
          userMessage: retryMessage,
          schema: feature.schema,
          quality,
          maxTokens: feature.maxTokens,
        });

        attempts = 2;
        value = retry.value;
        outcome = await review(value);
        usage = {
          input_tokens: usage.input_tokens + retry.usage.input_tokens + outcome.usage.input_tokens,
          output_tokens:
            usage.output_tokens + retry.usage.output_tokens + outcome.usage.output_tokens,
        };
      }

      const brain: BrainReport = {
        law: outcome.law,
        judge: outcome.verdict,
        canon: canon.map((c) => ({
          chunkId: c.chunkId,
          documentTitle: c.documentTitle,
          score: Number(c.score.toFixed(3)),
          method: c.method,
        })),
        attempts,
        // A second failure is stored, flagged, and surfaced — never silently shipped.
        needsHuman: outcome.verdict.verdict === 'fail' || outcome.verdict.needs_human,
      };

      const persisted = await feature.persist(value, input, ctx, brain);

      return {
        feature: feature.id,
        model: run.model,
        attempts,
        usage,
        result: value,
        persisted,
        brain,
      };
    },
  };
}
