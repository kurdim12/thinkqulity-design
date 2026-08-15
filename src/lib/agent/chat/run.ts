import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '@/lib/auth';
import { requireEnv } from '@/lib/env';
import type { Quality } from '@/lib/prefs';
import { claimsLinter, fail, normaliseDigits, type LawResult } from '@/lib/brain/law';
import type { ChatLawReportRow, ChatLawResultRow, ChatToolCallRecord } from '@/lib/types/db';
// Re-exported because anyone writing a `ToolExecutor` needs this shape, and the
// row type and the runtime type must stay the same type — not two that agree.
export type { ChatToolCallRecord } from '@/lib/types/db';
import {
  collectSourceKeys,
  renderStrategistBlocks,
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
 *   2. The draft is linted by the REAL claims-linter (src/lib/brain/law) against
 *      the rendered strategist blocks AND every tool result this turn produced.
 *   3. A violation buys exactly ONE repair — the failing numbers are named back
 *      to the model and it drafts again, without tools.
 *   4. A second violation is not argued with. The offending numbers are
 *      SURGICALLY REMOVED from the text and replaced, in place, with a visible
 *      «رقم غير موثّق — حُذف» marker, and the law report says which numbers went.
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
 * ONE ASSEMBLER. The context is built by `renderStrategistBlocks()` — the same
 * function, on the same `StrategistData`, that the strategist reads. This module
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
 * What a tool handed back.
 *
 * `content` is fed to the model verbatim AND becomes part of the context the
 * linter checks the reply against — those are the same string on purpose. A tool
 * result the model can read but the linter cannot see would be a hole straight
 * through rule 16.
 */
export interface ChatToolResult {
  content: string;
  /** The source_keys the values in `content` carry, for the log. */
  source_keys?: string[];
  /** A dispatched deliverable, as a card. Never the deliverable's text. */
  card?: Record<string, unknown>;
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

export interface ChatRunResult {
  /** The delivered text. Linted, and repaired or stripped if it had to be. */
  reply: string;
  /** References to what dispatch produced this turn. Never deliverable text. */
  cards: Record<string, unknown>[];
  tools: RecordedTool[];
  law_report: ChatLawReportRow;
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
 * MIRRORS `METRIC` in src/lib/brain/law/claims-linter.ts, character for
 * character, and the filter below mirrors that file's `extract()`.
 *
 * Why a mirror rather than an import: the linter's regex is module-private and
 * the linter answers a different question — "is anything unsourced?" — while
 * this file needs WHERE each claim sits so it can be cut out. Duplication is the
 * cost; drift is the risk, and it is covered two ways. At runtime `applyGate`
 * re-lints after stripping and never delivers text the real linter still
 * rejects. In tests, chat-lint.test.ts asserts the stripped output passes the
 * real linter, so a change to `METRIC` that this mirror did not follow fails
 * there rather than in production.
 */
const METRIC_MIRROR = /(\d[\d,]*(?:\.\d+)?)\s*(%|×|x\b)?/g;

interface ClaimSpan {
  start: number;
  end: number;
  value: number;
}

/**
 * Every metric claim in `normalised`, with its offsets.
 *
 * THE PROPERTY THIS RESTS ON: `normaliseDigits` maps one digit character to one
 * digit character (Arabic-Indic ٠-٩ and extended ۰-۹ → ASCII), so the normalised
 * string is the SAME LENGTH as the original and every offset means the same
 * thing in both. That is what makes it possible to find a claim in normalised
 * text and cut it out of Arabic text without touching a single surrounding
 * letter, mark or space.
 */
function claimSpans(normalised: string): ClaimSpan[] {
  const spans: ClaimSpan[] = [];

  for (const match of normalised.matchAll(METRIC_MIRROR)) {
    const raw = match[1];
    const marked = Boolean(match[2]);
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const isYear = !marked && value >= 1900 && value <= 2100 && !raw.includes(',');
    if (isYear) continue;
    if (!marked && value < 100) continue;

    const start = match.index ?? -1;
    if (start < 0) continue;

    // `\s*` is greedy and the unit marker is optional, so an unmarked match
    // swallows the space that follows it. Give that space back, or the chip
    // would glue itself to the next Arabic word.
    const text = marked ? match[0] : match[0].replace(/\s+$/, '');
    spans.push({ start, end: start + text.length, value });
  }

  return spans;
}

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

  const targets = new Set<number>();
  for (const entry of unsourced) {
    const value = Number(normaliseDigits(entry).replace(/,/g, ''));
    if (Number.isFinite(value)) targets.add(value);
  }
  if (targets.size === 0) return { text, stripped: [] };

  const spans = claimSpans(normaliseDigits(text)).filter((span) => targets.has(span.value));
  if (spans.length === 0) return { text, stripped: [] };

  const stripped: string[] = [];
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + UNSOURCED_CHIP;
    stripped.push(text.slice(span.start, span.end));
    cursor = span.end;
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

/**
 * The repair instruction, naming what failed.
 *
 * A subtlety worth stating: this message QUOTES the offending numbers back at
 * the model, and it is a conversation message — it never joins the lint context.
 * The context is the blocks and the tool results, and nothing else, so echoing a
 * bad number here cannot launder it into a sourced one on the next pass.
 */
function repairInstruction(unsourced: readonly string[]): string {
  const list = unsourced.join(', ');
  return [
    `Your draft stated ${unsourced.length} number(s) that appear nowhere in the blocks or the tool results you were given: ${list}.`,
    'Rewrite the reply now. State only quantities that appear verbatim in the provided context, each with its source key.',
    'Where a figure you wanted does not exist, say which computation is missing and offer to open a request for it. Do not estimate, round, or re-derive it.',
    'Reply with the corrected message only.',
  ].join('\n');
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
        // the failure travels back as a tool result instead of a 500. It also
        // becomes part of the lint context, which is correct: a cap message
        // naming a number is a source for that number.
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

  const context = [blocks, ...recorded.map((entry) => entry.result.content)].join('\n\n');
  const results: LawResult[] = [];

  let lint = claimsLinter(draft, context);
  results.push(lint);
  let repaired = false;

  if (!lint.passed) {
    repaired = true;
    messages.push({ role: 'assistant', content: draft });
    messages.push({ role: 'user', content: repairInstruction(unsourcedFrom(lint)) });

    // No tools on the repair. The failure was a stated number, not a missing
    // lookup, and re-opening the tool surface here would let one bad draft turn
    // into a second round of spend.
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
    lint = claimsLinter(draft, context);
    results.push(lint);
  }

  /* ---- second violation: strip, in place, and say so --------------------- */

  const stripped: string[] = [];
  let delivered = draft;

  for (let pass = 1; !lint.passed && pass <= MAX_STRIP_PASSES; pass += 1) {
    const outcome = stripUnsourcedNumbers(delivered, unsourcedFrom(lint));
    if (outcome.stripped.length === 0) break;
    delivered = outcome.text;
    stripped.push(...outcome.stripped);
    lint = claimsLinter(delivered, context);
    results.push(lint);
  }

  if (!lint.passed) {
    // Unreachable unless METRIC_MIRROR has drifted from the linter's own regex.
    // The safe direction is to say nothing rather than to say a number nobody
    // can source, so the reply is withheld and the report records why.
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

  const cost = estimateCost(model, usage);

  return {
    reply: delivered,
    cards,
    tools: recorded,
    law_report,
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
