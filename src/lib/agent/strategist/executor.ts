import { HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getFeature } from '@/lib/agent/features/registry';
import {
  strategistResponseSchema,
  type StrategistResponse,
} from '@/lib/agent/features/strategist';
import type { FeatureRunOutcome } from '@/lib/agent/features/types';
import type { Quality } from '@/lib/prefs';
import type { Account, DigestRow, StrategistPayload } from '@/lib/types/db';

/**
 * The executor: what happens to a digest's `actions[]` after a human decides to
 * act on them.
 *
 * ===========================================================================
 * THE ONE IDEA
 * ===========================================================================
 * The strategist NAMES work; it never does it. `persistStrategist()` returns
 * `actions_executed: false` and means it — nothing in the generation path runs
 * an action, and that separation is the reason the strategist is allowed to
 * speak about the client's account at all. This module is the other half of
 * that sentence: the deliberate, human-initiated step where a named request
 * becomes a routed call, or an opened item, or nothing.
 *
 * Three action types exist and each one gets a DIFFERENT disposition:
 *
 *   generate_concepts   → routed to the concepts feature, through the registry,
 *                         with that feature's own gates applying unchanged.
 *   request_computation → opens a TRACKED ITEM and computes nothing. This is
 *                         the load-bearing one. The whole reason the strategist
 *                         is permitted to say "I need a figure I do not have"
 *                         is that saying it costs nothing and produces nothing;
 *                         an executor that answered the question would hand the
 *                         agent a way to conjure the measurement it was denied.
 *   flag_needs_human    → surfaced. Executing an escalation is a contradiction
 *                         in terms: the escalation IS the request for a person.
 *
 * ===========================================================================
 * RULE 14, ENFORCED THREE TIMES, NONE OF THEM A COMMENT
 * ===========================================================================
 * "No action may trigger a scrape or any Apify spend."
 *
 *   1. DEFAULT DENY. `ACTION_ROUTES` is a Map, and `routeFor()` returns null
 *      for every key that is not in it. A Map rather than a `Record` on
 *      purpose: this repository compiles with `noUncheckedIndexedAccess: false`,
 *      so `SOME_RECORD[unknownKey]` would type as a present route and the
 *      missing-key branch would be invisible to the compiler. `Map.get()`
 *      returns `ActionRoute | undefined` and the check cannot be forgotten.
 *   2. EXHAUSTIVE SWITCH. `planExecution()` switches over the schema's
 *      discriminated union and assigns the default branch to `never`. Adding a
 *      fourth action type to `strategistResponseSchema` without deciding what
 *      this file does with it is a COMPILE ERROR, not a silent execution.
 *   3. ONE REACHABLE FEATURE. The only `feature` any route names is
 *      `concepts`. Nothing here imports the ingestion layer, the Apify budget,
 *      or any monitor/refresh path, and `featuresThisExecutorMayRun()` is
 *      derived from the route table so a test can assert the whole reachable
 *      set rather than trusting this paragraph.
 *
 * ===========================================================================
 * PURITY
 * ===========================================================================
 * Everything above `defaultExecutorDeps()` is pure: no database, no model, no
 * clock, no environment. `planExecution()` takes a validated payload and a
 * timestamp and returns a list of steps; `runPlan()` takes those steps and an
 * `ExecutorDeps` and returns the record. That is what lets the tests exercise
 * the real allow-list, the real refusals and the real tracked-item shape with
 * no key and no Supabase URL.
 *
 * ===========================================================================
 * WHAT THIS MODULE DOES NOT DO
 * ===========================================================================
 * - It does not send anything, and it does not write `digests.sent` (rule 1).
 * - It does not write content. Routing a request to the concepts feature makes
 *   that feature write concepts, into `concepts`, as drafts, where a human
 *   reviews them. What comes back here is identifiers and counters — never a
 *   hook, a caption or a body. See `summariseRun()`.
 * - It does not estimate. Rule 9 is estimate-before-spend and the estimate
 *   belongs to whatever route offers this to an operator; there is no such
 *   route yet, and this module refuses nothing on cost grounds because it is
 *   not the layer that knows the price.
 */

/* ============================================================ the allow-list */

/** What happens to an action of a given type. */
export type ActionDisposition = 'run_feature' | 'track' | 'surface';

export interface ActionRoute {
  disposition: ActionDisposition;
  /**
   * The feature id this action is routed to, or null when the disposition
   * executes nothing. This is the ONLY place a feature id may be named.
   */
  feature: string | null;
}

/** The one feature this executor may reach. Named once. */
export const CONCEPTS_FEATURE_ID = 'concepts';

/**
 * The allow-list. A Map, and read only through `routeFor()`.
 *
 * A key absent from this table is refused — including the keys an object
 * literal would answer for free (`constructor`, `__proto__`, `toString`), which
 * is the second reason this is a Map and not a `Record`.
 */
const ACTION_ROUTES: ReadonlyMap<string, ActionRoute> = new Map<string, ActionRoute>([
  ['generate_concepts', { disposition: 'run_feature', feature: CONCEPTS_FEATURE_ID }],
  ['request_computation', { disposition: 'track', feature: null }],
  ['flag_needs_human', { disposition: 'surface', feature: null }],
]);

/** Every action type this executor will act on, in table order. */
export const ALLOWED_ACTION_TYPES: readonly string[] = Object.freeze([...ACTION_ROUTES.keys()]);

/** The gate. Null means refused, and null is the answer for everything unlisted. */
export function routeFor(type: string): ActionRoute | null {
  return ACTION_ROUTES.get(type) ?? null;
}

/**
 * Every feature id reachable from this module, derived from the route table
 * rather than restated. A test asserts this set, which is how "no action can
 * trigger a scrape" is checked rather than promised.
 */
export function featuresThisExecutorMayRun(): string[] {
  const ids: string[] = [];
  for (const route of ACTION_ROUTES.values()) {
    if (route.feature !== null) ids.push(route.feature);
  }
  return ids;
}

/* ================================================================== shapes = */

/** The concepts feature's input, as this executor builds it. */
export interface ConceptsRequestInput {
  account: Account;
  count: number;
  theme: string | null;
}

/**
 * A request for a measurement nobody has taken.
 *
 * `computed` and `answer` are here so that "it computed nothing" is a property
 * of the stored object rather than a claim in a comment: opening the item
 * writes `computed: false` and `answer: null`, and no path in this module
 * writes either field any other way. Answering it is a person's job, in the
 * code they would have to write — which is the whole point of the request.
 */
export interface TrackedItem {
  /** Index of the action that opened it, inside the digest's `actions[]`. */
  action_index: number;
  /** What to compute, in English, for whoever will build it. */
  question_en: string;
  /** The claim it would unlock, in Arabic. */
  would_unlock_ar: string;
  owner: 'operator' | 'client';
  by_date: string | null;
  /** Opened, and only ever opened by this module. */
  status: 'open';
  opened_at: string;
  /** ALWAYS false. Opening a request is not answering it. */
  computed: false;
  /** ALWAYS null. See above. */
  answer: null;
}

/** One planned step, before anything has been done. */
export type PlannedStep =
  | {
      kind: 'run_feature';
      action_index: number;
      type: string;
      feature: string;
      input: ConceptsRequestInput;
      /** Fields of the request this executor could not carry. Never silent. */
      unrouted: string[];
    }
  | { kind: 'track'; action_index: number; type: string; item: TrackedItem }
  | { kind: 'surface'; action_index: number; type: string; note: string }
  | { kind: 'refused'; action_index: number; type: string; reason: string };

/** What a routed feature run produced. Identifiers and counters, never text. */
export interface FeatureRunSummary {
  feature: string;
  model: string;
  attempts: number;
  usage: { input_tokens: number; output_tokens: number };
  /** Ids of the rows the feature persisted, when it reported any. */
  persisted_ids: string[];
  /**
   * Whether the feature ran through the Design Brain at all. Recorded because
   * `needs_human` below is meaningless without it.
   */
  brain_applied: boolean;
  /**
   * The brain's verdict, or NULL when no brain ran. Null is not false: a
   * feature nobody judged has not been found acceptable, it has been unjudged
   * (hard rule 2).
   */
  needs_human: boolean | null;
}

export type ActionStatus = 'ran' | 'opened' | 'surfaced' | 'refused' | 'failed';

/** One action, and what became of it. Index-aligned with the digest's actions[]. */
export interface ActionResult {
  action_index: number;
  type: string;
  disposition: ActionDisposition | 'refused';
  status: ActionStatus;
  /** Why this outcome, in English, for the operator. Always written. */
  note: string;
  run: FeatureRunSummary | null;
  tracked: TrackedItem | null;
  /** The failure, verbatim. Never swallowed, never summarised into silence. */
  error: string | null;
}

export interface ExecutionCounts {
  requested: number;
  ran: number;
  opened: number;
  surfaced: number;
  refused: number;
  failed: number;
}

/**
 * What one execution pass did, stored on the digest it belongs to.
 *
 * It is attached under the reserved key `execution` in `digests.payload`, beside
 * the agent's own fields and never inside them. The strategist cannot write
 * this key — `strategistResponseSchema` has no such field, so a payload that
 * carried one would have had it stripped on the way in — which keeps a stored
 * digest readable as exactly two things: everything the model said, and this.
 */
export interface ExecutionRecord {
  digest_id: string;
  executed_at: string;
  /** One entry per action in the digest, in order. */
  results: ActionResult[];
  counts: ExecutionCounts;
  /** Anything the operator has to know that is not a failure. Surfaced, not logged. */
  warnings: string[];
}

/** A payload that has been executed. The agent's fields are untouched. */
export type ExecutedPayload = StrategistPayload & { execution: ExecutionRecord };

/* ================================================================ the gate = */

/**
 * A digest whose payload still satisfies the strategist's contract.
 *
 * `digests.payload` is jsonb: the row was written by a validated run, but what
 * comes back out of the column is whatever is in the column now. Re-parsing it
 * with the schema that owns the contract — rather than a second copy of the
 * rules living here — is what "a validated digest" means in this module, and it
 * happens BEFORE anything is planned, let alone run.
 */
export interface ValidatedDigest {
  digest: DigestRow;
  payload: StrategistResponse;
}

/**
 * Reads the execution record already on a payload, if there is one.
 *
 * `in` rather than a cast: the key is not on `StrategistPayload` — it is not
 * the agent's to write — so the presence check is what makes it readable, and
 * nothing here asserts anything about a value it has not looked at.
 */
export function storedExecution(payload: StrategistPayload): unknown {
  if (!('execution' in payload)) return null;
  return payload.execution ?? null;
}

/**
 * The two refusals, both before any spend:
 *
 *   1. THE PAYLOAD DOES NOT VALIDATE. Executing the actions of a digest whose
 *      contract no longer holds would be acting on a shape nobody checked.
 *   2. IT HAS ALREADY BEEN EXECUTED. An action run twice is a second spend
 *      nobody asked for, and a second set of drafts nobody wanted. Re-running
 *      is a decision, so it is refused here and would have to be made
 *      explicitly somewhere a person can see it.
 */
export function validateDigest(digest: DigestRow): ValidatedDigest {
  // The schema runs FIRST, and the order is load-bearing rather than stylistic:
  // `digests.payload` is jsonb and can hold null or a scalar, and reading a key
  // off one of those throws a TypeError that would reach the operator as a 500
  // about the `in` operator. Parsing first turns every such payload into the
  // same honest refusal. An already-executed payload still parses — zod strips
  // the key it does not declare — so the second guard is unaffected by running
  // second.
  const parsed = strategistResponseSchema.safeParse(digest.payload);
  if (!parsed.success) {
    throw new HttpError(
      409,
      'This digest did not validate against the strategist contract, so none of its actions were executed.',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }

  // Read off the STORED payload, not the parsed one: the parse drops the key,
  // because `execution` is not a field the strategist may write.
  const existing = storedExecution(digest.payload);
  if (existing !== null && existing !== undefined) {
    throw new HttpError(
      409,
      'This digest already carries an execution record, so its actions were run once already.',
      'Run a new digest if the situation has changed. Executing the same actions twice would spend again and produce a second set of drafts nobody asked for.',
    );
  }

  return { digest, payload: parsed.data };
}

/* ================================================================ planning = */

/**
 * The concepts request, mapped onto the concepts feature's input.
 *
 * `pillar` HAS NO HOME. `conceptsFeature`'s input schema is `{count, theme,
 * account}` and nothing else, so a pillar the strategist named cannot be
 * carried into the run. It is reported as `unrouted` rather than folded into
 * `theme`, because folding it would mean this module writing an instruction the
 * strategist did not write — a smaller version of exactly the thing the whole
 * request/execute split exists to prevent. The durable fix is a `pillar` field
 * on the concepts feature's input; that is reported, not improvised here.
 */
export function conceptsRequest(spec: {
  account: Account;
  pillar: string | null;
  theme: string | null;
  count: number;
}): { input: ConceptsRequestInput; unrouted: string[] } {
  return {
    input: { account: spec.account, count: spec.count, theme: spec.theme },
    unrouted: spec.pillar === null ? [] : ['pillar'],
  };
}

/**
 * The plan: one step per action, in the digest's own order.
 *
 * Pure. It reads no clock — `openedAt` is passed in — so the same payload plans
 * identically in a test and in production.
 */
export function planExecution(payload: StrategistResponse, openedAt: string): PlannedStep[] {
  const steps: PlannedStep[] = [];

  payload.actions.forEach((action, index) => {
    const route = routeFor(action.type);
    if (route === null) {
      steps.push({
        kind: 'refused',
        action_index: index,
        type: action.type,
        reason: `"${action.type}" is not on this executor's allow-list (${ALLOWED_ACTION_TYPES.join(', ')}), so nothing was done with it.`,
      });
      return;
    }

    switch (action.type) {
      case 'generate_concepts': {
        const { input, unrouted } = conceptsRequest(action.spec);
        steps.push({
          kind: 'run_feature',
          action_index: index,
          type: action.type,
          // From the route table, not from the case label: the allow-list is
          // what decides where an action goes.
          feature: route.feature ?? CONCEPTS_FEATURE_ID,
          input,
          unrouted,
        });
        return;
      }
      case 'request_computation': {
        steps.push({
          kind: 'track',
          action_index: index,
          type: action.type,
          item: {
            action_index: index,
            question_en: action.spec.question_en,
            would_unlock_ar: action.spec.would_unlock_ar,
            owner: action.owner,
            by_date: action.by_date,
            status: 'open',
            opened_at: openedAt,
            computed: false,
            answer: null,
          },
        });
        return;
      }
      case 'flag_needs_human': {
        steps.push({
          kind: 'surface',
          action_index: index,
          type: action.type,
          note: `Escalation (${action.spec.urgency}) — surfaced for a person. An escalation is a request FOR a human; there is nothing here to execute.`,
        });
        return;
      }
      default: {
        // Unreachable today: the union has exactly the three members above.
        // It is written this way so that adding a fourth to
        // strategistResponseSchema without deciding what happens to it here
        // fails the build rather than falling through into an execution.
        const unhandled: never = action;
        const leftover: { type?: string } = unhandled;
        steps.push({
          kind: 'refused',
          action_index: index,
          type: leftover.type ?? 'unknown',
          reason:
            'This action type reached the executor without a route. Nothing was done with it.',
        });
      }
    }
  });

  return steps;
}

/* ================================================================ running = */

export interface ExecutorDeps {
  /** ISO timestamp for this pass. Injected so the plan and the record are testable. */
  now(): string;
  /** Runs one registered feature. The registry's own gates apply, unchanged. */
  runFeature(featureId: string, input: unknown): Promise<FeatureRunOutcome>;
  /** Writes the record onto the digest row. */
  attach(digestId: string, payload: ExecutedPayload): Promise<void>;
}

/** Ids of rows a feature reported persisting. Identifiers only, never content. */
function persistedIds(persisted: unknown): string[] {
  if (typeof persisted !== 'object' || persisted === null) return [];
  if (!('inserted' in persisted)) return [];
  const inserted = persisted.inserted;
  if (!Array.isArray(inserted)) return [];
  const rows: readonly unknown[] = inserted;

  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    if (!('id' in row)) continue;
    const id = row.id;
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

/**
 * What is kept from a feature run.
 *
 * Deliberately narrow. `outcome.result` holds the generated concepts — hooks,
 * captions, visual directions — and none of it is copied here: the content
 * lives in the `concepts` table, on the Concepts screen, where a human reviews
 * it before anything happens to it. A digest payload carrying a copy would be a
 * second, unreviewed home for the same text.
 */
function summariseRun(outcome: FeatureRunOutcome): FeatureRunSummary {
  return {
    feature: outcome.feature,
    model: outcome.model,
    attempts: outcome.attempts,
    usage: outcome.usage,
    persisted_ids: persistedIds(outcome.persisted),
    brain_applied: outcome.brain !== undefined,
    needs_human: outcome.brain === undefined ? null : outcome.brain.needsHuman,
  };
}

function countOf(results: readonly ActionResult[], status: ActionStatus): number {
  return results.filter((result) => result.status === status).length;
}

/**
 * Runs a plan, in order, and returns the record.
 *
 * A failed step does not abort the pass: the steps are independent requests and
 * stopping at the first failure would leave the later ones in a state nobody
 * can read — neither run nor refused. The failure is recorded with its message
 * verbatim and counted, and `counts.failed` is what a caller checks.
 */
export async function runPlan(
  digestId: string,
  steps: readonly PlannedStep[],
  deps: ExecutorDeps,
): Promise<ExecutionRecord> {
  const results: ActionResult[] = [];
  const warnings: string[] = [];

  for (const step of steps) {
    if (step.kind === 'refused') {
      results.push({
        action_index: step.action_index,
        type: step.type,
        disposition: 'refused',
        status: 'refused',
        note: step.reason,
        run: null,
        tracked: null,
        error: null,
      });
      continue;
    }

    if (step.kind === 'track') {
      // NOTHING IS COMPUTED HERE, and there is no branch below that could. The
      // item is opened with the question written down and the answer left null.
      results.push({
        action_index: step.action_index,
        type: step.type,
        disposition: 'track',
        status: 'opened',
        note:
          'Opened as a tracked item. The measurement was NOT computed: naming a figure that does not exist is a request for someone to build it, not a way to obtain it.',
        run: null,
        tracked: step.item,
        error: null,
      });
      continue;
    }

    if (step.kind === 'surface') {
      results.push({
        action_index: step.action_index,
        type: step.type,
        disposition: 'surface',
        status: 'surfaced',
        note: step.note,
        run: null,
        tracked: null,
        error: null,
      });
      continue;
    }

    if (step.unrouted.length > 0) {
      warnings.push(
        `actions[${step.action_index}]: the request named ${step.unrouted.join(', ')}, which the ${step.feature} feature has no input for. The run was made without it, and it was not folded into another field.`,
      );
    }

    try {
      const outcome = await deps.runFeature(step.feature, step.input);
      const run = summariseRun(outcome);
      if (!run.brain_applied) {
        warnings.push(
          `actions[${step.action_index}]: the ${step.feature} feature runs no Design Brain, so what it produced is unjudged. It is stored as a draft and needs a human read before use.`,
        );
      }
      results.push({
        action_index: step.action_index,
        type: step.type,
        disposition: 'run_feature',
        status: 'ran',
        note: `Routed to the ${step.feature} feature through the registry. Its own gates applied unchanged; this executor added none and removed none.`,
        run,
        tracked: null,
        error: null,
      });
    } catch (err) {
      results.push({
        action_index: step.action_index,
        type: step.type,
        disposition: 'run_feature',
        status: 'failed',
        note: `The ${step.feature} feature was reached and did not complete. Nothing was written for this action.`,
        run: null,
        tracked: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    digest_id: digestId,
    executed_at: deps.now(),
    results,
    counts: {
      requested: steps.length,
      ran: countOf(results, 'ran'),
      opened: countOf(results, 'opened'),
      surfaced: countOf(results, 'surfaced'),
      refused: countOf(results, 'refused'),
      failed: countOf(results, 'failed'),
    },
    warnings,
  };
}

/**
 * Validate, plan, run, attach — in that order, and the order is the contract.
 *
 * The validation happens before the plan and the plan before the first call, so
 * a digest that fails the gate costs nothing: `deps.runFeature` is never
 * reached, which is a property the tests assert rather than infer.
 */
export async function executeDigestActions(
  digest: DigestRow,
  deps: ExecutorDeps,
): Promise<ExecutionRecord> {
  const validated = validateDigest(digest);
  const openedAt = deps.now();
  const plan = planExecution(validated.payload, openedAt);
  const record = await runPlan(digest.id, plan, deps);

  // The agent's fields are copied through untouched; only the reserved key is
  // added. What the model said stays readable as what the model said.
  const next: ExecutedPayload = { ...digest.payload, execution: record };
  await deps.attach(digest.id, next);

  return record;
}

/* ================================================================ the wiring */
/* Everything below this line touches the database or the registry.            */
/* Nothing above it does.                                                      */

/**
 * The production dependencies.
 *
 * `runFeature` goes through `getFeature()` — the same registry
 * `/api/generate/[feature]` uses — so a routed action runs the identical code
 * path an operator gets from the Concepts screen, with the same brain gates,
 * the same persistence and the same refusals. Bypassing the registry to call a
 * feature module directly would create a second way to run the same feature,
 * and the two would drift.
 */
export function defaultExecutorDeps(quality: Quality): ExecutorDeps {
  return {
    now: () => new Date().toISOString(),

    async runFeature(featureId, input) {
      const feature = getFeature(featureId);
      if (!feature) {
        throw new HttpError(
          500,
          `The executor routed an action to the "${featureId}" feature, which is not registered.`,
          'This is a wiring fault rather than a data problem: the route table in src/lib/agent/strategist/executor.ts names a feature the registry does not have.',
        );
      }
      return feature.run(input, quality);
    },

    async attach(digestId, payload) {
      const db = supabaseAdmin();
      const { error } = await db.from('digests').update({ payload }).eq('id', digestId);
      if (error) {
        throw new Error(`The actions ran but the record could not be attached: ${error.message}`);
      }
    },
  };
}

/**
 * One execution pass over one stored digest.
 *
 * This is the function a route would call. NOTHING CALLS IT YET — no route in
 * this app executes actions, deliberately: the generation path returns
 * `actions_executed: false` and the screen says so. Wiring it means a route
 * that estimates first (rule 9) and that a person triggers on purpose.
 */
export async function executeDigest(digestId: string, quality: Quality): Promise<ExecutionRecord> {
  const db = supabaseAdmin();
  const { data, error } = await db.from('digests').select('*').eq('id', digestId).maybeSingle();
  if (error) throw new Error(`Could not read the digest: ${error.message}`);
  if (!data) throw new HttpError(404, 'That digest does not exist.');

  return executeDigestActions(data as DigestRow, defaultExecutorDeps(quality));
}
