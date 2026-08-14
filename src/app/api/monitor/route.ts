import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { requireEnv, optionalEnv, hasEnv, apifyBudgetUsd } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSnapshotFrom, type SnapshotResult } from '@/lib/ingest/snapshot';
import { canonicalHandles } from '@/lib/ingest/handles';
import { estimateScrape, checkBudget, type ScrapeEstimate } from '@/lib/ingest/budget';
import { mirrorPostMedia, type MirrorCandidate, type MirrorMediaResult } from '@/lib/ingest/media';
import { scanCoverage, MAX_POSTS_SCAN, type ScanCoverage } from '@/lib/audience/posts';
import { resolveProvider, providerKeyName } from '@/lib/agent/provider';
import { todayIso } from '@/lib/snapshots';
import type { Account, ScrapeKind } from '@/lib/types/db';
import { GET as profileGet, POST as profilePost } from '@/app/api/profile/route';
import { GET as commentsGet, POST as commentsPost } from '@/app/api/comments/route';
import { GET as analyzeGet, POST as analyzePost } from '@/app/api/board/analyze/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DEFAULT_ACTOR = 'apify~instagram-scraper';
const KIND: ScrapeKind = 'monitor';
const RAW_BUCKET = 'brand-assets';
const MAX_RESULTS = 5000;
const MAX_IMPORT_ITEMS = 50_000;
const DATASET_PAGE = 1000;
const DEFAULT_LIMIT = 200;
const DEFAULT_ANALYZE_CHUNK = 25;

/**
 * Instagram monitoring — one operator gesture, several bounded calls.
 *
 * A full-history scrape takes far longer than any HTTP request should live —
 * ten posts per profile already runs ~110s — so the run is started, polled and
 * imported separately rather than held open on one synchronous call. v3 keeps
 * that shape and extends it into a pipeline, because a monitor run is no longer
 * just "fetch posts":
 *
 *   POST { action: "start" }               -> new posts, both accounts
 *   GET  ?runId=…&step=posts               -> poll
 *   POST { action: "import", runId }       -> snapshot, then the media mirror
 *   POST { action: "profile" }             -> follower/bio refresh
 *   POST { action: "comments" }            -> comments for posts entering the top-N
 *   GET  ?runId=…&step=comments            -> poll
 *   POST { action: "comments-import", … }  -> map them into the corpus
 *   POST { action: "analyze" }             -> analyse newly ingested posts (v2 gap)
 *
 * Every response carries `next`: the exact call to make after it. The pipeline
 * is therefore resumable at any step — a failure loses one step, not the run —
 * and no single call is long enough to time out.
 *
 * The steps after the snapshot delegate to /api/profile, /api/comments and
 * /api/board/analyze by importing their handlers directly. That is deliberate:
 * the mapping, the budget guard and the analysis prompt each stay in exactly
 * one place, and there is no self-fetch to deadlock on.
 *
 * Reading only throughout. No Meta OAuth, no Graph API, no write scope.
 */

type Json = Record<string, unknown>;

interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId: string;
  startedAt?: string;
  finishedAt?: string | null;
  usageTotalUsd?: number;
  stats?: { outputItemCount?: number };
}

const ACTIONS = ['start', 'import', 'profile', 'comments', 'comments-import', 'analyze'] as const;
type Action = (typeof ACTIONS)[number];

type Step = 'posts' | 'import' | 'profile' | 'comments' | 'comments-import' | 'analyze' | 'done';

interface NextCall {
  step: Step;
  route: string;
  method: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: Json;
}

function actorId(): string {
  return optionalEnv('APIFY_ACTOR') ?? DEFAULT_ACTOR;
}

function apifyToken(): string {
  if (!hasEnv('APIFY_TOKEN')) {
    throw new HttpError(
      503,
      'Automated monitoring is not configured.',
      'Add APIFY_TOKEN to .env.local (apify.com → Settings → Integrations), or upload an export by hand on the Data screen.',
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

/** Paged, so a large history import is never silently truncated at one page. */
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
 * Hard rule 8: the complete payload lands in storage before any mapping, so the
 * fields v3 does not surface yet stay re-processable without paying to scrape
 * again. Readable afterwards through the existing /api/assets?path=… redirect.
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
 * The same guard /api/profile and /api/comments already put around their own
 * storeRaw, applied to the third and most expensive call site: by the time this
 * runs the posts actor has finished a full-history scrape and has been charged
 * for every result. Letting storeRaw's 502 escape untouched would leave the row
 * inserted moments earlier at status 'running' with actual_results null and
 * raw_path null — the largest spend in the app, with the ledger blind to it.
 *
 * Rule 8 is untouched: raw_path stays null because nothing was stored, and the
 * original error is re-raised so the caller aborts before createSnapshotFrom —
 * nothing is mapped. Only the accounting is repaired. 'error' plus a real result
 * count plus no raw_path is what marks a paid run whose payload was lost.
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

/* ----------------------------------------------------------- the mirror -- */

/**
 * The media mirror, as the import step reports it.
 *
 * `report` is null only when the pass could not be attempted at all — the
 * read-back of the snapshot's rows failed. Every other outcome, including
 * "MIRROR_MEDIA is off", arrives as a real MirrorMediaResult with counts.
 */
interface MirrorOutcome {
  /** The scrape_runs row this pass was recorded on. Null if that write failed. */
  run_id: string | null;
  report: MirrorMediaResult | null;
  /** The read-back that produced the candidates, and whether it hit its cap. */
  scan: ScanCoverage | null;
  /**
   * Rows stored with no raw payload, so no thumbnail URL could be read from
   * them. Null when the read-back never completed — nothing was examined, so
   * there is no count to give (hard rule 2: absent is not zero).
   */
  posts_without_raw: number | null;
  /** A failure around the pass: the read-back, or the ledger write. */
  error: string | null;
}

/**
 * Mirrors the snapshot's post thumbnails into the private bucket.
 *
 * WHY IT IS CALLED HERE. src/lib/ingest/media.ts is the MIRROR_MEDIA flag path
 * the v3 spec asked for, and until now nothing reached it. The import step is
 * where it belongs: raw is already stored, the posts are already parsed and
 * written, and an Instagram CDN URL is at its freshest the moment the scrape
 * that produced it lands — which is the whole reason the module exists.
 *
 * WHY IT READS THE ROWS BACK. createSnapshotFrom() parses and inserts in one
 * call and returns counts, not posts, so the candidates come from the rows it
 * just wrote. That is not a workaround, it is the stricter source: only posts
 * that actually reached the table are mirrored, so an item the parser skipped
 * as unroutable cannot acquire a thumbnail. `account`, `ig_id` and `raw` are
 * exactly the narrow select MirrorCandidate documents.
 *
 * ORDERING. `rank` is the parser's engagement ordering (rank 1 = highest
 * engagement), which is the order MAX_MIRROR_OBJECTS assumes: a pass that hits
 * the cap has mirrored the loudest posts, the ones a Board shows first. No
 * dedupe is needed here and none is done — `posts` is UNIQUE (snapshot_id,
 * ig_id) and this reads ONE snapshot, so there is one row per post by
 * construction.
 *
 * IT CANNOT FAIL THE INGEST. The posts are already committed and the import
 * ledger row is already closed before this is called. mirrorPostMedia() never
 * throws by contract; everything around it — the read-back, the ledger write —
 * is caught here and degrades to a reported `error`. Nothing in this function
 * re-raises.
 *
 * RULE 4. Nothing here mints or returns a signed URL. MirrorMediaResult carries
 * counts only, and a mirrored object is read back exactly the way a raw payload
 * already is: through /api/assets, which requires an operator and 307s to a
 * short-lived signed URL minted inside that route. No URL reaches a client.
 */
async function mirrorSnapshotMedia(snapshotId: string, apifyRunId: string): Promise<MirrorOutcome> {
  const outcome: MirrorOutcome = {
    run_id: null,
    report: null,
    scan: null,
    posts_without_raw: null,
    error: null,
  };

  const db = supabaseAdmin();

  try {
    const { data, error } = await db
      .from('posts')
      .select('account, ig_id, raw')
      .eq('snapshot_id', snapshotId)
      .order('rank', { ascending: true, nullsFirst: false })
      .limit(MAX_POSTS_SCAN);

    if (error) throw new Error(`Could not read the snapshot's posts: ${error.message}`);

    const rows = (data as { account: Account; ig_id: string; raw: Json | null }[] | null) ?? [];
    // Measured on the raw row count, because it is the query that was capped.
    outcome.scan = scanCoverage(rows.length, MAX_POSTS_SCAN);

    const candidates: MirrorCandidate[] = [];
    let withoutRaw = 0;
    for (const row of rows) {
      // `posts.raw` is nullable in the schema. A row with no payload has no
      // thumbnail URL to read, so it is counted rather than handed over as an
      // empty object that would be miscounted as "no media URL".
      if (row.raw === null) {
        withoutRaw += 1;
        continue;
      }
      candidates.push({ account: row.account, ig_id: row.ig_id, raw: row.raw });
    }
    outcome.posts_without_raw = withoutRaw;

    outcome.report = await mirrorPostMedia(candidates, db);
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
  }

  const report = outcome.report;
  const status =
    outcome.error !== null || (report !== null && report.error !== null)
      ? 'error'
      : report === null || !report.enabled
        ? 'skipped'
        : 'done';

  try {
    outcome.run_id = await ledger({
      kind: KIND,
      // No actor is called: the bytes come from Instagram's CDN, not Apify.
      actor: 'internal:mirror-media',
      // scrape_runs has no column for a mirror report, and `input` is where
      // this route already records what a non-actor step did and why — the
      // analyze skip does the same. Written whether the flag was on or off, so
      // "MIRROR_MEDIA is off" is an audited outcome and not a silent skip.
      input: {
        step: 'mirror',
        apify_run_id: apifyRunId,
        snapshot_id: snapshotId,
        enabled: report === null ? null : report.enabled,
        reason: report === null ? outcome.error : report.reason,
        scan: outcome.scan,
        posts_without_raw: outcome.posts_without_raw,
        result: report,
        error: outcome.error,
      },
      // Bandwidth and storage are not Apify spend and have no published rate to
      // price them against. Null means "not estimated", never "free".
      estimated_usd: null,
      // Objects written by this pass. Null — never 0 — when no pass ran, because
      // a pass that did not happen measured nothing (hard rule 2).
      actual_results: report !== null && report.enabled ? report.mirrored : null,
      status,
      raw_path: null,
    });
  } catch (err) {
    // The posts are already stored and the import row is already closed. A
    // ledger failure here is reported, never thrown: losing an ingest over the
    // bookkeeping of a thumbnail pass would be the worse trade.
    const message = err instanceof Error ? err.message : String(err);
    outcome.error = outcome.error === null ? message : `${outcome.error}; ${message}`;
  }

  return outcome;
}

/** The mirror outcome as the import response states it. Counts only, no URLs. */
function mirrorBlock(outcome: MirrorOutcome) {
  const r = outcome.report;
  return {
    run_id: outcome.run_id,
    // Null, not false: "the pass could not be attempted" is not "the flag is
    // off". Every count below is null for the same reason.
    enabled: r === null ? null : r.enabled,
    ran: r !== null && r.enabled,
    reason: r === null ? outcome.error : r.reason,
    scan: outcome.scan,
    posts_without_raw: outcome.posts_without_raw,
    cap: r === null ? null : r.cap,
    considered: r === null ? null : r.considered,
    attempted: r === null ? null : r.attempted,
    mirrored: r === null ? null : r.mirrored,
    already_mirrored: r === null ? null : r.already_mirrored,
    skipped: r === null ? null : r.skipped,
    failed: r === null ? null : r.failed,
    bytes_stored: r === null ? null : r.bytes_stored,
    index_complete: r === null ? null : r.index_complete,
    /** A failure inside the pass, which stopped it early. */
    pass_error: r === null ? null : r.error,
    /** A failure around the pass: the read-back, or the ledger write. */
    error: outcome.error,
    warnings: [
      ...(r === null ? [] : r.warnings),
      ...(outcome.error === null ? [] : [`The media mirror step could not run: ${outcome.error}`]),
    ],
  };
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

function estimateBlock(g: Guard) {
  return {
    actor: g.actor,
    result_count: g.result_count,
    usd: g.estimate.usd,
    rate_per_1000: g.estimate.rate_per_1000,
  };
}

function budgetBlock(g: Guard) {
  return {
    budget_usd: g.budget_usd,
    allowed: g.allowed,
    reason: g.reason,
    shortfall_usd: g.shortfall_usd,
  };
}

function blockedResponse(g: Guard, runId: string | null) {
  return NextResponse.json(
    {
      error: g.reason ?? 'Blocked by the scrape budget guard.',
      hint: 'Raise APIFY_BUDGET_USD, or lower the post limit. Nothing was scraped and nothing was charged.',
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

/* ------------------------------------------------------------ delegation -- */

interface Delegated {
  ok: boolean;
  status: number;
  payload: Json;
}

async function readDelegated(response: Response): Promise<Delegated> {
  const payload = ((await response.json().catch(() => ({}))) ?? {}) as Json;
  return { ok: response.ok, status: response.status, payload };
}

function jsonRequest(origin: string, path: string, body: Json): Request {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(origin: string, path: string): Request {
  return new Request(`${origin}${path}`, { method: 'GET' });
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function int(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

/* ----------------------------------------------------------------- POST --- */

export async function POST(request: Request) {
  try {
    await requireOperator();

    const origin = new URL(request.url).origin;
    const body = ((await request.json().catch(() => ({}))) ?? {}) as {
      action?: unknown;
      profiles?: unknown;
      limit?: unknown;
      runId?: unknown;
      ledgerId?: unknown;
      topN?: unknown;
      perPost?: unknown;
    };

    const requested = str(body.action);
    const action: Action =
      requested !== null && (ACTIONS as readonly string[]).includes(requested)
        ? (requested as Action)
        : 'start';

    /* ---------------------------------------------------------- import --- */
    if (action === 'import') {
      const apifyRunId = str(body.runId);
      if (!apifyRunId) throw new HttpError(400, 'Missing runId.');
      const ledgerId = str(body.ledgerId);

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

      // A run started outside this pipeline has no ledger row yet; give it one
      // rather than importing something the ledger never saw.
      const runRowId =
        ledgerId ??
        (await ledger({
          kind: KIND,
          actor: actorId(),
          input: { step: 'import', apify_run_id: apifyRunId },
          estimated_usd: null,
          actual_results: null,
          status: 'running',
          raw_path: null,
        }));

      const raw = await storeRawOrCloseLedger(runRowId, items, items.length);

      let result: SnapshotResult;
      try {
        result = await createSnapshotFrom(
          [{ name: `apify:run:${apifyRunId}`, payload: items }],
          todayIso(),
          'monitor',
        );
      } catch (err) {
        await db
          .from('scrape_runs')
          .update({ status: 'error', actual_results: items.length, raw_path: raw.path })
          .eq('id', runRowId);
        throw err;
      }

      await db
        .from('scrape_runs')
        .update({ actual_results: items.length, status: 'done', raw_path: raw.path })
        .eq('id', runRowId);

      // The ingest is complete and ledgered by this line. The mirror pass runs
      // after it, on its own ledger row, precisely so that nothing it does —
      // including failing — can reach back and change that.
      const mirror = await mirrorSnapshotMedia(result.snapshot.id, apifyRunId);

      return NextResponse.json({
        ...result,
        step: 'import',
        run_id: runRowId,
        runId: apifyRunId,
        apify_run_id: apifyRunId,
        results: items.length,
        raw_path: raw.path,
        raw_bytes: raw.bytes,
        usageUsd: run.usageTotalUsd ?? null,
        mirror: mirrorBlock(mirror),
        next: {
          step: 'profile',
          route: '/api/monitor',
          method: 'POST',
          body: { action: 'profile' },
        } satisfies NextCall,
      });
    }

    /* --------------------------------------------------------- profile --- */
    if (action === 'profile') {
      // /api/profile does its own budget guard and its own ledger row.
      const delegated = await readDelegated(await profilePost());

      return NextResponse.json({
        step: 'profile',
        ok: delegated.ok,
        status: delegated.status,
        profile: delegated.payload,
        next: {
          step: 'comments',
          route: '/api/monitor',
          method: 'POST',
          body: { action: 'comments' },
        } satisfies NextCall,
      });
    }

    /* -------------------------------------------------------- comments --- */
    if (action === 'comments') {
      // onlyUncovered: a monitor run buys comments for posts ENTERING the
      // top-N, not for the whole top-N again. Posts already in the corpus are
      // skipped, which is the difference between a monitor and a re-scrape.
      const scopeBody: Json = { action: 'start', onlyUncovered: true };
      const topN = int(body.topN);
      const perPost = int(body.perPost);
      if (topN !== null) scopeBody.topN = topN;
      if (perPost !== null) scopeBody.perPost = perPost;

      const delegated = await readDelegated(
        await commentsPost(jsonRequest(origin, '/api/comments', scopeBody)),
      );

      const started = delegated.payload['started'] === true;
      const apifyRunId = str(delegated.payload['apify_run_id']);
      const commentsLedgerId = str(delegated.payload['run_id']);
      // The cap the run was actually bought at, carried through to the import
      // so a widened scope is not trimmed back to the env default.
      const scope = delegated.payload['scope'];
      const scopePerPost = isObject(scope) ? int(scope['per_post']) : null;

      // Nothing to buy, or blocked by the budget: neither is a reason to abandon
      // the run. Move on to the analysis step and let the operator see why.
      const next: NextCall =
        started && apifyRunId !== null
          ? {
              step: 'comments',
              route: '/api/monitor',
              method: 'GET',
              query: {
                runId: apifyRunId,
                step: 'comments',
                ...(commentsLedgerId === null ? {} : { ledgerId: commentsLedgerId }),
                ...(scopePerPost === null ? {} : { perPost: String(scopePerPost) }),
              },
            }
          : { step: 'analyze', route: '/api/monitor', method: 'POST', body: { action: 'analyze' } };

      return NextResponse.json({
        step: 'comments',
        ok: delegated.ok,
        status: delegated.status,
        started,
        comments: delegated.payload,
        next,
      });
    }

    /* ------------------------------------------------- comments-import --- */
    if (action === 'comments-import') {
      const apifyRunId = str(body.runId);
      if (!apifyRunId) throw new HttpError(400, 'Missing runId.');

      const importBody: Json = { action: 'import', runId: apifyRunId };
      const ledgerId = str(body.ledgerId);
      const perPost = int(body.perPost);
      if (ledgerId !== null) importBody.ledgerId = ledgerId;
      if (perPost !== null) importBody.perPost = perPost;

      const delegated = await readDelegated(
        await commentsPost(jsonRequest(origin, '/api/comments', importBody)),
      );

      return NextResponse.json({
        step: 'comments-import',
        ok: delegated.ok,
        status: delegated.status,
        comments: delegated.payload,
        next: {
          step: 'analyze',
          route: '/api/monitor',
          method: 'POST',
          body: { action: 'analyze' },
        } satisfies NextCall,
      });
    }

    /* --------------------------------------------------------- analyze --- */
    if (action === 'analyze') {
      const provider = resolveProvider();
      const keyName = providerKeyName(provider);

      // Closing the v2 gap must not reopen a worse one: a studio with no model
      // key still gets its posts, its followers and its comments. The skip is
      // recorded in the ledger so "why is nothing analysed?" has an answer.
      if (!hasEnv(keyName)) {
        const reason =
          `No model key is configured: the resolved provider is ${provider}, which needs ${keyName}. ` +
          'Posts, profile and comments were unaffected — only the analysis step was skipped.';

        const skippedId = await ledger({
          kind: KIND,
          actor: `internal:board-analyze:${provider}`,
          // No actor is called here, so `input` records what the step was asked
          // to do and why it did not — scrape_runs is the only durable place a
          // skipped step can be audited from.
          input: { step: 'analyze', skipped: true, reason },
          estimated_usd: null,
          actual_results: null,
          status: 'skipped',
          raw_path: null,
        });

        return NextResponse.json({
          step: 'analyze',
          ran: false,
          skipped_reason: reason,
          run_id: skippedId,
          next: null,
          done: true,
        });
      }

      const limit = int(body.limit) ?? DEFAULT_ANALYZE_CHUNK;
      const delegated = await readDelegated(
        await analyzePost(jsonRequest(origin, '/api/board/analyze', { limit })),
      );

      const analyzed = int(delegated.payload['analyzed']) ?? 0;
      const remaining = int(delegated.payload['remaining']);

      await ledger({
        kind: KIND,
        actor: `internal:board-analyze:${provider}`,
        input: { step: 'analyze', limit },
        // Model spend is not Apify spend; the per-post model estimate lives on
        // /api/board/analyze. Null here means "not estimated", never "free".
        estimated_usd: null,
        actual_results: delegated.ok ? analyzed : null,
        status: delegated.ok ? 'done' : 'error',
        raw_path: null,
      });

      // Chunked and resumable, exactly as /api/board/analyze is: keep calling
      // until `remaining` reaches zero.
      const more = delegated.ok && remaining !== null && remaining > 0;

      return NextResponse.json({
        step: 'analyze',
        ran: delegated.ok,
        ok: delegated.ok,
        status: delegated.status,
        analyze: delegated.payload,
        next: more
          ? ({
              step: 'analyze',
              route: '/api/monitor',
              method: 'POST',
              body: { action: 'analyze', limit },
            } satisfies NextCall)
          : null,
        done: !more,
      });
    }

    /* ----------------------------------------------------------- start --- */
    const handles = canonicalHandles();
    const profiles = Array.isArray(body.profiles)
      ? body.profiles.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : (optionalEnv('APIFY_PROFILES')?.split(/[,\s]+/).filter(Boolean) ?? [
          handles.personal,
          handles.academy,
        ]);

    const requestedLimit = int(body.limit);
    const limit =
      requestedLimit !== null && requestedLimit > 0 && requestedLimit <= MAX_RESULTS
        ? requestedLimit
        : DEFAULT_LIMIT;

    if (profiles.length === 0) throw new HttpError(400, 'No Instagram profiles to monitor.');

    const input: Json = {
      directUrls: profiles.map((p) => `https://www.instagram.com/${p.replace(/^@/, '')}/`),
      resultsType: 'posts',
      resultsLimit: limit,
      addParentData: true,
    };

    // Rule 9: priced on what will actually be requested — one result per post,
    // per profile — and checked before a single credit is spent.
    const g = guard(profiles.length * limit);

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

    const runRowId = await ledger({
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
      await supabaseAdmin().from('scrape_runs').update({ status: 'error' }).eq('id', runRowId);
      throw err;
    }

    return NextResponse.json({
      step: 'posts',
      run_id: runRowId,
      runId: run.id,
      apify_run_id: run.id,
      datasetId: run.defaultDatasetId,
      dataset_id: run.defaultDatasetId,
      status: run.status,
      profiles,
      limit,
      estimate: estimateBlock(g),
      budget: budgetBlock(g),
      // Throughput, not money: observed at roughly ten results a second.
      duration_hint_s: Math.ceil((profiles.length * limit) / 10),
      next: {
        step: 'posts',
        route: '/api/monitor',
        method: 'GET',
        query: { runId: run.id, step: 'posts', ledgerId: runRowId },
      } satisfies NextCall,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ------------------------------------------------------------------ GET --- */

/**
 * GET /api/monitor?runId=…&step=posts — poll a run without importing it.
 * GET /api/monitor                    — the whole plan and what it would cost,
 *                                       spending nothing.
 */
export async function GET(request: Request) {
  try {
    await requireOperator();

    const url = new URL(request.url);
    const runId = url.searchParams.get('runId');
    const step: Step = url.searchParams.get('step') === 'comments' ? 'comments' : 'posts';
    const ledgerId = url.searchParams.get('ledgerId');
    const perPost = int(url.searchParams.get('perPost'));

    /* ------------------------------------------------------------ poll --- */
    if (runId) {
      const { data: run } = await apify<{ data: ApifyRun }>(`/actor-runs/${runId}`);
      const done = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status);

      let next: NextCall | null;
      if (!done) {
        next = {
          step,
          route: '/api/monitor',
          method: 'GET',
          query: {
            runId: run.id,
            step,
            ...(ledgerId === null ? {} : { ledgerId }),
            ...(perPost === null ? {} : { perPost: String(perPost) }),
          },
        };
      } else if (run.status === 'SUCCEEDED') {
        next = {
          step: step === 'comments' ? 'comments-import' : 'import',
          route: '/api/monitor',
          method: 'POST',
          body: {
            action: step === 'comments' ? 'comments-import' : 'import',
            runId: run.id,
            ...(ledgerId === null ? {} : { ledgerId }),
            ...(perPost === null || step !== 'comments' ? {} : { perPost }),
          },
        };
      } else {
        // Failed, aborted or timed out: there is nothing to import, and
        // inventing a next step would only hide that.
        next = null;
      }

      return NextResponse.json({
        runId: run.id,
        apify_run_id: run.id,
        step,
        status: run.status,
        itemCount: run.stats?.outputItemCount ?? null,
        item_count: run.stats?.outputItemCount ?? null,
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
        usageUsd: run.usageTotalUsd ?? null,
        done,
        next,
      });
    }

    /* ------------------------------------------------------------ plan --- */
    // Every figure below comes from a route that only reads: no actor is
    // started and no model is called, so the Data screen can show the whole
    // pipeline's cost before the operator commits to any of it.
    const origin = url.origin;
    const handles = canonicalHandles();
    const profiles =
      optionalEnv('APIFY_PROFILES')?.split(/[,\s]+/).filter(Boolean) ?? [
        handles.personal,
        handles.academy,
      ];
    const postsGuard = guard(profiles.length * DEFAULT_LIMIT);

    const [profileRes, commentsRes, analyzeRes] = await Promise.all([
      profileGet(),
      commentsGet(getRequest(origin, '/api/comments?onlyUncovered=true')),
      analyzeGet(),
    ]);
    const [profilePlan, commentsPlan, analyzePlan] = await Promise.all([
      readDelegated(profileRes),
      readDelegated(commentsRes),
      readDelegated(analyzeRes),
    ]);

    return NextResponse.json({
      handles,
      steps: {
        posts: {
          profiles,
          limit: DEFAULT_LIMIT,
          estimate: estimateBlock(postsGuard),
          budget: budgetBlock(postsGuard),
        },
        profile: { ok: profilePlan.ok, ...profilePlan.payload },
        comments: { ok: commentsPlan.ok, ...commentsPlan.payload },
        analyze: { ok: analyzePlan.ok, ...analyzePlan.payload },
      },
      next: {
        step: 'posts',
        route: '/api/monitor',
        method: 'POST',
        body: { action: 'start' },
      } satisfies NextCall,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
