import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { readQuality } from '@/lib/prefs.server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { accountSchema } from '@/lib/agent/schemas';
import { audienceFeature, MAX_CORPUS, type CorpusComment } from '@/lib/agent/features/audience';
import { distinctPosts, scanCoverage, MAX_POSTS_SCAN, type PostIdentity } from '@/lib/audience/posts';
import type { Account, AudienceInsightRow } from '@/lib/types/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const requestSchema = z.object({
  account: z.union([accountSchema, z.literal('all')]).default('all'),
  /** How many comments to read. The cap is the feature's prompt budget. */
  limit: z.number().int().positive().max(MAX_CORPUS).default(MAX_CORPUS),
});

/**
 * A post row as this route reads it: the join key and the URL a quote links to,
 * plus the identity columns distinctPosts() needs to tell posts from re-scrapes.
 */
interface PostIndexRow extends PostIdentity {
  id: string;
  url: string | null;
  account: Account;
}

/**
 * A comment row as this route reads it. `posted_at` is selected but never sent
 * onward: it is the column the read is ORDERED by, and the batched read below
 * has to reproduce that ordering in code once the rows arrive in pieces.
 */
interface CommentIndexRow {
  id: string;
  post_id: string | null;
  posted_at: string | null;
  text_content: string;
}

/** The service-role client, named so helpers can take it without a cast. */
type AdminClient = ReturnType<typeof supabaseAdmin>;

/**
 * `in (…)` batch size — keeps the PostgREST query string short.
 *
 * The same number, for the same reason, as ID_BATCH in /api/comments. A uuid is
 * 36 characters and an encoded comma is 3 more, so 40 ids is roughly 1.5 KB of
 * query string — well inside the ~8 KB request-line ceiling that typically sits
 * in front of PostgREST. Unbatched, the scoped read sends one id per post ROW,
 * and `posts` is UNIQUE (snapshot_id, ig_id): the personal segment is ~190 rows
 * (~7.4 KB) with one snapshot stored, and every monitor run adds another row per
 * surviving post. The first re-scrape would push that read over the limit.
 *
 * Declared here rather than imported from /api/comments because a route module
 * is an entry point, not a library; the shared home would be a lib module, which
 * is outside this change's scope.
 */
const ID_BATCH = 40;

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
 * published, identical in every re-scrape of it — so the only place scrape
 * recency lives is `snapshots.taken_on`. distinctPosts() ranks snapshots by the
 * order rows reach it, which puts that ordering on the caller: this is that
 * ordering. The same read, for the same reason, as /api/board, /api/comments and
 * the audience feature's own timing collapse.
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
 * `posted_at` as a sortable instant. A value Date.parse cannot read is treated
 * as undated rather than ranked on a number nobody can vouch for; a timestamptz
 * column cannot produce one, so this is defensive only.
 */
function postedAtMs(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The query's ORDER BY, in code: newest first, undated last, ties broken by id.
 *
 * Comparison is on the parsed instant, not on the text, so this orders rows the
 * way Postgres ordered them whatever textual form PostgREST rendered them in.
 * The id tie-break is a string compare because Postgres emits uuids in canonical
 * lowercase hex, where byte order and lexicographic order agree.
 */
function byNewestThenId(a: CommentIndexRow, b: CommentIndexRow): number {
  const at = postedAtMs(a.posted_at);
  const bt = postedAtMs(b.posted_at);
  if (at !== bt) {
    if (at === null) return 1; // undated sorts last, never first
    if (bt === null) return -1;
    return bt - at;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The comment corpus: the newest `limit` comments, for one account's post rows
 * or for every stored comment when `postIds` is null.
 *
 * WHY THE SCOPED READ IS BATCHED. `postIds` holds one uuid per post ROW, and
 * `posts` is UNIQUE (snapshot_id, ig_id), so that list grows by the size of the
 * account on every monitor run — see ID_BATCH above for the arithmetic. This is
 * the same batching /api/comments does over the same table.
 *
 * WHY THE BATCHED RESULT IS THE UNBATCHED ONE. Every batch is read with the SAME
 * ordering and the SAME cap, so a comment in the global newest-`limit` is
 * necessarily inside its own batch's newest-`limit`: at most `limit` - 1
 * comments are newer than it overall, hence at most that many are newer than it
 * within any subset. The union therefore contains every row one big query would
 * have returned, and re-applying the same order and the same cap selects the
 * same rows in the same order.
 *
 * The id tie-break is in the query AND in the merge, and is why "the same order"
 * is a fact rather than a hope: `posted_at` alone leaves ties unordered in
 * Postgres, so the boundary of the cap — which comments make the corpus the
 * model reads — would otherwise be free to differ between two runs over
 * identical rows.
 */
async function readCorpusRows(
  db: AdminClient,
  postIds: readonly string[] | null,
  limit: number,
): Promise<CommentIndexRow[]> {
  const batches: (readonly string[] | null)[] =
    postIds === null
      ? [null]
      : Array.from({ length: Math.ceil(postIds.length / ID_BATCH) }, (_, index) =>
          postIds.slice(index * ID_BATCH, index * ID_BATCH + ID_BATCH),
        );

  const merged: CommentIndexRow[] = [];
  for (const batch of batches) {
    const selection = db.from('comments').select('id, post_id, posted_at, text_content');
    // Newest first: a truncated corpus should be the most recent conversation,
    // not an arbitrary slice. `capped_at` in the response says it was truncated.
    const { data, error } = await (batch === null ? selection : selection.in('post_id', batch))
      .order('posted_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`Could not read comments: ${error.message}`);
    merged.push(...((data as CommentIndexRow[] | null) ?? []));
  }

  // A single batch came back from the database already in this order and already
  // capped, so the sort is a no-op there — one code path rather than two, and
  // the merge rule is stated once.
  return merged.sort(byNewestThenId).slice(0, limit);
}

/* ------------------------------------------------ the population, persisted -- */

/**
 * One capped read of `posts`, in BOTH units: scrape rows returned, and the posts
 * they collapse to once re-scrapes of the same ig_id are merged. `truncated`
 * means the read filled its cap, so the figures describe a PREFIX of the table.
 *
 * There is deliberately no "rows missing" member: what a capped query never saw
 * is unknowable from its result, so a consumer says "the first N rows" and never
 * "N of M".
 */
const populationScanSchema = z.object({
  rows_fetched: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  truncated: z.boolean(),
  posts: z.number().int().nonnegative(),
  duplicates_collapsed: z.number().int().nonnegative(),
  snapshots_seen: z.number().int().nonnegative(),
});

/**
 * What one run covered, written onto the row that run produced.
 *
 * WHY THIS IS STORED AND NOT RECOMPUTED. These are facts about the rows that
 * were read at generation time. A read of `posts` performed later describes the
 * table as it stands later — a different row set, after further scrapes — so
 * presenting it as the frame around stored numbers would be a fabricated number
 * arriving by arithmetic. The population therefore travels WITH the insight or
 * not at all; a row that lacks it is reported as unknown, never re-derived.
 *
 * It rides inside the existing `timing` jsonb under `population`, which is
 * additive and needs no migration. The whole object is the run's coverage, not
 * the timing grid's alone, which is why `comments` and `post_index` sit beside
 * `timing_posts` rather than being scattered.
 */
const storedPopulationSchema = z.object({
  /** The scope the corpus was read under — part of what the report covers. */
  account: z.union([accountSchema, z.literal('all')]),
  comments: z.object({
    /** Comments that reached the model, after unattributed ones were dropped. */
    read: z.number().int().nonnegative(),
    cap: z.number().int().positive(),
    /** The read filled its cap, so it is the newest slice, not the whole set. */
    truncated: z.boolean(),
    /** Read but left out: no post to hang a quote's provenance on. */
    unattributed: z.number().int().nonnegative(),
  }),
  /** The read that gave the quotes their source links. */
  post_index: populationScanSchema,
  /** The read every figure in the timing grid was computed over. */
  timing_posts: populationScanSchema,
});

type StoredAudiencePopulation = z.infer<typeof storedPopulationSchema>;

/** How the population is nested inside the `timing` jsonb, for reading it back. */
const storedTimingEnvelopeSchema = z.object({ population: storedPopulationSchema });

/**
 * The half of `persist()`'s return this route has to reach into. `persist` is
 * typed `unknown` by the feature contract, so it is parsed rather than cast —
 * `.passthrough()` keeps every other key intact so the response still carries
 * the full payload the feature built.
 */
const persistedSchema = z
  .object({
    insight: z
      .object({
        id: z.string().min(1),
        /** null would leave nowhere to attach the population — see below. */
        timing: z.record(z.unknown()).nullable(),
      })
      .passthrough(),
    posts_population: populationScanSchema,
  })
  .passthrough();

/**
 * POST /api/audience — read the comment corpus, run the audience feature, and
 * store the result in audience_insights.
 *
 * The corpus is assembled here rather than inside the feature because a
 * feature's buildPrompt is synchronous. Only `text_content` and the post it
 * hangs off travel onwards: author handles stay in the database (hard rule 10).
 *
 * Two populations are involved and they are not the same size. `posts` is
 * UNIQUE (snapshot_id, ig_id), so its rows are post-per-snapshot: the response
 * reports the row count AND the post count it collapses to, plus whether either
 * read hit its cap. A population that was quietly cut short is the same class of
 * lie as an invented figure, so nothing here reports a prefix as a total.
 *
 * The same facts are also written onto the stored insight, because a screen that
 * loads a stored report gets no run to read them from — see GET.
 */
export async function POST(request: Request) {
  try {
    await requireOperator();

    const body: unknown = await request.json().catch(() => ({}));
    const parsed = requestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new HttpError(
        400,
        'Invalid request body.',
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      );
    }
    const { account, limit } = parsed.data;

    const db = supabaseAdmin();

    // Ordered and capped rather than unbounded: this index is the only thing
    // that attaches a comment to its post, so a read that silently stopped at
    // the database's default page would drop comments out of the corpus without
    // saying so. Newest posts first, so that if the cap is ever reached what
    // survives is the recent conversation and `posts.truncated` says it happened.
    const [snapshotRank, { data: postData, error: postsError }] = await Promise.all([
      snapshotRecencyRank(),
      db
        .from('posts')
        .select('id, url, account, ig_id, snapshot_id, posted_at')
        .order('posted_at', { ascending: false, nullsFirst: false })
        .limit(MAX_POSTS_SCAN),
    ]);
    if (postsError) throw new Error(`Could not read posts: ${postsError.message}`);
    const postRows = (postData as PostIndexRow[] | null) ?? [];
    const coverage = scanCoverage(postRows.length, MAX_POSTS_SCAN);

    // How many POSTS those rows are. `posts` is UNIQUE (snapshot_id, ig_id), so
    // a re-scraped post occupies one row per snapshot and the row count is not a
    // post count. Reported, not used as a filter — see the two maps below.
    //
    // The rows are re-ordered by scrape recency FIRST, on a copy, exactly as
    // /api/board, /api/comments and the audience feature do. distinctPosts()
    // ranks snapshots by the order rows reach it, and the read above is ordered
    // by `posted_at` — which is identical in every re-scrape of a post, so
    // Postgres is free to return the copies in any order it likes and the
    // surviving row would be whichever one it happened to hand back first. The
    // counts are the same either way; the winning ROW is not, and the moment
    // anything downstream reads a column off it that arbitrariness becomes a
    // number. The copy keeps `postRows` in publish order for the two maps below.
    const byScrapeRecency = [...postRows].sort(
      (a, b) =>
        (snapshotRank.get(a.snapshot_id) ?? UNRANKED) -
        (snapshotRank.get(b.snapshot_id) ?? UNRANKED),
    );
    const postIndexPopulation = distinctPosts(byScrapeRecency, { newestSnapshotFirst: true });

    // Both of these are keyed by `posts.id`, and `comments.post_id` references
    // that column — the row, not the Instagram post. A comment scraped under one
    // snapshot's row keeps pointing at that row forever, so deduping here would
    // strip the losing row's id out of the lookup and silently drop its comments
    // from the corpus. The join stays over every row read; only the reported
    // population is deduplicated.
    const urlByPostId = new Map(postRows.map((p) => [p.id, p.url]));
    const scopedIds = postRows.filter((p) => p.account === account).map((p) => p.id);

    if (account !== 'all' && scopedIds.length === 0) {
      throw new HttpError(
        409,
        `There are no posts stored for the ${account} account, so there are no comments to analyse.`,
        'Ingest posts for that account first, then scrape its comments.',
      );
    }

    // The scoped read is batched: `scopedIds` is one uuid per post ROW, so an
    // unbatched `in (…)` grows past the query-string ceiling in front of
    // PostgREST as soon as a second snapshot exists. Same rows, same order —
    // see readCorpusRows.
    const comments = await readCorpusRows(db, account === 'all' ? null : scopedIds, limit);
    const corpus: CorpusComment[] = [];
    let unattributed = 0;

    for (const comment of comments) {
      const postId = comment.post_id;
      // A comment with no post cannot carry a quote's provenance, so it is
      // counted and left out rather than quoted with a missing source.
      if (!postId || !comment.text_content.trim()) {
        unattributed += 1;
        continue;
      }
      corpus.push({
        id: comment.id,
        post_id: postId,
        post_url: urlByPostId.get(postId) ?? null,
        text: comment.text_content,
      });
    }

    if (corpus.length === 0) {
      throw new HttpError(
        409,
        account === 'all'
          ? 'There are no comments to analyse yet.'
          : `There are no comments stored for the ${account} account yet.`,
        'Run a comment scrape on the Data screen — it only reads — then generate the audience analysis again.',
      );
    }

    /** Measured before unattributed comments were dropped. */
    const corpusTruncated = comments.length >= limit;

    const quality = await readQuality();
    const outcome = await audienceFeature.run({ account, comments: corpus }, quality);

    /* ------------------------------------------------- stamp the population -- */

    // The run is over the moment `run()` returns, and nothing downstream can
    // reconstruct which rows it read. So the coverage is written onto the row
    // that was just inserted, under `timing.population`. GET reads it back,
    // which is what lets a plain page load state what the stored numbers cover
    // instead of rendering a heatmap with no frame around it.
    //
    // A failure here does NOT fail the request: the insight is already stored
    // and the model call is already paid for. It is reported instead, and the
    // stored report will say its population is unknown — which is true.
    let populationStorageError: string | null = null;
    let persistedPayload: unknown = outcome.persisted;

    const persistedResult = persistedSchema.safeParse(outcome.persisted);
    if (!persistedResult.success) {
      populationStorageError =
        'The population of this run could not be stored with the insight: the feature returned a payload this route does not recognise. The stored report will say its population is unknown.';
    } else if (persistedResult.data.insight.timing === null) {
      // `timing` is the jsonb the population rides in. A row stored without one
      // has nowhere to carry it, and inventing a timing object to hold it would
      // put an empty grid on screen.
      populationStorageError =
        'The population of this run could not be stored with the insight: the row carries no timing report to attach it to. The stored report will say its population is unknown.';
    } else {
      const storedInsight = persistedResult.data.insight;
      const population: StoredAudiencePopulation = {
        account,
        comments: {
          read: corpus.length,
          cap: limit,
          truncated: corpusTruncated,
          unattributed,
        },
        post_index: {
          rows_fetched: coverage.rows_fetched,
          limit: coverage.limit,
          truncated: coverage.truncated,
          posts: postIndexPopulation.posts.length,
          duplicates_collapsed: postIndexPopulation.duplicates_collapsed,
          snapshots_seen: postIndexPopulation.snapshots_seen,
        },
        timing_posts: persistedResult.data.posts_population,
      };

      // `.single()` rather than a bare update: a write that matched no row is
      // then an error rather than a silent no-op that leaves the response
      // claiming a population the table does not hold.
      const stamp = await db
        .from('audience_insights')
        .update({ timing: { ...storedInsight.timing, population } })
        .eq('id', storedInsight.id)
        .select('*')
        .single();

      if (stamp.error) {
        populationStorageError = `The population of this run could not be stored with the insight: ${stamp.error.message}. The stored report will say its population is unknown.`;
      } else {
        // The row as it now stands, so this response and a later GET agree.
        const stamped = stamp.data as AudienceInsightRow;
        persistedPayload = { ...persistedResult.data, insight: stamped };
      }
    }

    return NextResponse.json({
      ...outcome,
      persisted: persistedPayload,
      corpus: {
        account,
        size: corpus.length,
        capped_at: limit,
        /** Measured before unattributed comments were dropped. */
        truncated: corpusTruncated,
        unattributed,
      },
      /**
       * The post index the corpus was joined against, in both units: rows read
       * and posts they collapse to. `truncated` means the read filled its cap,
       * so comments hanging off posts beyond it are missing from this corpus —
       * a truncated population is stated, never presented as a total.
       */
      posts: {
        rows_fetched: coverage.rows_fetched,
        limit: coverage.limit,
        truncated: coverage.truncated,
        distinct: postIndexPopulation.posts.length,
        duplicates_collapsed: postIndexPopulation.duplicates_collapsed,
        snapshots_seen: postIndexPopulation.snapshots_seen,
      },
      /** null when this run's population was stored on the row. */
      population_storage_error: populationStorageError,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * GET /api/audience — the latest stored insight, the population that insight was
 * computed over, and the size of the corpus it could be regenerated from. All
 * are null/0 before the first scrape, which is the empty state the screen
 * renders.
 *
 * `population` is read off the stored row and NEVER recomputed here. A fresh
 * read of `posts` would describe the table as it stands today — a different row
 * set, once another snapshot lands — and putting today's coverage around
 * yesterday's numbers would be a fabricated frame. A row written before the
 * population was recorded returns null, and the screen says the population is
 * unknown rather than showing one that does not belong to it.
 */
export async function GET() {
  try {
    await requireOperator();
    const db = supabaseAdmin();

    const [insightResult, countResult] = await Promise.all([
      db.from('audience_insights').select('*').order('created_at', { ascending: false }).limit(1),
      db.from('comments').select('id', { count: 'exact', head: true }),
    ]);

    if (insightResult.error) {
      throw new Error(`Could not read audience insights: ${insightResult.error.message}`);
    }
    if (countResult.error) {
      throw new Error(`Could not count comments: ${countResult.error.message}`);
    }

    const insight = (insightResult.data as AudienceInsightRow[] | null)?.[0] ?? null;
    // null means "not counted", not "none" — the UI renders an em-dash for it.
    const comments = countResult.count ?? null;

    // Parsed, not trusted: a legacy row, or one whose jsonb holds a shape this
    // schema does not recognise, yields null — which the screen states — rather
    // than a half-populated block of figures nobody can vouch for.
    const envelope = storedTimingEnvelopeSchema.safeParse(insight?.timing);
    const population = envelope.success ? envelope.data.population : null;

    return NextResponse.json({
      insight,
      comments,
      population,
      hint:
        insight === null && comments === 0
          ? 'No comments have been ingested yet, so there is nothing to analyse.'
          : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
