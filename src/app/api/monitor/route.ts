import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { requireEnv, optionalEnv, hasEnv } from '@/lib/env';
import { createSnapshotFrom } from '@/lib/ingest/snapshot';
import { todayIso } from '@/lib/snapshots';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DEFAULT_ACTOR = 'apify~instagram-scraper';
const DEFAULT_PROFILES = ['ahmadkahtan_', 'thinkquality_academyy'];
const MAX_RESULTS = 5000;

/**
 * Instagram monitoring, in three steps.
 *
 * A full-history scrape takes far longer than any HTTP request should live —
 * ten posts per profile already runs ~110s — so the run is started, polled and
 * imported separately rather than held open on one synchronous call:
 *
 *   POST { action: "start" }   -> { runId, datasetId }
 *   GET  ?runId=…              -> { status, itemCount, usageUsd }
 *   POST { action: "import", runId } -> creates the snapshot
 *
 * Reading only throughout. No Meta OAuth, no Graph API, no write scope.
 */

interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId: string;
  startedAt?: string;
  finishedAt?: string | null;
  usageTotalUsd?: number;
  stats?: { outputItemCount?: number };
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

export async function POST(request: Request) {
  try {
    await requireOperator();

    const body = ((await request.json().catch(() => ({}))) ?? {}) as {
      action?: unknown;
      profiles?: unknown;
      limit?: unknown;
      runId?: unknown;
      replaceHistory?: unknown;
    };

    const action = body.action === 'import' ? 'import' : 'start';

    /* ---------------------------------------------------------- import --- */
    if (action === 'import') {
      const runId = typeof body.runId === 'string' ? body.runId : null;
      if (!runId) throw new HttpError(400, 'Missing runId.');

      const { data: run } = await apify<{ data: ApifyRun }>(`/actor-runs/${runId}`);
      if (run.status !== 'SUCCEEDED') {
        throw new HttpError(
          409,
          `That run is ${run.status}, not SUCCEEDED.`,
          'Wait for it to finish before importing.',
        );
      }

      const items = await apify<unknown>(`/datasets/${run.defaultDatasetId}/items?limit=${MAX_RESULTS}`);

      const result = await createSnapshotFrom(
        [{ name: `apify:run:${runId}`, payload: items }],
        todayIso(),
        'monitor',
      );

      return NextResponse.json({ ...result, runId, usageUsd: run.usageTotalUsd ?? null });
    }

    /* ----------------------------------------------------------- start --- */
    const profiles = Array.isArray(body.profiles)
      ? body.profiles.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : (optionalEnv('APIFY_PROFILES')?.split(/[,\s]+/).filter(Boolean) ?? DEFAULT_PROFILES);

    const limit =
      typeof body.limit === 'number' && body.limit > 0 && body.limit <= MAX_RESULTS
        ? Math.floor(body.limit)
        : 200;

    if (profiles.length === 0) throw new HttpError(400, 'No Instagram profiles to monitor.');

    const actor = optionalEnv('APIFY_ACTOR') ?? DEFAULT_ACTOR;

    const { data: run } = await apify<{ data: ApifyRun }>(`/acts/${actor}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        directUrls: profiles.map((p) => `https://www.instagram.com/${p.replace(/^@/, '')}/`),
        resultsType: 'posts',
        resultsLimit: limit,
        addParentData: true,
      }),
    });

    return NextResponse.json({
      runId: run.id,
      datasetId: run.defaultDatasetId,
      status: run.status,
      profiles,
      limit,
      // Rough, from observed throughput — shown so nobody starts a large run blind.
      estimate: `${profiles.length * limit} results max, roughly ${Math.ceil((profiles.length * limit) / 10)}s`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** GET /api/monitor?runId=… — poll a run without importing it. */
export async function GET(request: Request) {
  try {
    await requireOperator();
    const runId = new URL(request.url).searchParams.get('runId');
    if (!runId) throw new HttpError(400, 'Missing runId.');

    const { data: run } = await apify<{ data: ApifyRun }>(`/actor-runs/${runId}`);

    return NextResponse.json({
      runId: run.id,
      status: run.status,
      itemCount: run.stats?.outputItemCount ?? null,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      usageUsd: run.usageTotalUsd ?? null,
      done: ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
