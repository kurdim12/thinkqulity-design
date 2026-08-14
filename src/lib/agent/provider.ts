import { optionalEnv, hasEnv } from '@/lib/env';
import type { Quality } from '@/lib/prefs';

/**
 * Two ways to reach a model:
 *
 *   anthropic  — the first-party SDK. Adaptive thinking, effort, streaming.
 *   openrouter — one key, many vendors. The true default — no second billing
 *                relationship needed to try a different frontier model.
 *
 * Resolution order, written out so it never has to be reverse-engineered from
 * the code below:
 *
 *   1. AI_PROVIDER=anthropic or AI_PROVIDER=openrouter, if set explicitly —
 *      always wins, whatever keys are present.
 *   2. Otherwise, anthropic — but ONLY if ANTHROPIC_API_KEY is present AND
 *      OPENROUTER_API_KEY is NOT.
 *   3. Otherwise, openrouter. This is the default: no explicit provider, no
 *      keys at all, or both keys present — OpenRouter is what this app is
 *      built around, so absence of configuration resolves to it rather than
 *      to Anthropic.
 */
export type Provider = 'anthropic' | 'openrouter';

export function resolveProvider(): Provider {
  const explicit = optionalEnv('AI_PROVIDER')?.toLowerCase();
  if (explicit === 'openrouter' || explicit === 'anthropic') return explicit;
  if (hasEnv('ANTHROPIC_API_KEY') && !hasEnv('OPENROUTER_API_KEY')) return 'anthropic';
  return 'openrouter';
}

/**
 * Defaults on OpenRouter: openai/gpt-5.6-luna (standard), qwen/qwen3.7-plus
 * (high).
 *
 * luna is the same lineage as this app's previous default (the gpt-5.6
 * family) at roughly 1/10th the output price ($0.60 vs $6.00 per million
 * output tokens for gpt-5.6-terra) — the schema discipline and structural
 * consistency that lineage was chosen for should carry over largely intact.
 *
 * qwen3.7-plus is the high tier because Qwen models lead the open Arabic
 * benchmarks (OALL, HELM Arabic), and it costs roughly 23x less on output
 * than gpt-5.6-sol ($1.28 vs $30.00 per million). To be stated plainly: no
 * clean Arabic head-to-head exists between the closed frontier models
 * (GPT/Claude/Gemini) and Qwen. This is a hypothesis about Arabic quality,
 * not a finding. `npm run bakeoff` exists to settle it — it runs the same
 * brief through several models and grades the real Arabic output, blind.
 *
 * Switching provider or model is one env line, deliberately. Any model id
 * from https://openrouter.ai/models works, including anthropic/claude-opus-5,
 * google/gemini-3.7-flash and deepseek/deepseek-v4-pro-0813.
 *
 * Published prices, USD per MILLION tokens, read 2026-08-15 from
 * https://openrouter.ai/api/v1/models:
 *
 *   openai/gpt-5.6-luna            in $0.10   out $0.60   ctx 1,050,000
 *   qwen/qwen3.7-plus              in $0.32   out $1.28   ctx 1,000,000
 *   google/gemini-3.7-flash        in $0.38   out $1.88   ctx 1,048,576
 *   deepseek/deepseek-v4-pro-0813  in $0.43   out $0.87   ctx 1,048,576
 *   qwen/qwen3.7-flash             in $0.03   out $0.13   ctx 1,000,000
 *   openai/gpt-5.6-terra           in $1.00   out $6.00
 *   openai/gpt-5.6-sol             in $5.00   out $30.00
 *   anthropic/claude-sonnet-5      in $2.00   out $10.00
 *   anthropic/claude-opus-5        in $5.00   out $25.00
 */
const DEFAULT_MODELS: Record<Provider, Record<Quality, string>> = {
  anthropic: {
    standard: 'claude-sonnet-5',
    high: 'claude-opus-5',
  },
  openrouter: {
    standard: 'openai/gpt-5.6-luna',
    high: 'qwen/qwen3.7-plus',
  },
};

export function modelFor(quality: Quality, provider: Provider = resolveProvider()): string {
  const override =
    quality === 'high'
      ? optionalEnv('AI_MODEL_QUALITY') ?? optionalEnv('ANTHROPIC_MODEL_QUALITY')
      : optionalEnv('AI_MODEL_STANDARD') ?? optionalEnv('ANTHROPIC_MODEL_STANDARD');

  return override ?? DEFAULT_MODELS[provider][quality];
}

/** Thinking depth. Both providers understand these level names. */
export function effortFor(quality: Quality): 'medium' | 'high' {
  return quality === 'high' ? 'high' : 'medium';
}

export function providerKeyName(provider: Provider): 'ANTHROPIC_API_KEY' | 'OPENROUTER_API_KEY' {
  return provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
}
