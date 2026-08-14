import {
  isObject,
  normaliseUsername,
  pickIso,
  pickNumber,
  pickString,
  type Json,
} from '@/lib/ingest/apify';
import { instagramShortcode } from '@/lib/snapshots';
import type { CommentRow } from '@/lib/types/db';

/**
 * Comment items from Apify's Instagram scraper, mapped onto `comments` rows.
 *
 * HARD RULE 10 — commenters are an audience, not targets.
 *
 * This module maps items to rows and stops there. It builds no per-commenter
 * aggregate, no "top commenter" ranking, no follower lookup, no per-handle
 * history — and nothing downstream may add one here. `author_handle` is stored
 * for two narrow reasons: it is in the raw payload and dropping it would make
 * the stored copy a lie (rule 8), and it lets a duplicate reply be recognised.
 * Nothing reads it. The audience analysis that consumes these rows works at
 * aggregate level only: themes, questions, register, timing.
 *
 * If you arrived here to add `groupBy(author_handle)`, that is the surface this
 * comment exists to prevent. Aggregate over comments, never over people.
 */
export type ParsedComment = Omit<CommentRow, 'id'>;

/**
 * ig_id → posts.id, for the posts already stored. A Map is what a Supabase
 * select naturally produces; a plain object is accepted so a caller that built
 * a lookup from JSON does not have to convert it.
 */
export type PostIdIndex = ReadonlyMap<string, string> | Readonly<Record<string, string>>;

export interface ParseCommentsResult {
  comments: ParsedComment[];
  skipped: {
    /** Same (post_id, ig_comment_id) seen twice — the table's unique key. */
    duplicates: number;
    /** No comment id to key on. */
    missing_id: number;
    /** No text at all; text_content is NOT NULL and is never invented. */
    missing_text: number;
    /** Records that do not look like a comment. */
    unrecognised: number;
  };
  /**
   * Comments kept with `post_id: null` because their post is not in the index.
   * Counted rather than dropped — they are still real comments, they just
   * cannot be quoted against a post yet.
   */
  unmatched_post: number;
  warnings: string[];
}

const ID_KEYS = ['id', 'commentId', 'comment_id', 'pk'];
const TEXT_KEYS = ['text', 'commentText', 'content', 'message', 'caption'];
const AUTHOR_KEYS = ['ownerUsername', 'username', 'owner_username', 'author'];
const TIME_KEYS = ['timestamp', 'createdAt', 'created_at', 'takenAt', 'taken_at', 'time'];
const LIKE_KEYS = ['likesCount', 'likeCount', 'likes', 'comment_like_count'];
const POST_ID_KEYS = ['postId', 'post_id', 'mediaId', 'media_id'];
const POST_CODE_KEYS = ['postShortCode', 'shortCode', 'shortcode', 'postCode'];
const POST_URL_KEYS = ['postUrl', 'post_url', 'inputUrl', 'commentUrl', 'url'];
const REPLY_KEYS = ['replies', 'childComments', 'threadedComments'];

/** Replies nest one level in the actor's output; the guard is belt and braces. */
const MAX_REPLY_DEPTH = 4;

/**
 * Whitespace-only normalisation: CRLF folded, runs of blank lines collapsed,
 * ends trimmed. Nothing else is touched.
 *
 * This deliberately does NOT reuse cleanCaption. A caption's trailing hashtag
 * block is decoration, but a comment that reads only "#تعلم 🔥" IS the comment —
 * stripping it would delete the record. As in cleanCaption, no character class
 * is filtered, so Arabic script, diacritics, tatweel and emoji survive intact.
 */
export function cleanCommentText(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function looksLikeApifyComment(item: unknown): item is Json {
  if (!isObject(item)) return false;
  const hasText = pickString(item, TEXT_KEYS) !== null;
  const hasId = pickString(item, ID_KEYS) !== null;
  return hasText || (hasId && commentAuthor(item) !== null);
}

/** Flat `ownerUsername`, or the nested `owner`/`user` object. */
function commentAuthor(item: Json): string | null {
  const flat = normaliseUsername(pickString(item, AUTHOR_KEYS));
  if (flat) return flat;
  for (const key of ['owner', 'user', 'from']) {
    const nested = item[key];
    if (isObject(nested)) {
      const handle = normaliseUsername(pickString(nested, ['username', 'handle', 'userName']));
      if (handle) return handle;
    }
  }
  return null;
}

function lookup(index: PostIdIndex, key: string | null): string | null {
  if (!key) return null;
  if (index instanceof Map) return index.get(key) ?? null;
  const record = index as Readonly<Record<string, string>>;
  return Object.hasOwn(record, key) ? (record[key] ?? null) : null;
}

/**
 * Resolves the post a comment belongs to. Tries the ids the actor may have
 * attached, then the shortcode, then the shortcode inside any post URL —
 * `posts.ig_id` is whichever of id/shortCode the original export carried, so
 * all three are worth trying before giving up.
 */
function resolvePostId(item: Json, index: PostIdIndex): string | null {
  for (const keys of [POST_ID_KEYS, POST_CODE_KEYS]) {
    for (const key of keys) {
      const hit = lookup(index, pickString(item, [key]));
      if (hit) return hit;
    }
  }
  for (const key of POST_URL_KEYS) {
    const hit = lookup(index, instagramShortcode(pickString(item, [key])));
    if (hit) return hit;
  }
  return null;
}

/** A comment plus the comment it was nested under, if any. */
interface FlatComment {
  item: unknown;
  /** The parent comment, kept so a reply can inherit its post reference. */
  parent: Json | null;
}

/** Flattens a comment and its nested replies into one list, depth-first. */
function flattenComments(items: unknown[], parent: Json | null, depth: number): FlatComment[] {
  const out: FlatComment[] = [];
  for (const item of items) {
    out.push({ item, parent });
    if (!isObject(item)) continue;
    if (depth >= MAX_REPLY_DEPTH) continue;
    for (const key of REPLY_KEYS) {
      const nested = item[key];
      if (Array.isArray(nested)) out.push(...flattenComments(nested, item, depth + 1));
    }
  }
  return out;
}

/** Flattens whatever top-level shape the payload arrived in into an item list. */
function collectCommentItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isObject(payload)) {
    for (const key of ['items', 'data', 'results', 'comments', 'latestComments']) {
      const value = payload[key];
      if (Array.isArray(value)) return value;
    }
    return [payload];
  }
  return [];
}

/**
 * Parses comment items into `comments` rows, deduped by
 * (post_id, ig_comment_id) — the table's unique key. Replies are flattened in
 * alongside their parent and inherit the parent's post when they carry no post
 * reference of their own.
 *
 * A comment whose post is not in `postIdByIgId` is kept with `post_id: null`
 * and counted, not discarded.
 */
export function parseComments(items: unknown, postIdByIgId: PostIdIndex): ParseCommentsResult {
  const collected = flattenComments(collectCommentItems(items), null, 0);

  const comments: ParsedComment[] = [];
  const seen = new Set<string>();
  const skipped = { duplicates: 0, missing_id: 0, missing_text: 0, unrecognised: 0 };
  let unmatchedPost = 0;

  for (const { item, parent } of collected) {
    if (!looksLikeApifyComment(item)) {
      skipped.unrecognised += 1;
      continue;
    }

    const igCommentId = pickString(item, ID_KEYS);
    if (!igCommentId) {
      skipped.missing_id += 1;
      continue;
    }

    const text = cleanCommentText(pickString(item, TEXT_KEYS));
    if (!text) {
      skipped.missing_text += 1;
      continue;
    }

    // A reply carries no post reference of its own, so it falls back to the
    // comment it hangs under — which is the post it was written on.
    const postId =
      resolvePostId(item, postIdByIgId) ??
      (parent === null ? null : resolvePostId(parent, postIdByIgId));
    if (postId === null) unmatchedPost += 1;

    // Deduped on the table's unique key, (post_id, ig_comment_id). The NUL
    // separator cannot occur in a uuid or an Instagram id, so no two distinct
    // pairs can collapse onto one key.
    const key = `${postId ?? ''}\u0000${igCommentId}`;
    if (seen.has(key)) {
      skipped.duplicates += 1;
      continue;
    }
    seen.add(key);

    comments.push({
      post_id: postId,
      ig_comment_id: igCommentId,
      author_handle: commentAuthor(item),
      text_content: text,
      likes: pickNumber(item, LIKE_KEYS),
      posted_at: pickIso(item, TIME_KEYS),
      // Hard rule 8: the item goes in whole.
      raw: item,
    });
  }

  const warnings: string[] = [];
  if (unmatchedPost > 0) {
    warnings.push(
      `${unmatchedPost} comment(s) kept without a post: their post is not in this database yet.`,
    );
  }
  if (skipped.duplicates > 0) {
    warnings.push(`${skipped.duplicates} duplicate comment(s) collapsed.`);
  }
  if (skipped.missing_id > 0) {
    warnings.push(`${skipped.missing_id} comment(s) skipped: no comment id.`);
  }
  if (skipped.missing_text > 0) {
    warnings.push(`${skipped.missing_text} comment(s) skipped: no text.`);
  }
  if (skipped.unrecognised > 0) {
    warnings.push(`${skipped.unrecognised} record(s) skipped: not recognisable as a comment.`);
  }

  return { comments, skipped, unmatched_post: unmatchedPost, warnings };
}
