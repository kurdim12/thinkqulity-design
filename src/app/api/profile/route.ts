import { NextResponse } from 'next/server';
import dayjs from 'dayjs';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { requireEnv, optionalEnv, hasEnv, apifyBudgetUsd } from '@/lib/env';
import { canonicalHandles } from '@/lib/ingest/handles';
import { estimateScrape, checkBudget, type ScrapeEstimate } from '@/lib/ingest/budget';
import { parseProfiles } from '@/lib/ingest/profile';
import { type Json } from '@/lib/ingest/apify';
import { toIsoDate } from '@/lib/date';
import type { Account, ProfileSnapshotRow, ScrapeKind } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Profile history — the cheapest scrape in the app.
 *
 * Follower counts are the one number the post scraper does not reliably return:
 * snapshots.stats.followers is {personal:null, academy:null} today, and the
 * "84.5K" that appears in the brand facts is a seeded string, not a measurement.
 * This route is how that becomes a real, dated series.
 *
 *   GET   -> the estimate (no spend) + the latest snapshot per account + the
 *            delta against the one before it.
 *   POST  -> two results, one per canonical handle, upserted on (account, taken_on).
 *
 * Two results is small enough to run synchronously inside one request, so this
 * route does not need the monitor's start/poll/import dance.
 *
 * Read-only against Instagram, always. No Meta OAuth, no write scope.
 */

const ACCOUNTS: readonly Account[] = ['personal', 'academy'];
const DEFAULT_ACTOR = 'apify~instagram-scraper';
const KIND: ScrapeKind = 'profile';
const RAW_BUCKET = 'brand-assets';
/** Apify's sync endpoint caps at 300s; stay under this route's maxDuration. */
const SYNC_TIMEOUT_S = 180;

function actorId(): string {
  return optionalEnv('APIFY_ACTOR') ?? DEFAULT_ACTOR;
}

function apifyToken(): string {
  if (!hasEnv('APIFY_TOKEN')) {
    throw new HttpError(
      503,
      'Automated scraping is not configured.',
      'Add APIFY_TOKEN to .env.local (apify.com → Settings → Integrations).',
    );
  }
  return requireEnv('APIFY_TOKEN');
}

async function apify<T>(path: string, init?: RequestInit): Promise<T> {
  const token = apifyToken();
  const joiner = path.includes('?') ? '&' : '?';
  const response = await fetch(
    `https://api.apify.com/v2${path}${joiner}token=${encodeURIComponent(token)}`,
    init,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new HttpError(
      502,
      `Apify returned ${response.status}.`,
      detail.slice(0, 300) || 'Check the token is valid and the account has credits left.',
    );
  }

  return (await response.json()) as T;
}

/* ------------------------------------------------------------- the ledger -- */

/**
 * Hard rule 8/9. Written before the actor is called, so a blocked run leaves a
 * trace carrying its estimate. A ledger failure aborts the run: an unledgered
 * scrape is exactly what these rules exist to prevent.
 */
async function ledger(row: {
  kind: ScrapeKind;
  actor: string;
  input: Json;
  estimated_usd: number | null;
  actual_results: number | null;
  status: string;
  raw_path: string | null;
}): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from('scrape_runs')
    .insert(row)
    .select('id')
    .single();

  if (error || !data) {
    throw new HttpError(
      500,
      `Could not write the scrape ledger: ${error?.message ?? 'no row returned'}`,
      'Nothing was scraped — the ledger is written first on purpose.',
    );
  }
  return (data as { id: string }).id;
}

/**
 * Hard rule 8: the complete payload is stored before any mapping, so fields
 * this version does not surface stay re-processable without paying to scrape
 * again. It goes to the private brand-assets bucket rather than into the row
 * because scrape_runs has no raw column; the operator reads it back through the
 * existing auth-gated /api/assets?path=… redirect.
 */
async function storeRaw(runId: string, payload: unknown): Promise<{ path: string; bytes: number }> {
  const body = JSON.stringify(payload ?? null);
  const path = `scrape-raw/${KIND}/${runId}.json`;

  const { error } = await supabaseAdmin()
    .storage.from(RAW_BUCKET)
    .upload(path, body, { contentType: 'application/json; charset=utf-8', upsert: true });

  if (error) {
    throw new HttpError(
      502,
      'The scrape ran but its raw payload could not be stored.',
      `${error.message} — nothing was mapped, because raw is stored before mapping.`,
    );
  }

  return { path, bytes: Buffer.byteLength(body, 'utf8') };
}

/**
 * storeRaw, with the ledger closed if it fails.
 *
 * By the time raw storage is attempted the actor has already run and already
 * been charged. Letting storeRaw's 502 escape untouched would leave the row at
 * status 'running' with actual_results null and raw_path null — money spent
 * that the ledger has no record of. The result count is already known here, so
 * it is written alongside status 'error'.
 *
 * Rule 8 is untouched: raw_path stays null because nothing was stored, and
 * nothing downstream is mapped — the original error is re-raised, so the caller
 * still aborts before parseProfiles. Only the accounting is repaired. That
 * combination — 'error', a real result count, no raw_path — is what marks this
 * row as a paid run whose payload was lost.
 */
async function storeRawOrCloseLedger(
  runId: string,
  payload: unknown,
  actualResults: number,
): Promise<{ path: string; bytes: number }> {
  try {
    return await storeRaw(runId, payload);
  } catch (err) {
    await supabaseAdmin()
      .from('scrape_runs')
      .update({ status: 'error', actual_results: actualResults, raw_path: null })
      .eq('id', runId);
    throw err;
  }
}

/* ---------------------------------------------------------- spend guard --- */

interface Guard {
  estimate: ScrapeEstimate;
  budget_usd: number | null;
  allowed: boolean;
  reason: string | null;
  shortfall_usd: number | null;
  result_count: number;
  actor: string;
}

function guard(resultCount: number): Guard {
  const actor = actorId();
  const estimate = estimateScrape({ actor, resultCount });
  const budgetUsd = apifyBudgetUsd();
  const decision = checkBudget({ estimate, budgetUsd });

  // A shortfall is only a real number when both sides are real numbers.
  const shortfall =
    estimate.usd !== null && budgetUsd !== null && Number.isFinite(budgetUsd) && budgetUsd >= 0
      ? Number(Math.max(estimate.usd - budgetUsd, 0).toFixed(2))
      : null;

  return {
    estimate,
    budget_usd: budgetUsd,
    allowed: decision.allowed,
    reason: decision.reason,
    shortfall_usd: shortfall,
    result_count: resultCount,
    actor,
  };
}

function blockedResponse(g: Guard, runId: string | null) {
  return NextResponse.json(
    {
      error: g.reason ?? 'Blocked by the scrape budget guard.',
      hint: 'Raise APIFY_BUDGET_USD, or narrow the scope. Nothing was scraped and nothing was charged.',
      blocked: true,
      run_id: runId,
      estimate_usd: g.estimate.usd,
      rate_per_1000: g.estimate.rate_per_1000,
      result_count: g.result_count,
      budget_usd: g.budget_usd,
      shortfall_usd: g.shortfall_usd,
    },
    { status: 402 },
  );
}

/* ---------------------------------------------------------------- deltas -- */

interface ProfileDelta {
  previous_taken_on: string;
  days_between: number | null;
  followers: number | null;
  following: number | null;
  posts_count: number | null;
}

/** Null when either side is unknown — "we don't know" is not "no change". */
function delta(next: number | null, previous: number | null): number | null {
  if (next === null || previous === null) return null;
  return next - previous;
}

interface AccountHistory {
  latest: ProfileSnapshotRow | null;
  previous: ProfileSnapshotRow | null;
  delta: ProfileDelta | null;
}

/**
 * The latest two rows for one account. The delta is null until a second
 * measurement exists — a first snapshot has nothing to be compared against, and
 * showing 0 there would be an invented number.
 */
async function historyFor(account: Account): Promise<AccountHistory> {
  const { data, error } = await supabaseAdmin()
    .from('profile_snapshots')
    .select('*')
    .eq('account', account)
    .order('taken_on', { ascending: false })
    .limit(2);

  if (error) throw new Error(`Could not read profile history: ${error.message}`);

  const rows = (data as ProfileSnapshotRow[] | null) ?? [];
  const latest = rows[0] ?? null;
  const previous = rows[1] ?? null;

  if (!latest || !previous) return { latest, previous, delta: null };

  const days = dayjs(latest.taken_on).diff(dayjs(previous.taken_on), 'day');

  return {
    latest,
    previous,
    delta: {
      previous_taken_on: previous.taken_on,
      days_between: Number.isFinite(days) ? days : null,
      followers: delta(latest.followers, previous.followers),
      following: delta(latest.following, previous.following),
      posts_count: delta(latest.posts_count, previous.posts_count),
    },
  };
}

async function allHistory(): Promise<Record<Account, AccountHistory>> {
  const [personal, academy] = await Promise.all([historyFor('personal'), historyFor('academy')]);
  return { personal, academy };
}

/* ------------------------------------------------------------------ GET --- */

/**
 * GET /api/profile — what a refresh would cost, and what is already known.
 * Reads only: no actor is started, nothing is charged.
 */
export async function GET() {
  try {
    await requireOperator();

    const handles = canonicalHandles();
    const g = guard(ACCOUNTS.length);
    const accounts = await allHistory();

    return NextResponse.json({
      handles,
      estimate: {
        actor: g.actor,
        result_count: g.result_count,
        usd: g.estimate.usd,
        rate_per_1000: g.estimate.rate_per_1000,
      },
      budget: {
        budget_usd: g.budget_usd,
        allowed: g.allowed,
        reason: g.reason,
        shortfall_usd: g.shortfall_usd,
      },
      accounts,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ----------------------------------------------------------------- POST --- */

/**
 * POST /api/profile — one profile scrape, two results, upserted by (account, taken_on).
 *
 * Re-running on the same day overwrites that day's row rather than growing the
 * series, so the series stays one measurement per day per account.
 */
export async function POST() {
  try {
    await requireOperator();

    const handles = canonicalHandles();
    const urls = [handles.personal, handles.academy].map(
      (handle) => `https://www.instagram.com/${handle}/`,
    );

    const input: Json = {
      directUrls: urls,
      resultsType: 'details',
      resultsLimit: 1,
      addParentData: false,
    };

    const g = guard(urls.length);

    // Ledger first, decide second: a blocked run is still a run that happened.
    if (!g.allowed) {
      const blockedId = await ledger({
        kind: KIND,
        actor: g.actor,
        input,
        estimated_usd: g.estimate.usd,
        actual_results: null,
        status: 'blocked',
        raw_path: null,
      });
      return blockedResponse(g, blockedId);
    }

    const runId = await ledger({
      kind: KIND,
      actor: g.actor,
      input,
      estimated_usd: g.estimate.usd,
      actual_results: null,
      status: 'running',
      raw_path: null,
    });

    const db = supabaseAdmin();

    let items: unknown[];
    try {
      items = await apify<unknown[]>(
        `/acts/${g.actor}/run-sync-get-dataset-items?timeout=${SYNC_TIMEOUT_S}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        },
      );
    } catch (err) {
      await db.from('scrape_runs').update({ status: 'error' }).eq('id', runId);
      throw err;
    }

    const results = Array.isArray(items) ? items : [];
    const raw = await storeRawOrCloseLedger(runId, results, results.length);

    // toIsoDate keeps the date in Latin digits: an Arabic-Indic date string must
    // never reach Postgres (hard rule 5). Mapping, routing and the "never guess
    // an account" rule all live in parseProfiles — this route only persists.
    const takenOn = toIsoDate(dayjs());
    const parsed = parseProfiles(results, { takenOn });

    const rows = parsed.profiles.map((profile) => ({
      account: profile.account,
      taken_on: profile.taken_on,
      followers: profile.followers,
      following: profile.following,
      posts_count: profile.posts_count,
      bio: profile.bio,
      external_url: profile.external_url,
      is_verified: profile.is_verified,
      raw: profile.raw,
    }));

    if (rows.length > 0) {
      const { error: upsertError } = await db
        .from('profile_snapshots')
        .upsert(rows, { onConflict: 'account,taken_on' });

      if (upsertError) {
        // Same accounting as storeRawOrCloseLedger above, one step later: the
        // actor has already run and already been charged by this line, so a row
        // closed at 'error' without `actual_results` is a paid run the ledger
        // has no result count for. It is known here — `results.length` is what
        // came back — so it is written alongside the status, exactly as the
        // comments and monitor imports do on their own upsert failures. raw_path
        // is written too, because unlike the storeRaw path the payload IS in
        // storage: the run can be re-mapped without paying again (rule 8).
        await db
          .from('scrape_runs')
          .update({ status: 'error', actual_results: results.length, raw_path: raw.path })
          .eq('id', runId);
        throw new Error(`Could not save profile snapshots: ${upsertError.message}`);
      }
    }

    await db
      .from('scrape_runs')
      .update({
        actual_results: results.length,
        status: rows.length > 0 ? 'done' : 'empty',
        raw_path: raw.path,
      })
      .eq('id', runId);

    return NextResponse.json({
      run_id: runId,
      taken_on: takenOn,
      estimate: {
        actor: g.actor,
        result_count: g.result_count,
        usd: g.estimate.usd,
        rate_per_1000: g.estimate.rate_per_1000,
      },
      budget: { budget_usd: g.budget_usd, allowed: true, reason: null, shortfall_usd: null },
      results: results.length,
      saved: rows.length,
      handles_seen: parsed.profiles.map((profile) => profile.username),
      // Every item that did not become a row, with its reason. Shown verbatim:
      // a follower number that did not arrive must not look like one that did.
      warnings: parsed.warnings,
      raw_path: raw.path,
      raw_bytes: raw.bytes,
      accounts: await allHistory(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
