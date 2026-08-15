import { NextResponse } from 'next/server';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { requireEnv, optionalEnv, hasEnv, apifyBudgetUsd } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSnapshotFrom, type SnapshotResult } from '@/lib/ingest/snapshot';
import { canonicalHandles } from '@/lib/ingest/handles';
import { estimateScrape, checkBudget, type ScrapeEstimate } from '@/lib/ingest/budget';
import {
  mirrorPostMedia,
  mirrorMediaEnabled,
  skippedMirrorReport,
  type MirrorCandidate,
  type MirrorMediaResult,
} from '@/lib/ingest/media';
import { scanCoverage, MAX_POSTS_SCAN, type ScanCoverage } from '@/lib/audience/posts';
import { resolveProvider, providerKeyName } from '@/lib/agent/provider';
import { todayIso } from '@/lib/snapshots';
import type { Account, ScrapeKind } from '@/lib/types/db';
import { GET as profileGet, POST as profilePost } from '@/app/api/profile/route';
import { GET as commentsGet, POST as commentsPost } from '@/app/api/comments/route';
import { GET as analyzeGet, POST as analyzePost } from '@/app/api/board/analyze/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DEFAULT_ACTOR = 'apify~instagram-scraper';
const KIND: ScrapeKind = 'monitor';
const RAW_BUCKET = 'brand-assets';

/**
 * Per-profile ceiling on what the actor is asked for. Not the binding limit any
 * more — `importCap` in the start action clamps harder, because a run that
 * cannot be imported must not be bought (rule 9). This stays as the guard
 * against an absurd `limit` in the request body.
 */
const MAX_RESULTS = 5000;

/* ------------------------------------------------- the 128 MB isolate ----- *
 *
 * These four numbers exist because a Cloudflare Worker isolate is capped at a
 * hard 128 MB, shared across concurrent requests, and exceeding it is Error
 * 1102: the isolate is discarded, uncatchably. There is no error page and no
 * ledger row — which is precisely the failure this route must not have, since
 * by import time the actor has already run and already been charged for.
 *
 * WHAT ONE ITEM COSTS. The mean serialised item size for this actor config is
 * an ESTIMATE, and is labelled as one. Two real `apify~instagram-scraper`
 * exports measured on the operator's machine (20 items total) average 1.15 KB,
 * but they carry 14 flat scalar fields and no nested arrays — that is a FLOOR,
 * not this app's shape. This route requests `resultsType: 'posts'` with
 * `addParentData: true`, and src/lib/ingest/apify.ts reads fields absent from
 * those exports (hashtags, mentions, firstComment, videoPlayCount, dimensions,
 * location), so a real item here also carries `latestComments`, `childPosts`
 * for carousels, CDN URLs, and a parent profile record attached to every item.
 * The working figure is ~8 KB/item. It could not be grounded against the
 * corpus: `posts.raw` is null for all 320 rows (they predate the column, as
 * 0002_v3_ingestion says) and `scrape_runs` is empty, so no production payload
 * exists to measure yet.
 *
 * WHY BYTES AND NOT ONLY ITEMS. MAX_IMPORT_BYTES is the ceiling that actually
 * protects the isolate, because it is MEASURED page by page as the payload is
 * stored rather than assumed from a mean. If items are fatter than estimated it
 * trips sooner; if leaner, the item ceiling trips first. The estimate above only
 * decides which of the two is expected to bind, never whether the isolate is
 * safe. Both are loud (see CeilingBreach); neither ever truncates.
 *
 * THE ARITHMETIC, at B = accumulated serialised bytes of the mappable payload:
 *   parsed items held for mapping          ~3.0 x B   (V8 object + string
 *                                                      overhead over JSON text)
 *   ParsedPost wrappers (raw by reference) ~0.5 x B
 *   one insert chunk + its request body    ~0.4 x B   (250 of 2000 rows)
 *   ------------------------------------------------
 *   mapping peak                           ~3.9 x B
 * At B = 16 MB that is ~62 MB, leaving ~66 MB of the 128 MB for the Worker
 * baseline and concurrency. The old code reached ~7 x B because it also held a
 * whole-dataset JSON.stringify and a whole-dataset insert body; both are gone.
 *
 * WHAT THE OLD CEILING MEANT. MAX_IMPORT_ITEMS was 50_000. At the estimated
 * 8 KB that is 400 MB of payload and a ~2.8 GB peak. Even at the MEASURED
 * 1.15 KB floor it is 57 MB of payload, whose single `JSON.stringify` copy
 * alone is ~115 MB as a V8 two-byte string (Arabic captions force two-byte) —
 * the isolate is gone before the upload is even attempted. It fit on Vercel
 * because that was a multi-GB lambda.
 * -------------------------------------------------------------------------- */

/** The most items one import will MAP. The item-count face of MAX_IMPORT_BYTES. */
const MAX_IMPORT_ITEMS = 2_000;

/** The most serialised payload bytes one import will MAP. The binding guard. */
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

/* ------------------------------------ the 1,000 subrequest budget -------- *
 *
 * The OTHER hard limit this route lives under, and the one the memory fix above
 * walked straight into. A Workers invocation on the Paid plan may make 1,000
 * subrequests, and EVERY fetch counts: every Apify page, every Storage upload,
 * every Supabase query, every CDN download the mirror makes. The 1,001st throws.
 *
 * WHAT THE MEMORY FIX COST. It took the dataset page from 1000 items to 250 and
 * began uploading each page as it arrived. Both were right for memory and both
 * cost subrequests: four times the fetches per item, and an upload per fetch
 * instead of one upload for the whole dataset. At the ceiling this file used to
 * declare — 200,000 items — that is 800 fetches + 800 uploads = 1,600
 * subrequests. The invocation died around 125,000 items, so the declared ceiling
 * was a number that could not happen, which is exactly what hard rule 2 forbids.
 *
 * THE FIX IS TO STOP SIZING THE READ AND THE WRITE WITH ONE NUMBER:
 *   a PAGE is one Apify fetch     — DATASET_PAGE items, sized by MEMORY
 *   a PART is one Storage upload  — RAW_OBJECT_PAGES pages, sized by SUBREQUESTS
 * A page is serialised and its parsed form dropped the instant it lands, so the
 * memory fix is untouched; the serialised BYTES of a few pages are then written
 * as one object, so an upload no longer costs a subrequest per page.
 *
 * SUBREQUEST ARITHMETIC, at MAX_RAW_ITEMS = 75,000:
 *   items per page             DATASET_PAGE                       250
 *   pages per part             RAW_OBJECT_PAGES                     2  (500 items)
 *   subrequests per page       1 Apify fetch + 1/2 an upload   =  1.5
 *
 *   Apify page fetches                     75,000 / 250  =       300
 *   Storage uploads                        ceil(300 / 2) =       150
 *   the manifest, written last                                     1
 *   -------------------------------------------------------------------
 *   the raw step at the ceiling                                  451
 *
 *   everything else one import invocation can do:
 *     requireOperator() -> supabase.auth.getUser()                 1  (+1 if the
 *                                                        session token is refreshed)
 *     GET /actor-runs/<id>                                         1
 *     the ledger row, when the caller passed no ledgerId           1
 *     EITHER — the raw crossed a mapping ceiling and is refused:
 *       closing the import row + the breach ledger row             2
 *     OR — it is mapped:
 *       createSnapshotFrom(): the previous snapshot, its ig_ids,
 *         the snapshot insert, and ceil(2000 / 250) chunked post
 *         inserts (INSERT_CHUNK is 250 in ingest/snapshot.ts)     11
 *       closing the import row                                     1
 *       the media mirror WITH MIRROR_MEDIA ON: the read-back, up
 *         to 2 accounts x MAX_INDEX_PAGES (20) listings, up to
 *         MAX_MIRROR_OBJECTS (200) downloads and as many uploads,
 *         then its own ledger row                                442
 *
 *   The two heavy halves are MUTUALLY EXCLUSIVE today: a run at the raw
 *   ceiling is 75,000 items, far past MAX_IMPORT_ITEMS, so it is refused and
 *   never reaches the mirror; a run that is mapped and mirrored holds at most
 *   2,000 items, whose raw step is at most 9 fetches (exactly 2,000 items is 8
 *   full pages plus the empty page that ends the loop) + 4 uploads + 1 manifest
 *   = 14.
 *     the refused run at the raw ceiling     3 + 451 + 2          =  456
 *     the mapped-and-mirrored run            3 + 14 + 12 + 442    =  471
 *   The figure this file budgets against is nevertheless the SUM of both
 *   halves, because it is what the budget has to survive if MAX_IMPORT_ITEMS
 *   is ever raised to where they can co-occur:
 *     3 + 451 + 12 + 442                                          =  908
 *     (909 with a token refresh)
 *   -------------------------------------------------------------------
 *   headroom left of the 1,000                                92 (91)
 *
 * With MIRROR_MEDIA off — the default, and the flag is now read BEFORE the
 * read-back — the mirror costs 1 subrequest (its ledger row) and the summed
 * bound is 3 + 451 + 12 + 1 = 467. Two things the count assumes: a CDN download
 * that answers directly (each hop of a followed redirect is one more
 * subrequest), and no other route being delegated to from the import action —
 * profile, comments and analyze run in their own invocations.
 *
 * PEAK MEMORY, the constraint that motivated 250, still holds — and the buffer
 * is BYTES, not strings, so batching pages costs less than the memory fix's own
 * per-page upload did. Nothing parsed is ever held between pages. At the same
 * estimated ~8 KB/item, one page is P = 250 x 8 KB = 2 MB of JSON text, and this
 * file's own conventions above apply: a parsed page is ~3.0 x its text, and a
 * V8 string of it is ~2 x its text because Arabic captions force two-byte.
 *   the page just fetched, parsed (`batch`)          ~3.0 x P  =   ~6 MB
 *   its JSON.stringify string, a transient of the
 *     statement that encodes it, counted anyway
 *     because collection is not immediate            ~2.0 x P  =   ~4 MB
 *   its UTF-8 bytes, held in `pending`                1.0 x P  =   ~2 MB
 *   the earlier page's bytes, held in `pending`       1.0 x P  =   ~2 MB
 *   the part body, one Buffer.concat at flush         2.0 x P  =   ~4 MB
 *   -------------------------------------------------------------------
 *   the raw step's worst instant, at a flush                       ~18 MB
 *   resident during the upload (pending released)    6 + 4    =   ~10 MB
 * For comparison the memory fix's per-page string upload was ~6 + ~4 + the
 * request's own UTF-8 encoding ~2 = ~12 MB resident during the upload; the
 * bytes-not-strings buffer is why the worst instant here is only ~6 MB more
 * and the resident figure is ~2 MB less. Against the mapping accumulator at its
 * own ceiling (~3.0 x MAX_IMPORT_BYTES = ~48 MB, still growing while pages
 * arrive) that is ~66 MB, and the accumulator overshoots by at most one part
 * before the byte ceiling drops it. That is a little above the ~62 MB mapping
 * peak budgeted above, still ~62 MB under the 128 MB isolate, and the buffer is
 * gone before mapping begins.
 *
 * THE TRADE, stated once so neither number moves alone. With n pages per part
 * the raw step at the ceiling costs 300 + ceil(300 / n) + 1 subrequests (n=1:
 * 601, n=2: 451, n=3: 401, n=4: 376) and each extra page adds ~4 MB to the
 * worst instant (~2 MB more held in `pending`, ~2 MB more part body). Halving
 * DATASET_PAGE halves the transient and doubles the fetches.
 * -------------------------------------------------------------------------- */

/**
 * The most items one run will page into STORAGE at all.
 *
 * A subrequest number, not a memory number: raw storage is paged, so size costs
 * fetches rather than resident bytes, and 75,000 is what fits in the budget
 * counted above with headroom left. Raw is still stored whether or not it can be
 * mapped (rule 8) — this bounds how much of it one invocation can page, nothing
 * else.
 *
 * Nothing this pipeline can START comes near it: `importCap` in the start action
 * divides MAX_IMPORT_ITEMS across the profiles, so a run of the two canonical
 * handles asks the actor for at most 2,000 items in total. The ceiling binds
 * only when importing a run started outside this pipeline, which is the only way
 * a dataset this large reaches this route at all.
 */
const MAX_RAW_ITEMS = 75_000;

/**
 * Items per Apify fetch. THE MEMORY NUMBER: one page is parsed, serialised and
 * its parsed form dropped before the next is fetched, so this sets the largest
 * live object graph the raw step ever holds. It was 1000, which at the same
 * estimate (~8 KB/item, parsed ~3 x text, string ~2 x text) is 8 MB of text and
 * a ~40 MB transient for a single page, against ~10 MB at 250.
 */
const DATASET_PAGE = 250;

/**
 * Pages per stored object. THE SUBREQUEST NUMBER: it divides the upload cost of
 * a run without touching what a fetch costs in memory, because what is held
 * between pages is UTF-8 bytes, not items and not strings. 2 keeps the raw
 * step's worst instant at ~18 MB and the whole import inside the
 * 1,000-subrequest budget with 92 spare, both counted in the block above.
 */
const RAW_OBJECT_PAGES = 2;

/** The bytes a flush puts around and between the pages of one part. */
const RAW_ARRAY_OPEN = Buffer.from('[', 'utf8');
const RAW_ARRAY_COMMA = Buffer.from(',', 'utf8');
const RAW_ARRAY_CLOSE = Buffer.from(']', 'utf8');

const DEFAULT_LIMIT = 200;
const DEFAULT_ANALYZE_CHUNK = 25;

/**
 * Instagram monitoring — one operator gesture, several bounded calls.
 *
 * A full-history scrape takes far longer than any HTTP request should live —
 * ten posts per profile already runs ~110s — so the run is started, polled and
 * imported separately rather than held open on one synchronous call. v3 keeps
 * that shape and extends it into a pipeline, because a monitor run is no longer
 * just "fetch posts":
 *
 *   POST { action: "start" }               -> new posts, both accounts
 *   GET  ?runId=…&step=posts               -> poll
 *   POST { action: "import", runId }       -> snapshot, then the media mirror
 *   POST { action: "profile" }             -> follower/bio refresh
 *   POST { action: "comments" }            -> comments for posts entering the top-N
 *   GET  ?runId=…&step=comments            -> poll
 *   POST { action: "comments-import", … }  -> map them into the corpus
 *   POST { action: "analyze" }             -> analyse newly ingested posts (v2 gap)
 *
 * Every response carries `next`: the exact call to make after it. The pipeline
 * is therefore resumable at any step — a failure loses one step, not the run —
 * and no single call is long enough to time out.
 *
 * The steps after the snapshot delegate to /api/profile, /api/comments and
 * /api/board/analyze by importing their handlers directly. That is deliberate:
 * the mapping, the budget guard and the analysis prompt each stay in exactly
 * one place, and there is no self-fetch to deadlock on.
 *
 * Reading only throughout. No Meta OAuth, no Graph API, no write scope.
 */

type Json = Record<string, unknown>;

interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId: string;
  startedAt?: string;
  finishedAt?: string | null;
  usageTotalUsd?: number;
  stats?: { outputItemCount?: number };
}

const ACTIONS = ['start', 'import', 'profile', 'comments', 'comments-import', 'analyze'] as const;
type Action = (typeof ACTIONS)[number];

type Step = 'posts' | 'import' | 'profile' | 'comments' | 'comments-import' | 'analyze' | 'done';

interface NextCall {
  step: Step;
  route: string;
  method: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: Json;
}

function actorId(): string {
  return optionalEnv('APIFY_ACTOR') ?? DEFAULT_ACTOR;
}

function apifyToken(): string {
  if (!hasEnv('APIFY_TOKEN')) {
    throw new HttpError(
      503,
      'Automated monitoring is not configured.',
      'Add APIFY_TOKEN to .env.local (apify.com → Settings → Integrations), or upload an export by hand on the Data screen.',
    );
  }
  return requireEnv('APIFY_TOKEN');
}

async function apify<T>(path: string, init?: RequestInit): Promise<T> {
  const token = apifyToken();
  const joiner = path.includes('?') ? '&' : '?';
  const response = await fetch(
    `https://api.apify.com/v2${path}${joiner}token=${encodeURIComponent(token)}`,
    init,
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new HttpError(
      502,
      `Apify returned ${response.status}.`,
      detail.slice(0, 300) || 'Check the token is valid and the account has credits left.',
    );
  }

  return (await response.json()) as T;
}

/* ------------------------------------------------------------- the ledger -- */

async function ledger(row: {
  kind: ScrapeKind;
  actor: string;
  input: Json;
  estimated_usd: number | null;
  actual_results: number | null;
  status: string;
  raw_path: string | null;
}): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from('scrape_runs')
    .insert(row)
    .select('id')
    .single();

  if (error || !data) {
    throw new HttpError(
      500,
      `Could not write the scrape ledger: ${error?.message ?? 'no row returned'}`,
      'Nothing was scraped — the ledger is written first on purpose.',
    );
  }
  return (data as { id: string }).id;
}

/* ---------------------------------------------------------------- the raw -- */

/**
 * One stored object, as the manifest lists it — up to RAW_OBJECT_PAGES dataset
 * pages concatenated into a single JSON array of items. `bytes` is measured on
 * the body that was actually uploaded, not summed from the pages inside it.
 */
interface RawPart {
  path: string;
  /** Dataset pages written into this object. */
  pages: number;
  items: number;
  bytes: number;
}

/**
 * A ceiling the import refused to cross. Never a truncation: the payload is
 * stored in full either way, and this is the loud half of saying so.
 */
interface CeilingBreach {
  ceiling: 'items' | 'bytes' | 'raw_items';
  limit: number;
  observed: number;
  message: string;
  hint: string;
}

interface RawImportMeta {
  /** The manifest, written last: its presence means the raw set is complete. */
  manifest_path: string;
  /** One entry per stored object, in the order they were written. */
  parts: RawPart[];
  /** Apify page fetches this run made — one subrequest each. */
  total_pages: number;
  total_items: number;
  total_bytes: number;
  /**
   * True when paging stopped at MAX_RAW_ITEMS. A SUSPICION that the stored raw
   * is a prefix, not proof of one — the same shape `scanCoverage()` uses for a
   * capped read. The loop stops at the ceiling without asking Apify whether
   * anything follows, so a dataset ending exactly on it reports the same as one
   * that continues past it. There is deliberately no count of what was left
   * behind: that number is not knowable from here, and inventing it is the
   * fabrication this flag exists to avoid.
   */
  raw_truncated: boolean;
}

/**
 * The outcome of storing a dataset's raw payload page by page.
 *
 * A discriminated union rather than a nullable `items`, so the refusal path is
 * unmissable at the call site and neither branch needs a non-null assertion.
 */
type RawImport =
  | ({ mappable: true; items: unknown[] } & RawImportMeta)
  | ({ mappable: false; breach: CeilingBreach } & RawImportMeta);

/** How far storeRawPaged got, readable by the caller after a throw. */
interface RawProgress {
  /** Items CONFIRMED in storage — advanced when a part lands, not when a page is fetched. */
  items: number;
  parts: number;
}

/**
 * Fetches the dataset and stores it, one page at a time.
 *
 * HARD RULE 8 IS STRENGTHENED, NOT WEAKENED. The complete payload still reaches
 * storage before any mapping happens — it now reaches it *sooner*, part by part
 * as it arrives, instead of being held whole and written once at the end. The
 * set is stored as `part-0000.json`, `part-0001.json`, … under one prefix, with
 * a `manifest.json` written last that lists every part, the pages inside it, its
 * item count and its byte count. The manifest existing is what makes the set
 * complete; a run that died mid-paging leaves parts but no manifest, and claims
 * no raw_path. Each part is a plain JSON array of items, exactly as a single
 * page was, so a re-import reads a part the same way it read a page.
 *
 * WHY PAGING THE WRITE IS THE WHOLE POINT. The read was already paged. The
 * memory bug was on the write: `JSON.stringify(items)` built a second, complete
 * copy of the dataset as one contiguous V8 string while the parsed dataset was
 * still live, and this corpus is bilingual, so that string is two bytes per
 * character. Serialising a page at a time means the largest copy that ever
 * exists is one page — the parsed dataset and a full serialised copy are never
 * both resident, because a full serialised copy is never built at all.
 *
 * WHY THE WRITE IS NO LONGER ONE PAGE PER UPLOAD. Because an upload is also a
 * subrequest, and there are only 1,000 of them (see the budget block above). A
 * page is SERIALISED the moment it lands and its parsed form is dropped there —
 * that is the memory fix, unchanged — then ENCODED to UTF-8 bytes and its string
 * dropped too, and the bytes wait in a buffer of at most RAW_OBJECT_PAGES pages,
 * which is written as one object. What is held between pages is bytes, never
 * items and never strings, so the cost of batching is one extra page's worth of
 * UTF-8 (~2 MB at the estimate) and nothing more; the arithmetic is in the
 * budget block above.
 *
 * WHY THE CEILINGS ONLY BOUND MAPPING. Raw storage is deliberately NOT bounded
 * by MAX_IMPORT_ITEMS or MAX_IMPORT_BYTES. Paging makes storing the whole thing
 * cheap regardless of size, and a run too large to map is still a run the
 * operator paid Apify for: its payload is kept in full and stays re-importable
 * without scraping again. Only the mapping accumulator is capped, and crossing
 * either cap drops the accumulator immediately — the remaining pages still get
 * stored, they just stop being kept in memory.
 */
async function storeRawPaged(
  datasetId: string,
  runRowId: string,
  apifyRunId: string,
  progress: RawProgress,
): Promise<RawImport> {
  const storage = supabaseAdmin().storage.from(RAW_BUCKET);
  const prefix = `scrape-raw/${KIND}/${runRowId}`;
  const parts: RawPart[] = [];

  let items: unknown[] | null = [];
  let breached: CeilingBreach['ceiling'] | null = null;
  let totalPages = 0;
  let totalItems = 0;
  let storedItems = 0;
  let totalBytes = 0;
  let rawTruncated = false;

  // One part's worth of already-serialised pages. Each entry is a page's JSON
  // text with its outer brackets stripped and ENCODED TO UTF-8 BYTES, so a
  // flush concatenates buffers around commas and re-serialises nothing. BYTES
  // ONLY: a page's parsed form is unreachable the moment its string exists —
  // the memory fix, unchanged — and the string itself is unreachable the moment
  // its bytes exist. That second drop is what makes holding pages cheap: this
  // corpus is bilingual, so a page's V8 string is two bytes per character
  // while its UTF-8 encoding is ~half that (see the peak-memory arithmetic in
  // the budget block above).
  const pending: Buffer[] = [];
  let pendingItems = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;

    const pieces: Buffer[] = [];
    for (const [index, page] of pending.entries()) {
      pieces.push(index === 0 ? RAW_ARRAY_OPEN : RAW_ARRAY_COMMA, page);
    }
    pieces.push(RAW_ARRAY_CLOSE);
    // One allocation of exactly the body's size, one-byte, no re-encoding.
    const body = Buffer.concat(pieces);
    const bytes = body.byteLength;
    const pages = pending.length;
    const partItems = pendingItems;
    const path = `${prefix}/part-${String(parts.length).padStart(4, '0')}.json`;

    // Released before the upload is awaited: `body` is the only copy that has
    // to survive the round trip, so the page buffers inside it are collectable
    // while the request is in flight.
    pending.length = 0;
    pieces.length = 0;
    pendingItems = 0;

    const { error } = await storage.upload(path, body, {
      contentType: 'application/json; charset=utf-8',
      upsert: true,
    });
    if (error) {
      throw new HttpError(
        502,
        'The scrape ran but its raw payload could not be stored.',
        `${error.message} — nothing was mapped, because raw is stored before mapping.`,
      );
    }

    parts.push({ path, pages, items: partItems, bytes });
    storedItems += partItems;
    totalBytes += bytes;
    progress.items = storedItems;
    progress.parts = parts.length;

    // Checked per part rather than per page, because totalBytes is measured on
    // what was actually written. The mapping accumulator can therefore overshoot
    // by at most one part before it is dropped — bounded, and never a
    // truncation: the item ceiling is checked per page and the payload is stored
    // in full either way.
    if (items !== null && totalBytes > MAX_IMPORT_BYTES) {
      breached = 'bytes';
      items = null;
    }
  };

  for (;;) {
    if (totalItems >= MAX_RAW_ITEMS) {
      // A suspicion, not a measurement: paging stops here without spending a
      // subrequest to ask whether the dataset continues, so this cannot tell a
      // dataset that ended exactly on the ceiling from one that runs past it.
      // Both report "may be a prefix", and neither reports a count of what was
      // left behind, because that number is not knowable from here.
      rawTruncated = true;
      break;
    }

    const batch = await apify<unknown[]>(
      `/datasets/${datasetId}/items?limit=${DATASET_PAGE}&offset=${totalItems}`,
    );
    // Counted before the batch is examined: an empty terminal page is still a
    // fetch, and this figure exists to state what the run cost in subrequests.
    // The ceiling check at the top of the loop is what bounds it at
    // MAX_RAW_ITEMS / DATASET_PAGE.
    totalPages += 1;
    if (!Array.isArray(batch) || batch.length === 0) break;

    totalItems += batch.length;

    // Serialised here, so the parsed page stops being the largest thing alive
    // as early as it possibly can, and encoded at once, so the two-byte string
    // is a transient of this statement rather than something the buffer holds.
    // The brackets come off because the part this page joins is itself one
    // JSON array.
    pending.push(Buffer.from(JSON.stringify(batch).slice(1, -1), 'utf8'));
    pendingItems += batch.length;

    if (items !== null) {
      if (totalItems > MAX_IMPORT_ITEMS) {
        breached = 'items';
        items = null;
      } else {
        for (const item of batch) items.push(item);
      }
    }

    if (pending.length >= RAW_OBJECT_PAGES) await flush();
    if (batch.length < DATASET_PAGE) break;
  }

  // Whatever is left over from a part that never filled. Rule 8: every fetched
  // page reaches storage, including the last one.
  await flush();

  if (rawTruncated && breached === null) breached = 'raw_items';

  const meta: RawImportMeta = {
    manifest_path: `${prefix}/manifest.json`,
    parts,
    total_pages: totalPages,
    total_items: totalItems,
    total_bytes: totalBytes,
    raw_truncated: rawTruncated,
  };

  // Written last, and written on both outcomes: a refused import is still a
  // fully stored one, and the manifest is what a re-import will read.
  const manifestBody = JSON.stringify({
    kind: KIND,
    apify_run_id: apifyRunId,
    dataset_id: datasetId,
    ledger_run_id: runRowId,
    stored_at: new Date().toISOString(),
    // The read unit and the write unit, stated apart because they are sized by
    // two different limits — the isolate's 128 MB and the 1,000 subrequests.
    fetch_page_items: DATASET_PAGE,
    pages_per_part: RAW_OBJECT_PAGES,
    total_pages: totalPages,
    total_items: totalItems,
    total_bytes: totalBytes,
    raw_truncated: rawTruncated,
    mapped: breached === null,
    ceilings: {
      map_items: MAX_IMPORT_ITEMS,
      map_bytes: MAX_IMPORT_BYTES,
      raw_items: MAX_RAW_ITEMS,
    },
    parts,
  });

  const { error: manifestError } = await storage.upload(meta.manifest_path, manifestBody, {
    contentType: 'application/json; charset=utf-8',
    upsert: true,
  });
  if (manifestError) {
    throw new HttpError(
      502,
      'The scrape ran and its parts were stored, but the raw manifest could not be written.',
      `${manifestError.message} — nothing was mapped, because raw is stored before mapping.`,
    );
  }

  if (breached !== null || items === null) {
    return { mappable: false, breach: describeBreach(breached, totalItems, totalBytes), ...meta };
  }
  return { mappable: true, items, ...meta };
}

/** The refusal, in the operator's words. Real measured numbers, never a guess. */
function describeBreach(
  ceiling: CeilingBreach['ceiling'] | null,
  totalItems: number,
  totalBytes: number,
): CeilingBreach {
  const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const kept =
    `Nothing was truncated and nothing was lost: all ${totalItems} item(s) — ${mb(totalBytes)} — ` +
    'are stored under this run\'s raw prefix and can be imported without scraping again.';

  if (ceiling === 'bytes') {
    return {
      ceiling: 'bytes',
      limit: MAX_IMPORT_BYTES,
      observed: totalBytes,
      message: `This run is ${mb(totalBytes)} of payload; one import can map at most ${mb(MAX_IMPORT_BYTES)}.`,
      hint: `${kept} Import it in smaller runs — lower the post limit, or monitor one profile at a time.`,
    };
  }
  if (ceiling === 'raw_items') {
    return {
      ceiling: 'raw_items',
      limit: MAX_RAW_ITEMS,
      observed: totalItems,
      message: `This run reached ${MAX_RAW_ITEMS} items, the ceiling on how much raw one import will page.`,
      hint: `The first ${totalItems} item(s) are stored. Paging stopped at the ceiling without checking whether the dataset continues, so anything past it — if there is anything — is still on Apify and was NOT stored. Re-run against a narrower scrape.`,
    };
  }
  return {
    ceiling: 'items',
    limit: MAX_IMPORT_ITEMS,
    observed: totalItems,
    message: `This run returned ${totalItems} items; one import can map at most ${MAX_IMPORT_ITEMS}.`,
    hint: `${kept} Import it in smaller runs — lower the post limit, or monitor one profile at a time.`,
  };
}

/**
 * storeRawPaged, with the ledger closed if it fails.
 *
 * The same guard /api/profile and /api/comments already put around their own
 * storeRaw, applied to the third and most expensive call site: by the time this
 * runs the posts actor has finished a full-history scrape and has been charged
 * for every result. Letting the 502 escape untouched would leave the row
 * inserted moments earlier at status 'running' with actual_results null and
 * raw_path null — the largest spend in the app, with the ledger blind to it.
 *
 * Rule 8 is untouched: the original error is re-raised so the caller aborts
 * before createSnapshotFrom, and nothing is mapped. Only the accounting is
 * repaired. `actual_results` records the items CONFIRMED STORED before the
 * failure — advanced when a part lands, never when a page is merely fetched —
 * and is null rather than 0 when the failure came before the first part landed:
 * an unknown count is unknown (rule 2). `raw_path` stays null because no
 * manifest was written, so the orphaned parts are never claimed as a complete
 * payload: 'error' plus no raw_path is what marks a paid run whose payload was
 * lost.
 */
async function storeRawPagedOrCloseLedger(
  datasetId: string,
  runRowId: string,
  apifyRunId: string,
): Promise<RawImport> {
  const progress: RawProgress = { items: 0, parts: 0 };
  try {
    return await storeRawPaged(datasetId, runRowId, apifyRunId, progress);
  } catch (err) {
    await supabaseAdmin()
      .from('scrape_runs')
      .update({
        status: 'error',
        actual_results: progress.items > 0 ? progress.items : null,
        raw_path: null,
      })
      .eq('id', runRowId);
    throw err;
  }
}

/* ------------------------------------------------------------- the import -- */

interface ImportOutcome {
  result: SnapshotResult;
  raw_path: string;
  raw_bytes: number;
  /** Objects written to storage — one Storage subrequest each. */
  raw_parts: number;
  /** Dataset pages fetched — one Apify subrequest each. */
  raw_pages: number;
  results: number;
}

/**
 * Store raw, then map — with the parsed dataset confined to this function.
 *
 * WHY IT IS A FUNCTION AND NOT INLINE IN THE HANDLER. The media mirror runs
 * straight after the import and reads up to MAX_POSTS_SCAN (2000) rows of
 * `posts.raw` back out of Postgres — which at the mapping ceiling is the same
 * payload again. If the parsed dataset were still reachable from a local in the
 * handler it would still be pinned in the isolate while that read-back
 * allocates, and the two together are what a 128 MB cap cannot take. Returning
 * from here makes the dataset unreachable, so the mirror pass starts on a clean
 * heap. Nothing in ImportOutcome references an item.
 */
async function runImport(
  datasetId: string,
  runRowId: string,
  apifyRunId: string,
): Promise<ImportOutcome> {
  const db = supabaseAdmin();
  const raw = await storeRawPagedOrCloseLedger(datasetId, runRowId, apifyRunId);

  if (!raw.mappable) {
    // The ceiling is VISIBLE or it is worthless. Three places say so: the
    // import row is closed as 'blocked' carrying the real item count and the
    // manifest path, a dedicated ledger row records the breach in full, and the
    // operator gets a 413 whose message and hint the Data screen surfaces
    // verbatim. What does NOT happen is a quiet truncation to the first 2000.
    await db
      .from('scrape_runs')
      .update({
        status: 'blocked',
        actual_results: raw.total_items,
        raw_path: raw.manifest_path,
      })
      .eq('id', runRowId);

    await ledger({
      kind: KIND,
      // No actor is called: this step refused to map something already scraped.
      actor: 'internal:import-ceiling',
      input: {
        step: 'import',
        refused: true,
        apify_run_id: apifyRunId,
        ceiling: raw.breach.ceiling,
        limit: raw.breach.limit,
        observed: raw.breach.observed,
        total_items: raw.total_items,
        total_bytes: raw.total_bytes,
        pages: raw.total_pages,
        parts: raw.parts.length,
        raw_truncated: raw.raw_truncated,
        raw_path: raw.manifest_path,
        reason: raw.breach.message,
      },
      estimated_usd: null,
      // Nothing was mapped. Null, not 0 — the count of mapped posts is not zero
      // by measurement, it is absent because the step did not run (rule 2).
      actual_results: null,
      status: 'blocked',
      raw_path: raw.manifest_path,
    });

    throw new HttpError(413, raw.breach.message, raw.breach.hint);
  }

  let result: SnapshotResult;
  try {
    result = await createSnapshotFrom(
      [{ name: `apify:run:${apifyRunId}`, payload: raw.items }],
      todayIso(),
      'monitor',
    );
  } catch (err) {
    await db
      .from('scrape_runs')
      .update({
        status: 'error',
        actual_results: raw.total_items,
        raw_path: raw.manifest_path,
      })
      .eq('id', runRowId);
    throw err;
  }

  await db
    .from('scrape_runs')
    .update({ actual_results: raw.total_items, status: 'done', raw_path: raw.manifest_path })
    .eq('id', runRowId);

  return {
    result,
    raw_path: raw.manifest_path,
    raw_bytes: raw.total_bytes,
    raw_parts: raw.parts.length,
    raw_pages: raw.total_pages,
    results: raw.total_items,
  };
}

/* ----------------------------------------------------------- the mirror -- */

/**
 * The media mirror, as the import step reports it.
 *
 * `report` is null only when the pass could not be attempted at all — the
 * read-back of the snapshot's rows failed. Every other outcome, including
 * "MIRROR_MEDIA is off", arrives as a real MirrorMediaResult with counts.
 */
interface MirrorOutcome {
  /** The scrape_runs row this pass was recorded on. Null if that write failed. */
  run_id: string | null;
  report: MirrorMediaResult | null;
  /**
   * The read-back that produced the candidates, and whether it hit its cap. Null
   * when no read-back happened — either it failed, or MIRROR_MEDIA is off and it
   * was never issued.
   */
  scan: ScanCoverage | null;
  /**
   * Rows stored with no raw payload, so no thumbnail URL could be read from
   * them. Null when the read-back never completed — nothing was examined, so
   * there is no count to give (hard rule 2: absent is not zero).
   */
  posts_without_raw: number | null;
  /** A failure around the pass: the read-back, or the ledger write. */
  error: string | null;
}

/**
 * Mirrors the snapshot's post thumbnails into the private bucket.
 *
 * WHY IT IS CALLED HERE. src/lib/ingest/media.ts is the MIRROR_MEDIA flag path
 * the v3 spec asked for, and until now nothing reached it. The import step is
 * where it belongs: raw is already stored, the posts are already parsed and
 * written, and an Instagram CDN URL is at its freshest the moment the scrape
 * that produced it lands — which is the whole reason the module exists.
 *
 * WHY IT READS THE ROWS BACK. createSnapshotFrom() parses and inserts in one
 * call and returns counts, not posts, so the candidates come from the rows it
 * just wrote. That is not a workaround, it is the stricter source: only posts
 * that actually reached the table are mirrored, so an item the parser skipped
 * as unroutable cannot acquire a thumbnail. `account`, `ig_id` and `raw` are
 * exactly the narrow select MirrorCandidate documents.
 *
 * AND WHY THE FLAG IS READ BEFORE THAT READ. The select above asks for up to
 * MAX_POSTS_SCAN rows INCLUDING their full `raw` jsonb, which at the mapping
 * ceiling is the entire import payload allocated a second time — the largest
 * single allocation in this route, on a 128 MB isolate. MIRROR_MEDIA is off by
 * default, so doing it and then letting mirrorPostMedia() early-return meant
 * every import paid the largest cost in the route for a feature nobody had
 * enabled. mirrorPostMedia() still checks the flag itself; this checks it one
 * step earlier, where the cost actually is. It also saves the subrequest.
 *
 * WHAT THE SKIP MUST STILL DO. Report. A disabled mirror writes its ledger row
 * exactly as before and answers with `enabled: false` and a reason, so it stays
 * distinguishable from a mirror that ran and mirrored nothing. `scan`,
 * `posts_without_raw` and `considered` are null rather than 0 on that path,
 * because nothing was read and nothing was examined: absent is not zero (rule
 * 2), and the Data screen renders absent as an em-dash.
 *
 * ORDERING. `rank` is the parser's engagement ordering (rank 1 = highest
 * engagement), which is the order MAX_MIRROR_OBJECTS assumes: a pass that hits
 * the cap has mirrored the loudest posts, the ones a Board shows first. No
 * dedupe is needed here and none is done — `posts` is UNIQUE (snapshot_id,
 * ig_id) and this reads ONE snapshot, so there is one row per post by
 * construction.
 *
 * IT CANNOT FAIL THE INGEST. The posts are already committed and the import
 * ledger row is already closed before this is called. mirrorPostMedia() never
 * throws by contract; everything around it — the read-back, the ledger write —
 * is caught here and degrades to a reported `error`. Nothing in this function
 * re-raises.
 *
 * RULE 4. Nothing here mints or returns a signed URL. MirrorMediaResult carries
 * counts only, and a mirrored object is read back exactly the way a raw payload
 * already is: through /api/assets, which requires an operator and 307s to a
 * short-lived signed URL minted inside that route. No URL reaches a client.
 */
async function mirrorSnapshotMedia(snapshotId: string, apifyRunId: string): Promise<MirrorOutcome> {
  const outcome: MirrorOutcome = {
    run_id: null,
    report: null,
    scan: null,
    posts_without_raw: null,
    error: null,
  };

  const db = supabaseAdmin();

  if (!mirrorMediaEnabled()) {
    // Nothing is read, so `scan` and `posts_without_raw` stay null. The ledger
    // row below is still written: an off mirror is an audited outcome.
    outcome.report = skippedMirrorReport();
  } else {
    try {
      const { data, error } = await db
        .from('posts')
        .select('account, ig_id, raw')
        .eq('snapshot_id', snapshotId)
        .order('rank', { ascending: true, nullsFirst: false })
        .limit(MAX_POSTS_SCAN);

      if (error) throw new Error(`Could not read the snapshot's posts: ${error.message}`);

      const rows = (data as { account: Account; ig_id: string; raw: Json | null }[] | null) ?? [];
      // Measured on the raw row count, because it is the query that was capped.
      outcome.scan = scanCoverage(rows.length, MAX_POSTS_SCAN);

      const candidates: MirrorCandidate[] = [];
      let withoutRaw = 0;
      for (const row of rows) {
        // `posts.raw` is nullable in the schema. A row with no payload has no
        // thumbnail URL to read, so it is counted rather than handed over as an
        // empty object that would be miscounted as "no media URL".
        if (row.raw === null) {
          withoutRaw += 1;
          continue;
        }
        candidates.push({ account: row.account, ig_id: row.ig_id, raw: row.raw });
      }
      outcome.posts_without_raw = withoutRaw;

      outcome.report = await mirrorPostMedia(candidates, db);
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
    }
  }

  const report = outcome.report;
  const status =
    outcome.error !== null || (report !== null && report.error !== null)
      ? 'error'
      : report === null || !report.enabled
        ? 'skipped'
        : 'done';

  try {
    outcome.run_id = await ledger({
      kind: KIND,
      // No actor is called: the bytes come from Instagram's CDN, not Apify.
      actor: 'internal:mirror-media',
      // scrape_runs has no column for a mirror report, and `input` is where
      // this route already records what a non-actor step did and why — the
      // analyze skip does the same. Written whether the flag was on or off, so
      // "MIRROR_MEDIA is off" is an audited outcome and not a silent skip.
      input: {
        step: 'mirror',
        apify_run_id: apifyRunId,
        snapshot_id: snapshotId,
        enabled: report === null ? null : report.enabled,
        reason: report === null ? outcome.error : report.reason,
        scan: outcome.scan,
        posts_without_raw: outcome.posts_without_raw,
        result: report,
        error: outcome.error,
      },
      // Bandwidth and storage are not Apify spend and have no published rate to
      // price them against. Null means "not estimated", never "free".
      estimated_usd: null,
      // Objects written by this pass. Null — never 0 — when no pass ran, because
      // a pass that did not happen measured nothing (hard rule 2).
      actual_results: report !== null && report.enabled ? report.mirrored : null,
      status,
      raw_path: null,
    });
  } catch (err) {
    // The posts are already stored and the import row is already closed. A
    // ledger failure here is reported, never thrown: losing an ingest over the
    // bookkeeping of a thumbnail pass would be the worse trade.
    const message = err instanceof Error ? err.message : String(err);
    outcome.error = outcome.error === null ? message : `${outcome.error}; ${message}`;
  }

  return outcome;
}

/** The mirror outcome as the import response states it. Counts only, no URLs. */
function mirrorBlock(outcome: MirrorOutcome) {
  const r = outcome.report;
  return {
    run_id: outcome.run_id,
    // Null, not false: "the pass could not be attempted" is not "the flag is
    // off". Every count below is null for the same reason.
    enabled: r === null ? null : r.enabled,
    ran: r !== null && r.enabled,
    reason: r === null ? outcome.error : r.reason,
    scan: outcome.scan,
    posts_without_raw: outcome.posts_without_raw,
    cap: r === null ? null : r.cap,
    considered: r === null ? null : r.considered,
    attempted: r === null ? null : r.attempted,
    mirrored: r === null ? null : r.mirrored,
    already_mirrored: r === null ? null : r.already_mirrored,
    skipped: r === null ? null : r.skipped,
    failed: r === null ? null : r.failed,
    bytes_stored: r === null ? null : r.bytes_stored,
    index_complete: r === null ? null : r.index_complete,
    /** A failure inside the pass, which stopped it early. */
    pass_error: r === null ? null : r.error,
    /** A failure around the pass: the read-back, or the ledger write. */
    error: outcome.error,
    warnings: [
      ...(r === null ? [] : r.warnings),
      ...(outcome.error === null ? [] : [`The media mirror step could not run: ${outcome.error}`]),
    ],
  };
}

/* ---------------------------------------------------------- spend guard --- */

interface Guard {
  estimate: ScrapeEstimate;
  budget_usd: number | null;
  allowed: boolean;
  reason: string | null;
  shortfall_usd: number | null;
  result_count: number;
  actor: string;
}

function guard(resultCount: number): Guard {
  const actor = actorId();
  const estimate = estimateScrape({ actor, resultCount });
  const budgetUsd = apifyBudgetUsd();
  const decision = checkBudget({ estimate, budgetUsd });

  const shortfall =
    estimate.usd !== null && budgetUsd !== null && Number.isFinite(budgetUsd) && budgetUsd >= 0
      ? Number(Math.max(estimate.usd - budgetUsd, 0).toFixed(2))
      : null;

  return {
    estimate,
    budget_usd: budgetUsd,
    allowed: decision.allowed,
    reason: decision.reason,
    shortfall_usd: shortfall,
    result_count: resultCount,
    actor,
  };
}

function estimateBlock(g: Guard) {
  return {
    actor: g.actor,
    result_count: g.result_count,
    usd: g.estimate.usd,
    rate_per_1000: g.estimate.rate_per_1000,
  };
}

function budgetBlock(g: Guard) {
  return {
    budget_usd: g.budget_usd,
    allowed: g.allowed,
    reason: g.reason,
    shortfall_usd: g.shortfall_usd,
  };
}

function blockedResponse(g: Guard, runId: string | null) {
  return NextResponse.json(
    {
      error: g.reason ?? 'Blocked by the scrape budget guard.',
      hint: 'Raise APIFY_BUDGET_USD, or lower the post limit. Nothing was scraped and nothing was charged.',
      blocked: true,
      run_id: runId,
      estimate_usd: g.estimate.usd,
      rate_per_1000: g.estimate.rate_per_1000,
      result_count: g.result_count,
      budget_usd: g.budget_usd,
      shortfall_usd: g.shortfall_usd,
    },
    { status: 402 },
  );
}

/* ------------------------------------------------------------ delegation -- */

interface Delegated {
  ok: boolean;
  status: number;
  payload: Json;
}

async function readDelegated(response: Response): Promise<Delegated> {
  const payload = ((await response.json().catch(() => ({}))) ?? {}) as Json;
  return { ok: response.ok, status: response.status, payload };
}

function jsonRequest(origin: string, path: string, body: Json): Request {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(origin: string, path: string): Request {
  return new Request(`${origin}${path}`, { method: 'GET' });
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function int(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

/* ----------------------------------------------------------------- POST --- */

export async function POST(request: Request) {
  try {
    await requireOperator();

    const origin = new URL(request.url).origin;
    const body = ((await request.json().catch(() => ({}))) ?? {}) as {
      action?: unknown;
      profiles?: unknown;
      limit?: unknown;
      runId?: unknown;
      ledgerId?: unknown;
      topN?: unknown;
      perPost?: unknown;
    };

    const requested = str(body.action);
    const action: Action =
      requested !== null && (ACTIONS as readonly string[]).includes(requested)
        ? (requested as Action)
        : 'start';

    /* ---------------------------------------------------------- import --- */
    if (action === 'import') {
      const apifyRunId = str(body.runId);
      if (!apifyRunId) throw new HttpError(400, 'Missing runId.');
      const ledgerId = str(body.ledgerId);

      const { data: run } = await apify<{ data: ApifyRun }>(`/actor-runs/${apifyRunId}`);
      if (run.status !== 'SUCCEEDED') {
        throw new HttpError(
          409,
          `That run is ${run.status}, not SUCCEEDED.`,
          'Wait for it to finish before importing.',
        );
      }

      // A run started outside this pipeline has no ledger row yet; give it one
      // rather than importing something the ledger never saw. This now happens
      // BEFORE a single item is fetched — the row names the storage prefix the
      // raw pages are written under, and the ledger is written first on purpose.
      const runRowId =
        ledgerId ??
        (await ledger({
          kind: KIND,
          actor: actorId(),
          input: { step: 'import', apify_run_id: apifyRunId },
          estimated_usd: null,
          actual_results: null,
          status: 'running',
          raw_path: null,
        }));

      const imported = await runImport(run.defaultDatasetId, runRowId, apifyRunId);

      // The ingest is complete and ledgered by this line, and the parsed
      // dataset is unreachable — runImport returned, so the mirror pass below
      // starts without it pinned. The pass runs on its own ledger row precisely
      // so that nothing it does — including failing — can reach back here.
      const mirror = await mirrorSnapshotMedia(imported.result.snapshot.id, apifyRunId);

      return NextResponse.json({
        ...imported.result,
        step: 'import',
        run_id: runRowId,
        runId: apifyRunId,
        apify_run_id: apifyRunId,
        results: imported.results,
        raw_path: imported.raw_path,
        raw_bytes: imported.raw_bytes,
        // Both halves of what the raw step cost in subrequests: one per page
        // fetched, one per part written.
        raw_pages: imported.raw_pages,
        raw_parts: imported.raw_parts,
        usageUsd: run.usageTotalUsd ?? null,
        mirror: mirrorBlock(mirror),
        next: {
          step: 'profile',
          route: '/api/monitor',
          method: 'POST',
          body: { action: 'profile' },
        } satisfies NextCall,
      });
    }

    /* --------------------------------------------------------- profile --- */
    if (action === 'profile') {
      // /api/profile does its own budget guard and its own ledger row.
      const delegated = await readDelegated(await profilePost());

      return NextResponse.json({
        step: 'profile',
        ok: delegated.ok,
        status: delegated.status,
        profile: delegated.payload,
        next: {
          step: 'comments',
          route: '/api/monitor',
          method: 'POST',
          body: { action: 'comments' },
        } satisfies NextCall,
      });
    }

    /* -------------------------------------------------------- comments --- */
    if (action === 'comments') {
      // onlyUncovered: a monitor run buys comments for posts ENTERING the
      // top-N, not for the whole top-N again. Posts already in the corpus are
      // skipped, which is the difference between a monitor and a re-scrape.
      const scopeBody: Json = { action: 'start', onlyUncovered: true };
      const topN = int(body.topN);
      const perPost = int(body.perPost);
      if (topN !== null) scopeBody.topN = topN;
      if (perPost !== null) scopeBody.perPost = perPost;

      const delegated = await readDelegated(
        await commentsPost(jsonRequest(origin, '/api/comments', scopeBody)),
      );

      const started = delegated.payload['started'] === true;
      const apifyRunId = str(delegated.payload['apify_run_id']);
      const commentsLedgerId = str(delegated.payload['run_id']);
      // The cap the run was actually bought at, carried through to the import
      // so a widened scope is not trimmed back to the env default.
      const scope = delegated.payload['scope'];
      const scopePerPost = isObject(scope) ? int(scope['per_post']) : null;

      // Nothing to buy, or blocked by the budget: neither is a reason to abandon
      // the run. Move on to the analysis step and let the operator see why.
      const next: NextCall =
        started && apifyRunId !== null
          ? {
              step: 'comments',
              route: '/api/monitor',
              method: 'GET',
              query: {
                runId: apifyRunId,
                step: 'comments',
                ...(commentsLedgerId === null ? {} : { ledgerId: commentsLedgerId }),
                ...(scopePerPost === null ? {} : { perPost: String(scopePerPost) }),
              },
            }
          : { step: 'analyze', route: '/api/monitor', method: 'POST', body: { action: 'analyze' } };

      return NextResponse.json({
        step: 'comments',
        ok: delegated.ok,
        status: delegated.status,
        started,
        comments: delegated.payload,
        next,
      });
    }

    /* ------------------------------------------------- comments-import --- */
    if (action === 'comments-import') {
      const apifyRunId = str(body.runId);
      if (!apifyRunId) throw new HttpError(400, 'Missing runId.');

      const importBody: Json = { action: 'import', runId: apifyRunId };
      const ledgerId = str(body.ledgerId);
      const perPost = int(body.perPost);
      if (ledgerId !== null) importBody.ledgerId = ledgerId;
      if (perPost !== null) importBody.perPost = perPost;

      const delegated = await readDelegated(
        await commentsPost(jsonRequest(origin, '/api/comments', importBody)),
      );

      return NextResponse.json({
        step: 'comments-import',
        ok: delegated.ok,
        status: delegated.status,
        comments: delegated.payload,
        next: {
          step: 'analyze',
          route: '/api/monitor',
          method: 'POST',
          body: { action: 'analyze' },
        } satisfies NextCall,
      });
    }

    /* --------------------------------------------------------- analyze --- */
    if (action === 'analyze') {
      const provider = resolveProvider();
      const keyName = providerKeyName(provider);

      // Closing the v2 gap must not reopen a worse one: a studio with no model
      // key still gets its posts, its followers and its comments. The skip is
      // recorded in the ledger so "why is nothing analysed?" has an answer.
      if (!hasEnv(keyName)) {
        const reason =
          `No model key is configured: the resolved provider is ${provider}, which needs ${keyName}. ` +
          'Posts, profile and comments were unaffected — only the analysis step was skipped.';

        const skippedId = await ledger({
          kind: KIND,
          actor: `internal:board-analyze:${provider}`,
          // No actor is called here, so `input` records what the step was asked
          // to do and why it did not — scrape_runs is the only durable place a
          // skipped step can be audited from.
          input: { step: 'analyze', skipped: true, reason },
          estimated_usd: null,
          actual_results: null,
          status: 'skipped',
          raw_path: null,
        });

        return NextResponse.json({
          step: 'analyze',
          ran: false,
          skipped_reason: reason,
          run_id: skippedId,
          next: null,
          done: true,
        });
      }

      const limit = int(body.limit) ?? DEFAULT_ANALYZE_CHUNK;
      const delegated = await readDelegated(
        await analyzePost(jsonRequest(origin, '/api/board/analyze', { limit })),
      );

      const analyzed = int(delegated.payload['analyzed']) ?? 0;
      const remaining = int(delegated.payload['remaining']);

      await ledger({
        kind: KIND,
        actor: `internal:board-analyze:${provider}`,
        input: { step: 'analyze', limit },
        // Model spend is not Apify spend; the per-post model estimate lives on
        // /api/board/analyze. Null here means "not estimated", never "free".
        estimated_usd: null,
        actual_results: delegated.ok ? analyzed : null,
        status: delegated.ok ? 'done' : 'error',
        raw_path: null,
      });

      // Chunked and resumable, exactly as /api/board/analyze is: keep calling
      // until `remaining` reaches zero.
      const more = delegated.ok && remaining !== null && remaining > 0;

      return NextResponse.json({
        step: 'analyze',
        ran: delegated.ok,
        ok: delegated.ok,
        status: delegated.status,
        analyze: delegated.payload,
        next: more
          ? ({
              step: 'analyze',
              route: '/api/monitor',
              method: 'POST',
              body: { action: 'analyze', limit },
            } satisfies NextCall)
          : null,
        done: !more,
      });
    }

    /* ----------------------------------------------------------- start --- */
    const handles = canonicalHandles();
    const profiles = Array.isArray(body.profiles)
      ? body.profiles.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : (optionalEnv('APIFY_PROFILES')?.split(/[,\s]+/).filter(Boolean) ?? [
          handles.personal,
          handles.academy,
        ]);

    if (profiles.length === 0) throw new HttpError(400, 'No Instagram profiles to monitor.');

    const requestedLimit = int(body.limit);
    const askedFor =
      requestedLimit !== null && requestedLimit > 0 && requestedLimit <= MAX_RESULTS
        ? requestedLimit
        : DEFAULT_LIMIT;

    // Rule 9 applied to memory rather than money: a run that cannot be imported
    // must not be bought. profiles x limit is exactly what the import step will
    // have to map, so the per-profile limit is clamped to what MAX_IMPORT_ITEMS
    // can take — and the clamp is REPORTED, priced and ledgered rather than
    // applied quietly. Without this the operator could pay for a scrape whose
    // only possible outcome is the 413 that runImport raises.
    const importCap = Math.max(1, Math.floor(MAX_IMPORT_ITEMS / profiles.length));
    const limit = Math.min(askedFor, importCap);
    const limitWarnings =
      limit < askedFor
        ? [
            `Post limit lowered from ${askedFor} to ${limit} per profile: ${profiles.length} profile(s) x ${askedFor} is ${profiles.length * askedFor} items, and one import can map at most ${MAX_IMPORT_ITEMS}. Run it again for older posts.`,
          ]
        : [];

    const input: Json = {
      directUrls: profiles.map((p) => `https://www.instagram.com/${p.replace(/^@/, '')}/`),
      resultsType: 'posts',
      resultsLimit: limit,
      addParentData: true,
    };

    // Rule 9: priced on what will actually be requested — one result per post,
    // per profile — and checked before a single credit is spent.
    const g = guard(profiles.length * limit);

    if (!g.allowed) {
      const blockedId = await ledger({
        kind: KIND,
        actor: g.actor,
        input,
        estimated_usd: g.estimate.usd,
        actual_results: null,
        status: 'blocked',
        raw_path: null,
      });
      return blockedResponse(g, blockedId);
    }

    const runRowId = await ledger({
      kind: KIND,
      actor: g.actor,
      input,
      estimated_usd: g.estimate.usd,
      actual_results: null,
      status: 'running',
      raw_path: null,
    });

    let run: ApifyRun;
    try {
      ({ data: run } = await apify<{ data: ApifyRun }>(`/acts/${g.actor}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }));
    } catch (err) {
      await supabaseAdmin().from('scrape_runs').update({ status: 'error' }).eq('id', runRowId);
      throw err;
    }

    return NextResponse.json({
      step: 'posts',
      run_id: runRowId,
      runId: run.id,
      apify_run_id: run.id,
      datasetId: run.defaultDatasetId,
      dataset_id: run.defaultDatasetId,
      status: run.status,
      profiles,
      limit,
      limit_requested: askedFor,
      limit_capped: limit < askedFor,
      max_import_items: MAX_IMPORT_ITEMS,
      warnings: limitWarnings,
      estimate: estimateBlock(g),
      budget: budgetBlock(g),
      // Throughput, not money: observed at roughly ten results a second.
      duration_hint_s: Math.ceil((profiles.length * limit) / 10),
      next: {
        step: 'posts',
        route: '/api/monitor',
        method: 'GET',
        query: { runId: run.id, step: 'posts', ledgerId: runRowId },
      } satisfies NextCall,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/* ------------------------------------------------------------------ GET --- */

/**
 * GET /api/monitor?runId=…&step=posts — poll a run without importing it.
 * GET /api/monitor                    — the whole plan and what it would cost,
 *                                       spending nothing.
 */
export async function GET(request: Request) {
  try {
    await requireOperator();

    const url = new URL(request.url);
    const runId = url.searchParams.get('runId');
    const step: Step = url.searchParams.get('step') === 'comments' ? 'comments' : 'posts';
    const ledgerId = url.searchParams.get('ledgerId');
    const perPost = int(url.searchParams.get('perPost'));

    /* ------------------------------------------------------------ poll --- */
    if (runId) {
      const { data: run } = await apify<{ data: ApifyRun }>(`/actor-runs/${runId}`);
      const done = ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status);

      let next: NextCall | null;
      if (!done) {
        next = {
          step,
          route: '/api/monitor',
          method: 'GET',
          query: {
            runId: run.id,
            step,
            ...(ledgerId === null ? {} : { ledgerId }),
            ...(perPost === null ? {} : { perPost: String(perPost) }),
          },
        };
      } else if (run.status === 'SUCCEEDED') {
        next = {
          step: step === 'comments' ? 'comments-import' : 'import',
          route: '/api/monitor',
          method: 'POST',
          body: {
            action: step === 'comments' ? 'comments-import' : 'import',
            runId: run.id,
            ...(ledgerId === null ? {} : { ledgerId }),
            ...(perPost === null || step !== 'comments' ? {} : { perPost }),
          },
        };
      } else {
        // Failed, aborted or timed out: there is nothing to import, and
        // inventing a next step would only hide that.
        next = null;
      }

      return NextResponse.json({
        runId: run.id,
        apify_run_id: run.id,
        step,
        status: run.status,
        itemCount: run.stats?.outputItemCount ?? null,
        item_count: run.stats?.outputItemCount ?? null,
        startedAt: run.startedAt ?? null,
        finishedAt: run.finishedAt ?? null,
        usageUsd: run.usageTotalUsd ?? null,
        done,
        next,
      });
    }

    /* ------------------------------------------------------------ plan --- */
    // Every figure below comes from a route that only reads: no actor is
    // started and no model is called, so the Data screen can show the whole
    // pipeline's cost before the operator commits to any of it.
    const origin = url.origin;
    const handles = canonicalHandles();
    const profiles =
      optionalEnv('APIFY_PROFILES')?.split(/[,\s]+/).filter(Boolean) ?? [
        handles.personal,
        handles.academy,
      ];
    // The same clamp the start action applies, so the plan prices what a run
    // would actually request rather than what the default asks for.
    const plannedLimit =
      profiles.length === 0
        ? DEFAULT_LIMIT
        : Math.min(DEFAULT_LIMIT, Math.max(1, Math.floor(MAX_IMPORT_ITEMS / profiles.length)));
    const postsGuard = guard(profiles.length * plannedLimit);

    const [profileRes, commentsRes, analyzeRes] = await Promise.all([
      profileGet(),
      commentsGet(getRequest(origin, '/api/comments?onlyUncovered=true')),
      analyzeGet(),
    ]);
    const [profilePlan, commentsPlan, analyzePlan] = await Promise.all([
      readDelegated(profileRes),
      readDelegated(commentsRes),
      readDelegated(analyzeRes),
    ]);

    return NextResponse.json({
      handles,
      steps: {
        posts: {
          profiles,
          limit: plannedLimit,
          max_import_items: MAX_IMPORT_ITEMS,
          estimate: estimateBlock(postsGuard),
          budget: budgetBlock(postsGuard),
        },
        profile: { ok: profilePlan.ok, ...profilePlan.payload },
        comments: { ok: commentsPlan.ok, ...commentsPlan.payload },
        analyze: { ok: analyzePlan.ok, ...analyzePlan.payload },
      },
      next: {
        step: 'posts',
        route: '/api/monitor',
        method: 'POST',
        body: { action: 'start' },
      } satisfies NextCall,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
