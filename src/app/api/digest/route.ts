import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { MissingEnvError } from '@/lib/env';
import { readQuality } from '@/lib/prefs.server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { modelFor } from '@/lib/agent/client';
import { rateFor, unpricedReason } from '@/lib/agent/rates';
import { JUDGE_SYSTEM } from '@/lib/brain/judge';
import { STRATEGIST_SYSTEM } from '@/lib/agent/strategist/system';
import {
  LEDGER_SCAN,
  assessCoverage,
  loadStrategistData,
  renderStrategistBlocks,
  type StrategistCoverage,
} from '@/lib/agent/strategist/blocks';
import {
  NO_MODEL_RAN,
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
  /** Null when this model has no rate anybody verified. Never 0. */
  usd: number | null;
  /** The rates the figure was multiplied by, so the screen can show its work. */
  rate_in_per_mtok: number | null;
  rate_out_per_mtok: number | null;
  unpriced_reason: string | null;
}

/** Rounds UP to the next cent, so a ceiling never reads below what it bounds. */
function ceilToCents(value: number): number {
  // toFixed first: binary floating point turns exact cents into 2.7000000000003
  // and a naive ceil would push $2.70 to $2.71. Same rule /api/board/analyze
  // applies, for the same reason.
  return Math.ceil(Number((value * 100).toFixed(6))) / 100;
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

  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const outputTokens =
    AGENT_CALLS_CEILING * STRATEGIST_MAX_TOKENS + JUDGE_CALLS_CEILING * JUDGE_MAX_TOKENS;

  const base = {
    model,
    calls: { agent_ceiling: AGENT_CALLS_CEILING, judge_ceiling: JUDGE_CALLS_CEILING },
    chars: {
      agent_prompt: agentPromptChars,
      judge_prompt: judgePromptChars,
      candidate_allowance: candidateAllowance,
      judge_overhead_allowance: JUDGE_OVERHEAD_CHARS,
    },
    input_tokens_ceiling: inputTokens,
    output_tokens_ceiling: outputTokens,
    chars_per_token: CHARS_PER_TOKEN,
  };

  // THE TABLE MOVED, AND THIS FOLLOWED IT. Until 2026-08-15 this returned
  // `usd: null` with a reason naming src/app/api/board/analyze/route.ts as the
  // only place a verified rate lived and stating it was not exported. Both
  // halves of that sentence stopped being true when PUBLISHED_RATES became
  // src/lib/agent/rates.ts — so the refusal was no longer a refusal, it was a
  // stale string telling the operator to look in a file that no longer holds
  // the table, beside an em-dash standing in for a figure this route could
  // already compute. The rate is read from the one table now, on the same terms
  // every other estimate reads it: a model nobody has priced still returns null
  // and says so, in the one spelling unpricedReason() owns.
  const rate = rateFor(model);
  if (rate === null) {
    return {
      ...base,
      usd: null,
      rate_in_per_mtok: null,
      rate_out_per_mtok: null,
      unpriced_reason: unpricedReason(model),
    };
  }

  return {
    ...base,
    usd: ceilToCents((inputTokens * rate.in) / 1_000_000 + (outputTokens * rate.out) / 1_000_000),
    rate_in_per_mtok: rate.in,
    rate_out_per_mtok: rate.out,
    unpriced_reason: null,
  };
}

/**
 * The estimate for a run that will call NO MODEL.
 *
 * `assessCoverage()` can already tell, from the loaded data and before a single
 * token is spent, that every corpus a judgement rests on is dark — and the
 * feature answers that case in code (see composeInsufficientPayload). Pricing
 * the prompt that run will never send would over-state the ceiling by the whole
 * of it, and rule 9 is not "produce a number", it is "know what you are about
 * to spend".
 *
 * EVERY FIGURE HERE IS A MEASURED ZERO, not an absence dressed as one: zero
 * agent calls, zero judge passes, zero characters sent, therefore zero tokens
 * and zero dollars. Hard rule 2 forbids a zero standing in for something nobody
 * measured; it does not forbid counting to zero. `unpriced_reason` is null
 * because nothing here is unpriced — the rate table is simply not consulted,
 * since no quantity it multiplies is non-zero. The model reads as an em-dash
 * for the same reason it does everywhere else: none was chosen, because none
 * will run.
 */
function noSpendEstimate(): DigestEstimate {
  return {
    model: NO_MODEL_RAN,
    calls: { agent_ceiling: 0, judge_ceiling: 0 },
    chars: {
      agent_prompt: 0,
      judge_prompt: 0,
      candidate_allowance: 0,
      judge_overhead_allowance: 0,
    },
    input_tokens_ceiling: 0,
    output_tokens_ceiling: 0,
    chars_per_token: CHARS_PER_TOKEN,
    usd: 0,
    rate_in_per_mtok: null,
    rate_out_per_mtok: null,
    unpriced_reason: null,
  };
}

/* ------------------------------------------------- every failure names a fix -- */

/**
 * The fix line for a failure nobody classified.
 *
 * Every stage this route can reach either throws an HttpError carrying its own
 * hint — the auth gate, the input schema, the preflight, the load, the model
 * transport, the Judge, the digest write — or it is a bug. This is the sentence
 * for the last case, and it exists because `errorResponse()` gives an
 * unclassified error `hint: null`, which reaches the screen as a message with
 * nothing to do about it. A card that says only "no" is the defect this phase
 * is closing, and it is closed on the last path as well as the first.
 */
const UNCLASSIFIED_HINT =
  'This failure was not classified, which is itself worth reporting. Reload the Digest screen: if a ' +
  'new digest is at the top, the run finished and only the reply was lost; if the previous one is ' +
  'still there, nothing was written and it is safe to run again. If it repeats, the path is ' +
  'POST /api/digest → strategistFeature.run() in src/lib/agent/features/strategist.ts.';

/**
 * Guarantees the failure card has a cause AND a fix, whatever was thrown.
 *
 * The one non-generic branch is the commonest failure this route has: a run
 * that reaches `runAgentJson` with no provider key configured throws a
 * `MissingEnvError`, which is a plain Error and therefore arrived on screen with
 * `hint: null`. Its message names the variable; the hint names where it is bound
 * in production, which is the half the message cannot know.
 */
function withFix(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  if (err instanceof MissingEnvError) {
    return new HttpError(
      500,
      err.message,
      `Locally: put ${err.key} in .env.local and restart the dev server. In production it is a ` +
        `Worker secret — bind it with: wrangler secret put ${err.key}. Nothing was written, and the ` +
        'digest that was already stored is untouched.',
    );
  }
  const message = err instanceof Error ? err.message : 'Unexpected server error.';
  return new HttpError(500, message, UNCLASSIFIED_HINT);
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
    let coverage: StrategistCoverage | null = null;

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
      // Reported under `?estimate=1` and not on a plain page load, for exactly
      // the reason the estimate is: this needs `loadStrategistData()`, the
      // heaviest read in the app. It is computed here rather than only inside
      // the run so a caller can learn BEFORE clicking that the run will cost
      // nothing and will answer with the blindness rather than with a digest.
      coverage = assessCoverage(data);

      if (coverage.verdict === 'insufficient') {
        // `readiness.can_run` stays true on purpose. This is not a refusal —
        // the run proceeds, costs nothing, and stores a record naming what is
        // dark and what fills it. Refusing here would leave the operator with
        // an error card and no way to produce the record.
        estimate = noSpendEstimate();
      } else {
        const blocks = renderStrategistBlocks(data);
        // The very string the run would send, so the measurement is of the
        // thing being priced rather than of something shaped like it.
        const message = buildStrategistMessage(blocks, input, data);
        estimate = estimateFor(
          modelFor(await readQuality()),
          STRATEGIST_SYSTEM.length + message.length,
          blocks.length,
        );
      }
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
      /**
       * Whether a run could see anything, and which corpora are dark. Null on a
       * plain page load — it was not computed, which is a different fact from
       * "nothing is dark" and is reported as one.
       */
      coverage,
      estimate,
    });
  } catch (err) {
    // `?estimate=1` is a CLICK — the screen calls it before offering to spend —
    // so a failure here ends a run the operator started and has to say what to
    // do about it, exactly like the POST below.
    return errorResponse(withFix(err));
  }
}

/* -------------------------------------------------------------------- POST -- */

/**
 * POST /api/digest — run the strategist over the period ending today.
 *
 * The body is passed to the feature: it owns its own input contract, refuses
 * invalid bodies with a 400, refuses runs with nothing to report at all with a
 * 409, and answers a run that cannot SEE anything with an insufficient-data
 * digest — all three BEFORE any model call. The response is the standard
 * feature outcome (result, persisted, brain) plus nothing this route invented.
 *
 * What comes back describes REQUESTS. `persisted.actions_executed` is false and
 * always will be from this path: `generate_concepts` is a request routed by a
 * human through the concept feature later, not a thing that happens because the
 * strategist asked.
 */
export async function POST(request: Request) {
  try {
    await requireOperator();

    /**
     * A BODY THAT DID NOT PARSE IS NOT AN EMPTY BODY.
     *
     * This was `request.json().catch(() => ({}))`, which turned a malformed
     * body into a default run: the caller asked for one thing, got another, and
     * was told it succeeded. The two cases are separated here. No body at all —
     * which is a legitimate way to ask for the defaults — is `{}`. A body that
     * is present and unparseable is a 400 that says so, because silently
     * running something else is the quiet kind of wrong this app refuses.
     */
    const raw = (await request.text()).trim();
    let body: unknown = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch (parseError) {
        throw new HttpError(
          400,
          `The request body is not valid JSON, so no run was started: ${
            parseError instanceof Error ? parseError.message : 'unparseable'
          }`,
          'Send no body at all to run with the defaults, or send a JSON object with any of ' +
            '`period_days`, `action_budget` and `note`.',
        );
      }
    }

    const quality = await readQuality();

    const outcome = await strategistFeature.run(body, quality);
    return NextResponse.json(outcome);
  } catch (err) {
    return errorResponse(withFix(err));
  }
}
