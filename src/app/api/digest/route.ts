import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { readQuality } from '@/lib/prefs.server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { modelFor } from '@/lib/agent/client';
import { JUDGE_SYSTEM } from '@/lib/brain/judge';
import { STRATEGIST_SYSTEM } from '@/lib/agent/strategist/system';
import {
  LEDGER_SCAN,
  loadStrategistData,
  renderStrategistBlocks,
} from '@/lib/agent/strategist/blocks';
import {
  STRATEGIST_MAX_TOKENS,
  buildStrategistMessage,
  strategistFeature,
  strategistInputSchema,
  strategistPreflight,
  todayInAmman,
} from '@/lib/agent/features/strategist';
import type { DecisionRow, DigestRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The digest: the strategist's output, and the ledger it is accountable to.
 *
 * GET  — the latest digest, the open decisions, and which of them are past
 *        their review date. Optionally an estimate of what a run would cost.
 * POST — run the strategist.
 *
 * THERE IS NO PATH HERE THAT WRITES `digests.sent`, and there is not meant to
 * be. Sending the digest to the client is a human act performed outside this
 * product; a route that flipped that flag would be this app claiming a delivery
 * it did not make (hard rule 1). The column exists so a person can record the
 * fact by hand, in the database, after they have actually sent it.
 */

/* ------------------------------------------------------------ the estimate --
 *
 * Hard rule 9 is estimate before spend. The conventions are the ones
 * /api/board/analyze established and states at length: measure the strings that
 * are actually sent, round upward, surface every assumption beside the number,
 * and return null rather than a figure nobody verified.
 *
 * One difference in kind: analysing the board is a chunked job whose size scales
 * with the number of posts, so its cost had to be projected. A digest is ONE
 * run — at most two agent calls and two Judge passes — and its prompt is a
 * string this route can build and measure exactly, because it is the same string
 * the run sends.
 */

/**
 * Characters per token. AN ASSUMPTION, not a measurement — tokenising needs the
 * vendor's tokeniser, which this app does not have. 2 is chosen for the same
 * reason /api/board/analyze chooses it: it over-states, and over-stating is the
 * safe way for a spend guard to be wrong. It travels to the screen beside the
 * figure so the number is never read as a quote.
 */
const CHARS_PER_TOKEN = 2;

/**
 * The Judge's output ceiling, restated from src/lib/brain/judge.ts, which passes
 * `maxTokens: 8000` and does not export it. RESTATED CONSTANTS DRIFT: if that
 * number changes and this one does not, this ceiling silently under-states.
 * The durable fix is for judge.ts to export it.
 */
const JUDGE_MAX_TOKENS = 8000;

/**
 * An allowance for the parts of the Judge's message this route does not build:
 * the Law summary, the empty-canon placeholder and the task lines. Generous on
 * purpose, and stated rather than assumed to be zero.
 */
const JUDGE_OVERHEAD_CHARS = 2000;

/** The cycle's ceiling: one agent call, one Judge pass, and one retry of each. */
const AGENT_CALLS_CEILING = 2;
const JUDGE_CALLS_CEILING = 2;

interface DigestEstimate {
  model: string;
  calls: { agent_ceiling: number; judge_ceiling: number };
  chars: {
    /** System prompt + user message for one agent call. Measured. */
    agent_prompt: number;
    /** Judge system + the blocks + the allowances below. Measured plus stated. */
    judge_prompt: number;
    /** What the payload could grow to, at the output ceiling. An allowance. */
    candidate_allowance: number;
    judge_overhead_allowance: number;
  };
  input_tokens_ceiling: number;
  output_tokens_ceiling: number;
  /** THE ASSUMPTION. Everything above in tokens rests on it. */
  chars_per_token: number;
  /** Null until a verified per-token rate is reachable from here. Never 0. */
  usd: number | null;
  unpriced_reason: string | null;
}

function estimateFor(model: string, agentPromptChars: number, blocksChars: number): DigestEstimate {
  // The candidate the Judge reads is derived from the payload, and the payload
  // cannot exceed the output ceiling the run passes to the model. Pricing that
  // ceiling over-states — the ceiling covers thinking tokens that never reach
  // the text — which is the direction a spend guard wants.
  const candidateAllowance = STRATEGIST_MAX_TOKENS * CHARS_PER_TOKEN;
  const judgePromptChars =
    JUDGE_SYSTEM.length + blocksChars + candidateAllowance + JUDGE_OVERHEAD_CHARS;

  // The retry sends the base message again plus the violation list. The list is
  // short in practice and is covered by counting the base message twice at the
  // ceiling above; it is named here rather than left as an implied zero.
  const inputChars = AGENT_CALLS_CEILING * agentPromptChars + JUDGE_CALLS_CEILING * judgePromptChars;

  return {
    model,
    calls: { agent_ceiling: AGENT_CALLS_CEILING, judge_ceiling: JUDGE_CALLS_CEILING },
    chars: {
      agent_prompt: agentPromptChars,
      judge_prompt: judgePromptChars,
      candidate_allowance: candidateAllowance,
      judge_overhead_allowance: JUDGE_OVERHEAD_CHARS,
    },
    input_tokens_ceiling: Math.ceil(inputChars / CHARS_PER_TOKEN),
    output_tokens_ceiling:
      AGENT_CALLS_CEILING * STRATEGIST_MAX_TOKENS + JUDGE_CALLS_CEILING * JUDGE_MAX_TOKENS,
    chars_per_token: CHARS_PER_TOKEN,
    usd: null,
    unpriced_reason:
      'The only per-token rates this repository has verified against a vendor price page live in ' +
      'src/app/api/board/analyze/route.ts (PUBLISHED_RATES) and are not exported from that route ' +
      'module. Copying them here would create a second table to go stale, so this estimate is ' +
      'stated in tokens. Move that table to a lib module and this figure becomes a dollar ceiling.',
  };
}

/* --------------------------------------------------------------- readiness -- */

/** Whether a run would be refused, computed without spending anything. */
interface Readiness {
  can_run: boolean;
  /** Why not. Null when it can. */
  error: string | null;
  hint: string | null;
}

function readinessFrom(check: () => void): Readiness {
  try {
    check();
    return { can_run: true, error: null, hint: null };
  } catch (err) {
    if (err instanceof HttpError) {
      return { can_run: false, error: err.message, hint: err.hint ?? null };
    }
    throw err;
  }
}

/* --------------------------------------------------------------------- GET -- */

/**
 * GET /api/digest — the latest digest and the open ledger.
 *
 * `?estimate=1` also assembles the blocks a run would send, measures them, and
 * reports the ceiling and whether the run would be refused at all. It is opt-in
 * because assembling them is the heaviest read in the app: the same one the run
 * itself performs. The screen asks for it when the operator is about to spend,
 * not on every page load.
 *
 * Every open decision carries `past_review`: its review date has arrived and
 * nobody has judged it. That flag is the ledger's whole point — a decision no
 * one read the outcome of stays open and stays visible.
 */
export async function GET(request: Request) {
  try {
    await requireOperator();
    const db = supabaseAdmin();
    const today = todayInAmman();

    const [digestResult, decisionsResult] = await Promise.all([
      db.from('digests').select('*').order('created_at', { ascending: false }).limit(1),
      db
        .from('decisions')
        .select('*')
        .eq('status', 'open')
        .order('review_after', { ascending: true })
        .limit(LEDGER_SCAN),
    ]);

    if (digestResult.error) throw new Error(`Could not read digests: ${digestResult.error.message}`);
    if (decisionsResult.error) {
      throw new Error(`Could not read decisions: ${decisionsResult.error.message}`);
    }

    const digest = (digestResult.data as DigestRow[] | null)?.[0] ?? null;
    const openRows = (decisionsResult.data as DecisionRow[] | null) ?? [];

    const decisions = openRows.map((decision) => ({
      ...decision,
      /** The review date has arrived and no verdict has been recorded. */
      past_review: decision.review_after <= today,
    }));

    const wantsEstimate = new URL(request.url).searchParams.get('estimate') === '1';
    let estimate: DigestEstimate | null = null;
    let readiness: Readiness | null = null;

    if (wantsEstimate) {
      // The defaults. A POST that overrides period_days or action_budget moves
      // two dates and one integer inside the prompt, which is inside the
      // rounding of a ceiling quoted in tokens — so the estimate does not take
      // them, rather than taking them and implying a precision it lacks.
      const input = strategistInputSchema.parse({});
      const data = await loadStrategistData(db, {
        today,
        periodDays: input.period_days,
        actionBudget: input.action_budget,
      });
      readiness = readinessFrom(() => strategistPreflight(data));

      const blocks = renderStrategistBlocks(data);
      // The very string the run would send, so the measurement is of the thing
      // being priced rather than of something shaped like it.
      const message = buildStrategistMessage(blocks, input, data);
      estimate = estimateFor(
        modelFor(await readQuality()),
        STRATEGIST_SYSTEM.length + message.length,
        blocks.length,
      );
    }

    return NextResponse.json({
      digest,
      decisions,
      /**
       * The open ledger read filled its cap, so `decisions` is a prefix of it.
       * Stated rather than presented as the whole ledger.
       */
      decisions_truncated: openRows.length >= LEDGER_SCAN,
      due_for_review: decisions.filter((d) => d.past_review).length,
      today,
      readiness,
      estimate,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* -------------------------------------------------------------------- POST -- */

/**
 * POST /api/digest — run the strategist over the period ending today.
 *
 * The body is passed to the feature untouched: it owns its own input contract,
 * refuses invalid bodies with a 400, and refuses runs with nothing to report
 * with a 409 — both BEFORE any model call. The response is the standard feature
 * outcome (result, persisted, brain) plus nothing this route invented.
 *
 * What comes back describes REQUESTS. `persisted.actions_executed` is false and
 * always will be from this path: `generate_concepts` is a request routed by a
 * human through the concept feature later, not a thing that happens because the
 * strategist asked.
 */
export async function POST(request: Request) {
  try {
    await requireOperator();
    const body: unknown = await request.json().catch(() => ({}));
    const quality = await readQuality();

    const outcome = await strategistFeature.run(body ?? {}, quality);
    return NextResponse.json(outcome);
  } catch (err) {
    return errorResponse(err);
  }
}
