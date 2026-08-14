import { optionalEnv, hasEnv } from '@/lib/env';
import type { Quality } from '@/lib/prefs';

/**
 * Two ways to reach a model:
 *
 *   anthropic  — the first-party SDK. Adaptive thinking, effort, streaming.
 *   openrouter — one key, many vendors. Useful for trying a different frontier
 *                model without a second billing relationship.
 *
 * Resolution order: explicit AI_PROVIDER, else whichever key is present,
 * preferring OpenRouter when both are (you only set it deliberately).
 */
export type Provider = 'anthropic' | 'openrouter';

export function resolveProvider(): Provider {
  const explicit = optionalEnv('AI_PROVIDER')?.toLowerCase();
  if (explicit === 'openrouter' || explicit === 'anthropic') return explicit;
  if (hasEnv('OPENROUTER_API_KEY')) return 'openrouter';
  return 'anthropic';
}

/**
 * Defaults are the current frontier tier. Claude Opus 5 leads the August 2026
 * Artificial Analysis index (63) and is the strongest available model for
 * agentic work, which is what this app does; Sonnet 5 is the cheaper tier
 * behind the same header switch.
 *
 * Override either with env to run a different model — on OpenRouter any model
 * id from https://openrouter.ai/models works, e.g. openai/gpt-5.6-sol or
 * google/gemini-3.7-flash.
 */
const DEFAULT_MODELS: Record<Provider, Record<Quality, string>> = {
  anthropic: {
    standard: 'claude-sonnet-5',
    high: 'claude-opus-5',
  },
  openrouter: {
    standard: 'anthropic/claude-sonnet-5',
    high: 'anthropic/claude-opus-5',
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
