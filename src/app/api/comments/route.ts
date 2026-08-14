import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  requireEnv,
  optionalEnv,
  hasEnv,
  apifyBudgetUsd,
  commentsTopN,
  commentsPerPost,
} from '@/lib/env';
import { estimateScrape, checkBudget, type ScrapeEstimate } from '@/lib/ingest/budget';
import { parseComments, type ParsedComment } from '@/lib/ingest/comments';
import { type Json } from '@/lib/ingest/apify';
import {
  distinctPosts,
  scanCoverage,
  MAX_POSTS_SCAN,
  type PostIdentity,
  type ScanCoverage,
} from '@/lib/audience/posts';
import { instagramShortcode } from '@/lib/snapshots';
import type { Account, ScrapeKind } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The comment corpus.
 *
 * Hard rule 10: commenters are an audience, not targets. What this route builds
 * is a body of text to read at aggregate level — themes, questions, register,
 * timing. `author_handle` is stored because the raw item contains it and raw is
 * sacred, and because (post_id, ig_comment_id) needs to dedupe; nothing here or
 * downstream builds a per-commenter profile, a follow list, or a DM surface.
 *
 * Same three-step shape as /api/monitor, for the same reason: 50 posts x 100
 * comments is 5,000 results, which is far more than one HTTP request should
 * hold open.
 *
 *   GET                              -> scope + estimate, spends nothing
 *   POST { action: "start", … }      -> { apify_run_id, … }
 *   GET  ?runId=…                    -> { status, itemCount }
 *   POST { action: "import", runId }  -> maps the dataset into `comments`
 */

const DEFAULT_ACTOR = 'apify~instagram-scraper';
const KIND: ScrapeKind = 'comments';
const RAW_BUCKET = 'brand-assets';
/**
 * Snapshot rows read when ranking scrape recency. The read is newest-first, so
 * this cap can only ever drop snapshots that would have lost the comparison.
 */
const MAX_SNAPSHOTS_SCAN = 200;
/** Sorts a row whose snapshot is not in the ranking behind every ranked one. */
const UNRANKED = Number.MAX_SAFE_INTEGER;
/** Ceiling on an operator-widened scope. Deliberate, but not unbounded. */
const MAX_TOP_N = 500;
const MAX_PER_POST = 1000;
const MAX_IMPORT_ITEMS = 50_000;
const DATASET_PAGE = 1000;
const INSERT_CHUNK = 500;
/** `in (…)` batch size — keeps the PostgREST query string short. */
const ID_BATCH = 40;

interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId: string;
  startedAt?: string;
  finishedAt?: string | null;
  usageTotalUsd?: number;
  stats?: { outputItemCount?: number };
}

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

/** Paged so a large comment pull is never silently truncated at one page. */
async function fetchDatasetItems(datasetId: string): Promise<unknown[]> {
  const items: unknown[] = [];
  while (items.length < MAX_IMPORT_ITEMS) {
    const batch = await apify<unknown[]>(
      `/datasets/${datasetId}/items?limit=${DATASET_PAGE}&offset=${items.length}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < DATASET_PAGE) break;
  }
  return items;
}

/* ------------------------------------------------------------- the ledger -- */

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
 * Hard rule 8: the complete payload lands in storage before anything is mapped,
 * so the fields this version ignores stay re-processable without paying twice.
 * Readable afterwards through the existing /api/assets?path=… redirect.
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
 * The import step runs after the actor has finished and been charged, so a
 * storeRaw 502 escaping untouched would leave the row at status 'running' with
 * actual_results null and raw_path null — a paid comment pull the ledger has no
 * record of. The dataset item count is already known here, so it is written
 * alongside status 'error'.
 *
 * Rule 8 is untouched: raw_path stays null because nothing was stored, and the
 * original error is re-raised so the caller aborts before parseComments —
 * nothing is mapped. Only the accounting is repaired. 'error' plus a real
 * result count plus no raw_path is what marks a paid run whose payload was lost.
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
      hint: 'Raise APIFY_BUDGET_USD, or narrow the scope (fewer posts, fewer comments per post). Nothing was scraped and nothing was charged.',
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

/* ----------------------------------------------------------------- scope -- */

/**
 * A post row as this route reads it: the id comments hang off, the permalink
 * the actor is given, the engagement it is ranked by — plus the identity
 * columns distinctPosts() needs to tell posts from re-scrapes of the same post.
 */
interface CandidatePost extends PostIdentity {
  id: string;
  url: string | null;
  engagement: number;
  account: Account;
}

/** What one collapse of the candidate window produced, in both units. */
interface Candidates {
  /** One row per ig_id, highest engagement first. */
  representatives: CandidatePost[];
  /** The read that produced them, and whether it filled its cap. */
  coverage: ScanCoverage;
  /** Rows dropped as re-scrapes of a post already kept. */
  duplicates_collapsed: number;
  /** Distinct snapshots the window spanned. 1 means the collapse was a no-op. */
  snapshots_seen: number;
}

interface Scope {
  targets: CandidatePost[];
  top_n: number;
  per_post: number;
  only_uncovered: boolean;
  /** Ids the caller named that are not in the candidate window or have no URL. */
  missing_post_ids: string[];
  /** How many of the ranked top-N already have comments stored. */
  already_covered: number;
  candidates: Candidates;
}

/**
 * Scrape recency as a rank: newest snapshot 0, the one before it 1, and so on.
 *
 * A post row carries no timestamp of its own — `posted_at` is when Ahmad
 * published, identical in every re-scrape of that post — so the only place
 * scrape recency lives is `snapshots.taken_on`. Same read, and for the same
 * reason, as the one the audience feature does before its own collapse.
 */
async function snapshotRecencyRank(): Promise<Map<string, number>> {
  const { data, error } = await supabaseAdmin()
    .from('snapshots')
    .select('id')
    .order('taken_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(MAX_SNAPSHOTS_SCAN);
  if (error) throw new Error(`Could not read snapshots: ${error.message}`);

  const rank = new Map<string, number>();
  for (const row of (data as { id: string }[] | null) ?? []) {
    if (!rank.has(row.id)) rank.set(row.id, rank.size);
  }
  return rank;
}

/**
 * One representative row per ig_id, highest engagement first.
 *
 * `posts` holds one row per post per snapshot, so the same ig_id reappears
 * every time it is re-scraped. Collapsing to a single representative keeps the
 * comment corpus attached to one row per real post — otherwise coverage would
 * read as "not covered" after every monitor run and the same comments would be
 * bought again.
 *
 * WHICH ROW SURVIVES, AND WHY THE ORDER IS BUILT TWICE. distinctPosts() ranks
 * snapshots by the order rows reach it, so handing it the engagement-ordered
 * read would make the winner whichever snapshot happened to hold the loudest
 * post — arbitrary, and arbitrary in a way that silently picks which scrape's
 * like count the estimate is priced on. So the rows are re-ordered by scrape
 * recency for the collapse, which makes "the freshest copy wins" a rule rather
 * than a hope, and the winners are then re-sorted by engagement because the
 * top-N this route buys comments for is an engagement ranking. Both sorts are
 * stable, so a tie keeps the freshest row.
 *
 * The read is capped at MAX_POSTS_SCAN — the same ceiling every other
 * full-population read in the app states — and the coverage travels with the
 * result so a scope built from a prefix can say so instead of presenting it as
 * the whole account.
 */
async function loadCandidates(): Promise<Candidates> {
  const rank = await snapshotRecencyRank();

  const { data, error } = await supabaseAdmin()
    .from('posts')
    .select('id, ig_id, url, engagement, account, snapshot_id, posted_at')
    .order('engagement', { ascending: false })
    .limit(MAX_POSTS_SCAN);

  if (error) throw new Error(`Could not read posts: ${error.message}`);

  const rows = (data as CandidatePost[] | null) ?? [];
  // Measured on the raw row count, before the collapse: it is the QUERY that
  // was capped, not the post population.
  const coverage = scanCoverage(rows.length, MAX_POSTS_SCAN);

  const byScrapeRecency = [...rows].sort(
    (a, b) => (rank.get(a.snapshot_id) ?? UNRANKED) - (rank.get(b.snapshot_id) ?? UNRANKED),
  );
  const population = distinctPosts(byScrapeRecency, { newestSnapshotFirst: true });

  const representatives = [...population.posts].sort((a, b) => b.engagement - a.engagement);

  return {
    representatives,
    coverage,
    duplicates_collapsed: population.duplicates_collapsed,
    snapshots_seen: population.snapshots_seen,
  };
}

/** Post rows that already have at least one comment stored. */
async function coveredPostIds(postIds: string[]): Promise<Set<string>> {
  const db = supabaseAdmin();
  const covered = new Set<string>();

  for (let index = 0; index < postIds.length; index += ID_BATCH) {
    const batch = postIds.slice(index, index + ID_BATCH);
    const { data, error } = await db.from('comments').select('post_id').in('post_id', batch);
    if (error) throw new Error(`Could not read the comment corpus: ${error.message}`);
    for (const row of (data as { post_id: string | null }[] | null) ?? []) {
      if (row.post_id) covered.add(row.post_id);
    }
  }

  return covered;
}

function clampInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

async function resolveScope(args: {
  topN?: unknown;
  perPost?: unknown;
  postIds?: unknown;
  onlyUncovered?: unknown;
}): Promise<Scope> {
  const topN = clampInt(args.topN, commentsTopN(), MAX_TOP_N);
  const perPost = clampInt(args.perPost, commentsPerPost(), MAX_PER_POST);
  const onlyUncovered = args.onlyUncovered === true;

  const requested = Array.isArray(args.postIds)
    ? args.postIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : null;

  const candidates = await loadCandidates();
  const withUrl = candidates.representatives.filter((post) => post.url !== null);

  let ranked: CandidatePost[];
  const missing: string[] = [];

  if (requested !== null) {
    // An explicit list is honoured exactly, including an empty one. Falling back
    // to the top-N because the caller sent [] would spend money nobody asked for.
    const known = new Map(withUrl.map((post) => [post.id, post]));
    ranked = [];
    for (const id of requested) {
      const post = known.get(id);
      if (post) ranked.push(post);
      // A named post we cannot scrape (unknown id, or no permalink to give the
      // actor) is reported back rather than silently dropped.
      else missing.push(id);
    }
  } else {
    ranked = withUrl.slice(0, topN);
  }

  const covered = await coveredPostIds(ranked.map((post) => post.id));
  const alreadyCovered = ranked.filter((post) => covered.has(post.id)).length;
  const targets = onlyUncovered ? ranked.filter((post) => !covered.has(post.id)) : ranked;

  return {
    targets,
    top_n: topN,
    per_post: perPost,
    only_uncovered: onlyUncovered,
    missing_post_ids: missing,
    already_covered: alreadyCovered,
    candidates,
  };
}

function scopeSummary(scope: Scope) {
  return {
    target_post_count: scope.targets.length,
    top_n: scope.top_n,
    per_post: scope.per_post,
    only_uncovered: scope.only_uncovered,
    already_covered: scope.already_covered,
    missing_post_ids: scope.missing_post_ids,
    /** Distinct POSTS the scope was ranked over, after the collapse. */
    candidates_scanned: scope.candidates.representatives.length,
    /**
     * The read behind that number, in both units. `truncated` means the query
     * filled its cap, so posts beyond it were never ranked and the scope is a
     * prefix of the account — stated, never presented as the whole of it.
     */
    scan: {
      rows_fetched: scope.candidates.coverage.rows_fetched,
      limit: scope.candidates.coverage.limit,
      truncated: scope.candidates.coverage.truncated,
      duplicates_collapsed: scope.candidates.duplicates_collapsed,
      snapshots_seen: scope.candidates.snapshots_seen,
    },
  };
}

function actorInput(scope: Scope): Json {
  return {
    directUrls: scope.targets.map((post) => post.url),
    resultsType: 'comments',
    resultsLimit: scope.per_post,
    addParentData: true,
  };
}

/* -------------------------------------------------------------- mapping --- */

/**
 * The index parseComments resolves a comment's post against.
 *
 * Keyed by BOTH `ig_id` and the permalink's shortcode, because they are not the
 * same thing here: posts.ig_id in this database is the numeric media id
 * (e.g. 3908976897951975382) while a comment item references its post by URL
 * (…/p/DY_ecctosfW/). Indexing only one of the two would match nothing.
 *
 * The value is always the representative row for that post, so comments stay
 * attached to one row per real post no matter how many snapshots contain it.
 */
function buildPostIndex(representatives: CandidatePost[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const post of representatives) {
    if (!index.has(post.ig_id)) index.set(post.ig_id, post.id);
    const shortcode = instagramShortcode(post.url);
    if (shortcode !== null && !index.has(shortcode)) index.set(shortcode, post.id);
  }

  return index;
}

/** A parsed comment that resolved to a post — the only kind we persist. */
type AttachedComment = ParsedComment & { post_id: string };

/* ------------------------------------------------------------------ GET --- */

/**
 * GET /api/comments            — the scope and what it would cost. Spends nothing.
 * GET /api/comments?runId=…    — polls a started run.
 *
 * Query overrides `topN`, `perPost` and `onlyUncovered` let the Data screen
 * price a widened scope before the operator commits to it.
 */
export async function GET(request: Request) {
  try {
    await requireOperator();

    const params = new URL(request.url).searchParams;
    const runId = params.get('runId');

    if (runId) {
      const { data: run } = await apify<{ data: ApifyRun }>(`/actor-runs/${runId}`);
      return NextResponse.json({
        apify_run_id: run.id,
        status: run.status,
        item_count: run.stats?.outputItemCount ?? null,
        started_at: run.startedAt ?? null,
        finished_at: run.finishedAt ?? null,
        usage_usd: run.usageTotalUsd ?? null,
        done: ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status),
      });
    }

    const scope = await resolveScope({
      topN: params.get('topN'),
      perPost: params.get('perPost'),
      onlyUncovered: params.get('onlyUncovered') === 'true',
    });

    const g = guard(scope.targets.length * scope.per_post);

    const { count, error } = await supabaseAdmin()
      .from('comments')
      .select('id', { count: 'exact', head: true });
    if (error) throw new Error(`Could not count stored comments: ${error.message}`);

    return NextResponse.json({
      scope: scopeSummary(scope),
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
      // A count that did not come back is null, not 0 — it renders as an
      // em-dash rather than claiming an empty corpus (hard rule 2).
      corpus: { comments_stored: count ?? null },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ----------------------------------------------------------------- POST --- */

export async function POST(request: Request) {
  try {
    await requireOperator();

    const body = ((await request.json().catch(() => ({}))) ?? {}) as {
      action?: unknown;
      topN?: unknown;
      perPost?: unknown;
      postIds?: unknown;
      onlyUncovered?: unknown;
      runId?: unknown;
      ledgerId?: unknown;
    };

    const action = body.action === 'import' ? 'import' : 'start';

    /* ---------------------------------------------------------- import --- */
    if (action === 'import') {
      const apifyRunId = typeof body.runId === 'string' ? body.runId : null;
      if (!apifyRunId) throw new HttpError(400, 'Missing runId.');

      const perPost = clampInt(body.perPost, commentsPerPost(), MAX_PER_POST);
      const ledgerId = typeof body.ledgerId === 'string' ? body.ledgerId : null;

      const { data: run } = await apify<{ data: ApifyRun }>(`/actor-runs/${apifyRunId}`);
      if (run.status !== 'SUCCEEDED') {
        throw new HttpError(
          409,
          `That run is ${run.status}, not SUCCEEDED.`,
          'Wait for it to finish before importing.',
        );
      }

      const items = await fetchDatasetItems(run.defaultDatasetId);

      const db = supabaseAdmin();
      const rawOwnerId =
        ledgerId ??
        (await ledger({
          kind: KIND,
          actor: actorId(),
          // No actor input to record verbatim on this row: the run was started
          // elsewhere and this is the import half. What it did is the input.
          input: { step: 'import', apify_run_id: apifyRunId, per_post: perPost },
          estimated_usd: null,
          actual_results: null,
          status: 'running',
          raw_path: null,
        }));

      const raw = await storeRawOrCloseLedger(rawOwnerId, items, items.length);

      const { representatives } = await loadCandidates();
      // Mapping, reply flattening and dedupe on (post_id, ig_comment_id) all
      // live in parseComments. This route only decides what gets persisted.
      const parsed = parseComments(items, buildPostIndex(representatives));

      // parseComments keeps an unmatched comment with post_id: null rather than
      // discarding it, which is right for a parser. It is wrong for this table:
      // Postgres treats NULLs as distinct, so `unique (post_id, ig_comment_id)`
      // cannot catch them and every re-import would insert the row again. They
      // are counted here instead, and the complete payload is already in
      // storage — so once their post exists they can be re-processed for free.
      const attached: AttachedComment[] = [];
      for (const comment of parsed.comments) {
        if (comment.post_id !== null) attached.push({ ...comment, post_id: comment.post_id });
      }

      // Newest-first cap, applied here rather than trusted from the actor: the
      // scraper returns comments in Instagram's own order and we do not claim a
      // sort we cannot verify. `posted_at` is real data, so the cap is too.
      const byPost = new Map<string, AttachedComment[]>();
      for (const comment of attached) {
        const bucket = byPost.get(comment.post_id) ?? [];
        bucket.push(comment);
        byPost.set(comment.post_id, bucket);
      }

      const rows: AttachedComment[] = [];
      let overCap = 0;
      for (const bucket of byPost.values()) {
        bucket.sort((a, b) => {
          if (a.posted_at === b.posted_at) return 0;
          if (a.posted_at === null) return 1; // undated sorts last, never first
          if (b.posted_at === null) return -1;
          return a.posted_at < b.posted_at ? 1 : -1;
        });
        rows.push(...bucket.slice(0, perPost));
        overCap += Math.max(bucket.length - perPost, 0);
      }

      let saved = 0;
      for (let index = 0; index < rows.length; index += INSERT_CHUNK) {
        const chunk = rows.slice(index, index + INSERT_CHUNK);
        const { error: upsertError } = await db
          .from('comments')
          .upsert(chunk, { onConflict: 'post_id,ig_comment_id' });

        if (upsertError) {
          await db
            .from('scrape_runs')
            .update({ status: 'error', actual_results: items.length, raw_path: raw.path })
            .eq('id', rawOwnerId);
          throw new Error(
            `Could not save comments (${saved} of ${rows.length} written): ${upsertError.message}`,
          );
        }
        saved += chunk.length;
      }

      await db
        .from('scrape_runs')
        .update({ actual_results: items.length, status: 'done', raw_path: raw.path })
        .eq('id', rawOwnerId);

      const { count } = await db.from('comments').select('id', { count: 'exact', head: true });

      return NextResponse.json({
        run_id: rawOwnerId,
        apify_run_id: apifyRunId,
        results: items.length,
        saved,
        posts_covered: byPost.size,
        per_post_cap: perPost,
        skipped: {
          ...parsed.skipped,
          unmatched_post: parsed.unmatched_post,
          over_cap: overCap,
        },
        warnings: parsed.warnings,
        raw_path: raw.path,
        raw_bytes: raw.bytes,
        usage_usd: run.usageTotalUsd ?? null,
        // A count that did not come back is null, not 0 — it renders as an
        // em-dash rather than claiming an empty corpus (hard rule 2).
        corpus: { comments_stored: count ?? null },
      });
    }

    /* ----------------------------------------------------------- start --- */
    const scope = await resolveScope({
      topN: body.topN,
      perPost: body.perPost,
      postIds: body.postIds,
      onlyUncovered: body.onlyUncovered,
    });

    if (scope.targets.length === 0) {
      // Not an error: "everything in scope already has comments" is a normal
      // outcome of a monitor run. No actor is started, so no ledger row.
      return NextResponse.json({
        started: false,
        reason: scope.only_uncovered
          ? 'Every post in the top-N already has comments stored.'
          : 'No posts in scope have a permalink to scrape.',
        scope: scopeSummary(scope),
      });
    }

    const input = actorInput(scope);
    // The scope was resolved fresh above, so a widened scope from the request
    // body is priced on exactly what will be sent to the actor (rule 9).
    const g = guard(scope.targets.length * scope.per_post);

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

    let run: ApifyRun;
    try {
      ({ data: run } = await apify<{ data: ApifyRun }>(`/acts/${g.actor}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }));
    } catch (err) {
      await supabaseAdmin().from('scrape_runs').update({ status: 'error' }).eq('id', runId);
      throw err;
    }

    return NextResponse.json({
      started: true,
      run_id: runId,
      apify_run_id: run.id,
      dataset_id: run.defaultDatasetId,
      status: run.status,
      scope: scopeSummary(scope),
      estimate: {
        actor: g.actor,
        result_count: g.result_count,
        usd: g.estimate.usd,
        rate_per_1000: g.estimate.rate_per_1000,
      },
      budget: { budget_usd: g.budget_usd, allowed: true, reason: null, shortfall_usd: null },
      // per_post travels with the run: the import caps newest-first using it,
      // and defaulting back to the env value would discard comments already
      // paid for on a deliberately widened scope.
      next: {
        step: 'poll',
        route: '/api/comments',
        method: 'GET',
        query: { runId: run.id, ledgerId: runId, perPost: String(scope.per_post) },
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
