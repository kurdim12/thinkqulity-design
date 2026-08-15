/**
 * Cloudflare Workers binding reader — the ONLY module in `src/` that imports
 * the OpenNext adapter. Kept separate from `env.ts` so the plain-Node paths
 * (`next dev`, `next start`, `node --test`, `scripts/*`) carry exactly one
 * extra import, and so the adapter dependency is visible in one place.
 *
 * WHY A STATIC IMPORT IS SAFE OUTSIDE WORKERS
 * `@opennextjs/cloudflare`'s public entry (dist/api/index.js) has no
 * module-scope side effects: `cloudflare-context.js` only defines functions,
 * and its `wrangler` / `node:module` imports are dynamic and sit inside
 * `initOpenNextCloudflareForDev`, which nothing here calls. The package is a
 * devDependency, present wherever `next build` runs (the adapter CLI is what
 * builds this app), and Next bundles it into the server output. Under
 * `next dev` / `next start` the import resolves and does nothing.
 *
 * WHY THE SYNC FORM
 * `getCloudflareContext()` (no options) reads
 * `globalThis[Symbol.for("__cloudflare-context__")]`, which the adapter's
 * worker entry defines as a getter over an AsyncLocalStorage store that
 * `runWithCloudflareRequestContext` populates for the whole request — the
 * middleware, every route handler, and every server-component render included.
 * So inside any request on Workers the sync form returns `{ env, ctx, cf }`.
 * `optionalEnv` is synchronous and has many callers; the async form is not
 * needed and would force every caller async.
 *
 * WHERE THE SYNC FORM IS NOT AVAILABLE — every case is caught below and yields
 * `undefined`, so `env.ts` falls through to `process.env`:
 *   - `next dev` / `next start` without `initOpenNextCloudflareForDev()` in
 *     next.config.ts (this project deliberately does not call it — that would
 *     spin up wrangler's platform proxy under plain dev): the adapter throws
 *     its "called without having called initOpenNextCloudflareForDev" error.
 *   - Static generation (SSG): the adapter throws its "sync mode in a static
 *     route" error. Irrelevant here — every route in this app is dynamic — but
 *     handled the same way.
 *   - Module scope on Workers, or any code outside the request's ALS scope: the
 *     getter returns `undefined` and the adapter throws. Nothing in `env.ts`
 *     runs at module scope, and its doc-comment already says not to.
 */
import { getCloudflareContext } from '@opennextjs/cloudflare';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The string binding `key` on the current request's Worker `env`, or
 * `undefined` when there is no Worker context (see the header) or the binding
 * is absent / not a string (KV, R2, ASSETS and other non-text bindings are
 * skipped by design; those are read via `getCloudflareContext().env` directly
 * by whoever needs them).
 *
 * Never throws. Never logs. Returns the raw value untrimmed — `env.ts` owns
 * the "blank counts as unset" rule so that both sources are judged alike.
 */
export function workerBinding(key: string): string | undefined {
  let context: unknown;
  try {
    context = getCloudflareContext();
  } catch {
    return undefined;
  }
  if (!isRecord(context)) return undefined;
  const bindings: unknown = context.env;
  if (!isRecord(bindings)) return undefined;
  const value: unknown = bindings[key];
  return typeof value === 'string' ? value : undefined;
}
