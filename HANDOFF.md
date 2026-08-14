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
`report`, `gaps`, `guideline`, `storyboard`.

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

## 5. What exists — verified counts

```
15 commits · 109 tracked files · 11,360 lines of TypeScript
24 API routes · 11 screens · 8 scripts · 6 registered features
tsc --noEmit    clean
npm run build   ✓ compiled successfully
npm test        26/26 Law tests pass
```

**Screens:** dashboard · board · concepts (with a Storyboard tab) · campaigns · reports ·
gaps · guideline · compliance · brand brain · data · settings

**Scripts:** `dev` `build` `start` `typecheck` `test` `seed` `doctor` `login`
`ingest:knowledge` `ingest:canon` `assets` `bakeoff` `demo:check`

`npm run login` mints a magic link via the Supabase Admin API. It is a **local script and
deliberately not an HTTP endpoint** — as a route it would be a complete auth bypass.
Keep it that way.

## 6. PROVEN — verified by execution, not by reading code

- **26/26 Law tests pass**, including an off-brand fixture that fails on palette *and*
  claims and warns on register.
- **Canon retrieval end-to-end** — `/api/canon` returned 200, 5 chunks, `method: "vector"`,
  score 0.428, verbatim content with document title and tags attached.
- **Bucket privacy**, probed from an unauthenticated client — the public object URL returns
  **400 NoSuchBucket**; `/api/assets` returns **401**. The three client decks are no longer
  fetchable by anyone holding a link.
- **320 real posts ingested** from Apify across both accounts, deduped by `ig_id`.
- **Palette sampled from published creatives** by dominant-colour analysis, not eyeballed.
- `tsc --noEmit` clean · `npm run build` succeeds · `npm run demo:check` runs correctly
  and reports honest red.

## 7. NOT PROVEN — do not claim otherwise

**Everything below is blocked on one thing: `OPENROUTER_API_KEY` is not set. No
model-dependent code path has ever executed.**

| Gate | Status |
|---|---|
| Off-brand output **fails, retries once, surfaces needs_human** | Law half tested; **Judge half unproven** |
| Bake-off — 3 models on one task | **never run** |
| Board analysed | **0 / 320** |
| Guideline generated and approved | **never run** |
| Arabic print-PDF of the guideline | **never rendered** |
| The full compliance WOW path | **never run** |
| `npm run demo:check` all green | **red — 6 failures** |

Human-only gates, also unproven and not provable by any agent:
**bake-off grading** (a person must read the blind Arabic), **Arabic register quality**,
**demo rehearsal count**, **the recorded backup run**.

## 8. Known gaps — flagged, not hidden

1. **The `/bakeoff` grading screen was not built.** `scripts/bakeoff.mjs` exists and does
   the real work — runs three models on one task, stores outputs under blind labels A/B/C,
   `--show` prints them without revealing which model wrote which, `--winner` records the
   decision. The blind comparison and the human decision are intact; the side-by-side UI
   is not. `demo:check` still blocks until a winner is recorded.
2. **The monitor does not auto-analyse new posts.** Batch analysis is chunked and resumable
   as designed, but nothing triggers it when the monitor ingests new rows.

## 9. Do this next, in order

1. Put `OPENROUTER_API_KEY` in `.env.local`. Everything below is blocked without it.
2. `npm run bakeoff` → `npm run bakeoff -- --show` → grade the blind Arabic yourself →
   `npm run bakeoff -- --winner <model>`. **The default model must be chosen by reading
   graded Arabic, not inherited from whatever a commit happened to set.** Then set
   `AI_MODEL_QUALITY` / `AI_MODEL_STANDARD` to match.
3. Open `/board`, run "Analyze all" until it reads 320/320. Then hand-check five computed
   rows against SQL — the comparatives are the product's credibility.
4. Paste the off-brand fixture into `/compliance` and **prove the fail path**: FAIL with
   receipts → Apply fixes → PASS. Record the result in the build record. Until this is
   observed, the Judge is unproven.
5. Generate a guideline on `/guideline`, approve v1, screenshot the Arabic print view.
6. `npm run demo:check` until fully green. Red means do not demo.
7. Then, if wanted: the `/bakeoff` grading screen, and monitor→analyse auto-wiring.

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
