/**
 * Hard rule 9 — estimate before spend.
 *
 * Pure arithmetic over Apify's published pay-per-result pricing. No I/O, no
 * network, no environment reads, so it is unit-testable under
 * `node --test --experimental-strip-types` and callable from anywhere.
 *
 * Every rate here is a published price, copied from the actor's own store page.
 * A rate we cannot verify is `null`, and a null rate produces a null estimate
 * rather than an invented number (hard rule 2). A null estimate is never
 * allowed to spend: rule 9 is "estimate before spend", not "hope".
 */

export type ApifyPlan = 'free' | 'starter' | 'scale' | 'business';

/**
 * apify/instagram-scraper bills pay-per-result: one result is one scraped item
 * (a post, reel, comment, profile, hashtag or place) at a single rate whatever
 * the kind. The rate depends on the Apify plan the token belongs to.
 *
 * Published on https://apify.com/apify/instagram-scraper, read 2026-08-14:
 * "from $1.50 / 1,000 results", broken down per plan below.
 */
export const APIFY_INSTAGRAM_SCRAPER_PLAN_RATES: Record<ApifyPlan, number> = {
  free: 2.7,
  starter: 2.3,
  scale: 1.9,
  business: 1.5,
};

/**
 * The plan assumed when estimating. Free is both what this project's token is
 * on and the most expensive tier, so an estimate is a ceiling rather than a
 * best case — the right direction of error for a spend guard.
 */
export const ASSUMED_APIFY_PLAN: ApifyPlan = 'free';

/**
 * USD per 1,000 results, keyed by actor id. `null` means "no published rate
 * verified" — add a rate here only with the actor's store page in front of you.
 */
export const ACTOR_RATES: Record<string, number | null> = {
  'apify/instagram-scraper': APIFY_INSTAGRAM_SCRAPER_PLAN_RATES[ASSUMED_APIFY_PLAN],
};

export interface ScrapeEstimate {
  /** Estimated cost in USD, or null when it could not be computed. */
  usd: number | null;
  rate_per_1000: number | null;
}

export interface BudgetDecision {
  allowed: boolean;
  /** Why the run was blocked. Null when it is allowed. */
  reason: string | null;
}

/** Apify writes actor ids both ways; `apify~instagram-scraper` is the API form. */
function normaliseActor(actor: string): string {
  return actor.trim().toLowerCase().replace(/~/g, '/');
}

/**
 * The published per-1,000-results rate for an actor, or null if we do not have
 * one. An unknown actor and an actor with an unverified rate are deliberately
 * indistinguishable here: both mean "cannot estimate".
 */
export function actorRatePer1000(actor: string): number | null {
  const key = normaliseActor(actor);
  if (!Object.hasOwn(ACTOR_RATES, key)) return null;
  return ACTOR_RATES[key] ?? null;
}

/** Rounds UP to the next cent, so an estimate never reads below the charge. */
function ceilToCents(value: number): number {
  // toFixed first: 2.7 * 1000 / 1000 * 100 is 270.00000000000003 in binary
  // floating point, and a naive ceil would turn $2.70 into $2.71.
  return Math.ceil(Number((value * 100).toFixed(6))) / 100;
}

/**
 * Cost of a run before it is started. A result count that is not a finite,
 * non-negative number yields a null `usd` (the rate is still reported, since
 * that is a property of the actor, not of the request).
 */
export function estimateScrape(args: { actor: string; resultCount: number }): ScrapeEstimate {
  const rate = actorRatePer1000(args.actor);
  if (rate === null) return { usd: null, rate_per_1000: null };

  const { resultCount } = args;
  if (!Number.isFinite(resultCount) || resultCount < 0) {
    return { usd: null, rate_per_1000: rate };
  }

  // A fractional count cannot happen, but if one arrives it rounds up too.
  const results = Math.ceil(resultCount);
  return { usd: ceilToCents((rate * results) / 1000), rate_per_1000: rate };
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * The spend gate. Blocks unless the cost is known AND within the ceiling.
 *
 * - `usd: null`            → BLOCKED. Rule 9 is estimate before spend.
 * - `budgetUsd: null`      → allowed, provided the cost was estimated. No
 *                            ceiling is configured, so there is nothing to
 *                            exceed; the estimate is still recorded on the run.
 * - `budgetUsd: 0`         → a real ceiling of zero. Any positive estimate is
 *                            blocked; an estimate of exactly $0.00 is allowed.
 * - negative / NaN budget  → BLOCKED as a misconfiguration, never read as
 *                            "unlimited".
 */
export function checkBudget(args: {
  estimate: ScrapeEstimate;
  budgetUsd: number | null | undefined;
}): BudgetDecision {
  const { estimate } = args;
  const budgetUsd = args.budgetUsd ?? null;

  if (estimate.usd === null) {
    return {
      allowed: false,
      reason:
        'Cost could not be estimated: no verified per-1,000-results rate for this actor. ' +
        'Blocked because the rule is estimate before spend.',
    };
  }

  if (budgetUsd === null) return { allowed: true, reason: null };

  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    return {
      allowed: false,
      reason: `APIFY_BUDGET_USD is set to an unusable value (${String(budgetUsd)}). ` +
        'Fix it or clear it — an unreadable budget is never treated as unlimited.',
    };
  }

  if (estimate.usd > budgetUsd) {
    return {
      allowed: false,
      reason: `Estimated ${usd(estimate.usd)} exceeds the APIFY_BUDGET_USD ceiling of ${usd(budgetUsd)}.`,
    };
  }

  return { allowed: true, reason: null };
}
