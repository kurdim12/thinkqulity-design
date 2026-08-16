/**
 * The strategist's context blocks.
 *
 * ===========================================================================
 * THE ONE IDEA
 * ===========================================================================
 * Every quantity the strategist is allowed to speak arrives here ALREADY
 * COMPUTED, paired with a stable `source_key`. The agent does no arithmetic —
 * not a subtraction, not a ratio, not an average. If a number is not on a line
 * below with a key in front of it, the agent may not state it; it has to ask
 * for it instead. That is the whole design, and everything in this file exists
 * to make it structural rather than aspirational:
 *
 *   - a measure is `{key, label, value}` where `value` is a STRING, so nothing
 *     downstream can recompute, rescale or re-round it (see BasisRef in
 *     src/lib/types/db.ts);
 *   - `renderStrategistBlocks()` and `collectSourceKeys()` are both built from
 *     the SAME block list, so the set of keys the Law check verifies against is
 *     by construction the set of keys the agent was shown — they cannot drift;
 *   - a value that does not exist is rendered as an ABSENCE and emits NO key.
 *
 * ===========================================================================
 * WHY AN ABSENT VALUE MUST NOT GET A KEY
 * ===========================================================================
 * A key that resolves to nothing is worse than a missing key. A missing key
 * makes the agent ask; a key holding "0", "—" or "null" invites a confident
 * sentence about a value nobody measured, and the sentence arrives wearing a
 * citation. profile_snapshots, comments and post_analyses are ALL EMPTY today,
 * so the empty case is not an edge case here — it is the common case, and the
 * blocks say "no measurement exists" out loud, by name, with the reason.
 *
 * Note the distinction the whole feature turns on: a COUNT of zero is a
 * measurement (we counted the analysed posts; there were none). An AVERAGE
 * over zero posts is an absence. The first gets a key and the value "0"; the
 * second gets no key at all (hard rule 2).
 *
 * ===========================================================================
 * SOURCE KEY CONVENTION
 * ===========================================================================
 *   <block>.<subject>[.<qualifier>…].<measure>
 *
 * Dotted, lowercase, self-describing, e.g.
 *   profiles.personal.followers
 *   performance.clusters.reels.vs_account_avg
 *   content_state.shipped.backfill.measured
 *
 * Fixed segments (block names, account names, measure names) are stable across
 * runs and are the ones a reader can rely on. Segments MINTED FROM DATA — a
 * cluster slug, a theme slug, a decision id, a window index — identify an item
 * within the run that produced them, which is all a basis reference ever needs:
 * a decision cites the evidence it was actually shown, at the moment it was
 * shown. Minted segments are de-duplicated (`_2`, `_3`) so one key never names
 * two things.
 *
 * ===========================================================================
 * RENDERED FORM
 * ===========================================================================
 *   [some.source.key] what it is (n=…, as_of=…) = "the value"
 *   (no measurement) some.source.key — why there is no number for this.
 *
 * A line starting with `[` is always a measure and its bracket always holds a
 * real key. A line starting with `(no measurement)` never has one. Everything
 * else is prose, and prose in this file CONTAINS NO DIGITS BY RULE — a number
 * loose in a note would be quotable without a key, which is exactly what this
 * module exists to prevent.
 *
 * ===========================================================================
 * PURITY
 * ===========================================================================
 * Everything above `loadStrategistData()` is pure: no I/O, no environment
 * reads, no model, no clock (today's date is passed in). That is what makes
 * the blocks unit-testable with no database, and it is why the imports carry
 * explicit `.ts` extensions — this module runs unchanged under
 * `node --test --experimental-strip-types`, exactly as the Law and audience
 * modules do. `loadStrategistData()` is the only impure function here and it
 * takes its database handle as an argument rather than building one, so no
 * secret and no env read reaches this file.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { wholeQuantity } from '../../brain/law/claims-linter.ts';
import {
  distinctPosts,
  scanCoverage,
  MAX_POSTS_SCAN,
  type ScanCoverage,
} from '../../audience/posts.ts';
import { buildTiming, MIN_WINDOW_N, type TimingResult } from '../../audience/timing.ts';
import type {
  Account,
  AudienceInsightRow,
  BrandRow,
  ConceptFormat,
  ConceptRow,
  ConceptStatus,
  DecisionRow,
  DecisionStatus,
  PostRow,
  ProfileSnapshotRow,
} from '../../types/db.ts';

/* ============================================================== alphabet == */

/**
 * One quantity or one quotable string, with the key that resolves it.
 *
 * `value` is text, always, for the reason spelled out on BasisRef: a number
 * that travelled as a string cannot have been quietly recomputed on the way to
 * the sentence that states it. `n` and `as_of` are attributes OF this measure
 * and share its key — a basis reference to `performance.personal.avg_engagement`
 * carries the sample size that came with it (hard rule 11).
 */
export interface Measure {
  /** Dotted, stable. See the convention above. */
  key: string;
  /** What this is, in English, for the agent. Contains no bare quantity. */
  label: string;
  /** VERBATIM, exactly as it will be quoted back. Never a number type. */
  value: string;
  /** How many observations stand behind the value. Omitted when meaningless. */
  n?: number | null;
  /** The date the value was measured on. Omitted when it has no date. */
  as_of?: string | null;
}

/**
 * Something that was NOT measured. `what` is the dotted name the key WOULD
 * have had, which is the most useful thing to tell an agent that wanted it —
 * and it is deliberately not registered as a key, so a basis reference to it
 * fails the Law check instead of resolving to a hole.
 */
export interface Absence {
  /** The name of the thing that does not exist, e.g. `profiles.personal.followers`. */
  what: string;
  /** Why there is no measurement. Contains no digits, by rule. */
  reason: string;
}

/** One rendered block. Notes are prose; every quantity lives in `measures`. */
export interface StrategistBlock {
  tag: string;
  notes: string[];
  measures: Measure[];
  absences: Absence[];
}

/* ============================================================== policy === */

/**
 * Thresholds are POLICY, not measurement: they are stated here, in code, and
 * travel into the block so the agent quotes the rule it was actually given
 * rather than inventing a bar to clear.
 */
export interface AnomalyThresholds {
  /** At or above this multiple of the account average, a post is an outlier. */
  outlier_multiple: number;
  /** Below this many posts a cluster average is one loud post wearing a trend coat. */
  min_cluster_n: number;
  /** Past this age, every performance figure is stale and must be labelled so. */
  stale_after_days: number;
  /** Below this percent, a change is noise and is not reported as a movement. */
  material_change_pct: number;
}

/** Three actions is a plan; twelve is a list nobody does. */
export const DEFAULT_ACTION_BUDGET = 3;

/** How many days a digest period covers when the caller does not say. */
export const DEFAULT_PERIOD_DAYS = 7;

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  outlier_multiple: 2,
  // The same floor the timing engine enforces, imported rather than retyped so
  // there is exactly one such number in the app.
  min_cluster_n: MIN_WINDOW_N,
  stale_after_days: 14,
  material_change_pct: 5,
};

/* ======================================================= input contract == */

/** The newest guideline version on record. */
export interface GuidelineVersion {
  version: number;
  status: string;
  created_at: string;
}

/**
 * One account's profile history, latest first. `previous` exists only when a
 * SECOND dated observation exists — one measurement is not a trend, and the
 * delta is simply not emitted when there is nothing to subtract from.
 */
export interface ProfileObservation {
  taken_on: string;
  followers: number | null;
  following: number | null;
  posts_count: number | null;
  previous: {
    taken_on: string;
    followers: number | null;
    following: number | null;
    posts_count: number | null;
  } | null;
}

/** One account's slice of the snapshot, computed over DISTINCT posts. */
export interface AccountPerformance {
  post_count: number;
  total_engagement: number;
  /** Null when post_count is 0 — an average over nothing is an absence. */
  avg_engagement: number | null;
  top_post: {
    url: string | null;
    engagement: number;
    posted_at: string | null;
  } | null;
}

/** One board cluster, aggregated in code from post_analyses x posts. */
export interface ClusterAggregate {
  label: string;
  account: Account;
  n: number;
  avg_engagement: number | null;
  /** Cluster average / account average. Null when the account average is 0. */
  vs_account_avg: number | null;
}

export interface PerformanceInput {
  snapshot: { id: string; taken_on: string } | null;
  accounts: Record<Account, AccountPerformance | null>;
  clusters: ClusterAggregate[];
  /** From src/lib/audience/timing.ts. Nothing here computes a timing figure. */
  timing: TimingResult[];
  posts_coverage: ScanCoverage | null;
  duplicates_collapsed: number;
  /** Rows in post_analyses. Null means "not read", 0 means "read, none there". */
  analyses_count: number | null;
}

export interface ShippedConcept {
  id: string;
  title: string;
  account: Account;
  format: ConceptFormat;
  shipped_url: string | null;
  /** Null = not backfilled yet. Never 0 — 0 would be a measured result. */
  shipped_engagement: number | null;
}

export interface ContentStateInput {
  counts: Record<ConceptStatus, number>;
  shipped: ShippedConcept[];
}

export interface MetaInput {
  /** ISO date. Passed in so every pure function here stays clock-free. */
  today: string;
  period: { from: string; to: string };
  /** Age of the snapshot in days. Null when there is no snapshot. */
  staleness_days: number | null;
  action_budget: number;
  thresholds: AnomalyThresholds;
}

/** Everything the blocks are built from. Assembled by loadStrategistData(). */
export interface StrategistData {
  brand: BrandRow | null;
  guideline: GuidelineVersion | null;
  profiles: Record<Account, ProfileObservation | null>;
  performance: PerformanceInput;
  audience: AudienceInsightRow | null;
  content: ContentStateInput;
  /** Past decisions, newest first, with the status a review gave them. */
  ledger: DecisionRow[];
  meta: MetaInput;
}

/* =============================================================== helpers == */

const ACCOUNTS: readonly Account[] = ['personal', 'academy'];
const CONCEPT_STATUSES: readonly ConceptStatus[] = ['draft', 'approved', 'shipped', 'rejected'];
const DECISION_STATUSES: readonly DecisionStatus[] = [
  'open',
  'validated',
  'refuted',
  'superseded',
];

/**
 * The single place a number becomes text.
 *
 * Rounding happens here and nowhere else, so one quantity never appears in two
 * textual forms — which matters beyond tidiness: the Law's claims-linter traces
 * a number in the output back to the context by string match, and `507.97` in
 * the block against `507.9736842105263` in the sentence would read as an
 * invented figure. No thousands separators, for the same reason.
 *
 * A value that is not a finite number returns null — it is not rendered as 0.
 */
export function formatQuantity(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  return String(Math.round(value * 100) / 100);
}

/** A change, with its sign kept: `+41`, `-7`, `0`. */
export function formatDelta(value: number): string | null {
  const text = formatQuantity(value);
  if (text === null) return null;
  return value > 0 ? `+${text}` : text;
}

/**
 * Turns a label into one key segment: lowercase, separators to underscore,
 * punctuation dropped. Letters and digits of ANY script survive, so an Arabic
 * cluster label keeps its identity instead of collapsing to nothing. Returns
 * '' when nothing usable is left; callers substitute a positional segment.
 */
export function keySegment(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[\s./\\|:،؛,-]+/gu, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Mints one unique segment per label, in order. A collision gets `_2`, `_3` —
 * because one key naming two things is a basis reference that resolves to the
 * wrong evidence, which is worse than no reference at all.
 */
export function uniqueSegments(labels: readonly string[]): string[] {
  const used = new Map<string, number>();
  return labels.map((label, index) => {
    const base = keySegment(label) || `item_${index + 1}`;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}_${seen + 1}`;
  });
}

/** Whole days between two ISO dates. Null when either side is unparseable. */
export function daysBetweenIso(fromIso: string, toIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/** `today` shifted by whole days, as an ISO date. */
export function addDaysIso(iso: string, days: number): string | null {
  const at = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(at)) return null;
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- drafting -- */

interface Draft {
  tag: string;
  notes: string[];
  measures: Measure[];
  absences: Absence[];
}

function draft(tag: string): Draft {
  return { tag, notes: [], measures: [], absences: [] };
}

interface MeasureOptions {
  n?: number | null;
  as_of?: string | null;
}

/**
 * A value that CANNOT be absent by construction — a count, a status, a date
 * that was read from a row that exists. Choosing this function over
 * `measured()` is a statement about the data, so it is deliberately a separate
 * call rather than a flag.
 *
 * A number that turns out not to be finite still does not become 0: it becomes
 * an absence, because a broken value is not a measurement either.
 */
function always(
  d: Draft,
  key: string,
  label: string,
  value: string | number,
  opts: MeasureOptions = {},
): void {
  const text = typeof value === 'number' ? formatQuantity(value) : value;
  if (text === null) {
    d.absences.push({ what: key, reason: 'the stored value was not a usable number.' });
    return;
  }
  d.measures.push({ key, label, value: text, ...opts });
}

/**
 * The gate. A value that exists becomes a keyed measure; a value that does not
 * becomes an absence with NO key and a reason the agent can read. Every
 * nullable quantity in this file goes through here, which is what makes "absent
 * is absent, never zero" a property of the module rather than a habit.
 */
function measured(
  d: Draft,
  key: string,
  label: string,
  value: string | number | null | undefined,
  reason: string,
  opts: MeasureOptions = {},
): void {
  if (value === null || value === undefined || value === '') {
    d.absences.push({ what: key, reason });
    return;
  }
  always(d, key, label, value, opts);
}

function absent(d: Draft, what: string, reason: string): void {
  d.absences.push({ what, reason });
}

/* ========================================================= block: brand == */

function brandBlock(data: StrategistData): StrategistBlock {
  const d = draft('brand');
  const brand = data.brand;

  if (!brand) {
    absent(d, 'brand', 'the brand record has not been seeded; no fact, colour or voice example exists.');
    return d;
  }

  d.notes.push(
    'Facts, palette and voice as stored on the brand record. Every line here is quotable verbatim.',
  );
  always(d, 'brand.status', 'brand record status', brand.status);

  const factSegments = uniqueSegments((brand.facts ?? []).map((fact) => fact.key));
  (brand.facts ?? []).forEach((fact, index) => {
    const key = `brand.facts.${factSegments[index]}`;
    measured(d, key, `brand fact: ${fact.key}`, fact.value, 'this fact has no stored value.');
    measured(
      d,
      `${key}.source`,
      `where the fact "${fact.key}" came from`,
      fact.source,
      'this fact was stored without a source and must not be repeated as established.',
    );
  });
  if ((brand.facts ?? []).length === 0) {
    absent(d, 'brand.facts', 'the brand record carries no facts.');
  }

  (brand.voice_examples ?? []).forEach((example, index) => {
    const key = `brand.voice_examples.${index + 1}`;
    always(d, key, 'a real published caption, in his own voice', example.text);
    measured(
      d,
      `${key}.engagement`,
      'engagement on that caption',
      example.engagement,
      'this voice example was stored without an engagement figure.',
    );
    measured(
      d,
      `${key}.source_url`,
      'permalink for that caption',
      example.source_url,
      'this voice example was stored without a permalink.',
    );
  });
  if ((brand.voice_examples ?? []).length === 0) {
    absent(d, 'brand.voice_examples', 'no voice example is stored; his register cannot be quoted.');
  }

  const swatches = brand.palette?.swatches ?? null;
  const swatchNames = swatches ? Object.keys(swatches) : [];
  if (swatches && swatchNames.length > 0) {
    for (const name of swatchNames) {
      always(d, `brand.palette.${keySegment(name) || name}`, `palette swatch "${name}"`, swatches[name]);
    }
  } else {
    absent(
      d,
      'brand.palette',
      'the brand record has no palette; no colour may be named in any output.',
    );
  }

  measured(
    d,
    'brand.typography.arabic_display',
    'Arabic display typeface',
    brand.typography?.arabic_display,
    'the Arabic display typeface is unconfirmed.',
  );
  measured(
    d,
    'brand.typography.arabic_body',
    'Arabic body typeface',
    brand.typography?.arabic_body,
    'the Arabic body typeface is unconfirmed.',
  );
  measured(
    d,
    'brand.audience_notes',
    'stored notes about the audience',
    brand.audience_notes,
    'the brand record carries no audience notes.',
  );

  const docSegments = uniqueSegments((brand.knowledge ?? []).map((doc) => doc.title));
  (brand.knowledge ?? []).forEach((doc, index) => {
    always(
      d,
      `brand.knowledge.${docSegments[index]}`,
      `his own material: "${doc.title}" (${doc.kind}) — cite by this source string`,
      doc.source,
    );
  });
  if ((brand.knowledge ?? []).length === 0) {
    absent(d, 'brand.knowledge', 'no workshop material has been loaded.');
  }

  if (data.guideline) {
    always(d, 'brand.guideline.version', 'newest brand guideline version', data.guideline.version);
    always(d, 'brand.guideline.status', 'status of that guideline version', data.guideline.status);
    always(
      d,
      'brand.guideline.created_at',
      'when that guideline version was written',
      data.guideline.created_at,
    );
  } else {
    absent(d, 'brand.guideline', 'no brand guideline has been generated yet.');
  }

  return d;
}

/* ====================================================== block: profiles == */

function profilesBlock(data: StrategistData): StrategistBlock {
  const d = draft('profiles');
  d.notes.push(
    'Follower history, per account, each figure carrying the date it was observed on. A delta exists only where two dated observations exist.',
  );

  for (const account of ACCOUNTS) {
    const observed = data.profiles[account];
    const base = `profiles.${account}`;

    if (!observed) {
      absent(
        d,
        base,
        'no profile snapshot has ever been recorded for this account, so follower, following and post-count figures do not exist. State an em-dash, never a number.',
      );
      continue;
    }

    always(d, `${base}.taken_on`, `date this ${account} profile was observed`, observed.taken_on);
    measured(
      d,
      `${base}.followers`,
      `followers, ${account} account`,
      observed.followers,
      'this profile snapshot did not include a follower count.',
      { as_of: observed.taken_on },
    );
    measured(
      d,
      `${base}.following`,
      `accounts followed, ${account} account`,
      observed.following,
      'this profile snapshot did not include a following count.',
      { as_of: observed.taken_on },
    );
    measured(
      d,
      `${base}.posts_count`,
      `posts on the ${account} profile`,
      observed.posts_count,
      'this profile snapshot did not include a post count.',
      { as_of: observed.taken_on },
    );

    const previous = observed.previous;
    if (!previous) {
      absent(
        d,
        `${base}.followers.delta`,
        'only one dated observation exists for this account, so no change can be computed. A single measurement is not a trend.',
      );
      continue;
    }

    always(
      d,
      `${base}.previous.taken_on`,
      `date of the previous ${account} profile observation`,
      previous.taken_on,
    );
    measured(
      d,
      `${base}.previous.followers`,
      `followers at that earlier date, ${account} account`,
      previous.followers,
      'the earlier profile snapshot did not include a follower count.',
      { as_of: previous.taken_on },
    );

    if (observed.followers !== null && previous.followers !== null) {
      // Code does the subtraction. The agent quotes the answer.
      const change = formatDelta(observed.followers - previous.followers);
      measured(
        d,
        `${base}.followers.delta`,
        `change in followers between those two dates, ${account} account`,
        change,
        'one of the two observations has no follower count, so the change cannot be computed.',
        { as_of: observed.taken_on },
      );
      const days = daysBetweenIso(previous.taken_on, observed.taken_on);
      measured(
        d,
        `${base}.followers.delta.days`,
        'days between those two observations',
        days,
        'the two observation dates could not be read.',
      );
    } else {
      absent(
        d,
        `${base}.followers.delta`,
        'one of the two observations has no follower count, so the change cannot be computed.',
      );
    }
  }

  return d;
}

/* =================================================== block: performance == */

function performanceBlock(data: StrategistData): StrategistBlock {
  const d = draft('performance');
  const perf = data.performance;

  if (!perf.snapshot) {
    absent(
      d,
      'performance',
      'no engagement snapshot has been ingested, so no performance measurement of any kind exists.',
    );
    return d;
  }

  d.notes.push(
    'Everything below is measured over DISTINCT posts in one snapshot — re-scrape rows are collapsed before any average is taken. Sample sizes travel with their figures.',
  );
  always(d, 'performance.snapshot.taken_on', 'date the snapshot was taken', perf.snapshot.taken_on);
  always(d, 'performance.snapshot.id', 'id of the snapshot everything here is measured over', perf.snapshot.id);

  const coverage = perf.posts_coverage;
  if (coverage) {
    always(d, 'performance.scan.rows_fetched', 'scrape rows read for this snapshot', coverage.rows_fetched);
    always(d, 'performance.scan.limit', 'row ceiling the read applied', coverage.limit);
    always(
      d,
      'performance.scan.truncated',
      'whether the read filled its ceiling, so the population may be only a prefix',
      coverage.truncated ? 'true' : 'false',
    );
    always(
      d,
      'performance.scan.duplicates_collapsed',
      're-scrape rows collapsed so each post is counted once',
      perf.duplicates_collapsed,
    );
  } else {
    absent(d, 'performance.scan', 'the post population was supplied without coverage information.');
  }

  for (const account of ACCOUNTS) {
    const stats = perf.accounts[account];
    const base = `performance.${account}`;

    if (!stats) {
      absent(d, base, 'this account has no rows in the snapshot, so it was not measured.');
      continue;
    }

    always(d, `${base}.post_count`, `distinct posts, ${account} account`, stats.post_count, {
      as_of: perf.snapshot.taken_on,
    });
    always(
      d,
      `${base}.total_engagement`,
      `total engagement across those posts, ${account} account`,
      stats.total_engagement,
      { n: stats.post_count, as_of: perf.snapshot.taken_on },
    );
    measured(
      d,
      `${base}.avg_engagement`,
      `mean engagement per post, ${account} account`,
      stats.avg_engagement,
      'this account has no posts in the snapshot, so there is no average to state.',
      { n: stats.post_count, as_of: perf.snapshot.taken_on },
    );

    if (stats.top_post) {
      always(
        d,
        `${base}.top_post.engagement`,
        `engagement on the strongest ${account} post`,
        stats.top_post.engagement,
        { as_of: perf.snapshot.taken_on },
      );
      measured(
        d,
        `${base}.top_post.url`,
        `permalink of the strongest ${account} post`,
        stats.top_post.url,
        'the strongest post was stored without a permalink.',
      );
      measured(
        d,
        `${base}.top_post.posted_at`,
        `when the strongest ${account} post was published`,
        stats.top_post.posted_at,
        'the strongest post was stored without a publish time.',
      );
    } else {
      absent(d, `${base}.top_post`, 'this account has no posts in the snapshot.');
    }
  }

  /* ----------------------------------------------------------- clusters -- */

  if (perf.clusters.length === 0) {
    absent(
      d,
      'performance.clusters',
      'no post has been analysed yet, so no cluster aggregate exists. Any statement about what kind of content performs is a hypothesis, not a measurement.',
    );
  } else {
    const segments = uniqueSegments(perf.clusters.map((cluster) => cluster.label));
    perf.clusters.forEach((cluster, index) => {
      const base = `performance.clusters.${segments[index]}`;
      always(d, `${base}.label`, 'cluster label as stored', cluster.label);
      always(d, `${base}.account`, 'which account this cluster was measured on', cluster.account);
      always(d, `${base}.n`, 'posts in this cluster', cluster.n);
      measured(
        d,
        `${base}.avg_engagement`,
        'mean engagement per post in this cluster',
        cluster.avg_engagement,
        'this cluster has no posts with engagement, so it has no average.',
        { n: cluster.n },
      );
      measured(
        d,
        `${base}.vs_account_avg`,
        'cluster average as a multiple of the account average',
        cluster.vs_account_avg,
        'the account average is not positive, so a multiple against it would be meaningless.',
        { n: cluster.n },
      );
    });
  }

  /* ------------------------------------------------------------- timing -- */

  if (perf.timing.length === 0) {
    absent(
      d,
      'performance.timing',
      'no timing report was computed, so nothing about when to post can be stated.',
    );
  }

  for (const report of perf.timing) {
    const base = `performance.timing.${report.account}`;
    always(d, `${base}.total_n`, `posts with a usable publish time, ${report.account}`, report.total_n);
    always(d, `${base}.time_zone`, 'timezone every hour below is expressed in', report.time_zone);
    always(
      d,
      `${base}.min_window_n`,
      'minimum posts a window had to clear to be reported at all',
      report.min_window_n,
    );

    // timing.ts documents this exactly: overall_avg is 0 only when total_n is 0,
    // and a consumer MUST branch rather than present that 0 as an average.
    if (report.total_n > 0) {
      always(d, `${base}.overall_avg`, `mean engagement across those posts, ${report.account}`, report.overall_avg, {
        n: report.total_n,
      });
    } else {
      absent(
        d,
        `${base}.overall_avg`,
        'no post in this population has a usable publish time, so there is no average — the zero in the timing report is an absence, not a measurement.',
      );
    }

    if (report.best_windows.length === 0) {
      absent(
        d,
        `${base}.windows`,
        'no hour range cleared the minimum sample size while beating the average, so no posting window is reportable.',
      );
      continue;
    }

    report.best_windows.forEach((window, index) => {
      const wBase = `${base}.windows.${index + 1}`;
      always(d, `${wBase}.label`, 'the hour range, strongest first', window.label, { n: window.n });
      always(d, `${wBase}.n`, 'posts published in that range', window.n);
      always(d, `${wBase}.avg_engagement`, 'mean engagement in that range', window.avg_engagement, {
        n: window.n,
      });
      always(
        d,
        `${wBase}.multiple_vs_overall`,
        'that range against the overall average',
        window.multiple_vs_overall,
        { n: window.n },
      );
    });
  }

  measured(
    d,
    'performance.analyses.count',
    'posts that have been analysed so far',
    perf.analyses_count,
    'the analysis table was not read, so how many posts are analysed is unknown.',
  );

  return d;
}

/* ====================================================== block: audience == */

function audienceBlock(data: StrategistData): StrategistBlock {
  const d = draft('audience');
  const insight = data.audience;

  d.notes.push(
    'Aggregate only. Hard rule ten: commenters are an audience, not targets — no handle and no per-person figure reaches this block, by construction.',
  );

  if (!insight) {
    absent(
      d,
      'audience',
      'no audience insight has been generated and the comment corpus is empty, so nothing about what the audience says, asks or wants can be stated. Any such claim is a hypothesis.',
    );
    return d;
  }

  always(d, 'audience.grounding', 'how well grounded the stored insight is', insight.grounding);
  always(d, 'audience.created_at', 'when the insight was generated', insight.created_at);
  measured(
    d,
    'audience.register_notes',
    'stored notes on how the audience writes',
    insight.register_notes,
    'the insight carries no register notes.',
  );

  if (insight.themes.length === 0) {
    absent(d, 'audience.themes', 'the insight names no theme.');
  } else {
    const segments = uniqueSegments(insight.themes.map((theme) => theme.label));
    insight.themes.forEach((theme, index) => {
      const base = `audience.themes.${segments[index]}`;
      always(d, `${base}.label`, 'theme label as stored', theme.label);
      always(d, `${base}.n`, 'comments falling in this theme', theme.n);
      always(d, `${base}.grounding`, 'how well grounded this theme is', theme.grounding);
      theme.quotes.forEach((quote, qIndex) => {
        always(
          d,
          `${base}.quotes.${qIndex + 1}`,
          'a real comment, verbatim — quote it exactly or not at all',
          quote.text,
          { n: theme.n },
        );
      });
    });
  }

  if (insight.questions.length === 0) {
    absent(d, 'audience.questions', 'the insight records no audience question.');
  } else {
    insight.questions.forEach((question, index) => {
      const base = `audience.questions.${index + 1}`;
      always(d, `${base}.text`, 'a question the audience actually asked, verbatim', question.text);
      always(d, `${base}.asked_count`, 'times that question was asked', question.asked_count);
    });
  }

  return d;
}

/* ================================================= block: content_state == */

function contentStateBlock(data: StrategistData): StrategistBlock {
  const d = draft('content_state');
  d.notes.push(
    'What has been drafted, approved and shipped, and which shipped pieces have had their result read back. A shipped piece with no backfilled result is not a failure — it is unmeasured.',
  );

  for (const status of CONCEPT_STATUSES) {
    always(
      d,
      `content_state.counts.${status}`,
      `concepts with status ${status}`,
      data.content.counts[status] ?? 0,
    );
  }

  const shipped = data.content.shipped;
  if (shipped.length === 0) {
    absent(d, 'content_state.shipped', 'nothing has been marked shipped, so there is no result to read.');
    return d;
  }

  let measuredCount = 0;
  shipped.forEach((concept, index) => {
    const base = `content_state.shipped.${index + 1}`;
    always(d, `${base}.title`, 'title of a shipped concept', concept.title);
    always(d, `${base}.account`, 'which account it shipped on', concept.account);
    always(d, `${base}.format`, 'its format', concept.format);
    measured(
      d,
      `${base}.url`,
      'its permalink',
      concept.shipped_url,
      'this concept was marked shipped without a permalink, so its result cannot be matched.',
    );
    if (concept.shipped_engagement !== null) measuredCount += 1;
    measured(
      d,
      `${base}.engagement`,
      'engagement it actually earned',
      concept.shipped_engagement,
      'this concept was marked shipped but its result has not been backfilled; there is no engagement figure for it and none may be estimated.',
    );
  });

  always(
    d,
    'content_state.shipped.backfill.measured',
    'shipped concepts whose real result has been read back',
    measuredCount,
  );
  always(
    d,
    'content_state.shipped.backfill.pending',
    'shipped concepts still waiting for their result',
    shipped.length - measuredCount,
  );

  return d;
}

/* ======================================================== block: ledger == */

function ledgerBlock(data: StrategistData): StrategistBlock {
  const d = draft('ledger');
  d.notes.push(
    'Past decisions and what became of them. A decision that the data has since contradicted is corrected in this run, by name — being wrong in public is the mechanism, not a failure of it.',
  );

  const counts = new Map<DecisionStatus, number>();
  for (const status of DECISION_STATUSES) counts.set(status, 0);
  for (const decision of data.ledger) {
    counts.set(decision.status, (counts.get(decision.status) ?? 0) + 1);
  }
  for (const status of DECISION_STATUSES) {
    always(d, `ledger.counts.${status}`, `decisions with status ${status}`, counts.get(status) ?? 0);
  }

  const due = data.ledger.filter(
    (decision) => decision.status === 'open' && decision.review_after <= data.meta.today,
  );
  always(d, 'ledger.due_for_review', 'open decisions whose review date has passed', due.length);

  if (data.ledger.length === 0) {
    absent(d, 'ledger.decisions', 'no decision has been recorded yet; there is nothing to review.');
    return d;
  }

  for (const decision of data.ledger) {
    const base = `ledger.decisions.${decision.id}`;
    always(d, `${base}.statement_ar`, 'what was decided, verbatim', decision.statement_ar);
    always(d, `${base}.kind`, 'what kind of decision it was', decision.kind);
    always(d, `${base}.grounding`, 'how well grounded it was when written', decision.grounding);
    always(d, `${base}.expected_signal`, 'what was stated in advance as proof', decision.expected_signal);
    always(d, `${base}.review_after`, 'the date it was to be judged on', decision.review_after);
    always(d, `${base}.status`, 'what a review made of it', decision.status);
    always(d, `${base}.created_at`, 'when it was written', decision.created_at);
    measured(
      d,
      `${base}.outcome_note`,
      'what the review found',
      decision.outcome_note,
      'this decision has not been reviewed, so there is no outcome. Unreviewed is not the same as fine.',
    );

    const refs = decision.basis ?? [];
    if (refs.length === 0) {
      absent(d, `${base}.basis`, 'this decision was recorded without evidence.');
      continue;
    }
    const segments = uniqueSegments(refs.map((ref) => ref.source_key));
    refs.forEach((ref, index) => {
      always(
        d,
        `${base}.basis.${segments[index]}`,
        `evidence it rested on, under the key ${ref.source_key}`,
        ref.value,
      );
    });
  }

  return d;
}

/* ========================================================== block: meta == */

function metaBlock(data: StrategistData): StrategistBlock {
  const d = draft('meta');
  d.notes.push(
    'The frame for this run: the period, how old the data is, the bar a movement has to clear, and how many actions may be asked for.',
  );

  always(d, 'meta.today', "today's date", data.meta.today);
  always(d, 'meta.period.from', 'first day of the period this digest covers', data.meta.period.from);
  always(d, 'meta.period.to', 'last day of the period this digest covers', data.meta.period.to);
  measured(
    d,
    'meta.staleness_days',
    'age of the newest snapshot, in days',
    data.meta.staleness_days,
    'there is no snapshot, so its age cannot be computed and no performance figure may be described as current.',
  );
  always(
    d,
    'meta.action_budget',
    'the most actions this run may ask a human for',
    data.meta.action_budget,
  );
  always(
    d,
    'meta.thresholds.outlier_multiple',
    'multiple of the account average at which a post counts as an outlier',
    data.meta.thresholds.outlier_multiple,
  );
  always(
    d,
    'meta.thresholds.min_cluster_n',
    'posts a cluster needs before its average may be reported',
    data.meta.thresholds.min_cluster_n,
  );
  always(
    d,
    'meta.thresholds.stale_after_days',
    'age past which every performance figure must be labelled stale',
    data.meta.thresholds.stale_after_days,
  );
  always(
    d,
    'meta.thresholds.material_change_pct',
    'percent below which a change is noise rather than a movement',
    data.meta.thresholds.material_change_pct,
  );

  return d;
}

/* ====================================================== assembly & render = */

/**
 * The seven blocks, in reading order. BOTH `renderStrategistBlocks()` and
 * `collectSourceKeys()` go through here, which is the mechanism that keeps the
 * keys the Law check verifies against identical to the keys the agent saw.
 */
export function buildStrategistBlocks(data: StrategistData): StrategistBlock[] {
  return [
    brandBlock(data),
    profilesBlock(data),
    performanceBlock(data),
    audienceBlock(data),
    contentStateBlock(data),
    ledgerBlock(data),
    metaBlock(data),
  ];
}

/** The seven tags, in the order `buildStrategistBlocks()` returns them. */
export const BLOCK_TAGS: readonly string[] = [
  'brand',
  'profiles',
  'performance',
  'audience',
  'content_state',
  'ledger',
  'meta',
];

/**
 * The contract, stated to the agent before the data. It is prose only — it
 * contains no digits and no bracketed key, so nothing in it can be mistaken
 * for a measure or scraped as one.
 */
const CONTRACT = [
  '<blocks_contract>',
  'Every quantity you may state appears below on a line that begins with its source key in square brackets, then a label, then an equals sign, then the value in double quotes.',
  'Quote the value exactly as written between those quotes, and cite its key. Where a line shows a sample size or an observation date, carry those with the figure.',
  'A line beginning with the words "no measurement" in parentheses names something that was NOT measured. It has no key and no number exists for it. Write an em-dash. Do not estimate, and do not treat it as zero.',
  'If a figure you want is not on a keyed line, you may not state it. Say what you would need and ask for it.',
  'You do no arithmetic. Differences, averages, ratios and counts are computed in code and appear as their own keys, or they do not exist.',
  '</blocks_contract>',
].join('\n');

function renderMeasure(measure: Measure): string {
  const qualifiers: string[] = [];
  if (measure.n !== null && measure.n !== undefined) qualifiers.push(`n=${measure.n}`);
  if (measure.as_of) qualifiers.push(`as_of=${measure.as_of}`);
  const tail = qualifiers.length > 0 ? ` (${qualifiers.join(', ')})` : '';
  // JSON.stringify keeps the value on one line and escapes nothing that
  // matters: Arabic letters and Arabic-Indic digits pass through untouched, so
  // "٣٤٠" arrives at the agent as the author wrote it.
  return `[${measure.key}] ${measure.label}${tail} = ${JSON.stringify(measure.value)}`;
}

function renderAbsence(absence: Absence): string {
  return `(no measurement) ${absence.what} — ${absence.reason}`;
}

function renderBlock(block: StrategistBlock): string {
  const lines = [
    ...block.notes,
    ...block.measures.map(renderMeasure),
    ...block.absences.map(renderAbsence),
  ];
  return `<${block.tag}>\n${lines.join('\n')}\n</${block.tag}>`;
}

/**
 * The context the strategist reads. Pure: same input, same string, no clock,
 * no database, no model.
 */
export function renderStrategistBlocks(data: StrategistData): string {
  return [CONTRACT, ...buildStrategistBlocks(data).map(renderBlock)].join('\n\n');
}

/**
 * Every measure the agent was shown, in render order. Exported alongside the
 * key set because a Law check that only knows the KEYS can verify a basis
 * reference resolves; one that also knows the VALUES can verify the quoted
 * text was not altered on the way into the claim.
 */
export function collectMeasures(data: StrategistData): Measure[] {
  return buildStrategistBlocks(data).flatMap((block) => block.measures);
}

/**
 * Every source_key the blocks emitted — and only those. An absent measurement
 * contributes nothing here, so a basis reference to something that was never
 * measured fails to resolve instead of quietly succeeding against a hole.
 */
export function collectSourceKeys(data: StrategistData): Set<string> {
  return new Set(collectMeasures(data).map((measure) => measure.key));
}

/* ==================================================== what counts as evidence */

/**
 * ===========================================================================
 * WHAT THE BLOCKS RENDER AND WHAT THEY VOUCH FOR ARE TWO DIFFERENT THINGS
 * ===========================================================================
 *
 * `renderStrategistBlocks()` is what the AGENT READS. It has to carry the
 * client's own captions, the audience's own comments and questions, the titles
 * of shipped pieces and the text of past decisions — that is what a voice
 * example is FOR, and the agent cannot match a register it has not been shown.
 *
 * This is what the LAW TRACES A NUMBER BACK TO, and it is a different list. The
 * defect that made the distinction necessary was executed: a caption reading
 * «عدد المتدربين 88123» was rendered into the lint context verbatim, so the
 * claims-linter found 88123 there and the agent could state 88123 as measured
 * fact. The same held for an audience comment, an audience question, a shipped
 * title and a decision statement. None of those is a measurement. All of them
 * are text somebody typed — the client, the audience, or a model.
 *
 * THE RULE, and it is structural rather than a list of the five known carriers:
 * a measure is evidence only where its VALUE IS ITSELF A QUANTITY. `508` is;
 * «عدد المتدربين 88123 متدرب» is not, it is prose that contains digits. A sixth
 * free-text measure added later is therefore not evidence either, and nobody has
 * to remember to exclude it.
 *
 * THE COST, stated rather than discovered later: a caption or a comment that
 * quotes a REAL figure no measure holds makes that figure unquotable. The agent
 * that repeats it has the number cut out and the chip left in its place, even
 * though the client himself wrote it. That is the right way round for this
 * product — the alternative is that anything ever typed into the account becomes
 * a citable statistic — but it is a real loss and it will be visible the first
 * time a caption quoting a workshop headcount is quoted back.
 *
 * The KEY is not evidence either, and never appears here. A key can be MINTED
 * FROM DATA — `performance.clusters.<label>` takes its segment from a cluster
 * label a model wrote — and `keySegment()` preserves `\p{N}`, so a model that
 * named a cluster could otherwise have named its own evidence.
 *
 * `n` IS evidence: it is a count this code computed, and the blocks contract
 * tells the agent to carry it with the figure, so it must be quotable.
 *
 * ONE ASSEMBLER. This is built from `collectMeasures()`, the same block list
 * `renderStrategistBlocks()` renders, so the evidence can never be about a
 * different set of measures than the agent was shown.
 */
export function measureEvidence(measures: readonly Measure[]): string[] {
  const values: string[] = [];
  for (const measure of measures) {
    if (wholeQuantity(measure.value) !== null) values.push(measure.value);
    if (measure.n !== null && measure.n !== undefined) values.push(String(measure.n));
  }
  return values;
}

/**
 * The lint context for anything generated against these blocks: one declared
 * quantity per line, no key, no label, no prose. Pass this to the Law as
 * `context` — never the rendered blocks.
 */
export function strategistEvidence(data: StrategistData): string {
  return measureEvidence(collectMeasures(data)).join('\n');
}

/* ========================================================================= */
/* Everything below this line touches the database. Nothing above it does.   */
/* ========================================================================= */

export interface LoadStrategistOptions {
  /** ISO date for "today". Passed in so the caller owns the clock. */
  today: string;
  /** Days the digest period covers, ending today. */
  periodDays?: number;
  actionBudget?: number;
  /** Row ceiling for the posts read. Defaults to the app-wide MAX_POSTS_SCAN. */
  postScanLimit?: number;
  thresholds?: Partial<AnomalyThresholds>;
}

/** How far back the profile history read goes. Two dated rows make a delta. */
export const PROFILE_HISTORY_SCAN = 60;

/** Past decisions carried into context. The ledger is a memory, not an archive. */
export const LEDGER_SCAN = 100;

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function accountPerformance(posts: readonly PostRow[], account: Account): AccountPerformance {
  const mine = posts.filter((post) => post.account === account && Number.isFinite(post.engagement));
  const engagements = mine.map((post) => post.engagement);
  const total = engagements.reduce((sum, value) => sum + value, 0);

  let top: PostRow | null = null;
  for (const post of mine) {
    if (!top || post.engagement > top.engagement) top = post;
  }

  return {
    post_count: mine.length,
    total_engagement: total,
    avg_engagement: mean(engagements),
    top_post: top
      ? { url: top.url, engagement: top.engagement, posted_at: top.posted_at }
      : null,
  };
}

/**
 * Reads everything the strategist is allowed to know.
 *
 * The database handle is an ARGUMENT, not an import: this module then reads no
 * environment variable, holds no secret, and can be exercised against any
 * client the caller has already authorised. Callers pass `supabaseAdmin()`
 * after `requireOperator()`, exactly as every other server path in this app
 * does.
 *
 * Every posts read goes through `distinctPosts()` under `MAX_POSTS_SCAN`, and
 * the coverage of that read travels into the block so a capped population can
 * say so rather than being presented as the whole truth.
 */
export async function loadStrategistData(
  db: SupabaseClient,
  opts: LoadStrategistOptions,
): Promise<StrategistData> {
  const today = opts.today;
  const periodDays = opts.periodDays ?? DEFAULT_PERIOD_DAYS;
  const limit = opts.postScanLimit ?? MAX_POSTS_SCAN;
  const thresholds: AnomalyThresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };

  const [brandRes, guidelineRes, profileRes, snapshotRes, audienceRes, conceptRes, ledgerRes] =
    await Promise.all([
      db.from('brand').select('*').eq('id', 1).maybeSingle(),
      db.from('brand_guidelines').select('version,status,created_at').order('version', { ascending: false }).limit(1),
      db.from('profile_snapshots').select('*').order('taken_on', { ascending: false }).limit(PROFILE_HISTORY_SCAN),
      db.from('snapshots').select('*').order('taken_on', { ascending: false }).limit(1),
      db.from('audience_insights').select('*').order('created_at', { ascending: false }).limit(1),
      db.from('concepts').select('*').order('created_at', { ascending: false }).limit(500),
      db.from('decisions').select('*').order('created_at', { ascending: false }).limit(LEDGER_SCAN),
    ]);

  for (const [what, res] of [
    ['brand', brandRes],
    ['guidelines', guidelineRes],
    ['profile snapshots', profileRes],
    ['snapshots', snapshotRes],
    ['audience insights', audienceRes],
    ['concepts', conceptRes],
    ['decisions', ledgerRes],
  ] as const) {
    if (res.error) throw new Error(`Could not read ${what}: ${res.error.message}`);
  }

  /* ------------------------------------------------------------ profiles -- */

  const profileRows = (profileRes.data as ProfileSnapshotRow[] | null) ?? [];
  const profiles = {} as Record<Account, ProfileObservation | null>;
  for (const account of ACCOUNTS) {
    // Already ordered newest-first by the query, so the first two rows for an
    // account are its latest observation and the one before it.
    const history = profileRows.filter((row) => row.account === account);
    const latest = history[0];
    const previous = history[1];
    profiles[account] = latest
      ? {
          taken_on: latest.taken_on,
          followers: latest.followers,
          following: latest.following,
          posts_count: latest.posts_count,
          previous: previous
            ? {
                taken_on: previous.taken_on,
                followers: previous.followers,
                following: previous.following,
                posts_count: previous.posts_count,
              }
            : null,
        }
      : null;
  }

  /* --------------------------------------------------------- performance -- */

  const snapshotRow = (snapshotRes.data as { id: string; taken_on: string }[] | null)?.[0] ?? null;

  let posts: PostRow[] = [];
  let coverage: ScanCoverage | null = null;
  let duplicatesCollapsed = 0;
  let analysesCount: number | null = null;
  let clusters: ClusterAggregate[] = [];
  const accounts = {} as Record<Account, AccountPerformance | null>;
  for (const account of ACCOUNTS) accounts[account] = null;

  if (snapshotRow) {
    const postsRes = await db
      .from('posts')
      .select('*')
      .eq('snapshot_id', snapshotRow.id)
      .order('engagement', { ascending: false })
      .limit(limit);
    if (postsRes.error) throw new Error(`Could not read posts: ${postsRes.error.message}`);

    const rows = (postsRes.data as PostRow[] | null) ?? [];
    // Coverage counts SCRAPE ROWS, so it is measured before the collapse.
    coverage = scanCoverage(rows.length, limit);
    // The read is scoped to one snapshot, so this collapse is a no-op today —
    // it is applied anyway because the day it stops being a no-op is the day
    // every average here would silently double-count (see audience/posts.ts).
    const collapsed = distinctPosts(rows);
    posts = collapsed.posts;
    duplicatesCollapsed = collapsed.duplicates_collapsed;

    for (const account of ACCOUNTS) accounts[account] = accountPerformance(posts, account);

    const analysesRes = await db.from('post_analyses').select('post_id,cluster_label').limit(limit);
    if (analysesRes.error) {
      throw new Error(`Could not read post analyses: ${analysesRes.error.message}`);
    }
    const analyses = (analysesRes.data as { post_id: string; cluster_label: string | null }[] | null) ?? [];
    analysesCount = analyses.length;

    const byId = new Map(posts.map((post) => [post.id, post]));
    const groups = new Map<string, { label: string; account: Account; engagements: number[] }>();
    for (const analysis of analyses) {
      const post = byId.get(analysis.post_id);
      if (!post || !analysis.cluster_label) continue;
      const groupKey = `${post.account}\u0000${analysis.cluster_label}`;
      const group = groups.get(groupKey) ?? {
        label: analysis.cluster_label,
        account: post.account,
        engagements: [],
      };
      if (Number.isFinite(post.engagement)) group.engagements.push(post.engagement);
      groups.set(groupKey, group);
    }

    clusters = [...groups.values()].map((group) => {
      const avg = mean(group.engagements);
      const accountAvg = accounts[group.account]?.avg_engagement ?? null;
      return {
        label: group.label,
        account: group.account,
        n: group.engagements.length,
        avg_engagement: avg,
        vs_account_avg: avg !== null && accountAvg !== null && accountAvg > 0 ? avg / accountAvg : null,
      };
    });
  }

  // Hard rule 11: timing is computed by the timing engine, per account, and
  // arrives here with its n already attached. Nothing in this file counts an
  // hour. The two accounts are measured separately on purpose — blending an
  // account averaging in the hundreds with one averaging in the tens would
  // produce a "best hour" that belongs to neither.
  const timing: TimingResult[] = snapshotRow
    ? ACCOUNTS.map((account) => buildTiming(posts, { account }))
    : [];

  /* -------------------------------------------------------- content state -- */

  const conceptRows = (conceptRes.data as ConceptRow[] | null) ?? [];
  const counts = {} as Record<ConceptStatus, number>;
  for (const status of CONCEPT_STATUSES) {
    counts[status] = conceptRows.filter((concept) => concept.status === status).length;
  }
  const shipped: ShippedConcept[] = conceptRows
    .filter((concept) => concept.status === 'shipped')
    .map((concept) => ({
      id: concept.id,
      title: concept.title,
      account: concept.account,
      format: concept.format,
      shipped_url: concept.shipped_url,
      shipped_engagement: concept.shipped_engagement,
    }));

  /* ----------------------------------------------------------------- meta -- */

  const periodFrom = addDaysIso(today, -(periodDays - 1));
  const staleness = snapshotRow ? daysBetweenIso(snapshotRow.taken_on, today) : null;

  return {
    brand: (brandRes.data as BrandRow | null) ?? null,
    guideline: (guidelineRes.data as GuidelineVersion[] | null)?.[0] ?? null,
    profiles,
    performance: {
      snapshot: snapshotRow ? { id: snapshotRow.id, taken_on: snapshotRow.taken_on } : null,
      accounts,
      clusters,
      timing,
      posts_coverage: coverage,
      duplicates_collapsed: duplicatesCollapsed,
      analyses_count: analysesCount,
    },
    audience: (audienceRes.data as AudienceInsightRow[] | null)?.[0] ?? null,
    content: { counts, shipped },
    ledger: (ledgerRes.data as DecisionRow[] | null) ?? [],
    meta: {
      today,
      period: { from: periodFrom ?? today, to: today },
      staleness_days: staleness,
      action_budget: opts.actionBudget ?? DEFAULT_ACTION_BUDGET,
      thresholds,
    },
  };
}
