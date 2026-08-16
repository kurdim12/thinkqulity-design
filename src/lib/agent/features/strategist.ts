import { z } from 'zod';
import { HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { runAgentJson } from '@/lib/agent/client';
import type { Quality } from '@/lib/prefs';
import { AMMAN_TIME_ZONE } from '@/lib/audience/timing';
import { accountSchema, grounding } from '@/lib/agent/schemas';
import { STRATEGIST_SYSTEM } from '@/lib/agent/strategist/system';
import {
  BLOCK_TAGS,
  DEFAULT_ACTION_BUDGET,
  DEFAULT_PERIOD_DAYS,
  assessCoverage,
  collectSourceKeys,
  loadStrategistData,
  renderStrategistBlocks,
  strategistEvidence,
  type CorpusGap,
  type StrategistCorpus,
  type StrategistCoverage,
  type StrategistData,
} from '@/lib/agent/strategist/blocks';
import {
  fail,
  pass,
  runLaw,
  schemaValid,
  type CitedClaim,
  type LawReport,
  type LawResult,
} from '@/lib/brain/law';
import { reconcile, runJudge } from '@/lib/brain/judge';
import type { BasisRef, DecisionRow, DigestRow, StrategistPayload } from '@/lib/types/db';
import type { BrainReport, FeatureRunOutcome, RunnableFeature } from './types';

/**
 * The strategist: one run over one period, producing one digest and the
 * decisions that digest commits to.
 *
 * ===========================================================================
 * WHY THIS FILE IS NOT `defineFeature(...)`
 * ===========================================================================
 * Every other feature in this folder is a `defineFeature` call, and this one
 * should be too. It is not, for two reasons, both of them mechanical rather
 * than stylistic — and both fixable in three lines of
 * src/lib/agent/features/types.ts, which is outside this change's scope:
 *
 *   1. NO SYSTEM PROMPT HOOK. `AgentFeature` has no `system` field and
 *      `defineFeature` calls `runAgentJson` without one, so a feature defined
 *      through it always runs under the app-wide prompt in
 *      src/lib/agent/system.ts. The strategist has its own constitution
 *      (src/lib/agent/strategist/system.ts) whose hard limits are the reason
 *      this feature is allowed to speak about the client's account at all.
 *      Running it under the generic prompt would be shipping a different
 *      product with the same name.
 *   2. THE LAW WOULD READ THE WRONG CONTEXT. `defineFeature` traces numbers
 *      against `agentContextEvidence(ctx)` — the declared quantities of the
 *      app-wide four blocks. Every quantity the strategist may state comes from
 *      its own blocks instead, so its evidence is `strategistEvidence(data)`,
 *      and those two pools share almost nothing: an average this agent quoted
 *      correctly, with its key, would be reported as a number that "appears
 *      nowhere in the data it was given". The check would fail every honest run
 *      and pass nothing useful. (Both surfaces now lint against DECLARED
 *      VALUES rather than rendered prose; what differs is whose blocks.)
 *
 * So the Law → Judge → one-retry cycle below is the SAME cycle as
 * `defineFeature`'s, assembled from the same primitives (`runLaw`,
 * `schemaValid`, `runJudge`, `reconcile`), with the two inputs corrected. It is
 * deliberately a copy in shape and naming, so the day `AgentFeature` grows a
 * `system?: string` and a `lawContext?()` this file collapses back into a
 * `defineFeature` call with nothing else changed.
 *
 * ===========================================================================
 * WHAT THIS FEATURE IS FORBIDDEN TO DO
 * ===========================================================================
 * - NO ARITHMETIC. Every figure arrives pre-computed and keyed in the blocks.
 *   `BasisRef.value` is a string, `sourceKeysCheck()` compares it character for
 *   character against the value the blocks actually rendered, and a quoted
 *   figure that was rounded, rescaled or invented fails deterministically
 *   without consulting a model.
 * - NO INLINE CONTENT. There is no field anywhere in this schema that can hold
 *   a hook, a caption or a concept body. Concepts are REQUESTED, via an action
 *   whose spec is `{account, pillar, theme, count}` — the exact input shape of
 *   `conceptsFeature` — and routed by code, later, explicitly.
 * - NO EXECUTION. `persist()` writes the digest and the ledger. It does not run
 *   a single action it was handed. See the note above persistStrategist().
 * - NO SENDING. `digests.sent` is written `false` and is never written again by
 *   this app. A human sends the digest, outside it.
 *
 * ===========================================================================
 * THE ONE PATH WHERE CODE WRITES THE ARABIC
 * ===========================================================================
 * `composeInsufficientPayload()` builds a whole payload — headline, client
 * line, escalation, actions — without calling a model, and every string in it
 * is a constant in this file. That is a genuine exception to how everything
 * else here works and it is deliberate in both directions: the run has exactly
 * one thing to say, saying it differently each week would be the padding this
 * product refuses, and a model asked to report that it cannot see is a model
 * with an incentive. It is also free, which hard rule 9 asks for before it asks
 * for anything else. What guards it is that the strings carry NO digits and
 * every figure the payload states arrives as a `basis` copied verbatim out of
 * the blocks — asserted, against the real Law, in tests/strategist-probes.test.ts.
 */

/* ================================================================ clock === */

/**
 * The run's date, in Amman.
 *
 * Not UTC. Ahmad's week is a Jordanian week, and a digest generated at 01:00
 * Amman is 22:00 UTC the previous day — a UTC clock would stamp that run with
 * yesterday's date and open its period one day early. `AMMAN_TIME_ZONE` is
 * imported from the timing engine rather than restated, so the app has exactly
 * one opinion about which day it is.
 */
const AMMAN_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: AMMAN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function todayInAmman(): string {
  const parts = AMMAN_DATE_FORMAT.formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  // Assembled from named parts rather than trusting en-CA's ordering: the
  // locale renders ISO-shaped dates today, and this way a locale-data change
  // cannot silently reorder the segments into a plausible wrong date.
  const iso = `${part('year')}-${part('month')}-${part('day')}`;
  if (!ISO_DATE.test(iso)) {
    // Unreachable with a working Intl. Throwing beats falling back to UTC: a
    // date that is quietly one day off is exactly the class of wrong number
    // this app refuses to produce.
    throw new Error(`Could not resolve today's date in ${AMMAN_TIME_ZONE}.`);
  }
  return iso;
}

/* ================================================================ input === */

export const strategistInputSchema = z.object({
  /** Days the digest covers, ending today. */
  period_days: z.number().int().min(1).max(90).default(DEFAULT_PERIOD_DAYS),
  /** The most actions this run may ask a human for. Three is a plan. */
  action_budget: z.number().int().min(1).max(6).default(DEFAULT_ACTION_BUDGET),
  /** Anything the operator wants the run to pay attention to. */
  note: z.string().trim().max(500).nullish(),
});

export type StrategistInput = z.infer<typeof strategistInputSchema>;

/* =============================================================== output === */

const isoDateSchema = z
  .string()
  .regex(ISO_DATE, 'must be an ISO date, YYYY-MM-DD');

/**
 * One receipt: a key the blocks emitted, and the value they rendered under it.
 *
 * `value` is `z.string()` and zod does NOT coerce, so a model that returns
 * `{"source_key": "performance.personal.avg_engagement", "value": 508}` fails
 * validation rather than having its number quietly stringified. That is the
 * point: a quantity that never existed as a number in this process cannot have
 * been recomputed, re-rounded or rescaled between the block that measured it
 * and the sentence that states it. See BasisRef in src/lib/types/db.ts.
 */
const basisRefSchema = z.object({
  source_key: z.string().min(1),
  value: z.string().min(1),
});

/**
 * "A claim marked `data` must cite a measurement" is NOT enforced here, and the
 * omission is deliberate. `sourceKeys()` in src/lib/brain/law/source-keys.ts
 * owns that rule, states it at length, and applies it to every claim this file
 * hands it. Enforcing it a second time in the schema would give one rule two
 * mechanisms with different consequences — a zod failure retries inside
 * `runAgentJson` and eventually 502s, a Law violation is stored, judged, and
 * surfaced as needs_human — and the two would drift the first time either was
 * edited. One rule, one owner.
 */

const deltaSchema = z.object({
  label_ar: z.string().min(1),
  direction: z.enum(['up', 'down', 'flat']),
  basis: z.array(basisRefSchema),
  grounding,
});

const findingSchema = z.object({
  statement_ar: z.string().min(1),
  basis: z.array(basisRefSchema),
  grounding,
});

const correctionSchema = z.object({
  /** The ledger decision being corrected. Null when the error was not one. */
  decision_id: z.string().uuid().nullable(),
  what_was_said_ar: z.string().min(1),
  what_is_true_ar: z.string().min(1),
  basis: z.array(basisRefSchema),
});

const proposedDecisionSchema = z.object({
  kind: z.enum(['recommendation', 'experiment', 'alert', 'escalation']),
  statement_ar: z.string().min(1),
  basis: z.array(basisRefSchema),
  grounding,
  /** What would validate or refute this. No expected signal, no decision. */
  expected_signal: z.string().min(1),
  review_after: isoDateSchema,
  /**
   * THE FENCE. "WHEN proposing an experiment → it ships with a cap (max
   * posts/spend), a kill condition, and `review_after`. No open-ended
   * experiments." — the strategist's own decision protocol.
   *
   * These two fields are the third addition to `StrategistPayload`, and they
   * exist because the rule cannot be enforced without them. An open-ended
   * experiment states no number, so the claims-linter passes it; it cites
   * nothing false, so the source-key check passes it; and it reads exactly like
   * a fenced one to anyone skimming Arabic prose. Routing the fence into the
   * prose of `expected_signal` — which the first version of this file did —
   * puts it somewhere no check can reach. The requirement itself is
   * `experimentFenceCheck()`.
   *
   * Required and nullable, like every other optional-in-meaning field in this
   * contract: a recommendation writes `null` twice rather than omitting them,
   * which keeps "this decision has no fence" a statement rather than a gap.
   * Nothing in this schema uses a zod `.default()` — a default makes the
   * schema's input type differ from its output type, and `runAgentJson`'s
   * `z.ZodType<T>` then infers T from the INPUT side, quietly handing the rest
   * of this file a value whose every field is optional.
   */
  cap: z.string().min(1).nullable(),
  kill_condition: z.string().min(1).nullable(),
});

/* ------------------------------------------------------------- actions --- */

/**
 * Fields every action carries, whatever its type.
 *
 * `decision_index` points into `decisions[]` rather than at an id, because a
 * proposed decision has no id until persist() writes it.
 */
const actionBaseShape = {
  do_ar: z.string().min(1),
  owner: z.enum(['operator', 'client']),
  by_date: isoDateSchema.nullable(),
  decision_index: z.number().int().nonnegative().nullable(),
};

/**
 * THE ACTION IS A REQUEST, NOT A DRAFT.
 *
 * `spec` is exactly the input shape of `conceptsFeature` (see concepts.ts:
 * count 1–8, account, theme) so routing one is a pure mapping and not a
 * translation with room for invention. There is no field here for a hook, a
 * caption or a visual direction: the strategist cannot write content in this
 * payload even if it decides it should.
 *
 * `count` is a number and that is not a contradiction of the string rule —
 * the string rule governs MEASUREMENTS, which are quoted from the blocks.
 * `count` is a parameter of a request nobody measured, so it is typed as what
 * it is.
 */
const generateConceptsActionSchema = z.object({
  ...actionBaseShape,
  type: z.literal('generate_concepts'),
  spec: z.object({
    account: accountSchema,
    /** A pillar name as it appears in the blocks, or null for the agent's pick. */
    pillar: z.string().min(1).nullable(),
    theme: z.string().min(1).nullable(),
    count: z.number().int().min(1).max(8),
  }),
});

/**
 * The escape hatch that replaces guessing: a figure the strategist wanted and
 * the blocks did not carry is REQUESTED, and the claim that needed it is
 * written as pending. This is the mechanism behind "you do no arithmetic" —
 * without somewhere to put the request, the pressure to derive the number
 * quietly would fall back on the model.
 */
const requestComputationActionSchema = z.object({
  ...actionBaseShape,
  type: z.literal('request_computation'),
  spec: z.object({
    /** What to compute, in English, for whoever will build it. */
    question_en: z.string().min(1),
    /** The claim this would unlock, in Arabic. */
    would_unlock_ar: z.string().min(1),
  }),
});

/**
 * The escalation channel. "WHEN an anomaly crosses a `<meta>` threshold →
 * `needs_human` with `urgency` and the receipt. Alerts are never buried
 * mid-digest."
 *
 * `urgency` and `basis` are required here because that rule has two halves and
 * both are structural: an alert with no urgency is a sentence, and an alert
 * with no receipt is a feeling. `needs_human` itself stays the boolean
 * `StrategistPayload` declares — see the reconciliation note on the payload
 * schema below — so this spec is where the urgency and the evidence live.
 * `basis` is checked by the Law like every other citation, because
 * strategistClaims() collects it.
 */
const flagNeedsHumanActionSchema = z.object({
  ...actionBaseShape,
  type: z.literal('flag_needs_human'),
  spec: z.object({
    reason_ar: z.string().min(1),
    urgency: z.enum(['now', 'this_week']),
    /**
     * The receipt, and it is a required field: an escalation with no receipt is
     * a feeling, and this is the one output in the payload that wakes a human
     * up. `[]` is the honest value when the thing that needs a human is a
     * measurement that is MISSING — an absence emits no key, so there is
     * nothing to cite. What IS cited here is verified like every other
     * citation: strategistClaims() collects it, so an escalation citing a key
     * nobody measured fails the source-key check exactly as a win would.
     */
    basis: z.array(basisRefSchema),
  }),
});

const actionSchema = z.discriminatedUnion('type', [
  generateConceptsActionSchema,
  requestComputationActionSchema,
  flagNeedsHumanActionSchema,
]);

/* ------------------------------------------------------- ledger review --- */

/**
 * The verdict on one past decision.
 *
 * 'extended' is not a `DecisionStatus`, and deliberately so: an extended
 * decision stays `open` and simply gets a later `review_after`. The alternative
 * — a fourth status — would let a decision leave the open list without anybody
 * having read its outcome, which is the one thing the ledger exists to prevent.
 */
const ledgerReviewSchema = z
  .object({
    decision_id: z.string().uuid(),
    verdict: z.enum(['validated', 'refuted', 'superseded', 'extended']),
    outcome_note_ar: z.string().min(1),
    basis: z.array(basisRefSchema),
    /** Required for 'extended', forbidden otherwise. */
    new_review_after: isoDateSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.verdict === 'extended' && value.new_review_after === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['new_review_after'],
        message: 'an extended decision needs a new review date — otherwise it is not extended, it is forgotten',
      });
    }
    if (value.verdict !== 'extended' && value.new_review_after !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['new_review_after'],
        message: 'only an extended decision may carry a new review date',
      });
    }
  });

/* --------------------------------------------------------------- payload -- */

/** Lines of a client digest, counted the way a reader counts them. */
export function digestLines(clientDigestAr: string): string[] {
  return clientDigestAr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** "At most three lines" — the quiet-week rule, as a number. */
export const QUIET_MAX_LINES = 3;

/**
 * The response contract. It mirrors `StrategistPayload` (src/lib/types/db.ts)
 * field for field, plus three additions, each forced by a rule the operator
 * wrote that the interface has no room to express:
 *
 *   - `actions[].type` and `actions[].spec` — the enum that makes "the agent
 *     never generates content inline" structural rather than advisory.
 *   - `decisions[].cap` and `decisions[].kill_condition` — the fence on an
 *     experiment. See proposedDecisionSchema.
 *   - `ledger_review[]` — `StrategistPayload` gives the agent nowhere to record
 *     a verdict on a past decision, and a ledger that can only be appended to
 *     is a list of promises, not a memory.
 *
 * All three are additive, all three land in the `digests.payload` jsonb, and
 * the assignment below is a compile-time proof that the parsed value is still a
 * `StrategistPayload` — if a field is renamed, dropped or retyped on either
 * side, this line stops compiling. The durable fix is for db.ts (foundation,
 * not this change's file) to absorb them; that is reported, not patched here.
 *
 * ONE RULE THIS SHAPE CANNOT EXPRESS. The system prompt's own sketch writes
 * `needs_human` as a LIST of escalations, each with `urgency` and a receipt;
 * `StrategistPayload` declares it a boolean, and a boolean cannot carry either.
 * Rather than fork the stored type, the urgency and the receipt live on the
 * `flag_needs_human` action, which is the channel this feature was specified
 * around. It is a genuine conflict between two documents in the repository and
 * it is reported rather than silently decided: settling it means either db.ts
 * widening `needs_human`, or the prompt's sketch moving to the actions channel.
 */
export const strategistResponseSchema = z.object({
  period: z.object({ from: isoDateSchema, to: isoDateSchema }),
  status: z.enum(['material', 'quiet']),
  headline_ar: z.string().min(1),
  deltas: z.array(deltaSchema).max(12),
  wins: z.array(findingSchema).max(8),
  concerns: z.array(findingSchema).max(8),
  corrections: z.array(correctionSchema).max(8),
  decisions: z.array(proposedDecisionSchema).max(6),
  actions: z.array(actionSchema).max(12),
  /**
   * `[]` when nothing was due — stated, not omitted. "I read the ledger and
   * nothing needed a verdict" and "I forgot the ledger" are different answers,
   * and only one of them can be written down.
   */
  ledger_review: z.array(ledgerReviewSchema).max(50),
  /** True when this must not be sent until a human has read it. */
  needs_human: z.boolean(),
  client_digest_ar: z.string().min(1),
  /** Operator-only. Never sent to the client. */
  operator_notes: z.array(z.string().min(1)),
});

export type StrategistResponse = z.infer<typeof strategistResponseSchema>;

/** Compile-time proof that the response is still a StrategistPayload. */
const RESPONSE_IS_A_PAYLOAD: (response: StrategistResponse) => StrategistPayload = (response) =>
  response;
void RESPONSE_IS_A_PAYLOAD;

/**
 * ===========================================================================
 * WHAT IS STORED — THE RESPONSE PLUS THE ONE FIELD THE MODEL MAY NOT WRITE
 * ===========================================================================
 * `coverage` is NOT in `strategistResponseSchema`, and that is the point of it.
 * Whether the run could see anything is a fact about the DATABASE, computed by
 * `assessCoverage()` from the same block list the agent reads. A model asked to
 * declare its own blindness would be a model with an incentive, and hard rule
 * 20 already says the model does not write quantities — this is the same
 * doctrine one level up: the model does not write the verdict on its own
 * evidence either. Code writes it, on every run, and the model never sees the
 * field.
 *
 * IT IS PRESENT ON EVERY STORED PAYLOAD, not only on a refusal. That is what
 * makes it a distinction rather than a marker: after this change
 * `payload->'coverage'->>'verdict'` answers "could this run see?" for every row
 * in `digests`, and its ABSENCE identifies a row written before the field
 * existed — which is the honest answer for the one stored quiet digest, rather
 * than back-filling a verdict nobody computed.
 *
 * ---------------------------------------------------------------------------
 * WHY A PAYLOAD FIELD AND NOT A THIRD `digests.status` VALUE
 * ---------------------------------------------------------------------------
 * A third status is the better shape and it is not available here.
 * `digests.status` carries `check (status in ('material','quiet'))` from
 * 0003_strategist.sql, so writing `'insufficient_data'` needs migration 0009 —
 * and until that migration is APPLIED, every insufficient run would raise
 * 23514, roll back, and surface as an opaque database error. That is exactly
 * the 0007 class of defect this phase exists to close: code reserving under a
 * name a CHECK constraint refuses, invisible until something executed it. A
 * distinction that only works on a database nobody has migrated yet is not a
 * distinction; it is a dead button with a nicer name.
 *
 * `payload` is `jsonb not null` and is already where this contract grows: it
 * carries three fields `StrategistPayload` does not declare (`actions[].type`
 * and `.spec`, `decisions[].cap` and `.kill_condition`, `ledger_review[]`). It
 * is queryable — `where payload->'coverage'->>'verdict' = 'insufficient'` — so
 * this is a typed field in a structured column, not a note buried in a blob.
 *
 * THE DURABLE FIX, reported rather than improvised: migration 0009 adds
 * `'insufficient_data'` to the CHECK, `DigestStatus` gains it in
 * src/lib/types/db.ts, and `coverage.verdict` becomes the thing that decides
 * it. Nothing else about this file changes when that happens.
 */
export interface StoredStrategistPayload extends StrategistResponse {
  coverage: StrategistCoverage;
}

/* ========================================================== the checks === */

/**
 * The payload flattened into the claims `sourceKeys()` checks: what was
 * asserted, where in the payload it lives, and what it cited.
 *
 * The flattening belongs here rather than in the Law, exactly as
 * src/lib/brain/law/source-keys.ts says: that module takes plain data so it
 * never has to track this payload's shape. Everything that can carry a `basis`
 * is included — a citation is checked wherever it appears, not only where it is
 * convenient.
 *
 * WHY CORRECTIONS AND LEDGER VERDICTS ARE PASSED AS 'hypothesis'. `grounding`
 * in a CitedClaim drives exactly one rule: a claim marked `data` must cite
 * something. Corrections and verdicts have no grounding field of their own, and
 * forcing them to cite would be actively harmful — the commonest honest reason
 * to refute a decision is that the measurement it was waiting for never
 * arrived, and an absence emits NO key to cite (blocks.ts). Requiring a
 * citation there is a standing invitation to invent one, which is the first
 * failure source-keys.ts exists to stop. Their citations are still checked in
 * full: a key they name must exist and its value must be verbatim.
 */
export function strategistClaims(payload: StrategistResponse): CitedClaim[] {
  const claims: CitedClaim[] = [];

  payload.deltas.forEach((delta, i) =>
    claims.push({ where: `deltas[${i}]`, grounding: delta.grounding, basis: delta.basis }),
  );
  payload.wins.forEach((win, i) =>
    claims.push({ where: `wins[${i}]`, grounding: win.grounding, basis: win.basis }),
  );
  payload.concerns.forEach((concern, i) =>
    claims.push({ where: `concerns[${i}]`, grounding: concern.grounding, basis: concern.basis }),
  );
  payload.decisions.forEach((decision, i) =>
    claims.push({
      where: `decisions[${i}]`,
      grounding: decision.grounding,
      basis: decision.basis,
    }),
  );
  payload.corrections.forEach((correction, i) =>
    claims.push({ where: `corrections[${i}]`, grounding: 'hypothesis', basis: correction.basis }),
  );
  payload.ledger_review.forEach((review, i) =>
    claims.push({ where: `ledger_review[${i}]`, grounding: 'hypothesis', basis: review.basis }),
  );
  // An escalation's receipt is a citation, and this is the output that wakes a
  // human up — the last place a fabricated key should be able to hide. An empty
  // receipt is not a false citation, so it contributes no claim: what it means
  // is that the thing needing a human was never measured, and an absence has no
  // key to cite.
  payload.actions.forEach((action, i) => {
    if (action.type !== 'flag_needs_human') return;
    if (action.spec.basis.length === 0) return;
    claims.push({ where: `actions[${i}].spec`, grounding: 'hypothesis', basis: action.spec.basis });
  });

  return claims;
}

/** Open decisions whose review date has passed. The blocks name these too. */
export function decisionsDueForReview(data: StrategistData): DecisionRow[] {
  return data.ledger.filter(
    (decision) => decision.status === 'open' && decision.review_after <= data.meta.today,
  );
}

/**
 * The ledger review is complete and points at real rows.
 *
 * "Review every open decision whose review_after has passed" is the first
 * clause of the strategist's decision protocol, and it is the one a model under
 * output pressure drops first — the digest reads fine without it, which is
 * exactly the problem. Checked in code: a due decision left unverdicted is a
 * violation, and so is a verdict on a decision that is not on the ledger or is
 * no longer open.
 */
export function ledgerReviewCheck(payload: StrategistResponse, data: StrategistData): LawResult {
  const byId = new Map(data.ledger.map((decision) => [decision.id, decision]));
  const due = decisionsDueForReview(data);
  const reviewed = new Set(payload.ledger_review.map((review) => review.decision_id));

  const problems: string[] = [];

  for (const decision of due) {
    if (!reviewed.has(decision.id)) {
      problems.push(
        `decision ${decision.id} was due for review on ${decision.review_after} and carries no verdict`,
      );
    }
  }

  for (const review of payload.ledger_review) {
    const decision = byId.get(review.decision_id);
    if (!decision) {
      problems.push(`ledger_review names decision ${review.decision_id}, which is not on the ledger`);
      continue;
    }
    if (decision.status !== 'open') {
      problems.push(
        `decision ${review.decision_id} was already ${decision.status} and cannot be verdicted again`,
      );
    }
  }

  const seen = new Set<string>();
  for (const review of payload.ledger_review) {
    if (seen.has(review.decision_id)) {
      problems.push(`decision ${review.decision_id} carries two verdicts in one run`);
    }
    seen.add(review.decision_id);
  }

  for (const [index, correction] of payload.corrections.entries()) {
    if (correction.decision_id !== null && !byId.has(correction.decision_id)) {
      problems.push(
        `corrections[${index}] names decision ${correction.decision_id}, which is not on the ledger`,
      );
    }
  }

  if (problems.length > 0) {
    return fail('strategist-ledger-review', problems.join('; '), 'violation', {
      due: due.length,
      verdicted: payload.ledger_review.length,
    });
  }

  return pass(
    'strategist-ledger-review',
    `${due.length} decision(s) were due for review and ${payload.ledger_review.length} verdict(s) were given, all against open ledger rows.`,
    { due: due.length, verdicted: payload.ledger_review.length },
  );
}

/**
 * A QUIET WEEK IS THREE LINES.
 *
 * "WHEN nothing material changed → `status: 'quiet'`, headline «لا جديد يستحق
 * قرار», at most three lines, zero manufactured insight. Quiet weeks build the
 * trust that makes loud weeks land."
 *
 * Why this needs a check at all: a padded quiet week passes everything else.
 * Its numbers are real and sourced, so the claims-linter clears it; its keys
 * resolve, so the source-key check clears it; it reads like diligence. The
 * padding IS the failure — a week of re-phrased old findings is what teaches a
 * client to stop opening the digest — and the line count is the only mechanical
 * evidence of it that exists.
 *
 * Why here and not as a `superRefine` on the schema: a rejected payload is
 * thrown away by `runAgentJson` and retried with nothing but a zod message,
 * while a Law violation reaches the model as a complaint it can act on, is
 * judged, and is recorded in the report a human reads. The schema is this
 * contract's SHAPE; a padded digest has the right shape and the wrong content,
 * which is what the Law is for.
 *
 * The rule binds to `quiet` alone. The identical six lines under 'material' are
 * a long digest of a busy week, which is a different thing.
 */
export function quietDigestCheck(payload: StrategistResponse): LawResult {
  if (payload.status !== 'quiet') {
    return pass('strategist-quiet-digest', 'This run is not quiet, so the three-line rule does not bind.');
  }
  const lines = digestLines(payload.client_digest_ar);
  if (lines.length > QUIET_MAX_LINES) {
    return fail(
      'strategist-quiet-digest',
      `A quiet week is at most ${QUIET_MAX_LINES} lines and this digest has ${lines.length}. ` +
        'Nothing material happened; say that in three lines and stop. Re-phrasing old findings to ' +
        'fill the space is the padding the rule exists to prevent.',
      'violation',
      { lines: lines.length, max: QUIET_MAX_LINES },
    );
  }
  return pass(
    'strategist-quiet-digest',
    `A quiet week reported in ${lines.length} line(s), within the ${QUIET_MAX_LINES}-line rule.`,
    { lines: lines.length, max: QUIET_MAX_LINES },
  );
}

/**
 * NO OPEN-ENDED EXPERIMENTS.
 *
 * "WHEN proposing an experiment → it ships with a cap (max posts/spend), a kill
 * condition, and `review_after`." The review date is `commitmentsCheck()`'s
 * half; this is the other two thirds.
 *
 * An experiment is the one decision kind that changes what the client publishes
 * before anybody knows whether it works. The cap bounds what it can cost and
 * the kill condition names what would stop it — without them it is not a test,
 * it is a change of direction nobody agreed to. Only the missing half is
 * reported: telling an author their cap is missing when it is not is how a
 * complaint gets ignored.
 */
export function experimentFenceCheck(payload: StrategistResponse): LawResult {
  const experiments = payload.decisions.filter((decision) => decision.kind === 'experiment');
  if (experiments.length === 0) {
    return pass('strategist-experiment-fence', 'No experiment was proposed.');
  }

  const problems: string[] = [];
  payload.decisions.forEach((decision, index) => {
    if (decision.kind !== 'experiment') return;
    if (decision.cap === null) {
      problems.push(`decisions[${index}] is an experiment with no cap`);
    }
    if (decision.kill_condition === null) {
      problems.push(`decisions[${index}] is an experiment with no kill condition`);
    }
  });

  if (problems.length > 0) {
    return fail(
      'strategist-experiment-fence',
      `${problems.join('; ')}. An experiment ships with the most posts or spend it may consume and ` +
        'the observation that would stop it early, or it is not an experiment.',
      'violation',
      { experiments: experiments.length },
    );
  }

  return pass(
    'strategist-experiment-fence',
    `All ${experiments.length} experiment(s) carry a cap and a kill condition.`,
    { experiments: experiments.length },
  );
}

/**
 * STALE DATA MAKES NO NEW CLAIMS.
 *
 * "WHEN `<meta>.staleness_days` exceeds its threshold → the digest opens with
 * the staleness banner and contains no new strategy claims — only the refresh
 * action and anything already grounded."
 *
 * Half of that rule is checkable and this is the half: under staleness, no
 * statement in this run may be badged `data`. The other half — that the digest
 * OPENS with the banner — is a sentence the agent writes in its own Arabic, and
 * a check that pattern-matched it would be checking for a phrase rather than
 * for honesty.
 *
 * Why this needs its own check: every figure in a stale digest is real. It was
 * measured, it is in the blocks, it carries a key, and every other check in the
 * Law passes it. What is false is the tense — a twenty-day-old average
 * presented as the state of the account today. Nothing else here can see a
 * date, so nothing else can see that.
 *
 * The escape is deliberately NOT "relabel the measurement as a hypothesis",
 * which would be a second lie on top of the first. It is: run the refresh
 * action and generate the digest again against fresh numbers.
 */
export function stalenessCheck(payload: StrategistResponse, data: StrategistData): LawResult {
  const days = data.meta.staleness_days;
  const threshold = data.meta.thresholds.stale_after_days;

  if (days === null) {
    return pass(
      'strategist-staleness',
      'There is no snapshot, so no figure here is being described as current.',
    );
  }
  if (days <= threshold) {
    return pass(
      'strategist-staleness',
      `The snapshot is ${days} day(s) old, within the ${threshold}-day threshold.`,
      { staleness_days: days, threshold },
    );
  }

  // The same set the probe suite calls newDataGroundedClaims(): every statement
  // this run badged as a measurement. Corrections and verdicts are not in it —
  // strategistClaims() files them as hypotheses — because correcting a past
  // decision is exactly what a stale run SHOULD still be doing.
  const claimed = strategistClaims(payload).filter((claim) => claim.grounding === 'data');

  if (claimed.length > 0) {
    return fail(
      'strategist-staleness',
      `The snapshot is ${days} day(s) old, past the ${threshold}-day threshold, but this digest ` +
        `states ${claimed.length} claim(s) as measurement: ${claimed.map((c) => c.where).join(', ')}. ` +
        'Past the threshold the digest carries the staleness banner and the refresh action, and ' +
        'makes no new strategy claim — the figures are real but the tense is not.',
      'violation',
      { staleness_days: days, threshold, claims: claimed.map((claim) => claim.where) },
    );
  }

  return pass(
    'strategist-staleness',
    `The snapshot is ${days} day(s) old, past the ${threshold}-day threshold, and the digest makes no claim badged as measurement.`,
    { staleness_days: days, threshold },
  );
}

/**
 * The period is the run's, not the model's. `persist()` writes the dates from
 * the loaded data whatever the payload says, so a mismatch is never stored —
 * but it is still a violation, because an agent that restated the period wrong
 * was reasoning about a window it was not given.
 */
export function periodCheck(payload: StrategistResponse, data: StrategistData): LawResult {
  const expected = data.meta.period;
  if (payload.period.from === expected.from && payload.period.to === expected.to) {
    return pass('strategist-period', `Period restated correctly: ${expected.from} → ${expected.to}.`);
  }
  return fail(
    'strategist-period',
    `The period for this run is ${expected.from} → ${expected.to}, but the payload says ${payload.period.from} → ${payload.period.to}.`,
  );
}

/**
 * Falsifiability, checked. A recommendation whose review date has already
 * passed cannot be judged and is therefore not a recommendation — it is an
 * opinion with a date on it. The action budget is checked here too: both are
 * limits the prompt states and neither can be enforced by a schema, which knows
 * nothing about today or about this run's budget.
 */
export function commitmentsCheck(payload: StrategistResponse, data: StrategistData): LawResult {
  const problems: string[] = [];
  const today = data.meta.today;

  payload.decisions.forEach((decision, index) => {
    if (decision.review_after <= today) {
      problems.push(
        `decisions[${index}] is to be judged on ${decision.review_after}, which is not after today (${today})`,
      );
    }
  });

  payload.ledger_review.forEach((review, index) => {
    if (review.new_review_after !== null && review.new_review_after <= today) {
      problems.push(
        `ledger_review[${index}] extends a decision to ${review.new_review_after}, which is not after today (${today})`,
      );
    }
  });

  payload.actions.forEach((action, index) => {
    if (action.decision_index === null) return;
    if (action.decision_index >= payload.decisions.length) {
      problems.push(
        `actions[${index}] points at decisions[${action.decision_index}], which does not exist`,
      );
    }
  });

  const budget = data.meta.action_budget;
  if (payload.actions.length > budget) {
    problems.push(`${payload.actions.length} actions were requested; the budget for this run is ${budget}`);
  }

  if (problems.length > 0) {
    return fail('strategist-commitments', problems.join('; '), 'violation', {
      decisions: payload.decisions.length,
      actions: payload.actions.length,
      budget,
    });
  }

  return pass(
    'strategist-commitments',
    `${payload.decisions.length} decision(s) are judgeable after today and ${payload.actions.length} action(s) are within the budget of ${budget}.`,
  );
}

/* ============================================================== the text = */

/**
 * Everything the payload SAYS, flattened for the Law and the Judge.
 *
 * Basis values are printed beside their keys because that is what the
 * claims-linter reads: a figure with a key next to it traces back to the
 * blocks, and a figure without one is a number the agent produced on its own —
 * which is what the check is for.
 *
 * NO IDENTIFIER IS FLATTENED HERE, and that is a rule rather than an omission.
 * A decision id is a foreign key, not something the output says to a reader —
 * `client_digest_ar` never prints one — and a uuid's hyphen-separated groups
 * tokenise as five bounded quantities that clear the claim floor
 * (`11111111`, `4111`, `111111111111`, …). Flattening one made the Law demand a
 * source for digits nobody was asserting as a measurement. It went unnoticed
 * only because the RENDERED blocks were being used as the lint context and they
 * carried the same uuid, so the id sourced itself; against declared evidence it
 * is five unsourced numbers on every honest ledger review. Entries are named by
 * POSITION instead, which is what `## Decisions` already did.
 */
export function strategistToText(payload: StrategistResponse): string {
  const refs = (basis: readonly BasisRef[]): string =>
    basis.length === 0
      ? '  (no basis — hypothesis)'
      : basis.map((b) => `  [${b.source_key}] = ${JSON.stringify(b.value)}`).join('\n');

  const sections: string[] = [
    `# ${payload.headline_ar}`,
    `status: ${payload.status} · period ${payload.period.from} → ${payload.period.to}`,
  ];

  if (payload.corrections.length > 0) {
    sections.push(
      `## Corrections\n${payload.corrections
        .map((c) => `- was: ${c.what_was_said_ar}\n- now: ${c.what_is_true_ar}\n${refs(c.basis)}`)
        .join('\n\n')}`,
    );
  }
  if (payload.deltas.length > 0) {
    sections.push(
      `## Deltas\n${payload.deltas
        .map((d) => `- ${d.label_ar} (${d.direction}, ${d.grounding})\n${refs(d.basis)}`)
        .join('\n')}`,
    );
  }
  if (payload.wins.length > 0) {
    sections.push(
      `## Wins\n${payload.wins
        .map((w) => `- ${w.statement_ar} (${w.grounding})\n${refs(w.basis)}`)
        .join('\n')}`,
    );
  }
  if (payload.concerns.length > 0) {
    sections.push(
      `## Concerns\n${payload.concerns
        .map((c) => `- ${c.statement_ar} (${c.grounding})\n${refs(c.basis)}`)
        .join('\n')}`,
    );
  }
  if (payload.ledger_review.length > 0) {
    sections.push(
      `## Ledger review\n${payload.ledger_review
        .map(
          (r, i) =>
            `- [${i}] ${r.verdict}${r.new_review_after ? ` until ${r.new_review_after}` : ''}\n  ${r.outcome_note_ar}\n${refs(r.basis)}`,
        )
        .join('\n')}`,
    );
  }
  if (payload.decisions.length > 0) {
    sections.push(
      `## Decisions\n${payload.decisions
        .map(
          (d, i) =>
            `- [${i}] (${d.kind}, ${d.grounding}) ${d.statement_ar}\n  expected signal: ${d.expected_signal}\n  review after: ${d.review_after}\n${refs(d.basis)}`,
        )
        .join('\n')}`,
    );
  }
  if (payload.actions.length > 0) {
    sections.push(
      `## Actions requested (not executed)\n${payload.actions
        .map(
          (a) =>
            `- ${a.type} · ${a.owner}${a.by_date ? ` · by ${a.by_date}` : ''}: ${a.do_ar}\n  spec: ${JSON.stringify(a.spec)}`,
        )
        .join('\n')}`,
    );
  }

  sections.push(`## Client digest (Arabic)\n${payload.client_digest_ar}`);
  if (payload.operator_notes.length > 0) {
    sections.push(`## Operator notes\n${payload.operator_notes.map((n) => `- ${n}`).join('\n')}`);
  }
  sections.push(`needs_human: ${payload.needs_human}`);

  return sections.join('\n\n');
}

/* ============================================================== the Law == */

/**
 * The Law for this feature: the shared checks, run against the RIGHT context,
 * plus the six checks only this feature can make. Each rule has exactly one
 * home — the schema carries the SHAPE, these carry the RULES, and no rule is
 * enforced in both places, because a rule with two homes is a rule that will
 * one day disagree with itself.
 *
 * `sourceKeys` is the check the whole feature turns on, and it is the Law's own
 * (src/lib/brain/law/source-keys.ts) rather than a second copy living here —
 * `emitted` and `blocks` both come from the same block list the agent read, so
 * the keys verified against are by construction the keys it was shown.
 *
 * `voiceExamples` is deliberately NOT passed. `registerScore` compares text
 * against Ahmad's published captions, and `client_digest_ar` is a client-comms
 * report — a register the strategist's own constitution tells it not to write
 * in. Scoring a report against a caption voice would generate warnings for
 * doing the right thing, and warnings that are wrong are how a report gets
 * skimmed.
 *
 * `context` is the strategist's EVIDENCE — the value half of its keyed measures
 * — which is the entire reason this function exists rather than
 * `defineFeature`'s copy. It is emphatically NOT `blocks`: the rendered blocks
 * carry the client's own captions, the audience's own comments and questions,
 * shipped titles and past decision statements, and a figure inside any of those
 * is text somebody typed, not a measurement. `strategistEvidence()` is the
 * evidence view of the SAME block list the agent read — one assembler, two
 * views — so the pool can never be about a different set of measures than it
 * was shown. See `measureEvidence()` in ../strategist/blocks.ts for the
 * doctrine and for what it costs.
 *
 * `blocks` is still passed, to `sourceKeys` and nowhere else: that check reads
 * the RENDERED measures and compares a cited value character for character
 * against the line it came from, which is a different question from "is this
 * number sourced at all" and needs the rendering to answer it.
 */
function strategistLaw(
  payload: StrategistResponse,
  blocks: string,
  evidence: string,
  data: StrategistData,
  emitted: ReadonlySet<string>,
): LawReport {
  const base = runLaw({
    text: strategistToText(payload),
    context: evidence,
    swatches: data.brand?.palette?.swatches ?? null,
    sourceKeys: { claims: strategistClaims(payload), emitted, blocks },
  });

  const results: LawResult[] = [
    ...base.results,
    // The payload reached here through the same schema, so this re-assertion
    // cannot fail today. It is in the report because the Judge reads Law
    // results as facts, and "the contract holds" is one of the facts it should
    // be reading rather than assuming — and because the day a check downstream
    // of parsing mutates a payload, this is the line that catches it.
    schemaValid(strategistResponseSchema, payload),
    ledgerReviewCheck(payload, data),
    stalenessCheck(payload, data),
    quietDigestCheck(payload),
    experimentFenceCheck(payload),
    periodCheck(payload, data),
    commitmentsCheck(payload, data),
  ];

  const violations = results.filter((r) => !r.passed && r.severity === 'violation');
  const warnings = results.filter((r) => !r.passed && r.severity === 'warning');
  return { results, violations, warnings, passed: violations.length === 0 };
}

/* ============================================================ preflight == */

/**
 * Refuse before spending.
 *
 * Two refusals, and neither is a taste judgement:
 *
 *   1. NO BRAND RECORD. Every claim the strategist makes is about a brand it
 *      has never read. There is nothing to be careful with.
 *   2. NO MATERIAL DATA AT ALL. When there is no snapshot, no profile
 *      observation, no audience insight, no shipped concept and no decision on
 *      the ledger, every block is an absence and the only honest digest is one
 *      sentence long — which a model call is not needed to write. This is the
 *      shape of hard rule 9: the cheapest correct answer is not a model call.
 *
 * Staleness is deliberately NOT a refusal. A stale snapshot still supports a
 * true digest, and the constitution already says what to do with one: open with
 * the staleness banner and make no new strategy claims.
 */
export function strategistPreflight(data: StrategistData): void {
  if (!data.brand) {
    throw new HttpError(
      409,
      'The brand record has not been seeded, so there is nothing to write a digest about.',
      'Seed the brand on the Brand screen, then run the digest again.',
    );
  }

  const hasSnapshot = data.performance.snapshot !== null;
  const hasProfile = Object.values(data.profiles).some((observation) => observation !== null);
  const hasAudience = data.audience !== null;
  const hasShipped = data.content.shipped.length > 0;
  const hasLedger = data.ledger.length > 0;

  if (!hasSnapshot && !hasProfile && !hasAudience && !hasShipped && !hasLedger) {
    throw new HttpError(
      409,
      'There is no measured data of any kind to report on yet — no snapshot, no profile observation, no audience insight, no shipped content and no past decision.',
      'Run the monitor or upload an engagement export on the Data screen, then run the digest again.',
    );
  }
}

/* =================================================== the insufficient run == */

/**
 * ===========================================================================
 * "I CANNOT SEE" IS AN ANSWER, AND IT COSTS NOTHING TO GIVE
 * ===========================================================================
 * `assessCoverage()` (src/lib/agent/strategist/blocks.ts) decides the FACTS:
 * which of the three judgement corpora are dark, in what way, and what measure
 * proves it. This section decides the WORDS, and then composes the whole
 * payload in code.
 *
 * NO MODEL RUNS ON THIS PATH. Hard rule 9 is estimate before spend and its
 * sharper half is that the cheapest correct answer is not a model call. There
 * is nothing here for a model to judge — the finding is that there is nothing
 * to judge — so the run makes zero calls, spends zero tokens, and reports all
 * three as zeros rather than as a model name nobody used.
 *
 * NO LAW AND NO JUDGE RUN ON THIS PATH EITHER, and that is a decision rather
 * than an oversight. The Law exists to catch a model inventing a figure. Every
 * string below is a code-owned constant containing no digit, and every figure
 * that appears anywhere in this payload arrives as a `basis` entry copied
 * verbatim out of `collectMeasures()`. Running an invention detector over text
 * that cannot invent is theatre, and it buys a failure mode — a Law violation
 * on this path has no retry to offer, because there is no author to complain
 * to. What replaces it is a PROBE: tests/strategist-probes.test.ts runs the
 * composed payload through the real schema and the real source-key check and
 * asserts both clear. The gate is executed; it is executed in the suite rather
 * than on every run.
 *
 * WHY IT STILL WRITES A ROW. The screen reads the LATEST digest. A refusal that
 * returned only an error card would vanish on reload and the operator would be
 * looking at the previous quiet digest again — the same dead-button reading,
 * one costume over. The run happened, so the run is a fact, and the fact is
 * stored with its evidence.
 */

/** What a human is told about one dark corpus. No digits, in either language. */
interface GapCopy {
  /** What cannot be judged while it is dark. True in every state of it. */
  blind_to_ar: string;
  blind_to_en: string;
  /** The ONE action that fills it. */
  fill_ar: string;
  fill_en: string;
  /** What filling it would unlock, for `request_computation.would_unlock_ar`. */
  unlocks_ar: string;
}

/**
 * One entry per corpus, and each sentence is written to hold in EVERY state of
 * that corpus — read-and-empty, read-and-too-thin, or not read at all. That is
 * why they say what cannot be built rather than what is or is not in the table:
 * "there is no analysis to build a statement on" is true whether the table is
 * empty or was never opened, while "the table is empty" would be a claim about
 * a read nobody performed. The precise state travels in English, per gap, in
 * `operator_notes` — where the operator, not the client, reads it.
 */
const GAP_COPY: Record<StrategistCorpus, GapCopy> = {
  post_analyses: {
    blind_to_ar: 'لا يوجد تحليل نبني عليه أي كلام عن نوع المحتوى الذي يشتغل.',
    blind_to_en:
      'No cluster aggregate exists, so nothing about which kind of content works can be stated as measurement.',
    fill_ar: 'افتحوا شاشة اللوحة وشغّلوا تحليل المنشورات حتى يكتمل.',
    fill_en: 'Open /board and run "Analyze all" until it reads complete.',
    unlocks_ar: 'أي نوع محتوى يشتغل فعلاً، برقم لا برأي.',
  },
  comments: {
    blind_to_ar: 'لا توجد بين أيدينا تعليقات نقرأ منها ما يسأل عنه الجمهور.',
    // "hard rule ten", spelled, for the reason blocks.ts spells it: a bare
    // numeral loose in prose is a quantity somebody could quote with no key
    // behind it, and every string here ends up inside linted text.
    blind_to_en:
      'The comment corpus supports no reading, so nothing about what the audience asks or wants can be stated. Aggregate only — hard rule ten.',
    fill_ar: 'شغّلوا سحب التعليقات من شاشة البيانات، ثم ولّدوا قراءة الجمهور.',
    fill_en:
      'Run /data → Automated scrapes → "Run comment scrape" (aggregate only), then /audience → Generate.',
    unlocks_ar: 'ما الذي يسأل عنه الجمهور فعلاً، بصيغة تجميعية.',
  },
  profile_snapshots: {
    blind_to_ar: 'لا توجد قراءتان مؤرّختان للمتابعين، وبدون نقطتين لا حركة يمكن قياسها.',
    blind_to_en:
      'Fewer than two dated profile observations exist on either account, so no follower movement can be measured at all.',
    fill_ar: 'شغّلوا سحب الحسابات من شاشة البيانات، وأعيدوه لاحقاً حتى تتوفّر نقطتان مؤرّختان.',
    fill_en:
      'Run /data → Automated scrapes → "Run profile scrape", and run it again later so two dated points exist.',
    unlocks_ar: 'حركة المتابعين بين قراءتين مؤرّختين.',
  },
};

/** The state, in the operator's language. Kept out of the Arabic on purpose. */
const GAP_STATE_EN: Record<CorpusGap['state'], string> = {
  absent: 'read, and there is nothing in it',
  too_thin: 'read, and there is not enough of it to support a judgement',
  uncounted: 'NOT READ this run, so its state is unknown — which is not the same as empty',
};

/** One operator-facing line per gap: the corpus, its state, and the one fix. */
export function gapNote(gap: CorpusGap): string {
  const copy = GAP_COPY[gap.corpus];
  return `${gap.corpus} — ${GAP_STATE_EN[gap.state]}. ${copy.blind_to_en} Fill: ${copy.fill_en}`;
}

/**
 * The headline, the client line and the escalation. Code-owned, digit-free, and
 * the same every time — an insufficient run has exactly one thing to say and
 * saying it differently each week would be the padding this product refuses.
 */
const INSUFFICIENT_HEADLINE_AR = 'لا يوجد ما يكفي للحكم بعد — وهذا ما ينقص بالضبط';

/**
 * WHAT THE CLIENT WOULD RECEIVE, and what he would not. The fills below are
 * scrapes and analyses the OPERATOR runs; a client digest listing them would be
 * this studio's chores sent out as if they were his. So the client line says
 * the true thing in his register and stops, and every fill lives in the
 * actions, whose owner is `operator`, and in `operator_notes`, which are never
 * sent.
 */
const INSUFFICIENT_CLIENT_DIGEST_AR = [
  // Not «ما رح نبعت» — this text IS the thing a human would send, so a line
  // about sending it would be the product narrating a delivery it does not
  // make (hard rule 1). It says what is true about the WEEK instead.
  'ما في قراءة هالأسبوع، وهاد مقصود.',
  'القياسات اللي بتقوم عليها القراءة لسّه ناقصة، وأي رأي فوقها بصير تخمين.',
  'عم نكمّلها، وبنرجعلك بقراءة حقيقية — مش بتعبئة فراغ.',
].join('\n');

const INSUFFICIENT_ESCALATION_AR =
  'هذا التقرير لا يحكم على شيء: المصادر التي يقوم عليها الحكم غير متوفّرة بعد. أدناه ما ينقص بالضبط، وما الذي يفتحه كل واحد منها.';

/**
 * The whole payload for a run that cannot see, assembled from the gaps.
 *
 * `status: 'material'` and the reasoning is the point of this whole change. It
 * is emphatically NOT `'quiet'` — that value means "the period was read and
 * nothing moved", which is the false sentence being replaced. And it is not a
 * neutral third thing, because the column has no third thing (see
 * StoredStrategistPayload). Of the two values that exist, `'material'` is the
 * true one: this run changes what the operator does this week, it carries named
 * actions and an escalation, and it must not be read as a week with nothing in
 * it. The empty lists under a `'material'` header provoke the question "why is
 * this empty?" — whose answer is `coverage.gaps`, right there in the same row.
 * The empty lists under `'quiet'` provoke no question at all, which is exactly
 * how a working digest got read as a dead button.
 *
 * The action list is NOT trimmed to `meta.action_budget`. The budget bounds what
 * a strategist may ASK A HUMAN TO DO on top of their week; these are not new
 * work, they are the read that has to exist before any of this product means
 * anything, and dropping one to fit a ceiling would hide a corpus. It is the one
 * rule this path knowingly does not apply, and it is stated here rather than
 * discovered by someone wondering why `commitmentsCheck` was skipped.
 */
export function composeInsufficientPayload(
  data: StrategistData,
  coverage: StrategistCoverage,
): StoredStrategistPayload {
  const due = decisionsDueForReview(data);

  // Every receipt the gaps carry, de-duplicated by key. A gap whose proof is an
  // absence contributes nothing — an absence emits no key, and an escalation
  // with an empty receipt is the honest shape when the thing that needs a human
  // is a measurement that was never taken.
  const seen = new Set<string>();
  const receipts: BasisRef[] = [];
  for (const gap of coverage.gaps) {
    for (const ref of gap.basis) {
      if (seen.has(ref.source_key)) continue;
      seen.add(ref.source_key);
      receipts.push(ref);
    }
  }

  const notes = [
    'Coverage: insufficient. Every corpus a judgement rests on is dark, so this run made NO model call, spent nothing, and states no finding. What is recorded is the blindness itself, with the measure that proves each half of it and the one action that fills it.',
    ...coverage.gaps.map(gapNote),
  ];

  if (due.length > 0) {
    notes.push(
      `${due.length} open decision(s) are past their review date and carry NO verdict from this run: judging them needs the data that is missing. They stay open and stay visible on /decisions — that is the ledger working, not a step skipped.`,
    );
  }

  return {
    period: { from: data.meta.period.from, to: data.meta.period.to },
    status: 'material',
    headline_ar: INSUFFICIENT_HEADLINE_AR,
    // Nothing was judged, and every list says so by being empty rather than by
    // being filled with a re-phrasing of the same sentence.
    deltas: [],
    wins: [],
    concerns: [],
    corrections: [],
    decisions: [],
    actions: [
      {
        type: 'flag_needs_human',
        do_ar: 'اقرأوا هذا قبل أي شيء آخر هالأسبوع: القراءة مش ناقصة رأي، ناقصة قياس.',
        owner: 'operator',
        by_date: null,
        decision_index: null,
        spec: {
          reason_ar: INSUFFICIENT_ESCALATION_AR,
          // Not 'now'. Nothing broke this week; the corpora have been dark since
          // the beginning, and an urgency that cries every run stops being read.
          urgency: 'this_week',
          basis: receipts,
        },
      },
      ...coverage.gaps.map((gap) => ({
        type: 'request_computation' as const,
        do_ar: GAP_COPY[gap.corpus].fill_ar,
        owner: 'operator' as const,
        by_date: null,
        decision_index: null,
        spec: {
          question_en: GAP_COPY[gap.corpus].fill_en,
          would_unlock_ar: GAP_COPY[gap.corpus].unlocks_ar,
        },
      })),
    ],
    ledger_review: [],
    needs_human: true,
    client_digest_ar: INSUFFICIENT_CLIENT_DIGEST_AR,
    operator_notes: notes,
    coverage,
  };
}

/* =============================================================== prompt == */

/** Output ceiling for one strategist call. Covers thinking plus the payload. */
export const STRATEGIST_MAX_TOKENS = 24000;

const RESPONSE_SCHEMA_TEXT = `{
  "period": {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"},
  "status": "material|quiet",
  "headline_ar": "string  // one line, Arabic",
  "deltas": [{
    "label_ar": "string",
    "direction": "up|down|flat",
    "basis": [{"source_key": "string", "value": "string  // VERBATIM from the block line"}],
    "grounding": "data|hypothesis"
  }],
  "wins":     [{"statement_ar": "string", "basis": [{"source_key": "string", "value": "string"}], "grounding": "data|hypothesis"}],
  "concerns": [{"statement_ar": "string", "basis": [{"source_key": "string", "value": "string"}], "grounding": "data|hypothesis"}],
  "corrections": [{
    "decision_id": "uuid|null",
    "what_was_said_ar": "string",
    "what_is_true_ar": "string",
    "basis": [{"source_key": "string", "value": "string"}]
  }],
  "decisions": [{
    "kind": "recommendation|experiment|alert|escalation",
    "statement_ar": "string",
    "basis": [{"source_key": "string", "value": "string"}],
    "grounding": "data|hypothesis",
    "expected_signal": "string  // the observable that would validate or refute it",
    "review_after": "YYYY-MM-DD  // must be after today",
    "cap": "string|null  // REQUIRED for kind \\"experiment\\": the most posts or spend it may consume",
    "kill_condition": "string|null  // REQUIRED for kind \\"experiment\\": what would stop it early"
  }],
  "actions": [{
    "type": "generate_concepts|request_computation|flag_needs_human",
    "do_ar": "string  // one line: what a human does, and why now",
    "owner": "operator|client",
    "by_date": "YYYY-MM-DD|null",
    "decision_index": "number|null  // index into decisions[], or null",
    "spec": "one of: {\\"account\\":\\"personal|academy\\",\\"pillar\\":\\"string|null\\",\\"theme\\":\\"string|null\\",\\"count\\":1-8} | {\\"question_en\\":\\"string\\",\\"would_unlock_ar\\":\\"string\\"} | {\\"reason_ar\\":\\"string\\",\\"urgency\\":\\"now|this_week\\",\\"basis\\":[{\\"source_key\\":\\"string\\",\\"value\\":\\"string\\"}]}"
  }],
  "ledger_review": [{
    "decision_id": "uuid  // from the <ledger> block",
    "verdict": "validated|refuted|superseded|extended",
    "outcome_note_ar": "string  // what the review found",
    "basis": [{"source_key": "string", "value": "string"}],
    "new_review_after": "YYYY-MM-DD when verdict is \\"extended\\", otherwise null"
  }],
  "needs_human": "boolean",
  "client_digest_ar": "string  // Arabic, WhatsApp-shaped, <= 180 words",
  "operator_notes": ["string  // operator only, never sent"]
}`;

/**
 * The whole user message: the blocks, then the task.
 *
 * Exported because the route measures it to estimate the run before spending on
 * it — an estimate computed from a different string than the one that gets sent
 * is not an estimate.
 */
export function buildStrategistMessage(
  blocks: string,
  input: StrategistInput,
  data: StrategistData,
): string {
  const due = decisionsDueForReview(data);
  const note = input.note?.trim();
  const staleness = data.meta.staleness_days;

  return [
    blocks,
    '',
    '## Task',
    `Run the digest for ${data.meta.period.from} → ${data.meta.period.to}. Today is ${data.meta.today}.`,
    note ? `Operator note for this run: "${note}".` : '',
    '',
    '### Rules specific to this run',
    '- EVERY number, date, name or quotation you state carries a `basis` entry: the `source_key` of the block line it came from and that line\'s value copied character for character between the quotes. A value you retyped, rounded, translated or reformatted is a different value and is rejected in code — copy it.',
    '- You do NO arithmetic. Differences, averages, ratios, multiples and counts either exist as their own keyed lines or they do not exist. If you need one that is missing, request it with a `request_computation` action and write the claim as pending.',
    '- A line beginning "(no measurement)" has no key. Write an em-dash «—» for it. Never zero, never an estimate, never "roughly".',
    `- \`period\` is fixed for this run: from ${data.meta.period.from} to ${data.meta.period.to}. Copy those two dates exactly.`,
    due.length > 0
      ? `- LEDGER REVIEW FIRST. ${due.length} decision(s) are due for review right now and every one of them needs a verdict in \`ledger_review\`: ${due
          .map((decision) => `${decision.id} (review_after ${decision.review_after})`)
          .join(', ')}. A refuted decision also goes in \`corrections\` and leads the digest.`
      : '- No decision is due for review this run, so `ledger_review` is `[]`. Do not verdict a decision that is not due.',
    `- Every decision you propose must be judgeable: \`expected_signal\` names the observable, and \`review_after\` is a real date AFTER today (${data.meta.today}). An experiment additionally carries \`cap\` and \`kill_condition\`, both non-null — an open-ended experiment is rejected before anyone reads it.`,
    `- At most ${data.meta.action_budget} action(s), ranked, each with one line of why-now in \`do_ar\`.`,
    staleness !== null && staleness > data.meta.thresholds.stale_after_days
      ? `- THE DATA IS STALE. The newest snapshot is ${staleness} days old against a threshold of ${data.meta.thresholds.stale_after_days}. Open the digest by saying so, ask for the refresh, and make NO new claim badged \`grounding: "data"\` — not one, anywhere. The figures below are real; describing them as the state of the account today is not. Correcting a past decision is still allowed and still expected.`
      : '',
    `- A quiet week is at most ${QUIET_MAX_LINES} lines in \`client_digest_ar\`. That is enforced, not encouraged: a padded quiet week is the fastest way to teach a client to stop reading.`,
    '- An escalation goes in a `flag_needs_human` action and carries its `urgency` and its `basis`. An alert with no urgency is a sentence; an alert with no receipt is a feeling.',
    '- YOU NEVER WRITE CONTENT. There is no field here for a hook, a caption, a script or a visual direction. When the answer is "post about X", the answer is a `generate_concepts` action carrying `{account, pillar, theme, count}` — a request that a human routes to the concept generator. Writing the concept yourself is the one thing this payload cannot express.',
    '- Actions are REQUESTS. Nothing in this system executes them because you asked. Write each one as a thing a named human does.',
    '- `needs_human` is a single boolean. Put the reason in `operator_notes`, and if it is urgent add a `flag_needs_human` action carrying the urgency.',
    '- Nothing material happened is a real answer: `status: "quiet"`, a headline that says so, at most three lines, empty lists. Do not pad.',
    '- `client_digest_ar` is assembled ONLY from parts already in this payload. Warm, direct, professional Arabic — client register, not caption voice. No model, no prompt, no token, no agent, no mention of this system. Never say or imply it was sent.',
    '- Write the `_ar` fields in Arabic. Source keys, `direction`, `kind`, `type` and `owner` stay exactly as spelled below.',
    '',
    '## Response schema',
    'This schema is what is validated in code, and it is authoritative for this run wherever the sketch in your system prompt reads differently.',
    RESPONSE_SCHEMA_TEXT,
  ]
    .filter(Boolean)
    .join('\n');
}

/* ============================================================== persist == */

/**
 * The expected signal as the ledger row stores it: the agent's text, plus the
 * cap and kill condition on their own lines when the decision has them. The
 * labels are ASCII and code-owned so the halves can be told apart later by
 * something other than a human reading Arabic.
 */
export function fencedSignal(decision: StrategistResponse['decisions'][number]): string {
  const lines = [decision.expected_signal];
  if (decision.cap !== null) lines.push(`[cap] ${decision.cap}`);
  if (decision.kill_condition !== null) lines.push(`[kill_condition] ${decision.kill_condition}`);
  return lines.join('\n');
}

interface StrategistPersisted {
  digest: DigestRow;
  decisions_written: number;
  ledger_updated: number;
  /** Ledger writes that failed AFTER the digest was stored. Never swallowed. */
  ledger_write_errors: string[];
  concept_requests: number;
  computation_requests: number;
  human_flags: number;
  /** Always false. This path requests actions; it does not run them. */
  actions_executed: boolean;
  needs_human: boolean;
  /** Null when no Judge ran — an insufficient-data run calls no model at all. */
  judge_score: number | null;
  /** Whether the run could see anything, and what was dark. Computed in code. */
  coverage: StrategistCoverage;
}

/**
 * Writes the digest, applies the ledger review, records the new decisions.
 *
 * WHAT IT DOES NOT DO: execute an action. Not one. `actions` is a list of
 * requests addressed to a human — `generate_concepts` included, which is why
 * its spec is the concept feature's input shape and not its output. An executor
 * would be a separate route that a person invokes deliberately, with its own
 * spend estimate; there is none in this change, and `actions_executed: false`
 * is returned so a caller can never mistake a request for a result.
 *
 * `sent` is written `false` and this app contains no path that writes it again.
 * Sending is a human act performed outside the product (hard rule 1).
 *
 * Ordering: digest first, then the ledger. Once the digest row exists the run
 * is a fact, so a later failure is REPORTED rather than thrown — throwing would
 * tell the operator the run failed while its digest sits in the table.
 */
async function persistStrategist(
  payload: StoredStrategistPayload,
  data: StrategistData,
  brain: BrainReport | null,
): Promise<StrategistPersisted> {
  const db = supabaseAdmin();

  const { data: inserted, error } = await db
    .from('digests')
    .insert({
      // The dates come from the loaded run, never from the model: the payload's
      // own period is checked against these, and the check is what fails — the
      // stored row is never the model's opinion about which week this was.
      period_from: data.meta.period.from,
      period_to: data.meta.period.to,
      status: payload.status,
      payload,
      client_digest_ar: payload.client_digest_ar,
      // NEVER true. Nothing in this app sends anything; a human does, elsewhere.
      sent: false,
    })
    .select('*')
    .single();

  if (error) {
    // A WRITE THAT FAILS MUST NAME ITS FIX, and the fix for this one is almost
    // always a migration. `digests.status` carries a CHECK from 0003 and
    // `payload` is jsonb — a rejected insert here is either a status value the
    // constraint does not know or a column this code believes in and the
    // database does not. Both are the 0007 class: code and schema disagreeing,
    // invisible until something executed it. Reported as HttpError so the hint
    // survives all the way to the failure card; a bare Error would arrive on
    // screen as a Postgres sentence with no action attached to it.
    throw new HttpError(
      500,
      `Could not save the digest: ${error.message}`,
      'The run completed and nothing was stored. If the message names a check constraint or an ' +
        'unknown column, the database is behind the code: apply every file in supabase/migrations/ ' +
        'that is newer than the last one you ran (Supabase dashboard → SQL editor → paste → Run; ' +
        'they are additive and rewrite nothing). Otherwise confirm SUPABASE_SERVICE_ROLE_KEY is the ' +
        'service-role key — RLS on digests is deny-all and the anon key writes nothing.',
    );
  }
  const digest = inserted as DigestRow;

  const ledgerWriteErrors: string[] = [];
  let ledgerUpdated = 0;

  for (const review of payload.ledger_review) {
    // 'extended' keeps the decision open and moves its review date. The other
    // three close it with the note that closed it — an outcome_note is written
    // on every one of them, because a status with no reason is not a review.
    let update: Record<string, string>;
    if (review.verdict === 'extended') {
      if (review.new_review_after === null) {
        // Unreachable: the schema refuses an extension with no new date. Kept
        // because the alternative is writing null into a NOT NULL column and
        // reporting the constraint error as if the ledger had failed.
        ledgerWriteErrors.push(
          `decision ${review.decision_id} was extended without a new review date and was left untouched.`,
        );
        continue;
      }
      update = { review_after: review.new_review_after, outcome_note: review.outcome_note_ar };
    } else {
      update = { status: review.verdict, outcome_note: review.outcome_note_ar };
    }

    const result = await db
      .from('decisions')
      .update(update)
      .eq('id', review.decision_id)
      // Only an open decision may be verdicted. Scoping the write means a
      // decision reviewed by someone else between load and write is left alone
      // and reported, rather than silently overwritten.
      .eq('status', 'open')
      .select('id');

    if (result.error) {
      ledgerWriteErrors.push(`decision ${review.decision_id}: ${result.error.message}`);
      continue;
    }
    const rows = (result.data as { id: string }[] | null) ?? [];
    if (rows.length === 0) {
      ledgerWriteErrors.push(
        `decision ${review.decision_id} was not updated — it is no longer open. Its verdict is recorded in the digest payload only.`,
      );
      continue;
    }
    ledgerUpdated += 1;
  }

  let decisionsWritten = 0;
  if (payload.decisions.length > 0) {
    const rows = payload.decisions.map((decision) => ({
      kind: decision.kind,
      statement_ar: decision.statement_ar,
      basis: decision.basis,
      grounding: decision.grounding,
      // The fence travels with the decision it fences. `decisions` has no
      // column for a cap or a kill condition and this change adds no migration,
      // so they are appended verbatim to the field a reviewer actually reads
      // when judging the decision — in a code-owned format, so the halves stay
      // separable. The unmodified payload keeps its own copy in the digest.
      // The durable fix is two additive columns; it is reported, not improvised.
      expected_signal: fencedSignal(decision),
      review_after: decision.review_after,
      // Every new decision starts open. Nothing here may write an outcome: the
      // outcome is what a later run, or a human, reads off the data.
      status: 'open' as const,
    }));

    const result = await db.from('decisions').insert(rows).select('id');
    if (result.error) {
      ledgerWriteErrors.push(`decisions: ${result.error.message}`);
    } else {
      decisionsWritten = ((result.data as { id: string }[] | null) ?? []).length;
    }
  }

  const countActions = (type: StrategistResponse['actions'][number]['type']): number =>
    payload.actions.filter((action) => action.type === type).length;

  return {
    digest,
    decisions_written: decisionsWritten,
    ledger_updated: ledgerUpdated,
    ledger_write_errors: ledgerWriteErrors,
    concept_requests: countActions('generate_concepts'),
    computation_requests: countActions('request_computation'),
    human_flags: countActions('flag_needs_human'),
    actions_executed: false,
    needs_human: payload.needs_human || (brain?.needsHuman ?? false),
    // Null when no Judge ran, which is the honest value and reads as an em-dash
    // on screen. Never 0 — a score of zero is a verdict, and no verdict was given.
    judge_score: brain === null ? null : brain.judge.score,
    coverage: payload.coverage,
  };
}

/* ================================================================== run == */

/**
 * The model name reported by a run that called no model.
 *
 * Hard rule 2 in the one place it is easiest to break: absent is an em-dash,
 * never a plausible stand-in. Reported beside `attempts: 0` and zero tokens, so
 * the three of them together say the same thing three ways and no reader has to
 * infer it from one of them.
 */
export const NO_MODEL_RAN = '—';

/**
 * Runs one stage and makes sure a failure inside it arrives with a fix attached.
 *
 * WHY THIS EXISTS. `errorResponse()` turns an HttpError into `{error, hint}` and
 * anything else into `{error, hint: null}`, and the digest screen renders the
 * hint as the actionable half of its failure card. So an ordinary `Error`
 * thrown deep in a read — `Could not read decisions: …` — reaches the operator
 * as a Postgres sentence with no action beside it, which is a P1 in this
 * product's terms: the click ended, and the screen cannot say what to do.
 * An HttpError already carrying a hint passes through untouched.
 */
async function stage<T>(label: string, hint: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = err instanceof Error ? err.message : 'Unexpected failure.';
    throw new HttpError(500, `${label}: ${message}`, hint);
  }
}

const LOAD_HINT =
  'Nothing was written. Confirm SUPABASE_SERVICE_ROLE_KEY is the service-role key (RLS is deny-all, ' +
  'so the anon key reads nothing), and that every file in supabase/migrations/ has been applied — a ' +
  'table this read names and the database does not have fails exactly here.';

/**
 * One strategist run: load → refuse → answer for free if it cannot see → else
 * spend → Law → Judge → at most one retry → persist.
 *
 * The retry budget is one, for the reason stated in
 * src/lib/agent/features/types.ts: looping on a model that keeps failing burns
 * money and converges on nothing, and a second failure is a human's problem —
 * it is stored, flagged `needs_human`, and surfaced.
 *
 * EVERY EXIT FROM THIS FUNCTION IS RENDERABLE. There are exactly four: an
 * HttpError with a message and a hint (the failure card), the insufficient-data
 * digest, a digest, or a digest flagged `needs_human`. There is no path that
 * returns nothing, and no path that throws something without a fix attached.
 */
async function runStrategist(rawInput: unknown, quality: Quality): Promise<FeatureRunOutcome> {
  const parsedInput = strategistInputSchema.safeParse(rawInput ?? {});
  if (!parsedInput.success) {
    throw new HttpError(
      400,
      'Invalid request body.',
      parsedInput.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    );
  }
  const input = parsedInput.data;

  const data = await stage('Could not assemble the digest', LOAD_HINT, () =>
    loadStrategistData(supabaseAdmin(), {
      today: todayInAmman(),
      periodDays: input.period_days,
      actionBudget: input.action_budget,
    }),
  );

  // Before the model call, not after it.
  strategistPreflight(data);

  /* --------------------------------------------- can this run see anything? --
   *
   * Computed from the loaded data, before the blocks are rendered and before a
   * single token is spent. When the answer is no, the run answers for free and
   * ends here — see composeInsufficientPayload() for why it still writes a row,
   * why it calls neither model nor Judge, and why its status is 'material'.
   */
  const coverage = assessCoverage(data);
  if (coverage.verdict === 'insufficient') {
    const payload = composeInsufficientPayload(data, coverage);
    const persisted = await persistStrategist(payload, data, null);
    return {
      feature: 'strategist',
      model: NO_MODEL_RAN,
      attempts: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      result: payload,
      persisted,
      // No `brain`: there is no Law report and no Judge verdict to report, and
      // an empty one would read as "reviewed and found clean".
    };
  }

  const blocks = renderStrategistBlocks(data);
  // The evidence view of the same blocks. Built here, beside the render, so the
  // two are visibly one assembler read twice rather than two sources of truth.
  const evidence = strategistEvidence(data);
  // Both halves of the source-key check come from the same block list, so the
  // keys it verifies against cannot drift from the keys the agent was shown.
  const emitted = collectSourceKeys(data);
  const baseMessage = buildStrategistMessage(blocks, input, data);

  const run = await runAgentJson({
    userMessage: baseMessage,
    schema: strategistResponseSchema,
    quality,
    maxTokens: STRATEGIST_MAX_TOKENS,
    // The strategist's own constitution, not the app-wide prompt.
    system: STRATEGIST_SYSTEM,
  });

  const review = async (candidate: StrategistResponse) => {
    const law = strategistLaw(candidate, blocks, evidence, data, emitted);
    const judged = await runJudge({
      candidate: strategistToText(candidate),
      lawReport: law,
      // Canon is a design corpus — structure and principle for creative output.
      // A weekly digest is an internal report and retrieving against it would
      // put another brand's guideline language in front of the Judge for no
      // gain. The Judge's authority here is the blocks and the Law.
      canon: [],
      // The blocks the generator was given: what the Judge needs to check a
      // claim against. runJudge fixes its own quality at 'high' by design.
      brandBlocks: blocks,
      task: 'weekly strategist digest and the decisions it commits to',
    });
    return { law, verdict: reconcile(judged.verdict, law), usage: judged.usage };
  };

  let value = run.value;
  let attempts = 1;
  let outcome = await review(value);
  let usage = {
    input_tokens: run.usage.input_tokens + outcome.usage.input_tokens,
    output_tokens: run.usage.output_tokens + outcome.usage.output_tokens,
  };

  if (outcome.verdict.verdict === 'fail') {
    const complaint = outcome.verdict.violations
      .map((v) => `- ${v.rule} (${v.source}): ${v.evidence}`)
      .join('\n');
    const fixes = outcome.verdict.fixes.map((f) => `- ${f}`).join('\n');

    const retryMessage = [
      baseMessage,
      '',
      '## Your previous attempt was rejected in review',
      'Violations:',
      complaint || '- (none itemised)',
      fixes ? `\nRequested fixes:\n${fixes}` : '',
      '',
      'Rewrite it so every violation above is resolved. Do not restate the',
      'rejected output. Return only the corrected JSON object.',
    ].join('\n');

    const retry = await runAgentJson({
      userMessage: retryMessage,
      schema: strategistResponseSchema,
      quality,
      maxTokens: STRATEGIST_MAX_TOKENS,
      system: STRATEGIST_SYSTEM,
    });

    attempts = 2;
    value = retry.value;
    outcome = await review(value);
    usage = {
      input_tokens: usage.input_tokens + retry.usage.input_tokens + outcome.usage.input_tokens,
      output_tokens: usage.output_tokens + retry.usage.output_tokens + outcome.usage.output_tokens,
    };
  }

  const brain: BrainReport = {
    law: outcome.law,
    judge: outcome.verdict,
    canon: [],
    attempts,
    needsHuman: outcome.verdict.verdict === 'fail' || outcome.verdict.needs_human,
  };

  // The verdict travels with the digest even when it is 'sufficient', and its
  // `gaps` still name whatever is dark. A material week written over two live
  // corpora and one empty one is a true digest with a stated blind spot, and
  // the row says which — so "why does this digest never mention the audience?"
  // has an answer stored beside it rather than in somebody's memory.
  const stored: StoredStrategistPayload = { ...value, coverage };
  const persisted = await persistStrategist(stored, data, brain);

  return {
    feature: 'strategist',
    model: run.model,
    attempts,
    usage,
    result: stored,
    persisted,
    brain,
  };
}

export const strategistFeature: RunnableFeature = {
  id: 'strategist',
  label: 'Weekly digest',
  /** The blocks this feature reads — its own, not the app-wide four. */
  contextBlocks: BLOCK_TAGS,
  hasBrain: true,
  run: runStrategist,
};
