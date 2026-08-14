import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { readQuality } from '@/lib/prefs.server';
import { runAgentJson, modelFor } from '@/lib/agent/client';
import { SYSTEM_PROMPT } from '@/lib/agent/system';
import { computeFor, computeStats, type BoardStats, type ComputedAnalysis } from '@/lib/board/compute';
import {
  distinctPosts,
  scanCoverage,
  MAX_POSTS_SCAN,
  type DistinctPostsResult,
  type PostIdentity,
} from '@/lib/audience/posts';
import type { PostRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/* ------------------------------------------------------------- what we read --
 *
 * Both reads name their columns. The POST handler's read used to be
 * `select('*')`, which since migration 0002 has meant pulling `posts.raw` — the
 * complete Apify item, with the monitor's `addParentData` parent-profile blob
 * inside it — for up to 2000 rows into a serverless function's memory, in order
 * to read four fields off each one. `raw` is sacred in the TABLE (hard rule 8);
 * it is not an input to this route.
 *
 * Each list is one string LITERAL: PostgREST parses the column list at the type
 * level, and a value merely typed `string` (a concatenation, a `join()`)
 * resolves to an error type instead of to rows.
 */
// prettier-ignore
const ANALYZE_POST_COLUMNS = 'id, snapshot_id, account, ig_id, caption, media_type, engagement, posted_at';

/** The progress read needs only enough to collapse and to join an analysis. */
// prettier-ignore
const PROGRESS_POST_COLUMNS = 'id, ig_id, snapshot_id, posted_at';

/** Splits `'a, b, c'` into the union `'a' | 'b' | 'c'`. */
type SplitColumns<S extends string> = S extends `${infer Head}, ${infer Rest}`
  ? Head | SplitColumns<Rest>
  : S;

/** A post row as the analyser reads it: the columns above, and nothing else. */
type AnalyzePostRow = Pick<PostRow, SplitColumns<typeof ANALYZE_POST_COLUMNS> & keyof PostRow>;

/** The row `progress()` reads: enough to collapse, enough to join an analysis. */
type ProgressRow = Pick<PostRow, SplitColumns<typeof PROGRESS_POST_COLUMNS> & keyof PostRow>;

/**
 * Compile-time proof that every name in both select lists is a real column. A
 * typo would otherwise cost a field silently — PostgREST would not return it and
 * `Pick` would quietly drop it. Here it is a build failure instead.
 */
const COLUMNS_ARE_POST_FIELDS: SplitColumns<
  typeof ANALYZE_POST_COLUMNS | typeof PROGRESS_POST_COLUMNS
> extends keyof PostRow
  ? true
  : never = true;
void COLUMNS_ARE_POST_FIELDS;

/**
 * `computeStats` and `computeFor` are declared over `PostRow`, but read only
 * `account`, `media_type`, `engagement` and `posted_at`
 * (src/lib/board/compute.ts:25-64) — every one of them in ANALYZE_POST_COLUMNS.
 * Narrowing what they accept is what lets the row type stay honest about the
 * columns actually read, instead of widening the rows to a `PostRow` and
 * claiming a `raw` this query deliberately did not fetch. compute.ts is outside
 * this task's scope; the durable fix is to declare its parameters as the subset
 * they use.
 */
const statsOf = computeStats as (posts: readonly AnalyzePostRow[]) => BoardStats;
const computeForPost = computeFor as (
  post: AnalyzePostRow,
  posts: readonly AnalyzePostRow[],
  stats: BoardStats,
) => ComputedAnalysis;

/* ------------------------------------------------------------- the prompt --- */

/**
 * Where the prompt builder slices a caption. Named because the estimate below
 * needs the same number: change one and the other follows.
 */
const CAPTION_PROMPT_CHARS = 400;

/** The output ceiling this route sets on every request it makes. */
const MAX_OUTPUT_TOKENS = 16_000;

/** Posts per request when the body names no limit — and what the Board sends. */
const DEFAULT_CHUNK = 25;

/** What separates two post blocks in the listing. */
const BLOCK_SEPARATOR = '\n\n---\n\n';

/** The fields of a post that reach the model. */
type PromptPost = Pick<AnalyzePostRow, 'id' | 'account' | 'media_type' | 'engagement' | 'caption'>;

/** One post's block in the prompt. The only place a caption is truncated. */
function postBlock(post: PromptPost, computed: ComputedAnalysis): string {
  return (
    `id: ${post.id}\naccount: ${post.account} · format: ${post.media_type ?? 'unknown'}\n` +
    `engagement: ${post.engagement} (×${computed.vs_account_avg} account avg, ×${computed.vs_format_avg} format avg, P${computed.percentile})\n` +
    `caption: ${post.caption ? post.caption.slice(0, CAPTION_PROMPT_CHARS) : '(none)'}`
  );
}

/** Everything after the listing: fixed per request, whatever the batch size. */
const TASK_LINES = [
  '## Task',
  'For each post, give a cluster_label and a short explanation, in Arabic.',
  '',
  'Rules specific to this task:',
  '- cluster_label groups the post with others like it by subject and angle (e.g. «سؤال سلوكي», «اقتباس شعري»). Reuse labels across posts — that is the point of a cluster.',
  '- explanation_ar explains the PATTERN the post belongs to, not the post. A causal story about one post is forbidden: with a single data point you cannot know why it performed, and saying so anyway is exactly the fabrication this app exists to prevent.',
  '- Refer to the cluster when explaining: "منشورات هذا النمط تميل إلى…".',
  '- Set grounding to "data" only when the comparatives above support the claim. Otherwise "hypothesis".',
  '- Do not restate the engagement numbers; they are already computed and displayed.',
  '- Return one entry per post id, using the ids exactly as given.',
  '',
  '## Response schema',
  '{"warnings":["string"],"analyses":[{"post_id":"string","cluster_label":"string","explanation_ar":"string","grounding":"data|hypothesis"}]}',
];

/** The whole user message. `listing` is the only part that grows with the batch. */
function userMessage(listing: string): string {
  return ['<posts_to_analyse>', listing, '</posts_to_analyse>', '', ...TASK_LINES].join('\n');
}

/* ------------------------------------------------------------ the estimate --
 *
 * Hard rule 9 is estimate before spend; hard rule 2 is that a number put in
 * front of the operator as money carries its source, its date and its
 * derivation. The two constants that used to live here — 700 input tokens and
 * 130 output tokens per post — had none of the three, and the figure built on
 * them was rendered as "~$0.42".
 *
 * What replaces them is a CEILING, and every step of it is either measured from
 * the strings this route actually sends or is a published rate with a URL and a
 * read date. Rounding is upward throughout and the screen says "at most", which
 * is the direction src/lib/ingest/budget.ts also chooses when it assumes the
 * free (most expensive) Apify plan: for a spend guard, over-stating is the safe
 * way to be wrong. Exactly one input is an assumption rather than a measurement
 * — CHARS_PER_TOKEN — and it travels to the screen with the number.
 */

/**
 * Characters per token. THIS IS AN ASSUMPTION, not a measurement: the only way
 * to know a prompt's token count is to tokenise it, which needs the vendor's
 * tokeniser, which this app does not have.
 *
 * 2 is chosen to over-estimate rather than under-estimate. Latin prose runs
 * nearer 4 characters per token on the tokenisers these vendors publish; Arabic
 * script — which is what the captions are — tokenises far denser, and a caption
 * is the bulk of every post block. Halving the divisor doubles the token count
 * and therefore the quoted ceiling, which is the error direction a spend guard
 * wants. It is surfaced on screen as an assumption so the number is never read
 * as a quote.
 */
const CHARS_PER_TOKEN = 2;

/** The system prompt plus the wrapper: what every request pays regardless of batch. */
const FIXED_PROMPT_CHARS = SYSTEM_PROMPT.length + userMessage('').length;

/**
 * The widest post block this route can build, measured by building one.
 *
 * Each placeholder is at or above the widest real value: `id` is a Postgres
 * uuid, which is exactly 36 characters in text form; `account` is the longer of
 * the two enum values; `caption` is the slice above, the point at which
 * postBlock() itself truncates. `media_type` is free text from the scraper and
 * the engagement and ratio figures are unbounded in the schema, so those three
 * get generous allowances rather than measurements — they are allowances in the
 * open, not silently-assumed zeroes.
 */
const PER_POST_PROMPT_CHARS =
  postBlock(
    {
      id: 'x'.repeat(36),
      account: 'personal',
      media_type: 'x'.repeat(24),
      engagement: 99_999_999,
      caption: 'x'.repeat(CAPTION_PROMPT_CHARS),
    },
    { vs_account_avg: 99.99, vs_format_avg: 99.99, percentile: 100, days_old: null },
  ).length + BLOCK_SEPARATOR.length;

interface TokenRate {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
}

/**
 * Published list prices, USD per MILLION tokens, copied from
 * https://platform.claude.com/docs/en/about-claude/models/overview — read
 * 2026-08-14.
 *
 * Only rates read from that page are recorded here. A model with no verified
 * rate is absent, and absence produces a null estimate rather than an invented
 * number — the same contract src/lib/ingest/budget.ts keeps for the Apify
 * actors, and the reason the OpenRouter model ids this app can be pointed at
 * (openai/…, google/…) are NOT listed: nobody has read their price pages into
 * this file, so this route cannot honestly price them.
 */
const PUBLISHED_RATES: Record<string, TokenRate> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

/**
 * Claude Sonnet 5 is on introductory pricing of $2 / $10 per million tokens
 * "through 2026-08-31" (same page, same read date).
 *
 * A discount with an expiry is stored WITH its expiry. Hard-coding 2 and 10 —
 * which is what this file used to do — is correct today and silently
 * under-quotes the operator from the first of September, which is the same
 * class of defect as an invented constant: a number that looks computed and is
 * wrong. After the date the standard rate applies on its own.
 */
const SONNET_5_INTRO = { rate: { in: 2, out: 10 }, through: '2026-08-31' };

/** Today in UTC as `YYYY-MM-DD`, which is how the expiry above is written. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** OpenRouter writes `anthropic/claude-opus-5`; the first-party SDK writes the bare id. */
function normaliseModel(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** The published rate for a model, or null when this file has not verified one. */
function rateFor(model: string): TokenRate | null {
  const key = normaliseModel(model);
  if (key === 'claude-sonnet-5' && todayIso() <= SONNET_5_INTRO.through) return SONNET_5_INTRO.rate;
  if (!Object.hasOwn(PUBLISHED_RATES, key)) return null;
  return PUBLISHED_RATES[key];
}

/** Rounds UP to the next cent, so a ceiling never reads below what it bounds. */
function ceilToCents(value: number): number {
  // toFixed first: binary floating point turns exact cents into 2.7000000000003
  // and a naive ceil would push $2.70 to $2.71.
  return Math.ceil(Number((value * 100).toFixed(6))) / 100;
}

/**
 * An upper bound on what analysing `posts` posts costs, with everything the
 * screen needs to state what the bound assumes.
 */
export interface CostCeiling {
  /** Upper bound in USD, or null when the model has no verified rate. Never 0. */
  usd: number | null;
  model: string;
  /** Requests this many posts take at the chunk size the Board sends. */
  requests: number;
  /** Prompt characters, measured — the divisor below turns them into tokens. */
  prompt_chars: number;
  input_tokens: number;
  /** requests × the token ceiling this route sets. Not a guess: a hard limit. */
  output_tokens: number;
  chars_per_token: number;
  rate_in_per_mtok: number | null;
  rate_out_per_mtok: number | null;
  /** Why `usd` is null. Null when it is not. */
  unpriced_reason: string | null;
}

function costCeiling(model: string, posts: number): CostCeiling {
  const count = Number.isFinite(posts) && posts > 0 ? Math.ceil(posts) : 0;
  const requests = Math.ceil(count / DEFAULT_CHUNK);
  const promptChars = requests * FIXED_PROMPT_CHARS + count * PER_POST_PROMPT_CHARS;
  const inputTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  // The model is free to write anything up to the ceiling this route passes to
  // runAgentJson(), and how much it will actually write is not knowable before
  // the run. The ceiling is the only bound the code guarantees, so the ceiling
  // is what gets priced.
  const outputTokens = requests * MAX_OUTPUT_TOKENS;

  const base = {
    model,
    requests,
    prompt_chars: promptChars,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    chars_per_token: CHARS_PER_TOKEN,
  };

  const rate = rateFor(model);
  if (rate === null) {
    return {
      ...base,
      usd: null,
      rate_in_per_mtok: null,
      rate_out_per_mtok: null,
      unpriced_reason:
        `No published per-token rate has been verified for "${model}", so the cost cannot be ` +
        'estimated. Add one to src/app/api/board/analyze/route.ts with the vendor’s price page ' +
        'in front of you.',
    };
  }

  return {
    ...base,
    usd: ceilToCents((inputTokens * rate.in) / 1_000_000 + (outputTokens * rate.out) / 1_000_000),
    rate_in_per_mtok: rate.in,
    rate_out_per_mtok: rate.out,
    unpriced_reason: null,
  };
}

const analysisSchema = z.object({
  warnings: z.array(z.string()),
  analyses: z
    .array(
      z.object({
        post_id: z.string(),
        cluster_label: z.string().min(1),
        explanation_ar: z.string().min(1),
        grounding: z.enum(['data', 'hypothesis']),
      }),
    )
    .min(1),
});

/**
 * Snapshot rows read when ranking scrape recency. The read is newest-first, so
 * this cap can only ever drop snapshots that would have lost the comparison.
 */
const MAX_SNAPSHOTS_SCAN = 200;

/** Sorts a row whose snapshot is not in the ranking behind every ranked one. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Scrape recency as a rank: newest snapshot 0, the one before it 1, and so on.
 *
 * A post row carries no timestamp of its own — `posted_at` is when the post was
 * published, identical in every re-scrape — so the only place scrape recency
 * lives is `snapshots.taken_on`. distinctPosts() ranks snapshots by the order
 * rows reach it, which puts that ordering on the caller: this is that ordering.
 */
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

/**
 * One row per post, newest scrape winning. The recency sort is what makes the
 * winner deterministic; `Array.prototype.sort` is stable, so rows from the same
 * snapshot keep the order the query returned them in.
 */
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
 * Loudest first — the order this route analyses in, and the order the recency
 * sort above destroyed. The ig_id tie-break keeps two posts on equal engagement
 * in the same order on every request, which Postgres does not promise.
 */
function byEngagement<T extends PostIdentity & { engagement: number }>(posts: readonly T[]): T[] {
  return [...posts].sort(
    (a, b) =>
      b.engagement - a.engagement || (a.ig_id < b.ig_id ? -1 : a.ig_id > b.ig_id ? 1 : 0),
  );
}

/* -------------------------------------- what is already analysed, by POST --- */

interface AnalysisCoverage {
  /** ig_ids carrying at least one analysis — the set that decides re-spend. */
  igIds: Set<string>;
  /** The raw `posts.id` values the analyses cite, for the current/superseded split. */
  rowIds: Set<string>;
  /** Analyses whose post row was not in this read: truncated scan, or row gone. */
  unresolved: number;
}

/**
 * Resolves `post_analyses.post_id` — a `posts.id`, i.e. a scrape ROW — to the
 * Instagram post it describes.
 *
 * `posts` is UNIQUE (snapshot_id, ig_id), so a re-scrape gives every post a
 * SECOND row with a NEW uuid, and distinctPosts() hands the win to that new row.
 * Matched by row id, an analysis written before the re-scrape therefore belongs
 * to nothing the board shows: `analyzed` collapses to 0, `remaining` snaps back
 * to the full count, and the confirm dialog quotes the operator for the entire
 * board — for work already paid for, still sitting in `post_analyses`, invisible.
 *
 * Matching by ig_id instead is a pure code fix: the rows this request already
 * read carry both ids, so the join exists in memory. (A `post_analyses.ig_id`
 * column would have to be backfilled from exactly this map, so the migration
 * would depend on the code, not replace it.)
 */
function coverAnalyses(
  analysisPostIds: readonly string[],
  igIdByRowId: ReadonlyMap<string, string>,
): AnalysisCoverage {
  const igIds = new Set<string>();
  const rowIds = new Set<string>();
  let unresolved = 0;

  for (const postId of analysisPostIds) {
    const igId = igIdByRowId.get(postId);
    if (igId === undefined) {
      unresolved += 1;
      continue;
    }
    igIds.add(igId);
    rowIds.add(postId);
  }

  return { igIds, rowIds, unresolved };
}

/**
 * How much of the board is analysed, counted in POSTS.
 *
 * Not `count: 'exact'` on either table. `posts` is UNIQUE (snapshot_id, ig_id),
 * so a head count of it counts scrape rows: after one re-scrape the same 320
 * posts report a total of 640 and the screen reads "320/640 analysed". Worse,
 * `remaining` is what GET hands to the estimate, so a doubled total quotes the
 * operator a doubled dollar figure — an estimate computed off a double-counted
 * population is a fabricated number, and hard rule 9 says the block must show a
 * real one.
 *
 * `analyzed` is counted over the same population and resolved through ig_id, so
 * this identity holds: remaining = total - analyzed = exactly the posts POST
 * below will pick up. The current/superseded split is reported beside it because
 * they are different facts — a post whose analysis was computed against an
 * earlier scrape has been paid for and is shown, but its stored comparatives are
 * frozen at that older population, which is why the card carries a date.
 */
async function progress() {
  const db = supabaseAdmin();
  const [rank, postsResult, analysesResult] = await Promise.all([
    snapshotRecencyRank(),
    db
      .from('posts')
      .select(PROGRESS_POST_COLUMNS)
      .order('engagement', { ascending: false })
      .limit(MAX_POSTS_SCAN),
    db.from('post_analyses').select('post_id'),
  ]);
  if (postsResult.error) throw new Error(`Could not read posts: ${postsResult.error.message}`);
  if (analysesResult.error) {
    throw new Error(`Could not read analyses: ${analysesResult.error.message}`);
  }

  const rows = (postsResult.data as ProgressRow[] | null) ?? [];
  const coverage = scanCoverage(rows.length, MAX_POSTS_SCAN);
  const population = collapseToPosts(rows, rank);

  // Built from the PRE-collapse rows: the row a superseded analysis cites is the
  // one the collapse discarded, and that row is the only place its ig_id is.
  const igIdByRowId = new Map<string, string>();
  for (const row of rows) igIdByRowId.set(row.id, row.ig_id);

  const cover = coverAnalyses(
    ((analysesResult.data as { post_id: string }[] | null) ?? []).map((r) => r.post_id),
    igIdByRowId,
  );

  const total = population.posts.length;
  let current = 0;
  let superseded = 0;
  for (const post of population.posts) {
    if (!cover.igIds.has(post.ig_id)) continue;
    if (cover.rowIds.has(post.id)) current += 1;
    else superseded += 1;
  }
  const analyzed = current + superseded;

  return {
    total,
    analyzed,
    /** …of which the analysis hangs off the row the board now displays. */
    analyzed_current: current,
    /** …and of which it was written against an earlier scrape of the same post. */
    analyzed_superseded: superseded,
    remaining: total - analyzed,
    /** Analyses this read could not place. Stated, not folded into "unanalysed". */
    unresolved_analyses: cover.unresolved,
    /**
     * The population those counts are made of. `truncated` means the read filled
     * its cap, so `total` is a floor and the estimate covers only what was seen —
     * stated, never presented as the whole board.
     */
    population: {
      rows_fetched: coverage.rows_fetched,
      limit: coverage.limit,
      truncated: coverage.truncated,
      distinct: total,
      duplicates_collapsed: population.duplicates_collapsed,
      snapshots_seen: population.snapshots_seen,
    },
  };
}

export async function GET() {
  try {
    await requireOperator();
    const quality = await readQuality();
    const p = await progress();
    // `remaining` is posts, not rows, and it excludes posts that already carry an
    // analysis under any scrape row — so nothing here re-prices work already
    // bought. `p.population` travels with it so the screen can say what the
    // ceiling was priced over.
    return NextResponse.json({ ...p, estimate: costCeiling(modelFor(quality), p.remaining) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/board/analyze — analyse the next chunk of unanalysed posts.
 *
 * Chunked and resumable on purpose: 320 posts will not fit in one request, and
 * a failure halfway through must not lose the work already done. Call it until
 * `remaining` reaches zero.
 *
 * The division of labour is the same as everywhere else in this app: the
 * comparatives are computed here in code from real rows, and the model is only
 * ever asked to name the pattern. It is explicitly forbidden from telling a
 * causal story about a single post — with n=1 that is astrology, not analysis.
 */
export async function POST(request: Request) {
  try {
    await requireOperator();
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { limit?: unknown };
    const limit =
      typeof body.limit === 'number' && body.limit > 0 && body.limit <= 50
        ? Math.floor(body.limit)
        : DEFAULT_CHUNK;

    const quality = await readQuality();
    const db = supabaseAdmin();

    const [rank, postsResult, doneResult] = await Promise.all([
      snapshotRecencyRank(),
      db
        .from('posts')
        .select(ANALYZE_POST_COLUMNS)
        .order('engagement', { ascending: false })
        .limit(MAX_POSTS_SCAN),
      db.from('post_analyses').select('post_id'),
    ]);
    if (postsResult.error) throw new Error(`Could not read posts: ${postsResult.error.message}`);
    if (doneResult.error) throw new Error(`Could not read analyses: ${doneResult.error.message}`);

    // Rows collapse to posts before anything is chunked or compared. Without
    // this a re-scraped post is queued for analysis once per snapshot — the
    // model is paid twice to describe the same post — and computeStats() below
    // would average every duplicated post in twice, so the comparatives put in
    // front of it would be arithmetic over a population that does not exist.
    const scanRows = (postsResult.data as AnalyzePostRow[] | null) ?? [];
    const collapsed = collapseToPosts(scanRows, rank);
    const allPosts = byEngagement(collapsed.posts);

    const igIdByRowId = new Map<string, string>();
    for (const row of scanRows) igIdByRowId.set(row.id, row.ig_id);

    // By ig_id, not by row id: a post analysed before the last re-scrape has a
    // NEW winning row with a NEW uuid, and filtering on row id would queue it —
    // and charge for it — all over again.
    const cover = coverAnalyses(
      ((doneResult.data as { post_id: string }[] | null) ?? []).map((r) => r.post_id),
      igIdByRowId,
    );
    const pending = allPosts.filter((post) => !cover.igIds.has(post.ig_id)).slice(0, limit);

    if (pending.length === 0) {
      const state = await progress();
      // `analyzed` is this batch's count; `analyzed_total` is the running total.
      return NextResponse.json({
        analyzed: 0,
        failed: 0,
        remaining: state.remaining,
        total: state.total,
        analyzed_total: state.analyzed,
        population: state.population,
      });
    }

    const stats = statsOf(allPosts);

    const rows = pending.map((post) => ({
      post,
      computed: computeForPost(post, allPosts, stats),
    }));

    const listing = rows
      .map(({ post, computed }) => postBlock(post, computed))
      .join(BLOCK_SEPARATOR);

    const run = await runAgentJson({
      quality,
      maxTokens: MAX_OUTPUT_TOKENS,
      schema: analysisSchema,
      userMessage: userMessage(listing),
    });

    const byId = new Map(rows.map((r) => [r.post.id, r.computed]));
    const inserts = run.value.analyses.flatMap((a) => {
      const computed = byId.get(a.post_id);
      if (computed === undefined) return [];
      return [
        {
          post_id: a.post_id,
          // Written out field by field rather than cast: `computed` is the
          // arithmetic this app stands behind, and the column it lands in is
          // jsonb, so the shape crossing that boundary is stated here.
          computed: {
            vs_account_avg: computed.vs_account_avg,
            vs_format_avg: computed.vs_format_avg,
            percentile: computed.percentile,
            days_old: computed.days_old,
          },
          cluster_label: a.cluster_label,
          explanation: a.explanation_ar,
          grounding: a.grounding,
          model: run.model,
        },
      ];
    });

    if (inserts.length > 0) {
      const { error: insertError } = await db
        .from('post_analyses')
        .upsert(inserts, { onConflict: 'post_id' });
      if (insertError) throw new Error(`Could not save analyses: ${insertError.message}`);
    }

    const state = await progress();
    return NextResponse.json({
      analyzed: inserts.length,
      failed: pending.length - inserts.length,
      warnings: run.value.warnings,
      remaining: state.remaining,
      total: state.total,
      analyzed_total: state.analyzed,
      population: state.population,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
