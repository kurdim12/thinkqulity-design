import type { Account, PostRow } from '@/lib/types/db';

/**
 * Every number on a Board card is calculated here, in code, from real rows.
 * The model is never asked for arithmetic — it only ever gets to name a
 * pattern. This is the same division of labour as the pillars.
 */
export interface ComputedAnalysis {
  vs_account_avg: number;
  vs_format_avg: number;
  /** 0–100. 99 means it outperformed 99% of that account's posts. */
  percentile: number;
  days_old: number | null;
}

export interface BoardStats {
  accountAvg: Record<Account, number>;
  formatAvg: Map<string, number>;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeStats(posts: PostRow[]): BoardStats {
  const accountAvg = {
    personal: mean(posts.filter((p) => p.account === 'personal').map((p) => p.engagement)),
    academy: mean(posts.filter((p) => p.account === 'academy').map((p) => p.engagement)),
  } as Record<Account, number>;

  const byFormat = new Map<string, number[]>();
  for (const post of posts) {
    const key = `${post.account}:${post.media_type ?? 'unknown'}`;
    byFormat.set(key, [...(byFormat.get(key) ?? []), post.engagement]);
  }

  const formatAvg = new Map<string, number>();
  for (const [key, values] of byFormat) formatAvg.set(key, mean(values));

  return { accountAvg, formatAvg };
}

export function computeFor(post: PostRow, posts: PostRow[], stats: BoardStats): ComputedAnalysis {
  const accountPosts = posts.filter((p) => p.account === post.account);
  const accountAvg = stats.accountAvg[post.account];
  const formatKey = `${post.account}:${post.media_type ?? 'unknown'}`;
  const formatAvg = stats.formatAvg.get(formatKey) ?? 0;

  const below = accountPosts.filter((p) => p.engagement < post.engagement).length;
  const percentile =
    accountPosts.length <= 1 ? 50 : Math.round((below / (accountPosts.length - 1)) * 100);

  const daysOld = post.posted_at
    ? Math.max(0, Math.floor((Date.now() - new Date(post.posted_at).getTime()) / 86_400_000))
    : null;

  return {
    // Ratios against a zero average are meaningless, so they report 0 rather
    // than Infinity — an em dash in the UI beats a nonsense multiplier.
    vs_account_avg: accountAvg > 0 ? Number((post.engagement / accountAvg).toFixed(2)) : 0,
    vs_format_avg: formatAvg > 0 ? Number((post.engagement / formatAvg).toFixed(2)) : 0,
    percentile,
    days_old: daysOld,
  };
}
