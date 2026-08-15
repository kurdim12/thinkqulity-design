import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { todayInAmman } from '@/lib/agent/features/strategist';
import type { DecisionRow, DecisionStatus } from '@/lib/types/db';

export const dynamic = 'force-dynamic';

/**
 * The decision ledger.
 *
 * GET   — every decision on record, with the review-due flag computed against
 *         Amman's date rather than the reader's laptop clock.
 * PATCH — an operator records the outcome of ONE open decision.
 *
 * ===========================================================================
 * WHY THE HUMAN VERDICT IS ALLOWED HERE AND SENDING IS NOT
 * ===========================================================================
 * Hard rule 1 forbids this app from acting on the client's behalf. Recording
 * that a decision turned out right or wrong is not an act on the client's
 * behalf — it is the operator writing down what they observed, in the ledger
 * whose entire purpose is to hold that reading. The rule the ledger exists to
 * enforce is that a decision is judged AT ALL, so the screen that shows the
 * overdue ones must also be the screen where the verdict lands.
 *
 * What is still forbidden, and has no path here:
 *   - `digests.sent` — this route touches the `decisions` table and nothing
 *     else. Sending is a human act performed outside the product.
 *   - reopening. There is no transition back to 'open': a verdict that could
 *     be quietly withdrawn would let a decision leave the open list twice, and
 *     the second time nobody would know it had ever been judged.
 *   - editing a closed decision. The update below is scoped `status = 'open'`,
 *     so a decision someone else judged between the page load and the click is
 *     left exactly as they judged it, and the caller is told.
 */

/**
 * The ledger read's ceiling — this route's own, not the strategist's.
 *
 * `LEDGER_SCAN` in src/lib/agent/strategist/blocks.ts caps how much memory the
 * AGENT carries into a run, which is a context-budget question. This caps how
 * many rows a SCREEN lists, which is a reading question. Sharing one number
 * would mean tuning either constraint moved the other.
 */
const DECISION_SCAN = 200;

const DECISION_STATUSES: readonly DecisionStatus[] = [
  'open',
  'validated',
  'refuted',
  'superseded',
];

/** A decision, plus the flag the route computes. Never computed in the browser. */
interface LedgerDecision extends DecisionRow {
  /** Open, and its review date has arrived with no verdict recorded. */
  past_review: boolean;
}

/* --------------------------------------------------------------------- GET -- */

/**
 * GET /api/decisions — the whole ledger, newest decision first.
 *
 * NO STATUS FILTER IS APPLIED HERE, deliberately. The screen filters the loaded
 * set instead, and that is the honest arrangement: a server-side filter would
 * hand the reader a different population per chip, so "how many are open"
 * could not be answered from the response without a second query, and the
 * counts beside the chips would each describe a different read. One read, one
 * population, counts that agree with the rows underneath them.
 *
 * `created_at desc` with a cap means the prefix that survives truncation is the
 * NEWEST part of the ledger. Ordering by `review_after` instead would truncate
 * away the decisions that have not come due yet, which are the ones a reader is
 * least able to reconstruct from memory.
 */
export async function GET() {
  try {
    await requireOperator();
    const db = supabaseAdmin();
    const today = todayInAmman();

    const { data, error } = await db
      .from('decisions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(DECISION_SCAN);

    if (error) throw new Error(`Could not read decisions: ${error.message}`);

    const rows = (data as DecisionRow[] | null) ?? [];
    const decisions: LedgerDecision[] = rows.map((decision) => ({
      ...decision,
      past_review: decision.status === 'open' && decision.review_after <= today,
    }));

    const counts = {} as Record<DecisionStatus, number>;
    for (const status of DECISION_STATUSES) {
      counts[status] = decisions.filter((decision) => decision.status === status).length;
    }

    return NextResponse.json({
      decisions,
      /** Counts OF THIS READ. When truncated they are not the table's totals. */
      counts,
      due_for_review: decisions.filter((decision) => decision.past_review).length,
      /** The read filled its cap, so everything above is a prefix of the ledger. */
      truncated: rows.length >= DECISION_SCAN,
      scan_limit: DECISION_SCAN,
      /** The date `past_review` was computed against, in Amman. */
      today,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ------------------------------------------------------------------- PATCH -- */

/**
 * The verdict an operator may record.
 *
 * 'extended' is absent on purpose. A strategist run may extend a decision — it
 * is reading the whole period and moving a date it set itself — but an operator
 * extending a decision from this screen is the one action that looks like
 * diligence and functions as avoidance: the review date slides, the open list
 * never shrinks, and nothing is ever judged. If a decision needs more time, the
 * next digest is where that case gets made.
 *
 * `outcome_note` is required and non-empty because a status with no reason is
 * not a review — it is a row that changed colour.
 */
const outcomeSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['validated', 'refuted', 'superseded']),
  outcome_note: z.string().trim().min(1).max(2000),
});

/** PATCH /api/decisions — record the outcome of one open decision. */
export async function PATCH(request: Request) {
  try {
    await requireOperator();

    const body: unknown = await request.json().catch(() => ({}));
    const parsed = outcomeSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid request body.',
        parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      );
    }

    const { id, status, outcome_note } = parsed.data;
    const db = supabaseAdmin();

    const { data, error } = await db
      .from('decisions')
      .update({ status, outcome_note })
      // Scoped to open. A decision judged by someone else between the read and
      // this write is left as they judged it, and the caller is told below
      // rather than having their verdict silently overwrite the earlier one.
      .eq('id', id)
      .eq('status', 'open')
      .select('*');

    if (error) throw new Error(`Could not record the outcome: ${error.message}`);

    const updated = (data as DecisionRow[] | null) ?? [];
    if (updated.length === 0) {
      throw new HttpError(
        409,
        'That decision is no longer open, so no outcome was recorded.',
        'It was either judged already — by a digest run or by someone else — or it does not exist. Reload the ledger to see its current verdict; a recorded verdict is not overwritten from this screen.',
      );
    }

    return NextResponse.json({ decision: updated[0] });
  } catch (err) {
    return errorResponse(err);
  }
}
