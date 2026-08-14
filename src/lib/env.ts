/**
 * Environment access. Every read is lazy so `next build` succeeds on a machine
 * with no `.env` — the app only fails when a route actually needs a value.
 */

export type EnvKey =
  | 'ANTHROPIC_API_KEY'
  | 'NEXT_PUBLIC_SUPABASE_URL'
  | 'NEXT_PUBLIC_SUPABASE_ANON_KEY'
  | 'SUPABASE_SERVICE_ROLE_KEY'
  | 'ALLOWED_EMAILS'
  // Optional overrides — the two model tiers behind the header quality switch.
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
