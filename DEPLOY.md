# DEPLOY

Target: **Cloudflare Workers, Paid plan**, through `@opennextjs/cloudflare`.

Two files carry the runtime settings: `wrangler.jsonc` and `open-next.config.ts`.
This runbook tells you how to drive them. It does not tell you to improvise them.

Two things that are never right here, whatever a blog post says:

- **`@cloudflare/next-on-pages` is deprecated.** Do not install it. OpenNext is the adapter.
- **Never add `export const runtime = 'edge'`.** The codebase has zero `runtime`
  declarations and that is correct — OpenNext keeps Node.js route handlers by default.
  Adding one takes a working route and breaks it.

Deploying is not rehearsing. If it is demo day, read `DEMO.md` and deploy the day before.

---

## 1. ONE-TIME SETUP

```
npx wrangler login
```

A browser opens and asks you to authorize Wrangler. Approve it on the account that
holds the **Workers Paid** subscription. A Free-plan account will accept the deploy
and then quietly ignore the raised CPU limit, which fails later and looks like a
code bug.

Confirm where you landed before you do anything else:

```
npx wrangler whoami
```

That account is the only account this project needs. **You do not need a zone.**
The first deploy publishes to `<worker-name>.<your-subdomain>.workers.dev`, and that
hostname is what goes into Supabase in section 4. A custom domain is optional, needs
a zone on the same account, and if you add one you must redo section 4 with the new
hostname or sign-in breaks on it.

---

## 2. SECRETS

A value lives in one of two places, and they are not interchangeable:

| Placement | How you set it | In git? |
|---|---|---|
| **secret** | `npx wrangler secret put NAME` — prompts, stores write-only | Never |
| **var** | a `vars` entry in `wrangler.jsonc` | Yes — that file is tracked |

The rule: if leaking it costs money or data, it is a secret. `src/lib/env.ts` already
classifies every key, and `envBindingHint()` prints the correct command for any key at
runtime — the table below is the same classification, written out.

### `wrangler secret put` is MANDATORY. It was never optional; it only looked optional.

Every key marked **secret** below has to be bound on the Worker with
`npx wrangler secret put NAME`. Not "should be". The deployment has no other source for
those values.

**Read this even if a past deploy worked without doing it — especially then.**

The adapter compiles `.env*` files into the build output
(`.open-next/cloudflare/next-env.mjs`). Before the build was sanitised, that meant a build
run on a machine with a populated `.env.local` **baked the server secrets into the artifact
that gets uploaded** — the service-role key and the Apify token among them, confirmed by
grepping the `wrangler deploy --dry-run` output.

That is why the missing step never announced itself. A deploy with **no secrets bound at
all** appeared to work perfectly, because the baked copy was quietly answering every
`process.env` read. The consequences of relying on it, all of which arrive later and none
of which look like a configuration problem:

- **The service-role key shipped inside the bundle.** It bypasses RLS — unrestricted read
  and write on the whole database — sitting in a deployable artifact instead of in
  write-only secret storage.
- **Rotating a key did nothing.** `wrangler secret put` on a key that was never read
  changes no behaviour, so the old baked value kept working and the rotation looked
  applied when it was not.
- **The build machine's `.env.local` became production config by accident.** Whoever built
  last decided what the deployment used.

`scripts/cf-build.mjs` is the fix, and `npm run cf:build` is `node scripts/cf-build.mjs`.
Its contract, as read from the script:

- While the adapter runs, `.env.local` holds **only** its `NEXT_PUBLIC_*` entries — the
  ones that are meant to be inlined into the client bundle — and the same non-public keys
  are removed from the child process's environment. The real file is copied aside first
  and restored afterwards, on success, failure, or Ctrl-C.
- After the adapter build it bundles with `wrangler deploy --dry-run` (no upload) and
  searches both `.open-next/` and that bundle for the literal value of every non-public
  key in `.env.local`. Any hit **deletes `.open-next/` and exits non-zero** — no artifact
  to deploy. Key names are printed, never values.
- It refuses to start if any other adapter-read env file exists (`.env`, `.env.production`,
  `.env.development`, `.env.test`, or their `.local` variants), because it sanitises
  `.env.local` only and cannot vouch for the others.
- If a build is killed outright (SIGKILL, power cut, closing the terminal window), the
  restore cannot run: `.env.local` is left in its sanitised state and the real contents
  are in `.env.cf-build-backup.local` beside it. The next `npm run cf:build` restores it
  automatically at startup; renaming the backup back by hand also works. Both that file
  and `.env.cf-build-lock.local` match the `.env*.local` ignore rule (`.gitignore` line
  10; verified with `git check-ignore -v`).
- Its scan is a net, not a proof: values shorter than 12 characters are not searched
  (they are listed by name instead), and values already committed in the project's own
  source are excused from the leak test but printed as a warning naming the file.

A build that passes has been checked; a build that fails has told you something true and
must not be worked around by calling the adapter directly.

> **Verification status, stated plainly:** as of 2026-08-15 the script exists in the
> working tree (untracked, not yet committed) and `package.json` defines `cf:build` as
> `node scripts/cf-build.mjs`. The contract above was read from the script's source and
> then observed once, on this machine, on 2026-08-15: `npm run cf:build` exited 0, restored
> `.env.local`, and its scan reported `PASS` with `clean: ALLOWED_EMAILS`, `clean:
> APIFY_TOKEN`, `clean: SUPABASE_SERVICE_ROLE_KEY` after searching 1558 files across
> `.open-next` and the `wrangler --dry-run` bundle; the baked
> `.open-next/cloudflare/next-env.mjs` it produced names only `NEXT_PUBLIC_SUPABASE_URL`
> and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. That is one run, not a guarantee. Confirm it
> yourself before you trust a build to be clean: `git status` shows the file, and
> `npm run cf:build` prints `cf-build — secret-safe Cloudflare Workers build` as its first
> line and, under `--- artifact secret scan ---`, a `PASS` or `FAIL` line followed by the
> keys it checked. If it says the build is **UNVERIFIED** instead, nothing in `.env.local`
> was long enough (or absent enough from source) to search for — that is not a pass.

Once secrets are genuinely absent from the artifact, an unbound secret stops being
invisible and starts being a plain runtime failure — a 500 from whichever route needed it,
with `envBindingHint()` naming the exact command. That is the intended behaviour. Bind
them.

**`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. It is unrestricted read and write on the
entire database.** It is a secret, always. Never a `var`, never in a tracked file,
never in a client bundle, never pasted into a chat or an issue. If it is ever exposed,
rotate it in the Supabase dashboard and re-put it here; nothing else undoes it.

### `NEXT_PUBLIC_*` is a different animal, and it bites

Both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are **public by
design** — the anon key is meant to reach the browser, and RLS (deny-all here) is what
guards it. That is not the trap. The trap is that they are needed in **two** places:

1. **At build time**, on the machine that runs the build. `src/lib/supabase/browser.ts`
   is a `'use client'` module and reads `process.env.NEXT_PUBLIC_SUPABASE_URL` as a
   literal property, so Next inlines the value into the client bundle. If it is missing
   from `.env.local` when you build, the bundle ships `undefined` and the sign-in
   handshake throws in the browser. **Binding it on the Worker afterwards does not fix
   an already-built bundle. You have to rebuild.**
2. **At runtime**, as a Worker binding. `src/lib/env.ts` reads every key through
   `process.env[key]` — a dynamic index Next never inlines — so the server routes and
   `src/middleware.ts` need the live binding as well.

Set them in both places, to identical values.

**Their inlining is correct and must not be "fixed".** `NEXT_PUBLIC_*` values are compiled
into the **client** bundle and are therefore readable by anyone who opens the deployed
site. That is the contract of the prefix, not an oversight: the anon key is *designed* to
reach the browser, and RLS — deny-all on this project — is what actually guards the data.
So when a scan turns up `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`
sitting in the shipped JavaScript, that is the system working. It is not a leak, it is not
a finding, and stripping it breaks sign-in.

The distinction that matters: **the prefix is the whole boundary.** A value with it is
public; a value without it must never appear in the client bundle. `SUPABASE_SERVICE_ROLE_KEY`
is the same kind of string from the same dashboard page and is the exact opposite case —
see the mandatory-secrets block above. Never add a `NEXT_PUBLIC_` prefix to a key to make
a build error go away.

### REQUIRED — four keys. Without these the app cannot reach its database or let anyone in.

| Key | Placement | Where the value comes from |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | var **+ build env** | Supabase dashboard → the project → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | var **+ build env** | Same page — the anon / public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | Same page — the `service_role` key, behind the reveal control |
| `ALLOWED_EMAILS` | **secret** | You choose. Comma-separated addresses |

```
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put ALLOWED_EMAILS
```

The two `NEXT_PUBLIC_` values belong in `vars` in `wrangler.jsonc` — public by design,
and a tracked file is the honest home for them. If you would rather keep them out of git
entirely, `npx wrangler secret put NEXT_PUBLIC_SUPABASE_URL` works too: a secret binding
lands on `process.env` exactly like a var does. The build-time copy in `.env.local` is
required either way.

`ALLOWED_EMAILS` is not a credential, but it is real addresses, so it is a secret here.
Watch the shape: an entry with no `@` is dropped, and a list that parses to nobody locks
you out of an app that otherwise looks perfectly configured.

### OPTIONAL — absent means a feature is off, not that the app is broken

Degraded is not broken. Every key below has a documented fallback, and the app is built
to be honest about what it cannot do rather than to fake it.

**Model provider** — without one of these, generation fails. Everything that reads stored
data still works.

| Key | Placement | Where the value comes from |
|---|---|---|
| `OPENROUTER_API_KEY` | **secret** | openrouter.ai/keys — the default path, one key for every vendor |
| `ANTHROPIC_API_KEY` | **secret** | console.anthropic.com — only used when `AI_PROVIDER=anthropic`, or when the OpenRouter key is blank |
| `AI_PROVIDER` | var | You set it: `openrouter` or `anthropic`. Unset = inferred from whichever key is present |
| `AI_MODEL_STANDARD` | var | A model id — see `.env.example` for the current defaults |
| `AI_MODEL_QUALITY` | var | A model id for the high tier |
| `ANTHROPIC_MODEL_STANDARD` | var | Legacy alias for `AI_MODEL_STANDARD`, still honoured |
| `ANTHROPIC_MODEL_QUALITY` | var | Legacy alias for `AI_MODEL_QUALITY`, still honoured |

```
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

Do not pick the model ids by inheriting whatever a commit set. `npm run bakeoff` exists
so a human reads the blind Arabic and chooses. See `HANDOFF.md` §9.

**Embeddings** — the default embedder is local, 384-dim, keyless. Canon retrieval is
provable with no key at all, which is the point. Only set these to move off it.

| Key | Placement | Where the value comes from |
|---|---|---|
| `EMBEDDING_PROVIDER` | var | `local` (default) or `openai` |
| `EMBEDDING_MODEL` | var | An embedding model id |
| `OPENAI_API_KEY` | **secret** | platform.openai.com → API keys. Needed **only** when `EMBEDDING_PROVIDER=openai` |

```
npx wrangler secret put OPENAI_API_KEY
```

**Ingestion** — without `APIFY_TOKEN`, monitoring and profile pulls are off. Nothing else
changes.

| Key | Placement | Where the value comes from |
|---|---|---|
| `APIFY_TOKEN` | **secret** | apify.com → Settings → Integrations |
| `APIFY_ACTOR` | var | Overrides the scraper actor id |
| `APIFY_PROFILES` | var | Overrides which handles the monitor pulls |
| `APIFY_BUDGET_USD` | var | You choose the ceiling, in USD |
| `IG_HANDLE_PERSONAL` | var | The personal handle, exactly as Instagram spells it |
| `IG_HANDLE_ACADEMY` | var | The academy handle, exactly as Instagram spells it |
| `COMMENTS_TOP_N` | var | How many top posts get their comments pulled |
| `COMMENTS_PER_POST` | var | How many comments per post |
| `MIRROR_MEDIA` | var | `true` mirrors post media into storage. Off unless explicitly enabled |

```
npx wrangler secret put APIFY_TOKEN
```

Two of these deserve a second look before you deploy:

- **`APIFY_BUDGET_USD` blank is not a ceiling, it is no ceiling.** Every scrape whose
  cost can be estimated is waved through. Set a real number.
- **`IG_HANDLE_PERSONAL` / `IG_HANDLE_ACADEMY` must match the handles the stored posts
  actually came from.** A mismatch means the monitor is watching nobody, silently.

### Confirm what is bound

```
npx wrangler secret list
```

Names only, never values — which is exactly what it is for. It proves a binding exists.
It cannot prove the value behind it is the right one.

`npx wrangler secret delete NAME` removes one. `npx wrangler secret bulk <file>` sets many
from a JSON file in one call — convenient, and the file it reads holds every real value in
plaintext, so put it outside the repo, or under an ignore rule you have verified with
`git check-ignore`, and delete it when you are done.

---

## 3. LOCAL SECRETS — `.dev.vars`

`wrangler dev` and `opennextjs-cloudflare preview` do not read `.env.local`. They read
**`.dev.vars`**, one `KEY=value` per line, no quotes needed:

```
SUPABASE_SERVICE_ROLE_KEY=...
ALLOWED_EMAILS=...
OPENROUTER_API_KEY=...
APIFY_TOKEN=...
```

**Before you create it, prove it is ignored:**

```
git check-ignore -v .dev.vars
```

That must print a matching rule. As of 2026-08-15 it does — `.gitignore` lines 13–14 are
`.dev.vars` and `.dev.vars*`. If it ever prints nothing, `.dev.vars` is **not** ignored —
restore those rules first, then create the file. Nothing that can hold a key gets written
outside an ignore rule, ever. `.env.local` is already ignored (line 10, `.env*.local`) and
stays that way.

Keep `.env.local` too. It is what `npm run dev`, `npm run doctor`, `npm run login`,
`npm run seed` and every other script read. `.dev.vars` is only for the Workers runtime.
Two files, two runtimes, same values.

While you are there, `.open-next/` and `.wrangler/` are build and local-state output and
are ignored the same way (`.gitignore` lines 20–21). Confirm with `git check-ignore -v
.open-next .wrangler` before your first build.

---

## 4. THE SUPABASE STEP EVERYONE MISSES

Do this **before** you try to sign in to the deployed app, or you will spend an hour
debugging code that is fine.

Supabase dashboard → **Authentication → URL Configuration**:

1. **Site URL** — set to your deployed origin, e.g. `https://<worker>.<subdomain>.workers.dev`
   (no trailing slash).
2. **Redirect URLs** — add **both** of these:
   - `https://<worker>.<subdomain>.workers.dev/auth/callback`
   - `http://localhost:3000/auth/callback`

Why `/auth/callback` specifically: `src/app/api/auth/otp/route.ts` computes
`emailRedirectTo` as `${origin}/auth/callback` from the incoming request. Supabase will
only honour a redirect target that is on this allowlist. If the deployed origin is not
listed, Supabase silently falls back to the **Site URL** — so if Site URL is still
`http://localhost:3000` from local development, every magic link you click on the
deployed app lands on a dead localhost tab. Nothing errors. No log line. Sign-in simply
never completes, and the app looks broken in a way the code cannot explain.

Why keep the localhost entry: `npm run login` mints a link with a hardcoded
`http://localhost:${PORT}/auth/callback` redirect. It still works against this same
Supabase project after you deploy — it is your local sign-in and it is deliberately a
local script, not an HTTP endpoint, because a route that hands out sign-in links is a
complete auth bypass. Adding the production domain must not mean deleting localhost.

Add the custom domain to both fields as well, if you add one later.

---

## 5. DEPLOY

**Delete any pre-existing build output first.** `.open-next/` is not just stale artifacts:
a directory produced by any build made *before* the sanitising wrapper landed can contain
real server secrets compiled into `.open-next/cloudflare/next-env.mjs`. Deploying on top of
one re-uploads them, and a clean build afterwards will not tell you it happened.

```
rm -rf .open-next
npx tsc --noEmit
npm test
npm run cf:build
npx opennextjs-cloudflare deploy
```

`.open-next/` is git-ignored, so nothing was ever committed — but it is still sitting on
the build machine, unencrypted, for as long as you leave it there. Remove it once as
hygiene even if you are not deploying today. Same for any CI cache that persists it
between runs.

Both gates first. A build that typechecks on your machine and a build that runs on
workerd are different claims, but shipping over a red gate makes the second one
impossible to diagnose.

**Build through `npm run cf:build`, not `npx opennextjs-cloudflare build`.** The npm script
is `node scripts/cf-build.mjs`; invoking the adapter directly walks straight past the
sanitiser and its leak check, which is exactly the failure mode section 2 exists to
prevent. (As noted there: the wrapper is in the working tree but was not yet committed when
this was written — check `git status` and `package.json` before relying on it.)

The build runs `next build` and then adapts the output for Workers — this is the step that
inlines the `NEXT_PUBLIC_*` values from `.env.local`, so run it with `.env.local` in place.
Those two values are *meant* to be inlined; nothing else is. `deploy` uploads the result
and publishes it.

A build that fails on a detected leak has not been unlucky. Read what it names, remove that
value from the build environment, and build again — do not route around it. Note that the
wrapper already deletes `.open-next/` on a failed scan; the `rm -rf` above is for output
left by builds that predate it.

To exercise it on the real runtime before it is public:

```
npx opennextjs-cloudflare preview
```

That runs the adapted build on workerd locally, reading `.dev.vars`. It is the only local
thing that tells you anything true about Workers behaviour. `npm run dev` is Node — a
route can pass there and fail on workerd.

**One bound on how true, and it is worth knowing before you trust a green preview.**
Preview is `wrangler dev`, which runs the workerd binary in `node_modules` — currently
**1.20260811.1**, pinned to that exact version by miniflare and wrangler (`npm ls workerd`);
it is not a dependency you can bump on its own. `wrangler.jsonc` requests **2026-08-14**.
The npm wrapper for that binary advertises a `compatibilityDate` of 2026-08-11, but the
binary itself accepts later dates: run directly, it loads a 2026-08-14 worker with no date
complaint, and reports its real ceiling only when asked for something past it —
`This Worker requires compatibility date "2026-09-01", but the newest date supported by
this server binary is "2026-08-18".` (observed 2026-08-15). So today preview and production
run the **same** date, and a green preview means what it says about date-gated behaviour.

If `compatibility_date` is ever moved past the local binary's ceiling, preview does **not**
quietly fall back to an older date and warn — workerd rejects the config with that error and
does not serve; miniflare and workerd both also refuse any date after today's UTC date. The
fix is to update `wrangler` (which brings its pinned miniflare and workerd along). Do not
close a gap by lowering `compatibility_date` — that moves production backwards to satisfy a
local binary. The full reasoning is in the comment above `compatibility_date` in
`wrangler.jsonc`.

Watch a deployed request live:

```
npx wrangler tail
```

### ROLLBACK

List what is deployed, then roll back:

```
npx wrangler deployments list
npx wrangler rollback [version-id]
```

`deployments list` shows the **10 most recent** deployments; `npx wrangler versions list`
shows the 10 most recent versions, and `npx wrangler versions view <version-id>` gives you
the detail on one. `rollback` with no argument targets the previous version and prompts
for confirmation — pass a version id to go further back, and `-m "why"` to leave a reason
on the record. It re-points the Worker at code that was already uploaded, so it is fast
and does not rebuild.

Two things a rollback does **not** undo, and you must handle yourself:

- **A secret you overwrote.** `wrangler secret put` replaces the value; the old one is
  gone. Have the source (Supabase dashboard, OpenRouter, Apify) at hand before you rotate
  anything.
- **A Supabase migration.** Migrations here are additive-only by rule, so a rollback of
  the Worker leaves an additive schema in place and the older code ignores the new
  columns. That is the design working. Do not "roll back" a migration to match.

The guaranteed rollback, when `wrangler rollback` cannot get you where you need to be:
check out the last known-good commit, build, deploy. It is slower and it always works.

---

## 6. VERIFY AFTER DEPLOY

In this order. Each step assumes the one above passed.

1. **The site answers.** Open the deployed URL. You should be bounced to `/login`
   (`src/middleware.ts` does this for any unauthenticated non-public path). A 500 here,
   before any sign-in, is almost always a missing binding — go to `npx wrangler tail` and
   read the actual error rather than guessing.

2. **Sign in.** Enter an address from `ALLOWED_EMAILS` and complete the code. If the link
   or code bounces to localhost, section 4 is not done. If you are told the address is not
   on the allowlist, `ALLOWED_EMAILS` on the Worker is wrong or parsed to nobody —
   `wrangler secret list` will show it bound and tell you nothing about its contents,
   which is the point at which you re-put it.

3. **`/dashboard` renders real numbers.** Personal averages **508** per post, academy
   **40**, over 320 stored rows. Those are the numbers to look for. Em-dashes where you
   expect figures mean a read failed or the value genuinely is not in the data — followers
   read as an em-dash until a profile scrape has run, and that is correct behaviour, not a
   bug. Zeros where you expect figures mean something is wrong; this app does not render 0
   for absent.

4. **`/data` shows the cost estimate.** Open it and confirm a scrape action displays its
   USD estimate and its budget state before you can run it. An em-dash in the estimate
   means "not priced", never "free" — and an unpriceable run is blocked either way. This
   is rule 9 on screen: estimate before spend.

5. **Bindings, from inside the deployment.** Sign in and open **`/settings`** — its badges
   are served by `/api/health`, which reports each required key as present or missing,
   names the resolved provider and models, and probes the database with the service-role
   key. That is the deployed equivalent of `npm run doctor`, and it is the only check that
   reads the Worker's own `process.env`.

   Two honest limits on it. It is operator-gated, so if the Supabase keys or
   `ALLOWED_EMAILS` are what is broken you cannot reach it — in that state use
   `wrangler secret list` plus `wrangler tail`. And `/api/health` does its own
   key-by-key checks rather than calling `checkRequiredEnv()` in `src/lib/env.ts`;
   that function was written for an unauthenticated diagnostic route which does not
   exist yet, so on the deployed Worker nothing calls it. Its only caller today is
   `npm run doctor`, which runs on your machine — see the limit directly below.

   **`npm run doctor` on your machine reads `.env.local`. It knows nothing about what is
   bound on the Worker.** A green doctor locally proves your laptop is configured. It
   proves nothing at all about the deployment.

6. **Hydration.** Section 7. Do this before you show anyone.

---

## 7. KNOWN ISSUE — OpenNext #1321

**Next 15.5 + React 19 + `@supabase/ssr` on Workers produces a React hydration mismatch —
error #418 — on roughly 9% of page loads. The same build under `next start` shows 0%.**
The issue was opened 2026-08-02 and has had no maintainer response as of this writing.

This app is the worst shape for it: Ant Design v5 server-rendered through
`@ant-design/nextjs-registry`, which is about as hydration-sensitive as a React app gets.
It cannot be fixed in this codebase. It can be detected, and it must be, before an
audience sees it.

### How to detect it

1. Open the deployed app with the browser console open.
2. **Hard-reload ten to fifteen times**, on a page that matters — `/dashboard` and
   `/compliance` are the two the demo lives on.
3. Watch for **React error #418** (`Minified React error #418`, hydration text mismatch).
   A hard reload is required; a soft navigation re-uses the client bundle and will not
   reproduce it.

Ten to fifteen reloads at a ~9% rate is a coin-flip on whether you see it — one
appearance is a confirmation, zero appearances is not a clearance. Repeat the sweep after
any deploy that changes a page.

### If it appears

- **It is intermittent and it is cosmetic-to-fatal depending on the page.** Reload and it
  is usually gone. That is not a fix; it is a coin flip you do not control in front of a
  room.
- **The fallback is Vercel or a Node container.** Both run this app unmodified — there is
  no `runtime = 'edge'` and nothing here is Workers-specific in `src/`. Moving is a
  redeploy, not a rewrite. Redo section 4 with the new hostname if you do.
- **The demo has a backup either way.** `DEMO.md` says record one clean run to local
  storage before any live demo, and lists the failure drills. A recorded run is immune to
  this bug. In a hostile room the recording is already the default and the live run is the
  encore.

Do not treat a clean sweep as proof the bug is not there. Treat it as "not observed today".

---

## 8. WHAT WORKERS CHANGES ABOUT THE RUNTIME

Read this once. It explains failures that otherwise look like code bugs.

**`maxDuration` exports are inert.** Nine route files still export one. It is a Vercel
construct and nothing on Workers reads it. Leaving them costs nothing and they document
intent, but do not tune one expecting an effect.

**CPU time is the real bound, and it is not wall clock.** Workers meter CPU, so time spent
waiting on Supabase, OpenRouter or Apify does not count against you — a route can wait on
a slow model for a long time and burn almost no CPU. What counts is parsing, mapping,
`JSON.stringify` over a large payload, and rendering. **The Paid default is 30s, which is
not enough for this app's long routes; `wrangler.jsonc` raises it to 300000 ms.** Do not
lower it, and check it is still there after anyone edits that file.

**The isolate has 128 MB, hard, shared across concurrent requests in it.** Exceeding it is
Error 1102: the isolate is discarded and the failure is uncatchable — no `try`/`catch`
runs, no error handler fires, nothing is logged from inside. If a route dies with no
diagnostics at all, suspect memory before you suspect logic. Ingestion and monitor routes,
which hold a whole scrape payload in memory, are where this lands.

**Placement is pinned to `aws:eu-central-1`, on purpose.** Supabase is in EU-Central
(Frankfurt) and this app is database-bound on every route — each one is `force-dynamic`.
Unpinned, Cloudflare runs the Worker near the request, which for an operator in Amman puts
every single Supabase call on a transcontinental round trip, repeatedly, per page. The pin
costs the first byte a little and saves everything after it. Do not remove it to "reduce
latency".

**`global_fetch_strictly_public` is required** and is set in `wrangler.jsonc`.

**Node APIs work, and must stay that way.** OpenNext runs route handlers in Node
compatibility mode. `src/app/api/ingest/route.ts` already uses Web `request.formData()`,
which is Workers-safe, and nothing in `src/` streams to the browser. Keep both true.
