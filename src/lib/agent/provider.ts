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
 * Defaults on OpenRouter are the GPT-5.6 family.
 *
 * The reasoning, so the next person can re-litigate it with evidence rather
 * than taste: this app's output is marketing copy — hooks, captions, a monthly
 * report. Independent 2026 writing comparisons put GPT ahead of Gemini on
 * polished, stylistically consistent persuasive copy, and ahead on holding
 * structure across long documents (the report). Nobody has published a clean
 * Arabic head-to-head between the closed frontier models — the Arabic
 * leaderboards (OALL, HELM Arabic) rank open Arabic-specialist models — so
 * treat this as a starting point, not a finding.
 *
 * Switching is one env line, deliberately: generate the same brief on two
 * models and let the Arabic decide. Any id from https://openrouter.ai/models
 * works, including anthropic/claude-opus-5, google/gemini-3.7-flash and
 * deepseek/deepseek-v4-pro-0813.
 */
const DEFAULT_MODELS: Record<Provider, Record<Quality, string>> = {
  anthropic: {
    standard: 'claude-sonnet-5',
    high: 'claude-opus-5',
  },
  openrouter: {
    standard: 'openai/gpt-5.6-terra',
    high: 'openai/gpt-5.6-sol',
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
