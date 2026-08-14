import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { accountSchema, grounding } from '@/lib/agent/schemas';
import { buildTiming, type TimingPost, type TimingResult } from '@/lib/audience/timing';
import { distinctPosts, scanCoverage, MAX_POSTS_SCAN, type PostIdentity } from '@/lib/audience/posts';
import type { AudienceQuestion, AudienceTheme, Grounding } from '@/lib/types/db';
import { defineFeature, type BrainReport } from './types';

/**
 * "What is the audience actually saying?"
 *
 * Four constraints shape this feature, and each of them exists because the
 * obvious implementation would be dishonest:
 *
 * 1. AGGREGATE ONLY (hard rule 10). Commenters are an audience, not targets.
 *    The corpus reaches the model without handles, the prompt forbids
 *    per-person reasoning in as many words, and nothing here can produce a
 *    per-commenter profile even if the model tried.
 * 2. VERBATIM OR NOTHING. Every theme carries real quotes. The prompt forbids
 *    paraphrase, and `verifyThemes` re-checks each quote against the corpus
 *    afterwards — a quote that is not literally in a stored comment is dropped,
 *    and a theme that loses its evidence is downgraded to a hypothesis.
 * 3. THE MODEL DOES NOT COUNT COMMENTS (hard rule 2). `n` and `asked_count` are
 *    not in the response schema at all, so the model is never asked for a number
 *    it has no way to know. It used to be, guarded by a ceiling (n must not
 *    exceed the corpus) and a floor (n must not be below the number of quotes) —
 *    and neither guard can tell a count from a guess: a theme with two verified
 *    quotes reporting n over a corpus in the hundreds passes both, then renders
 *    as a measurement beside a green `data` badge. The counts are computed
 *    below, in code, over the same rows the quotes were verified against.
 *    See countMatchingComments().
 * 4. THE MODEL DOES NOT COUNT HOURS (hard rule 11). The timing block is
 *    computed by buildTiming() from posted_at x engagement and attached in
 *    persist(). The model may propose a NAME for the pattern; the schema
 *    refuses that name if it contains so much as a digit.
 */

/** The prompt cap. A larger corpus is refused rather than silently truncated. */
export const MAX_CORPUS = 600;

/* ------------------------------------------------------------------ input -- */

/**
 * One comment as the caller supplies it. No author handle, by design — the
 * model never sees who said anything.
 */
const corpusCommentSchema = z.object({
  id: z.string().min(1),
  post_id: z.string().min(1),
  /** Filled from the database by the caller; the model is never shown it. */
  post_url: z.string().nullable(),
  text: z.string().min(1),
});

export type CorpusComment = z.infer<typeof corpusCommentSchema>;

/**
 * The corpus travels IN, rather than being loaded here, because buildPrompt is
 * synchronous by contract. `/api/audience` is the sanctioned caller and reads
 * it from Postgres; a caller that supplies none gets a 400 that says so.
 */
const inputSchema = z.object({
  account: z.union([accountSchema, z.literal('all')]).default('all'),
  comments: z
    .array(corpusCommentSchema)
    .min(1, 'no comments supplied — POST /api/audience loads the corpus from the database')
    .max(MAX_CORPUS, `at most ${MAX_CORPUS} comments per run`),
  /** The scrape run the corpus came from, when the caller knows it. */
  scrape_run_id: z.string().uuid().nullish(),
});

type Input = z.infer<typeof inputSchema>;

/* ----------------------------------------------------------------- output -- */

/** Latin, Arabic-Indic and extended Arabic-Indic digits. */
const ANY_DIGIT = /[0-9٠-٩۰-۹]/;

const quoteSchema = z.object({
  /** Copied character-for-character out of the corpus. Checked afterwards. */
  text: z.string().min(1),
  post_id: z.string().min(1),
});

/**
 * No `n`. The theme is a label and its evidence; the count that goes on screen
 * beside it is computed in verifyThemes() from the corpus. zod strips unknown
 * keys by default, so a model that volunteers a count anyway has it discarded
 * here rather than carried one function further and rendered.
 */
const themeSchema = z.object({
  label_ar: z.string().min(1),
  quotes: z.array(quoteSchema).min(2).max(3),
  grounding,
});

/** No `asked_count`, for the same reason. See verifyQuestions(). */
const questionSchema = z.object({
  text: z.string().min(1),
  post_id: z.string().min(1),
});

const audienceResponseSchema = z.object({
  warnings: z.array(z.string()),
  themes: z.array(themeSchema).min(1).max(8),
  questions: z.array(questionSchema).max(12),
  register_notes_ar: z.string().min(1),
  /**
   * A name for the posting-time pattern, or null. Hard rule 11 lives in this
   * refinement: the moment a digit appears, the model is producing timing
   * numbers instead of naming a shape, and the response is rejected.
   */
  timing_pattern_name_ar: z
    .string()
    .min(1)
    .refine((value) => !ANY_DIGIT.test(value), {
      message: 'must not contain a number — timing figures are computed in code, not written here',
    })
    .nullable(),
});

type AudienceResponse = z.infer<typeof audienceResponseSchema>;

/** What lands in the `timing` jsonb: code-computed numbers, model-named shape. */
type StoredTiming = TimingResult & { pattern_name_ar: string | null };

/* ----------------------------------------------------------- verification -- */

/** Whitespace differences are formatting, not paraphrase. Nothing else is. */
function normaliseForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * A quote is real when it appears literally inside a stored comment on the
 * post it is attributed to. Substrings pass (trimming a long comment is still
 * quoting it); anything reworded does not.
 */
function findSource(
  text: string,
  postId: string,
  corpus: readonly CorpusComment[],
): CorpusComment | null {
  const needle = normaliseForMatch(text);
  if (!needle) return null;
  for (const comment of corpus) {
    if (comment.post_id !== postId) continue;
    if (normaliseForMatch(comment.text).includes(needle)) return comment;
  }
  return null;
}

/**
 * THE PUBLISHED COUNT. How many stored comments contain at least one of these
 * strings, matched by the same whitespace-normalised rule findSource() uses.
 * Each comment is counted once however many needles it contains.
 *
 * This is option (a) of the two honest fixes — compute the number ourselves —
 * and it was chosen over option (b), dropping `n` in favour of a
 * `verified_quotes` count, for three reasons:
 *
 * - `verified_quotes` measures the model, not the audience. The schema caps
 *   quotes at three, so that number tops out at three no matter whether a theme
 *   runs through the whole corpus or through two comments. It is defensible and
 *   nearly uninformative.
 * - This count is arithmetic over corpus rows: same corpus and same verified
 *   quotes give the same answer on every run, with no model in the loop. It is
 *   reproducible by anyone holding the comments.
 * - Its error direction is safe. A comment that expresses the theme in different
 *   words is NOT counted, so the published figure is a floor on the theme's real
 *   size, never an inflation of it. The old failure mode was the opposite one.
 *
 * What the number therefore means, exactly: comments containing this theme's
 * verified evidence. Not "comments the model assigned to the theme" — nothing in
 * this file can measure that, and a number nobody can check is the thing hard
 * rule 2 forbids. The definition travels to the caller in persist() as
 * `count_basis` so the screen can state what it is counting.
 */
function countMatchingComments(
  needles: readonly string[],
  corpus: readonly CorpusComment[],
): number {
  const normalised = needles.map(normaliseForMatch).filter((needle) => needle.length > 0);
  if (normalised.length === 0) return 0;

  let count = 0;
  for (const comment of corpus) {
    const haystack = normaliseForMatch(comment.text);
    if (normalised.some((needle) => haystack.includes(needle))) count += 1;
  }
  return count;
}

interface Verified<T> {
  kept: T[];
  warnings: string[];
}

function verifyThemes(
  themes: AudienceResponse['themes'],
  corpus: readonly CorpusComment[],
): Verified<AudienceTheme> {
  const kept: AudienceTheme[] = [];
  const warnings: string[] = [];

  for (const theme of themes) {
    const quotes: AudienceTheme['quotes'] = [];
    for (const quote of theme.quotes) {
      const source = findSource(quote.text, quote.post_id, corpus);
      if (!source) {
        warnings.push(
          `A quote under «${theme.label_ar}» is not in the corpus verbatim — dropped: "${quote.text.slice(0, 60)}".`,
        );
        continue;
      }
      // The URL comes from the database row, never from the model.
      quotes.push({ text: quote.text, post_id: source.post_id, post_url: source.post_url });
    }

    if (quotes.length === 0) {
      warnings.push(`Theme «${theme.label_ar}» lost every quote to verification — dropped.`);
      continue;
    }

    const n = countMatchingComments(
      quotes.map((quote) => quote.text),
      corpus,
    );
    if (n === 0) {
      // Unreachable: every surviving quote was just located inside a corpus
      // comment, so the corpus contains at least that one. Kept because the
      // alternative to dropping is publishing n=0 next to quotes that plainly
      // exist, and hard rule 2 has no zero — an uncountable theme is not a
      // theme worth a number.
      warnings.push(
        `Theme «${theme.label_ar}» could not be counted against the corpus — dropped.`,
      );
      continue;
    }

    // Two quotes is the evidence bar. One surviving quote is a lead, not a
    // finding, so the theme is kept and demoted rather than published as data.
    // The old `theme.n >= quotes.length` half of this condition is gone with the
    // model's count: a floor check on a number we now compute ourselves is a
    // check on our own arithmetic, which is not where the risk was.
    const enoughEvidence = quotes.length >= 2;
    if (!enoughEvidence) {
      warnings.push(
        `Theme «${theme.label_ar}» kept ${quotes.length} verified quote(s) — recorded as a hypothesis.`,
      );
    }

    kept.push({
      label: theme.label_ar,
      n,
      quotes,
      grounding: enoughEvidence ? theme.grounding : 'hypothesis',
    });
  }

  return { kept, warnings };
}

function verifyQuestions(
  questions: AudienceResponse['questions'],
  corpus: readonly CorpusComment[],
): Verified<AudienceQuestion> {
  const kept: AudienceQuestion[] = [];
  const warnings: string[] = [];

  for (const question of questions) {
    const source = findSource(question.text, question.post_id, corpus);
    if (!source) {
      warnings.push(`A question is not in the corpus verbatim — dropped: "${question.text.slice(0, 60)}".`);
      continue;
    }

    // Counted, not claimed: comments that literally contain this question. The
    // model used to supply asked_count and could not have known it — it sees the
    // corpus once and cannot tally it. "Or a near-duplicate" is beyond a literal
    // match, so a reworded repeat is not counted, and this number is a floor.
    const askedCount = countMatchingComments([question.text], corpus);
    if (askedCount === 0) {
      // Unreachable — findSource just matched the same text by the same rule.
      warnings.push(
        `A question could not be counted against the corpus — dropped: "${question.text.slice(0, 60)}".`,
      );
      continue;
    }

    kept.push({
      text: question.text,
      post_id: source.post_id,
      post_url: source.post_url,
      asked_count: askedCount,
    });
  }

  return { kept, warnings };
}

/* --------------------------------------------------------------- feature -- */

/** Everything the timing read needs: the timing columns plus post identity. */
type TimingScanRow = TimingPost & PostIdentity;

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
 * A post row carries no timestamp of its own — `posted_at` is when Ahmad
 * published, identical in every re-scrape of that post — so the only place
 * scrape recency lives is `snapshots.taken_on`. distinctPosts() ranks snapshots
 * by the order rows reach it, which puts the ordering on the caller: this is
 * that ordering. Without it, "the freshest copy of the post wins" would be a
 * hope rather than a rule, and the engagement figure feeding buildTiming() would
 * be whichever scrape the database happened to return first.
 */
async function snapshotRecencyRank(): Promise<Map<string, number>> {
  const { data, error } = await supabaseAdmin()
    .from('snapshots')
    .select('id')
    .order('taken_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(MAX_SNAPSHOTS_SCAN);
  if (error) {
    throw new Error(`Could not read snapshots for the timing report: ${error.message}`);
  }

  const rank = new Map<string, number>();
  for (const row of (data as { id: string }[] | null) ?? []) {
    if (!rank.has(row.id)) rank.set(row.id, rank.size);
  }
  return rank;
}

async function latestCommentRunId(): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('scrape_runs')
    .select('id')
    .eq('kind', 'comments')
    .eq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(1);
  return (data?.[0] as { id: string } | undefined)?.id ?? null;
}

export const audienceFeature = defineFeature<Input, AudienceResponse>({
  id: 'audience',
  label: 'Audience analysis',
  contextBlocks: ['brand', 'knowledge', 'latest_snapshot', 'pillars'],
  inputSchema,
  schema: audienceResponseSchema,
  maxTokens: 24000,

  brain: {
    task: 'audience comment analysis',
    // The Judge reads the model's answer BEFORE verification, so the only
    // number here is the length of a list the model itself wrote — labelled as
    // quotes offered, because none of them has been checked against the corpus
    // at this point. Theme sizes are absent on purpose: they are counted in
    // persist(), and printing an uncounted one here would put a figure in front
    // of the Judge that no row backs.
    toText: (result) =>
      [
        ...result.themes.map(
          (t) =>
            `## ${t.label_ar} (${t.quotes.length} quote(s) offered, ${t.grounding})\n${t.quotes
              .map((q) => `- verbatim: «${q.text}»`)
              .join('\n')}`,
        ),
        result.questions.length > 0
          ? `## Questions asked\n${result.questions.map((q) => `- «${q.text}»`).join('\n')}`
          : '',
        `## Register\n${result.register_notes_ar}`,
        result.timing_pattern_name_ar ? `## Timing pattern name\n${result.timing_pattern_name_ar}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    canonQuery: () =>
      'how a brand reads its audience: recurring themes, the questions people ask, tone and register of a community, aggregate not individual',
    canonTags: ['voice', 'social', 'arabic-specific'],
  },

  buildPrompt(input, _ctx) {
    const corpus = input.comments;
    const scope = input.account === 'all' ? 'both accounts' : `the ${input.account} account`;

    // post_url is deliberately absent: the model has no use for it and cannot
    // invent one it was never shown. Code attaches the real URL afterwards.
    const rendered = corpus
      .map((c) => `- post_id=${c.post_id} :: ${c.text.replace(/\s+/g, ' ').trim()}`)
      .join('\n');

    return [
      '## Task',
      `Read the comment corpus below — every comment stored for ${scope} — and describe the AUDIENCE as a group: what they keep coming back to, what they ask, and how they talk.`,
      '',
      '### Rules specific to this task',
      '- AGGREGATE ONLY. These are people, not leads. Never describe, profile, name, rank, segment or count an individual commenter, and never speculate about who anyone is. No handles are in the corpus; do not ask for them, infer them, or invent them. Every finding is about the group.',
      '- QUOTES ARE VERBATIM. Each theme carries 2–3 quotes copied character-for-character from the corpus, including typos, dialect spelling and emoji. Do NOT translate, tidy, shorten, merge or paraphrase a quote. A paraphrased quote is a fabrication: it is checked against the stored comments after you answer, and a quote that is not found is deleted along with the theme that leaned on it.',
      '- Each quote\'s post_id must be the post_id printed next to that exact comment below. Do not guess it.',
      '- DO NOT COUNT ANYTHING. There is no `n` and no `asked_count` in the schema below, and no count belongs in any other field either — not a total, not a percentage, not "most" expressed as a figure. How many comments carry a theme, and how often a question was asked, are counted from the stored comments in code after you answer, and any number you write here is discarded. Pick the themes and the quotes; the arithmetic is not yours.',
      '- NO TIMING NUMBERS. Do not say when the audience is active, at what hour, on which day, or by what multiple. Posting-time patterns are computed from the database in code and attached to this result after you finish. You may propose ONE short Arabic name for the shape of the pattern in `timing_pattern_name_ar` (no digits at all), or return null — null is the right answer when the corpus tells you nothing about timing.',
      '- A theme you believe but cannot evidence from the quotes is `grounding: "hypothesis"`. Say plainly in `warnings` what would confirm it.',
      '- Write label_ar and register_notes_ar in Arabic. Quotes stay exactly as the audience wrote them.',
      '- register_notes_ar describes the register of the corpus as a whole: formality, dialect vs فصحى, emoji use, length, how people address Ahmad. It is a description of language, not of people.',
      '',
      `## Comment corpus — ${corpus.length} comment(s), author handles removed`,
      rendered,
      '',
      '## Response schema',
      `{
  "warnings": ["string"],
  "themes": [{
    "label_ar": "string  // the theme, in Arabic",
    "quotes": [{"text": "string  // VERBATIM from the corpus", "post_id": "string"}],
    "grounding": "data|hypothesis"
  }],
  "questions": [{"text": "string  // VERBATIM", "post_id": "string"}],
  "register_notes_ar": "string  // Arabic, about the language of the corpus",
  "timing_pattern_name_ar": "string | null  // a name only, no digits"
}`,
    ].join('\n');
  },

  async persist(result, input, _ctx, brain?: BrainReport) {
    const db = supabaseAdmin();
    const corpus = input.comments;

    const themes = verifyThemes(result.themes, corpus);
    const questions = verifyQuestions(result.questions, corpus);

    // Hard rule 11: the timing block is arithmetic over the posts table, not a
    // model output. The model's contribution is the pattern's NAME, kept
    // beside the numbers so the provenance of each half is obvious.
    //
    // `posts` is UNIQUE (snapshot_id, ig_id) — one row per post PER SNAPSHOT.
    // Reading the table raw therefore measures scrape rows, not posts: after the
    // next re-scrape every post still on the account is stored a second time,
    // and buildTiming() would weight it once per scrape it survived while every
    // window's n went on calling itself posts. So the read is ordered and capped
    // rather than unbounded, ranked by scrape recency, and collapsed to one row
    // per ig_id before a single average is taken.
    const snapshotRank = await snapshotRecencyRank();

    const { data: postRows, error: postsError } = await db
      .from('posts')
      .select('ig_id, snapshot_id, account, posted_at, engagement')
      .order('posted_at', { ascending: false, nullsFirst: false })
      .limit(MAX_POSTS_SCAN);
    if (postsError) {
      throw new Error(`Could not read posts for the timing report: ${postsError.message}`);
    }

    const scanned = (postRows as TimingScanRow[] | null) ?? [];
    // Coverage is measured on the RAW row count, because it is the query that
    // was capped, not the post population.
    const coverage = scanCoverage(scanned.length, MAX_POSTS_SCAN);
    // Array.prototype.sort is stable, so posts stay newest-published-first
    // within each snapshot and only the snapshot ordering changes here.
    const byScrapeRecency = [...scanned].sort(
      (a, b) =>
        (snapshotRank.get(a.snapshot_id) ?? UNRANKED) -
        (snapshotRank.get(b.snapshot_id) ?? UNRANKED),
    );
    const population = distinctPosts(byScrapeRecency, { newestSnapshotFirst: true });

    const timing: StoredTiming = {
      ...buildTiming(population.posts, { account: input.account }),
      pattern_name_ar: result.timing_pattern_name_ar,
    };

    const generatedFrom = input.scrape_run_id ?? (await latestCommentRunId());

    // The row is data only if at least one theme survived verification as data.
    const rowGrounding: Grounding = themes.kept.some((t) => t.grounding === 'data')
      ? 'data'
      : 'hypothesis';

    const { data, error } = await db
      .from('audience_insights')
      .insert({
        generated_from: generatedFrom,
        themes: themes.kept,
        questions: questions.kept,
        register_notes: result.register_notes_ar,
        timing,
        grounding: rowGrounding,
      })
      .select('*')
      .single();

    if (error) throw new Error(`Could not save the audience insight: ${error.message}`);

    return {
      insight: data,
      corpus_size: corpus.length,
      themes_kept: themes.kept.length,
      themes_returned: result.themes.length,
      questions_kept: questions.kept.length,
      /** Everything verification threw away, verbatim, so it is auditable. */
      dropped: [...themes.warnings, ...questions.warnings],
      timing: {
        time_zone: timing.time_zone,
        min_window_n: timing.min_window_n,
        windows: timing.best_windows.length,
        total_n: timing.total_n,
      },
      /**
       * The population every timing figure was computed over, in BOTH units:
       * scrape rows read, and posts left once re-scrapes were collapsed. A
       * `truncated` read filled its cap, so the population may be a prefix of
       * the table — the screen shows that rather than presenting a prefix as a
       * total. There is no "rows missing" figure: what a capped query never saw
       * is unknowable from its result.
       */
      posts_population: {
        rows_fetched: coverage.rows_fetched,
        limit: coverage.limit,
        truncated: coverage.truncated,
        posts: population.posts.length,
        duplicates_collapsed: population.duplicates_collapsed,
        snapshots_seen: population.snapshots_seen,
      },
      /** What the numbers beside the themes and the questions actually count. */
      count_basis:
        'counted in code from the stored comments — a theme n is the comments containing at least one of its verified quotes; a question asked_count is the comments containing that question verbatim',
      needs_human: brain?.needsHuman ?? false,
      judge_score: brain?.judge.score ?? null,
    };
  },
});
