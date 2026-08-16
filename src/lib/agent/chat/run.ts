import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '@/lib/auth';
import { requireEnv } from '@/lib/env';
import type { Quality } from '@/lib/prefs';
import { claimsLinter, fail, type LawResult } from '@/lib/brain/law';
// Imported from the module rather than the barrel: these are the MECHANISM the
// claims-linter is built from, not part of the Law's public verdict surface.
import {
  claimQuantities,
  contextQuantities,
  quantities,
  wholeQuantity,
} from '@/lib/brain/law/claims-linter';
import {
  substitute,
  type SubstitutionViolation,
  type ViolationKind,
} from '@/lib/brain/substitute';
import type { ChatLawReportRow, ChatLawResultRow, ChatToolCallRecord } from '@/lib/types/db';
// Re-exported because anyone writing a `ToolExecutor` needs this shape, and the
// row type and the runtime type must stay the same type — not two that agree.
export type { ChatToolCallRecord } from '@/lib/types/db';
import {
  buildValueMap,
  collectMeasures,
  collectSourceKeys,
  measureValues,
  renderStrategistBlocks,
  strategistEvidence,
  type KeyedValue,
  type StrategistData,
} from '../strategist/blocks';
import { effortFor, modelFor, providerKeyName, resolveProvider, type Provider } from '../provider';
import { rateFor, unpricedReason } from '../rates';
import { CHAT_SYSTEM } from './system';

/**
 * ===========================================================================
 * THE CHAT LOOP, AND THE GATE THAT MAKES HARD RULE 16 REAL
 * ===========================================================================
 *
 * `runAgentChat` is the conversational sibling of `runAgentJson`
 * (src/lib/agent/client.ts). Same provider abstraction, same error vocabulary,
 * same one-retry instinct — and one structural difference that is the whole
 * point of the file:
 *
 *   IT RETURNS A COMPLETED, LINTED REPLY. There is no streaming path, no
 *   generator, no callback that receives partial text. That is not an
 *   implementation detail that could be optimised later; it is hard rule 16
 *   expressed as a type. A retracted number is worse than a slow answer, and
 *   the only way to guarantee nothing unsourced reaches a screen is for the
 *   function to have no way to emit anything before the lint has run.
 *
 * THE GATE, in order:
 *
 *   1. The model drafts a reply, with tools, over a windowed history.
 *   2. THE DRAFT IS SUBSTITUTED (hard rule 20). Every `{{source.key}}` the model
 *      wrote is replaced by the value THIS CODEBASE computed for that key, taken
 *      from the value map assembled by ../strategist/blocks.ts and from the
 *      DECLARED half of the turn's tool results. A number the model cannot write
 *      is a number it cannot fabricate; see src/lib/brain/substitute.ts for why
 *      text-matching numbers was abandoned as the guarantee.
 *   3. The substituted text is linted by the REAL claims-linter
 *      (src/lib/brain/law) against the DECLARED VALUES of the strategist blocks
 *      AND the DECLARED half of every tool result this turn produced —
 *      `ChatToolResult.sourced`, never `content`. See that type for the
 *      laundering attack the split closes, and `measureEvidence()` in
 *      ../strategist/blocks.ts for why the lint context is the block VALUES
 *      rather than the rendered blocks the model reads.
 *   4. A violation of either kind buys exactly ONE repair — the specific fault is
 *      named back to the model and it drafts again, without tools.
 *   5. A second violation is not argued with. The offending numbers are
 *      SURGICALLY REMOVED from the text and replaced, in place, with a visible
 *      «رقم غير موثّق — حُذف» marker, and the law report says which numbers went.
 *
 * TWO GUARANTEES, AND THE RUN RESULT NEVER CONFLATES THEM.
 * A digit in the delivered text got there one of two ways.
 *
 *   SUBSTITUTED — code wrote it, at a character position the engine itself
 *   recorded. That is the hard guarantee of rule 20, and no spelling, script,
 *   zero-width character or Unicode version can reach around it.
 *
 *   TYPED — the model wrote it. It is REFUSED unless the claims-linter can trace
 *   it to a declared value, which is the OLD, weaker guarantee: a whole-token
 *   match against the evidence pool. Every one that survives is listed in
 *   `ChatRunResult.substitution.typed`, and `hard_guarantee` is true exactly when
 *   that list is empty.
 *
 * WHY TYPED IS TOLERATED AT ALL, stated rather than discovered later. Rule 20
 * says a bare quantity is a violation, and it is — it is fed back, and if the
 * model will not withdraw it, it is cut. The one exception is a figure the
 * linter can already source: refusing THOSE on the day the prompt changed would
 * chip every true number in every reply from a model that has not yet learned
 * the syntax, and an operator who sees the chip where 508 belongs stops
 * believing the chip. The honest route to zero typed quantities is to watch
 * `typed` empty out, not to break the product to reach it in one commit. What is
 * NOT tolerated, at any magnitude and whatever the evidence says: digits welded
 * onto a substituted value, two values shoved together, a numeral outside the
 * decimal classes, and — the round-3 counter-example — the sub-100 head of a
 * split figure, which the linter's claim floor drops in silence and this engine
 * has no floor to drop it through.
 *
 * WHY CHAT PROSE SKIPS THE JUDGE — do not "fix" this later.
 * Every other generation path in this app runs Law then Judge then one retry
 * (defineFeature, src/lib/agent/features/types.ts). Chat prose deliberately does
 * not, and it is safe precisely because of hard rule 17: a deliverable is never
 * written in chat. Concepts, campaigns, reports, guidelines, rewrites and
 * digests are DISPATCHED to the feature that owns them and arrive back as a
 * card, having passed that feature's Law → Judge → retry cycle unchanged. What
 * is left in the message itself is short, sourced prose — and for that, a
 * deterministic linter that cannot be talked round is a stronger guarantee than
 * a second model's opinion, at a fraction of the latency and the spend. Adding a
 * Judge here would slow every turn to buy an assurance the dispatch boundary
 * already gives.
 *
 * NO SUMMARISATION CALL. History that does not fit the budget is truncated BY
 * CODE (`windowHistory`). A model call to summarise old turns would be spend
 * nobody budgeted and, worse, an unlinted surface: its output would re-enter the
 * context as if it were source material. Code truncation cannot invent.
 *
 * ONE ASSEMBLER. What the model reads is `renderStrategistBlocks()` — the same
 * function, on the same `StrategistData`, that the strategist reads. What the
 * Law traces a number back to is `strategistEvidence()`, the evidence view of
 * that same block list. Two views, one assembler, never a fork. This module
 * takes the DATA, not a pre-rendered string, so a caller cannot hand chat a
 * forked or hand-written context. `collectSourceKeys()` comes from the same
 * block list, so the keys reported here are by construction the keys the model
 * was shown.
 *
 * PURITY. Everything above `openRouterTransport()` is pure: no network, no
 * environment, no clock, no model. `windowHistory`, `stripUnsourcedNumbers` and
 * `runAgentChat` itself (given an injected transport) are exercised with no key
 * present, which is the only way anything here could be tested in this
 * repository at all — see tests/chat-lint.test.ts.
 */

/* ================================================================= types == */

/** One prior turn of the conversation. Tool traffic is not part of history. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A tool the model may call. `parameters` is a JSON Schema object, which both
 * provider wire formats accept (OpenAI calls it `parameters`, Anthropic calls it
 * `input_schema`).
 *
 * NOTE what is NOT here: nothing in this module defines a tool. Hard rule 19 —
 * predefined lookups only — is kept by whoever supplies this array, and the fact
 * that the loop has no built-in tools is what stops it growing a free-SQL escape
 * hatch by accident.
 */
export interface ChatToolSpec {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

/**
 * A type ALIAS rather than an interface, deliberately: the Anthropic SDK types
 * `input_schema` with an index signature, and TypeScript grants an implicit
 * index signature to an object type alias but never to an interface. Written as
 * an interface this shape is unassignable to `Anthropic.Tool` and the map below
 * needs a cast — which is the sort of cast that hides a real mismatch later.
 */
export type ToolParameterSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

/**
 * One value a tool COMPUTED, ready to be evidence.
 *
 * `value` is TEXT, exactly as the tool wrote it into `content`, so nothing here
 * can re-round a figure on its way to the linter — the same contract
 * `StatValue.value` keeps in ./stats.ts and `Measure` keeps in the blocks.
 */
export interface SourcedValue {
  value: string;
  /**
   * Hard rule 12 — the key that resolves this value, where one exists. Omitted
   * rather than invented when the value has no key in the namespace: a made-up
   * key is a citation that resolves to nothing, which is worse than none.
   */
  source_key?: string;
}

/**
 * What a tool handed back.
 *
 * ===========================================================================
 * TWO HALVES, AND ONLY ONE OF THEM IS EVIDENCE
 * ===========================================================================
 *
 * `content` is what the MODEL reads: JSON, a refusal, a catalogue, a sentence
 * naming what went wrong. It is deliberately generous, because a model that can
 * see why it was refused answers better than one that met a silence.
 *
 * `sourced` is what the LINTER reads, and it is the tool's own declaration of
 * the values the SYSTEM produced. Nothing else in this object reaches the lint
 * context.
 *
 * THE DEFECT THIS SHAPE EXISTS TO CLOSE. `content` used to be both. But several
 * tools echo model-supplied strings back inside it — the lookup name that did
 * not exist, the filters that were asked for, the tool name that is not a tool,
 * the feature that cannot be dispatched. Every one of those refusals is free,
 * so a model could call `get_stats("followers_88123")`, have 88123 quoted back
 * to it inside the refusal, and cite 88123 on the next turn as a number "in the
 * context". It was executed and it worked: with `profile_snapshots` empty, the
 * gate delivered a follower count that no row anywhere has ever held.
 *
 * The split is structural rather than a list of the four known echoes. A tool
 * that declares nothing contributes NOTHING to the lint context, so a fifth
 * echo added later fails closed — the number it repeats is simply not evidence,
 * and no one has to remember to add it to a denylist. The cost is that a tool
 * which forgets to declare a real value gets that value stripped out of the
 * reply, which is the direction this app errs in on purpose.
 */
export interface ChatToolResult {
  /** Fed to the model verbatim. NEVER lint evidence — see `sourced`. */
  content: string;
  /**
   * The values this tool COMPUTED, and the whole of what the claims-linter is
   * allowed to trace a number in the reply back to. Absent means this result
   * sources nothing, which is the safe default and never an error.
   */
  sourced?: SourcedValue[];
  /** The source_keys the values in `content` carry, for the log. */
  source_keys?: string[];
  /** A dispatched deliverable, as a card. Never the deliverable's text. */
  card?: Record<string, unknown>;
}

/**
 * The lint evidence one tool result contributes: its declared VALUES, one per
 * line. No key, no label, no prose.
 *
 * THE KEY IS NOT EVIDENCE. This used to render `[key] = "value"` and the whole
 * line was mined, which made the key a second, unguarded channel into the
 * evidence pool — and a key can be minted from data. `runStatLookup`'s cluster
 * lookup builds `performance.clusters.<label>` from `cluster_label`, a string
 * the board-analysis MODEL wrote into post_analyses, and key segments preserve
 * `\p{N}`. A model that had named a cluster could name its own evidence. The
 * key is still rendered into `content` for the agent and still travels in
 * `source_keys` for the log; it simply cannot source a number.
 *
 * A VALUE IS EVIDENCE ONLY WHERE IT IS ITSELF A QUANTITY. `wholeQuantity()` is
 * the same boundary the strategist blocks apply — see `measureEvidence()` in
 * ../strategist/blocks.ts for the doctrine and its cost. A declared date, url,
 * uuid or label contains digits without measuring anything, and drops out here.
 *
 * A result with no `sourced` half renders to the empty string and is dropped
 * from the context entirely. That is the fail-closed property: silence, not
 * trust.
 */
export function lintEvidence(result: ChatToolResult): string {
  return (result.sourced ?? [])
    .filter((entry) => wholeQuantity(entry.value) !== null)
    .map((entry) => entry.value)
    .join('\n');
}

export type ToolExecutor = (call: ChatToolCallRecord) => Promise<ChatToolResult>;

/** One recorded call and what it returned, in the order they happened. */
export interface RecordedTool {
  call: ChatToolCallRecord;
  result: ChatToolResult;
}

/* ------------------------------------------------------------ transport -- */

/**
 * The wire shape, OpenAI-flavoured because that is what the default provider
 * speaks. The Anthropic transport maps it into content blocks; nothing above
 * this line knows which provider answered.
 */
export interface ChatWireMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** On an assistant turn that called tools. */
  tool_calls?: ChatToolCallRecord[];
  /** On a tool turn: which call this answers. */
  tool_call_id?: string;
  name?: string;
}

export interface ChatTransportRequest {
  model: string;
  quality: Quality;
  system: string;
  messages: ChatWireMessage[];
  tools: ChatToolSpec[];
  maxTokens: number;
}

export interface ChatCompletion {
  text: string;
  toolCalls: ChatToolCallRecord[];
  inputTokens: number;
  outputTokens: number;
  refused: boolean;
}

/**
 * How a completion is obtained. Defaulted to the real provider and injectable so
 * the gate can be driven by a fake model — the only way this file runs in a
 * repository with no OPENROUTER_API_KEY.
 */
export type ChatTransport = (request: ChatTransportRequest) => Promise<ChatCompletion>;

/* --------------------------------------------------------------- result -- */

export interface HistoryWindow {
  turns: ChatTurn[];
  /** Whole turns dropped from the front because they did not fit the budget. */
  dropped: number;
  /** True when the oldest KEPT turn was cut mid-way, by code, not by a model. */
  truncated: boolean;
}

/** One substitution fault, as the report keeps it. Diagnostics, never text. */
export interface ChatSubstitutionFault {
  kind: ViolationKind;
  /** Operator-facing, from the engine. Names what was wrong and why it matters. */
  evidence: string;
  /** The offending text, verbatim and truncated. Null when the fault has none. */
  raw: string | null;
  /** The key that failed to resolve, for `unknown-key`. Null otherwise. */
  key: string | null;
}

/**
 * WHERE THE DIGITS IN THIS REPLY CAME FROM.
 *
 * Kept beside `law_report` rather than inside it because `ChatLawReportRow` is
 * the STORED shape (src/lib/types/db.ts) and this is a property of the run. What
 * the row already records — repaired, stripped, every check in order — is
 * unchanged and still true.
 */
export interface ChatSubstitutionReport {
  /** Source keys whose values CODE wrote into the reply, in the order they landed. */
  substituted_keys: string[];
  /**
   * Quantities the MODEL typed that the claims-linter could source, so they were
   * delivered. Each one is a figure resting on the old guarantee.
   */
  typed: string[];
  /** Faults refused: named back to the model once, then redacted or cut out. */
  refused: ChatSubstitutionFault[];
  /**
   * True when every digit in the DELIVERED text was written by this codebase.
   *
   * Refused quantities never reach the operator — they are cut and chipped — so
   * the only model-typed digits that can survive are the tolerated ones, and the
   * guarantee holds exactly when `typed` is empty.
   */
  hard_guarantee: boolean;
}

export interface ChatRunResult {
  /** The delivered text. Linted, and repaired or stripped if it had to be. */
  reply: string;
  /** References to what dispatch produced this turn. Never deliverable text. */
  cards: Record<string, unknown>[];
  tools: RecordedTool[];
  law_report: ChatLawReportRow;
  /** Where the digits came from. See `ChatSubstitutionReport`. */
  substitution: ChatSubstitutionReport;
  /** Every source_key the blocks emitted this turn — what could be cited. */
  source_keys: string[];
  model: string;
  provider: Provider;
  /** Model calls actually made: tool rounds, plus the repair if one happened. */
  calls: number;
  usage: { input_tokens: number; output_tokens: number };
  /** Null when no rate has been verified for this model. Never 0-for-unknown. */
  est_usd: number | null;
  unpriced_reason: string | null;
  history_window: HistoryWindow;
}

export interface RunChatArgs {
  /** The strategist's data. Rendered here by the ONE block assembler. */
  data: StrategistData;
  /** Prior turns, oldest first. */
  history: ChatTurn[];
  /** What the operator just said. */
  message: string;
  quality: Quality;
  tools?: ChatToolSpec[];
  /** Required when `tools` is non-empty. */
  executeTool?: ToolExecutor;
  maxTokens?: number;
  historyTokenBudget?: number;
  /** Defaults to the provider abstraction. Injected by tests. */
  transport?: ChatTransport;
}

/* ============================================================= constants == */

/**
 * The same crude assumption the estimate routes make (src/app/api/digest,
 * /api/board/analyze, /api/visual all declare `CHARS_PER_TOKEN = 2`). It is used
 * here only to decide how much history fits — never to state a cost — so being
 * approximate is harmless in a way it would not be if it priced anything.
 */
const CHARS_PER_TOKEN = 2;

/** How much of the conversation travels with each turn. */
export const HISTORY_TOKEN_BUDGET = 4000;

/** A truncated turn shorter than this is not worth sending; drop it instead. */
const MIN_TRUNCATED_CHARS = 120;

/** Marks a turn the code cut. Contains no digits, so it can state no quantity. */
const TRUNCATION_MARK = '[…] ';

/** Chat answers are short by design (the system prompt says so). */
export const CHAT_MAX_TOKENS = 2000;

/**
 * How many times the model may call tools before it must answer in prose. A
 * bound rather than a trust: an unbounded loop is an unbounded number of
 * requests, and every one of them costs.
 */
export const MAX_TOOL_ROUNDS = 4;

/** Defensive only — see `applyGate`. One pass removes every flagged number. */
const MAX_STRIP_PASSES = 3;

/** What replaces a number that survived the repair. Visible, and in Arabic. */
export const UNSOURCED_CHIP = '«رقم غير موثّق — حُذف»';

/**
 * Unreachable in principle (see `applyGate`), and stated in Arabic rather than
 * as an exception because the alternative to a broken reply is an honest
 * sentence, not a 500. Contains no digits.
 */
export const WITHHELD_REPLY =
  'تعذّر التحقق من الأرقام في هذا الرد، فحُجب. أعِد صياغة السؤال أو اطلب الرقم باسمه.';

const REQUEST_TIMEOUT_MS = 280_000;

/* ========================================================== pure: history == */

function tokensFor(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The newest turns that fit `budgetTokens`, oldest first.
 *
 * Truncation is a SLICE, taken at a whitespace boundary and marked. Two reasons
 * for the boundary: it keeps words whole, and — the load-bearing one — it cannot
 * cut a number in half. `508` sliced into `50` would be a quantity that appears
 * in no source, which is exactly the thing this module exists to prevent. (The
 * linter would catch it downstream; not creating it is better.)
 *
 * Pure. No model is asked to summarise anything: that call would be unbudgeted
 * spend and its output would re-enter the context unlinted.
 */
export function windowHistory(
  history: readonly ChatTurn[],
  budgetTokens: number = HISTORY_TOKEN_BUDGET,
): HistoryWindow {
  const kept: ChatTurn[] = [];
  let remaining = budgetTokens;
  let dropped = 0;
  let truncated = false;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (truncated) {
      dropped += 1;
      continue;
    }

    const cost = tokensFor(turn.content);
    if (cost <= remaining) {
      kept.push(turn);
      remaining -= cost;
      continue;
    }

    const room = remaining * CHARS_PER_TOKEN - TRUNCATION_MARK.length;
    if (room < MIN_TRUNCATED_CHARS) {
      dropped += 1;
      continue;
    }

    // Keep the TAIL: the end of an old turn is the part nearest the present.
    const tail = turn.content.slice(turn.content.length - room);
    const boundary = tail.search(/\s/);
    const cut = boundary === -1 ? tail : tail.slice(boundary + 1);
    kept.push({ role: turn.role, content: TRUNCATION_MARK + cut });
    truncated = true;
    remaining = 0;
  }

  return { turns: kept.reverse(), dropped, truncated };
}

/* ========================================================== pure: strip === */

/**
 * There is no claim regex in this file, and that is the fix.
 *
 * There used to be `METRIC_MIRROR`: a hand-copied duplicate of the linter's claim
 * pattern, kept here because the stripper needs to know WHERE each claim sits
 * while the linter only answers whether any is unsourced. A mirror is a second
 * definition of "a number", and this app has already paid for having two of
 * those — see the header of src/lib/brain/law/claims-linter.ts. The linter now
 * exports the spans it linted, so what gets cut out is by construction what got
 * checked, and there is nothing left to drift.
 */

/** The numbers a failing claims-linter result named, or [] when it named none. */
export function unsourcedFrom(result: LawResult): string[] {
  const listed = result.detail?.unsourced;
  if (!Array.isArray(listed)) return [];
  return listed.filter((entry): entry is string => typeof entry === 'string');
}

export interface StripOutcome {
  text: string;
  /** What was removed, verbatim as the draft wrote it — Arabic-Indic and all. */
  stripped: string[];
}

/**
 * Removes exactly the named numbers and puts the chip where each one stood.
 *
 * Surgical by construction: the only characters that change are the ones inside
 * a matched claim span. Surrounding Arabic — letters, tashkeel, punctuation, the
 * space either side — is copied through untouched, and the trailing space of an
 * unmarked number is deliberately preserved so no two words are welded together.
 */
export function stripUnsourcedNumbers(
  text: string,
  unsourced: readonly string[],
): StripOutcome {
  if (unsourced.length === 0) return { text, stripped: [] };

  // Matched on the linter's own canonical key, so `٧٧٧`, `777` and `0777` are
  // one target and a 17-digit id is not the same target as its neighbour.
  const targets = new Set<string>();
  for (const entry of unsourced) {
    const key = wholeQuantity(entry);
    if (key !== null) targets.add(key);
  }
  if (targets.size === 0) return { text, stripped: [] };

  const spans = claimQuantities(text).filter((claim) => targets.has(claim.key));
  if (spans.length === 0) return { text, stripped: [] };

  const stripped: string[] = [];
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    // The unit marker goes with the figure — a bare `%` left standing would read
    // as a claim the chip did not remove.
    out += text.slice(cursor, span.start) + UNSOURCED_CHIP;
    stripped.push(text.slice(span.start, span.markerEnd));
    cursor = span.markerEnd;
  }
  out += text.slice(cursor);

  return { text: out, stripped };
}

/* ==================================================== pure: substitution == */

/**
 * The keyed values ONE tool result contributes to the map.
 *
 * A `SourcedValue` with a `source_key` is a keyed value by construction: the
 * handler that wrote it declared both halves in the same expression, and
 * `get_stats` already mints `<key>.n` and `<key>.as_of` under the convention the
 * blocks use (see `measureValues()` in ../strategist/blocks.ts).
 *
 * A DECLARATION WITHOUT A KEY CONTRIBUTES NOTHING HERE, and that is not an
 * oversight. `search_posts` declares a row's ig_id, likes and posted_at with no
 * key, because there is no key that resolves "the engagement of the fourth row
 * of this particular search" — hard rule 12 says an invented key is worse than
 * none. Those values remain lint evidence, so a model that types one still gets
 * it through; what they cannot be is the target of a placeholder, because a
 * placeholder must name something a reader could look up afterwards.
 */
export function toolValues(result: ChatToolResult): KeyedValue[] {
  const entries: KeyedValue[] = [];
  for (const declared of result.sourced ?? []) {
    const key = declared.source_key;
    if (key === undefined) continue;
    entries.push({ key, value: declared.value });
  }
  return entries;
}

/**
 * Whether a substitution violation is a quantity the claims-linter could source.
 *
 * ONLY `bare-quantity` IS ELIGIBLE. A `glued-value` is digits welded onto a
 * substituted value, two values shoved together, or a unit the model chose — a
 * figure ASSEMBLED out of real ones, which is exactly the fabrication that has no
 * evidence to be traced to however real its parts were. A placeholder fault is
 * not a quantity at all. See the header for why this tolerance exists and what it
 * costs.
 *
 * The comparison is the linter's own canonical key against the linter's own
 * evidence set — not a second notion of "the same number".
 */
function accountedFor(
  violation: SubstitutionViolation,
  sourced: ReadonlySet<string>,
): boolean {
  if (violation.kind !== 'bare-quantity') return false;
  const raw = violation.raw;
  if (raw === undefined) return false;
  const key = wholeQuantity(raw);
  return key !== null && sourced.has(key);
}

/** A violation as the run result keeps it. Never deliverable text. */
function toFault(violation: SubstitutionViolation): ChatSubstitutionFault {
  return {
    kind: violation.kind,
    evidence: violation.evidence,
    raw: violation.raw ?? null,
    key: violation.key ?? null,
  };
}

/**
 * Cuts refused quantities out of the SUBSTITUTED text and chips them.
 *
 * The counterpart of `stripUnsourcedNumbers` for the numbers the linter would
 * never flag: a sub-100 head, a superscript, digits glued to a real value. It
 * cuts SPANS THE ENGINE REPORTED rather than re-deciding what a number is, so
 * what is removed is by construction what was refused.
 *
 * TWO THINGS IT TAKES FROM THE ONE TOKENISER RATHER THAN RESTATING. The unit
 * marker travels with the figure — a bare `٪` left standing reads as a claim the
 * chip did not remove — and `quantities()` is where a marker's end is known.
 * Nothing here holds a pattern for digits or for units; the header of
 * src/lib/brain/law/claims-linter.ts is the list of what a second one costs.
 *
 * Only violations located in the FINAL text are cut. A placeholder fault is
 * located in the DRAFT, where its offsets mean something and where cutting them
 * out of the final text would slice the wrong characters; the engine has already
 * put `[?]` where it stood.
 */
export function stripSubstitutionViolations(
  text: string,
  violations: readonly SubstitutionViolation[],
): StripOutcome {
  const spans = violations
    .filter((violation) => violation.frame === 'final' && violation.end > violation.start)
    .map((violation) => ({ start: violation.start, end: violation.end }))
    .sort((left, right) => left.start - right.start || right.end - left.end);
  if (spans.length === 0) return { text, stripped: [] };

  const markerEnds = new Map<number, number>();
  for (const quantity of quantities(text)) markerEnds.set(quantity.end, quantity.markerEnd);

  const stripped: string[] = [];
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    // A span already inside a wider cut — the two-values rule reports the pair
    // AND each half can report itself — is not cut twice.
    if (span.start < cursor) continue;
    const end = Math.max(span.end, markerEnds.get(span.end) ?? span.end);
    out += text.slice(cursor, span.start) + UNSOURCED_CHIP;
    stripped.push(text.slice(span.start, end));
    cursor = end;
  }
  out += text.slice(cursor);

  return { text: out, stripped };
}

/* ============================================================ pure: cost == */

/** Six decimals, not cents: a chat turn can honestly cost less than a cent. */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function estimateCost(
  model: string,
  usage: { input_tokens: number; output_tokens: number },
): { est_usd: number | null; unpriced_reason: string | null } {
  const rate = rateFor(model);
  if (rate === null) return { est_usd: null, unpriced_reason: unpricedReason(model) };
  return {
    est_usd: roundUsd(
      (usage.input_tokens * rate.in) / 1_000_000 + (usage.output_tokens * rate.out) / 1_000_000,
    ),
    unpriced_reason: null,
  };
}

/* ============================================================= pure: gate == */

function toRow(result: LawResult): ChatLawResultRow {
  return {
    check: result.check,
    passed: result.passed,
    evidence: result.evidence,
    severity: result.severity,
  };
}

/** How many faults are quoted back. A repair message is not a lint report. */
const MAX_REPAIR_FAULTS = 6;

/**
 * The repair instruction, naming what failed — the SPECIFIC fault, from the
 * engine's own evidence, not a restatement of the rule.
 *
 * A subtlety worth stating: this message QUOTES the offending numbers back at
 * the model, and it is a conversation message — it never joins the lint context.
 * The context is the blocks and the tool results, and nothing else, so echoing a
 * bad number here cannot launder it into a sourced one on the next pass. The same
 * holds for a rejected KEY: naming it here tells the model what to fix, and the
 * key still resolves to nothing.
 *
 * Both halves can fire at once — a typed figure that is also unsourced is a
 * substitution fault AND a lint failure — and both are said, because a model told
 * only half of what is wrong fixes half of it.
 */
function repairInstruction(
  faults: readonly SubstitutionViolation[],
  unsourced: readonly string[],
): string {
  const lines: string[] = [];

  if (faults.length > 0) {
    lines.push(
      `Your draft broke the substitution contract in ${faults.length} place(s):`,
      ...faults.slice(0, MAX_REPAIR_FAULTS).map((fault) => `- ${fault.evidence}`),
      'Write every quantity about this client as {{source.key}} — two braces, the key exactly as the blocks spell it inside the square brackets, no spaces inside the braces — and the code substitutes the value. Do not type the digits yourself.',
    );
  }

  if (unsourced.length > 0) {
    lines.push(
      `Your draft stated ${unsourced.length} number(s) that appear nowhere in the blocks or the tool results you were given: ${unsourced.join(', ')}.`,
    );
  }

  lines.push(
    'Rewrite the reply now. State only quantities that appear verbatim in the provided context, each with its source key.',
    'Where a figure you wanted does not exist, say which computation is missing and offer to open a request for it. Do not estimate, round, or re-derive it.',
    'Reply with the corrected message only.',
  );

  return lines.join('\n');
}

/* ======================================================= transport: shared = */

function toolsForRequest(tools: readonly ChatToolSpec[]): ChatToolSpec[] {
  return tools.map((tool) => ({ ...tool }));
}

/* =================================================== transport: openrouter = */

interface OpenRouterToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterChatResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenRouterToolCall[] | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number };
}

function openRouterMessages(system: string, messages: readonly ChatWireMessage[]): unknown[] {
  return [
    { role: 'system', content: system },
    ...messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          content: message.content,
          tool_call_id: message.tool_call_id ?? '',
          name: message.name,
        };
      }
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        return {
          role: 'assistant',
          content: message.content,
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        };
      }
      return { role: message.role, content: message.content };
    }),
  ];
}

/**
 * The same endpoint, headers, timeout and error vocabulary as
 * `callOpenRouter` in src/lib/agent/client.ts — plus `tools`. No second HTTP
 * client, no SDK, no wrapper: one `fetch` against the OpenAI-compatible route,
 * exactly as the JSON path and the vision path already do.
 */
async function openRouterTransport(request: ChatTransportRequest): Promise<ChatCompletion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${requireEnv('OPENROUTER_API_KEY')}`,
        'content-type': 'application/json',
        'x-title': 'ThinkQuality Studio',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        reasoning: { effort: effortFor(request.quality) },
        messages: openRouterMessages(request.system, request.messages),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
              tool_choice: 'auto',
            }
          : {}),
      }),
    });

    const payload = (await response.json().catch(() => null)) as OpenRouterChatResponse | null;

    if (!response.ok) {
      throw new HttpError(
        502,
        `OpenRouter returned ${response.status}: ${payload?.error?.message ?? response.statusText}`,
        `Check the model id "${request.model}" is spelled exactly as listed on openrouter.ai/models, and that the key has credit.`,
      );
    }
    if (payload?.error) {
      throw new HttpError(502, `OpenRouter error: ${payload.error.message ?? 'unknown'}`);
    }

    const choice = payload?.choices?.[0];
    const calls: ChatToolCallRecord[] = [];
    (choice?.message?.tool_calls ?? []).forEach((call, index) => {
      const name = call.function?.name;
      if (!name) return;
      calls.push({
        id: call.id ?? `call_${index + 1}`,
        name,
        arguments: call.function?.arguments ?? '{}',
      });
    });

    return {
      text: (choice?.message?.content ?? '').trim(),
      toolCalls: calls,
      inputTokens: payload?.usage?.prompt_tokens ?? 0,
      outputTokens: payload?.usage?.completion_tokens ?? 0,
      refused: choice?.finish_reason === 'content_filter',
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HttpError(
        504,
        'The model took too long to respond.',
        'Try the standard tier, or a shorter question.',
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ==================================================== transport: anthropic = */

let anthropicClient: Anthropic | null = null;

function anthropic(): Anthropic {
  const provider = resolveProvider();
  if (provider !== 'anthropic') {
    throw new Error(
      `anthropic() was called while the resolved provider is "${provider}" — this is a bug, not a missing key.`,
    );
  }
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: requireEnv(providerKeyName(provider)) });
  }
  return anthropicClient;
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A model that emitted unparseable arguments gets an empty object rather
    // than a crash; the tool decides what a missing argument means.
    return {};
  }
}

/**
 * The wire shape above, mapped to Anthropic content blocks.
 *
 * Consecutive tool results are merged into ONE user turn: Anthropic expects the
 * results of a parallel tool call to arrive together, and sending them as
 * separate user messages would misrepresent the order the model called them in.
 */
function anthropicMessages(messages: readonly ChatWireMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingResults: Anthropic.ToolResultBlockParam[] = [];

  function flush(): void {
    if (pendingResults.length === 0) return;
    out.push({ role: 'user', content: pendingResults });
    pendingResults = [];
  }

  /**
   * Two plain turns of the same role become one. The blocks travel as the first
   * user message and the operator's question as the last, so a conversation
   * whose history opens on a user turn would otherwise hand Anthropic two user
   * turns in a row — which its models are trained to read as one anyway. Doing
   * the join here means the text is combined the way we intend rather than the
   * way a provider happens to.
   */
  function pushPlain(role: 'user' | 'assistant', content: string): void {
    const last = out[out.length - 1];
    if (last && last.role === role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${content}`;
      return;
    }
    out.push({ role, content });
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      pendingResults.push({
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: message.content,
      });
      continue;
    }

    flush();

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseArguments(call.arguments),
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    pushPlain(message.role, message.content);
  }

  flush();
  return out;
}

/**
 * Streamed through the SDK for the same reason `callAnthropic` streams: a long
 * generation must not trip an HTTP idle timeout. That is invisible to the
 * caller — `finalMessage()` is awaited here and a completed reply is returned,
 * so rule 16 holds unchanged. Streaming the transport is not streaming the
 * answer.
 */
async function anthropicTransport(request: ChatTransportRequest): Promise<ChatCompletion> {
  const stream = anthropic().messages.stream({
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    thinking: { type: 'adaptive' },
    output_config: { effort: effortFor(request.quality) },
    messages: anthropicMessages(request.messages),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
  });

  const message = await stream.finalMessage();

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  const toolCalls = message.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input),
    }));

  return {
    text,
    toolCalls,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    refused: message.stop_reason === 'refusal',
  };
}

/** Provider-agnostic by the same rule as runAgentJson: the contract is elsewhere. */
export const defaultChatTransport: ChatTransport = (request) =>
  resolveProvider() === 'openrouter' ? openRouterTransport(request) : anthropicTransport(request);

/* ================================================================== run === */

/**
 * One chat turn, from the operator's message to a reply that has already been
 * linted. See the header for the gate and for why there is no streaming path.
 */
export async function runAgentChat(args: RunChatArgs): Promise<ChatRunResult> {
  const tools = toolsForRequest(args.tools ?? []);
  const executeTool = args.executeTool;
  if (tools.length > 0 && !executeTool) {
    throw new Error('runAgentChat: tools were supplied without an executor.');
  }

  const transport = args.transport ?? defaultChatTransport;
  const provider = resolveProvider();
  const model = modelFor(args.quality, provider);
  const maxTokens = args.maxTokens ?? CHAT_MAX_TOKENS;

  // Only the real transport needs a key. An injected one must be able to run
  // with none, which is the only way this path is exercised in this repository.
  if (!args.transport) requireEnv(providerKeyName(provider));

  /* ---- context: the ONE assembler, on the strategist's own data ---------- */

  const blocks = renderStrategistBlocks(args.data);
  // The evidence view of the same blocks. Built here, beside the render, so the
  // two are visibly one assembler read twice rather than two sources of truth.
  const evidence = strategistEvidence(args.data);
  const sourceKeys = [...collectSourceKeys(args.data)];

  const window = windowHistory(args.history, args.historyTokenBudget ?? HISTORY_TOKEN_BUDGET);

  const messages: ChatWireMessage[] = [
    { role: 'user', content: blocks },
    ...window.turns.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: args.message },
  ];

  const usage = { input_tokens: 0, output_tokens: 0 };
  const recorded: RecordedTool[] = [];
  const cards: Record<string, unknown>[] = [];
  let calls = 0;

  function account(completion: ChatCompletion): void {
    usage.input_tokens += completion.inputTokens;
    usage.output_tokens += completion.outputTokens;
    calls += 1;
    if (completion.refused) {
      throw new HttpError(
        502,
        'The model declined this request.',
        'Rephrase the question and try again.',
      );
    }
  }

  /* ---- the tool loop ----------------------------------------------------- */

  let draft = '';

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    // The last round is offered WITHOUT tools, so a model that keeps calling
    // them is made to answer rather than looping at the operator's expense.
    const offered = round === MAX_TOOL_ROUNDS ? [] : tools;
    const completion = await transport({
      model,
      quality: args.quality,
      system: CHAT_SYSTEM,
      messages,
      tools: offered,
      maxTokens,
    });
    account(completion);

    if (completion.toolCalls.length === 0 || !executeTool) {
      draft = completion.text;
      break;
    }

    messages.push({
      role: 'assistant',
      content: completion.text,
      tool_calls: completion.toolCalls,
    });

    for (const call of completion.toolCalls) {
      let result: ChatToolResult;
      try {
        result = await executeTool(call);
      } catch (err) {
        // A refusal is an answer. Hard rule 18's cap refusal, a missing lookup,
        // a dispatch that would not run — the model must be able to SAY so, so
        // the failure travels back as a tool result instead of a 500.
        //
        // NOTHING IS DECLARED SOURCED HERE, and that is the point: `call.name`
        // is a string the MODEL chose and `reason` is an exception message
        // nobody shaped, so neither is evidence for a quantity. The real tools
        // never reach this path — `createChatToolExecutor` shapes its own
        // failures and declares what they source — so this is the last net, and
        // a net fails closed.
        const reason = err instanceof Error ? err.message : 'The tool failed.';
        result = { content: `TOOL ERROR (${call.name}): ${reason}` };
      }
      recorded.push({ call, result });
      if (result.card) cards.push(result.card);
      messages.push({
        role: 'tool',
        content: result.content,
        tool_call_id: call.id,
        name: call.name,
      });
    }

    draft = completion.text;
  }

  // An empty message is legitimate ONLY when a card carries the turn — rule 17
  // allows one line of framing, and no lines is a choice. Empty with no card is
  // a blank bubble the operator cannot act on, and it is reported as the failure
  // it is rather than rendered.
  if (draft.trim() === '' && cards.length === 0) {
    throw new HttpError(
      502,
      'The model returned an empty reply.',
      'Ask the question again, or switch the model quality toggle in the header.',
    );
  }

  /* ---- the gate ---------------------------------------------------------- */

  /* THE LINT CONTEXT: the DECLARED VALUES of the blocks, plus the DECLARED half
   * of every tool result. Not the blocks. Not any prose.
   *
   * `strategistEvidence` is the evidence view of the SAME block list the model
   * read a moment ago — one assembler, two views, so the evidence can never be
   * about a different set of measures than the agent was shown. What it leaves
   * out is what a model or a client wrote: captions, comments, questions,
   * titles, decision statements and every source_key. See `measureEvidence()`
   * in ../strategist/blocks.ts for why, and for what that costs.
   *
   * `lintEvidence` reads `result.sourced` and nothing else, so a tool's
   * human-readable `content` — which may quote back the lookup name, the
   * filters, the tool name or the feature the MODEL supplied — cannot be cited
   * as its own source. A tool that declares no values contributes an empty
   * string and is dropped here rather than trusted. */
  const context = [evidence, ...recorded.map((entry) => lintEvidence(entry.result))]
    .filter((part) => part !== '')
    .join('\n\n');

  /* WHAT THE LINTER CAN TRACE, computed ONCE for the turn.
   *
   * The same set `claimsLinter` builds internally, and it is built here for the
   * one other question that needs it: whether a quantity the model TYPED is one
   * the linter could source. Asking that per violation would rescan the whole
   * context per number; asking it with a second notion of "the same number" would
   * be the two-tokenisers defect again. */
  const sourcedValues = contextQuantities(context);

  /* THE VALUE MAP: what the code may write into the reply on the model's behalf.
   *
   * Blocks first, then the turn's tool results — `measureValues` and `toolValues`
   * both mint `<key>.n` and `<key>.as_of` under one convention, and
   * `buildValueMap` drops any key two sources disagree about. This is the SAME
   * block list `renderStrategistBlocks` rendered and `strategistEvidence`
   * distilled: one assembler, three views. */
  const values = buildValueMap([
    ...measureValues(collectMeasures(args.data)),
    ...recorded.flatMap((entry) => toolValues(entry.result)),
  ]);

  const results: LawResult[] = [];

  /* SUBSTITUTE, THEN LINT. In that order, and the order is the design: the
   * linter reads the text the OPERATOR will read, so a placeholder that resolved
   * to a caption full of digits is linted as that caption, not as `{{key}}`. */
  let substituted = substitute(draft, values);
  let delivered = substituted.final;
  let refused = substituted.violations.filter(
    (violation) => !accountedFor(violation, sourcedValues),
  );

  let lint = claimsLinter(delivered, context);
  results.push(lint);
  let repaired = false;

  if (refused.length > 0 || !lint.passed) {
    repaired = true;
    messages.push({ role: 'assistant', content: draft });
    messages.push({
      role: 'user',
      content: repairInstruction(refused, unsourcedFrom(lint)),
    });

    // No tools on the repair. The failure was a stated number or a mis-typed
    // key, not a missing lookup, and re-opening the tool surface here would let
    // one bad draft turn into a second round of spend.
    const retry = await transport({
      model,
      quality: args.quality,
      system: CHAT_SYSTEM,
      messages,
      tools: [],
      maxTokens,
    });
    account(retry);
    draft = retry.text;
    substituted = substitute(draft, values);
    delivered = substituted.final;
    refused = substituted.violations.filter(
      (violation) => !accountedFor(violation, sourcedValues),
    );
    lint = claimsLinter(delivered, context);
    results.push(lint);
  }

  /* ---- second violation: strip, in place, and say so --------------------- */

  const stripped: string[] = [];

  /* THE SUBSTITUTION FAULTS FIRST, and they are cut whatever the linter thinks.
   * These are the figures the linter cannot see: a sub-100 head under its claim
   * floor, a superscript outside its digit class, digits welded onto a real
   * value. A placeholder fault carries no digits into the text — the engine put
   * `[?]` where it stood — so there is nothing to cut for one. */
  if (refused.length > 0) {
    const outcome = stripSubstitutionViolations(delivered, refused);
    if (outcome.stripped.length > 0) {
      delivered = outcome.text;
      stripped.push(...outcome.stripped);
      lint = claimsLinter(delivered, context);
      results.push(lint);
    }
  }

  for (let pass = 1; !lint.passed && pass <= MAX_STRIP_PASSES; pass += 1) {
    const outcome = stripUnsourcedNumbers(delivered, unsourcedFrom(lint));
    if (outcome.stripped.length === 0) break;
    delivered = outcome.text;
    stripped.push(...outcome.stripped);
    lint = claimsLinter(delivered, context);
    results.push(lint);
  }

  if (!lint.passed) {
    // Unreachable while the stripper cuts what the linter linted — it now cuts
    // the linter's own spans, so there is no mirror left to drift. The safe
    // direction is to say nothing rather than to say a number nobody can
    // source, so the reply is withheld and the report records why.
    results.push(
      fail(
        'chat-gate',
        'The claims-linter still reported an unsourced number after stripping, so the reply was withheld.',
      ),
    );
    delivered = WITHHELD_REPLY;
    lint = claimsLinter(delivered, context);
    results.push(lint);
  }

  const law_report: ChatLawReportRow = {
    passed: lint.passed,
    repaired,
    stripped,
    results: results.map(toRow),
  };

  /* The tolerated class, named. Every quantity here is one the MODEL typed and
   * the linter could source — delivered, and resting on the old guarantee. An
   * empty list is the whole of what `hard_guarantee` claims. */
  const typed = substituted.violations
    .filter((violation) => accountedFor(violation, sourcedValues))
    .map((violation) => violation.raw ?? '');

  const substitution: ChatSubstitutionReport = {
    substituted_keys: substituted.substitutions.map((made) => made.key),
    typed,
    refused: refused.map(toFault),
    hard_guarantee: typed.length === 0,
  };

  const cost = estimateCost(model, usage);

  return {
    reply: delivered,
    cards,
    tools: recorded,
    law_report,
    substitution,
    source_keys: sourceKeys,
    model,
    provider,
    calls,
    usage,
    est_usd: cost.est_usd,
    unpriced_reason: cost.unpriced_reason,
    history_window: window,
  };
}
