/**
 * PUBLISHED PER-TOKEN RATES — the one table in this repository.
 *
 * This lived inside src/app/api/board/analyze/route.ts, which meant it was
 * reachable from exactly one screen. /api/digest builds a token ceiling for the
 * strategist cycle and could not price it, so it returned `usd: null` and said
 * so in `unpriced_reason`: "Copying them here would create a second table to go
 * stale". That was the right refusal and the wrong resting place. The table is
 * here now so every estimate in the app quotes the same numbers, read on the
 * same date, from the same page.
 *
 * THE RULE THIS FILE KEEPS (hard rule 15, the same contract
 * src/lib/ingest/budget.ts keeps for the Apify actors): a rate is either copied
 * from a vendor price page WITH that page's URL and the date it was read, or it
 * is absent. Absence produces a null estimate and a stated reason — never an
 * invented number, never a plausible-looking guess, never 0. A model whose rate
 * nobody has verified cannot be priced, and saying so is the only honest answer.
 *
 * Adding a model: open the vendor's price page, copy the two figures, and put
 * the URL and the read date beside them. Do not interpolate from a sibling
 * model and do not carry a rate over from memory.
 *
 * Pure data and pure functions — no imports, no I/O, no environment reads.
 */

export interface TokenRate {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
}

/**
 * Published list prices, USD per MILLION tokens, copied from
 * https://platform.claude.com/docs/en/about-claude/models/overview — read
 * 2026-08-14.
 *
 * Only rates read from that page are recorded here. A model with no verified
 * rate is absent, and absence produces a null estimate rather than an invented
 * number — the same contract src/lib/ingest/budget.ts keeps for the Apify
 * actors, and the reason most of the OpenRouter model ids this app can be
 * pointed at are NOT listed: nobody has read their price pages into this file,
 * so nothing here can honestly price them.
 */
export const PUBLISHED_RATES: Record<string, TokenRate> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  // OpenRouter model ids below, USD per MILLION tokens, read 2026-08-15 from
  // https://openrouter.ai/api/v1/models. Keyed by the bare id (the last
  // segment after the vendor slash), same as normaliseModel() below.
  'gpt-5.6-luna': { in: 0.1, out: 0.6 },
  'qwen3.7-plus': { in: 0.32, out: 1.28 },
  'gemini-3.7-flash': { in: 0.38, out: 1.88 },
  'deepseek-v4-pro-0813': { in: 0.43, out: 0.87 },
  'qwen3.7-flash': { in: 0.03, out: 0.13 },
  'gpt-5.6-terra': { in: 1, out: 6 },
  'gpt-5.6-sol': { in: 5, out: 30 },
};

/**
 * Claude Sonnet 5 is on introductory pricing of $2 / $10 per million tokens
 * "through 2026-08-31" (same page, same read date).
 *
 * A discount with an expiry is stored WITH its expiry. Hard-coding 2 and 10 —
 * which is what the route used to do — is correct today and silently
 * under-quotes the operator from the first of September, which is the same
 * class of defect as an invented constant: a number that looks computed and is
 * wrong. After the date the standard rate applies on its own.
 */
export const SONNET_5_INTRO = { rate: { in: 2, out: 10 }, through: '2026-08-31' };

/** Today in UTC as `YYYY-MM-DD`, which is how the expiry above is written. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** OpenRouter writes `anthropic/claude-opus-5`; the first-party SDK writes the bare id. */
export function normaliseModel(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** The published rate for a model, or null when this file has not verified one. */
export function rateFor(model: string): TokenRate | null {
  const key = normaliseModel(model);
  if (key === 'claude-sonnet-5' && todayIso() <= SONNET_5_INTRO.through) return SONNET_5_INTRO.rate;
  if (!Object.hasOwn(PUBLISHED_RATES, key)) return null;
  return PUBLISHED_RATES[key];
}

/**
 * Why a cost could not be stated, in words a non-engineer can act on. One
 * spelling, so two screens cannot disagree about what an absent rate means, and
 * so the path a maintainer is sent to is right in both.
 */
export function unpricedReason(model: string): string {
  return (
    `No published per-token rate has been verified for "${model}", so the cost cannot be ` +
    'estimated. Add one to src/lib/agent/rates.ts with the vendor’s price page in front of you.'
  );
}
