import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { requireEnv, optionalEnv, hasEnv } from '@/lib/env';
import { createSnapshotFrom } from '@/lib/ingest/snapshot';
import { todayIso } from '@/lib/snapshots';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DEFAULT_ACTOR = 'apify~instagram-scraper';
const DEFAULT_PROFILES = ['ahmadkahtan_', 'thinkquality_academyy'];

/**
 * POST /api/monitor — pulls both accounts straight from Apify and writes a
 * snapshot, no manual download-and-upload step.
 *
 * This reads Instagram; it does not touch it. No Meta OAuth, no Graph API, no
 * write scope of any kind — the no-publishing rule is intact. It produces the
 * same snapshot shape as a hand-dropped export, so Refresh, pillars and the
 * gap analysis behave identically either way.
 */
export async function POST(request: Request) {
  try {
    await requireOperator();

    if (!hasEnv('APIFY_TOKEN')) {
      throw new HttpError(
        503,
        'Automated monitoring is not configured.',
        'Add APIFY_TOKEN to .env.local (apify.com → Settings → Integrations), or upload an export by hand on the Data screen.',
      );
    }

    const body: unknown = await request.json().catch(() => ({}));
    const input = (body ?? {}) as { profiles?: unknown; limit?: unknown };

    const profiles = Array.isArray(input.profiles)
      ? input.profiles.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : (optionalEnv('APIFY_PROFILES')?.split(/[,\s]+/).filter(Boolean) ?? DEFAULT_PROFILES);

    const limit =
      typeof input.limit === 'number' && input.limit > 0 && input.limit <= 200
        ? Math.floor(input.limit)
        : 50;

    if (profiles.length === 0) {
      throw new HttpError(400, 'No Instagram profiles to monitor.');
    }

    const actor = optionalEnv('APIFY_ACTOR') ?? DEFAULT_ACTOR;
    const token = requireEnv('APIFY_TOKEN');

    // run-sync-get-dataset-items runs the actor and returns its items in one
    // call, so there is no run id to poll.
    const endpoint = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 280_000);

    let items: unknown;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          directUrls: profiles.map((p) => `https://www.instagram.com/${p.replace(/^@/, '')}/`),
          resultsType: 'posts',
          resultsLimit: limit,
          addParentData: true,
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new HttpError(
          502,
          `Apify returned ${response.status}.`,
          detail.slice(0, 300) ||
            'Check the token is valid and the account has run credits left.',
        );
      }

      items = (await response.json()) as unknown;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HttpError(
          504,
          'The Apify run took too long.',
          'Lower the post limit, or run the scrape in Apify and upload the JSON on the Data screen.',
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const result = await createSnapshotFrom(
      [{ name: `apify:${actor}`, payload: items }],
      todayIso(),
      'monitor',
    );

    return NextResponse.json({ ...result, profiles, limit });
  } catch (err) {
    return errorResponse(err);
  }
}
