import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTOR_RATES,
  APIFY_INSTAGRAM_SCRAPER_PLAN_RATES,
  ASSUMED_APIFY_PLAN,
  actorRatePer1000,
  checkBudget,
  estimateScrape,
} from '../src/lib/ingest/budget.ts';

/* ------------------------------------------------------------- fixtures -- */

/** The rate the estimator assumes: the published free-plan price. */
const RATE = APIFY_INSTAGRAM_SCRAPER_PLAN_RATES[ASSUMED_APIFY_PLAN];

const ACTOR = 'apify/instagram-scraper';

/* ----------------------------------------------------------------- rates -- */

test('the actor rate is the published price for the assumed plan', () => {
  assert.equal(RATE, 2.7);
  assert.equal(ACTOR_RATES[ACTOR], RATE);
  assert.equal(actorRatePer1000(ACTOR), RATE);
});

test('the tilde spelling Apify uses in its API resolves to the same rate', () => {
  assert.equal(actorRatePer1000('apify~instagram-scraper'), RATE);
  assert.equal(actorRatePer1000('  APIFY~Instagram-Scraper  '), RATE);
});

test('an unknown actor has no rate — it is not assumed to be free', () => {
  assert.equal(actorRatePer1000('someone/unknown-scraper'), null);
});

test('an inherited object key is not mistaken for a rate', () => {
  assert.equal(actorRatePer1000('toString'), null);
});

/* -------------------------------------------------------------- estimate -- */

test('estimateScrape multiplies the published rate by the result count', () => {
  const e = estimateScrape({ actor: ACTOR, resultCount: 1000 });
  assert.equal(e.rate_per_1000, RATE);
  assert.equal(e.usd, 2.7);
});

test('estimateScrape rounds UP to the next cent, never below the real charge', () => {
  // 320 results x $2.70/1000 = $0.864.
  assert.equal(estimateScrape({ actor: ACTOR, resultCount: 320 }).usd, 0.87);
});

test('estimateScrape returns 0 for 0 results — that is arithmetic, not a guess', () => {
  assert.equal(estimateScrape({ actor: ACTOR, resultCount: 0 }).usd, 0);
});

test('estimateScrape returns a null estimate for an unknown actor', () => {
  const e = estimateScrape({ actor: 'someone/unknown-scraper', resultCount: 1000 });
  assert.equal(e.usd, null);
  assert.equal(e.rate_per_1000, null);
});

test('estimateScrape refuses an impossible result count but still reports the rate', () => {
  const e = estimateScrape({ actor: ACTOR, resultCount: Number.NaN });
  assert.equal(e.usd, null);
  assert.equal(e.rate_per_1000, RATE);
  assert.equal(estimateScrape({ actor: ACTOR, resultCount: -1 }).usd, null);
});

/* ---------------------------------------------------------------- budget -- */

test('a run inside the budget is allowed, with no reason to report', () => {
  const estimate = estimateScrape({ actor: ACTOR, resultCount: 1000 }); // $2.70
  const d = checkBudget({ estimate, budgetUsd: 5 });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, null);
});

test('an estimate exactly equal to the budget is allowed', () => {
  const d = checkBudget({ estimate: { usd: 5, rate_per_1000: RATE }, budgetUsd: 5 });
  assert.equal(d.allowed, true);
});

test('a run over the budget is BLOCKED and the reason names both numbers', () => {
  const estimate = estimateScrape({ actor: ACTOR, resultCount: 5000 }); // $13.50
  assert.equal(estimate.usd, 13.5);
  const d = checkBudget({ estimate, budgetUsd: 5 });
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /13\.50/);
  assert.match(d.reason ?? '', /5\.00/);
});

test('an unknown actor BLOCKS: a null estimate is never auto-allowed', () => {
  const estimate = estimateScrape({ actor: 'someone/unknown-scraper', resultCount: 10 });
  assert.equal(estimate.usd, null);
  // Blocked with a budget set...
  const withBudget = checkBudget({ estimate, budgetUsd: 1000 });
  assert.equal(withBudget.allowed, false);
  assert.match(withBudget.reason ?? '', /could not be estimated/i);
  // ...and blocked with no budget set. Rule 9 is estimate before spend.
  const withoutBudget = checkBudget({ estimate, budgetUsd: null });
  assert.equal(withoutBudget.allowed, false);
});

/* --- zero and absent budgets: both are explicit, neither is accidental --- */

test('budgetUsd 0 is a real ceiling of zero — any positive estimate is blocked', () => {
  const d = checkBudget({ estimate: { usd: 0.01, rate_per_1000: RATE }, budgetUsd: 0 });
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? '', /0\.01/);
  assert.match(d.reason ?? '', /0\.00/);
});

test('budgetUsd 0 still allows a run estimated at exactly $0.00', () => {
  const estimate = estimateScrape({ actor: ACTOR, resultCount: 0 });
  assert.equal(checkBudget({ estimate, budgetUsd: 0 }).allowed, true);
});

test('an absent budget means no ceiling, so a KNOWN cost is allowed', () => {
  const estimate = estimateScrape({ actor: ACTOR, resultCount: 100000 }); // $270.00
  assert.equal(estimate.usd, 270);
  assert.equal(checkBudget({ estimate, budgetUsd: null }).allowed, true);
  assert.equal(checkBudget({ estimate, budgetUsd: undefined }).allowed, true);
});

test('an unreadable budget is a misconfiguration, never "unlimited"', () => {
  const estimate = estimateScrape({ actor: ACTOR, resultCount: 1000 });
  const nan = checkBudget({ estimate, budgetUsd: Number.NaN });
  assert.equal(nan.allowed, false);
  assert.match(nan.reason ?? '', /unusable/i);
  assert.equal(checkBudget({ estimate, budgetUsd: -1 }).allowed, false);
});
