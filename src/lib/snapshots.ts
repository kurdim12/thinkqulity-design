import type { Account, SnapshotDiff, SnapshotRow, SnapshotStats } from '@/lib/types/db';

const ACCOUNTS: readonly Account[] = ['personal', 'academy'];

/**
 * How old a snapshot may be before a client report refuses to be written from
 * it. It lives here, in the pure module both halves can reach, because it is
 * two different things at once: a rule the report feature ENFORCES on the
 * server, and a sentence the dashboard SAYS to an operator. Written twice it
 * drifts, and a screen that promises 45 while the route refuses at 30 is worse
 * than a screen that promises nothing.
 */
export const MAX_SNAPSHOT_AGE_DAYS = 45;

function delta(next: number | null, prev: number | null): number | null {
  if (next === null || prev === null) return null;
  return next - prev;
}

/**
 * Difference between two snapshots. A null delta means one side of the
 * comparison had no value — it is never coerced to zero, because "we don't
 * know" and "no change" are different answers.
 */
export function computeDiff(
  previous: SnapshotRow,
  nextStats: SnapshotStats,
  newPostCount: number,
): SnapshotDiff {
  const prev = previous.stats;
  const followers = {} as Record<Account, number | null>;
  const avgEngagement = {} as Record<Account, number | null>;
  const postCount = {} as Record<Account, number>;

  for (const account of ACCOUNTS) {
    followers[account] = delta(nextStats.followers[account], prev.followers?.[account] ?? null);
    avgEngagement[account] = delta(
      nextStats.avg_engagement[account],
      prev.avg_engagement?.[account] ?? null,
    );
    postCount[account] = nextStats.post_count[account] - (prev.post_count?.[account] ?? 0);
  }

  return {
    previous_snapshot_id: previous.id,
    previous_taken_on: previous.taken_on,
    followers,
    avg_engagement: avgEngagement,
    post_count: postCount,
    new_post_count: newPostCount,
  };
}

/** ISO date (YYYY-MM-DD) for "today" in the studio's local reckoning. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pulls the shortcode out of an Instagram permalink so a concept marked shipped
 * can be matched to its post regardless of query strings, trailing slashes, or
 * whether it was saved as /p/ or /reel/.
 */
export function instagramShortcode(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(url);
  if (match?.[1]) return match[1];
  // Bare shortcode pasted on its own.
  const bare = url.trim().replace(/\/+$/, '');
  return /^[A-Za-z0-9_-]{5,}$/.test(bare) ? bare : null;
}
