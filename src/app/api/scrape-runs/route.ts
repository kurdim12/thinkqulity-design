import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ScrapeRunRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/scrape-runs?limit=50 — the scrape ledger, newest first.
 *
 * Read-only, and deliberately dumb: it returns the rows as stored. Every row
 * was written BEFORE its actor was called (hard rule 9), so a blocked run and a
 * failed run are exactly as visible here as a successful one. That is the whole
 * point of the ledger — the Data screen must be able to show what a scrape was
 * expected to cost even when it never ran.
 *
 * Totals sum only the rows that actually carry a number. A run whose cost could
 * not be estimated is counted in `runs_without_estimate` and left out of the
 * sum rather than folded in as zero (hard rule 2): "not estimated" and "free"
 * are different facts. With nothing to sum, a total is null — never 0.
 */
export async function GET(request: Request) {
  try {
    await requireOperator();

    const requested = Number(new URL(request.url).searchParams.get('limit'));
    const limit =
      Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

    const { data, error } = await supabaseAdmin()
      .from('scrape_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Could not read the scrape ledger: ${error.message}`);

    const runs = (data as ScrapeRunRow[] | null) ?? [];

    // Postgres `numeric` arrives as a JSON number; coerce defensively but never
    // let a null become a 0 on the way through.
    const estimates: number[] = [];
    const results: number[] = [];
    let runsWithoutEstimate = 0;
    const byStatus: Record<string, number> = {};
    const byKind: Record<string, number> = {};

    for (const run of runs) {
      const usd = run.estimated_usd === null ? null : Number(run.estimated_usd);
      if (usd !== null && Number.isFinite(usd)) estimates.push(usd);
      else runsWithoutEstimate += 1;

      const count = run.actual_results === null ? null : Number(run.actual_results);
      if (count !== null && Number.isFinite(count)) results.push(count);

      byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
      byKind[run.kind] = (byKind[run.kind] ?? 0) + 1;
    }

    const sum = (values: number[]): number | null =>
      values.length === 0 ? null : values.reduce((total, value) => total + value, 0);

    const estimatedTotal = sum(estimates);

    return NextResponse.json({
      runs,
      count: runs.length,
      limit,
      totals: {
        // Rounded to cents because that is the unit the estimate was made in.
        estimated_usd: estimatedTotal === null ? null : Number(estimatedTotal.toFixed(2)),
        runs_with_estimate: estimates.length,
        runs_without_estimate: runsWithoutEstimate,
        actual_results: sum(results),
        runs_with_result_count: results.length,
      },
      by_status: byStatus,
      by_kind: byKind,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
