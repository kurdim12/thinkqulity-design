import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { readQuality } from '@/lib/prefs.server';
import { getFeature, featureIds } from '@/lib/agent/features/registry';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/generate/{feature}
 * Resolves the feature from the registry, runs it, returns the validated
 * result plus whatever it persisted. Adding a feature needs no change here.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ feature: string }> },
) {
  try {
    await requireOperator();
    const { feature: featureId } = await params;

    const feature = getFeature(featureId);
    if (!feature) {
      throw new HttpError(
        404,
        `Unknown feature "${featureId}".`,
        `Available: ${featureIds().join(', ')}.`,
      );
    }

    const body: unknown = await request.json().catch(() => ({}));
    const quality = await readQuality();

    const outcome = await feature.run(body, quality);
    return NextResponse.json(outcome);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Lets the UI discover what the registry currently offers. */
export async function GET() {
  try {
    await requireOperator();
    return NextResponse.json({ features: featureIds() });
  } catch (err) {
    return errorResponse(err);
  }
}
