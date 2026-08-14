import type { z } from 'zod';
import { HttpError } from '@/lib/auth';
import { loadAgentContext, renderContextBlocks, type AgentContext } from '@/lib/agent/context';
import { runAgentJson, type Quality } from '@/lib/agent/client';

/**
 * A feature is one thing the agent can be asked to do. Adding a capability =
 * one file in this folder + one entry in registry.ts (+ a nav entry if it needs
 * its own screen). See README → "Adding a feature".
 */
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
  /** Throw HttpError here to refuse before spending a model call. */
  preflight?(input: TInput, ctx: AgentContext): void;
  buildPrompt(input: TInput, ctx: AgentContext): string;
  /** Writes the validated result to Postgres. Returns whatever the UI needs. */
  persist(result: TResult, input: TInput, ctx: AgentContext): Promise<unknown>;
}

export interface FeatureRunOutcome {
  feature: string;
  model: string;
  attempts: number;
  usage: { input_tokens: number; output_tokens: number };
  result: unknown;
  persisted: unknown;
}

/** Type-erased handle so the registry can hold features with different shapes. */
export interface RunnableFeature {
  id: string;
  label: string;
  contextBlocks: readonly string[];
  run(rawInput: unknown, quality: Quality): Promise<FeatureRunOutcome>;
}

export function defineFeature<TInput, TResult>(
  feature: AgentFeature<TInput, TResult>,
): RunnableFeature {
  return {
    id: feature.id,
    label: feature.label,
    contextBlocks: feature.contextBlocks,
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

      const ctx = await loadAgentContext();
      feature.preflight?.(parsedInput.data, ctx);

      const userMessage = [
        renderContextBlocks(ctx),
        '',
        feature.buildPrompt(parsedInput.data, ctx),
      ].join('\n');

      const run = await runAgentJson({
        userMessage,
        schema: feature.schema,
        quality,
        maxTokens: feature.maxTokens,
      });

      const persisted = await feature.persist(run.value, parsedInput.data, ctx);

      return {
        feature: feature.id,
        model: run.model,
        attempts: run.attempts,
        usage: run.usage,
        result: run.value,
        persisted,
      };
    },
  };
}
