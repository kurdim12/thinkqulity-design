import {
  isObject,
  looksLikeApifyProfile,
  normaliseUsername,
  pickBoolean,
  pickNumber,
  pickString,
  type Json,
} from '@/lib/ingest/apify';
import { accountFor } from '@/lib/ingest/handles';
import { todayIso } from '@/lib/snapshots';
import type { ProfileSnapshotRow } from '@/lib/types/db';

/**
 * Profile-shaped items from apify/instagram-scraper (`resultsType=details`),
 * mapped onto profile_snapshots rows.
 *
 * This is where follower counts come from. The post scraper does not reliably
 * return them — snapshots.stats.followers is `{personal: null, academy: null}`
 * for every snapshot taken so far — so a follower number that is not in a
 * profile payload stays null and renders as an em-dash (hard rule 2).
 */
export interface ParsedProfile extends Omit<ProfileSnapshotRow, 'id'> {
  /**
   * The handle this row was routed by. Not a column: the writer persists
   * `account`. Kept so a caller can report which handle produced which row.
   */
  username: string;
}

export interface ParseProfilesOptions {
  /**
   * ISO date (`YYYY-MM-DD`) the profile was read on. Defaults to today.
   * Latin digits only — an Arabic-Indic date string is rejected with a warning
   * rather than handed to Postgres.
   */
  takenOn?: string;
}

export interface ParseProfilesResult {
  profiles: ParsedProfile[];
  /** Every profile-shaped item that did not become a row, with its reason. */
  warnings: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Counts the actor writes either flat (`followersCount: <n>`) or nested in the
 * GraphQL shape (`edge_followed_by: {count: <n>}`). No specimen figure stands in
 * for `<n>`: an illustrative follower count is still a number nobody measured,
 * and hard rule 2 covers comments too.
 */
function pickCount(item: Json, keys: string[]): number | null {
  const direct = pickNumber(item, keys);
  if (direct !== null) return direct;
  for (const key of keys) {
    const nested = item[key];
    if (isObject(nested)) {
      const count = pickNumber(nested, ['count']);
      if (count !== null) return count;
    }
  }
  return null;
}

/** `externalUrl`, or the first entry of the `externalUrls` link list. */
function pickExternalUrl(item: Json): string | null {
  const direct = pickString(item, ['externalUrl', 'external_url', 'website']);
  if (direct) return direct;
  const list = item['externalUrls'];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!isObject(entry)) continue;
      const url = pickString(entry, ['url', 'lynx_url', 'link']);
      if (url) return url;
    }
  }
  return null;
}

/** Flattens whatever top-level shape the payload arrived in into an item list. */
function collectProfileItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isObject(payload)) {
    for (const key of ['items', 'data', 'results', 'profiles']) {
      const value = payload[key];
      if (Array.isArray(value)) return value;
    }
    return [payload];
  }
  return [];
}

/**
 * Parses profile items into profile_snapshots rows.
 *
 * One row per account per day, matching the table's `unique (account, taken_on)`:
 * if a payload carries the same account twice the first item wins and the
 * second is reported rather than silently overwriting it. An item whose
 * username is not a canonical handle is never guessed into an account.
 */
export function parseProfiles(
  items: unknown,
  opts: ParseProfilesOptions = {},
): ParseProfilesResult {
  const warnings: string[] = [];

  let takenOn = todayIso();
  if (opts.takenOn !== undefined) {
    if (ISO_DATE.test(opts.takenOn)) {
      takenOn = opts.takenOn;
    } else {
      warnings.push(
        `Ignored takenOn "${opts.takenOn}": expected YYYY-MM-DD in Latin digits. Used ${takenOn}.`,
      );
    }
  }

  const collected = collectProfileItems(items);
  const profiles: ParsedProfile[] = [];
  const claimed = new Map<string, string>();
  let notProfiles = 0;
  const unroutable: string[] = [];

  for (const item of collected) {
    if (!looksLikeApifyProfile(item)) {
      notProfiles += 1;
      continue;
    }

    const username = normaliseUsername(pickString(item, ['username', 'userName']));
    if (!username) {
      notProfiles += 1;
      continue;
    }
    const account = accountFor(username);
    if (!account) {
      unroutable.push(username);
      continue;
    }

    const already = claimed.get(account);
    if (already !== undefined) {
      warnings.push(
        `Two profile records for ${account} on ${takenOn}: kept @${already}, skipped @${username}.`,
      );
      continue;
    }
    claimed.set(account, username);

    profiles.push({
      account,
      username,
      taken_on: takenOn,
      followers: pickCount(item, ['followersCount', 'followers', 'edge_followed_by']),
      following: pickCount(item, ['followsCount', 'followingCount', 'following', 'edge_follow']),
      posts_count: pickCount(item, [
        'postsCount',
        'posts_count',
        'edge_owner_to_timeline_media',
        'mediaCount',
      ]),
      // Kept verbatim: a bio's hashtags and line breaks are the bio, so
      // cleanCaption's hashtag-line stripping would be a loss here.
      bio: pickString(item, ['biography', 'bio', 'description']),
      external_url: pickExternalUrl(item),
      is_verified: pickBoolean(item, ['verified', 'isVerified', 'is_verified']),
      // Hard rule 8: the profile payload goes in whole.
      raw: item,
    });
  }

  if (unroutable.length > 0) {
    const counts = new Map<string, number>();
    for (const handle of unroutable) counts.set(handle, (counts.get(handle) ?? 0) + 1);
    const detail = [...counts.entries()].map(([handle, n]) => `@${handle} (${n})`).join(', ');
    warnings.push(
      `${unroutable.length} profile record(s) skipped: not a known account — ${detail}.`,
    );
  }
  if (notProfiles > 0) {
    warnings.push(`${notProfiles} record(s) skipped: not recognisable as a profile.`);
  }
  if (profiles.length === 0) {
    warnings.push('No profile rows were parsed, so no follower number was recorded.');
  }

  return { profiles, warnings };
}
