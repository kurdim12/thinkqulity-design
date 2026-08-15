/**
 * ===========================================================================
 * HARD RULE 19 — PREDEFINED LOOKUPS ONLY
 * ===========================================================================
 *
 * This file is the whole answer to "what can the chat agent ask the database?".
 * It is a CLOSED REGISTRY of named, code-defined computations. There is no
 * free-SQL tool, no raw-table tool, and no query anywhere below that is built
 * from model input beyond a bounded, named, zod-parsed parameter.
 *
 * Three mechanisms, in increasing order of strength — the same three
 * src/lib/mcp/tools.ts uses, because they are what made that surface provable:
 *
 *   1. THE REGISTRY IS A CLOSED ALLOW-LIST, NOT A LOOKUP. `STAT_LOOKUP_NAMES`
 *      is a readonly tuple, `StatLookupName` is its element union, and
 *      `LOOKUPS` is typed `Record<StatLookupName, StatLookup>` — total (a name
 *      in the tuple with no entry is a compile error) and closed (a name
 *      outside the tuple has no key to reach). `isStatLookupName` tests
 *      membership of the TUPLE, never of the record, so `__proto__`,
 *      `constructor` and every other inherited key resolve to nothing.
 *
 *   2. NO LOOKUP TAKES A TARGET. No parameter below is a table, a column, a
 *      filter expression, a URL or a path. Every parameter is an enum or an
 *      integer with a range, and every one of them is parsed by zod inside the
 *      lookup that owns it. A caller picks a computation and fills in scalars.
 *
 *   3. THE TABLE NAMES ARE LITERALS IN THIS FILE. Every table this module reads
 *      is written out as a quoted string at the call site — never assembled
 *      from a parameter, a variable, or anything a caller supplied. Read the
 *      table-selection calls below and each argument is a quoted string; that
 *      is the property to preserve, and tests/chat-tools.test.ts asserts it by
 *      scanning this source rather than by trusting this paragraph.
 *
 * ---------------------------------------------------------------------------
 * ABSENCE IS THE COMMON CASE, AND IT IS A FIRST-CLASS RESULT
 * ---------------------------------------------------------------------------
 * profile_snapshots, comments and post_analyses are EMPTY on this deployment.
 * So `follower_history` and `cluster_aggregates` have NO measurement today, and
 * that is not an edge case — it is what the model will see most of the time.
 *
 * A lookup with no data therefore returns an `Absence`: the dotted name the
 * value WOULD have had, why it does not exist, and what would produce it. It
 * never returns 0, and it never returns an empty array dressed as a result.
 * The reason is the one src/lib/agent/strategist/blocks.ts states at length: a
 * key holding "0" invites a confident sentence about a value nobody measured,
 * and the sentence arrives wearing a citation. An absence makes the model ask.
 *
 * ---------------------------------------------------------------------------
 * WHY VALUES ARE STRINGS, AND WHY THE FORMATTER IS IMPORTED
 * ---------------------------------------------------------------------------
 * `StatValue.value` is text, always, so nothing downstream can recompute,
 * rescale or re-round it — the same contract `Measure` keeps in blocks.ts.
 *
 * The rounding is done by `formatQuantity()`, IMPORTED from blocks.ts rather
 * than re-implemented, and that import is load-bearing rather than tidy. Chat
 * lints every reply with the claims-linter, which traces a number in the output
 * back to the context BY STRING MATCH (src/lib/brain/law/claims-linter.ts).
 * The context is the rendered strategist blocks PLUS these tool results. If
 * this file rounded 507.9736842105263 to `507.97` while the blocks rendered
 * `507.97`, all would be well — and if it rendered `508.0` or `507.974`, the
 * model quoting THIS tool would state a number the blocks do not contain, and
 * the linter would strip a figure that was in fact measured. One formatter is
 * the only way those two surfaces cannot drift.
 *
 * For the same reason the SOURCE KEY NAMESPACE IS SHARED: `performance.
 * personal.avg_engagement`, `profiles.academy.followers`, `performance.timing.
 * <account>.windows.1.n` are the keys blocks.ts already emits, restated here so
 * the operator sees one namespace rather than two that nearly agree.
 *
 * ---------------------------------------------------------------------------
 * PURITY AND THE DATABASE HANDLE
 * ---------------------------------------------------------------------------
 * The handle is an ARGUMENT, exactly as in `loadStrategistData()`. This module
 * therefore reads no environment variable, holds no secret, builds no client,
 * and can be executed against any client the caller has already authorised —
 * which is also what lets tests/chat-tools.test.ts run every lookup for real
 * with no key of any kind present.
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  distinctPosts,
  scanCoverage,
  MAX_POSTS_SCAN,
  type ScanCoverage,
} from '@/lib/audience/posts';
import { buildTiming, MIN_WINDOW_N } from '@/lib/audience/timing';
import { formatQuantity } from '@/lib/agent/strategist/blocks';
import type { Account, PostRow, ProfileSnapshotRow } from '@/lib/types/db';

/* ================================================================ shapes == */

/**
 * One measured quantity, with the key that resolves it.
 *
 * `value` is VERBATIM text — see the header. `n` and `as_of` are attributes OF
 * this value and travel with it (hard rule 11: a timing or an average claim
 * carries its sample size wherever it goes).
 */
export interface StatValue {
  /** Dotted, stable, and the same namespace the strategist blocks emit. */
  source_key: string;
  /** What this is, in English. Contains no bare quantity. */
  label: string;
  /** Exactly as it will be quoted back. Never a number type. */
  value: string;
  /** Observations behind the value. Null when the notion is meaningless. */
  n: number | null;
  /** The date it was measured on. Null when it has no date. */
  as_of: string | null;
}

/**
 * Something that was NOT measured.
 *
 * `what` is the dotted name the key WOULD have had — the most useful thing to
 * tell an agent that wanted it — and it is deliberately NOT emitted as a
 * source_key, so a citation of it cannot resolve to a hole.
 */
export interface StatAbsence {
  what: string;
  /** Why there is no measurement. Contains no digits, by rule. */
  reason: string;
  /** The operator action that would create it. Names a screen or a route. */
  what_would_produce_it: string;
}

export type StatStatus = 'measured' | 'partial' | 'absent';

export interface StatLookupResult {
  lookup: StatLookupName;
  title: string;
  /** The parameters AS PARSED, so the caller can see which defaults applied. */
  params: Record<string, unknown>;
  /**
   * `absent` when nothing was measured, `partial` when some of what was asked
   * for exists and some does not. Derived, never asserted by a lookup.
   */
  status: StatStatus;
  values: StatValue[];
  absences: StatAbsence[];
  /** Prose for the reader. Never carries a quantity that is not also a value. */
  notes: string[];
  /** Coverage of the underlying capped read, when one was made. */
  coverage: ScanCoverage | null;
  /** The snapshot every performance figure here was measured over. */
  measured_over: { snapshot_id: string; taken_on: string } | null;
}

/** Why a lookup did not run. Shaped, so a caller branches rather than regexes. */
export type StatLookupRefusal =
  | {
      ok: false;
      refusal: 'unknown_lookup';
      requested: string;
      available: readonly string[];
      reason: string;
      what_you_can_do: string[];
    }
  | {
      ok: false;
      refusal: 'invalid_params';
      lookup: string;
      issues: { path: string; message: string }[];
      reason: string;
    };

export type StatLookupOutcome = { ok: true; result: StatLookupResult } | StatLookupRefusal;

/* =============================================================== helpers == */

/** Every lookup's account parameter, in one place. */
const accountParam = z.enum(['personal', 'academy', 'all']).default('all');

type AccountParam = z.infer<typeof accountParam>;

const ACCOUNTS: readonly Account[] = ['personal', 'academy'];

function accountsFor(param: AccountParam): readonly Account[] {
  return param === 'all' ? ACCOUNTS : [param];
}

function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

function invalidParams(lookup: StatLookupName, error: z.ZodError): StatLookupRefusal {
  return {
    ok: false,
    refusal: 'invalid_params',
    lookup,
    issues: issuesOf(error),
    reason:
      `The parameters for "${lookup}" did not validate, so nothing was read and nothing was computed. ` +
      'Every parameter this registry accepts is a named enum or a bounded integer; there is no free-form filter.',
  };
}

/**
 * A number becoming a value. Returns null when the number is not finite, so an
 * unrepresentable figure becomes an ABSENCE at the call site rather than a
 * string that says "NaN".
 */
function value(
  source_key: string,
  label: string,
  quantity: number,
  opts: { n?: number | null; as_of?: string | null } = {},
): StatValue | null {
  const text = formatQuantity(quantity);
  if (text === null) return null;
  return {
    source_key,
    label,
    value: text,
    n: opts.n ?? null,
    as_of: opts.as_of ?? null,
  };
}

/** A value that is already text — a date, a label, an id. Never rounded. */
function textValue(
  source_key: string,
  label: string,
  text: string,
  opts: { n?: number | null; as_of?: string | null } = {},
): StatValue {
  return { source_key, label, value: text, n: opts.n ?? null, as_of: opts.as_of ?? null };
}

function statusOf(values: readonly StatValue[], absences: readonly StatAbsence[]): StatStatus {
  if (values.length === 0) return 'absent';
  return absences.length === 0 ? 'measured' : 'partial';
}

/* ============================================== the shared post population ==
 *
 * One capped read of `posts`, scoped to the newest snapshot, collapsed with
 * `distinctPosts()`. Four of the five lookups need it and none of them may
 * compute it differently.
 *
 * WHY THE COLLAPSE HAPPENS EVEN THOUGH IT IS A NO-OP TODAY. `posts` is UNIQUE
 * (snapshot_id, ig_id): one row per post PER SNAPSHOT. The read below is scoped
 * to a single snapshot, so nothing collapses today. It is applied anyway
 * because the day the scoping is loosened — or the day a caller passes a
 * cross-snapshot population in — is the day every average here would silently
 * count each post twice, and a fabricated number arriving by arithmetic looks
 * computed, which makes it worse rather than better.
 *
 * WHY EACH LOOKUP READS AGAIN RATHER THAN SHARING A CACHE. A cache would have
 * to be invalidated by something, and nothing in a chat turn knows when an
 * ingest lands. Two reads a turn cost a round trip; a stale population costs a
 * wrong number with a source key attached.
 */
interface Population {
  snapshot: { id: string; taken_on: string } | null;
  posts: PostRow[];
  coverage: ScanCoverage | null;
  duplicates_collapsed: number;
}

/** The absence every performance lookup returns when no snapshot exists. */
function noSnapshot(what: string): StatAbsence {
  return {
    what,
    reason:
      'no engagement snapshot has been ingested on this deployment, so there is no post population to measure.',
    what_would_produce_it:
      'Upload an Apify export on the Data screen and run Refresh; that writes a snapshot and its posts.',
  };
}

async function loadPopulation(db: SupabaseClient, limit: number): Promise<Population> {
  const snapshotRes = await db
    .from('snapshots')
    .select('id,taken_on')
    .order('taken_on', { ascending: false })
    .limit(1);
  if (snapshotRes.error) throw new Error(`Could not read snapshots: ${snapshotRes.error.message}`);

  const snapshot = (snapshotRes.data as { id: string; taken_on: string }[] | null)?.[0] ?? null;
  if (snapshot === null) {
    return { snapshot: null, posts: [], coverage: null, duplicates_collapsed: 0 };
  }

  const postsRes = await db
    .from('posts')
    .select('*')
    .eq('snapshot_id', snapshot.id)
    .order('engagement', { ascending: false })
    .limit(limit);
  if (postsRes.error) throw new Error(`Could not read posts: ${postsRes.error.message}`);

  const rows = (postsRes.data as PostRow[] | null) ?? [];
  // Coverage counts SCRAPE ROWS, so it is measured before the collapse.
  const coverage = scanCoverage(rows.length, limit);
  const collapsed = distinctPosts(rows);

  return {
    snapshot,
    posts: collapsed.posts,
    coverage,
    duplicates_collapsed: collapsed.duplicates_collapsed,
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, each) => total + each, 0) / values.length;
}

function postsOf(population: Population, account: Account): PostRow[] {
  return population.posts.filter(
    (post) => post.account === account && Number.isFinite(post.engagement),
  );
}

/** The coverage note, when the read filled its cap. Never a "N of M" claim. */
function coverageNotes(population: Population): string[] {
  const notes: string[] = [];
  if (population.coverage?.truncated) {
    notes.push(
      'This read filled its row ceiling, so the population below is a PREFIX of the table rather than all of it. How many rows it did not see is unknowable from the result and is deliberately not stated.',
    );
  }
  if (population.duplicates_collapsed > 0) {
    notes.push(
      'Re-scrapes of the same post were collapsed to one row each before anything was averaged.',
    );
  }
  return notes;
}

/* ================================================================ lookups == */

interface StatLookup {
  name: StatLookupName;
  title: string;
  /** One line for the catalogue the model reads. States what it returns. */
  summary: string;
  /** The parameters, with their constraints, for the catalogue. */
  params_doc: string;
  /** What the source keys look like, so a reader knows what it can cite. */
  emits: string;
  run(db: SupabaseClient, rawParams: unknown): Promise<StatLookupOutcome>;
}

/* ------------------------------------------------------- account_averages -- */

const accountAveragesParams = z.object({ account: accountParam }).strict();

const accountAverages: StatLookup = {
  name: 'account_averages',
  title: 'Per-account post count, total and mean engagement, and the gap between the two accounts',
  summary:
    'Mean engagement per post for one account or both, over the newest snapshot, with the post count that produced it. Returns each account separately and — when both were measured — the multiple between them.',
  params_doc: 'account: "personal" | "academy" | "all" (default "all").',
  emits:
    'performance.<account>.post_count, .total_engagement, .avg_engagement, and performance.gap.personal_vs_academy',

  async run(db, rawParams) {
    const parsed = accountAveragesParams.safeParse(rawParams ?? {});
    if (!parsed.success) return invalidParams('account_averages', parsed.error);

    const population = await loadPopulation(db, MAX_POSTS_SCAN);
    const values: StatValue[] = [];
    const absences: StatAbsence[] = [];
    const wanted = accountsFor(parsed.data.account);

    if (population.snapshot === null) {
      for (const account of wanted) absences.push(noSnapshot(`performance.${account}`));
      return {
        ok: true,
        result: {
          lookup: 'account_averages',
          title: accountAverages.title,
          params: parsed.data,
          status: 'absent',
          values,
          absences,
          notes: [],
          coverage: null,
          measured_over: null,
        },
      };
    }

    const takenOn = population.snapshot.taken_on;
    const averages = new Map<Account, number>();

    for (const account of wanted) {
      const mine = postsOf(population, account);
      const base = `performance.${account}`;

      if (mine.length === 0) {
        absences.push({
          what: base,
          reason: 'this account has no posts in the newest snapshot, so it was not measured.',
          what_would_produce_it:
            'Ingest an export that contains this account, then run Refresh on the Data screen.',
        });
        continue;
      }

      const engagements = mine.map((post) => post.engagement);
      const total = engagements.reduce((sum, each) => sum + each, 0);
      const average = mean(engagements);

      const count = value(`${base}.post_count`, `distinct posts, ${account} account`, mine.length, {
        as_of: takenOn,
      });
      if (count) values.push(count);

      const sum = value(
        `${base}.total_engagement`,
        `total engagement across those posts, ${account} account`,
        total,
        { n: mine.length, as_of: takenOn },
      );
      if (sum) values.push(sum);

      // `mean` returns null only for an empty array, which the guard above has
      // already excluded — but the null is honoured rather than asserted away,
      // because a non-null assertion is a claim TypeScript cannot check.
      const avg = average === null ? null : value(
        `${base}.avg_engagement`,
        `mean engagement per post, ${account} account`,
        average,
        { n: mine.length, as_of: takenOn },
      );
      if (avg) {
        values.push(avg);
        if (average !== null) averages.set(account, average);
      } else {
        absences.push({
          what: `${base}.avg_engagement`,
          reason: 'the mean over this account is not a finite number, so it is not stated.',
          what_would_produce_it:
            'Check the ingested engagement figures for this account on the Data screen.',
        });
      }
    }

    /* The one derived figure, and only when both halves were measured. The two
     * accounts are NEVER blended into a single average: one averages in the
     * hundreds and the other in the tens, so a combined mean belongs to
     * neither. A ratio between them is a different thing and is labelled as
     * one. */
    const personal = averages.get('personal');
    const academy = averages.get('academy');
    if (personal !== undefined && academy !== undefined) {
      if (academy > 0) {
        const gap = value(
          'performance.gap.personal_vs_academy',
          'the personal account average as a multiple of the academy account average',
          personal / academy,
          { n: postsOf(population, 'personal').length + postsOf(population, 'academy').length },
        );
        if (gap) values.push(gap);
      } else {
        absences.push({
          what: 'performance.gap.personal_vs_academy',
          reason:
            'the academy average is not positive, so a multiple against it would be meaningless.',
          what_would_produce_it: 'A snapshot in which the academy account has engagement above zero.',
        });
      }
    }

    return {
      ok: true,
      result: {
        lookup: 'account_averages',
        title: accountAverages.title,
        params: parsed.data,
        status: statusOf(values, absences),
        values,
        absences,
        notes: coverageNotes(population),
        coverage: population.coverage,
        measured_over: { snapshot_id: population.snapshot.id, taken_on: takenOn },
      },
    };
  },
};

/* ------------------------------------------------------ cluster_aggregates -- */

const clusterAggregatesParams = z
  .object({ account: accountParam, limit: z.number().int().min(1).max(20).default(10) })
  .strict();

const clusterAggregates: StatLookup = {
  name: 'cluster_aggregates',
  title: 'Mean engagement per content cluster, against the account average',
  summary:
    'What KIND of content performs, measured rather than guessed: each cluster from the board analysis with its post count, its mean engagement, and that mean as a multiple of the account average. EMPTY on this deployment — post_analyses holds no rows — so this returns an absence today.',
  params_doc:
    'account: "personal" | "academy" | "all" (default "all"). limit: integer 1–20, how many clusters to return, strongest first (default 10).',
  emits: 'performance.clusters.<cluster>.n, .avg_engagement, .vs_account_avg',

  async run(db, rawParams) {
    const parsed = clusterAggregatesParams.safeParse(rawParams ?? {});
    if (!parsed.success) return invalidParams('cluster_aggregates', parsed.error);

    const population = await loadPopulation(db, MAX_POSTS_SCAN);
    const absences: StatAbsence[] = [];

    if (population.snapshot === null) {
      absences.push(noSnapshot('performance.clusters'));
      return {
        ok: true,
        result: {
          lookup: 'cluster_aggregates',
          title: clusterAggregates.title,
          params: parsed.data,
          status: 'absent',
          values: [],
          absences,
          notes: [],
          coverage: null,
          measured_over: null,
        },
      };
    }

    const analysesRes = await db
      .from('post_analyses')
      .select('post_id,cluster_label')
      .limit(MAX_POSTS_SCAN);
    if (analysesRes.error) {
      throw new Error(`Could not read post analyses: ${analysesRes.error.message}`);
    }
    const analyses =
      (analysesRes.data as { post_id: string; cluster_label: string | null }[] | null) ?? [];

    /* THE ABSENCE THAT MATTERS. post_analyses is empty on this deployment, so
     * this is the branch that actually runs. It says what does not exist, why,
     * and what would create it — and it does NOT return an empty cluster list,
     * which a reader would take as "there are no patterns". */
    if (analyses.length === 0) {
      absences.push({
        what: 'performance.clusters',
        reason:
          'no post has been analysed yet, so no cluster aggregate exists. Any statement about what kind of content performs is a hypothesis, not a measurement.',
        what_would_produce_it:
          'Run the board analysis on the Board screen; it writes post_analyses, which is what these aggregates are computed from.',
      });
      return {
        ok: true,
        result: {
          lookup: 'cluster_aggregates',
          title: clusterAggregates.title,
          params: parsed.data,
          status: 'absent',
          values: [],
          absences,
          notes: coverageNotes(population),
          coverage: population.coverage,
          measured_over: {
            snapshot_id: population.snapshot.id,
            taken_on: population.snapshot.taken_on,
          },
        },
      };
    }

    const wanted = new Set<Account>(accountsFor(parsed.data.account));
    const byId = new Map(population.posts.map((post) => [post.id, post]));
    const groups = new Map<string, { label: string; account: Account; engagements: number[] }>();

    for (const analysis of analyses) {
      const post = byId.get(analysis.post_id);
      if (!post || !analysis.cluster_label || !wanted.has(post.account)) continue;
      const groupKey = `${post.account}::${analysis.cluster_label}`;
      const group = groups.get(groupKey) ?? {
        label: analysis.cluster_label,
        account: post.account,
        engagements: [],
      };
      if (Number.isFinite(post.engagement)) group.engagements.push(post.engagement);
      groups.set(groupKey, group);
    }

    const accountAveragesByName = new Map<Account, number | null>();
    for (const account of ACCOUNTS) {
      accountAveragesByName.set(account, mean(postsOf(population, account).map((p) => p.engagement)));
    }

    const ranked = [...groups.values()]
      .map((group) => ({ ...group, avg: mean(group.engagements) }))
      .sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1))
      .slice(0, parsed.data.limit);

    const values: StatValue[] = [];
    for (const group of ranked) {
      // The label is the cluster's own text and may be Arabic. It is used
      // verbatim in the key segment position, matching what blocks.ts does.
      const base = `performance.clusters.${group.label}`;
      values.push(
        textValue(`${base}.account`, 'which account this cluster was measured on', group.account),
      );
      const n = value(`${base}.n`, 'posts in this cluster', group.engagements.length);
      if (n) values.push(n);

      if (group.avg === null) {
        absences.push({
          what: `${base}.avg_engagement`,
          reason: 'this cluster has no posts with engagement, so it has no average.',
          what_would_produce_it: 'Analysed posts in this cluster that carry an engagement figure.',
        });
        continue;
      }

      const avg = value(`${base}.avg_engagement`, 'mean engagement per post in this cluster', group.avg, {
        n: group.engagements.length,
      });
      if (avg) values.push(avg);

      const accountAvg = accountAveragesByName.get(group.account) ?? null;
      if (accountAvg !== null && accountAvg > 0) {
        const multiple = value(
          `${base}.vs_account_avg`,
          'cluster average as a multiple of the account average',
          group.avg / accountAvg,
          { n: group.engagements.length },
        );
        if (multiple) values.push(multiple);
      } else {
        absences.push({
          what: `${base}.vs_account_avg`,
          reason:
            'the account average is not positive, so a multiple against it would be meaningless.',
          what_would_produce_it: 'A snapshot in which this account has engagement above zero.',
        });
      }
    }

    const notes = coverageNotes(population);
    notes.push(
      `A cluster below the minimum sample size is still returned here WITH its n, so a reader can apply the rule rather than have it applied silently. The studio's floor for treating a mean as a finding is ${MIN_WINDOW_N} posts.`,
    );

    return {
      ok: true,
      result: {
        lookup: 'cluster_aggregates',
        title: clusterAggregates.title,
        params: parsed.data,
        status: statusOf(values, absences),
        values,
        absences,
        notes,
        coverage: population.coverage,
        measured_over: {
          snapshot_id: population.snapshot.id,
          taken_on: population.snapshot.taken_on,
        },
      },
    };
  },
};

/* --------------------------------------------------------- timing_windows -- */

const timingWindowsParams = z.object({ account: accountParam }).strict();

const timingWindows: StatLookup = {
  name: 'timing_windows',
  title: 'When this account is actually read, computed from publish time x engagement',
  summary:
    'Posting-time patterns for one account or both: the hour ranges that beat the overall average, each with its post count and its multiple. Computed in code by the timing engine — never asserted by a model — in Asia/Amman.',
  params_doc: 'account: "personal" | "academy" | "all" (default "all").',
  emits:
    'performance.timing.<account>.total_n, .overall_avg, .windows.<i>.label, .n, .avg_engagement, .multiple_vs_overall',

  async run(db, rawParams) {
    const parsed = timingWindowsParams.safeParse(rawParams ?? {});
    if (!parsed.success) return invalidParams('timing_windows', parsed.error);

    const population = await loadPopulation(db, MAX_POSTS_SCAN);
    const values: StatValue[] = [];
    const absences: StatAbsence[] = [];
    const wanted = accountsFor(parsed.data.account);

    if (population.snapshot === null) {
      for (const account of wanted) absences.push(noSnapshot(`performance.timing.${account}`));
      return {
        ok: true,
        result: {
          lookup: 'timing_windows',
          title: timingWindows.title,
          params: parsed.data,
          status: 'absent',
          values,
          absences,
          notes: [],
          coverage: null,
          measured_over: null,
        },
      };
    }

    for (const account of wanted) {
      // The timing engine owns every hour bucket, every window and every n.
      // Nothing in this file counts an hour.
      const report = buildTiming(population.posts, { account });
      const base = `performance.timing.${account}`;

      const totalN = value(
        `${base}.total_n`,
        `posts with a usable publish time, ${account}`,
        report.total_n,
      );
      if (totalN) values.push(totalN);
      values.push(
        textValue(`${base}.time_zone`, 'timezone every hour below is expressed in', report.time_zone),
      );

      /* timing.ts documents this exactly: `overall_avg` is 0 ONLY when
       * total_n is 0, and a consumer must branch rather than present that 0 as
       * an average. This is the branch. */
      if (report.total_n === 0) {
        absences.push({
          what: `${base}.overall_avg`,
          reason:
            'no post on this account has a usable publish time, so there is no average — the zero in the timing report is an absence, not a measurement.',
          what_would_produce_it:
            'Posts ingested with a publish time; the Apify export carries one for every post it returns.',
        });
        continue;
      }

      const overall = value(
        `${base}.overall_avg`,
        `mean engagement across those posts, ${account}`,
        report.overall_avg,
        { n: report.total_n },
      );
      if (overall) values.push(overall);

      if (report.best_windows.length === 0) {
        absences.push({
          what: `${base}.windows`,
          reason: `no hour range cleared the minimum sample size while beating the average, so no posting window is reportable for this account.`,
          what_would_produce_it:
            'More posts in a consistent hour range; the engine reports a window only once it clears its sample-size floor.',
        });
        continue;
      }

      report.best_windows.forEach((window, index) => {
        const wBase = `${base}.windows.${index + 1}`;
        values.push(
          textValue(`${wBase}.label`, 'the hour range, strongest first', window.label, {
            n: window.n,
          }),
        );
        const n = value(`${wBase}.n`, 'posts published in that range', window.n);
        if (n) values.push(n);
        const avg = value(
          `${wBase}.avg_engagement`,
          'mean engagement in that range',
          window.avg_engagement,
          { n: window.n },
        );
        if (avg) values.push(avg);
        const multiple = value(
          `${wBase}.multiple_vs_overall`,
          'that range against the overall average',
          window.multiple_vs_overall,
          { n: window.n },
        );
        if (multiple) values.push(multiple);
      });
    }

    const notes = coverageNotes(population);
    notes.push(
      `A window is reported only once it clears the engine's sample-size floor of ${MIN_WINDOW_N} posts; below that an average is one loud post wearing a trend coat.`,
    );

    return {
      ok: true,
      result: {
        lookup: 'timing_windows',
        title: timingWindows.title,
        params: parsed.data,
        status: statusOf(values, absences),
        values,
        absences,
        notes,
        coverage: population.coverage,
        measured_over: {
          snapshot_id: population.snapshot.id,
          taken_on: population.snapshot.taken_on,
        },
      },
    };
  },
};

/* --------------------------------------------------------------- top_posts -- */

const topPostsParams = z
  .object({ account: accountParam, limit: z.number().int().min(1).max(10).default(5) })
  .strict();

const topPosts: StatLookup = {
  name: 'top_posts',
  title: 'The strongest posts by engagement, as quantities with their keys',
  summary:
    'The highest-engagement posts on the newest snapshot, each as a keyed quantity with its permalink and publish time. Returns FIGURES, not captions — use search_posts when you need the text of a post.',
  params_doc:
    'account: "personal" | "academy" | "all" (default "all"). limit: integer 1–10, how many posts per account (default 5).',
  emits: 'performance.<account>.top_posts.<rank>.engagement, .url, .posted_at',

  async run(db, rawParams) {
    const parsed = topPostsParams.safeParse(rawParams ?? {});
    if (!parsed.success) return invalidParams('top_posts', parsed.error);

    const population = await loadPopulation(db, MAX_POSTS_SCAN);
    const values: StatValue[] = [];
    const absences: StatAbsence[] = [];
    const wanted = accountsFor(parsed.data.account);

    if (population.snapshot === null) {
      for (const account of wanted) absences.push(noSnapshot(`performance.${account}.top_posts`));
      return {
        ok: true,
        result: {
          lookup: 'top_posts',
          title: topPosts.title,
          params: parsed.data,
          status: 'absent',
          values,
          absences,
          notes: [],
          coverage: null,
          measured_over: null,
        },
      };
    }

    const takenOn = population.snapshot.taken_on;

    for (const account of wanted) {
      const mine = postsOf(population, account);
      if (mine.length === 0) {
        absences.push({
          what: `performance.${account}.top_posts`,
          reason: 'this account has no posts in the newest snapshot.',
          what_would_produce_it:
            'Ingest an export that contains this account, then run Refresh on the Data screen.',
        });
        continue;
      }

      // Deterministic order the model cannot influence: engagement descending,
      // ties broken by ig_id so the same population always ranks the same way.
      const ranked = [...mine]
        .sort((a, b) => b.engagement - a.engagement || a.ig_id.localeCompare(b.ig_id))
        .slice(0, parsed.data.limit);

      ranked.forEach((post, index) => {
        const base = `performance.${account}.top_posts.${index + 1}`;
        const engagement = value(
          `${base}.engagement`,
          `engagement on the number ${index + 1} ${account} post`,
          post.engagement,
          { as_of: takenOn },
        );
        if (engagement) values.push(engagement);

        if (post.url === null) {
          absences.push({
            what: `${base}.url`,
            reason: 'this post was stored without a permalink.',
            what_would_produce_it: 'A re-ingest from an export that carries the post URL.',
          });
        } else {
          values.push(textValue(`${base}.url`, 'permalink of that post', post.url));
        }

        if (post.posted_at === null) {
          absences.push({
            what: `${base}.posted_at`,
            reason: 'this post was stored without a publish time.',
            what_would_produce_it: 'A re-ingest from an export that carries the publish time.',
          });
        } else {
          values.push(textValue(`${base}.posted_at`, 'when that post was published', post.posted_at));
        }
      });
    }

    return {
      ok: true,
      result: {
        lookup: 'top_posts',
        title: topPosts.title,
        params: parsed.data,
        status: statusOf(values, absences),
        values,
        absences,
        notes: coverageNotes(population),
        coverage: population.coverage,
        measured_over: { snapshot_id: population.snapshot.id, taken_on: takenOn },
      },
    };
  },
};

/* -------------------------------------------------------- follower_history -- */

const followerHistoryParams = z.object({ account: accountParam }).strict();

/** Two dated observations are the minimum for a delta. One is not a trend. */
const PROFILE_HISTORY_SCAN = 60;

const followerHistory: StatLookup = {
  name: 'follower_history',
  title: 'Follower, following and post counts, with the date each was observed',
  summary:
    'The newest profile observation per account and the one before it, so a change can be stated with both dates. EMPTY on this deployment — profile_snapshots holds no rows — so this returns an absence today.',
  params_doc: 'account: "personal" | "academy" | "all" (default "all").',
  emits:
    'profiles.<account>.taken_on, .followers, .following, .posts_count, and .followers.delta when two dated observations exist',

  async run(db, rawParams) {
    const parsed = followerHistoryParams.safeParse(rawParams ?? {});
    if (!parsed.success) return invalidParams('follower_history', parsed.error);

    const res = await db
      .from('profile_snapshots')
      .select('*')
      .order('taken_on', { ascending: false })
      .limit(PROFILE_HISTORY_SCAN);
    if (res.error) throw new Error(`Could not read profile snapshots: ${res.error.message}`);

    const rows = (res.data as ProfileSnapshotRow[] | null) ?? [];
    const values: StatValue[] = [];
    const absences: StatAbsence[] = [];

    for (const account of accountsFor(parsed.data.account)) {
      const history = rows.filter((row) => row.account === account);
      const base = `profiles.${account}`;

      /* THE ABSENCE THAT MATTERS. profile_snapshots is empty on this
       * deployment, so this is the branch that runs. Follower counts are the
       * single most likely thing to be asked about and the single most likely
       * thing to be guessed at, so the reason says out loud what to state
       * instead. */
      if (history.length === 0) {
        absences.push({
          what: base,
          reason:
            'no profile snapshot has ever been recorded for this account, so follower, following and post-count figures do not exist. State an em-dash, never a number.',
          what_would_produce_it:
            'Run a profile pull on the Data screen; it writes profile_snapshots. Two pulls on different days are needed before any change can be computed.',
        });
        continue;
      }

      const latest = history[0];
      values.push(
        textValue(`${base}.taken_on`, `date this ${account} profile was observed`, latest.taken_on),
      );

      const fields: { key: string; label: string; observed: number | null }[] = [
        { key: 'followers', label: `followers, ${account} account`, observed: latest.followers },
        { key: 'following', label: `accounts followed, ${account} account`, observed: latest.following },
        {
          key: 'posts_count',
          label: `posts on the ${account} profile`,
          observed: latest.posts_count,
        },
      ];

      for (const field of fields) {
        if (field.observed === null) {
          absences.push({
            what: `${base}.${field.key}`,
            reason: `this profile snapshot did not include a ${field.key.replace('_', ' ')}.`,
            what_would_produce_it: 'A profile pull that returns this field for this account.',
          });
          continue;
        }
        const measured = value(`${base}.${field.key}`, field.label, field.observed, {
          as_of: latest.taken_on,
        });
        if (measured) values.push(measured);
      }

      const previous = history[1];
      if (previous === undefined) {
        absences.push({
          what: `${base}.followers.delta`,
          reason:
            'only one dated observation exists for this account, so no change can be computed. A single measurement is not a trend.',
          what_would_produce_it:
            'A second profile pull on a later day; the delta appears once two dated observations exist.',
        });
        continue;
      }

      values.push(
        textValue(
          `${base}.followers.delta.from_date`,
          `date the earlier ${account} observation was taken`,
          previous.taken_on,
        ),
      );

      if (latest.followers === null || previous.followers === null) {
        absences.push({
          what: `${base}.followers.delta`,
          reason:
            'one of the two observations has no follower count, so there is nothing to subtract.',
          what_would_produce_it: 'Two profile pulls that both return a follower count.',
        });
        continue;
      }

      const delta = value(
        `${base}.followers.delta`,
        `change in followers, ${account} account, between those two dates`,
        latest.followers - previous.followers,
        { as_of: latest.taken_on },
      );
      if (delta) values.push(delta);
    }

    return {
      ok: true,
      result: {
        lookup: 'follower_history',
        title: followerHistory.title,
        params: parsed.data,
        status: statusOf(values, absences),
        values,
        absences,
        notes: [],
        coverage: null,
        measured_over: null,
      },
    };
  },
};

/* ======================================================= the closed registry ==
 *
 * Five names, fixed at compile time. Adding a sixth means editing this tuple,
 * which means editing this file, which means the diff shows up in review — as
 * opposed to a registry that accretes entries from elsewhere in the tree.
 * ========================================================================== */

export const STAT_LOOKUP_NAMES = [
  'account_averages',
  'cluster_aggregates',
  'timing_windows',
  'top_posts',
  'follower_history',
] as const;

export type StatLookupName = (typeof STAT_LOOKUP_NAMES)[number];

/** Total over StatLookupName: a name in the tuple with no entry cannot compile. */
const LOOKUPS: Record<StatLookupName, StatLookup> = {
  account_averages: accountAverages,
  cluster_aggregates: clusterAggregates,
  timing_windows: timingWindows,
  top_posts: topPosts,
  follower_history: followerHistory,
};

/**
 * Membership of the frozen TUPLE, not a property lookup on the record — so
 * `__proto__`, `constructor`, `toString` and every other inherited key resolve
 * to nothing rather than to a function.
 */
export function isStatLookupName(name: string): name is StatLookupName {
  return (STAT_LOOKUP_NAMES as readonly string[]).includes(name);
}

export interface StatLookupDoc {
  name: StatLookupName;
  title: string;
  summary: string;
  params: string;
  emits: string;
}

/** The catalogue, as get_stats publishes it in its own description. */
export function statLookupCatalogue(): StatLookupDoc[] {
  return STAT_LOOKUP_NAMES.map((name) => {
    const lookup = LOOKUPS[name];
    return {
      name: lookup.name,
      title: lookup.title,
      summary: lookup.summary,
      params: lookup.params_doc,
      emits: lookup.emits,
    };
  });
}

/**
 * Run one named lookup.
 *
 * An unknown name is REFUSED BY NAME with the catalogue attached — it never
 * resolves to a computation, and the refusal is the shape rule 19 asks for:
 * say the computation does not exist, and offer to have one requested.
 */
export async function runStatLookup(
  db: SupabaseClient,
  name: string,
  params: unknown,
): Promise<StatLookupOutcome> {
  if (!isStatLookupName(name)) {
    return {
      ok: false,
      refusal: 'unknown_lookup',
      requested: name,
      available: STAT_LOOKUP_NAMES,
      reason:
        `There is no lookup called "${name}". This registry executes named, code-defined computations only — ` +
        `there is no free-SQL tool and no raw-table tool, so a question needing a computation that does not exist ` +
        `cannot be answered by trying a different name.`,
      what_you_can_do: [
        `Pick one of the ${STAT_LOOKUP_NAMES.length} lookups that exist: ${STAT_LOOKUP_NAMES.join(', ')}.`,
        'If none of them computes what was asked for, say so plainly and offer a request_computation item naming the computation that is missing. Do not estimate it and do not derive it from figures that measure something else.',
      ],
    };
  }

  return LOOKUPS[name].run(db, params);
}
