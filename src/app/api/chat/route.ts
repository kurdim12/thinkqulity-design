import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { readQuality } from '@/lib/prefs.server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadStrategistData } from '@/lib/agent/strategist/blocks';
import { todayInAmman } from '@/lib/agent/features/strategist';
import { runAgentChat, type ChatTurn } from '@/lib/agent/chat/run';
import { chatToolSpecs, createChatToolExecutor } from '@/lib/agent/chat/tools';
import type { ChatMessageRow, ChatToolCallRecord, ConversationRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * ===========================================================================
 * /api/chat — THE ONLY DOOR ONTO THE CHAT SURFACE
 * ===========================================================================
 *
 * POST — send one message. Returns the COMPLETED, LINTED reply plus any cards.
 * GET  — list conversations, or load one with its turns.
 *
 * WHY THERE IS NO STREAM HERE, and why that is not a thing to optimise later.
 * Hard rule 16: nothing reaches a screen before the claims-linter has passed the
 * draft. `runAgentChat` has no way to emit a partial reply — it returns a
 * finished one — and this route has no way to forward what it never receives.
 * A retracted number is worse than a slow answer, so `maxDuration` is generous
 * and the response is a single JSON body.
 *
 * THE EXPORT SURFACE IS THE NEXT ALLOW-LIST AND NOTHING ELSE.
 * `next build` validates every export of a route module against a fixed list
 * (GET/POST/…, dynamic, revalidate, runtime, maxDuration, …) and fails the build
 * on anything else — a rule `tsc --noEmit` cannot see, because it lives in types
 * Next generates into .next/. A CI build has already failed on exactly this. So
 * everything here is either an allow-listed export or a module-private helper;
 * anything that needs to be shared or tested lives in src/lib/.
 *
 * WHAT THIS ROUTE PERSISTS, AND IN WHICH ORDER (0006_chat.sql):
 *   1. the operator's message — BEFORE the model runs, so a turn that crashes
 *      still leaves what they said on the record;
 *   2. one `tool` row per tool result, verbatim as it was fed back to the model,
 *      because it is half of the context the linter checked the reply against;
 *   3. the assistant turn, with its cards, its tool calls, its law_report and
 *      its est_usd.
 * The rows are inserted one at a time rather than in one batch: `created_at`
 * defaults to now(), a batched insert would stamp every row with the SAME
 * instant, and the read below orders by created_at. Sequential inserts give
 * strictly increasing timestamps. (A monotonic sequence column would be
 * stronger; that is a migration this task does not own.)
 * ===========================================================================
 */

/* ================================================================== input == */

const postSchema = z.object({
  /** Null or absent starts a new conversation. */
  conversation_id: z.string().uuid().nullish(),
  message: z.string().trim().min(1).max(8000),
});

const listLimitSchema = z.coerce.number().int().min(1).max(200);

/** Turns carried into the model. Tool rows are NOT history — see ./run.ts. */
const HISTORY_ROLES = ['user', 'assistant'] as const;

/** How many prior turns are read back. `windowHistory` then fits them to budget. */
const HISTORY_SCAN = 100;

/** Conversations listed when the caller names no limit. */
const DEFAULT_LIST_LIMIT = 50;

/* ================================================================ helpers == */

function badRequest(issues: z.ZodError): HttpError {
  return new HttpError(
    400,
    'Invalid request body.',
    issues.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
  );
}

/**
 * A title for a new conversation: THE OPERATOR'S OWN FIRST LINE, quoted and
 * truncated — never a generated summary.
 *
 * 0006_chat.sql says the column is nullable because "a placeholder title would
 * be a fabricated summary of a thread with no turns in it". Quoting what the
 * operator actually typed is not a summary and not a placeholder; it is their
 * words, shortened. The cut is taken at a whitespace boundary for the same
 * reason `windowHistory` does it: a slice through `508` would leave `50` on a
 * screen, a quantity that appears in no source.
 */
function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  if (flat.length <= 80) return flat;
  const head = flat.slice(0, 80);
  const boundary = head.lastIndexOf(' ');
  return `${boundary > 20 ? head.slice(0, boundary) : head}…`;
}

/* =================================================================== POST == */

/**
 * POST /api/chat
 * body: { conversation_id?: string | null, message: string }
 */
export async function POST(request: Request) {
  try {
    await requireOperator();

    const body: unknown = await request.json().catch(() => ({}));
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) throw badRequest(parsed.error);
    const { message } = parsed.data;

    const db = supabaseAdmin();
    const quality = await readQuality();

    /* -- the conversation -------------------------------------------------- */

    let conversationId = parsed.data.conversation_id ?? null;
    let history: ChatTurn[] = [];

    if (conversationId === null) {
      const { data, error } = await db
        .from('conversations')
        .insert({ title: titleFrom(message) })
        .select('id, title, created_at')
        .single();
      if (error) throw new Error(`Could not open a conversation: ${error.message}`);
      conversationId = (data as ConversationRow).id;
    } else {
      // Read the thread AND prove it exists in one go: a POST naming a
      // conversation that is not there must be a 404, not a silent new thread
      // whose turns nobody can find.
      const { data, error } = await db
        .from('conversations')
        .select('id')
        .eq('id', conversationId)
        .maybeSingle();
      if (error) throw new Error(`Could not read the conversation: ${error.message}`);
      if (data === null) throw new HttpError(404, 'No such conversation.');

      // NEWEST first with the cap applied, then reversed. Reading ascending
      // under a limit would hand the model the OLDEST hundred turns of a long
      // thread and drop everything that has been said since — `windowHistory`
      // can only fit a budget to what it is given.
      const { data: rows, error: readError } = await db
        .from('chat_messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .in('role', [...HISTORY_ROLES])
        .order('created_at', { ascending: false })
        .limit(HISTORY_SCAN);
      if (readError) throw new Error(`Could not read the transcript: ${readError.message}`);

      history = ((rows as { role: string; content: string }[] | null) ?? [])
        .filter((row): row is { role: 'user' | 'assistant'; content: string } =>
          row.role === 'user' || row.role === 'assistant',
        )
        .map((row) => ({ role: row.role, content: row.content }))
        .reverse();
    }

    /* -- the operator's words, recorded before anything can fail ----------- */

    const { error: userError } = await db
      .from('chat_messages')
      .insert({ conversation_id: conversationId, role: 'user', content: message });
    if (userError) throw new Error(`Could not record the message: ${userError.message}`);

    /* -- the context: the strategist's own data, through the ONE assembler -- */

    const data = await loadStrategistData(db, { today: todayInAmman() });

    /* -- the turn ----------------------------------------------------------
     * TOOLS COME FROM THE ONE CLOSED ALLOW-LIST, `CHAT_TOOL_NAMES`.
     *
     * Rule 19 — predefined lookups only — is kept by that tuple being fixed at
     * compile time in src/lib/agent/chat/tools.ts, not by this route restating
     * it. An earlier revision of this file published only `dispatch_feature` and
     * answered every other name with `unknown_tool`, which meant get_stats,
     * search_posts, get_brand and run_compliance were built, tested and
     * UNREACHABLE from the running app: the surface could dispatch a deliverable
     * but could not answer "what is each account's average engagement" from the
     * named lookups at all. Publishing the specs and delegating to the shared
     * executor is what makes the allow-list one list instead of two.
     *
     * `createChatToolExecutor` already routes `dispatch_feature` to ./dispatch.ts
     * (with the audience corpus substitution) and already answers an unknown name
     * with a structured refusal plus a card — so neither is re-implemented here.
     * It never throws; every failure comes back as a shaped tool result.
     *
     * WHAT v6 ADDED, AND WHY NEITHER NEEDED A LINE HERE. `get_knowledge` — the
     * decks, the Canon chunks and the References, verbatim with attribution — is
     * a seventh member of that same tuple, so it arrives through
     * `chatToolSpecs()` and is executed by the same executor; this route did not
     * have to learn its name. And the LINK CONTRACT, which lets a reply send the
     * operator to a screen without inventing a URL, is carried on the tool
     * results as ordinary keyed values and written into the reply by the
     * substitution engine inside `runAgentChat`. So a link is already linted,
     * already substituted and already persisted by the same three steps below
     * that a figure is. A route that had to special-case either one would be a
     * route that could get either one wrong.
     *
     * `now` is fixed ONCE for the whole turn so the cap window cannot shift
     * between the read and the reservation.
     * -------------------------------------------------------------------- */

    const chat = await runAgentChat({
      data,
      history,
      message,
      quality,
      tools: chatToolSpecs(),
      executeTool: createChatToolExecutor({ db, quality, now: new Date() }),
    });

    /* -- persist the turn --------------------------------------------------- */

    for (const entry of chat.tools) {
      const { error } = await db.from('chat_messages').insert({
        conversation_id: conversationId,
        role: 'tool',
        content: entry.result.content,
        tool_calls: [entry.call] satisfies ChatToolCallRecord[],
        cards: entry.result.card ? [entry.result.card] : null,
      });
      if (error) throw new Error(`Could not record a tool result: ${error.message}`);
    }

    const { data: assistantRow, error: assistantError } = await db
      .from('chat_messages')
      .insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: chat.reply,
        cards: chat.cards.length > 0 ? chat.cards : null,
        tool_calls: chat.tools.length > 0 ? chat.tools.map((entry) => entry.call) : null,
        law_report: chat.law_report,
        // The CHAT TURN's spend only. A dispatched feature's own cost is on its
        // card, under its own key, because it was billed by a different call
        // against a different model — adding them would produce one number that
        // no single source_key explains, and a null plus a number is not a sum.
        est_usd: chat.est_usd,
      })
      .select('*')
      .single();
    if (assistantError) throw new Error(`Could not record the reply: ${assistantError.message}`);

    return NextResponse.json({
      conversation_id: conversationId,
      message: assistantRow as ChatMessageRow,
      reply: chat.reply,
      cards: chat.cards,
      law_report: chat.law_report,
      source_keys: chat.source_keys,
      tools: chat.tools.map((entry) => ({
        call: entry.call,
        source_keys: entry.result.source_keys ?? [],
        card: entry.result.card ?? null,
      })),
      model: chat.model,
      provider: chat.provider,
      calls: chat.calls,
      usage: chat.usage,
      est_usd: chat.est_usd,
      unpriced_reason: chat.unpriced_reason,
      history_window: chat.history_window,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ==================================================================== GET == */

/**
 * GET /api/chat            — the conversations, newest first.
 * GET /api/chat?id=<uuid>  — one conversation and every turn in it, in order.
 *
 * The single-conversation read returns TOOL ROWS TOO. They are what the reply
 * was linted against, so a transcript without them is an audit trail that
 * cannot be audited: a number sourced by a tool result would look unsourced.
 */
export async function GET(request: Request) {
  try {
    await requireOperator();

    const params = new URL(request.url).searchParams;
    const db = supabaseAdmin();

    const id = params.get('id');
    if (id !== null) {
      const { data: conversation, error } = await db
        .from('conversations')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(`Could not read the conversation: ${error.message}`);
      if (conversation === null) throw new HttpError(404, 'No such conversation.');

      const { data: messages, error: readError } = await db
        .from('chat_messages')
        .select('*')
        .eq('conversation_id', id)
        .order('created_at', { ascending: true });
      if (readError) throw new Error(`Could not read the transcript: ${readError.message}`);

      return NextResponse.json({
        conversation: conversation as ConversationRow,
        messages: (messages as ChatMessageRow[] | null) ?? [],
      });
    }

    // A malformed `limit` is refused rather than clamped: silently answering a
    // different question than the one asked is how a caller comes to believe a
    // page is the whole list.
    const rawLimit = params.get('limit');
    let limit = DEFAULT_LIST_LIMIT;
    if (rawLimit !== null) {
      const parsedLimit = listLimitSchema.safeParse(rawLimit);
      if (!parsedLimit.success) throw badRequest(parsedLimit.error);
      limit = parsedLimit.data;
    }

    const { data, error } = await db
      .from('conversations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`Could not list conversations: ${error.message}`);

    return NextResponse.json({ conversations: (data as ConversationRow[] | null) ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}
