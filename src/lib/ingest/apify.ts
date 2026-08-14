import { HttpError } from '@/lib/auth';
import { accountFor, canonicalHandles } from '@/lib/ingest/handles';
import type { Account, SnapshotStats } from '@/lib/types/db';

/**
 * Apify's Instagram scraper emits one object per post. Field names vary a
 * little between actor versions, so every accessor below tolerates the known
 * aliases and nothing else — an unrecognised shape is rejected loudly rather
 * than silently producing zeros.
 */
export interface ParsedPost {
  account: Account;
  ig_id: string;
  url: string | null;
  caption: string | null;
  media_type: string | null;
  likes: number | null;
  comments: number | null;
  engagement: number;
  posted_at: string | null;
  owner_username: string | null;
  followers: number | null;
  /* --- 0002_v3_ingestion: fields the actor returned all along ------------- */
  video_play_count: number | null;
  video_view_count: number | null;
  video_duration: number | null;
  product_type: string | null;
  location_name: string | null;
  location_id: string | null;
  hashtags: string[] | null;
  mentions: string[] | null;
  first_comment: string | null;
  owner_id: string | null;
  is_sponsored: boolean | null;
  dimensions: { height: number | null; width: number | null } | null;
  /**
   * The source item, untouched. Hard rule 8: raw is sacred — a field this
   * parser does not surface yet is still captured, so the whole corpus is
   * re-processable without paying for another scrape.
   */
  raw: Json;
}

/** The key used when an unroutable item carried no owner username at all. */
export const UNKNOWN_OWNER = '(no owner username)';

/**
 * What was in the payload but did not become a post, counted by reason.
 * `duplicates` and `unroutable` keep the names the Data screen already reads.
 */
export interface IngestSkipped {
  duplicates: number;
  unroutable: number;
  /** Owner username → how many of its items were skipped. `UNKNOWN_OWNER` for none. */
  unroutable_by_username: Record<string, number>;
  /** Post-shaped items with no id or shortCode to key on. */
  missing_id: number;
  /** Profile-shaped items. Real data, just not posts — see ingest/profile.ts. */
  profiles: number;
  /** Records that do not look like an Instagram item at all. */
  unrecognised: number;
}

export interface IngestParseResult {
  posts: ParsedPost[];
  stats: SnapshotStats;
  skipped: IngestSkipped;
  usernames: Record<Account, string[]>;
  /**
   * One readable line per non-empty skip reason. A production scrape once lost
   * 12 items silently; nothing is dropped now without a number attached to it.
   */
  warnings: string[];
}

/**
 * A decoded JSON object. Exported alongside the accessors below so profile.ts
 * and comments.ts share one defensive field-reading toolkit instead of each
 * re-implementing the alias tolerance.
 */
export type Json = Record<string, unknown>;

export function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v.replace(/,/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Only a real boolean, or the exact strings "true"/"false", is a boolean.
 * 0 and 1 are deliberately not coerced: a missing flag must stay unknown
 * rather than becoming a confident `false` (hard rule 2).
 */
function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return null;
}

export function pickString(item: Json, keys: string[]): string | null {
  for (const key of keys) {
    const value = str(item[key]);
    if (value) return value;
  }
  return null;
}

export function pickNumber(item: Json, keys: string[]): number | null {
  for (const key of keys) {
    const value = num(item[key]);
    if (value !== null) return value;
  }
  return null;
}

export function pickBoolean(item: Json, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = bool(item[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Tag lists (hashtags, mentions). The first candidate key that holds an array
 * wins, even when that array is empty — "the actor listed no hashtags" and
 * "the actor did not report hashtags" are different answers, so the first is
 * `[]` and the second is `null`.
 *
 * Entries are trimmed and de-duplicated, and a single leading `#`/`@` marker is
 * removed because some actor versions emit "#tag" and others "tag"; the two
 * must group as one tag. No character class is filtered, so Arabic tags survive
 * intact, and `raw` keeps the original spelling either way.
 */
export function pickStringArray(item: Json, keys: string[]): string[] | null {
  for (const key of keys) {
    const value = item[key];
    if (!Array.isArray(value)) continue;
    const out: string[] = [];
    for (const entry of value) {
      const text = str(entry);
      if (!text) continue;
      const cleaned = text.replace(/^[#@]/, '').trim();
      if (cleaned.length > 0 && !out.includes(cleaned)) out.push(cleaned);
    }
    return out;
  }
  return null;
}

/** `dimensionsHeight`/`dimensionsWidth`, or a nested `dimensions` object. */
function pickDimensions(item: Json): { height: number | null; width: number | null } | null {
  let height = pickNumber(item, ['dimensionsHeight', 'height']);
  let width = pickNumber(item, ['dimensionsWidth', 'width']);
  const nested = item['dimensions'];
  if (isObject(nested)) {
    height = height ?? pickNumber(nested, ['height']);
    width = width ?? pickNumber(nested, ['width']);
  }
  if (height === null && width === null) return null;
  return { height, width };
}

export function normaliseUsername(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^@/, '').trim().toLowerCase();
}

/**
 * Strips hashtag-only lines and trailing hashtag blocks while leaving Arabic
 * text — including diacritics and tatweel — completely untouched.
 */
export function cleanCaption(raw: string | null): string | null {
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed === '') return true;
    const tokens = trimmed.split(/\s+/);
    return !tokens.every((t) => t.startsWith('#') || t.startsWith('@'));
  });
  const cleaned = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function toIso(value: unknown): string | null {
  const raw = str(value) ?? (typeof value === 'number' ? String(value) : null);
  if (!raw) return null;
  // Apify sometimes emits a unix timestamp for `timestamp`.
  if (/^\d{9,13}$/.test(raw)) {
    const ms = raw.length <= 10 ? Number(raw) * 1000 : Number(raw);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** First candidate key that parses as a timestamp. */
export function pickIso(item: Json, keys: string[]): string | null {
  for (const key of keys) {
    const value = toIso(item[key]);
    if (value) return value;
  }
  return null;
}

function looksLikeApifyPost(item: unknown): item is Json {
  if (!isObject(item)) return false;
  const hasId = pickString(item, ['id', 'postId', 'shortCode', 'shortcode', 'code']) !== null;
  const hasSignal =
    pickNumber(item, ['likesCount', 'likes', 'likeCount']) !== null ||
    pickNumber(item, ['commentsCount', 'comments', 'commentCount']) !== null ||
    pickString(item, ['url', 'postUrl', 'displayUrl']) !== null ||
    pickString(item, ['ownerUsername', 'username', 'owner_username']) !== null;
  return hasId && hasSignal;
}

/**
 * A profile-shaped item: `resultsType=details`, or the parent record the actor
 * attaches with `addParentData`. It carries a username and profile-only
 * counters but has no post identity — no shortCode, no ownerUsername, no likes.
 *
 * It lives next to looksLikeApifyPost so the two predicates cannot drift apart:
 * a profile object satisfies looksLikeApifyPost (id + username), and without
 * this guard it would be counted as a post with no engagement, quietly pulling
 * every average down.
 */
export function looksLikeApifyProfile(item: unknown): item is Json {
  if (!isObject(item)) return false;
  if (pickString(item, ['username', 'userName']) === null) return false;
  const hasProfileSignal =
    pickNumber(item, ['followersCount', 'followsCount', 'postsCount', 'followers']) !== null ||
    item['biography'] !== undefined ||
    Array.isArray(item['latestPosts']);
  const hasPostSignal =
    pickString(item, ['shortCode', 'shortcode', 'ownerUsername', 'owner_username']) !== null ||
    pickNumber(item, ['likesCount', 'likeCount']) !== null;
  return hasProfileSignal && !hasPostSignal;
}

/**
 * Profile exports nest their posts. Those nested arrays used to be dropped on
 * the floor whenever the top-level payload was itself an array of profiles, so
 * they are pulled up alongside their parent — the parent is still returned and
 * still counted, it just no longer hides its own posts.
 */
function expandNestedPosts(items: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    out.push(item);
    if (!isObject(item)) continue;
    for (const key of ['latestPosts', 'posts', 'topPosts']) {
      const nested = item[key];
      if (Array.isArray(nested) && nested.some(looksLikeApifyPost)) out.push(...nested);
    }
  }
  return out;
}

/** Flattens whatever top-level shape the export arrived in into an item array. */
function collectItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return expandNestedPosts(payload);
  if (isObject(payload)) {
    for (const key of ['items', 'data', 'results', 'posts', 'latestPosts']) {
      const value = payload[key];
      if (Array.isArray(value)) return expandNestedPosts(value);
    }
    // A profile object with nested posts (Apify profile scraper shape).
    const nested: unknown[] = [];
    for (const value of Object.values(payload)) {
      if (Array.isArray(value) && value.some(looksLikeApifyPost)) nested.push(...value);
    }
    if (nested.length > 0) return nested;
    // A single profile object on its own is still a recognisable record.
    if (looksLikeApifyProfile(payload)) return [payload];
  }
  return [];
}

function emptyByAccount<T>(value: T): Record<Account, T> {
  return { personal: value, academy: value };
}

/** Turns the skip counters into lines an operator can act on. */
function describeSkipped(skipped: IngestSkipped): string[] {
  const warnings: string[] = [];

  if (skipped.unroutable > 0) {
    const detail = Object.entries(skipped.unroutable_by_username)
      .sort((a, b) => b[1] - a[1])
      .map(([username, count]) =>
        username === UNKNOWN_OWNER ? `${UNKNOWN_OWNER} (${count})` : `@${username} (${count})`,
      )
      .join(', ');
    warnings.push(
      `${skipped.unroutable} item(s) skipped: owner is not a known account — ${detail}.`,
    );
  }
  if (skipped.missing_id > 0) {
    warnings.push(`${skipped.missing_id} item(s) skipped: no id or shortCode to key on.`);
  }
  if (skipped.profiles > 0) {
    warnings.push(
      `${skipped.profiles} profile record(s) in the payload were not counted as posts.`,
    );
  }
  if (skipped.unrecognised > 0) {
    warnings.push(
      `${skipped.unrecognised} record(s) skipped: not recognisable as an Instagram item.`,
    );
  }
  if (skipped.duplicates > 0) {
    warnings.push(`${skipped.duplicates} duplicate post(s) collapsed by ig_id.`);
  }

  return warnings;
}

/**
 * Parses one or more Apify JSON exports into a snapshot's worth of posts.
 * Dedupes by ig_id across files, routes by owner username through
 * handles.accountFor, computes engagement as likes + comments, and ranks
 * descending. Every number here is arithmetic on the export — nothing is
 * estimated. Every item that does not become a post is counted and reported.
 */
export function parseApifyExports(files: { name: string; payload: unknown }[]): IngestParseResult {
  if (files.length === 0) {
    throw new HttpError(400, 'No files were uploaded.');
  }

  const seen = new Set<string>();
  const posts: ParsedPost[] = [];
  const usernames: Record<Account, Set<string>> = {
    personal: new Set(),
    academy: new Set(),
  };
  const skipped: IngestSkipped = {
    duplicates: 0,
    unroutable: 0,
    unroutable_by_username: {},
    missing_id: 0,
    profiles: 0,
    unrecognised: 0,
  };
  let recognisedItems = 0;

  for (const file of files) {
    const items = collectItems(file.payload);
    if (items.length === 0) {
      throw new HttpError(
        400,
        `"${file.name}" does not look like an Apify Instagram export.`,
        'Expected a JSON array of post objects (or an object with an "items" array).',
      );
    }

    for (const item of items) {
      // Profiles are real data, handled by ingest/profile.ts. Counted, not lost.
      if (looksLikeApifyProfile(item)) {
        skipped.profiles += 1;
        continue;
      }
      if (!looksLikeApifyPost(item)) {
        skipped.unrecognised += 1;
        continue;
      }
      recognisedItems += 1;

      const igId = pickString(item, ['id', 'postId', 'shortCode', 'shortcode', 'code']);
      if (!igId) {
        skipped.missing_id += 1;
        continue;
      }

      const owner = normaliseUsername(
        pickString(item, ['ownerUsername', 'username', 'owner_username', 'ownerName']),
      );
      const account = accountFor(owner);
      if (!account) {
        const key = owner ?? UNKNOWN_OWNER;
        skipped.unroutable += 1;
        skipped.unroutable_by_username[key] = (skipped.unroutable_by_username[key] ?? 0) + 1;
        continue;
      }

      if (seen.has(igId)) {
        skipped.duplicates += 1;
        continue;
      }
      seen.add(igId);
      usernames[account].add(owner ?? '');

      const likes = pickNumber(item, ['likesCount', 'likes', 'likeCount']);
      const comments = pickNumber(item, ['commentsCount', 'comments', 'commentCount']);

      posts.push({
        account,
        ig_id: igId,
        url: pickString(item, ['url', 'postUrl', 'inputUrl']),
        caption: cleanCaption(pickString(item, ['caption', 'text', 'description'])),
        media_type: pickString(item, ['type', 'productType', 'mediaType', '__typename']),
        likes,
        comments,
        engagement: (likes ?? 0) + (comments ?? 0),
        posted_at: toIso(item['timestamp'] ?? item['takenAt'] ?? item['taken_at_timestamp']),
        owner_username: owner,
        followers: pickNumber(item, ['followersCount', 'ownerFollowersCount', 'followers']),
        video_play_count: pickNumber(item, ['videoPlayCount', 'video_play_count', 'playCount']),
        video_view_count: pickNumber(item, ['videoViewCount', 'video_view_count', 'viewCount']),
        video_duration: pickNumber(item, ['videoDuration', 'video_duration', 'duration']),
        product_type: pickString(item, ['productType', 'product_type']),
        location_name: pickString(item, ['locationName', 'location_name']),
        location_id: pickString(item, ['locationId', 'location_id']),
        hashtags: pickStringArray(item, ['hashtags', 'tags']),
        mentions: pickStringArray(item, ['mentions', 'taggedUsernames']),
        first_comment: pickString(item, ['firstComment', 'first_comment']),
        owner_id: pickString(item, ['ownerId', 'owner_id']),
        is_sponsored: pickBoolean(item, ['isSponsored', 'is_sponsored']),
        dimensions: pickDimensions(item),
        // Hard rule 8: the item goes in whole, before any of the mapping above
        // is trusted. Nothing above is allowed to be the only copy of a field.
        raw: item,
      });
    }
  }

  if (recognisedItems === 0) {
    throw new HttpError(
      400,
      'None of the uploaded records look like Instagram posts.',
      skipped.profiles > 0
        ? `Found ${skipped.profiles} profile record(s) instead — those are read by the profile importer, not by a post snapshot.`
        : 'Each record needs an id/shortCode plus likes, comments, url or ownerUsername.',
    );
  }

  if (posts.length === 0) {
    const handles = canonicalHandles();
    const known = [handles.personal, handles.academy].map((u) => `@${u}`).join(', ');
    throw new HttpError(
      400,
      `Found ${recognisedItems} posts, but none belong to a known account.`,
      `Posts are routed by owner username. Expected one of: ${known}.`,
    );
  }

  posts.sort((a, b) => b.engagement - a.engagement);

  return {
    posts,
    stats: computeStats(posts),
    skipped,
    usernames: {
      personal: [...usernames.personal].filter(Boolean),
      academy: [...usernames.academy].filter(Boolean),
    },
    warnings: describeSkipped(skipped),
  };
}

/** Snapshot stats, computed in code. The model never produces these numbers. */
export function computeStats(posts: ParsedPost[]): SnapshotStats {
  const stats: SnapshotStats = {
    followers: emptyByAccount<number | null>(null),
    avg_engagement: emptyByAccount<number | null>(null),
    top_format: emptyByAccount<string | null>(null),
    post_count: emptyByAccount(0),
    total_engagement: emptyByAccount(0),
    diff_vs_prev: null,
  };

  for (const account of ['personal', 'academy'] as const) {
    const group = posts.filter((p) => p.account === account);
    stats.post_count[account] = group.length;
    if (group.length === 0) continue;

    const total = group.reduce((sum, p) => sum + p.engagement, 0);
    stats.total_engagement[account] = total;
    stats.avg_engagement[account] = Math.round(total / group.length);

    const followerValues = group.map((p) => p.followers).filter((f): f is number => f !== null);
    stats.followers[account] = followerValues.length > 0 ? Math.max(...followerValues) : null;

    // Top format = the media type with the highest average engagement.
    const byFormat = new Map<string, { total: number; count: number }>();
    for (const post of group) {
      const key = post.media_type ?? 'unknown';
      const entry = byFormat.get(key) ?? { total: 0, count: 0 };
      entry.total += post.engagement;
      entry.count += 1;
      byFormat.set(key, entry);
    }
    let best: { format: string; avg: number } | null = null;
    for (const [format, entry] of byFormat) {
      const avg = entry.total / entry.count;
      if (!best || avg > best.avg) best = { format, avg };
    }
    stats.top_format[account] = best?.format ?? null;
  }

  return stats;
}
