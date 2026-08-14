import { HttpError } from '@/lib/auth';
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
}

export interface IngestParseResult {
  posts: ParsedPost[];
  stats: SnapshotStats;
  skipped: { duplicates: number; unroutable: number };
  usernames: Record<Account, string[]>;
}

export interface AccountMapping {
  personal: string[];
  academy: string[];
}

/** Usernames from the seed facts. Lowercase, no leading @. */
export const DEFAULT_ACCOUNT_MAPPING: AccountMapping = {
  personal: ['ahmadkahtan_'],
  academy: ['thinkquality_academyy'],
};

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
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

function pickString(item: Json, keys: string[]): string | null {
  for (const key of keys) {
    const value = str(item[key]);
    if (value) return value;
  }
  return null;
}

function pickNumber(item: Json, keys: string[]): number | null {
  for (const key of keys) {
    const value = num(item[key]);
    if (value !== null) return value;
  }
  return null;
}

function normaliseUsername(raw: string | null): string | null {
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

function toIso(value: unknown): string | null {
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

/** Flattens whatever top-level shape the export arrived in into a post array. */
function collectItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isObject(payload)) {
    for (const key of ['items', 'data', 'results', 'posts', 'latestPosts']) {
      const value = payload[key];
      if (Array.isArray(value)) return value;
    }
    // A profile object with nested posts (Apify profile scraper shape).
    const nested: unknown[] = [];
    for (const value of Object.values(payload)) {
      if (Array.isArray(value) && value.some(looksLikeApifyPost)) nested.push(...value);
    }
    if (nested.length > 0) return nested;
  }
  return [];
}

function routeAccount(username: string | null, mapping: AccountMapping): Account | null {
  if (!username) return null;
  if (mapping.personal.includes(username)) return 'personal';
  if (mapping.academy.includes(username)) return 'academy';
  return null;
}

function emptyByAccount<T>(value: T): Record<Account, T> {
  return { personal: value, academy: value };
}

/**
 * Parses one or more Apify JSON exports into a snapshot's worth of posts.
 * Dedupes by ig_id across files, routes by owner username, computes engagement
 * as likes + comments, and ranks descending. Every number here is arithmetic on
 * the export — nothing is estimated.
 */
export function parseApifyExports(
  files: { name: string; payload: unknown }[],
  mapping: AccountMapping = DEFAULT_ACCOUNT_MAPPING,
): IngestParseResult {
  if (files.length === 0) {
    throw new HttpError(400, 'No files were uploaded.');
  }

  const seen = new Set<string>();
  const posts: ParsedPost[] = [];
  const usernames: Record<Account, Set<string>> = {
    personal: new Set(),
    academy: new Set(),
  };
  let duplicates = 0;
  let unroutable = 0;
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
      if (!looksLikeApifyPost(item)) continue;
      recognisedItems += 1;

      const igId = pickString(item, ['id', 'postId', 'shortCode', 'shortcode', 'code']);
      if (!igId) continue;

      const owner = normaliseUsername(
        pickString(item, ['ownerUsername', 'username', 'owner_username', 'ownerName']),
      );
      const account = routeAccount(owner, mapping);
      if (!account) {
        unroutable += 1;
        continue;
      }

      if (seen.has(igId)) {
        duplicates += 1;
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
      });
    }
  }

  if (recognisedItems === 0) {
    throw new HttpError(
      400,
      'None of the uploaded records look like Instagram posts.',
      'Each record needs an id/shortCode plus likes, comments, url or ownerUsername.',
    );
  }

  if (posts.length === 0) {
    const known = [...mapping.personal, ...mapping.academy].map((u) => `@${u}`).join(', ');
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
    skipped: { duplicates, unroutable },
    usernames: {
      personal: [...usernames.personal].filter(Boolean),
      academy: [...usernames.academy].filter(Boolean),
    },
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
