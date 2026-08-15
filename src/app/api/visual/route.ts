import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { readQuality } from '@/lib/prefs.server';
import { extractJson } from '@/lib/agent/client';
// modelFor is imported from its home rather than through the client's
// re-export: the client module pulls in the Anthropic SDK, and this route's
// model resolution is a pure read of the environment that should not depend on
// an SDK it never calls.
import { resolveProvider, providerKeyName, modelFor } from '@/lib/agent/provider';
import { requireEnv } from '@/lib/env';
import { rateFor, unpricedReason, normaliseModel } from '@/lib/agent/rates';
import { mirrorPathFor, MAX_OBJECT_BYTES } from '@/lib/ingest/media';
import {
  distinctPosts,
  scanCoverage,
  MAX_POSTS_SCAN,
  type DistinctPostsResult,
  type PostIdentity,
} from '@/lib/audience/posts';
import {
  FACE_PROMINENCE_BANDS,
  TEXT_COVERAGE_BANDS,
  MAX_COMPOSITION_TAGS,
} from '@/lib/vision/analytics';
import type { Account, PostRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/* ===========================================================================
 * /api/visual — a vision-capable model TRANSCRIBES the mirrored creative.
 *
 * HARD RULE 13, WHICH IS THE WHOLE POSTURE OF THIS FILE: describing is not
 * generating. Everything here reads an image that the client already published
 * and writes down what is in it. Nothing in this route, and nothing it calls,
 * produces an image, edits an image, restyles an image, or offers an opinion
 * about what an image should have looked like. The prompt says so in as many
 * words, the response schema has no field such an answer could arrive in, and
 * the insert below is written out column by column so an unrequested field
 * cannot ride along into the database.
 *
 * Shaped after src/app/api/board/analyze/route.ts on purpose — chunked,
 * resumable, estimate-first, keyed by ig_id — because those four properties are
 * what make a paid batch job survivable. Call POST until `remaining` is 0.
 *
 * KEYED BY ig_id, NEVER BY posts.id. This is the post_analyses lesson, applied
 * before it costs anything: `posts` is UNIQUE (snapshot_id, ig_id), so a post
 * seen in seven scrapes has seven row ids. A description filed against a row id
 * goes invisible the moment the corpus is re-scraped, and the same unchanged
 * image is described — and paid for — again. visual_features is UNIQUE on
 * ig_id and the database enforces it.
 * ======================================================================== */

/* ================================================== what has been mirrored ==
 *
 * The bucket listing is the only source of "this post has an image". Nothing
 * here infers it from a row, a flag, or a URL that used to resolve — that is
 * src/lib/ingest/media.ts's rule and it holds on the reading side too, because
 * the alternative is paying a model to look at a 404.
 *
 * TODAY THAT LISTING IS EXPECTED TO BE EMPTY. `posts.raw` is null for all 320
 * stored rows (they predate the column), so their Instagram CDN URLs are long
 * expired and the mirror has nothing to fetch until a refresh scrape runs.
 * A GET against this route on today's database therefore reports
 * `mirrored: 0` and `remaining: 0`, and POST spends nothing. That is the
 * correct answer, not a broken one.
 */

/** The private bucket /api/assets fronts. Same constant as media.ts's BUCKET. */
const BUCKET = 'brand-assets';

/** Page size and page bound for the "what is already mirrored" listing. */
const INDEX_PAGE = 1000;
const MAX_INDEX_PAGES = 20;

const ACCOUNTS: readonly Account[] = ['personal', 'academy'];

interface MirrorIndex {
  /** Object NAMES (the last path segment, i.e. the ig_id) per account. */
  names: Map<Account, Set<string>>;
  /**
   * False when a listing hit its page bound or failed. A partial index can only
   * hide work, never invent it, and the caller says which it got rather than
   * presenting a prefix as the whole bucket.
   */
  complete: boolean;
}

/**
 * Which posts actually have a mirrored object, read from storage.
 *
 * A near-copy of media.ts's private `mirroredNames()`. It is private there, and
 * duplicating twenty lines was judged better than reaching into another
 * agent's module mid-edit — but this is a seam, not a design: media.ts's own
 * header already describes a `readMirrorIndex()` reader, and the moment that is
 * exported this function should be deleted and replaced by a call to it.
 */
async function readMirrorIndex(): Promise<MirrorIndex> {
  const db = supabaseAdmin();
  const names = new Map<Account, Set<string>>();
  let complete = true;

  for (const account of ACCOUNTS) {
    const found = new Set<string>();
    names.set(account, found);
    let finished = false;

    for (let page = 0; page < MAX_INDEX_PAGES; page += 1) {
      const { data, error } = await db.storage
        .from(BUCKET)
        .list(`post-media/${account}`, { limit: INDEX_PAGE, offset: page * INDEX_PAGE });

      // A missing prefix lists as empty. A real failure means the index is
      // UNKNOWN, and an unknown index is reported incomplete rather than
      // assumed empty — assuming empty would report the whole account as
      // un-mirrored and hide work that has already been paid for.
      if (error) {
        complete = false;
        finished = true;
        break;
      }
      const batch = data ?? [];
      for (const object of batch) found.add(object.name);
      if (batch.length < INDEX_PAGE) {
        finished = true;
        break;
      }
    }

    if (!finished) complete = false;
  }

  return { names, complete };
}

/* ============================================ RULE 15 — vision cost inputs ==
 *
 * Hard rule 15: a vision cost constant is copied from a vendor page WITH that
 * page's URL and the date it was read, or it is absent — and absence makes the
 * estimate null, which BLOCKS the run. The same contract src/lib/ingest/
 * budget.ts keeps for the Apify actors and src/lib/agent/rates.ts keeps for the
 * per-token prices. An unsourced constant is the named anti-pattern; a
 * plausible-looking guess here would quietly misprice every image in the corpus.
 *
 * The per-TOKEN prices are not restated here. They live in
 * src/lib/agent/rates.ts and are imported, so this route and every other
 * estimate in the app quote the same figures read on the same date.
 *
 * What IS declared here is the thing rates.ts has no opinion about: how many
 * input tokens one IMAGE costs.
 */

/**
 * Anthropic's published vision accounting, copied from
 * https://platform.claude.com/docs/en/build-with-claude/vision — read
 * 2026-08-15:
 *
 *   "Claude views images in patches instead of pixels. Each patch is a 28x28-
 *    pixel block of the image, referred to as a visual token. An image,
 *    therefore, costs ceil(width / 28) x ceil(height / 28) visual tokens."
 *
 * and the per-tier ceilings from the table on the same page:
 *
 *   High-resolution  Claude 4.7 and later models   2576 px long edge   4784 tokens
 *   Standard         All other models              1568 px long edge   1568 tokens
 *
 * Images above either limit are downscaled BEFORE they are counted, so the
 * token figure can never exceed the tier's maximum whatever is uploaded. THAT
 * is the property this route prices against: the ceiling is computable with no
 * knowledge of any image's dimensions, which is what makes an honest estimate
 * possible before a single object has been downloaded.
 *
 * The patch formula itself is quoted above and deliberately NOT implemented.
 * Applying it would need each image's post-downscale dimensions — a decode this
 * route does not do and a resize rule published on a different page — and an
 * unused implementation of a rule nobody checks is worse than the quotation.
 *
 * NOTHING IN THIS BLOCK IS EXPORTED, and that is a deliberate constraint rather
 * than a preference. Next validates a route module's exports against the verbs
 * and its own config fields, and every other route in this repository exports
 * only those plus type-only declarations — `export interface CostCeiling` in
 * /api/board/analyze is the precedent, and interfaces are erased. Exporting a
 * const from here would be the first place in the app to try it, on a check
 * that only `next build` runs and this task is not allowed to run. So the
 * constants stay private and the tests drive them through GET, which proves the
 * same arithmetic without betting on that answer.
 */
const VISION_SOURCE_URL = 'https://platform.claude.com/docs/en/build-with-claude/vision';
const VISION_SOURCE_READ_ON = '2026-08-15';

type ResolutionTier = 'standard' | 'high';

/** Maximum visual tokens one image can cost, per tier. Source above. */
const MAX_VISUAL_TOKENS: Record<ResolutionTier, number> = {
  standard: 1568,
  high: 4784,
};

/**
 * Which tier a model is on. Keyed by the bare model id, exactly as
 * PUBLISHED_RATES is, and resolved through the same normaliseModel().
 *
 * THE ONE INFERENCE IN THIS BLOCK, STATED PLAINLY: the source page assigns the
 * high-resolution tier to "Claude 4.7 and later models" and the standard tier
 * to "All other models". It does not print a per-model list. Placing opus-5 and
 * sonnet-5 above that line and haiku-4-5 below it is reading the rule the page
 * states, not copying a row from it. It is recorded here rather than applied
 * silently so that a maintainer can disagree with it in one place.
 *
 * Every other model this app can be pointed at is ABSENT, and absence is the
 * honest answer: nobody has read a vision-token accounting for gpt-5.6-luna,
 * qwen3.7-plus, gemini-3.7-flash or deepseek-v4-pro-0813 into this file, so
 * nothing here can price an image sent to one. Note what that means in
 * practice — the app's DEFAULT OpenRouter models are unpriced for vision, so
 * this route blocks until AI_MODEL_STANDARD / AI_MODEL_QUALITY names a model
 * that is listed here (`anthropic/claude-opus-5` is the worked example), or
 * until somebody adds a tier with the vendor's page in front of them.
 */
const VISION_TIERS: Record<string, ResolutionTier> = {
  'claude-opus-5': 'high',
  'claude-sonnet-5': 'high',
  'claude-haiku-4-5': 'standard',
};

/** The tier for a model, or null when no page has been read for it. */
function tierFor(model: string): ResolutionTier | null {
  const key = normaliseModel(model);
  if (!Object.hasOwn(VISION_TIERS, key)) return null;
  return VISION_TIERS[key];
}

/** The most visual tokens one image can cost on this model. Null when unknown. */
function imageTokenCeiling(model: string): number | null {
  const tier = tierFor(model);
  return tier === null ? null : MAX_VISUAL_TOKENS[tier];
}

/** Why an image could not be priced, in words an operator can act on. */
function unpricedImageReason(model: string): string {
  return (
    `No published vision-token accounting has been verified for "${model}", so the cost of ` +
    'reading an image cannot be estimated, and rule 15 blocks a run it cannot price. Add a ' +
    'resolution tier to VISION_TIERS in src/app/api/visual/route.ts with the vendor’s vision ' +
    `page in front of you (${VISION_SOURCE_URL} is the one this file already quotes, read ` +
    `${VISION_SOURCE_READ_ON}), or point AI_MODEL_STANDARD at a model that is already listed.`
  );
}

/* ================================================================ the cost ==
 *
 * The same ceiling discipline as /api/board/analyze: measured prompt characters
 * rather than invented per-post token counts, rounding upward throughout, and
 * exactly one assumption — CHARS_PER_TOKEN — which travels to the screen beside
 * the number so it is never read as a quote.
 */

/**
 * Characters per token. AN ASSUMPTION, not a measurement, and the same one
 * /api/board/analyze makes for the same reason: tokenising needs the vendor's
 * tokeniser, which this app does not have. 2 over-estimates Latin prose and is
 * close for Arabic script, so the resulting figure errs high — the direction a
 * spend guard wants to be wrong in.
 *
 * It is declared twice in this repository, here and in the board analyser. That
 * is a duplicate and it is reported as one; the right home is beside the rate
 * table in src/lib/agent/rates.ts, which this task does not own.
 */
const CHARS_PER_TOKEN = 2;

/** The output ceiling this route sets on every request. One image, one JSON object. */
const MAX_OUTPUT_TOKENS = 1_500;

/** Images per POST when the body names no limit. */
const DEFAULT_CHUNK = 4;

/** The most images one POST will ever describe, whatever the body asks for. */
const MAX_CHUNK = 10;

export interface VisionCostCeiling {
  /** Upper bound in USD, or null when something in the chain is unpriced. Never 0. */
  usd: number | null;
  model: string;
  images: number;
  /** One model call per image, so this equals `images`. Stated, not implied. */
  requests: number;
  /** Prompt characters, measured off the strings this route really sends. */
  prompt_chars: number;
  text_input_tokens: number;
  /** images x the tier ceiling. Null when the model has no verified tier. */
  image_input_tokens: number | null;
  input_tokens: number | null;
  /** requests x MAX_OUTPUT_TOKENS. A hard limit this route sets, not a guess. */
  output_tokens: number;
  chars_per_token: number;
  resolution_tier: ResolutionTier | null;
  visual_tokens_per_image_max: number | null;
  rate_in_per_mtok: number | null;
  rate_out_per_mtok: number | null;
  /** Where the vision constants came from, so the screen can show the receipt. */
  source: { url: string; read_on: string };
  /** Why `usd` is null. Null when it is not. */
  unpriced_reason: string | null;
}

/** Rounds UP to the next cent, so a ceiling never reads below what it bounds. */
function ceilToCents(value: number): number {
  // toFixed first: binary floating point turns exact cents into 2.7000000000003
  // and a naive ceil would push $2.70 to $2.71.
  return Math.ceil(Number((value * 100).toFixed(6))) / 100;
}

function visionCostCeiling(model: string, images: number): VisionCostCeiling {
  const count = Number.isFinite(images) && images > 0 ? Math.ceil(images) : 0;
  const promptChars = count * (VISION_SYSTEM.length + VISION_TASK.length);
  const textTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const outputTokens = count * MAX_OUTPUT_TOKENS;

  const tier = tierFor(model);
  const perImage = imageTokenCeiling(model);
  const rate = rateFor(model);

  const base = {
    model,
    images: count,
    requests: count,
    prompt_chars: promptChars,
    text_input_tokens: textTokens,
    output_tokens: outputTokens,
    chars_per_token: CHARS_PER_TOKEN,
    resolution_tier: tier,
    visual_tokens_per_image_max: perImage,
    source: { url: VISION_SOURCE_URL, read_on: VISION_SOURCE_READ_ON },
  };

  // Two independent ways to be unpriceable, reported apart because they are
  // fixed in different files: an unknown vision tier, and an unknown per-token
  // price. Either one alone is enough to block.
  const reasons: string[] = [];
  if (perImage === null) reasons.push(unpricedImageReason(model));
  if (rate === null) reasons.push(unpricedReason(model));

  if (perImage === null || rate === null) {
    return {
      ...base,
      usd: null,
      image_input_tokens: perImage === null ? null : count * perImage,
      input_tokens: null,
      rate_in_per_mtok: rate === null ? null : rate.in,
      rate_out_per_mtok: rate === null ? null : rate.out,
      unpriced_reason: reasons.join(' '),
    };
  }

  const imageTokens = count * perImage;
  const inputTokens = textTokens + imageTokens;

  return {
    ...base,
    usd: ceilToCents((inputTokens * rate.in) / 1_000_000 + (outputTokens * rate.out) / 1_000_000),
    image_input_tokens: imageTokens,
    input_tokens: inputTokens,
    rate_in_per_mtok: rate.in,
    rate_out_per_mtok: rate.out,
    unpriced_reason: null,
  };
}

export interface VisionSpendDecision {
  allowed: boolean;
  /** Why the run was blocked. Null when it is allowed. */
  reason: string | null;
}

/**
 * The spend gate. Rule 9 is estimate before spend and rule 15 is that a vision
 * constant nobody sourced produces no estimate — so an unpriceable run is
 * refused, never attempted "just this once".
 *
 * A ceiling of exactly $0.00 over zero images is allowed: there is nothing to
 * spend, and POST answers with an empty batch rather than an error.
 */
function checkVisionSpend(ceiling: VisionCostCeiling): VisionSpendDecision {
  if (ceiling.usd === null) {
    return { allowed: false, reason: ceiling.unpriced_reason };
  }
  return { allowed: true, reason: null };
}

/* ============================================================== the prompt ==
 *
 * RULE 13 IS ENFORCED IN THREE PLACES, because a prompt alone is a request:
 *   1. here, in words the model cannot read past;
 *   2. in the response schema, which has no field an image-generation answer
 *      could occupy;
 *   3. at the insert, which names every column it writes.
 */

const VISION_SYSTEM = `You are a transcription and classification instrument for ThinkQuality
Studio. You are shown ONE image that Think Quality Academy (Ahmad Kahtan,
Amman) already published on Instagram. You write down what is in it.

WHAT YOU DO
- Transcribe the Arabic text that appears ON the image, character for
  character, exactly as written, including line breaks as spaces. Do not
  translate it, correct its spelling, fix its grammar, or improve it.
- Classify the image against the closed vocabularies you are given.
- Answer only about the image in front of you.

WHAT YOU MUST NOT DO — this is not a style preference, it is the rule this
instrument exists under:
- You do NOT generate, create, draw, render, edit, retouch, restyle, crop or
  modify any image. You have no such capability here and no request will give
  you one.
- You do NOT suggest what the image should have looked like, propose a better
  composition, recommend a colour, or critique the design. There is no field
  for that answer and it will be discarded.
- You do NOT state any colour. Colours are measured from the pixels in code,
  not read off by eye. A colour named by you would be a quantity you did not
  measure.
- You do NOT identify, name or guess the identity of any person. "A man faces
  the camera" is a description; a name is not.
- You do NOT count, estimate percentages, or state any number. Use the bands.
- You do NOT infer anything about how the post performed. You cannot see that
  and neither can the image.

If the image is too small, too dark, corrupted or otherwise unreadable, set
"unreadable": true and leave the descriptive fields at their defaults. An
honest refusal is a correct answer; a guessed description is not.

Output ONE JSON object. No prose, no markdown fences.`;

/**
 * Everything after the image. Fixed per request — there is no per-post listing
 * here, because one call describes exactly one image — which is why the cost
 * ceiling can measure it with `.length` and be exact rather than assumed.
 */
const VISION_TASK = [
  '## Task',
  'Describe the image above by filling in the schema below.',
  '',
  'Fields:',
  '- has_face: true if a human face is visible in the frame.',
  `- face_prominence: how much of the frame the face occupies — one of ${FACE_PROMINENCE_BANDS.join(' | ')} — or null when has_face is false.`,
  '- text_in_image_ar: the Arabic text ON the image, VERBATIM. Empty string when the image carries no text. This is a transcription: never paraphrase, never complete a cut-off word, never add punctuation that is not there.',
  `- text_coverage: how much of the frame is text — one of ${TEXT_COVERAGE_BANDS.join(' | ')}. Use "none" when there is no text at all.`,
  '- logo_present: true if an academy logo or wordmark appears.',
  `- composition_tags: up to ${MAX_COMPOSITION_TAGS} short Arabic tags naming the composition («بورتريه», «نص على خلفية», «سلايد اقتباس»). REUSE the same tags across images — they are cluster labels, and a tag used once groups nothing.`,
  '- unreadable: true only when you genuinely cannot see the image.',
  '',
  'Consistency rules the response must satisfy:',
  '- has_face false => face_prominence null. has_face true => face_prominence is one of the bands.',
  '- text_coverage "none" => text_in_image_ar is the empty string. Any other band => text_in_image_ar is non-empty.',
  '',
  '## Response schema',
  '{"has_face":true,"face_prominence":"minor|moderate|dominant|null","text_in_image_ar":"string","text_coverage":"none|light|moderate|heavy","logo_present":true,"composition_tags":["string"],"unreadable":false}',
].join('\n');

/**
 * The response, and nothing else.
 *
 * There is deliberately no colour field, no "suggested_improvement", no
 * "quality_score". A model that answers with one gets it dropped here, before
 * anything reaches the insert — and since the insert names its columns, an
 * extra key could not have landed in the table even if this schema were
 * loosened.
 */
const visionSchema = z.object({
  has_face: z.boolean(),
  face_prominence: z.enum(FACE_PROMINENCE_BANDS).nullable(),
  text_in_image_ar: z.string(),
  text_coverage: z.enum(TEXT_COVERAGE_BANDS),
  logo_present: z.boolean(),
  composition_tags: z.array(z.string()),
  unreadable: z.boolean(),
});

type VisionAnswer = z.infer<typeof visionSchema>;

/**
 * The two cross-field rules the prompt states, enforced rather than hoped for.
 *
 * A model that says "no face" and then names a face prominence has contradicted
 * itself, and storing either half would be storing a fact this route knows to
 * be unreliable. The row is failed instead and the post stays in the queue —
 * the route is resumable, so a contradiction costs one call, not a batch.
 */
function contradiction(answer: VisionAnswer): string | null {
  if (!answer.has_face && answer.face_prominence !== null) {
    return 'has_face is false but face_prominence was still given.';
  }
  if (answer.has_face && answer.face_prominence === null) {
    return 'has_face is true but no face_prominence was given.';
  }
  const text = answer.text_in_image_ar.trim();
  if (answer.text_coverage === 'none' && text !== '') {
    return 'text_coverage is "none" but a transcription was returned.';
  }
  if (answer.text_coverage !== 'none' && text === '') {
    return `text_coverage is "${answer.text_coverage}" but the transcription is empty.`;
  }
  return null;
}

/* =============================================================== the model ==
 *
 * WHY THIS ROUTE DOES NOT CALL runAgentJson(). That helper takes a `userMessage:
 * string` and sends text turns. An image is a content PART, not a string, so
 * there is no argument that would carry one — the multimodal request is
 * assembled here instead. The durable fix is an image-capable entry point in
 * src/lib/agent/client.ts, which this task does not own; it is reported.
 *
 * OpenRouter only, and refused loudly otherwise. The Anthropic SDK takes a
 * different image block shape, and writing a second untested encoder for a
 * provider this app does not default to would be two paths where one is proven.
 */

/** Wall-clock ceiling on one vision call. A hung vendor must not hold the batch. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Formats this route will hand to a model, from the same vendor page the token
 * accounting came from: "Claude supports JPEG, PNG, GIF, and WebP images".
 * Anything else is refused rather than relabelled — a data URL claiming a media
 * type the bytes are not is a lie told to the vendor's decoder.
 */
const ACCEPTED_MEDIA_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

/**
 * Bytes to base64 without Buffer or a giant argument list.
 *
 * `btoa` exists on both the Node and the Workers runtime; `Buffer` does not
 * reliably exist on the second, and this app deploys to Cloudflare. The chunk
 * keeps `String.fromCharCode` off the argument-count limit that a 4 MB object
 * would otherwise blow straight through.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number };
}

interface VisionCall {
  answer: VisionAnswer;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * One image, one call, one JSON object back.
 *
 * NO RETRY, deliberately. runAgentJson() retries once with the validation error
 * fed back, and that is right for a single expensive multi-post request. Here a
 * failure costs one image out of a chunk of four, the post simply stays
 * unqueued-off, and the next POST picks it up — so a retry would double the
 * spend on exactly the images least likely to succeed. The failure is reported
 * with its reason instead.
 */
async function describeImage(
  model: string,
  dataUrl: string,
): Promise<{ ok: true; call: VisionCall } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${requireEnv('OPENROUTER_API_KEY')}`,
        'content-type': 'application/json',
        'x-title': 'ThinkQuality Studio',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: VISION_SYSTEM },
          {
            role: 'user',
            // Image first: the vendor page this file already quotes says Claude
            // "works best when images come before text".
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text', text: VISION_TASK },
            ],
          },
        ],
      }),
    });

    const payload = (await response.json().catch(() => null)) as OpenRouterResponse | null;

    if (!response.ok) {
      return {
        ok: false,
        reason: `OpenRouter returned ${response.status}: ${payload?.error?.message ?? response.statusText}`,
      };
    }
    if (payload?.error) {
      return { ok: false, reason: `OpenRouter error: ${payload.error.message ?? 'unknown'}` };
    }

    const choice = payload?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') {
      return { ok: false, reason: 'The model declined to describe this image.' };
    }

    const text = (choice?.message?.content ?? '').trim();
    if (text === '') return { ok: false, reason: 'The response contained no text.' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch (err) {
      return { ok: false, reason: `The response was not valid JSON: ${(err as Error).message}` };
    }

    const result = visionSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        reason: result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      };
    }

    return {
      ok: true,
      call: {
        answer: result.data,
        usage: {
          input_tokens: payload?.usage?.prompt_tokens ?? 0,
          output_tokens: payload?.usage?.completion_tokens ?? 0,
        },
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, reason: 'The model took too long to respond.' };
    }
    return { ok: false, reason: err instanceof Error ? err.message : 'Unexpected failure.' };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================ the population */

// prettier-ignore
const VISUAL_POST_COLUMNS = 'id, snapshot_id, account, ig_id, posted_at, engagement';

/** Splits `'a, b, c'` into the union `'a' | 'b' | 'c'`. */
type SplitColumns<S extends string> = S extends `${infer Head}, ${infer Rest}`
  ? Head | SplitColumns<Rest>
  : S;

type VisualPostRow = Pick<PostRow, SplitColumns<typeof VISUAL_POST_COLUMNS> & keyof PostRow>;

/**
 * Compile-time proof that every name in the select list is a real column — a
 * typo would otherwise cost a field silently, since PostgREST would not return
 * it and `Pick` would quietly drop it.
 */
const COLUMNS_ARE_POST_FIELDS: SplitColumns<typeof VISUAL_POST_COLUMNS> extends keyof PostRow
  ? true
  : never = true;
void COLUMNS_ARE_POST_FIELDS;

// prettier-ignore
const FEATURE_COLUMNS = 'ig_id, storage_path, model';

interface FeatureIdentity {
  ig_id: string;
  storage_path: string | null;
  model: string | null;
}

/**
 * Snapshot rows read when ranking scrape recency. Newest-first, so this cap can
 * only ever drop snapshots that would have lost the comparison anyway.
 */
const MAX_SNAPSHOTS_SCAN = 200;

/** Sorts a row whose snapshot is not in the ranking behind every ranked one. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

async function snapshotRecencyRank(): Promise<Map<string, number>> {
  const { data, error } = await supabaseAdmin()
    .from('snapshots')
    .select('id')
    .order('taken_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(MAX_SNAPSHOTS_SCAN);
  if (error) throw new Error(`Could not read snapshots: ${error.message}`);

  const rank = new Map<string, number>();
  for (const row of (data as { id: string }[] | null) ?? []) {
    if (!rank.has(row.id)) rank.set(row.id, rank.size);
  }
  return rank;
}

/** One row per post, newest scrape winning. See /api/board/analyze for the rule. */
function collapseToPosts<T extends PostIdentity>(
  rows: readonly T[],
  rank: Map<string, number>,
): DistinctPostsResult<T> {
  const byRecency = [...rows].sort(
    (a, b) => (rank.get(a.snapshot_id) ?? UNRANKED) - (rank.get(b.snapshot_id) ?? UNRANKED),
  );
  return distinctPosts(byRecency);
}

/**
 * Loudest first — the order this route describes in, so a run that stops half
 * way has bought the posts the Board shows above the fold. The ig_id tie-break
 * keeps two posts on equal engagement in the same order on every request, which
 * Postgres does not promise.
 */
function byEngagement<T extends PostIdentity & { engagement: number }>(posts: readonly T[]): T[] {
  return [...posts].sort(
    (a, b) => b.engagement - a.engagement || (a.ig_id < b.ig_id ? -1 : a.ig_id > b.ig_id ? 1 : 0),
  );
}

interface Candidate {
  ig_id: string;
  account: Account;
  storage_path: string;
}

interface Queue {
  /** Mirrored posts with no description yet, loudest first. */
  pending: Candidate[];
  total: number;
  mirrored: number;
  described: number;
  /**
   * Posts with no object in the bucket. Reported apart from `remaining`,
   * because a post with no mirror is not waiting on a model — it is waiting on
   * a refresh scrape, and no amount of spending here will move it.
   */
  not_mirrored: number;
  /** ig_ids whose shape cannot become an object name. See mirrorPathFor(). */
  unsafe_id: number;
  index_complete: boolean;
  population: {
    rows_fetched: number;
    limit: number;
    truncated: boolean;
    distinct: number;
    duplicates_collapsed: number;
    snapshots_seen: number;
  };
}

/**
 * What is describable, what is described, and what is neither.
 *
 * Not `count: 'exact'` on `posts`: that counts scrape ROWS, and after one
 * re-scrape the same 320 posts would report 640 — a doubled total that the
 * estimate would then quote a doubled dollar figure against. An estimate
 * computed off a double-counted population is a fabricated number arriving by
 * arithmetic, which is worse than an invented one because it looks computed.
 */
async function buildQueue(): Promise<Queue> {
  const db = supabaseAdmin();
  const [rank, postsResult, featuresResult, index] = await Promise.all([
    snapshotRecencyRank(),
    db
      .from('posts')
      .select(VISUAL_POST_COLUMNS)
      .order('engagement', { ascending: false })
      .limit(MAX_POSTS_SCAN),
    db.from('visual_features').select(FEATURE_COLUMNS),
    readMirrorIndex(),
  ]);
  if (postsResult.error) throw new Error(`Could not read posts: ${postsResult.error.message}`);
  if (featuresResult.error) {
    throw new Error(`Could not read visual features: ${featuresResult.error.message}`);
  }

  const rows = (postsResult.data as VisualPostRow[] | null) ?? [];
  const coverage = scanCoverage(rows.length, MAX_POSTS_SCAN);
  const collapsed = collapseToPosts(rows, rank);
  const posts = byEngagement(collapsed.posts);

  // THE LINE THAT DECIDES RE-SPEND, and it is by ig_id: a post described before
  // the last re-scrape has a NEW row with a NEW uuid, so any filter resting on
  // a row id would queue it — and pay for it — all over again.
  const describedIds = new Set<string>();
  for (const feature of (featuresResult.data as FeatureIdentity[] | null) ?? []) {
    // `model` null is a row that exists but has never been read. It is not a
    // description and it must not suppress one.
    if (feature.model !== null) describedIds.add(feature.ig_id);
  }

  const pending: Candidate[] = [];
  let mirrored = 0;
  let described = 0;
  let notMirrored = 0;
  let unsafeId = 0;

  for (const post of posts) {
    const path = mirrorPathFor(post.account, post.ig_id);
    if (path === null) {
      unsafeId += 1;
      continue;
    }
    if (index.names.get(post.account)?.has(post.ig_id) !== true) {
      notMirrored += 1;
      continue;
    }
    mirrored += 1;
    if (describedIds.has(post.ig_id)) {
      described += 1;
      continue;
    }
    pending.push({ ig_id: post.ig_id, account: post.account, storage_path: path });
  }

  return {
    pending,
    total: posts.length,
    mirrored,
    described,
    not_mirrored: notMirrored,
    unsafe_id: unsafeId,
    index_complete: index.complete,
    population: {
      rows_fetched: coverage.rows_fetched,
      limit: coverage.limit,
      truncated: coverage.truncated,
      distinct: posts.length,
      duplicates_collapsed: collapsed.duplicates_collapsed,
      snapshots_seen: collapsed.snapshots_seen,
    },
  };
}

/**
 * The queue as a response body — the pending list itself never goes over the
 * wire.
 *
 * `described_total` is the running total across every run; POST reports this
 * batch's count separately as `described`. The two are different facts and the
 * board analyser keeps them apart under the same pair of names for the same
 * reason: a caller polling for completion needs the total, a caller reporting
 * what just happened needs the batch.
 */
function progressOf(queue: Queue) {
  return {
    total: queue.total,
    mirrored: queue.mirrored,
    described_total: queue.described,
    remaining: queue.pending.length,
    not_mirrored: queue.not_mirrored,
    unsafe_id: queue.unsafe_id,
    index_complete: queue.index_complete,
    population: queue.population,
  };
}

/* ================================================================== routes ==*/

export async function GET() {
  try {
    await requireOperator();
    const quality = await readQuality();
    const model = modelFor(quality);
    const queue = await buildQueue();
    // Priced over `remaining`, which already excludes every post that carries a
    // description, so nothing here re-prices work already bought.
    const estimate = visionCostCeiling(model, queue.pending.length);
    return NextResponse.json({
      ...progressOf(queue),
      estimate,
      spend: checkVisionSpend(estimate),
      provider: resolveProvider(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/visual — describe the next chunk of mirrored, undescribed posts.
 *
 * Chunked and resumable on purpose: 320 images will not fit in one request, and
 * a failure half way through must not lose the work already done. Call it until
 * `remaining` reaches zero.
 */
export async function POST(request: Request) {
  try {
    await requireOperator();

    const provider = resolveProvider();
    if (provider !== 'openrouter') {
      throw new HttpError(
        501,
        `The vision route sends images through OpenRouter, and the resolved provider is "${provider}".`,
        'Set AI_PROVIDER=openrouter and point AI_MODEL_STANDARD at a vision-capable model, or add an image-capable entry point to src/lib/agent/client.ts. Nothing was read and nothing was charged.',
      );
    }
    // Fail here, clearly, rather than four layers down inside a fetch.
    requireEnv(providerKeyName(provider));

    const body = ((await request.json().catch(() => ({}))) ?? {}) as { limit?: unknown };
    const limit =
      typeof body.limit === 'number' && body.limit > 0 && body.limit <= MAX_CHUNK
        ? Math.floor(body.limit)
        : DEFAULT_CHUNK;

    const quality = await readQuality();
    const model = modelFor(quality);
    const db = supabaseAdmin();

    const queue = await buildQueue();
    const batch = queue.pending.slice(0, limit);

    // RULE 9 AND RULE 15, IN THAT ORDER: price the batch, then refuse it if the
    // price is unknown. The refusal happens BEFORE a single object is
    // downloaded, so a blocked run costs nothing at all — not even bandwidth.
    const estimate = visionCostCeiling(model, batch.length);
    const spend = checkVisionSpend(estimate);
    if (!spend.allowed) {
      return NextResponse.json(
        {
          error: spend.reason ?? 'Blocked: this run could not be priced.',
          hint: 'Nothing was read, nothing was downloaded and nothing was charged.',
          blocked: true,
          estimate,
          ...progressOf(queue),
        },
        { status: 409 },
      );
    }

    if (batch.length === 0) {
      return NextResponse.json({
        described: 0,
        failed: 0,
        failures: [],
        estimate,
        usage: { input_tokens: 0, output_tokens: 0 },
        ...progressOf(queue),
      });
    }

    const failures: { ig_id: string; reason: string }[] = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let describedNow = 0;

    // Sequential. Four images is a small batch and the alternative — a worker
    // pool — buys latency at the cost of a concurrency bug in a path that
    // spends money.
    for (const candidate of batch) {
      const object = await db.storage.from(BUCKET).download(candidate.storage_path);
      if (object.error || !object.data) {
        failures.push({
          ig_id: candidate.ig_id,
          reason: `The mirrored object could not be read: ${object.error?.message ?? 'no data'}.`,
        });
        continue;
      }

      const blob = object.data;
      const mediaType = blob.type.split(';')[0].trim().toLowerCase();
      if (!ACCEPTED_MEDIA_TYPES.includes(mediaType)) {
        failures.push({
          ig_id: candidate.ig_id,
          reason: `The mirrored object is stored as "${blob.type || 'no content type'}", which is not one of ${ACCEPTED_MEDIA_TYPES.join(', ')}.`,
        });
        continue;
      }

      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length > MAX_OBJECT_BYTES) {
        failures.push({
          ig_id: candidate.ig_id,
          reason: `The mirrored object is ${bytes.length} bytes, over the ${MAX_OBJECT_BYTES}-byte ceiling.`,
        });
        continue;
      }

      // A data URL, not a signed link. The bucket is private and this keeps it
      // that way: the bytes go to the model and no fetchable URL for the
      // client's creative is minted anywhere (hard rule 4 in spirit).
      const outcome = await describeImage(model, `data:${mediaType};base64,${toBase64(bytes)}`);
      if (!outcome.ok) {
        failures.push({ ig_id: candidate.ig_id, reason: outcome.reason });
        continue;
      }

      usage.input_tokens += outcome.call.usage.input_tokens;
      usage.output_tokens += outcome.call.usage.output_tokens;

      const answer = outcome.call.answer;
      if (answer.unreadable) {
        failures.push({
          ig_id: candidate.ig_id,
          reason: 'The model reported the image as unreadable, so nothing was recorded for it.',
        });
        continue;
      }
      const conflict = contradiction(answer);
      if (conflict !== null) {
        failures.push({ ig_id: candidate.ig_id, reason: `Contradictory answer — ${conflict}` });
        continue;
      }

      const transcription = answer.text_in_image_ar.trim();
      const tags = [
        ...new Set(
          answer.composition_tags.map((tag) => tag.trim()).filter((tag) => tag !== ''),
        ),
      ].slice(0, MAX_COMPOSITION_TAGS);

      // Written out column by column, never spread from the model's object.
      // dominant_colors and palette_match are ABSENT from this payload on
      // purpose: they are measured from the pixels by src/lib/vision/colors.ts
      // and checked by the Law, and a model never supplies a colour (rule 13,
      // and the same instinct as hard rule 11). PostgREST's upsert sets only
      // the columns present in the payload, so a colour pass that has already
      // run keeps its values when this route re-describes a row.
      const { error: writeError } = await db.from('visual_features').upsert(
        {
          ig_id: candidate.ig_id,
          account: candidate.account,
          storage_path: candidate.storage_path,
          has_face: answer.has_face,
          face_prominence: answer.face_prominence,
          // Null means "the image carries no text", which `text_coverage:
          // "none"` states alongside it; the row-level "nobody has read this"
          // absence is `model: null`, which this write is in the act of
          // removing. The two absences stay distinguishable.
          text_in_image_ar: transcription === '' ? null : transcription,
          text_coverage: answer.text_coverage,
          logo_present: answer.logo_present,
          composition_tags: tags,
          model,
          // Every field above is a transcription or a classification of an
          // image that was actually opened and read. That is data.
          grounding: 'data',
        },
        { onConflict: 'ig_id' },
      );

      if (writeError) {
        failures.push({
          ig_id: candidate.ig_id,
          reason: `The description could not be saved: ${writeError.message}`,
        });
        continue;
      }

      describedNow += 1;
    }

    const after = await buildQueue();
    return NextResponse.json({
      described: describedNow,
      failed: failures.length,
      failures,
      estimate,
      // What the vendor actually reported, beside what was estimated before the
      // run. The ceiling is a bound; this is the bill.
      usage,
      ...progressOf(after),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
