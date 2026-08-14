# ThinkQuality Studio — Handoff Prompt

Copy everything below the line into a fresh session to continue this build.

---

You are continuing **ThinkQuality Studio**, an existing, working codebase. Read this
whole brief before touching anything. Do not re-architect. Do not rewrite what works.

## 0. Where things are

| | |
|---|---|
| Local repo | `C:\Users\User\Desktop\designer agent\thinkquality-studio` |
| GitHub | `https://github.com/kurdim12/thinkqulity-design` (branch `main`) |
| Parent folder | `C:\Users\User\Desktop\designer agent\` — client source material, **deliberately NOT in the repo** |
| Env file | `.env.local` (gitignored) |
| Supabase | project `thinkquality-studio`, free tier, EU-Central |
| Scraper | Apify `apify/instagram-scraper`, key in `.env.local` |

The repo is a **subfolder** of the working directory on purpose: the client's PDFs,
WhatsApp exports and creative files sit in the parent and must never reach a public
GitHub repo. Keep that boundary. Check `git check-ignore` before adding anything new.

## 1. Client

**Think Quality Academy** — Ahmad Kahtan, Amman, Jordan. Training and soft-skills
academy. Two Instagram accounts:

- **personal** (`@ahmadkahtan_`) — followers **—**, avg engagement **508/post**. The "~84.5K"
  in the brief is not a measurement: it is a `brand.facts` string sourced `seed-2026-06`,
  and `snapshots.stats.followers` is `{personal: null, academy: null}` because the post
  export does not carry follower counts. The Dashboard renders the em-dash rather than
  falling back to the seed string — do not quote 84.5K as a fact. Run the profile scrape
  on `/data` and the number becomes a dated row in `profile_snapshots`.
- **academy** (`@thinkquality_academyy`) — avg engagement **40/post**

His personal voice outperforms the brand account roughly **13×**. That gap is the
product's entire reason to exist and the opening beat of the demo. Top post is
**33,176 engagement** («الموضوع مش نكد»).

Content is Arabic, Levantine/Jordanian register. All generated copy is Arabic.
The UI is bilingual EN/AR with real RTL.

## 2. Stack — locked, do not substitute

- Next.js 15 App Router · React 19 · TypeScript **strict, zero `any`**
- Ant Design v5 + `@ant-design/nextjs-registry` + `@ant-design/v5-patch-for-react-19`
- Supabase — Postgres, Auth (email OTP / magic link), Storage, RLS **deny-all**, pgvector
- `@supabase/ssr` for browser + server clients; a separate service-role admin client
- Model access via **OpenRouter** (OpenAI-compatible), with an Anthropic path behind
  the same provider abstraction
- Zero test dependencies: `node --test --experimental-strip-types`

## 3. Hard rules — these are not negotiable

1. **No publishing, scheduling, or Instagram writes.** No Meta OAuth. Read-only, always.
2. **No fabricated numbers, anywhere** — including UI copy, empty states, and placeholder
   text. Every number traces to a row. Absent values render as an em-dash `—`, never `0`.
3. **Grounded or hypothesis.** Every generated claim carries `grounding: 'data' | 'hypothesis'`.
   If the data does not support it, it is labelled a hypothesis. No exceptions.
4. **Keys are server-side only.** No model key, service-role key, or signed URL may reach
   a client bundle.
5. **Real RTL.** Logical CSS properties only (`margin-inline-start`, never `margin-left`).
   `dir="auto"` on user content. Numbers wrapped in `.tq-num` for LTR isolation.
   `toIsoDate()` guards against Arabic-Indic digits reaching Postgres.
6. **Additive migrations only.** Never drop or rewrite an applied migration.
7. **The Law never calls a model.** Anything in `src/lib/brain/law/` must stay a pure
   function. If a check needs a model, it is not Law — it belongs to the Judge.
8. **Raw is sacred.** Every scrape run stores its complete raw payload before any mapping.
   Fields not surfaced yet are still captured, so they are re-processable without
   re-scraping.
9. **Estimate before spend.** Every scrape computes result-count x actor-rate USD and
   checks it against `APIFY_BUDGET_USD`. Over budget blocks with the number. A rate that
   cannot be verified returns null and also BLOCKS — "estimate before spend" failing its
   own precondition is not a reason to proceed.
10. **Commenters are an audience, not targets.** Comment analysis is aggregate-only.
    `author_handle` is stored for raw fidelity and read by nothing.
11. **Timing claims need timing data.** Posting-time patterns are computed in code from
    `posted_at` x engagement in Asia/Amman. Always show n. Low-n windows are excluded,
    not reported.

Conflict order: these rules → the task at hand → existing code conventions → your judgment
(and note the call in the build record).

## 4. Architecture you must understand before editing

### The Design Brain — three layers, deliberately separated

**Law** (`src/lib/brain/law/`) — pure, dependency-free, deterministic. Uses explicit
`.ts` import extensions (`allowImportingTsExtensions: true`) so Node can strip types
and run the tests with no build step.

- `palette-claims.ts` — extracts hex codes, expands shorthand, rejects any colour not
  in `brand.palette`. `paletteRefs` validates swatch **names**, not hexes.
- `claims-linter.ts` — flags numbers ≥100 or marked with `%` / `×`. Ignores bare small
  numbers and bare years. Arabic-Indic digit aware.
- `register-score.ts` — heuristic profile (Arabic ratio, sentence length, emoji, ellipsis,
  Levantine markers) vs the stored voice examples. Returns a **warning, never a violation** —
  a character-ratio heuristic must not veto a human's writing.
- `structure.ts` — required guideline sections, required storyboard frame fields,
  `TBD_AR = 'سيُحدد لاحقاً'`.
- `index.ts` — `schemaValid`, `runLaw(input): LawReport`.

**Canon** (`src/lib/brain/canon/`) — retrieval only, quoted **verbatim** with a
`canon:<chunk_id>` attribution. Never paraphrased into a prompt.
`embed.ts` is pluggable: `local` (384-dim FNV hash, keyless, the default) or `openai`.
The keyless default exists so retrieval is provable without any API key.
`retrieve.ts` does vector search with a lexical fallback.

**Judge** (`src/lib/brain/judge.ts`) — a model verifier on fresh context with its own
system prompt, always at the `high` quality tier. Critically:

```ts
export function reconcile(verdict: JudgeVerdict, lawReport: LawReport): JudgeVerdict
```

Law violations the Judge tried to pass are re-added and the verdict forced to `fail`.
**The deterministic half wins ties.** One retry, never a loop.

### Feature registry

Every generative capability is a `defineFeature` object in `src/lib/agent/features/`,
registered with one line in `registry.ts`. Current features: `concepts`, `campaign`,
`report`, `gaps`, `guideline`, `storyboard`, `audience`.

A feature with a `brain` config runs Law → Judge → one retry automatically.
A feature without one behaves exactly as before. **Adding a capability should be one
new file plus one registry line. If you find yourself editing routes to add a feature,
stop — you are working against the design.**

### Agent client

`src/lib/agent/client.ts` → `runAgentJson({ userMessage, schema, quality, maxTokens?, system? })`
streams, extracts JSON, validates with zod, and retries **exactly once** on failure.
The optional `system` override is how the Judge runs its own prompt.

### Board analysis

`/api/board/analyze` is chunked and resumable (25 posts per call, `limit` max 50).
All comparatives — `vs_account_avg`, `vs_format_avg`, `percentile` — are computed in
**code** from real rows. The model is only ever asked to *name the pattern*, and is
explicitly forbidden from telling a causal story about a single post: with n=1 that is
astrology, not analysis. The route returns a `RATES`-based USD estimate before you spend.

### The ingestion spine (v3)

- `src/lib/ingest/handles.ts` — canonical handles from env, one source of truth.
- `src/lib/ingest/budget.ts` — pure estimate + guard. Apify rate verified from the actor
  page 2026-08-14: Free $2.70 / Starter $2.30 / Scale $1.90 / Business $1.50 per 1,000
  results; one result = one scraped item regardless of type (post, reel, comment, profile).
- `src/lib/audience/posts.ts` — `distinctPosts()`. `posts` is UNIQUE (snapshot_id, ig_id),
  so it holds ONE ROW PER POST PER SNAPSHOT. Every query that is not scoped to a single
  snapshot must collapse by ig_id or it double-counts. This is the single most important
  thing to know before touching any posts query.
- `src/lib/audience/timing.ts` — pure timing arithmetic.
- `src/lib/ingest/media.ts` — the MIRROR_MEDIA flag path, default OFF, hard cap 200
  objects, SSRF host allow-list. Wired into the monitor import.

## 5. What exists — verified counts

```
17 commits · 130 tracked files · 24,552 lines of TypeScript
28 API routes · 15 pages · 7 registered features · 13 npm scripts
(the build reports 44 routes — Next.js counts its own generated entries too)
tsc --noEmit    clean
npm test        116/116 pass
npm run build   passes — 44 routes, 16/16 static pages
npm run demo:check   honestly red: 9 failing, 7 passing
```

**Screens** (12 under `(app)/`): dashboard · board · audience · concepts (with a
Storyboard tab) · campaigns · calendar · reports · guideline · compliance · brand ·
data · settings. Plus `login` and `auth/callback` outside the app shell.

`gaps` is a registered **feature**, not a screen — it has no page of its own.

**Scripts:** `dev` `build` `start` `typecheck` `test` `seed` `doctor` `login`
`ingest:knowledge` `ingest:canon` `assets` `bakeoff` `demo:check`

`npm run login` mints a magic link via the Supabase Admin API. It is a **local script and
deliberately not an HTTP endpoint** — as a route it would be a complete auth bypass.
Keep it that way.

## 6. PROVEN — verified by execution, not by reading code

- Migration 0002 applied to project `ftqzykrweiwbrsnogniz` and confirmed by SQL: 4 new
  tables, RLS enabled with zero policies (deny-all), 14 additive nullable columns on
  `posts`.
- **116/116 tests pass** — law 26, budget, ingest, timing, posts, needs-human.
- `npm run build` passes: 44 routes, 16/16 static pages, no RSC boundary or
  route-manifest error.
- **Canon retrieval end-to-end** — `/api/canon` 200, 5 chunks, method `vector`, verbatim
  content with source.
- **Bucket privacy**, probed unauthenticated — the public object URL returns
  **400 NoSuchBucket**; `/api/assets` returns **401**.
- **Canonical handles verified against ingested data** by `demo:check`, which reports
  `320 post(s) in 320 row(s) across 1 snapshot(s)`.
- Apify pricing independently verified from the actor page.
- **Zero `any`, zero `@ts-ignore`, zero non-null assertions** across `src/` and `tests/` —
  swept by grep, because tsc structurally cannot see non-null assertions.

## 7. NOT PROVEN — do not claim otherwise

**Still blocked on `OPENROUTER_API_KEY`.** Unproven: the Judge fail path and needs_human
live (the retry cycle IS asserted in tests with an injected fake judge, but never observed
against a real model); bake-off; board analysed (0/320); guideline generated and approved;
the Arabic print PDF; the compliance WOW path including its new Arabic-rewrite second leg;
audience insights (no comments ingested).

**Also not proven, and worth its own line: no Apify run has ever executed in v3.** Zero
scrapes, zero spend. The profile scrape, comment scrape and full monitor pipeline are
written and typechecked but never called. So the estimate-vs-actual ledger has no rows,
and the budget guard has never blocked a real run.

Human-only gates unchanged: bake-off grading, Arabic register quality, rehearsal count,
recorded backup.

## 8. Known gaps — flagged, not hidden

1. `/bakeoff` grading screen still not built (the CLI does the real work).
2. **Mirrored media has no reader.** `media.ts` is wired and runs, but nothing constructs
   a URL to read the mirrored objects and there is no `<img>` on the Board — the Board is
   caption-first by an earlier decision. Turning `MIRROR_MEDIA=true` today downloads
   thumbnails into a bucket no screen displays. Decide: build the Board image path, or
   drop the flag.
3. **The analysed-set fix has a boundary at the 7th snapshot.** Analyses are matched to
   posts through `ig_id` inside one 2000-row capped read. At ~320 posts per snapshot that
   overflows at 2240 rows, after which an analysis whose cited row dropped out reads as
   unanalysed and would be paid for twice. This is surfaced in the API response
   (`unresolved_analyses`, `population.truncated`), not silent. The durable fix is an
   additive `post_analyses.ig_id` column backfilled from that same in-memory map.
4. `storeRawOrCloseLedger` now exists identically in three routes. Extracting it needs an
   owner holding all three files.
5. `TOKENS_IN_PER_POST` / `TOKENS_OUT_PER_POST` in the board analyze route were unsourced
   constants rendered to the operator as dollars; they have been addressed but the cost
   model is still an approximation and should say so wherever it appears.

## 9. Do this next, in order

1. Put `OPENROUTER_API_KEY` in `.env.local`. Everything below is blocked without it.
2. Set `APIFY_BUDGET_USD` in `.env.local` — the guard is disarmed while it is blank, and
   `demo:check` fails on it.
3. Run the profile scrape from /data. This is the cheapest possible first run (2 results)
   and it is the first time any of the v3 ingestion executes end to end. It retires the
   seed follower figure and turns the dashboard em-dashes into dated real numbers.
4. Then the comment scrape, then /audience -> Generate.
5. `npm run bakeoff` → `npm run bakeoff -- --show` → grade the blind Arabic yourself →
   `npm run bakeoff -- --winner <model>`. **The default model must be chosen by reading
   graded Arabic, not inherited from whatever a commit happened to set.** Then set
   `AI_MODEL_QUALITY` / `AI_MODEL_STANDARD` to match.
6. Open `/board`, run "Analyze all" until it reads 320/320. Then hand-check five computed
   rows against SQL — the comparatives are the product's credibility.
7. Paste the off-brand fixture into `/compliance` and **prove the fail path**: FAIL with
   receipts → Apply fixes → PASS. Record the result in the build record. Until this is
   observed, the Judge is unproven.
8. Generate a guideline on `/guideline`, approve v1, screenshot the Arabic print view.
9. `npm run demo:check` until fully green. Red means do not demo.
10. Then, if wanted: the `/bakeoff` grading screen, and monitor→analyse auto-wiring.

## 10. The demo

`DEMO.md` holds the click script, staging checklist, failure drills, and timing.
Read it before changing any demo-path screen.

**The WOW is the compliance fail path.** The prepared paste text:

```
Our new campaign uses a bold #7B2FF7 gradient and drives 340% more engagement
than any previous post, reaching 92% of our target demographic.
```

It fails deterministically every time: `#7B2FF7` is not in the sampled palette
(palette violation), `340%` and `92%` appear nowhere in the data (claims violation),
and the English marketing register warns against his Arabic captions. The first two
are Law — pure functions, no model involved. **They cannot flake.** That is why this,
and not a generation demo, is the moment the room remembers.

The landing line: **«كل رقم إله مصدر»** — every number has a source.

## 11. How to report your own work

Match the existing record's standard: state what you **executed**, separately from what
you **wrote**. If a gate was not observed running, it is not proven — say so plainly and
name what would prove it. Do not describe code that exists as behaviour that works.
Flag anything you skipped or scoped down; that call belongs to the user, not to you.
