/**
 * ===========================================================================
 * THE FIVE CHAT TOOLS
 * ===========================================================================
 *
 * `src/lib/agent/chat/run.ts` deliberately defines NO tools: it takes an array
 * and an executor and has no built-in surface of its own, which is what stops it
 * growing a free-SQL escape hatch by accident. This file is that array and that
 * executor, and it is the entire surface the chat agent can reach.
 *
 * Five tools. get_stats · search_posts · get_brand · run_compliance ·
 * dispatch_feature. There is no sixth, and adding one means editing the tuple at
 * the foot of this file, which means a diff a reviewer sees.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT OWN
 * ---------------------------------------------------------------------------
 * `dispatch_feature` is IMPLEMENTED IN ./dispatch.ts, not here. This file
 * publishes its spec by calling `dispatchToolSpec()` and executes it by calling
 * `runDispatch()`; it does not re-derive the allow-list, the cap, the
 * reservation or the card.
 *
 * That is a deliberate choice against a second implementation. The dispatcher
 * takes an ATOMIC RESERVATION against `mcp_cap_days` before its first billable
 * call (supabase/migrations/0005_mcp_reservations.sql) — a real gate, not a
 * read-then-act check — and it settles that reservation afterwards. A cap
 * implemented a second time in this file would be a weaker duplicate of a
 * stronger mechanism, and two gates that disagree about what a generation costs
 * is worse than either one alone.
 *
 * THE ONE THING THIS FILE ADDS TO A DISPATCH is the audience corpus guarantee —
 * see `AUDIENCE CORPUS` below. It is composed through `DispatchDeps.runFeature`,
 * the injection point ./dispatch.ts exposes for exactly this, so the dispatcher's
 * order (read cap → reserve → run → settle) is unchanged and unchangeable from
 * here.
 *
 * ---------------------------------------------------------------------------
 * HARD RULE 18 — NO NEW SPEND PATHS — ENFORCED STRUCTURALLY, NOT BY ABSENCE
 * ---------------------------------------------------------------------------
 * "No chat tool can scrape, mirror, or touch Apify" is not left to "no tool
 * calls it". Three mechanisms, the same three src/lib/mcp/tools.ts uses, because
 * they are what made that surface provable rather than merely reviewable:
 *
 *   1. THE REGISTRY IS A CLOSED ALLOW-LIST, NOT A LOOKUP. `CHAT_TOOL_NAMES` is a
 *      five-member readonly tuple, `ChatToolName` is its element union, and
 *      `TOOLS` is `Record<ChatToolName, ChatTool>` — total (a name in the tuple
 *      with no entry is a compile error) and closed (a name outside it has no key
 *      to reach). Dispatch passes the model-supplied string through
 *      `isChatToolName`, which tests membership of the TUPLE, before anything
 *      indexes the record. `__proto__`, `constructor` and every other inherited
 *      key therefore resolve to nothing. The same shape guards the dispatchable
 *      features (`CHAT_DISPATCHABLE`, in ./dispatch.ts) and the stat lookups
 *      (`STAT_LOOKUP_NAMES`, in ./stats.ts). Three closed lists, one pattern.
 *
 *   2. THE IMPORT GRAPH DOES NOT CONTAIN THE SPEND. Nothing under
 *      `src/lib/ingest/` — the Apify client, the budget guard, the media mirror —
 *      is imported by this module or by anything it imports, transitively. That
 *      is an executable claim: tests/chat-tools.test.ts walks the real import
 *      graph from this file and fails if any module under `src/lib/ingest/`
 *      becomes reachable, having first sanity-checked that the walker CAN find
 *      the ingestion layer when it is genuinely there, so the negative can never
 *      be an artefact of a walker that found nothing.
 *
 *   3. NO TOOL TAKES A TARGET. No input schema below has a url, endpoint, host,
 *      actor, webhook, handle, path or table parameter. The one parameter that
 *      names a thing to run — `dispatch_feature.feature` — is a CLOSED ENUM,
 *      checked against ./dispatch.ts's frozen tuple before the registry is
 *      touched. A caller picks a verb and fills in range-checked scalars; it
 *      cannot point the studio at anything.
 *
 * What is NOT claimed: that these tools are free. Two of them call a model.
 * `dispatch_feature` is bounded by the reservation in ./dispatch.ts;
 * `run_compliance` is bounded by the counted read of the SAME window — which is
 * weaker, and is documented as such at its cap check rather than glossed.
 *
 * ---------------------------------------------------------------------------
 * HARD RULE 19 — PREDEFINED LOOKUPS ONLY
 * ---------------------------------------------------------------------------
 * `get_stats` executes NAMED, code-defined queries from ./stats.ts and nothing
 * else. `search_posts` is the one tool that returns rows, and it is not an
 * exception: its filters are named, bounded and applied IN CODE over a capped,
 * snapshot-scoped read (see the note on its handler for why the matching is not
 * pushed into PostgREST). There is no free-SQL tool and no raw-table tool.
 *
 * ---------------------------------------------------------------------------
 * AUDIENCE CORPUS — THE ONE INPUT A MODEL MAY NEVER SUPPLY
 * ---------------------------------------------------------------------------
 * `audienceFeature`'s input schema requires a `comments` array: the corpus
 * travels IN, because `buildPrompt` is synchronous by contract, and /api/audience
 * is the sanctioned caller that reads it from Postgres.
 *
 * If chat forwarded the model's params unchanged, a model could hand that feature
 * an array of comments IT WROTE, and the analysis would quote invented Arabic
 * back to the operator as "what the audience said" — a fabricated quotation
 * wearing a citation, which is the worst failure this app can have. So the corpus
 * is never taken from model input: `loadAudienceCorpus` below is the only source,
 * and anything the model passed under `comments` is DROPPED rather than merged.
 * With no comments ingested — which is this deployment's state — the dispatch is
 * refused with a first-class absence BEFORE any unit is reserved.
 *
 * ---------------------------------------------------------------------------
 * FAILURE HONESTY
 * ---------------------------------------------------------------------------
 * No handler here swallows an error into prose. Every refusal and every failure
 * returns a SHAPED payload with a `refusal` key and a card the UI renders in its
 * own right. The model sees the same JSON, so it can say what happened rather
 * than improvise around a silence — and because the tool result is also part of
 * the lint context (run.ts joins the blocks and every tool result before
 * linting), a cap message that names a number is a legitimate source for it.
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/auth';
import { MissingEnvError } from '@/lib/env';
import type { Quality } from '@/lib/prefs';
import { distinctPosts, scanCoverage, MAX_POSTS_SCAN } from '@/lib/audience/posts';
import { loadAgentContext, renderContextBlocks } from '@/lib/agent/context';
import { runLaw, type LawReport } from '@/lib/brain/law';
import { retrieveCanon, type CanonHit } from '@/lib/brain/canon/retrieve';
import { reconcile, runJudge, type JudgeVerdict } from '@/lib/brain/judge';
import { CapUnavailableError } from '@/lib/mcp/tools';
import {
  CHAT_DISPATCHABLE,
  CHAT_DISPATCH_TOOL,
  capSourcedValues,
  defaultDispatchDeps,
  dispatchToolSpec,
  isDispatchable,
  readChatCapState,
  runDispatch,
  type ChatCapState,
  type DispatchDeps,
} from './dispatch';
import {
  runStatLookup,
  statLookupCatalogue,
  STAT_LOOKUP_NAMES,
  type StatLookupOutcome,
} from './stats';
import type {
  ChatToolCallRecord,
  ChatToolResult,
  ChatToolSpec,
  SourcedValue,
  ToolParameterSchema,
} from './run';
import type { Account, BrandRow, Grounding, PostRow } from '@/lib/types/db';

/* ============================================================ dependencies ==*/

/** The Canon retrieval half of the brain gate. Injected so tests can run it. */
export type CanonRetriever = (
  query: string,
  opts: { tags?: readonly string[]; k?: number },
) => Promise<CanonHit[]>;

/** The Judge half. Injected for the same reason. */
export type JudgeRunner = (input: {
  candidate: string;
  lawReport: LawReport;
  canon: CanonHit[];
  brandBlocks: string;
  task: string;
}) => Promise<{ verdict: JudgeVerdict; model: string }>;

/** The brand context the Law reads: the blocks, the palette, the real voice. */
export interface BrandContext {
  blocks: string;
  swatches: Record<string, string> | null;
  voiceExamples: string[];
}

export type BrandContextLoader = () => Promise<BrandContext>;

/**
 * Everything the tools need from the outside.
 *
 * `db` is an ARGUMENT rather than an import, exactly as in `loadStrategistData`
 * — so this module reads no environment variable, holds no secret, and can be
 * executed against any client the caller has already authorised.
 *
 * The optional members all default to the REAL implementation. They exist
 * because they call a model or an embedding endpoint and no provider key is
 * usable in this repository: injecting them is the only way the gates, the cap
 * and the allow-lists can be EXECUTED in tests rather than merely read. Nothing
 * deterministic is injectable — the Law always runs for real.
 */
export interface ChatToolDeps {
  db: SupabaseClient;
  quality: Quality;
  /** One instant for the whole turn, so the cap window cannot shift mid-turn. */
  now?: Date;
  loadBrandContext?: BrandContextLoader;
  retrieveCanon?: CanonRetriever;
  runJudge?: JudgeRunner;
  /** Handed to ./dispatch.ts. Its defaults are the registry and the reservation. */
  dispatchDeps?: DispatchDeps;
}

const defaultBrandContext: BrandContextLoader = async () => {
  const ctx = await loadAgentContext();
  return {
    blocks: renderContextBlocks(ctx),
    swatches: ctx.brand.palette?.swatches ?? null,
    voiceExamples: ctx.brand.voice_examples.map((example) => example.text),
  };
};

const defaultCanonRetriever: CanonRetriever = (query, opts) => retrieveCanon(query, opts);

const defaultJudgeRunner: JudgeRunner = async (input) => {
  const ruled = await runJudge(input);
  return { verdict: ruled.verdict, model: ruled.model };
};

/* ================================================================ results ==*/

/**
 * Every tool answers in the same envelope: JSON text for the model, an explicit
 * list of the values that JSON is EVIDENCE for, and an optional card.
 *
 * `payload` IS NOT EVIDENCE. It is written for the model and it deliberately
 * quotes back what the model asked for — the lookup name that does not exist,
 * the filters that were applied, the tool name that is not a tool — because a
 * refusal that names the mistake is answerable and a refusal that hides it is
 * not. `sourced` is the separate, explicit half the claims-linter reads, and it
 * DEFAULTS TO EMPTY: a handler that declares nothing sources nothing. See
 * `ChatToolResult` in ./run.ts for the laundering attack that shape closes.
 *
 * CARDS ARE FOR THINGS THAT MUST BE VISIBLE INDEPENDENTLY OF THE PROSE — a
 * stored artefact, a compliance verdict, a failure. A stat lookup gets no card:
 * its numbers belong in the sentence that cites them, and a card would invite the
 * reply to say "see above" while the figure sits unlinted next to it.
 */
function toolResult(
  payload: Record<string, unknown>,
  extra: {
    card?: Record<string, unknown>;
    source_keys?: string[];
    sourced?: SourcedValue[];
  } = {},
): ChatToolResult {
  return {
    content: JSON.stringify(payload, null, 2),
    sourced: extra.sourced ?? [],
    ...(extra.source_keys ? { source_keys: extra.source_keys } : {}),
    ...(extra.card ? { card: extra.card } : {}),
  };
}

/**
 * A measured number, declared. Null and NaN produce NO entry rather than a zero
 * — hard rule 2: an absent quantity is an em-dash, and a value the linter can
 * source is a value the model may state.
 */
function sourcedNumber(value: number | null | undefined, source_key?: string): SourcedValue[] {
  if (typeof value !== 'number' || !Number.isFinite(value)) return [];
  return [source_key === undefined ? { value: String(value) } : { value: String(value), source_key }];
}

/** A stored string — a date, an id, a recorded fact. Blank and null declare nothing. */
function sourcedText(value: string | null | undefined, source_key?: string): SourcedValue[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return [source_key === undefined ? { value } : { value, source_key }];
}

/** The failure card. Never a swallowed error, never an apology in prose. */
function failureCard(tool: string, refusal: string, reason: string): Record<string, unknown> {
  return { kind: 'tool_failure', tool, refusal, reason };
}

function invalidArguments(tool: string, error: z.ZodError): ChatToolResult {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  const payload = {
    tool,
    refusal: 'invalid_arguments',
    issues,
    reason: `The arguments for ${tool} did not validate. Nothing ran and nothing was counted against the daily cap.`,
  };
  return toolResult(payload, {
    card: failureCard(
      tool,
      'invalid_arguments',
      issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    ),
  });
}

/* ============================================================== 1. get_stats */

const getStatsInput = z
  .object({
    lookup: z.string().min(1),
    params: z.record(z.unknown()).default({}),
  })
  .strict();

function catalogueForDescription(): string {
  return statLookupCatalogue()
    .map(
      (entry) =>
        `  • ${entry.name} — ${entry.summary}\n    params: ${entry.params}\n    emits: ${entry.emits}`,
    )
    .join('\n');
}

const GET_STATS_DESCRIPTION = `Run ONE named, pre-written computation over the studio's own data and get back values that each carry the key that resolves them.

THE LOOKUPS THAT EXIST — there are exactly ${STAT_LOOKUP_NAMES.length}, and no others:
${catalogueForDescription()}

WHEN TO USE IT
- Before stating ANY quantity about the accounts. A number that did not come
  from here, from search_posts, or from the context blocks you were given may
  not be stated at all — it will be caught and cut out of your reply.
- When you want the sample size behind a figure. Every value carries its own n
  and the date it was measured on, so "average 508" travels with "over 190
  posts", not as a bare number.

WHEN NOT TO USE IT
- Do NOT call it hoping a lookup exists. The list above is the whole list. If
  the computation you need is not on it, say so plainly and offer to open a
  request_computation item naming what is missing. Do not substitute a
  neighbouring figure and do not derive the answer yourself — you have no
  arithmetic privileges here.
- Do NOT treat an absence as a zero. A lookup with no data returns an
  "absences" entry saying what does not exist, why, and what would create it.
  That is a REAL answer and it is usually the correct thing to report. Say the
  measurement does not exist; never say the value is zero, low, or unchanged.
- Do NOT use it to read post captions. It returns figures. search_posts returns
  the posts themselves.

PARAMETERS
- lookup (string, required). One of the ${STAT_LOOKUP_NAMES.length} names above,
  spelled exactly. Anything else is refused by name with the catalogue
  attached; it never resolves to a computation.
- params (object, optional, default {}). The named parameters that lookup
  accepts, as listed above. Every one is an enum or an integer with a range.
  Unknown properties are rejected rather than ignored, so a misspelt parameter
  is an error you can see instead of a silent default.

WHAT COMES BACK
{ "lookup", "title", "params", "status", "values": [...], "absences": [...],
  "notes": [...], "coverage", "measured_over" }
"status" is "measured", "partial" (some of it exists, some does not) or
"absent". Each value is { source_key, label, value, n, as_of } and "value" is
TEXT — quote it exactly as written, do not re-round it. "measured_over" names
the snapshot every performance figure was computed over.

REFUSAL SHAPES — always a shaped object with a "refusal" key, never prose:
- "unknown_lookup" — no such computation. The catalogue comes back with it.
- "invalid_params" — a parameter was out of range, unknown, or the wrong type.
  The issues are itemised by path.
- "tool_failed" — the read itself failed. Nothing was invented in its place.

SIDE EFFECTS
None. Reads only, calls no model, costs nothing, and is not capped.`;

/* =========================================================== 2. search_posts */

const SEARCH_ORDERS = ['engagement', 'recent'] as const;

const searchPostsInput = z
  .object({
    account: z.enum(['personal', 'academy', 'all']).default('all'),
    contains: z.string().trim().min(1).max(60).nullish(),
    min_engagement: z.number().int().min(0).max(10_000_000).nullish(),
    media_type: z.string().trim().min(1).max(24).nullish(),
    order: z.enum(SEARCH_ORDERS).default('engagement'),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

const SEARCH_POSTS_DESCRIPTION = `Return real posts from the newest snapshot, VERBATIM — the caption exactly as published, the engagement exactly as stored, the permalink exactly as ingested.

Nothing is summarised, shortened, translated or re-ranked on the way back. What
you get is rows.

WHEN TO USE IT
- To read what the account actually published: the wording of a hook, the
  register of a caption, the shape of a post that did well.
- To ground a claim about STYLE in the client's own text rather than in a
  memory of it.
- To find the specific post behind a figure get_stats gave you.

WHEN NOT TO USE IT
- Do NOT use it to compute anything. It does not average, total or rank beyond
  the ordering you asked for, and neither may you: a mean you work out yourself
  from these rows is an unsourced number and will be cut out of your reply. Use
  get_stats for every quantity.
- CRITICAL — A NUMBER INSIDE A CAPTION IS NOT A MEASUREMENT. Captions are text
  the client wrote. A caption that says "٥٠٠" is not evidence that anything
  equals five hundred, and quoting it as a metric is exactly the kind of
  laundering this studio exists to prevent. Quote a caption as words; take
  quantities from get_stats only.
- Do NOT ask for a large limit to "see everything". The cap is 25 rows and the
  read is scoped to the newest snapshot.

PARAMETERS — all filters are named and bounded; there is no free-form query.
- account ("personal" | "academy" | "all", default "all").
- contains (string, 1–60 characters, optional). Case-insensitive substring
  match against the caption, applied in code over the snapshot population. It
  is a plain substring, not a pattern: no wildcards, no regular expressions.
- min_engagement (integer 0–10000000, optional). Keeps posts at or above this
  engagement figure.
- media_type (string, 1–24 characters, optional). Exact, case-insensitive match
  against the stored media type, e.g. "Video". A type that matches nothing
  returns an empty result that SAYS it matched nothing.
- order ("engagement" | "recent", default "engagement"). The only two orderings
  that exist. A post with no publish time sorts last under "recent" rather than
  being dropped or guessed at.
- limit (integer 1–25, default 10).

WHAT COMES BACK
{ "rows": [{ "account", "ig_id", "url", "caption", "media_type", "likes",
  "comments", "engagement", "posted_at" }], "matched", "returned", "filters",
  "coverage", "measured_over" }
"matched" is how many posts passed the filters; "returned" is how many came
back after the limit. A null "likes" or "comments" means the export did not
carry that field — it does NOT mean zero.

REFUSAL SHAPES
- "invalid_arguments" — a filter was out of range or unknown.
- "tool_failed" — the read failed. No rows are invented in its place.
An empty result is NOT a refusal: it is the honest answer that nothing matched,
and it says so.

SIDE EFFECTS
None. One read, no model, no cost, not capped.`;

/* ============================================================== 3. get_brand */

const BRAND_SECTIONS = ['facts', 'voice', 'palette', 'guideline'] as const;

const getBrandInput = z.object({ section: z.enum(BRAND_SECTIONS) }).strict();

const GET_BRAND_DESCRIPTION = `Read one section of the Brand Brain — the verified facts about Think Quality Academy, the client's own captions, the palette, or the guideline's status — each with the source it came from.

WHEN TO USE IT
- BEFORE writing or judging anything about this client. Facts carry a "source"
  field; quote from here rather than from memory.
- To check whether a claim you are about to make is actually supported. If it
  is not in this section, the studio has not verified it.

WHEN NOT TO USE IT
- Do NOT treat an empty section as "this client has none". It means none have
  been recorded yet. Absent is not zero and is never filled in with a plausible
  guess.
- Do NOT ask for the palette in order to write a colour into copy. Swatch NAMES
  come back and hex values are deliberately withheld: brand copy references a
  colour by name, and the Law fails any output containing a raw hex.
- Do NOT read a voice example as a fact about performance. They are captions —
  text the client wrote. Any number inside one is words, not a measurement.

PARAMETERS
- section ("facts" | "voice" | "palette" | "guideline", required). Exactly one
  per call; there is no "all". Asking for one section at a time keeps the
  context small and keeps every returned value next to its own source.

WHAT COMES BACK, per section
- facts: { "facts": [{ "key", "value", "source", "label_en", "label_ar" }] }
- voice: { "examples": [{ "text", "source_url", "engagement" }], "count" } —
  the client's real captions, verbatim.
- palette: { "swatch_names": [...], "note", "typography" } — names only.
- guideline: { "version", "status", "created_at" } or an absence when no
  guideline has been generated.

REFUSAL SHAPES
- "invalid_arguments" — an unknown section, or none supplied.
- "tool_failed" — the read failed.
There is no cap refusal: nothing here is capped.

SIDE EFFECTS
None. One read, no model, no cost.`;

/* ========================================================= 4. run_compliance */

const COMPLIANCE_SUBJECTS = ['concept', 'storyboard', 'caption', 'freeform'] as const;

const runComplianceInput = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    subject: z.enum(COMPLIANCE_SUBJECTS).default('freeform'),
  })
  .strict();

const RUN_COMPLIANCE_DESCRIPTION = `Check a piece of text against the brand's Law and Judge, and return the verdict as a card.

This is the SAME pipeline the Compliance screen runs — the same deterministic
Law, the same retrieved Canon, the same Judge, the same reconcile step, and the
same ledger row. Nothing here is a chat-specific copy.

  1. THE LAW — deterministic checks that call no model: hex colours written into
     copy, palette names the brand does not own, numbers that appear nowhere in
     the brand's data, Arabic register scored against the client's real
     captions. It always runs, even with no model key configured, and its
     violations are FINAL — the Judge cannot overrule one.
  2. THE JUDGE — a model reading the same evidence plus retrieved brand canon.
     It can only add violations, never remove a Law violation.

WHEN TO USE IT
- Before showing the operator any Arabic caption, hook or concept that was
  drafted outside the studio's own gated features.
- To answer "why was this rejected": every violation carries its evidence and
  its source ("law", "canon:<chunk_id>" or "brand:<field>").

WHEN NOT TO USE IT
- It judges; it does NOT edit. Nothing you pass is modified and no corrected
  version comes back. To produce compliant copy, dispatch the feature that owns
  it — do not write the fix yourself in the reply.
- Do NOT use it on text that is not client-facing brand copy. The register
  check scores Arabic against this one client's captions, so a verdict on
  unrelated text is meaningless rather than merely unhelpful.
- Do NOT treat "passed": true as permission to publish. This studio never
  publishes; a human posts.
- Do NOT retry a call that came back with judge.status "unavailable". That
  means no provider key is configured; a second call spends another cap unit
  and returns the same answer.

PARAMETERS
- text (string, required, 1–20000 characters after trimming). The exact text to
  judge, verbatim and untranslated. Do not tidy or summarise it first — the
  register check reads the real characters, so a cleaned-up copy produces a
  verdict about the copy.
- subject ("concept" | "storyboard" | "caption" | "freeform", default
  "freeform"). Sets the Judge's framing and is recorded on the stored check.

WHAT COMES BACK
{ "passed", "needs_human", "law": {...}, "judge": {...}, "canon": [...],
  "recorded", "cap": {...} } plus a compliance card.
"passed" is true only when the Judge ruled pass AND the Law found no violation.
A missing ruling is neither a pass nor a fail: "needs_human" is set.

COST
This is a model-backed call and it is refused once the day's generation cap is
spent. The Law half is free and deterministic; the Judge half is not.

REFUSAL SHAPES
- "invalid_arguments" — empty text or over length. Nothing ran.
- "daily_generation_cap_reached" — the day's cap is spent. THE LAW RESULTS ARE
  STILL RETURNED IN FULL; only the model-backed Judge is refused, and the
  payload names the cap, what used it, and the instant it resets.
- "daily_generation_cap_unknown" — the cap could not be counted, so nothing
  model-backed was attempted. Retry once.

SIDE EFFECTS
Records the check in the studio's compliance ledger when — and only when — the
Judge actually ran. Reads no Instagram data, triggers no scrape, changes no
brand data.`;

/* ========================================================== the brain gate ==*/

type JudgeStatus = 'ruled' | 'unavailable' | 'refused_daily_cap';

interface ModelFailure {
  reason: string;
  hint: string | null;
}

/** Why a model call produced no ruling, phrased as the operator's next move. */
function describeModelFailure(err: unknown): ModelFailure {
  if (err instanceof MissingEnvError) {
    return {
      reason: `No model provider key is configured (${err.key}).`,
      hint:
        'An operator sets OPENROUTER_API_KEY (openrouter.ai/keys), or ANTHROPIC_API_KEY with ' +
        'AI_PROVIDER=anthropic. Until then every model-backed answer here is deterministic-only.',
    };
  }
  if (err instanceof HttpError) return { reason: err.message, hint: err.hint ?? null };
  return {
    reason: err instanceof Error ? err.message : 'The model call failed.',
    hint: null,
  };
}

interface ReviewOutcome {
  law: LawReport;
  judge_status: JudgeStatus;
  verdict: JudgeVerdict | null;
  model: string | null;
  unavailable: ModelFailure | null;
  canon: { chunk_id: string; document_title: string; method: string; score: number }[];
  passed: boolean;
  needs_human: boolean;
}

function lawSummary(report: LawReport): Record<string, unknown> {
  return {
    passed: report.passed,
    violation_count: report.violations.length,
    warning_count: report.warnings.length,
    results: report.results,
  };
}

/**
 * What a review sources: the COUNTS, and nothing that quotes the text back.
 *
 * A FIFTH ECHO, found by applying the rule rather than by reading the list of
 * four. `report.results` carries each check's evidence, and the claims-linter's
 * own evidence names the offending numbers verbatim — "2 number(s) appear in the
 * output but nowhere in the data it was given: 340, 92." The text under review
 * is a `text` parameter the MODEL supplied, so passing that report through as
 * lint evidence would let any number be sourced by asking `run_compliance` to
 * judge a sentence containing it. The counts are computed here; the evidence
 * strings are the input, reflected. Only the counts are declared.
 */
function lawSourced(report: LawReport): SourcedValue[] {
  return [
    ...sourcedNumber(report.violations.length, 'compliance.law.violation_count'),
    ...sourcedNumber(report.warnings.length, 'compliance.law.warning_count'),
    ...sourcedNumber(report.results.length, 'compliance.law.check_count'),
  ];
}

function canonSummary(canon: readonly CanonHit[]): ReviewOutcome['canon'] {
  return canon.map((hit) => ({
    chunk_id: hit.chunkId,
    document_title: hit.documentTitle,
    method: hit.method,
    score: Number(hit.score.toFixed(3)),
  }));
}

/**
 * Law, then Canon, then Judge, then reconcile — the composition
 * /api/compliance and defineFeature() both run, in that order.
 *
 * The Law half is NEVER injectable and never optional: it is deterministic,
 * needs no key, and its violations are final. Only the two model-dependent
 * halves come from `deps`, and a Judge that cannot rule produces
 * `judge_status: "unavailable"` with the reason — not a fabricated verdict, and
 * not a pass.
 */
async function review(
  deps: ChatToolDeps,
  args: { text: string; task: string; canonQuery: string; canonTags: readonly string[] },
): Promise<ReviewOutcome> {
  const loadContext = deps.loadBrandContext ?? defaultBrandContext;
  const canonOf = deps.retrieveCanon ?? defaultCanonRetriever;
  const judgeWith = deps.runJudge ?? defaultJudgeRunner;

  const context = await loadContext();
  const law = runLaw({
    text: args.text,
    context: context.blocks,
    swatches: context.swatches,
    voiceExamples: context.voiceExamples,
  });

  let canon: CanonHit[] = [];
  let canonFailure: string | null = null;
  try {
    canon = await canonOf(args.canonQuery, { tags: args.canonTags, k: 5 });
  } catch (err) {
    // Canon retrieval embeds the query, so it can fail on its own key. A missing
    // Canon weakens the Judge; it does not invalidate the Law, and it is
    // reported rather than silently treated as "no relevant canon".
    canonFailure = err instanceof Error ? err.message : 'Canon retrieval failed.';
  }

  try {
    const ruled = await judgeWith({
      candidate: args.text,
      lawReport: law,
      canon,
      brandBlocks: context.blocks,
      task: args.task,
    });
    // Law violations survive the Judge — reconcile re-fails anything the model
    // tried to wave through.
    const verdict = reconcile(ruled.verdict, law);
    return {
      law,
      judge_status: 'ruled',
      verdict,
      model: ruled.model,
      unavailable: canonFailure === null ? null : { reason: canonFailure, hint: null },
      canon: canonSummary(canon),
      passed: verdict.verdict === 'pass' && law.violations.length === 0,
      needs_human: verdict.verdict === 'fail' || verdict.needs_human,
    };
  } catch (err) {
    const failure = describeModelFailure(err);
    return {
      law,
      judge_status: 'unavailable',
      verdict: null,
      model: null,
      unavailable: failure,
      canon: canonSummary(canon),
      // No ruling is not a pass.
      passed: false,
      needs_human: true,
    };
  }
}

/* ============================================================== tool shapes ==*/

interface ChatTool {
  name: ChatToolName;
  title: string;
  description: string;
  /** JSON Schema, as both provider wire formats expect it. */
  parameters: ToolParameterSchema;
  run(args: unknown, deps: ChatToolDeps): Promise<ChatToolResult>;
}

/* ----------------------------------------------------- get_stats: the tool -- */

const getStatsTool: ChatTool = {
  name: 'get_stats',
  title: 'Run one named computation over the studio data',
  description: GET_STATS_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      lookup: {
        type: 'string',
        enum: [...STAT_LOOKUP_NAMES],
        description: 'Which named computation to run. Only these names exist.',
      },
      params: {
        type: 'object',
        description:
          'The named parameters that lookup accepts. Every one is an enum or a bounded integer; unknown properties are rejected.',
      },
    },
    required: ['lookup'],
    additionalProperties: false,
  },

  async run(args, deps) {
    const parsed = getStatsInput.safeParse(args ?? {});
    if (!parsed.success) return invalidArguments('get_stats', parsed.error);

    let outcome: StatLookupOutcome;
    try {
      outcome = await runStatLookup(deps.db, parsed.data.lookup, parsed.data.params);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'The lookup failed.';
      return toolResult(
        {
          tool: 'get_stats',
          refusal: 'tool_failed',
          lookup: parsed.data.lookup,
          reason,
          note: 'The read failed. No figure was estimated in its place.',
        },
        { card: failureCard('get_stats', 'tool_failed', reason) },
      );
    }

    /* THE REFUSAL THAT USED TO BE A SOURCE.
     *
     * `unknown_lookup` carries `requested: "<the name the model typed>"` and a
     * reason that quotes it again, and `invalid_params` itemises the model's own
     * parameters back at it. Both are the right thing to SHOW — a model that
     * cannot see which name it got wrong guesses again. Neither declares a
     * sourced value, so `get_stats("followers_88123")` now puts 88123 in front
     * of the model and nowhere near the linter. This is the executed attack. */
    if (!outcome.ok) {
      return toolResult(
        { tool: 'get_stats', ...outcome },
        { card: failureCard('get_stats', outcome.refusal, outcome.reason) },
      );
    }

    /* Hard rule 11 and hard rule 12 together: each value under the key that
     * resolves it, and the sample size and observation date that travel WITH it
     * declared in their own right — "average 508" is quotable only alongside
     * "over 190 posts" if 190 is evidence too. */
    const measured = outcome.result.values.flatMap((value) => [
      { value: value.value, source_key: value.source_key },
      ...sourcedNumber(value.n, `${value.source_key}.n`),
      ...sourcedText(value.as_of, `${value.source_key}.as_of`),
    ]);

    return toolResult(
      { tool: 'get_stats', ...outcome.result, grounding: 'data' satisfies Grounding },
      {
        source_keys: outcome.result.values.map((value) => value.source_key),
        sourced: [
          ...measured,
          ...sourcedText(
            outcome.result.measured_over?.taken_on,
            'performance.snapshot.taken_on',
          ),
          ...sourcedText(outcome.result.measured_over?.snapshot_id, 'performance.snapshot.id'),
          ...sourcedNumber(outcome.result.coverage?.rows_fetched, 'performance.scan.rows_fetched'),
          ...sourcedNumber(outcome.result.coverage?.limit, 'performance.scan.limit'),
        ],
      },
    );
  },
};

/* -------------------------------------------------- search_posts: the tool -- */

/** The row as it is handed back: every field verbatim, nothing derived. */
interface VerbatimPost {
  account: Account;
  ig_id: string;
  url: string | null;
  caption: string | null;
  media_type: string | null;
  likes: number | null;
  comments: number | null;
  engagement: number;
  posted_at: string | null;
}

function verbatim(post: PostRow): VerbatimPost {
  return {
    account: post.account,
    ig_id: post.ig_id,
    url: post.url,
    caption: post.caption,
    media_type: post.media_type,
    // Null stays null. A missing like count is not zero likes.
    likes: post.likes,
    comments: post.comments,
    engagement: post.engagement,
    posted_at: post.posted_at,
  };
}

const searchPostsTool: ChatTool = {
  name: 'search_posts',
  title: 'Return real posts, verbatim',
  description: SEARCH_POSTS_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      account: {
        type: 'string',
        enum: ['personal', 'academy', 'all'],
        default: 'all',
        description: 'Which account to search.',
      },
      contains: {
        type: ['string', 'null'],
        maxLength: 60,
        description:
          'Case-insensitive plain substring to look for in the caption. Not a pattern: no wildcards, no regular expressions.',
      },
      min_engagement: {
        type: ['integer', 'null'],
        minimum: 0,
        maximum: 10_000_000,
        description: 'Keep only posts at or above this engagement figure.',
      },
      media_type: {
        type: ['string', 'null'],
        maxLength: 24,
        description: 'Exact, case-insensitive match against the stored media type.',
      },
      order: {
        type: 'string',
        enum: [...SEARCH_ORDERS],
        default: 'engagement',
        description: 'The only two orderings that exist.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        default: 10,
        description: 'How many rows to return.',
      },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args, deps) {
    const parsed = searchPostsInput.safeParse(args ?? {});
    if (!parsed.success) return invalidArguments('search_posts', parsed.error);
    const filters = parsed.data;

    try {
      const snapshotRes = await deps.db
        .from('snapshots')
        .select('id,taken_on')
        .order('taken_on', { ascending: false })
        .limit(1);
      if (snapshotRes.error) {
        throw new Error(`Could not read snapshots: ${snapshotRes.error.message}`);
      }

      const snapshot = (snapshotRes.data as { id: string; taken_on: string }[] | null)?.[0] ?? null;
      if (snapshot === null) {
        // An absence sources nothing. The zeros below say "this read matched
        // nothing", which is true of the read — they are not a measurement of
        // the account, and rule 2 is that an absent quantity is an em-dash.
        return toolResult({
          tool: 'search_posts',
          rows: [],
          matched: 0,
          returned: 0,
          filters,
          absence: {
            what: 'posts',
            reason:
              'no engagement snapshot has been ingested on this deployment, so there are no posts to search.',
            what_would_produce_it:
              'Upload an Apify export on the Data screen and run Refresh; that writes a snapshot and its posts.',
          },
          grounding: 'data' satisfies Grounding,
        });
      }

      /* THE READ, AND WHY THE FILTERING IS NOT PUSHED INTO POSTGREST.
       *
       * `contains` is model-supplied text. Sent to PostgREST as an `ilike`
       * pattern it would be interpreted: `%`, `_` and `,` are meaningful there,
       * and a comma can terminate a filter argument. Rather than reason about
       * escaping a syntax that is not ours, the read is a plain, bounded,
       * snapshot-scoped select — a query shape that is a literal in this file —
       * and every filter is applied in code below over the returned rows. No
       * model-supplied string ever reaches the database.
       *
       * The cost is honest: the population is capped at MAX_POSTS_SCAN rows,
       * which is exactly the ceiling the board and the strategist already use,
       * and `coverage.truncated` says so when the cap was filled. */
      const postsRes = await deps.db
        .from('posts')
        .select('*')
        .eq('snapshot_id', snapshot.id)
        .order('engagement', { ascending: false })
        .limit(MAX_POSTS_SCAN);
      if (postsRes.error) throw new Error(`Could not read posts: ${postsRes.error.message}`);

      const rows = (postsRes.data as PostRow[] | null) ?? [];
      const coverage = scanCoverage(rows.length, MAX_POSTS_SCAN);
      const population = distinctPosts(rows).posts;

      const needle = filters.contains?.toLowerCase() ?? null;
      const mediaType = filters.media_type?.toLowerCase() ?? null;
      const minEngagement = filters.min_engagement ?? null;

      const matched = population.filter((post) => {
        if (filters.account !== 'all' && post.account !== filters.account) return false;
        if (needle !== null && !(post.caption ?? '').toLowerCase().includes(needle)) return false;
        if (mediaType !== null && (post.media_type ?? '').toLowerCase() !== mediaType) return false;
        if (minEngagement !== null && !(post.engagement >= minEngagement)) return false;
        return true;
      });

      /* Deterministic ordering the model cannot influence beyond the declared
       * enum. Ties break on ig_id so the same population always ranks the same
       * way, and a post with no publish time sorts LAST under "recent" rather
       * than being dropped or given a guessed date. */
      const ordered = [...matched].sort((a, b) => {
        if (filters.order === 'recent') {
          const left = a.posted_at === null ? -Infinity : Date.parse(a.posted_at);
          const right = b.posted_at === null ? -Infinity : Date.parse(b.posted_at);
          const leftValue = Number.isNaN(left) ? -Infinity : left;
          const rightValue = Number.isNaN(right) ? -Infinity : right;
          if (leftValue !== rightValue) return rightValue - leftValue;
          return a.ig_id.localeCompare(b.ig_id);
        }
        if (a.engagement !== b.engagement) return b.engagement - a.engagement;
        return a.ig_id.localeCompare(b.ig_id);
      });

      const returned = ordered.slice(0, filters.limit).map(verbatim);

      /* WHAT A ROW SOURCES, AND WHAT IT DOES NOT.
       *
       * The stored figures do: engagement, likes, comments, the id, the publish
       * instant. A null likes count declares nothing, because it is not zero.
       *
       * `filters` DOES NOT, and that is the second executed attack. It is echoed
       * in the payload so the model can see which filters actually applied —
       * useful, and free — but `min_engagement` is an integer the MODEL chose,
       * so a result repeating it is not evidence that anything equals it.
       *
       * NEITHER DOES `caption`. This tool's own description says it in terms: a
       * number inside a caption is text the client wrote, not a measurement, and
       * quoting one as a metric is the laundering the studio exists to prevent.
       * Declaring caption prose as lint evidence would make the linter certify
       * exactly that. Captions travel to the model in full; they simply cannot
       * source a quantity. */
      const rowValues = returned.flatMap((row) => [
        ...sourcedText(row.ig_id),
        ...sourcedNumber(row.engagement),
        ...sourcedNumber(row.likes),
        ...sourcedNumber(row.comments),
        ...sourcedText(row.posted_at),
      ]);

      return toolResult(
        {
          tool: 'search_posts',
          rows: returned,
          matched: matched.length,
          returned: returned.length,
          filters,
          coverage,
          measured_over: { snapshot_id: snapshot.id, taken_on: snapshot.taken_on },
          note: 'Rows are verbatim. A number inside a caption is text the client wrote, not a measurement — never state one as a metric.',
          grounding: 'data' satisfies Grounding,
        },
        {
          sourced: [
            ...sourcedNumber(matched.length, 'posts.matched'),
            ...sourcedNumber(returned.length, 'posts.returned'),
            ...rowValues,
            ...sourcedText(snapshot.taken_on, 'performance.snapshot.taken_on'),
            ...sourcedText(snapshot.id, 'performance.snapshot.id'),
            ...sourcedNumber(coverage.rows_fetched, 'performance.scan.rows_fetched'),
            ...sourcedNumber(coverage.limit, 'performance.scan.limit'),
          ],
        },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'The search failed.';
      return toolResult(
        {
          tool: 'search_posts',
          refusal: 'tool_failed',
          reason,
          note: 'The read failed. No rows were invented in its place.',
        },
        { card: failureCard('search_posts', 'tool_failed', reason) },
      );
    }
  },
};

/* ----------------------------------------------------- get_brand: the tool -- */

const getBrandTool: ChatTool = {
  name: 'get_brand',
  title: 'Read one section of the Brand Brain',
  description: GET_BRAND_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: [...BRAND_SECTIONS],
        description: 'Which section to read. Exactly one per call.',
      },
    },
    required: ['section'],
    additionalProperties: false,
  },

  async run(args, deps) {
    const parsed = getBrandInput.safeParse(args ?? {});
    if (!parsed.success) return invalidArguments('get_brand', parsed.error);
    const section = parsed.data.section;

    try {
      if (section === 'guideline') {
        const res = await deps.db
          .from('brand_guidelines')
          .select('version,status,created_at')
          .order('version', { ascending: false })
          .limit(1);
        if (res.error) throw new Error(`Could not read brand guidelines: ${res.error.message}`);

        const guideline =
          (res.data as { version: number; status: string; created_at: string }[] | null)?.[0] ??
          null;

        if (guideline === null) {
          return toolResult({
            tool: 'get_brand',
            section,
            absence: {
              what: 'brand.guideline',
              reason: 'no brand guideline has been generated on this deployment yet.',
              what_would_produce_it:
                'Generate one on the Guideline screen; it writes a versioned row with its own review attached.',
            },
            grounding: 'data' satisfies Grounding,
          });
        }

        return toolResult(
          {
            tool: 'get_brand',
            section,
            version: guideline.version,
            status: guideline.status,
            created_at: guideline.created_at,
            source: 'brand_guidelines (newest version)',
            grounding: 'data' satisfies Grounding,
          },
          {
            sourced: [
              ...sourcedNumber(guideline.version, 'brand.guideline.version'),
              ...sourcedText(guideline.created_at, 'brand.guideline.created_at'),
            ],
          },
        );
      }

      const res = await deps.db.from('brand').select('*').eq('id', 1).maybeSingle();
      if (res.error) throw new Error(`Could not read the Brand Brain: ${res.error.message}`);
      const brand = (res.data as BrandRow | null) ?? null;

      if (brand === null) {
        return toolResult({
          tool: 'get_brand',
          section,
          absence: {
            what: `brand.${section}`,
            reason:
              'the Brand Brain has not been seeded on this deployment, so there is nothing recorded to report.',
            what_would_produce_it: 'Seed the brand on the Brand screen, or run the seed script.',
          },
          grounding: 'data' satisfies Grounding,
        });
      }

      if (section === 'facts') {
        return toolResult(
          {
            tool: 'get_brand',
            section,
            status: brand.status,
            updated_at: brand.updated_at,
            facts: brand.facts.map((fact) => ({
              key: fact.key,
              value: fact.value,
              source: fact.source,
              label_en: fact.label_en ?? null,
              label_ar: fact.label_ar ?? null,
            })),
            count: brand.facts.length,
            note:
              brand.facts.length === 0
                ? 'No fact has been recorded yet. That is an absence, not a client without facts.'
                : 'Every fact carries the source it came from. Quote from here rather than from memory.',
            grounding: 'data' satisfies Grounding,
          },
          {
            // A verified fact IS evidence — it is stored, it carries its own
            // source, and the description tells the model to quote from here
            // rather than from memory. Each one under its own key.
            sourced: [
              ...brand.facts.flatMap((fact) =>
                sourcedText(fact.value, `brand.facts.${fact.key}`),
              ),
              ...sourcedNumber(brand.facts.length, 'brand.facts.count'),
              ...sourcedText(brand.updated_at, 'brand.updated_at'),
            ],
          },
        );
      }

      if (section === 'voice') {
        return toolResult(
          {
            tool: 'get_brand',
            section,
            examples: brand.voice_examples.map((example) => ({
              text: example.text,
              source_url: example.source_url,
              // Null stays null: an example stored without an engagement figure has
              // no engagement figure, it does not have zero.
              engagement: example.engagement,
            })),
            count: brand.voice_examples.length,
            note: "These are the client's own captions, verbatim. They are TEXT: a number inside one is something the client wrote, never a measurement you may state as a metric.",
            grounding: 'data' satisfies Grounding,
          },
          {
            // The stored engagement figure sources itself. THE CAPTION DOES NOT
            // — the note above says why, and declaring it here would contradict
            // the note in the one place that has teeth.
            sourced: [
              ...brand.voice_examples.flatMap((example) => sourcedNumber(example.engagement)),
              ...sourcedNumber(brand.voice_examples.length, 'brand.voice_examples.count'),
            ],
          },
        );
      }

      // section === 'palette'
      return toolResult(
        {
          tool: 'get_brand',
          section,
          // Names only. A hex in client copy is a Law violation, so handing the
          // generator the hexes would be handing it the violation.
          swatch_names: Object.keys(brand.palette?.swatches ?? {}),
          note_from_brand: brand.palette?.note ?? null,
          typography: brand.typography,
          withheld: {
            palette_hex_values:
              'names are returned instead; a raw hex written into copy fails the Law.',
          },
          grounding: 'data' satisfies Grounding,
        },
        {
          // The typefaces as recorded. A weight or a size inside one of these
          // strings is stored brand data, so it may be quoted.
          sourced: [
            ...sourcedText(brand.typography?.arabic_display, 'brand.typography.arabic_display'),
            ...sourcedText(brand.typography?.arabic_body, 'brand.typography.arabic_body'),
            ...sourcedText(brand.typography?.latin, 'brand.typography.latin'),
            ...sourcedNumber(
              Object.keys(brand.palette?.swatches ?? {}).length,
              'brand.palette.swatch_count',
            ),
          ],
        },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'The read failed.';
      return toolResult(
        { tool: 'get_brand', section, refusal: 'tool_failed', reason },
        { card: failureCard('get_brand', 'tool_failed', reason) },
      );
    }
  },
};

/* ------------------------------------------------ run_compliance: the tool -- */

const COMPLIANCE_CANON_QUERY = 'brand voice, colour usage, social copy standards';
const COMPLIANCE_CANON_TAGS = ['voice', 'color', 'social', 'arabic-specific'] as const;

export const CAP_REACHED = 'daily_generation_cap_reached';
export const CAP_UNKNOWN = 'daily_generation_cap_unknown';

/** The over-cap answer: a shaped payload a caller can branch on, never prose. */
function capRefusal(cap: ChatCapState): Record<string, unknown> {
  return {
    refusal: CAP_REACHED,
    cap,
    reason:
      `The daily cap of ${cap.limit} ${cap.unit} has been reached ` +
      `(${cap.used} used since ${cap.window_start}).`,
    what_you_can_do: [
      `Wait until ${cap.resets_at} (${cap.resets_on}, ${cap.time_zone}), when the window rolls over and the count returns to zero.`,
      'Answer from what is already measured instead: get_stats, search_posts and get_brand call no model and are not capped.',
      `Ask the operator to raise ${cap.env_key}; it is a deployment variable, not a code change.`,
    ],
    grounding: 'data' satisfies Grounding,
  };
}

const runComplianceTool: ChatTool = {
  name: 'run_compliance',
  title: 'Check text against the brand Law and Judge',
  description: RUN_COMPLIANCE_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        minLength: 1,
        maxLength: 20_000,
        description:
          'The exact text to judge, verbatim and untranslated. 1–20000 characters after trimming.',
      },
      subject: {
        type: 'string',
        enum: [...COMPLIANCE_SUBJECTS],
        default: 'freeform',
        description: 'What kind of thing the text is. Sets the Judge’s framing.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },

  async run(args, deps) {
    const parsed = runComplianceInput.safeParse(args ?? {});
    if (!parsed.success) return invalidArguments('run_compliance', parsed.error);
    const { text, subject } = parsed.data;

    // ONE instant for the whole call: the window the cap is counted over must
    // not shift between the read and the refusal that quotes it.
    const now = deps.now ?? new Date();

    /* THE CAP THIS TOOL IS UNDER, AND HOW IT IS WEAKER THAN THE DISPATCHER'S.
     *
     * `readChatCapState` is the SAME window and the SAME ceiling ./dispatch.ts
     * uses, so a day spent on dispatches closes this tool too and vice versa.
     * What this tool does NOT do is take a reservation: `mcp_reservations.tool`
     * is constrained to named tools, so a compliance reservation needs its own
     * migration, and inventing a tool name the database would reject would fail
     * every call rather than bound anything.
     *
     * So this is a counted, read-then-act gate. Two consequences, stated rather
     * than glossed: simultaneous calls could each pass the same read, and the
     * durable count moves only when the ledger row lands. The exposure is one
     * authenticated operator taking turns in a browser, and the count includes
     * their own work elsewhere in the studio, so it over-counts and can only
     * refuse earlier. The durable fix is a reserving tool name for compliance,
     * which is a migration this file does not own. */
    let cap: ChatCapState;
    try {
      cap = await readChatCapState(now);
    } catch (err) {
      if (err instanceof CapUnavailableError) {
        return toolResult(
          {
            tool: 'run_compliance',
            refusal: CAP_UNKNOWN,
            reason: err.message,
            detail: err.detail,
            note: 'An uncounted window is treated as unknown, never as zero, so nothing model-backed was attempted.',
            what_you_can_do: [
              'Retry once — this is usually a transient database read.',
              'If it persists, the operator should check the Supabase service-role binding on the Settings screen.',
            ],
            grounding: 'data' satisfies Grounding,
          },
          { card: failureCard('run_compliance', CAP_UNKNOWN, err.message) },
        );
      }
      throw err;
    }

    /* OVER CAP: the Judge is refused and the LAW STILL RUNS. The deterministic
     * half needs no key, no credit and no network, and withholding it because
     * the model half is unaffordable would throw away the part of the answer
     * that is always available. */
    if (cap.remaining <= 0) {
      const loadContext = deps.loadBrandContext ?? defaultBrandContext;
      const context = await loadContext();
      const law = runLaw({
        text,
        context: context.blocks,
        swatches: context.swatches,
        voiceExamples: context.voiceExamples,
      });

      return toolResult(
        {
          tool: 'run_compliance',
          ...capRefusal(cap),
          subject,
          passed: false,
          needs_human: true,
          law: lawSummary(law),
          judge: { status: 'refused_daily_cap' satisfies JudgeStatus, verdict: null, model: null },
          canon: [],
          recorded: null,
          note: 'The Law ran and is complete. Only the model-backed Judge was refused.',
        },
        {
          // The cap figures ARE evidence and the description says so: "the
          // payload names the cap, what used it, and the instant it resets" —
          // the model is meant to relay them. Same list ./dispatch.ts refuses
          // with, imported rather than restated.
          sourced: [...capSourcedValues(cap), ...lawSourced(law)],
          card: {
            kind: 'compliance',
            tool: 'run_compliance',
            subject,
            passed: false,
            needs_human: true,
            law_passed: law.passed,
            violation_count: law.violations.length,
            judge_status: 'refused_daily_cap',
            refusal: CAP_REACHED,
            resets_at: cap.resets_at,
          },
        },
      );
    }

    const outcome = await review(deps, {
      text,
      task: `${subject} submitted for compliance review from the studio chat`,
      canonQuery: COMPLIANCE_CANON_QUERY,
      canonTags: COMPLIANCE_CANON_TAGS,
    });

    /* The ledger row is the record of a RULING, so it is written exactly when a
     * Judge ruled — the same rule /api/compliance keeps. A check with no ruling
     * records nothing rather than a stand-in verdict with an invented score. */
    let recorded: { id: string; created_at: string } | null = null;
    let recordError: string | null = null;
    if (outcome.judge_status === 'ruled') {
      const { data, error } = await deps.db
        .from('compliance_checks')
        .insert({
          subject_type: subject,
          subject_ref: null,
          input_text: text,
          law_results: outcome.law.results,
          judge_verdict: outcome.verdict,
          passed: outcome.passed,
        })
        .select('id, created_at')
        .single();
      if (error) {
        // The ruling happened; only its filing failed. Reported rather than
        // thrown, because the verdict is still the answer to the question.
        recordError = error.message;
      } else {
        recorded = data as { id: string; created_at: string };
      }
    }

    return toolResult(
      {
        tool: 'run_compliance',
        subject,
        passed: outcome.passed,
        needs_human: outcome.needs_human,
        law: lawSummary(outcome.law),
        judge: {
          status: outcome.judge_status,
          verdict: outcome.verdict,
          model: outcome.model,
          unavailable: outcome.unavailable,
        },
        canon: outcome.canon,
        recorded,
        record_error: recordError,
        cap,
        grounding: 'data' satisfies Grounding,
      },
      {
        // The Judge's verdict is model prose about model-supplied text, so it
        // is not here either — only the counts, the ledger row this call
        // created, and the cap it was measured against.
        sourced: [
          ...lawSourced(outcome.law),
          ...sourcedNumber(outcome.canon.length, 'compliance.canon.count'),
          ...sourcedText(recorded?.id, 'compliance.recorded.id'),
          ...sourcedText(recorded?.created_at, 'compliance.recorded.created_at'),
          ...capSourcedValues(cap),
        ],
        card: {
          kind: 'compliance',
          tool: 'run_compliance',
          subject,
          passed: outcome.passed,
          needs_human: outcome.needs_human,
          law_passed: outcome.law.passed,
          violation_count: outcome.law.violations.length,
          judge_status: outcome.judge_status,
          check_id: recorded?.id ?? null,
        },
      },
    );
  },
};

/* =========================================== dispatch_feature: the corpus ====
 *
 * See AUDIENCE CORPUS in the header. Everything else about a dispatch belongs to
 * ./dispatch.ts; this is the one input that must not come from a model.
 * ========================================================================== */

/** How many comments the audience corpus is capped at when one is loaded. */
const AUDIENCE_CORPUS_LIMIT = 400;

export interface CorpusComment {
  id: string;
  post_id: string;
  post_url: string | null;
  text: string;
}

const audienceAccountSchema = z.enum(['personal', 'academy', 'all']).catch('all');

/**
 * The audience corpus, read from the database and from nowhere else.
 *
 * `comments` is EMPTY on this deployment, so the honest outcome today is the
 * refusal below rather than an analysis. The read is bounded, scoped to the
 * newest snapshot's posts, and drops blank comments rather than passing an empty
 * string on as if it were something someone said.
 */
export async function loadAudienceCorpus(
  db: SupabaseClient,
  account: 'personal' | 'academy' | 'all',
): Promise<CorpusComment[]> {
  const snapshotRes = await db
    .from('snapshots')
    .select('id')
    .order('taken_on', { ascending: false })
    .limit(1);
  if (snapshotRes.error) throw new Error(`Could not read snapshots: ${snapshotRes.error.message}`);
  const snapshot = (snapshotRes.data as { id: string }[] | null)?.[0] ?? null;
  if (snapshot === null) return [];

  const postsRes = await db
    .from('posts')
    .select('id,account,url,ig_id,snapshot_id,posted_at')
    .eq('snapshot_id', snapshot.id)
    .limit(MAX_POSTS_SCAN);
  if (postsRes.error) throw new Error(`Could not read posts: ${postsRes.error.message}`);

  type PostKey = Pick<PostRow, 'id' | 'account' | 'url' | 'ig_id' | 'snapshot_id' | 'posted_at'>;
  const rows = (postsRes.data as PostKey[] | null) ?? [];
  const posts = distinctPosts(rows).posts.filter(
    (each) => account === 'all' || each.account === account,
  );
  if (posts.length === 0) return [];

  const byId = new Map(posts.map((each) => [each.id, each]));
  const commentsRes = await db
    .from('comments')
    .select('id, post_id, text_content')
    .in(
      'post_id',
      posts.map((each) => each.id),
    )
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(AUDIENCE_CORPUS_LIMIT);
  if (commentsRes.error) throw new Error(`Could not read comments: ${commentsRes.error.message}`);

  const comments =
    (commentsRes.data as { id: string; post_id: string; text_content: string | null }[] | null) ??
    [];

  return comments
    .filter(
      (row): row is { id: string; post_id: string; text_content: string } =>
        typeof row.text_content === 'string' && row.text_content.trim().length > 0,
    )
    .map((row) => ({
      id: row.id,
      post_id: row.post_id,
      // Filled from the database, never shown to the model that analyses it.
      post_url: byId.get(row.post_id)?.url ?? null,
      text: row.text_content,
    }));
}

/** The feature a dispatch call names, or null when the arguments do not say. */
function peekFeature(rawArguments: string): { feature: string | null; input: unknown } {
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { feature: null, input: null };
    }
    const record = parsed as Record<string, unknown>;
    return {
      feature: typeof record.feature === 'string' ? record.feature : null,
      input: record.input,
    };
  } catch {
    // Malformed arguments are ./dispatch.ts's refusal to shape, not this file's.
    return { feature: null, input: null };
  }
}

/**
 * One dispatch, delegated.
 *
 * The ONLY thing added here is the corpus substitution, and it is composed
 * through `DispatchDeps.runFeature` — the seam ./dispatch.ts exposes — so the
 * dispatcher's order is untouched: it still reads the cap, reserves, runs, and
 * settles, and nothing in this file can reorder that.
 */
async function runDispatchTool(
  call: ChatToolCallRecord,
  deps: ChatToolDeps,
): Promise<ChatToolResult> {
  const base = deps.dispatchDeps ?? defaultDispatchDeps();
  const peeked = peekFeature(call.arguments);

  if (peeked.feature !== 'audience') {
    return runDispatch({ call, quality: deps.quality, now: deps.now, deps: base });
  }

  const rawInput =
    typeof peeked.input === 'object' && peeked.input !== null && !Array.isArray(peeked.input)
      ? (peeked.input as Record<string, unknown>)
      : {};
  const account = audienceAccountSchema.parse(rawInput.account);

  let corpus: CorpusComment[];
  try {
    corpus = await loadAudienceCorpus(deps.db, account);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'The comment corpus could not be read.';
    return toolResult(
      { tool: CHAT_DISPATCH_TOOL, feature: 'audience', refusal: 'tool_failed', reason },
      { card: failureCard(CHAT_DISPATCH_TOOL, 'tool_failed', reason) },
    );
  }

  /* Refused BEFORE the dispatcher is called, so no unit is reserved for a run
   * that cannot happen. A model-supplied corpus would have satisfied the
   * feature's schema and produced invented quotations. */
  if (corpus.length === 0) {
    const reason =
      'there are no comments in the database for this account, so an audience analysis would have to invent its own corpus.';
    return toolResult(
      {
        tool: CHAT_DISPATCH_TOOL,
        feature: 'audience',
        refusal: 'no_corpus',
        account,
        reason,
        absence: {
          what: 'audience.corpus',
          reason,
          what_would_produce_it:
            'Pull comments on the Comments screen; the analysis reads that corpus from the database and never from anything a model supplies.',
        },
        note: 'Nothing was generated and no cap unit was reserved.',
        grounding: 'data' satisfies Grounding,
      },
      { card: failureCard(CHAT_DISPATCH_TOOL, 'no_corpus', reason) },
    );
  }

  return runDispatch({
    call,
    quality: deps.quality,
    now: deps.now,
    deps: {
      ...base,
      runFeature: (feature, input, quality) => {
        // Whatever the model passed under `comments` is DROPPED, not merged.
        const supplied =
          typeof input === 'object' && input !== null && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        const { comments: _discarded, ...rest } = supplied;
        return base.runFeature(feature, { ...rest, account, comments: corpus }, quality);
      },
    },
  });
}

/* ================================================== the closed allow-list ====
 *
 * Five names, fixed at compile time. See the header for why this shape and not a
 * lookup table that anything can add to.
 * ========================================================================== */

export const CHAT_TOOL_NAMES = [
  'get_stats',
  'search_posts',
  'get_brand',
  'run_compliance',
  CHAT_DISPATCH_TOOL,
] as const;

export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

/**
 * The four tools implemented here. `dispatch_feature` is deliberately absent:
 * it is ./dispatch.ts's, and routing it through this record would be the second
 * implementation this file exists to avoid.
 */
const TOOLS: Record<Exclude<ChatToolName, typeof CHAT_DISPATCH_TOOL>, ChatTool> = {
  get_stats: getStatsTool,
  search_posts: searchPostsTool,
  get_brand: getBrandTool,
  run_compliance: runComplianceTool,
};

/**
 * Membership of the frozen TUPLE, not a property lookup on the record — so a
 * model that emits `__proto__`, `constructor` or `toString` as a tool name
 * reaches nothing at all.
 */
export function isChatToolName(name: string): name is ChatToolName {
  return (CHAT_TOOL_NAMES as readonly string[]).includes(name);
}

/** Re-exported so a caller has ONE import for the whole surface. */
export { CHAT_DISPATCHABLE, CHAT_DISPATCH_TOOL, isDispatchable };

/** The tools as `runAgentChat` publishes them to the provider. No handlers. */
export function chatToolSpecs(): ChatToolSpec[] {
  return CHAT_TOOL_NAMES.map((name) => {
    if (name === CHAT_DISPATCH_TOOL) return dispatchToolSpec();
    const tool = TOOLS[name];
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  });
}

/**
 * The executor `runAgentChat` calls, bound to one turn's dependencies.
 *
 * IT NEVER THROWS. run.ts would catch a throw and turn it into a one-line "TOOL
 * ERROR" string, which is prose — and prose is exactly what a failure must not
 * become here. Every path below returns a shaped payload plus a card the UI
 * renders in its own right, so a refusal is something the operator can see and
 * act on rather than something the model paraphrases.
 */
export function createChatToolExecutor(
  deps: ChatToolDeps,
): (call: ChatToolCallRecord) => Promise<ChatToolResult> {
  return async (call) => {
    if (!isChatToolName(call.name)) {
      /* `call.name` IS A STRING THE MODEL WROTE. Saying it back is good UX —
       * the model can see it invented a tool and pick a real one — and it is
       * the third of the executed echoes: `get_stats_88123` would have put
       * 88123 into the lint context by being refused. `toolResult` declares no
       * sourced value here, so it now puts it nowhere. */
      const reason =
        `There is no tool called "${call.name}". This surface exposes exactly ` +
        `${CHAT_TOOL_NAMES.length}: ${CHAT_TOOL_NAMES.join(', ')}.`;
      return toolResult(
        {
          tool: call.name,
          refusal: 'unknown_tool',
          available: CHAT_TOOL_NAMES,
          reason,
          what_you_can_do: [
            'Call one of the tools that exists, or answer from the context you already have.',
            'If the thing you wanted needs a computation none of them performs, say so and offer a request_computation item.',
          ],
        },
        { card: failureCard(call.name, 'unknown_tool', reason) },
      );
    }

    try {
      // The dispatcher parses its own raw arguments — unparseable JSON is a case
      // it shapes, not a crash — so it is handed the call rather than a payload.
      if (call.name === CHAT_DISPATCH_TOOL) return await runDispatchTool(call, deps);

      let args: unknown;
      try {
        const parsed: unknown = JSON.parse(call.arguments);
        args = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
      } catch {
        const reason =
          'The arguments were not valid JSON, so nothing could be validated and nothing ran.';
        return toolResult(
          { tool: call.name, refusal: 'invalid_arguments', reason },
          { card: failureCard(call.name, 'invalid_arguments', reason) },
        );
      }

      return await TOOLS[call.name].run(args, deps);
    } catch (err) {
      // The last net. Anything a handler did not shape itself still comes back as
      // a structured failure with a card — never as a thrown error that run.ts
      // would flatten into a sentence.
      const reason = err instanceof Error ? err.message : 'The tool failed.';
      return toolResult(
        {
          tool: call.name,
          refusal: 'tool_failed',
          reason,
          note: 'Nothing was invented in place of the answer this tool could not give.',
        },
        { card: failureCard(call.name, 'tool_failed', reason) },
      );
    }
  };
}
