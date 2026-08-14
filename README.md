# ThinkQuality Studio

Brand strategist and creative director workspace for **Think Quality Academy**
(Ahmad Kahtan, Amman), operated by **ALKURDI Studio**.

It ingests real Instagram engagement exports, keeps a living Brand Brain, and
uses a Claude-powered agent to produce strategy, post concepts, campaigns and
client reports — in Arabic, in Ahmad's register.

**It designs and thinks. It never publishes.** There is no Instagram API, no
Meta OAuth, no scheduler, and no send button anywhere in the product. The loop
is: *ingest data → think → a human posts.*

---

## The honesty contract

This app is built around one rule: **it never invents a number.**

| Where | How it's enforced |
|---|---|
| Seed data | Only the eight verified client facts, each tagged `source: seed-2026-06`. Palette, typography, voice examples and pillars start empty. |
| Snapshot stats | Averages, totals, ranks and top-format are computed **in code** from the export. The model is never asked for arithmetic. |
| Pillars | Claude *groups* posts; `post_count` and `avg_engagement` are calculated from the real rows it grouped. |
| Agent output | Every concept carries `grounding: "data" | "hypothesis"`. A hypothesis is labelled as one, in the UI as an orange tag. |
| Missing values | Render as `—`. Never `0`, never a plausible-looking placeholder. |
| Reports | Refused outright when the latest snapshot is more than 45 days old, with the fix named in the error. |

If you change one thing in this codebase, don't change that.

---

## Stack

Next.js 15 (App Router) · TypeScript strict · Ant Design v5 · Supabase
(Postgres + Auth) · Anthropic API · deployable to Cloudflare Pages via OpenNext
or to Vercel.

Fonts: IBM Plex Sans Arabic (Arabic) + Inter (Latin), via `next/font`.

---

## Setup from a fresh clone

Requires **Node 20+** (developed on 22) and a Supabase project.

### 1. Install

```bash
npm install
```

### 2. Environment

```bash
cp .env.example .env.local
```

Fill in:

| Variable | Where it comes from |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys. Server-side only; never reaches the browser. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page (public by design) |
| `SUPABASE_SERVICE_ROLE_KEY` | same page — **secret**, bypasses RLS |
| `ALLOWED_EMAILS` | Comma-separated. Only these addresses can request a sign-in code. |

Optional model overrides (defaults shown):

```
ANTHROPIC_MODEL_STANDARD=claude-sonnet-4-6
ANTHROPIC_MODEL_QUALITY=claude-opus-4-8
```

### 3. Database

In the Supabase SQL editor, run **`supabase/migrations/0001_init.sql`**.

It creates the seven tables and enables row-level security with **no policies** —
deliberately. Every read and write goes through an auth-gated route handler
using the service-role key, so the anon key that ships to the browser can see
nothing at all.

### 4. Seed the Brand Brain

```bash
npm run seed
```

Writes the eight verified facts into the singleton `brand` row. Idempotent, and
it never overwrites voice examples, palette, typography or audience notes you've
since added. (The equivalent raw SQL is in `supabase/seed.sql`.)

### 5. Enable email sign-in

Supabase → Authentication → Providers → **Email**: enable it. The app uses
6-digit OTP codes, so also make sure "Confirm email" is on.

### 6. Run

```bash
npm run dev
```

Open http://localhost:3000, enter an allow-listed address, and paste the code
from your inbox.

---

## How the loop actually runs

1. **Data →** export both accounts from the Apify Instagram scraper. Drop the
   JSON files on the Data screen. One snapshot is created; posts are merged
   across files, deduped by post id, routed to `personal` / `academy` by owner
   username, and ranked by `likes + comments`.
2. **Run Refresh →** diffs the new snapshot against the previous one, folds the
   observed numbers into `brand.facts` (tagged `snapshot-YYYY-MM-DD`),
   re-clusters pillars, and backfills real engagement onto any concept you'd
   marked shipped.
3. **Concepts →** generate drafts, approve the good ones, give each a target
   week.
4. **Calendar →** see the approved week by week. After you post something,
   mark it shipped and paste the Instagram URL — that URL is what lets the next
   refresh measure it.
5. **Reports →** generate the Arabic monthly report, edit it, copy or download
   it. Sending it to the client is your job, on purpose.

---

## The agent

The system prompt lives verbatim in [`src/lib/agent/system.ts`](src/lib/agent/system.ts).
It is the product — edit it deliberately.

Each request assembles four context blocks from the database and nothing else:

```
<brand>             facts, voice examples, palette, typography, audience notes
<latest_snapshot>   taken_on, computed stats, top posts with caption excerpts
<pillars>           name, post_count, avg_engagement, hook_pattern
<recent_concepts>   the last 12, so it doesn't repeat a hook
```

Every call returns JSON only, is validated with zod, and is retried **exactly
once** with the validation error fed back. A second failure is a 502 — the app
would rather show you an error than write unvalidated model output into the
database.

Both model tiers run with adaptive thinking; the header switch picks the tier
and the API routes read it from a cookie, so a toggle applies to the very next
generation.

---

## Adding a feature

The extensibility pattern is one file plus one line. Here's a complete worked
example — a "hook rewriter" that produces variants of an existing hook.

**1. `src/lib/agent/features/hooks.ts`**

```ts
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { defineFeature } from './types';

const inputSchema = z.object({
  concept_id: z.string().uuid(),
  variants: z.number().int().min(2).max(5).default(3),
});

const resultSchema = z.object({
  warnings: z.array(z.string()),
  hooks: z.array(z.object({ hook_ar: z.string(), why: z.string() })).min(2),
});

export const hooksFeature = defineFeature<
  z.infer<typeof inputSchema>,
  z.infer<typeof resultSchema>
>({
  id: 'hooks',
  label: 'Hook variants',
  contextBlocks: ['brand', 'latest_snapshot', 'pillars'],
  inputSchema,
  schema: resultSchema,

  buildPrompt(input) {
    return [
      '## Task',
      `Rewrite the hook of concept ${input.concept_id} as ${input.variants} variants.`,
      'Keep the register of <brand.voice_examples>.',
      '',
      '## Response schema',
      '{ "warnings": ["string"], "hooks": [{ "hook_ar": "string", "why": "string" }] }',
    ].join('\n');
  },

  async persist(result, input) {
    const db = supabaseAdmin();
    await db.from('concepts').update({ hook_ar: result.hooks[0].hook_ar }).eq('id', input.concept_id);
    return { hooks: result.hooks };
  },
});
```

**2. Register it** in `src/lib/agent/features/registry.ts`:

```ts
import { hooksFeature } from './hooks';

export const FEATURES: readonly RunnableFeature[] = [
  conceptsFeature,
  campaignFeature,
  reportFeature,
  hooksFeature, // ← added
];
```

That's it. `POST /api/generate/hooks` now works, gated by the same auth, using
the same context blocks, validation and retry. No route file to write. Add a
nav entry in `src/lib/i18n/dict.ts` + `src/components/Shell.tsx` only if the
feature needs its own screen.

Optional hooks on a feature:

- `preflight(input, ctx)` — throw `HttpError` to refuse *before* spending a
  model call (this is how the report refuses on a stale snapshot).
- `maxTokens` — defaults to 8000.

---

## Bilingual / RTL

The locale switch flips three things together: `<html dir lang>` (server-rendered
from a cookie), antd's `ConfigProvider direction`, and the dictionary in
`src/lib/i18n/dict.ts`.

Conventions that keep RTL correct as the app grows:

- **No directional CSS.** Use `marginInlineStart`, `paddingInlineEnd`,
  `insetInlineStart`, `border-inline-start`. There is not a single
  `margin-left` in `src/`.
- **Arabic content carries `dir="auto"`** (via `<ArabicText>`), so a caption
  mixing Arabic with a Latin handle or URL still renders in the right order.
- **Numbers carry `className="tq-num"`** — `direction: ltr; unicode-bidi: isolate`
  — so metrics stay readable inside an RTL page.
- **Dates crossing the API boundary go through `toIsoDate()`**, which formats in
  the `en` dayjs locale. The Arabic locale renders Arabic-Indic digits (`٢٠٢٦`),
  which are right for display and wrong for Postgres.
- Drawers use `placement={isRTL ? 'left' : 'right'}`.

---

## Project layout

```
src/
  app/
    (app)/            dashboard · brand · data · concepts · campaigns
                      calendar · reports · settings   (all behind auth)
    api/              route handlers, all auth-gated
    login/            email → 6-digit code
  components/         Shell, Providers, ConceptCard, shared UI atoms
  lib/
    agent/            system prompt, zod schemas, runner, context blocks
      features/       one file per capability + registry
    ingest/           Apify parser (dedupe, routing, caption cleaning)
    supabase/         browser / server / admin clients
    i18n/             dictionary + locale context
supabase/
  migrations/         0001_init.sql
  seed.sql
scripts/seed.ts
```

---

## Verification status

| Check | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`, strict) | passes, zero errors, zero `any` |
| `npm run build` | passes — 12 pages, 14 API routes |
| Ingest pipeline logic | 34 assertions pass (merge, dedupe, account routing, Arabic caption preservation, stats arithmetic, null-vs-zero, diff, shortcode matching, JSON extraction, schema rejection) |
| RTL audit | no directional CSS in `src/` |
| Fabricated-metric audit | none in copy, empty states or seeds |
| Publishing affordances | none |
| Live generation against the Anthropic API | **not run** — needs real credentials |
| Live Supabase round trip | **not run** — needs a real project |

The last two need your keys. Run them as described in "Setup from a fresh
clone", then generate concepts twice from the Concepts screen: both runs should
return schema-valid drafts, and while `brand.status` is `seed` every response
should carry the warning *"running on seed data — ingest a fresh export"*.
