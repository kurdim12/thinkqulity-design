import { optionalEnv } from '@/lib/env';
import type { Account } from '@/lib/types/db';

/**
 * The single source of truth for which Instagram handle is which account.
 *
 * These two values are not a guess. They are the usernames recorded in
 * snapshots.raw_meta.usernames by the Apify run that produced all 320 stored
 * posts, so every post in the database routes through one of them. The dotted
 * spellings that appear in older prose ("@ahmad.kahtan", "@thinkquality.academy")
 * are wrong and were never in the data.
 *
 * IG_HANDLE_PERSONAL / IG_HANDLE_ACADEMY override them if the accounts are ever
 * renamed; an unset or blank override falls back to the proven value.
 */
export const CANONICAL_HANDLES: { personal: string; academy: string } = {
  personal: 'ahmadkahtan_',
  academy: 'thinkquality_academyy',
};

/** Lowercase, trimmed, no leading `@`. Null for anything empty. */
function normaliseHandle(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^@+/, '').trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

export function canonicalHandles(): { personal: string; academy: string } {
  return {
    personal: normaliseHandle(optionalEnv('IG_HANDLE_PERSONAL')) ?? CANONICAL_HANDLES.personal,
    academy: normaliseHandle(optionalEnv('IG_HANDLE_ACADEMY')) ?? CANONICAL_HANDLES.academy,
  };
}

/**
 * Routes a scraped username to an account. Case-insensitive and tolerant of a
 * leading `@`. Returns null for anyone else — an unroutable item is skipped and
 * counted, never guessed into an account.
 */
export function accountFor(username: string | null): Account | null {
  const handle = normaliseHandle(username);
  if (!handle) return null;
  const handles = canonicalHandles();
  if (handle === handles.personal) return 'personal';
  if (handle === handles.academy) return 'academy';
  return null;
}
