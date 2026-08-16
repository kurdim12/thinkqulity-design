import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ammanIsoDate } from '@/lib/mcp/tools';
import { canonicalHandles } from '@/lib/ingest/handles';
import {
  fetchExternal,
  pageExcerpt,
  retrievalEvidenceFrom,
  supabaseWebLedger,
  MAX_FETCHES_PER_DAY,
} from '@/lib/web/fetch';
import { clientIdentity, externalFact, externalFactRow } from '@/lib/web/facts';

/**
 * ===========================================================================
 * THE OPERATOR'S RETRIEVAL SURFACE — hard rules 21 and 22
 * ===========================================================================
 * This route is the CALLER src/lib/web/fetch.ts did not have.
 *
 * WHY IT WAS WRITTEN RATHER THAN THE MODULE DELETED. The v3 lesson is real —
 * careful machinery nothing calls is not a feature — but the remedy v4 actually
 * applied to src/lib/ingest/media.ts was to SHIP THE READER WITH THE WRITER, not
 * to delete the writer. Three facts made that the right call again here:
 *
 *   1. 0008_external_facts.sql IS APPLIED. `web_fetch_days`, `web_retrievals`,
 *      `external_facts`, `web_reserve_fetch` and `web_settle_retrieval` are in
 *      the database now, and hard rule 6 (additive migrations, never rewritten)
 *      means they stay there. Deleting the only code that can write to an applied
 *      ledger leaves a LARGER dead surface than the one it removes, and a table
 *      nothing can ever insert into is the same failure one level down.
 *   2. THE READ SIDE ALREADY EXISTS AND NAMES THIS SCREEN. `get_external_facts`
 *      in src/lib/agent/chat/tools.ts tells a model, in its own description,
 *      "Retrieval is an operator's act on its own surface" — and that surface was
 *      never built. `readExternalClaims` in src/lib/chat/transcript.ts refuses
 *      claims at the last mile. src/lib/web/facts.ts is the whole rule-21 class.
 *      All of it reads rows that nothing could produce.
 *   3. `external_facts.retrieval_id` IS NOT NULL REFERENCES `web_retrievals`.
 *      With no fetch there is no ledger row, so there is no fact, so rule 21's
 *      machinery governs an empty table. Wiring the fetch is what turns both
 *      rules from a design into a thing that happens.
 *
 * ---------------------------------------------------------------------------
 * WHY RETRIEVING AND FILING ARE TWO REQUESTS
 * ---------------------------------------------------------------------------
 * POST fetches a page. PUT files one claim read off it. They are separate
 * because a human cannot write down what a page says before seeing it, and
 * because the split is the same one rule 22 draws between the two acts:
 *
 *   POST spends. It takes a cap unit and writes a ledger row BEFORE the request,
 *        it is `trigger: 'operator'` with the signed-in operator's own email in
 *        `triggered_by`, and it reaches the network.
 *   PUT  spends nothing and reaches nothing. It reads a ledger row back and
 *        inserts one `external_facts` row against it.
 *
 * THE FILING REQUEST CARRIES AN ID, NOT A URL. `source_url` and `retrieved_at`
 * are read out of the ledger by `retrievalEvidenceFrom()` and are never taken
 * from the caller — see the argument on that function. `page_title` is the one
 * field this surface does accept from the browser, because `web_retrievals` has
 * no column for it and rule 6 forbids rewriting an applied migration; it is a
 * LABEL, never a claim, it cannot lower the rule-21 ratchet (the scan reads the
 * claim, the ledger's URL and the topic as well, and can only ever escalate),
 * and it is the only thing on this path an operator supplies about the page.
 *
 * ---------------------------------------------------------------------------
 * A REFUSED FETCH IS A 200, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * `fetchExternal` never throws: a capped day, an SSRF refusal and a dead server
 * are all settled ledger rows with typed reasons. This route returns them as
 * `{ ok: false, ... }` with the retrieval id, because the row IS the result and
 * the operator needs to see which one it was and that it was recorded. An error
 * envelope would collapse "the guard refused this host" and "the request failed"
 * into one red toast and hide the ledger id behind it. Only a request this route
 * could not act on at all — bad body, not signed in, a filing against a
 * retrieval that read nothing — is a 4xx.
 */

export const dynamic = 'force-dynamic';
/** Bounded by FETCH_TIMEOUT_MS inside the module; this is the outer envelope. */
export const maxDuration = 60;

const CLIENT_MEASURES = [
  'followers',
  'following',
  'post_count',
  'engagement',
  'verification',
] as const;

const retrieveSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
  })
  .strict();

const fileSchema = z
  .object({
    retrieval_id: z.string().uuid(),
    /** VERBATIM AS PUBLISHED. Stored exactly as typed; never summarised here. */
    claim: z.string().trim().min(1).max(4000),
    topic: z.string().trim().min(1).max(120),
    kind: z.enum(['statistic', 'statement', 'definition', 'event', 'listing']),
    confidence: z.enum(['unverified', 'corroborated', 'contradicted']).optional(),
    page_title: z.string().trim().max(300).nullish(),
    about: z
      .object({
        account: z.enum(['personal', 'academy']),
        measure: z.enum(CLIENT_MEASURES).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Who the client is, for the rule-21 ratchet.
 *
 * The handles come from `canonicalHandles()` — the proven usernames every stored
 * post routes through — and the two display names are the ones this codebase
 * already writes verbatim in its own prompts (src/lib/agent/system.ts and the
 * compliance rewriter). Nothing here is invented: an alias nobody verified would
 * be configuration wearing the shape of a fact, and a WRONG alias would only
 * ever cost the ratchet an escalation it should have made.
 */
function identity() {
  const handles = canonicalHandles();
  return clientIdentity(
    [handles.personal, 'Ahmad Kahtan'],
    [handles.academy, 'Think Quality Academy'],
  );
}

function badBody(error: z.ZodError): HttpError {
  return new HttpError(
    400,
    'Invalid request.',
    error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  );
}

/* -------------------------------------------------------------- retrieve -- */

/**
 * POST /api/web — retrieve one public page, ledgered and counted.
 *
 * The trigger is `operator` and `triggered_by` is the signed-in operator's own
 * email, which is what discharges rule 22's "operator-triggered": the ledger
 * names a person, not a boolean. No model, no tool and no schedule can reach
 * this handler — it is behind `requireOperator()` and it is not published to any
 * tool registry.
 */
export async function POST(request: Request) {
  try {
    const operator = await requireOperator();

    const parsed = retrieveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw badBody(parsed.error);

    // The clock is read HERE and passed down. Nothing inside the fetch module
    // decides what day it is, and neither does the database.
    const now = new Date();
    const outcome = await fetchExternal(supabaseWebLedger(supabaseAdmin()), {
      url: parsed.data.url,
      trigger: { kind: 'operator', operator: operator.email },
      ammanDay: ammanIsoDate(now),
      retrievedAt: now.toISOString(),
      // No USD ceiling is configured for this path and none is invented: a
      // direct https GET has a verified rate of zero (see WEB_PROVIDER_RATES),
      // so the binding constraint is the COUNT, and that is MAX_FETCHES_PER_DAY.
      budgetUsd: null,
    });

    if (!outcome.ok) {
      return NextResponse.json({
        ok: false,
        reason: outcome.reason,
        detail: outcome.detail,
        retrieval_id: outcome.retrieval_id,
        http_status: outcome.http_status,
        fetches_reserved_today: outcome.fetches_reserved_today,
        daily_cap: MAX_FETCHES_PER_DAY,
      });
    }

    return NextResponse.json({
      ok: true,
      retrieval: {
        retrieval_id: outcome.retrieval.retrieval_id,
        requested_url: outcome.retrieval.requested_url,
        final_url: outcome.retrieval.final_url,
        retrieved_at: outcome.retrieval.retrieved_at,
        page_title: outcome.retrieval.page_title,
      },
      http_status: outcome.http_status,
      content_type: outcome.content_type,
      bytes: outcome.bytes,
      truncated: outcome.truncated,
      redirects: outcome.redirects,
      fetches_reserved_today: outcome.fetches_reserved_today,
      daily_cap: MAX_FETCHES_PER_DAY,
      // What the operator reads before quoting. Never stored, never shown to a
      // model — see pageExcerpt().
      excerpt: pageExcerpt(outcome.body, outcome.content_type),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ------------------------------------------------------------------ file -- */

/**
 * PUT /api/web — file one claim read off an already-ledgered retrieval.
 *
 * Reaches no network and takes no cap unit. The URL and the retrieval instant
 * come out of `web_retrievals`; the caller supplies the sentence, where it is
 * filed, and what class of claim it is. `externalFact()` runs the rule-21
 * ratchet over all of it, and `externalFactRow()` is the only insert payload —
 * it has no `source_key` field because the table has no such column.
 */
export async function PUT(request: Request) {
  try {
    await requireOperator();

    const parsed = fileSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw badBody(parsed.error);
    const body = parsed.data;

    const db = supabaseAdmin();
    const { data, error } = await db
      .from('web_retrievals')
      .select('id, url, final_url, status, settled_at')
      .eq('id', body.retrieval_id)
      .maybeSingle();

    if (error) throw new Error(`Could not read the retrieval: ${error.message}`);

    const evidence = retrievalEvidenceFrom(data, body.page_title ?? null);
    if (!evidence.ok) {
      throw new HttpError(
        evidence.reason === 'not-settled' ? 409 : 404,
        'That claim cannot be filed.',
        evidence.detail,
      );
    }

    const built = externalFact(
      evidence.retrieval,
      {
        claim: body.claim,
        topic: body.topic,
        kind: body.kind,
        confidence: body.confidence,
        about: body.about,
      },
      identity(),
    );

    if (!built.ok) throw new HttpError(400, 'That claim cannot be filed.', built.detail);

    const { data: inserted, error: insertError } = await db
      .from('external_facts')
      .insert(externalFactRow(built.fact))
      .select('id, created_at')
      .single();

    if (insertError) {
      // The unique (retrieval_id, claim) constraint is the one an operator will
      // actually hit, and it is worth naming: the same sentence recorded twice
      // off one page would read as corroboration to somebody counting rows.
      throw new HttpError(
        409,
        'That claim could not be stored.',
        `${insertError.message}. The same claim filed twice against one retrieval is refused by the ` +
          'database, because two copies of one sentence read as two sources.',
      );
    }

    const row = inserted as { id: string; created_at: string };

    return NextResponse.json({
      fact: { id: row.id, created_at: row.created_at, ...built.fact },
      // True when the operator did NOT declare this as a claim about the client
      // and the scan raised the flag anyway. Shown, because it is the operator's
      // cue that a page they read as a world fact is talking about them.
      escalated: built.escalated,
      scan: built.scan,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ------------------------------------------------------------------- read -- */

/**
 * GET /api/web — the screen's state: today's cap, recent attempts, filed claims.
 *
 * The ledger is shown WHOLE, refusals included. A surface that listed only the
 * successful fetches would be the ledger-written-afterwards mistake 0008 exists
 * to avoid: the refused attempt and the one that hung are the two rows worth
 * looking at.
 */
export async function GET() {
  try {
    await requireOperator();
    const db = supabaseAdmin();
    const day = ammanIsoDate(new Date());

    const [dayRow, retrievals, facts] = await Promise.all([
      db.from('web_fetch_days').select('amman_day, reserved_fetches').eq('amman_day', day).maybeSingle(),
      db
        .from('web_retrievals')
        .select('id, url, host, final_url, trigger, triggered_by, status, http_status, bytes, note, requested_at, settled_at')
        .order('requested_at', { ascending: false })
        .limit(25),
      db
        .from('external_facts')
        .select('id, retrieval_id, claim, source_url, page_title, retrieved_at, topic, kind, confidence, about_client, client_account, client_measure, created_at')
        .order('retrieved_at', { ascending: false })
        .limit(50),
    ]);

    if (retrievals.error) throw new Error(`Could not read the retrieval ledger: ${retrievals.error.message}`);
    if (facts.error) throw new Error(`Could not read the external facts: ${facts.error.message}`);
    // A FAILED READ IS NOT A ZERO. No row for today genuinely means zero — the
    // day row is created by the first reservation — but a refused query means
    // the count is UNKNOWN, and reporting an unknown as "0 of 40 spent" is a
    // number nobody measured on a screen (hard rule 2).
    if (dayRow.error) throw new Error(`Could not read today's fetch count: ${dayRow.error.message}`);

    const used = (dayRow.data as { reserved_fetches: number } | null)?.reserved_fetches ?? 0;

    return NextResponse.json({
      cap: { amman_day: day, reserved_fetches: used, daily_cap: MAX_FETCHES_PER_DAY },
      retrievals: retrievals.data ?? [],
      facts: facts.data ?? [],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
