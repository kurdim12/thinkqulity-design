/**
 * Environment access. Every read is lazy so `next build` succeeds on a machine
 * with no `.env` — the app only fails when a route actually needs a value.
 */

// Via the `@/` alias, not `./env.workers`: the test loaders in tests/*.test.ts
// resolve `@/*` to `src/*.ts`, and one of them reads a dotted relative
// specifier ("env.workers") as already having an extension.
import { workerBinding } from '@/lib/env.workers';

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
  // Optional. The MCP server (src/app/api/mcp/route.ts). MCP_ACCESS_TOKEN is the
  // ONLY credential that endpoint accepts; unset it and the endpoint refuses
  // every call, which is the intended off state. An unset secret is a closed
  // door, never an open one.
  | 'MCP_ACCESS_TOKEN'
  // Optional. Hard rule 14 — external callers cannot spend freely. The ceiling
  // on model-backed generations an MCP caller can trigger per Asia/Amman day.
  | 'MCP_DAILY_GENERATION_CAP'
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

/**
 * The raw, untrimmed value of `key`, or `undefined` when neither source has it.
 * The single read site for both `optionalEnv` and `isBlank`, so "set", "blank"
 * and "absent" are all judged against the same sources in the same order.
 *
 * TWO SOURCES, IN THIS ORDER:
 *
 *   1. The Cloudflare Worker's per-request `env` — the bindings object the
 *      runtime hands to `fetch(request, env, ctx)`, read through the adapter's
 *      `getCloudflareContext()` (see env.workers.ts). This is where `vars` and
 *      `wrangler secret put` values actually live on Workers; it is the source
 *      of truth, and it is request-scoped, so it is exactly right inside a
 *      route handler or a server-component render. Outside Workers (plain
 *      `next dev` / `next start`, tests, scripts) `workerBinding` is a no-op
 *      that returns `undefined`.
 *
 *   2. `process.env[key]` — local dev reads `.env.local` through this, tests and
 *      scripts set it, and on Workers the adapter's first-request init COPIES
 *      the string bindings from `env` onto it.
 *
 * WHY 1 BEFORE 2. The deployed /login page (a `force-dynamic` server
 * component) rendered its "Setup incomplete" alert naming the four required
 * keys as unset while the same deployment's OTP route handler saw them and
 * called Supabase — i.e. the RSC render was observing a `process.env` on which
 * the adapter's copy of the bindings had not landed. Route handlers and server
 * components hold the same request context, so reading the request's own
 * `env` first removes the dependence on that copy having happened at all,
 * whatever the ordering: if a binding exists on the Worker, it is found here.
 * `process.env` stays as the fallback so nothing outside Workers changes.
 *
 * NOTE — the process.env read is a DYNAMIC index, `process.env[key]`, not
 * `process.env.FOO`. Next's build-time inlining only rewrites literal property
 * reads, so nothing read through here is ever baked into the bundle. Every
 * value must genuinely be present at RUNTIME, which on Cloudflare Workers
 * means a `vars` entry or a secret binding on the deployed Worker.
 *
 * A missing binding therefore fails at request time, not at build time. See
 * `checkRequiredEnv()` at the foot of this file for the deliberate check.
 */
function rawEnv(key: EnvKey): string | undefined {
  const bound = workerBinding(key);
  if (bound !== undefined) return bound;
  return process.env[key];
}

export function optionalEnv(key: EnvKey): string | null {
  const value = rawEnv(key);
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

/* ============================================== boot-time binding checking ==
 *
 * Why this exists. `optionalEnv` reads the Worker's request `env` and then
 * `process.env[key]` with a dynamic index, so Next inlines nothing — every
 * value has to be present at runtime, sourced on Workers from a `vars` entry
 * or a secret binding. The build cannot tell you one is absent. The first symptom is a 500 from
 * whichever route happened to need it, which on a demo day is the worst
 * possible moment to discover it. This turns that into one deliberate question
 * you can ask before anyone clicks anything.
 *
 * Two constraints, both deliberate:
 *
 *   1. Nothing here runs at module scope and `checkRequiredEnv()` never throws.
 *      A Worker that dies while loading its modules returns no diagnostics at
 *      all, so the one tool for diagnosing a bad deployment must never be able
 *      to take the deployment down. Callers decide what a failure means.
 *   2. Nothing here reports a VALUE. Only a key's name, whether it is set, and
 *      how to bind it.
 *
 * Call it from inside a request handler. Worker bindings are reliably readable
 * in request scope; module scope is not a safe place to read them.
 * ========================================================================= */

export type EnvRequirement = 'required' | 'optional';

/**
 * Where a value has to come from on Workers, which decides the fix we suggest.
 *
 *   secret — `wrangler secret put NAME`. Never belongs in a tracked file.
 *   var    — a `vars` entry in wrangler.jsonc. Safe to commit.
 */
export type EnvPlacement = 'secret' | 'var';

interface EnvSpec {
  readonly requirement: EnvRequirement;
  readonly placement: EnvPlacement;
  /** What is lost without it. Operator-facing; never mentions a value. */
  readonly what: string;
}

/**
 * Every EnvKey, classified. Typed as a total `Record<EnvKey, …>` on purpose:
 * adding a key to the union above without classifying it here is a compile
 * error, so this table cannot silently fall behind the union.
 *
 * REQUIRED is the set with no honest fallback — without them the app cannot
 * reach its database or let anybody in. Everything else is OPTIONAL because
 * the app is designed to run and be honest without it: a missing model key
 * disables generation, a missing Apify token disables scraping, and the
 * tuning vars all have documented defaults. Degraded is not broken.
 */
const ENV_SPECS: Record<EnvKey, EnvSpec> = {
  /* -- required ---------------------------------------------------------- */
  NEXT_PUBLIC_SUPABASE_URL: {
    requirement: 'required',
    placement: 'var',
    what: 'the Supabase project URL — every read and write goes here',
  },
  NEXT_PUBLIC_SUPABASE_ANON_KEY: {
    requirement: 'required',
    placement: 'var',
    what: 'the browser-side Supabase key; public by design, guarded by RLS',
  },
  SUPABASE_SERVICE_ROLE_KEY: {
    requirement: 'required',
    placement: 'secret',
    what: 'server-side database access — without it every data read fails',
  },
  ALLOWED_EMAILS: {
    // Not a credential, but real addresses: keep it out of a tracked file.
    requirement: 'required',
    placement: 'secret',
    what: 'the operator allowlist — an empty list means nobody can sign in',
  },

  /* -- optional: model provider ------------------------------------------ */
  OPENROUTER_API_KEY: {
    requirement: 'optional',
    placement: 'secret',
    what: 'the default model provider; without a provider key generation fails',
  },
  ANTHROPIC_API_KEY: {
    requirement: 'optional',
    placement: 'secret',
    what: 'the first-party model provider, used when AI_PROVIDER=anthropic',
  },
  AI_PROVIDER: {
    requirement: 'optional',
    placement: 'var',
    what: 'forces a provider; inferred from whichever key is set when unset',
  },
  AI_MODEL_STANDARD: {
    requirement: 'optional',
    placement: 'var',
    what: 'overrides the standard-tier model id',
  },
  AI_MODEL_QUALITY: {
    requirement: 'optional',
    placement: 'var',
    what: 'overrides the high-tier model id',
  },
  ANTHROPIC_MODEL_STANDARD: {
    requirement: 'optional',
    placement: 'var',
    what: 'legacy alias for AI_MODEL_STANDARD, still honoured',
  },
  ANTHROPIC_MODEL_QUALITY: {
    requirement: 'optional',
    placement: 'var',
    what: 'legacy alias for AI_MODEL_QUALITY, still honoured',
  },

  /* -- optional: embeddings ---------------------------------------------- */
  EMBEDDING_PROVIDER: {
    requirement: 'optional',
    placement: 'var',
    what: 'Canon embeddings; defaults to the keyless local embedder',
  },
  EMBEDDING_MODEL: {
    requirement: 'optional',
    placement: 'var',
    what: 'overrides the embedding model id',
  },
  OPENAI_API_KEY: {
    requirement: 'optional',
    placement: 'secret',
    what: 'only needed when EMBEDDING_PROVIDER=openai',
  },

  /* -- optional: ingestion ----------------------------------------------- */
  APIFY_TOKEN: {
    requirement: 'optional',
    placement: 'secret',
    what: 'Instagram scraping; without it monitoring and profile pulls are off',
  },
  APIFY_ACTOR: {
    requirement: 'optional',
    placement: 'var',
    what: 'overrides the scraper actor id',
  },
  APIFY_PROFILES: {
    requirement: 'optional',
    placement: 'var',
    what: 'overrides which handles the monitor pulls',
  },
  APIFY_BUDGET_USD: {
    requirement: 'optional',
    placement: 'var',
    what: 'the scrape spend ceiling; unset means no ceiling',
  },
  IG_HANDLE_PERSONAL: {
    requirement: 'optional',
    placement: 'var',
    what: 'overrides the personal account handle',
  },
  IG_HANDLE_ACADEMY: {
    requirement: 'optional',
    placement: 'var',
    what: 'overrides the academy account handle',
  },
  COMMENTS_TOP_N: {
    requirement: 'optional',
    placement: 'var',
    what: 'how many top posts get their comments pulled',
  },
  COMMENTS_PER_POST: {
    requirement: 'optional',
    placement: 'var',
    what: 'how many comments to pull per post',
  },
  MIRROR_MEDIA: {
    requirement: 'optional',
    placement: 'var',
    what: 'mirrors post media into storage; off unless explicitly enabled',
  },

  /* -- optional: the MCP server ------------------------------------------ */
  MCP_ACCESS_TOKEN: {
    // A bearer token is a credential. It is never echoed (it is absent from
    // ECHOABLE_VALUES below), and no check in this file reports its length,
    // prefix or shape: checkRequiredEnv() is meant to be readable from an
    // UNAUTHENTICATED diagnostic route, so anything it says about this key is
    // said to the public. "Set" or "not bound" is the whole vocabulary.
    requirement: 'optional',
    placement: 'secret',
    what: 'the only credential /api/mcp accepts; unset means the endpoint refuses every call',
  },
  MCP_DAILY_GENERATION_CAP: {
    requirement: 'optional',
    placement: 'var',
    what: 'model-backed generations an MCP caller may trigger per Asia/Amman day; unset uses the conservative built-in default',
  },
};

/**
 * Values that are configuration rather than credentials, and so may be shown
 * back to the operator — a Supabase URL or a model id is worth reading back to
 * confirm you are pointed at the right project.
 *
 * Listed as an allowlist on purpose: anything NOT named here is treated as
 * sensitive and its value is never printed. A credential added to the union
 * later is therefore silent by default, instead of leaking until somebody
 * remembers to classify it.
 */
const ECHOABLE_VALUES: ReadonlySet<EnvKey> = new Set<EnvKey>([
  'NEXT_PUBLIC_SUPABASE_URL',
  'ALLOWED_EMAILS',
  'AI_PROVIDER',
  'AI_MODEL_STANDARD',
  'AI_MODEL_QUALITY',
  'ANTHROPIC_MODEL_STANDARD',
  'ANTHROPIC_MODEL_QUALITY',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_MODEL',
  'APIFY_ACTOR',
  'APIFY_PROFILES',
  'APIFY_BUDGET_USD',
  'IG_HANDLE_PERSONAL',
  'IG_HANDLE_ACADEMY',
  'COMMENTS_TOP_N',
  'COMMENTS_PER_POST',
  'MIRROR_MEDIA',
  // The cap is a policy number an operator needs to read back. The token it
  // sits beside is deliberately NOT here.
  'MCP_DAILY_GENERATION_CAP',
]);

/** False for every credential. Never show a value this returns false for. */
export function isEchoableEnv(key: EnvKey): boolean {
  return ECHOABLE_VALUES.has(key);
}

/** Sound because ENV_SPECS is a total Record over EnvKey. No cast needed. */
function isEnvKey(key: string): key is EnvKey {
  return Object.prototype.hasOwnProperty.call(ENV_SPECS, key);
}

/** Every EnvKey, in the declaration order above. */
export function envKeys(): EnvKey[] {
  return Object.keys(ENV_SPECS).filter(isEnvKey);
}

/**
 * The fix for an unbound key, naming the binding. Contains no value.
 * e.g. "SUPABASE_SERVICE_ROLE_KEY is not bound — add it with: wrangler secret
 * put SUPABASE_SERVICE_ROLE_KEY"
 */
export function envBindingHint(key: EnvKey): string {
  return ENV_SPECS[key].placement === 'secret'
    ? `${key} is not bound — add it with: wrangler secret put ${key}`
    : `${key} is not bound — add it to "vars" in wrangler.jsonc, then redeploy`;
}

/**
 * Bound, but to an empty or whitespace-only value. A genuinely different
 * failure from "not bound": `wrangler secret list` shows the secret present, so
 * being told it is missing sends you hunting for the wrong thing. It is also
 * the state this repo's own .env.local ships in for the model keys, which are
 * empty placeholders.
 */
function envBlankHint(key: EnvKey): string {
  return ENV_SPECS[key].placement === 'secret'
    ? `${key} is bound but empty — re-set it with: wrangler secret put ${key}`
    : `${key} is bound but empty — give it a value in "vars" in wrangler.jsonc, then redeploy`;
}

/** Bound (Worker `env` or process.env) but trims to nothing. `optionalEnv` reads it as absent. */
function isBlank(key: EnvKey): boolean {
  const raw = rawEnv(key);
  return raw !== undefined && raw.trim().length === 0;
}

/**
 * Checks where "non-blank" is not the same as "usable". Returns a description
 * of the problem, or null when there is nothing wrong. Never returns a value.
 *
 * Both cases here are real traps: an ALLOWED_EMAILS that parses to nobody locks
 * the operator out of an app that looks correctly configured, and a Supabase
 * URL pasted without its scheme fails at the first fetch rather than at boot.
 */
function usabilityProblem(key: EnvKey): string | null {
  if (key === 'ALLOWED_EMAILS') {
    return allowedEmails().length === 0
      ? 'set, but no entry contains "@" — the allowlist parses to nobody, so no one can sign in'
      : null;
  }

  if (key === 'MCP_DAILY_GENERATION_CAP') {
    // Set-but-unparseable is the trap here, and it is a quiet one:
    // `positiveIntEnv` falls back to its default, so a cap typed as "20 " with
    // a stray character, as "20.5", or as "-1" silently becomes the built-in
    // number and the operator believes a ceiling is in force that is not the
    // one they wrote. Absence is fine and is reported separately; this branch
    // only judges a present value.
    const raw = optionalEnv(key);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0
      ? null
      : 'set, but is not a positive whole number — the built-in default is being used instead of the value you wrote';
  }

  if (key === 'NEXT_PUBLIC_SUPABASE_URL') {
    const raw = optionalEnv(key);
    // Absence is reported separately; this branch only judges a present value.
    if (raw === null) return null;
    try {
      const { protocol } = new URL(raw);
      return protocol === 'https:' || protocol === 'http:'
        ? null
        : 'set, but is not an http(s) URL';
    } catch {
      return 'set, but is not a parseable URL — a missing "https://" is the usual cause';
    }
  }

  return null;
}

export interface EnvStatus {
  readonly key: EnvKey;
  readonly requirement: EnvRequirement;
  readonly placement: EnvPlacement;
  readonly what: string;
  /** Present and non-blank. Says nothing about the value beyond that. */
  readonly set: boolean;
  /** Bound to an empty value — distinct from absent, and fixed differently. */
  readonly blank: boolean;
  /** Set but unusable. null when there is nothing wrong. */
  readonly problem: string | null;
  /** Ready to use: set, and with no problem. */
  readonly ok: boolean;
  /** One operator-facing line: the problem, or how to bind it. No value. */
  readonly detail: string;
}

export function envStatus(key: EnvKey): EnvStatus {
  const spec = ENV_SPECS[key];
  const set = hasEnv(key);
  const blank = !set && isBlank(key);
  const problem = set ? usabilityProblem(key) : null;

  function detail(): string {
    if (!set) return blank ? envBlankHint(key) : envBindingHint(key);
    return problem === null ? `${key} is set` : `${key} is ${problem}`;
  }

  return {
    key,
    requirement: spec.requirement,
    placement: spec.placement,
    what: spec.what,
    set,
    blank,
    problem,
    ok: set && problem === null,
    detail: detail(),
  };
}

export interface EnvReport {
  /** True when every REQUIRED key is bound and usable. Optional keys never
   *  affect this — a degraded app is still a working app. */
  readonly ok: boolean;
  readonly required: EnvStatus[];
  readonly optional: EnvStatus[];
  /** Exactly the required keys that must be fixed: absent OR set-but-unusable. */
  readonly missing: EnvKey[];
  /** Optional keys that are absent. Features are off; the app still runs. */
  readonly degraded: EnvKey[];
  /** Operator-facing summary naming every missing binding. null when ok. */
  readonly message: string | null;
}

/**
 * The startup assertion. Never throws, never echoes a value, and reports
 * exactly which bindings are wrong and how to fix each one.
 *
 * Intended caller is an unauthenticated diagnostic route: if ALLOWED_EMAILS or
 * the Supabase keys are the thing that is broken, nobody can sign in, so a
 * check that sits behind the operator gate cannot report the failure it exists
 * to report.
 */
export function checkRequiredEnv(): EnvReport {
  const all = envKeys().map(envStatus);
  const required = all.filter((s) => s.requirement === 'required');
  const optional = all.filter((s) => s.requirement === 'optional');
  const broken = required.filter((s) => !s.ok);
  const count = broken.length;

  return {
    ok: count === 0,
    required,
    optional,
    missing: broken.map((s) => s.key),
    degraded: optional.filter((s) => !s.set).map((s) => s.key),
    message:
      count === 0
        ? null
        : [
            `${count} required environment binding${count === 1 ? '' : 's'} ` +
              `${count === 1 ? 'is' : 'are'} missing or unusable on this deployment:`,
            ...broken.map((s) => `  - ${s.detail}`),
          ].join('\n'),
  };
}
