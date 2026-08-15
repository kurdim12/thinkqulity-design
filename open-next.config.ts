/**
 * OpenNext configuration for Cloudflare Workers.
 *
 * This is the adapter's own default template
 * (`node_modules/@opennextjs/cloudflare/templates/open-next.config.ts`) in the
 * shape its `migrate` command produces when caching is NOT set up — see
 * `dist/cli/utils/create-open-next-config.js`, which comments out exactly these
 * two lines via its `commentOutR2ImportRule` / `commentOutIncrementalCacheRule`.
 *
 * Why caching is off here rather than merely unconfigured: `incrementalCache`
 * backs ISR/SSG output, and this app produces none. `next build` renders all 44
 * entries in its route table as `ƒ (Dynamic)` — zero static, zero SSG. Of the 43
 * route and page modules under `src/app`, 30 declare `export const dynamic =
 * 'force-dynamic'` outright and the remaining 13 page.tsx inherit dynamism from
 * the cookie-reading `(app)` layout; `export const revalidate` appears nowhere
 * in the tree. An R2 incremental cache would therefore be a bucket that is
 * written to never, plus a bucket that has to exist before `deploy` will
 * succeed.
 *
 * If ISR is ever introduced, uncomment both lines below, restore the
 * `r2_buckets` and `WORKER_SELF_REFERENCE` service blocks in wrangler.jsonc
 * (both are described there), and create the bucket first.
 * See https://opennext.js.org/cloudflare/caching
 */
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
// import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";

export default defineCloudflareConfig({
  // For best results consider enabling R2 caching
  // See https://opennext.js.org/cloudflare/caching for more details
  // incrementalCache: r2IncrementalCache
});
