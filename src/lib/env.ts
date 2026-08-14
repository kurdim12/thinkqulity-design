/**
 * Environment access. Every read is lazy so `next build` succeeds on a machine
 * with no `.env` — the app only fails when a route actually needs a value.
 */

export type EnvKey =
  | 'ANTHROPIC_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'NEXT_PUBLIC_SUPABASE_URL'
  | 'NEXT_PUBLIC_SUPABASE_ANON_KEY'
  | 'SUPABASE_SERVICE_ROLE_KEY'
  | 'ALLOWED_EMAILS'
  // Optional. 'anthropic' | 'openrouter'; inferred from whichever key is set.
  | 'AI_PROVIDER'
  // Optional. Canon embeddings; defaults to the keyless local embedder.
  | 'EMBEDDING_PROVIDER'
  | 'EMBEDDING_MODEL'
  | 'OPENAI_API_KEY'
  // Optional. Automated Instagram monitoring via Apify. Read-only.
  | 'APIFY_TOKEN'
  | 'APIFY_ACTOR'
  | 'APIFY_PROFILES'
  // Optional. The two account handles; see src/lib/ingest/handles.ts for the
  // proven defaults these override.
  | 'IG_HANDLE_PERSONAL'
  | 'IG_HANDLE_ACADEMY'
  // Optional. Scrape budget ceiling in USD, and comment-pull limits.
  | 'APIFY_BUDGET_USD'
  | 'COMMENTS_TOP_N'
  | 'COMMENTS_PER_POST'
  | 'MIRROR_MEDIA'
  // Optional overrides — the two model tiers behind the header quality switch.
  | 'AI_MODEL_STANDARD'
  | 'AI_MODEL_QUALITY'
  // Legacy aliases, still honoured.
  | 'ANTHROPIC_MODEL_STANDARD'
  | 'ANTHROPIC_MODEL_QUALITY';

export class MissingEnvError extends Error {
  readonly key: EnvKey;

  constructor(key: EnvKey) {
    super(`Missing environment variable ${key}. Copy .env.example to .env.local and fill it in.`);
    this.name = 'MissingEnvError';
    this.key = key;
  }
}

export function optionalEnv(key: EnvKey): string | null {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function requireEnv(key: EnvKey): string {
  const value = optionalEnv(key);
  if (!value) throw new MissingEnvError(key);
  return value;
}

export function hasEnv(key: EnvKey): boolean {
  return optionalEnv(key) !== null;
}

/** Emails allowed to sign in, lowercased. Empty array = nobody can sign in. */
export function allowedEmails(): string[] {
  const raw = optionalEnv('ALLOWED_EMAILS');
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}

/* ------------------------------------------------------------ v3 ingestion -- */

/**
 * A finite number from the environment, or null. A value that is set but not
 * parseable returns null rather than a silent 0 — a misspelt budget must not
 * read as "spend nothing", and a misspelt limit must not read as "no limit".
 * Callers that need a hard failure should check `hasEnv` alongside this.
 */
export function optionalNumberEnv(key: EnvKey): number | null {
  const raw = optionalEnv(key);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A positive-integer limit, or `fallback` when unset, unparseable or <= 0. */
export function positiveIntEnv(key: EnvKey, fallback: number): number {
  const value = optionalNumberEnv(key);
  if (value === null || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

/** `true` only for an explicit truthy spelling. Anything else is false. */
export function booleanEnv(key: EnvKey): boolean {
  const raw = optionalEnv(key);
  if (raw === null) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * The scrape spend ceiling in USD, or null when no ceiling is configured.
 * A negative or unparseable value is returned as-is / as null so that
 * checkBudget can reject it loudly instead of guessing an intent.
 */
export function apifyBudgetUsd(): number | null {
  return optionalNumberEnv('APIFY_BUDGET_USD');
}

/** How many top posts (by engagement) get their comments pulled. */
export function commentsTopN(): number {
  return positiveIntEnv('COMMENTS_TOP_N', 50);
}

/** How many comments to pull per post. */
export function commentsPerPost(): number {
  return positiveIntEnv('COMMENTS_PER_POST', 100);
}

/** Whether to mirror post media into storage. Off unless explicitly enabled. */
export function mirrorMedia(): boolean {
  return booleanEnv('MIRROR_MEDIA');
}
