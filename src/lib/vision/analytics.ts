/**
 * Visual features x engagement — «وجه أحمد مقابل التصاميم», answered in code.
 *
 * ===========================================================================
 * WHY THIS IS ARITHMETIC AND NOT A PROMPT
 * ===========================================================================
 * "Posts with Ahmad's face do better than the designs" is the single most
 * asked question about this account, and it is exactly the shape of claim a
 * model will happily produce from nothing. Every number in this module is
 * counted or averaged here, from rows, by the same rules the timing engine
 * follows (src/lib/audience/timing.ts): the vision layer supplies the LABEL on
 * each image, this file supplies the MEASUREMENT, and the model is never asked
 * for a quantity. A model may name the pattern a cluster shows, under the
 * standing grounding law; it does not get to say how big it is.
 *
 * ===========================================================================
 * THE CONFOUND, NAMED BEFORE IT IS MEASURED
 * ===========================================================================
 * personal averages 508 engagement over 190 posts; academy averages 40 over
 * 130 — a factor of about thirteen between the two accounts. Ahmad's face is
 * mostly on personal and the designed creative is mostly on academy. So a
 * face-vs-no-face gap computed over BOTH accounts at once is, to a first
 * approximation, the account gap wearing a different label: it would look like
 * a finding and be an artefact.
 *
 * Two things follow, and they are the reason this module looks the way it does:
 *
 *   1. `account` is a first-class option, exactly as it is on buildTiming().
 *      The honest question is "within personal, does a face help?", and that is
 *      one argument away.
 *   2. Every group carries `accounts` — how many of its posts came from each
 *      account. It is a count, not a threshold, so it invents nothing; a reader
 *      who sees a group that is 100% personal against another that is 100%
 *      academy can see for themselves that the comparison is between accounts.
 *
 * There is deliberately no automatic "this is confounded" verdict. That would
 * need a cut-off nobody has justified, and an unjustified constant that decides
 * whether a finding is shown is precisely the anti-pattern this codebase names.
 *
 * ===========================================================================
 * WHAT IS WITHHELD, AND WHY IT IS STILL COUNTED
 * ===========================================================================
 * A group below MIN_GROUP_N is EXCLUDED, not caveated — same rule, same
 * reasoning as MIN_WINDOW_N in the timing engine: below the floor an "average"
 * is one loud post wearing a trend coat. But the group does not vanish. Its
 * key and its `n` travel back in `withheld` so the population stays
 * accountable, while its average is never computed into the payload at all.
 * Stating "3 groups were withheld, n<5" is honest; silently dropping them
 * leaves a reader to assume the reported groups are the whole corpus.
 *
 * A group with NO members is the same shape: `n: 0`, and no average anywhere.
 * Absence, never zero (hard rule 2). The caller renders an em-dash.
 *
 * ===========================================================================
 * PURITY
 * ===========================================================================
 * Pure functions, no I/O, no environment reads, no clock, no model — so this
 * module runs unchanged under `node --test --experimental-strip-types`, which
 * is why every import carries an explicit `.ts` extension, exactly as the
 * timing engine and the Law modules do.
 */

import { distinctPosts } from '../audience/posts.ts';
import type { Account, PostRow, VisualFeatureRow } from '../types/db.ts';

/* ====================================================== the vocabularies == */

/**
 * How much of the frame a face occupies. A classified band, never a number:
 * the model is looking at an image, not measuring it, and "38% of the frame"
 * from a model that cannot count pixels is a fabricated quantity.
 *
 * Exported because the vision route builds its response schema from this list.
 * One vocabulary, in one place: a band the model is allowed to return but this
 * module has never heard of would silently land in `off_vocabulary` below.
 */
export const FACE_PROMINENCE_BANDS = ['minor', 'moderate', 'dominant'] as const;
export type FaceProminenceBand = (typeof FACE_PROMINENCE_BANDS)[number];

/** How much of the frame is text. Same contract as the face bands above. */
export const TEXT_COVERAGE_BANDS = ['none', 'light', 'moderate', 'heavy'] as const;
export type TextCoverageBand = (typeof TEXT_COVERAGE_BANDS)[number];

/**
 * The two-way "text-heavy vs clean" split, written down rather than inferred.
 *
 * `moderate` is in NEITHER list, and that is the point. Folding the middle band
 * into one side or the other would be a judgement call presented as a
 * measurement — and whichever side received it would gain posts, and therefore
 * a different average, on no evidence at all. It is left unassigned, counted in
 * `FacetReport.unassigned`, and visible.
 */
export const TEXT_CLEAN_BANDS = ['none', 'light'] as const;
export const TEXT_HEAVY_BANDS = ['heavy'] as const;
/** Bands the split deliberately refuses to place. Named, not forgotten. */
export const TEXT_UNASSIGNED_BANDS = ['moderate'] as const;

/**
 * Compile-time proof that the three lists above between them mention every
 * band, so a band added to TEXT_COVERAGE_BANDS cannot quietly go missing from
 * the clean/heavy split. A test asserts the runtime half (no band appears
 * twice); this half catches the omission at build time.
 */
const SPLIT_COVERS_EVERY_BAND: TextCoverageBand extends
  | (typeof TEXT_CLEAN_BANDS)[number]
  | (typeof TEXT_HEAVY_BANDS)[number]
  | (typeof TEXT_UNASSIGNED_BANDS)[number]
  ? true
  : never = true;
void SPLIT_COVERS_EVERY_BAND;

/**
 * The floor for reporting a group, and the same number as MIN_WINDOW_N in the
 * timing engine — deliberately, because it is the same judgement about the same
 * corpus: below five posts an average is not a pattern. It travels back to the
 * caller as `min_group_n` on every facet so a surface can state the rule it
 * enforced rather than leaving a reader to guess why a group is missing.
 */
export const MIN_GROUP_N = 5;

/** How many composition tags one image may contribute. */
export const MAX_COMPOSITION_TAGS = 6;

/* ============================================================= the inputs == */

/**
 * What this module needs from a post.
 *
 * `snapshot_id` and `posted_at` are here because `posts` is UNIQUE
 * (snapshot_id, ig_id) — one ROW PER POST PER SNAPSHOT — and the collapse below
 * goes through distinctPosts(), whose contract demands them. A caller that
 * selects a population without them cannot dedupe and will not compile, which
 * is the point: after the next re-scrape an uncollapsed read averages every
 * post in twice.
 */
export type AnalyticsPost = Pick<
  PostRow,
  'ig_id' | 'snapshot_id' | 'posted_at' | 'account' | 'engagement'
>;

/**
 * What this module needs from a visual feature row.
 *
 * `model` is not decoration: it is how a row that has been READ is told apart
 * from a row that merely exists. visual_features is written the moment an image
 * is mirrored, with every descriptive column null; `model` stays null until a
 * model has actually looked at it. Counting those rows as described would put
 * every one of their posts in an `unknown` group and quietly deflate every real
 * group's share of the corpus.
 */
export type AnalyticsFeature = Pick<
  VisualFeatureRow,
  'ig_id' | 'has_face' | 'text_coverage' | 'logo_present' | 'composition_tags' | 'model'
>;

export interface BuildVisualAnalyticsOptions {
  /** Which account to measure. Defaults to 'all' — read the confound note above. */
  account?: Account | 'all';
  /** Defaults to MIN_GROUP_N. */
  minGroupN?: number;
}

/* ============================================================ the outputs == */

export type Facet = 'face' | 'logo' | 'text_coverage' | 'text_density' | 'composition_tag';

/** How a group's posts split across the two accounts. Counts, never a verdict. */
export interface AccountMix {
  personal: number;
  academy: number;
}

/**
 * One measured group.
 *
 * `avg_engagement` is a plain `number` rather than `number | null` because a
 * group only reaches this type after clearing the floor, so it always rests on
 * at least MIN_GROUP_N posts. Absence is not represented here at all — it is
 * represented by the group being in `withheld` instead, with no average in
 * existence. That is what stops an absent average from ever being rendered as 0.
 */
export interface GroupStat {
  facet: Facet;
  /** Stable machine key, unique within the report. */
  key: string;
  /** Hard rule 12 — the key these numbers are filed under. See sourceKeysFor(). */
  source_key: string;
  n: number;
  avg_engagement: number;
  /**
   * This group's average over the described population's average. Null when
   * that baseline is 0, because a ratio against zero is not a large number, it
   * is an undefined one.
   */
  multiple_vs_overall: number | null;
  accounts: AccountMix;
}

/** A group whose average is withheld. It has a size; it has no average. */
export interface WithheldGroup {
  facet: Facet;
  key: string;
  source_key: string;
  /** Below `min_group_n`, possibly 0. Reported so the population still adds up. */
  n: number;
  accounts: AccountMix;
}

export interface FacetReport {
  facet: Facet;
  /**
   * 'fixed'    — the groups come from a closed vocabulary, so every group is
   *              accounted for even at n = 0.
   * 'observed' — the groups are whatever the corpus contained; a group that was
   *              never observed does not appear, because there is nothing to
   *              report about it.
   */
  domain: 'fixed' | 'observed';
  /**
   * False when one post can belong to several groups — composition tags are
   * multi-label, so their n's sum to MORE than the population. A surface that
   * renders them as shares of a whole would be inventing a denominator.
   */
  partition: boolean;
  min_group_n: number;
  /** Groups clearing the floor. Deterministically ordered; see orderGroups(). */
  groups: GroupStat[];
  /** Groups below it. Counted, never averaged. */
  withheld: WithheldGroup[];
  /**
   * Described posts this facet placed in no group at all — the unassigned
   * middle band of the text split, a post carrying no composition tags. Stated
   * so `groups` plus `withheld` plus this accounts for the whole population on
   * every partitioning facet.
   */
  unassigned: number;
}

/** Who was measured, and who was not. Every number here is a row count. */
export interface VisualPopulation {
  /** Post ROWS handed in, before the collapse. */
  posts_in: number;
  /** Re-scrapes of a post already kept. See distinctPosts(). */
  duplicates_collapsed: number;
  /** Distinct posts after the collapse and the account filter. */
  posts: number;
  /** Feature rows handed in. */
  features_in: number;
  /** …of which `model` is null: mirrored, never read. Not a described post. */
  features_undescribed: number;
  /** …of which the ig_id matches no post in the input at all. Orphans. */
  features_unmatched: number;
  /** …of which the post exists but sits outside the account filter. */
  features_other_account: number;
  /** In-scope posts carrying a described feature. The denominator below. */
  described: number;
  /**
   * In-scope posts carrying no described feature at all: `posts` − `described`
   * − `engagement_unreadable`. The third term matters — a post that WAS
   * described but whose engagement could not be read is neither measured nor
   * waiting to be described, and folding it into either would misstate how much
   * of the corpus is still unread.
   */
  undescribed: number;
  /**
   * Mean engagement over `described`. Null when nothing is described — an
   * absent average, never 0 (hard rule 2). The caller renders an em-dash.
   */
  overall_avg_engagement: number | null;
  /**
   * Described posts dropped because `engagement` was not a finite number. A
   * post whose engagement cannot be read is not measured as zero.
   */
  engagement_unreadable: number;
}

export interface VisualAnalytics {
  account: Account | 'all';
  min_group_n: number;
  population: VisualPopulation;
  face: FacetReport;
  logo: FacetReport;
  text_coverage: FacetReport;
  text_density: FacetReport;
  composition_tag: FacetReport;
}

/* ============================================================== internals == */

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}

/** A group under construction: counts only, no arithmetic yet. */
interface Tally {
  key: string;
  n: number;
  sum: number;
  personal: number;
  academy: number;
}

function emptyTally(key: string): Tally {
  return { key, n: 0, sum: 0, personal: 0, academy: 0 };
}

/** One measured post, already collapsed, filtered and joined to its feature. */
interface Described {
  account: Account;
  engagement: number;
  feature: AnalyticsFeature;
}

function add(tally: Tally, post: Described): void {
  tally.n += 1;
  tally.sum += post.engagement;
  if (post.account === 'personal') tally.personal += 1;
  else tally.academy += 1;
}

function sourceKeyFor(facet: Facet, key: string): string {
  return `visual.${facet}.${key}`;
}

/**
 * The full set of keys one group's quantities are filed under (hard rule 12).
 *
 * A group carries three numbers and they are three different claims, so they
 * get three keys rather than one shared prefix a reader has to guess the
 * suffixes of. A surface rendering `n` cites `…​.n`; nothing renders a quantity
 * whose key it cannot name.
 */
export function sourceKeysFor(group: GroupStat | WithheldGroup): string[] {
  const base = group.source_key;
  // A withheld group HAS no average and no multiple, so it has no key for one:
  // emitting the key would advertise a measurement that was never computed.
  if (!('avg_engagement' in group)) return [`${base}.n`];
  return [`${base}.n`, `${base}.avg_engagement`, `${base}.multiple_vs_overall`];
}

/**
 * Every source key this report emits, in a stable order. The mirror of
 * collectSourceKeys() in the strategist blocks: a surface can check that a
 * quantity it is about to render was actually filed under the key it claims.
 */
export function collectSourceKeys(report: VisualAnalytics): string[] {
  const keys: string[] = [];
  for (const facet of facetReports(report)) {
    for (const group of facet.groups) keys.push(...sourceKeysFor(group));
    for (const group of facet.withheld) keys.push(...sourceKeysFor(group));
  }
  return keys;
}

/** The five facet reports, in a fixed order. */
export function facetReports(report: VisualAnalytics): FacetReport[] {
  return [
    report.face,
    report.logo,
    report.text_coverage,
    report.text_density,
    report.composition_tag,
  ];
}

/**
 * Turns tallies into a facet report.
 *
 * `order` decides how the reportable groups come back:
 *   'declared' — the order the tallies were created in. Used by every fixed
 *                vocabulary, so "with face / without face / unknown" reads the
 *                same way every time regardless of which won.
 *   'ranked'   — strongest average first, then the group resting on more posts,
 *                then the key. Three tie-breaks deep, so the result is a
 *                function of the data alone and not of the input's order.
 */
function report(
  facet: Facet,
  domain: 'fixed' | 'observed',
  partition: boolean,
  tallies: readonly Tally[],
  overallAvg: number | null,
  minGroupN: number,
  unassigned: number,
  order: 'declared' | 'ranked',
): FacetReport {
  const groups: GroupStat[] = [];
  const withheld: WithheldGroup[] = [];

  for (const tally of tallies) {
    const accounts: AccountMix = { personal: tally.personal, academy: tally.academy };
    if (tally.n < minGroupN) {
      withheld.push({ facet, key: tally.key, source_key: sourceKeyFor(facet, tally.key), n: tally.n, accounts });
      continue;
    }
    const avg = tally.sum / tally.n;
    groups.push({
      facet,
      key: tally.key,
      source_key: sourceKeyFor(facet, tally.key),
      n: tally.n,
      avg_engagement: round2(avg),
      // Rounded from the UNROUNDED average against the UNROUNDED baseline: a
      // ratio of two already-rounded numbers is a third number, slightly wrong,
      // that no longer equals the division of the two figures on screen.
      multiple_vs_overall:
        overallAvg !== null && overallAvg > 0 ? round2(avg / overallAvg) : null,
      accounts,
    });
  }

  if (order === 'ranked') {
    groups.sort(
      (a, b) =>
        b.avg_engagement - a.avg_engagement ||
        b.n - a.n ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  }
  // Withheld groups are always ordered by key: they carry no average to rank on,
  // and the alternative — insertion order — would leak the input's ordering.
  withheld.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { facet, domain, partition, min_group_n: minGroupN, groups, withheld, unassigned };
}

/* ================================================================= facets == */

/**
 * A yes/no column as three fixed groups: yes, no, and NOT DETERMINED.
 *
 * The third group is the whole reason this is not a two-way split. `has_face:
 * null` on a described row means the model looked and could not tell; folding
 * those posts into "without a face" would turn an absence into a finding, and
 * it is the cheapest possible way to make a face effect appear or disappear.
 */
function booleanFacet(
  facet: Facet,
  keys: { yes: string; no: string; unknown: string },
  read: (feature: AnalyticsFeature) => boolean | null,
  posts: readonly Described[],
  overallAvg: number | null,
  minGroupN: number,
): FacetReport {
  const yes = emptyTally(keys.yes);
  const no = emptyTally(keys.no);
  const unknown = emptyTally(keys.unknown);

  for (const post of posts) {
    const value = read(post.feature);
    if (value === null) add(unknown, post);
    else if (value) add(yes, post);
    else add(no, post);
  }

  // Every described post lands in exactly one of the three, so nothing is
  // unassigned and the three n's sum to the population.
  return report(facet, 'fixed', true, [yes, no, unknown], overallAvg, minGroupN, 0, 'declared');
}

const TEXT_UNKNOWN_KEY = 'unknown';
const TEXT_OFF_VOCABULARY_KEY = 'off_vocabulary';

function isTextBand(value: string | null): value is TextCoverageBand {
  return value !== null && (TEXT_COVERAGE_BANDS as readonly string[]).includes(value);
}

/**
 * Text coverage as its own band, plus two catch-alls that are kept apart on
 * purpose: `unknown` is a described row whose coverage is null (nobody
 * classified it), `off_vocabulary` is a row carrying a band this module has
 * never heard of. Merging them would hide a vocabulary drift — a model quietly
 * answering "medium" instead of "moderate" — behind what looks like missing
 * data.
 */
function textCoverageFacet(
  posts: readonly Described[],
  overallAvg: number | null,
  minGroupN: number,
): FacetReport {
  const tallies = new Map<string, Tally>();
  const ordered: Tally[] = [];
  for (const key of [...TEXT_COVERAGE_BANDS, TEXT_UNKNOWN_KEY, TEXT_OFF_VOCABULARY_KEY]) {
    const tally = emptyTally(key);
    tallies.set(key, tally);
    ordered.push(tally);
  }

  for (const post of posts) {
    const band = post.feature.text_coverage;
    const key = isTextBand(band)
      ? band
      : band === null
        ? TEXT_UNKNOWN_KEY
        : TEXT_OFF_VOCABULARY_KEY;
    const tally = tallies.get(key);
    if (tally !== undefined) add(tally, post);
  }

  return report('text_coverage', 'fixed', true, ordered, overallAvg, minGroupN, 0, 'declared');
}

/**
 * The headline split: clean creative against text-heavy creative.
 *
 * Exactly two groups, and a post whose band belongs to neither — `moderate`, an
 * unclassified null, an unrecognised string — is counted in `unassigned` rather
 * than pushed onto a side. See TEXT_UNASSIGNED_BANDS.
 */
function textDensityFacet(
  posts: readonly Described[],
  overallAvg: number | null,
  minGroupN: number,
): FacetReport {
  const clean = emptyTally('clean');
  const heavy = emptyTally('heavy');
  let unassigned = 0;

  for (const post of posts) {
    const band = post.feature.text_coverage;
    if (!isTextBand(band)) {
      unassigned += 1;
      continue;
    }
    if ((TEXT_CLEAN_BANDS as readonly string[]).includes(band)) add(clean, post);
    else if ((TEXT_HEAVY_BANDS as readonly string[]).includes(band)) add(heavy, post);
    else unassigned += 1;
  }

  return report('text_density', 'fixed', true, [clean, heavy], overallAvg, minGroupN, unassigned, 'declared');
}

/**
 * Per-tag aggregates over a MULTI-LABEL column.
 *
 * A post tagged «بورتريه» and «نص كبير» is counted in both groups, so the n's
 * deliberately sum to more than the population and `partition` is false. Tags
 * are trimmed and de-duplicated per post — a row carrying the same tag twice is
 * one post, not two — and a post is capped at MAX_COMPOSITION_TAGS so one
 * over-enthusiastic row cannot dominate the tag space.
 *
 * Ranked rather than declared: there is no vocabulary to declare, and the
 * question a reader brings to this facet is which composition does best.
 */
function compositionFacet(
  posts: readonly Described[],
  overallAvg: number | null,
  minGroupN: number,
): FacetReport {
  const tallies = new Map<string, Tally>();
  let unassigned = 0;

  for (const post of posts) {
    const raw = post.feature.composition_tags ?? [];
    const seen = new Set<string>();
    for (const tag of raw) {
      if (typeof tag !== 'string') continue;
      const key = tag.trim();
      if (key === '' || seen.has(key)) continue;
      if (seen.size >= MAX_COMPOSITION_TAGS) break;
      seen.add(key);
      const tally = tallies.get(key) ?? emptyTally(key);
      tallies.set(key, tally);
      add(tally, post);
    }
    if (seen.size === 0) unassigned += 1;
  }

  // Sorted by key before ranking so that two runs over the same data build the
  // candidate list identically whatever order the rows arrived in.
  const ordered = [...tallies.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return report('composition_tag', 'observed', false, ordered, overallAvg, minGroupN, unassigned, 'ranked');
}

/* ================================================================== build == */

/**
 * The whole report: five facets over the posts that have actually been
 * described, with the population that produced them.
 *
 * The join is by `ig_id` and only by ig_id. visual_features is keyed on the
 * post's own Instagram id precisely so that a description survives the next
 * re-scrape, when every posts.id changes; joining on a row id here would lose
 * every description the moment the corpus is refreshed.
 *
 * Posts are collapsed through distinctPosts() before anything is counted. The
 * caller is responsible for handing rows over NEWEST SNAPSHOT FIRST — that is
 * distinctPosts()'s documented contract and this module cannot verify it, since
 * a post row carries no scrape timestamp. Collapsing here as well as at the
 * call site is deliberate belt-and-braces: it is idempotent, and the cost of
 * forgetting it once is every average computed over a doubled corpus.
 */
export function buildVisualAnalytics(
  posts: readonly AnalyticsPost[],
  features: readonly AnalyticsFeature[],
  opts: BuildVisualAnalyticsOptions = {},
): VisualAnalytics {
  const account: Account | 'all' = opts.account ?? 'all';
  const minGroupN = positiveIntOr(opts.minGroupN, MIN_GROUP_N);

  const collapsed = distinctPosts(posts);

  /** Every post in the input, so an orphaned feature can be told from an out-of-scope one. */
  const allIgIds = new Set<string>();
  for (const post of collapsed.posts) allIgIds.add(post.ig_id);

  const inScope = collapsed.posts.filter((post) => account === 'all' || post.account === account);
  const byIgId = new Map<string, AnalyticsPost>();
  for (const post of inScope) if (!byIgId.has(post.ig_id)) byIgId.set(post.ig_id, post);

  let featuresUndescribed = 0;
  let featuresUnmatched = 0;
  let featuresOtherAccount = 0;
  let engagementUnreadable = 0;

  const described: Described[] = [];
  /** Guards against two feature rows for one post — the UNIQUE index forbids it. */
  const claimed = new Set<string>();

  for (const feature of features) {
    // `model` null means the image is mirrored but has never been read. It is
    // not a described post and it is not an error; it is work still to do.
    if (feature.model === null) {
      featuresUndescribed += 1;
      continue;
    }
    const post = byIgId.get(feature.ig_id);
    if (post === undefined) {
      if (allIgIds.has(feature.ig_id)) featuresOtherAccount += 1;
      else featuresUnmatched += 1;
      continue;
    }
    if (claimed.has(feature.ig_id)) continue;
    claimed.add(feature.ig_id);
    // A post whose engagement is not a real number is not measured as 0 — the
    // same refusal buildTiming() makes for the same reason.
    if (!Number.isFinite(post.engagement)) {
      engagementUnreadable += 1;
      continue;
    }
    described.push({ account: post.account, engagement: post.engagement, feature });
  }

  let sum = 0;
  for (const post of described) sum += post.engagement;
  const overallAvgRaw = described.length > 0 ? sum / described.length : null;

  const population: VisualPopulation = {
    posts_in: posts.length,
    duplicates_collapsed: collapsed.duplicates_collapsed,
    posts: inScope.length,
    features_in: features.length,
    features_undescribed: featuresUndescribed,
    features_unmatched: featuresUnmatched,
    features_other_account: featuresOtherAccount,
    described: described.length,
    undescribed: inScope.length - described.length - engagementUnreadable,
    overall_avg_engagement: overallAvgRaw === null ? null : round2(overallAvgRaw),
    engagement_unreadable: engagementUnreadable,
  };

  return {
    account,
    min_group_n: minGroupN,
    population,
    face: booleanFacet(
      'face',
      { yes: 'with_face', no: 'without_face', unknown: 'unknown' },
      (feature) => feature.has_face,
      described,
      overallAvgRaw,
      minGroupN,
    ),
    logo: booleanFacet(
      'logo',
      { yes: 'with_logo', no: 'without_logo', unknown: 'unknown' },
      (feature) => feature.logo_present,
      described,
      overallAvgRaw,
      minGroupN,
    ),
    text_coverage: textCoverageFacet(described, overallAvgRaw, minGroupN),
    text_density: textDensityFacet(described, overallAvgRaw, minGroupN),
    composition_tag: compositionFacet(described, overallAvgRaw, minGroupN),
  };
}
