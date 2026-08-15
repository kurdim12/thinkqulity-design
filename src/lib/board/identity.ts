/**
 * WHICH POST AN ANALYSIS BELONGS TO.
 *
 * `post_analyses.post_id` references `posts.id` — a scrape ROW. `posts` is
 * UNIQUE (snapshot_id, ig_id), so the same Instagram post gets a NEW row with a
 * NEW uuid on every re-scrape, and distinctPosts() hands the win to that new
 * row. Matched by row id, an analysis written before the re-scrape therefore
 * belongs to nothing the board shows: the card reads "not analysed yet", the
 * count reads 0, and the estimate re-quotes the operator for work already paid
 * for and still sitting in `post_analyses`.
 *
 * The first fix for that resolved the row id to an ig_id THROUGH THE ROWS THE
 * REQUEST HAD JUST READ — an in-memory map built from one capped read. That map
 * carries a boundary with it. The read is capped at MAX_POSTS_SCAN = 2000 rows
 * and each snapshot of this account is ~320 rows, so on the SEVENTH snapshot the
 * read stops mid-history, older rows fall out of it, and every analysis whose
 * cited row fell out resolves to nothing again. It reads as unanalysed, it is
 * queued, and the model is paid a second time to describe a post it has already
 * described.
 *
 * Migration 0004 added `post_analyses.ig_id` (indexed, backfilled), which is why
 * this module can stop inferring the join and simply read it. An analysis now
 * names its post directly, so the match no longer depends on which rows a capped
 * scan happened to include — the boundary is not moved, it is gone.
 *
 * `post_id` is untouched: it is a real foreign key and it is still the thing
 * that says WHICH SCRAPE an analysis was computed against, which is the whole
 * current/superseded distinction below. ig_id is the durable join; post_id is
 * the provenance.
 *
 * Pure: no I/O, no environment, no model, and no imports at all — so it runs
 * unchanged under `node --test --experimental-strip-types`, and so the matching
 * rule that decides re-spend can be proven without a database.
 */

/**
 * The identifying fields of a stored analysis. Deliberately narrower than
 * `PostAnalysisRow`: a caller that reads the whole row satisfies this, and a
 * caller that reads only these three columns does too.
 *
 * `ig_id` is nullable because the COLUMN is nullable — it arrived with 0004 and
 * any row written before it carries null until the backfill reaches it. Null
 * here is "this row does not say", never "no post", which is why resolveIgId()
 * falls back rather than discarding the row.
 */
export interface AnalysisIdentity {
  /** `posts.id` — the scrape ROW this analysis was computed against. */
  post_id: string;
  /** The post's Instagram id: the durable join. Null on pre-0004 rows. */
  ig_id: string | null;
  /** When the analysis was written. Decides which of two analyses is shown. */
  created_at: string;
}

/**
 * A post as the collapsed population presents it: the row now displayed, and
 * the post it is a copy of. Any row selected with `id` and `ig_id` fits.
 */
export interface PostIdentityRow {
  /** `posts.id` of the row that WON the collapse — the one on screen. */
  id: string;
  ig_id: string;
}

/** An analysis, resolved to the post it describes rather than the row it cites. */
export interface AnalysisLink<A> {
  analysis: A;
  /**
   * True when the analysis was computed against an EARLIER scrape of this post.
   * A different fact from "never analysed", and the reason the two are counted
   * apart: conflating them is what re-charges the operator. The work is done and
   * shown; only its stored comparatives are frozen at the older population,
   * which is why the card carries a date.
   */
  superseded: boolean;
}

/** One analysis per post, plus the counts a screen or an estimate needs. */
export interface AnalysisIndex<A> {
  /**
   * Keyed by ig_id, one winner per post, restricted to posts present in the
   * population that was passed in. `byIgId.size` is the analysed POST count.
   */
  byIgId: Map<string, AnalysisLink<A>>;
  /**
   * Analyses that could not be placed on any post in this population: the post
   * is gone, or the population was truncated before reaching it. Counted per
   * ANALYSIS, and reported rather than folded into "not analysed" — an analysis
   * this code could not place is not the same fact as a post that has none.
   */
  unresolved: number;
  /** Posts whose winning analysis hangs off the row now displayed. */
  analyzed_current: number;
  /** Posts whose winning analysis was written against an earlier scrape. */
  analyzed_superseded: number;
}

/** Shared empty default, so the common call allocates nothing. */
const NO_LEGACY_ROWS: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * The post an analysis describes, or null when nothing here can say.
 *
 * The stored column wins. `igIdByRowId` is the PRE-0004 BRIDGE and nothing else:
 * rows written before the column existed carry null, and the only place their
 * ig_id can be recovered from is the scrape rows a caller has in hand. That
 * fallback inherits the capped-scan boundary described at the top of this file,
 * which is exactly why it is the fallback and not the rule. Callers may omit it
 * entirely; 0004 backfilled the column.
 *
 * An empty string is treated as absent. It is not an Instagram id, and matching
 * on it would collapse every such row onto one imaginary post.
 */
export function resolveIgId(
  analysis: AnalysisIdentity,
  igIdByRowId: ReadonlyMap<string, string> = NO_LEGACY_ROWS,
): string | null {
  if (analysis.ig_id !== null && analysis.ig_id !== '') return analysis.ig_id;
  return igIdByRowId.get(analysis.post_id) ?? null;
}

/** `Date.parse` of an unusable timestamp is NaN; sort such a row oldest. */
function millis(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/**
 * Which of two analyses of the same post is shown.
 *
 * An analysis on the row now displayed beats one on a superseded row; then the
 * newer wins; then the lower post_id, so that two analyses written in the same
 * millisecond land the same way on every request. PostgREST promises no order
 * within a tie and neither does the collapse, so without the last clause the
 * screen could change between refreshes with nothing behind it.
 */
function beats<A extends AnalysisIdentity>(
  candidate: AnalysisLink<A>,
  held: AnalysisLink<A>,
): boolean {
  if (candidate.superseded !== held.superseded) return held.superseded;
  const candidateAt = millis(candidate.analysis.created_at);
  const heldAt = millis(held.analysis.created_at);
  if (candidateAt !== heldAt) return candidateAt > heldAt;
  return candidate.analysis.post_id < held.analysis.post_id;
}

/**
 * Analyses keyed by the POST they describe, not by the scrape row they cite.
 *
 * `population` is the COLLAPSED population — one row per post, the winner of
 * distinctPosts(). Its `id`s are what separate a current analysis from a
 * superseded one, and its `ig_id`s are what bound the index: an analysis for a
 * post this population does not contain is counted as unresolved rather than
 * silently attached to nothing.
 *
 * Nothing in here reads a database, a clock or an environment. Given the same
 * arrays it returns the same index, which is what makes the re-spend rule
 * testable at all.
 */
export function indexAnalysesByPost<A extends AnalysisIdentity>(
  analyses: readonly A[],
  population: readonly PostIdentityRow[],
  igIdByRowId: ReadonlyMap<string, string> = NO_LEGACY_ROWS,
): AnalysisIndex<A> {
  const winnerRowIds = new Set<string>();
  const populationIgIds = new Set<string>();
  for (const post of population) {
    winnerRowIds.add(post.id);
    populationIgIds.add(post.ig_id);
  }

  const byIgId = new Map<string, AnalysisLink<A>>();
  let unresolved = 0;

  for (const analysis of analyses) {
    const igId = resolveIgId(analysis, igIdByRowId);
    if (igId === null || !populationIgIds.has(igId)) {
      unresolved += 1;
      continue;
    }
    const link: AnalysisLink<A> = { analysis, superseded: !winnerRowIds.has(analysis.post_id) };
    const held = byIgId.get(igId);
    if (held === undefined || beats(link, held)) byIgId.set(igId, link);
  }

  let analyzedCurrent = 0;
  let analyzedSuperseded = 0;
  for (const link of byIgId.values()) {
    if (link.superseded) analyzedSuperseded += 1;
    else analyzedCurrent += 1;
  }

  return {
    byIgId,
    unresolved,
    analyzed_current: analyzedCurrent,
    analyzed_superseded: analyzedSuperseded,
  };
}
