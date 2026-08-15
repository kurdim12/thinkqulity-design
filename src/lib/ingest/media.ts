import type { SupabaseClient } from '@supabase/supabase-js';
import { mirrorMedia } from '@/lib/env';
import { isObject, pickString, type Json, type ParsedPost } from '@/lib/ingest/apify';
import type { Account } from '@/lib/types/db';

/**
 * MIRROR_MEDIA — the flag path, built but not enabled.
 *
 * The v3 spec asked for this verbatim: "Optional, default OFF:
 * MIRROR_MEDIA=false. When true, ingest downloads post thumbnails to the
 * private bucket (signed-URL reads) so the Board can render visually before
 * source URLs expire. Build the flag path; do not enable it — that call is the
 * operator's." `mirrorMedia()` has existed in src/lib/env.ts since v3 and has
 * never been called; .env.example has been promising behaviour that did not
 * exist. This module is that behaviour.
 *
 * WHY IT EXISTS AT ALL. An Instagram CDN URL is signed and short-lived. The
 * `displayUrl` captured in `posts.raw` is a complete, faithful record of what
 * the scrape returned (hard rule 8), but it stops resolving some time after the
 * scrape — so a Board rendered from stored rows shows broken images for posts
 * that are otherwise perfectly intact in the database. Mirroring copies the
 * bytes into storage we control while the URL still works.
 *
 * WHAT IT IS NOT. Read-only ingestion of already-public media into a private
 * bucket. Nothing here writes to Instagram, authenticates to Instagram, or
 * touches an account. It is the same act as the scrape that produced the row,
 * one step further along.
 *
 * WHERE IT IS READ FROM. No new ROUTE, and — since v4 — a real reader. Objects
 * land in the same private `brand-assets` bucket that /api/assets already
 * fronts, so a mirrored thumbnail is read exactly the way a stored raw payload
 * already is: `/api/assets?path=post-media/<account>/<ig_id>`, which calls
 * `requireOperator()` and 307-redirects to a signed URL that expires in five
 * minutes. RULE 4 holds because of that shape: the signed URL is minted inside
 * that route and handed to the browser as a redirect. It is never returned as
 * JSON, never rendered into HTML, and nothing in this module mints one — so no
 * signed URL can reach a client bundle. A separate /api/media route would be a
 * second copy of /api/assets with the same body, which is why there isn't one.
 *
 * THE READER SHIPS WITH THE WRITER. v3 built this pass and nothing rendered it,
 * which is why the v3 review said to drop it: a flag whose behaviour no surface
 * shows is indistinguishable from a flag that does nothing. readMirrorIndex()
 * below is the other half — /api/board asks it which posts actually have an
 * object and hands each card either the /api/assets query for it or the reason
 * there is none. The bucket listing is the ONLY source of that answer: nothing
 * infers "there is an image" from a row, a flag or a URL that used to resolve.
 *
 * FAILURE IS NORMAL HERE. Expired URLs are the reason this module exists, so a
 * download that 403s is an expected outcome, not an error: that post degrades
 * to "not mirrored" and the pass continues. Nothing in here throws into the
 * caller — an ingest must never be lost because a thumbnail was.
 */

/** The private bucket /api/assets fronts. Same one the raw payloads land in. */
const BUCKET = 'brand-assets';

/** Everything this module writes lives under one prefix, per account. */
const PREFIX = 'post-media';

/**
 * HARD CAP — the most objects one mirror pass will ever download, whatever the
 * caller asks for.
 *
 * Bandwidth and storage are billed to the client, so the ceiling is a constant
 * and not an environment variable: an operator can turn mirroring on or off,
 * but cannot talk this number upwards. `opts.maxObjects` may only lower it.
 *
 * 200 is chosen against the corpus that exists: 190 personal posts and 130
 * academy posts, 320 in total. One pass therefore completes the whole personal
 * account, and because an object already in the bucket is skipped without being
 * re-downloaded, two passes reach the whole corpus and every pass after that
 * costs almost nothing. Candidates are mirrored in the order they are handed
 * over — `parseApifyExports` returns posts sorted by engagement, so a pass that
 * hits the cap has bought the loudest posts first, which are the rows the Board
 * shows above the fold.
 */
export const MAX_MIRROR_OBJECTS = 200;

/**
 * Per-object ceiling. A thumbnail is far below this; the limit exists so that a
 * payload pointing at something that is not a thumbnail cannot quietly pull
 * hundreds of megabytes through the ingest. Enforced twice — on the declared
 * `content-length` before the body is read, and again on the bytes actually
 * received, because a CDN is not obliged to declare a length.
 */
export const MAX_OBJECT_BYTES = 4 * 1024 * 1024;

/** A hung CDN connection must not hold the pass open. */
const FETCH_TIMEOUT_MS = 15_000;

/** Downloads in flight at once. Small on purpose: this is someone else's CDN. */
const CONCURRENCY = 4;

/** Page size and page bound for the "what is already mirrored" listing. */
const INDEX_PAGE = 1000;
const MAX_INDEX_PAGES = 20;

/**
 * Hosts this module is willing to fetch from.
 *
 * The URL comes out of a scraped payload, which makes it attacker-influenced
 * input to a server-side fetch. An allow-list keeps the flag path from becoming
 * an SSRF gadget: a payload that names an internal address, or any host outside
 * Instagram's CDN, is counted and skipped rather than requested.
 */
const ALLOWED_HOST_SUFFIXES = ['cdninstagram.com', 'fbcdn.net', 'instagram.com'];

/**
 * Where a thumbnail URL hides, across actor versions. Ordered most specific
 * first. `videoUrl` is deliberately absent: this mirrors the still image a
 * Board card renders, never the video behind it.
 */
const MEDIA_URL_KEYS = [
  'displayUrl',
  'display_url',
  'thumbnailUrl',
  'thumbnail_url',
  'thumbnailSrc',
  'thumbnail_src',
  'imageUrl',
  'image_url',
  'displaySrc',
  'display_src',
  'thumbnail',
];

/**
 * Instagram ids are numeric ids or shortcodes. Anything outside this shape is
 * refused rather than sanitised: rewriting an id to make it path-safe could map
 * two different posts onto one object, and a thumbnail attributed to the wrong
 * post is a fabricated fact about a row.
 */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What this module needs from a post. `ParsedPost` satisfies it structurally,
 * so `mirrorPostMedia(parsed.posts, db)` compiles with no adapter, and so does
 * a narrow select that asks for `account`, `ig_id` and `raw`.
 */
export interface MirrorCandidate {
  account: Account;
  ig_id: string;
  /** The stored payload. The thumbnail URL is only ever read from here. */
  raw: Json;
}

/**
 * Compile-time guard, no runtime emit: a `ParsedPost` IS a `MirrorCandidate`,
 * so `mirrorPostMedia(parsed.posts, db)` needs no adapter. If `ParsedPost` ever
 * stops carrying `account`, `ig_id` or `raw` in these shapes, this file fails to
 * compile here rather than at whichever call site happens to be wired up.
 */
type Assert<T extends true> = T;
type _ParsedPostIsMirrorCandidate = Assert<ParsedPost extends MirrorCandidate ? true : false>;

export interface MirrorMediaOptions {
  /**
   * Lower the object cap for one pass. Values above MAX_MIRROR_OBJECTS are
   * clamped down to it — the constant is a ceiling, not a default.
   */
  maxObjects?: number;
  /**
   * Test seam. Production passes nothing and the global `fetch` is used; a
   * harness passes a stub so this module's logic can be executed with no
   * network. Never wired to anything in the app.
   */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface MirrorMediaResult {
  /** `mirrorMedia()` as read at the top of the pass. */
  enabled: boolean;
  /** Why nothing happened, when `enabled` is false. Null when it ran. */
  reason: string | null;
  /** The caps this pass actually enforced, so a report can state them. */
  cap: { max_objects: number; max_object_bytes: number };
  /**
   * Candidates handed in. Null when the caller checked the flag first and never
   * built a candidate list, so there is nothing to count — absent, not zero
   * (hard rule 2). A pass that was handed candidates always reports a number,
   * including a disabled one, because it really did receive them.
   */
  considered: number | null;
  /** Downloads started. Never more than `cap.max_objects`. */
  attempted: number;
  /** Objects written to the bucket by this pass. */
  mirrored: number;
  /** Candidates already in the bucket before this pass, so never re-fetched. */
  already_mirrored: number;
  skipped: {
    /** No thumbnail URL anywhere in the payload. */
    no_media_url: number;
    /** URL present, but not https on an allow-listed Instagram CDN host. */
    untrusted_host: number;
    /** ig_id is not path-safe, so no object name can be derived from it. */
    unsafe_id: number;
    /** Would have been fetched, but the pass had already hit its cap. */
    over_cap: number;
  };
  failed: {
    /** Fetch threw, timed out, or answered with a non-2xx — an expired URL. */
    download: number;
    /** Answered, but with something that is not an image. */
    not_image: number;
    /** Over MAX_OBJECT_BYTES, declared or actual. */
    too_large: number;
    /** Downloaded, but storage refused the write. */
    upload: number;
  };
  /** Bytes written to the bucket by this pass. */
  bytes_stored: number;
  /**
   * Whether the "already mirrored" listing saw every object under the prefix.
   * False means the pass may re-download something it already has — wasteful,
   * never wrong, and said out loud rather than assumed away.
   */
  index_complete: boolean;
  /**
   * Why the listing was incomplete, when storage said so in words. Null when
   * every listing answered, and null when it merely ran out of pages — those are
   * different facts, and "incomplete" without a reason is the weaker one.
   */
  index_error: string | null;
  /** An unexpected failure that ended the pass early. Null on a clean pass. */
  error: string | null;
  /** One readable line per non-zero outcome, in the parser's house style. */
  warnings: string[];
}

/**
 * The object path for a post's mirrored thumbnail, or null when the ig_id
 * cannot safely become one.
 *
 * Deterministic and derivable by any consumer from two columns it already has,
 * which is why there is no file extension: an extension is a claim about the
 * bytes, and the bytes are not known until after the download. The content type
 * is stored as object metadata instead, and Supabase serves it on the signed
 * URL, so a browser renders the object correctly with no extension present.
 * Keeping the name extension-free also means a post mirrored as a JPEG and
 * later re-fetched as a WebP occupies one object, not two.
 *
 * The account segment carries no uniqueness — an ig_id is already unique — it
 * exists so the bucket is browsable and so the "already mirrored" listing can
 * be read one account at a time.
 */
export function mirrorPathFor(account: Account, igId: string): string | null {
  if (!ID_SHAPE.test(igId)) return null;
  return `${PREFIX}/${account}/${igId}`;
}

/** The /api/assets query that reads a mirrored object back. Server-side only. */
export function mirrorReadPath(path: string): string {
  return `/api/assets?path=${encodeURIComponent(path)}`;
}

export type MirrorSource =
  | { ok: true; url: string }
  | { ok: false; reason: 'no_media_url' | 'untrusted_host' };

/**
 * The thumbnail URL for a post, taken from its raw payload and checked.
 *
 * Two failures are reported apart because they mean different things to whoever
 * reads the counts: "the actor did not return a thumbnail for this post" and
 * "it returned one this module refuses to fetch" are not the same finding.
 */
export function pickMirrorSource(raw: Json): MirrorSource {
  let candidate = pickString(raw, MEDIA_URL_KEYS);

  // Nested shapes some actor versions use instead of a flat key.
  if (candidate === null) {
    const images = raw['images'];
    if (Array.isArray(images)) {
      for (const entry of images) {
        if (typeof entry === 'string' && entry.trim().length > 0) {
          candidate = entry.trim();
          break;
        }
        if (isObject(entry)) {
          const nested = pickString(entry, ['url', 'src', 'displayUrl']);
          if (nested !== null) {
            candidate = nested;
            break;
          }
        }
      }
    }
  }
  if (candidate === null) {
    const resources = raw['displayResources'];
    if (Array.isArray(resources)) {
      for (const entry of resources) {
        if (!isObject(entry)) continue;
        const nested = pickString(entry, ['src', 'url']);
        if (nested !== null) {
          candidate = nested;
          break;
        }
      }
    }
  }

  if (candidate === null) return { ok: false, reason: 'no_media_url' };

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: 'untrusted_host' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'untrusted_host' };

  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!allowed) return { ok: false, reason: 'untrusted_host' };

  return { ok: true, url: parsed.toString() };
}

/** A bounded worker pool. Counters are mutated from it; JS runs one at a time. */
async function pool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/* ============================================================ THE READER ==
 *
 * What the bucket holds for one account, and what that does NOT tell you.
 *
 * `complete` is the whole point of this shape. A listing that answered every
 * page proves both halves: a name present means an object exists, and a name
 * absent means one does not. A listing that failed, or that ran out of its page
 * bound, proves only the first — absence is then UNKNOWN, not false. The writer
 * can treat unknown as "download it again" (wasteful, never wrong); a reader
 * cannot treat it as "there is no image", because that is a claim about the
 * post, and it would be one this module never measured (hard rule 2).
 */
export interface MirrorIndexEntry {
  /** Object names under `post-media/<account>/`. Each one is an ig_id. */
  names: Set<string>;
  /** True only when every page of the listing was read. */
  complete: boolean;
  /** What storage said when it refused. Null when it never refused. */
  error: string | null;
}

/** The same answer across several accounts, plus the two facts rolled up. */
export interface MirrorIndex {
  accounts: Map<Account, MirrorIndexEntry>;
  /** True when every account's listing was complete. */
  complete: boolean;
  /** The first refusal, verbatim. Null when nothing refused. */
  error: string | null;
}

/**
 * One account's object names, paged to MAX_INDEX_PAGES.
 *
 * IT NEVER THROWS, and that is a reader requirement rather than a writer one.
 * The mirror pass runs inside a try/catch that turns anything into a counted
 * outcome, so a throw here was survivable; /api/board calls this while
 * assembling a screen whose entire other content — captions, engagement,
 * analyses — is already in hand. Failing that request because a thumbnail
 * listing timed out would trade the whole board for the images. So a throw
 * becomes `complete: false` with the message, exactly like a refusal, and every
 * card whose name is not in the (possibly empty) set reports "unknown".
 */
async function listMirrored(db: SupabaseClient, account: Account): Promise<MirrorIndexEntry> {
  const names = new Set<string>();
  try {
    for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
      const { data, error } = await db.storage
        .from(BUCKET)
        .list(`${PREFIX}/${account}`, { limit: INDEX_PAGE, offset: page * INDEX_PAGE });

      // A missing prefix lists as empty — which is a complete answer, and the
      // answer today: nothing has ever been mirrored. A real failure means the
      // index is unknown, and an unknown index is reported as incomplete rather
      // than assumed empty; assuming empty would re-download the whole account
      // on the write side and claim "no image" on the read side.
      if (error) return { names, complete: false, error: error.message };
      const batch = data ?? [];
      for (const object of batch) names.add(object.name);
      if (batch.length < INDEX_PAGE) return { names, complete: true, error: null };
    }
  } catch (err) {
    return { names, complete: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Out of pages, with nothing refused: the names gathered are real, the ones
  // beyond the bound are unknown.
  return { names, complete: false, error: null };
}

/**
 * Which posts of these accounts have a mirrored object.
 *
 * One listing per DISTINCT account — two, at this corpus — regardless of how
 * many posts the caller is about to ask about. That is why the index is built
 * once and passed to postMediaFor() per post, rather than each post asking
 * storage about itself: 320 cards would otherwise be 320 subrequests, and a
 * Workers invocation has 1,000.
 *
 * Passing no accounts issues no requests and returns a complete, empty index —
 * which is the honest answer for a board that is showing no posts.
 */
export async function readMirrorIndex(
  db: SupabaseClient,
  accounts: readonly Account[],
): Promise<MirrorIndex> {
  const index: MirrorIndex = { accounts: new Map(), complete: true, error: null };

  for (const account of new Set<Account>(accounts)) {
    const entry = await listMirrored(db, account);
    index.accounts.set(account, entry);
    if (!entry.complete) index.complete = false;
    if (entry.error !== null && index.error === null) index.error = entry.error;
  }

  return index;
}

/**
 * What one post's card is allowed to say about its image.
 *
 * THREE STATES, NOT TWO. `mirrored` is a boolean OR NULL, and the null is the
 * reason this type exists: "the index could not be read" is not "there is no
 * image", and a card that renders them identically has invented a fact about
 * the post. `src` is populated only in the proven case, so a caller cannot
 * render an <img> at a path that was never confirmed to hold bytes — which is
 * how a broken-image icon reaches a screen (hard rule 2 again: the placeholder
 * is designed, the browser's broken glyph is not).
 *
 * `path` is the object name this post's thumbnail would occupy whether or not
 * it holds one, so the quantity on screen has its key available on inspection
 * (rule 12) — an operator can read a card's path straight back through
 * /api/assets and see the same object the mirror wrote.
 */
export interface PostMedia {
  /** true = an object exists. false = none does. null = the index is unknown. */
  mirrored: boolean | null;
  /** `post-media/<account>/<ig_id>`, or null when the ig_id cannot name one. */
  path: string | null;
  /**
   * The auth-gated /api/assets query, ONLY when `mirrored` is true. Never a
   * signed URL: this is a route path, and the signed URL is minted inside that
   * route after requireOperator() and handed over as a 307 (rule 4).
   */
  src: string | null;
}

/** One post's image state, read off an index built by readMirrorIndex(). */
export function postMediaFor(index: MirrorIndex, account: Account, igId: string): PostMedia {
  const path = mirrorPathFor(account, igId);
  // No path can be derived, so no object can exist under one. That is a proven
  // false rather than an unknown — the writer refuses the same ids for the same
  // reason, so there is nowhere for bytes to be hiding.
  if (path === null) return { mirrored: false, path: null, src: null };

  const entry = index.accounts.get(account);
  // The account was never listed, so nothing was measured about it.
  if (entry === undefined) return { mirrored: null, path, src: null };

  if (entry.names.has(igId)) return { mirrored: true, path, src: mirrorReadPath(path) };
  // Absence only counts as an answer when the listing was complete.
  return entry.complete
    ? { mirrored: false, path, src: null }
    : { mirrored: null, path, src: null };
}

/**
 * The three counts a surface may show, over the posts it is actually showing.
 *
 * All three are MEASURED — every post lands in exactly one of them and they sum
 * to `examined` — so none of them is a zero standing in for an absence. When the
 * index was partial, that shows up as `unknown` rising rather than as `mirrored`
 * quietly under-reporting a total it could not know.
 */
export interface MirrorCoverage {
  examined: number;
  mirrored: number;
  not_mirrored: number;
  unknown: number;
}

export function mirrorCoverage(media: readonly PostMedia[]): MirrorCoverage {
  const coverage: MirrorCoverage = { examined: media.length, mirrored: 0, not_mirrored: 0, unknown: 0 };
  for (const entry of media) {
    if (entry.mirrored === true) coverage.mirrored += 1;
    else if (entry.mirrored === false) coverage.not_mirrored += 1;
    else coverage.unknown += 1;
  }
  return coverage;
}

/** Turns the counters into lines an operator can act on. */
function describe(result: MirrorMediaResult): string[] {
  const lines: string[] = [];

  if (!result.enabled) {
    lines.push(
      result.considered === null
        ? 'MIRROR_MEDIA is off: the pass was skipped before its candidates were read, so nothing was read, downloaded or stored.'
        : `MIRROR_MEDIA is off: ${result.considered} post(s) were considered and nothing was downloaded or stored.`,
    );
    return lines;
  }

  if (result.mirrored > 0) {
    lines.push(`${result.mirrored} thumbnail(s) mirrored (${result.bytes_stored} bytes stored).`);
  }
  if (result.already_mirrored > 0) {
    lines.push(`${result.already_mirrored} post(s) were already mirrored and were not re-fetched.`);
  }
  if (result.skipped.over_cap > 0) {
    lines.push(
      `${result.skipped.over_cap} post(s) left for the next pass: this one hit its cap of ${result.cap.max_objects} object(s).`,
    );
  }
  if (result.skipped.no_media_url > 0) {
    lines.push(`${result.skipped.no_media_url} post(s) carry no thumbnail URL in their payload.`);
  }
  if (result.skipped.untrusted_host > 0) {
    lines.push(
      `${result.skipped.untrusted_host} post(s) skipped: their media URL is not https on an Instagram CDN host.`,
    );
  }
  if (result.skipped.unsafe_id > 0) {
    lines.push(`${result.skipped.unsafe_id} post(s) skipped: ig_id is not a usable object name.`);
  }
  if (result.failed.download > 0) {
    lines.push(
      `${result.failed.download} download(s) failed — the usual cause is an expired Instagram CDN URL. Those posts are not mirrored.`,
    );
  }
  if (result.failed.not_image > 0) {
    lines.push(`${result.failed.not_image} response(s) were not an image and were discarded.`);
  }
  if (result.failed.too_large > 0) {
    lines.push(
      `${result.failed.too_large} object(s) exceeded the ${result.cap.max_object_bytes}-byte per-object limit.`,
    );
  }
  if (result.failed.upload > 0) {
    lines.push(`${result.failed.upload} download(s) succeeded but could not be stored.`);
  }
  if (!result.index_complete) {
    lines.push(
      result.index_error === null
        ? 'The already-mirrored listing was incomplete, so this pass may have re-downloaded objects it already had.'
        : `The already-mirrored listing was incomplete (${result.index_error}), so this pass may have re-downloaded objects it already had.`,
    );
  }
  if (result.error !== null) {
    lines.push(`The mirror pass stopped early: ${result.error}`);
  }

  return lines;
}

/**
 * MIRROR_MEDIA, for a caller that must decide whether to do the work that
 * PRODUCES this module's argument.
 *
 * mirrorPostMedia() checks the flag itself and always will — that is the pass's
 * own guard and nothing may depend on a caller remembering it. This exists
 * because checking it there is too late for the CALLER: /api/monitor builds its
 * candidate list by reading up to MAX_POSTS_SCAN rows of `posts.raw` back out of
 * Postgres, which at the import ceiling is the whole scrape payload a second
 * time and the largest single allocation in that route. A pass that is off by
 * default must not cost that. The value still comes from `mirrorMedia()`, so the
 * env key keeps exactly one reader.
 */
export function mirrorMediaEnabled(): boolean {
  return mirrorMedia();
}

/**
 * The shape of a pass that did not run. `considered` is a count when candidates
 * were handed over and null when the caller skipped building them.
 */
function disabledResult(considered: number | null, cap: number): MirrorMediaResult {
  const result: MirrorMediaResult = {
    enabled: false,
    reason:
      'MIRROR_MEDIA is not enabled. Post media was not downloaded and nothing was written to storage.',
    cap: { max_objects: cap, max_object_bytes: MAX_OBJECT_BYTES },
    considered,
    attempted: 0,
    mirrored: 0,
    already_mirrored: 0,
    skipped: { no_media_url: 0, untrusted_host: 0, unsafe_id: 0, over_cap: 0 },
    failed: { download: 0, not_image: 0, too_large: 0, upload: 0 },
    bytes_stored: 0,
    index_complete: true,
    index_error: null,
    error: null,
    warnings: [],
  };
  result.warnings = describe(result);
  return result;
}

/**
 * The report of a pass that was never attempted, because the flag is off and the
 * caller therefore never built its candidates.
 *
 * THE REPORTING CONTRACT IS THE POINT. "Did not run" and "ran and mirrored
 * nothing" have to stay apart, and they do: this returns `enabled: false` with a
 * reason, where a pass that ran returns `enabled: true` with counts it measured.
 * The only field that differs from a disabled pass that WAS handed candidates is
 * `considered`, which is null here — no list was built, so its size is absent
 * rather than zero, and the Data screen renders absent as an em-dash.
 *
 * The caps are the module's constants, so a report can still state the ceiling
 * that would have applied. Nothing here reads the environment beyond the flag
 * and nothing here touches the network.
 */
export function skippedMirrorReport(): MirrorMediaResult {
  return disabledResult(null, MAX_MIRROR_OBJECTS);
}

/**
 * Mirrors post thumbnails into the private bucket, when MIRROR_MEDIA is on.
 *
 * When the flag is off this returns immediately with `enabled: false`, a
 * `reason`, and `considered` set to however many posts it was handed — a report
 * that it did nothing, not a silent skip. The counts are zero because zero
 * downloads happened, which is a measurement and not an absence. A caller that
 * would have to do real work to produce `posts` should call mirrorMediaEnabled()
 * first and report skippedMirrorReport() instead; this early return cannot
 * refund an allocation that already happened to build its argument.
 *
 * It never throws. Every per-post failure is a counted outcome, and an
 * unexpected failure anywhere else lands in `error` with whatever counts had
 * been accumulated, because the ingest that called this has already stored its
 * rows and must not lose them over a thumbnail.
 */
export async function mirrorPostMedia(
  posts: readonly MirrorCandidate[],
  db: SupabaseClient,
  opts: MirrorMediaOptions = {},
): Promise<MirrorMediaResult> {
  const requested = opts.maxObjects;
  const cap =
    typeof requested === 'number' && Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_MIRROR_OBJECTS)
      : MAX_MIRROR_OBJECTS;

  // The pass's own guard, kept whatever the caller did: this module decides
  // whether it runs, and it reports the same way from either entry point.
  if (!mirrorMediaEnabled()) return disabledResult(posts.length, cap);

  const result: MirrorMediaResult = {
    enabled: true,
    reason: null,
    cap: { max_objects: cap, max_object_bytes: MAX_OBJECT_BYTES },
    considered: posts.length,
    attempted: 0,
    mirrored: 0,
    already_mirrored: 0,
    skipped: { no_media_url: 0, untrusted_host: 0, unsafe_id: 0, over_cap: 0 },
    failed: { download: 0, not_image: 0, too_large: 0, upload: 0 },
    bytes_stored: 0,
    index_complete: true,
    index_error: null,
    error: null,
    warnings: [],
  };

  try {
    /* --- 1. classify every candidate, before a single byte is requested --- */
    const eligible: { account: Account; path: string; name: string; url: string }[] = [];

    for (const post of posts) {
      const path = mirrorPathFor(post.account, post.ig_id);
      if (path === null) {
        result.skipped.unsafe_id += 1;
        continue;
      }
      const source = pickMirrorSource(post.raw);
      if (!source.ok) {
        result.skipped[source.reason] += 1;
        continue;
      }
      eligible.push({ account: post.account, path, name: post.ig_id, url: source.url });
    }

    /* --- 2. drop the ones the bucket already holds ------------------------ */
    // The same index the Board reads. One implementation, so "this post has an
    // image" cannot mean one thing to the writer and another to the reader.
    const index = await readMirrorIndex(
      db,
      eligible.map((entry) => entry.account),
    );
    result.index_complete = index.complete;
    result.index_error = index.error;

    const work = eligible.filter((entry) => {
      // A name PRESENT is proof, whether or not the listing finished; only
      // absence needs a complete listing, and treating an unknown absence as a
      // re-download is the wasteful-never-wrong half of the contract.
      if (index.accounts.get(entry.account)?.names.has(entry.name) === true) {
        result.already_mirrored += 1;
        return false;
      }
      return true;
    });

    /* --- 3. spend, up to the cap and no further --------------------------- */
    result.skipped.over_cap = Math.max(0, work.length - cap);
    const batch = work.slice(0, cap);
    result.attempted = batch.length;

    const doFetch = opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init));

    await pool(batch, CONCURRENCY, async (entry) => {
      let response: Response;
      try {
        response = await doFetch(entry.url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch {
        // Expired signature, DNS, timeout — all the same outcome for this post.
        result.failed.download += 1;
        return;
      }

      if (!response.ok) {
        result.failed.download += 1;
        return;
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_OBJECT_BYTES) {
        if (response.body) await response.body.cancel().catch(() => undefined);
        result.failed.too_large += 1;
        return;
      }

      const header = response.headers.get('content-type');
      const contentType = header === null ? '' : header.split(';')[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) {
        // An expired CDN link often answers 200 with an XML or HTML error body.
        if (response.body) await response.body.cancel().catch(() => undefined);
        result.failed.not_image += 1;
        return;
      }

      let bytes: ArrayBuffer;
      try {
        bytes = await response.arrayBuffer();
      } catch {
        result.failed.download += 1;
        return;
      }

      // Second enforcement: a CDN need not declare content-length.
      if (bytes.byteLength > MAX_OBJECT_BYTES) {
        result.failed.too_large += 1;
        return;
      }

      // upsert is on only to survive a truncated index or a concurrent pass:
      // step 2 already skipped everything the bucket holds, and re-writing a
      // post's own thumbnail is idempotent. Reporting a failure there would be
      // reporting a failure that did not happen.
      const { error } = await db.storage
        .from(BUCKET)
        .upload(entry.path, bytes, { contentType, upsert: true });

      if (error) {
        result.failed.upload += 1;
        return;
      }

      result.mirrored += 1;
      result.bytes_stored += bytes.byteLength;
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.warnings = describe(result);
  return result;
}
