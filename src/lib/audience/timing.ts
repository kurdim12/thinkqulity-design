/**
 * Hard rule 11 — timing claims need timing data.
 *
 * Posting-time patterns are arithmetic over `posted_at x engagement`, so they
 * are computed here and never asserted by a model. "His audience engages at
 * night" is a hypothesis; "posts published 20:00–23:00 average 2.1x (n=41)" is
 * data, and the n travels with it everywhere.
 *
 * Pure functions, no I/O, no environment reads, no model — so this module runs
 * unchanged under `node --test --experimental-strip-types`, which is why the
 * one import is type-only and carries an explicit `.ts` extension, exactly as
 * the Law modules do.
 */

import type { Account, PostRow, TimingCell, TimingReport } from '../types/db.ts';

/**
 * Ahmad posts to a Jordanian audience, so "9pm" means 9pm in Amman. UTC hours
 * would shift every claim by three hours and quietly turn an evening pattern
 * into an afternoon one.
 *
 * The conversion goes through Intl with an explicit `timeZone` rather than a
 * hard-coded +03:00, because a fixed offset silently corrupts any post from
 * before Jordan stopped changing its clocks. ICU knows the history; we don't
 * have to.
 */
export const AMMAN_TIME_ZONE = 'Asia/Amman';

/**
 * The floor for reporting a window. Below this, an "average" is one loud post
 * wearing a trend coat — so a window with fewer than 5 posts is EXCLUDED from
 * best_windows rather than reported with a caveat. The value travels back to
 * the caller as `min_window_n` so the UI can state the rule it enforced.
 */
export const MIN_WINDOW_N = 5;

/** A "window" people can act on is a few hours, not a third of a day. */
export const MAX_WINDOW_HOURS = 6;

/** Three non-overlapping windows is a finding; ten is a heatmap in prose. */
export const MAX_BEST_WINDOWS = 3;

export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;

/**
 * Everything the timing engine needs from a post. Derived from PostRow, so a
 * `PostRow[]` is accepted as-is and a three-column select is accepted too.
 */
export type TimingPost = Pick<PostRow, 'account' | 'posted_at' | 'engagement'>;

export interface BuildTimingOptions {
  /** Which account to measure. Defaults to 'all'. */
  account?: Account | 'all';
  /** Defaults to Asia/Amman. Overridable so the choice stays visible. */
  timeZone?: string;
  /** Defaults to MIN_WINDOW_N. */
  minWindowN?: number;
  /** Defaults to MAX_WINDOW_HOURS. */
  maxWindowHours?: number;
  /** Defaults to MAX_BEST_WINDOWS. */
  maxWindows?: number;
}

/** An instant resolved into the local grid. */
export interface LocalCell {
  /** 0–23 in the report's timezone. */
  hour: number;
  /** 0 = Sunday, matching dayjs `.day()`. */
  weekday: number;
}

/**
 * A TimingReport plus the two facts a reader needs to trust it: the timezone
 * the hours are in, and the minimum n a window had to clear to be reported.
 * Both are additive — db.ts is a shared contract and is not edited here, and
 * the extra keys ride along into the `timing` jsonb column.
 *
 * `overall_avg` is 0 only when `total_n` is 0. The type cannot express null
 * there, so a consumer MUST branch on `total_n === 0` and render an em-dash;
 * treating that 0 as an average would be a fabricated number (hard rule 2).
 */
export interface TimingResult extends TimingReport {
  min_window_n: number;
  time_zone: string;
}

/* ------------------------------------------------------------ conversion -- */

const WEEKDAY_INDEX: Record<string, number | undefined> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // h23 gives 00–23. `hour12: false` has shipped as h24 ("24:00") in some
    // ICU builds, which would put midnight in a bucket that does not exist.
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
  });
  formatters.set(timeZone, made);
  return made;
}

/**
 * Resolves an ISO instant to its local hour and weekday. Returns null — never
 * a guessed bucket — when the value is missing or unparseable.
 */
export function toLocalCell(
  postedAt: string | null | undefined,
  timeZone: string = AMMAN_TIME_ZONE,
): LocalCell | null {
  if (!postedAt) return null;
  const at = new Date(postedAt);
  if (Number.isNaN(at.getTime())) return null;

  let hour: number | null = null;
  let weekday: number | null = null;

  for (const part of formatterFor(timeZone).formatToParts(at)) {
    if (part.type === 'hour') {
      const parsed = Number.parseInt(part.value, 10);
      hour = Number.isFinite(parsed) ? parsed % HOURS_PER_DAY : null;
    } else if (part.type === 'weekday') {
      weekday = WEEKDAY_INDEX[part.value] ?? null;
    }
  }

  if (hour === null || weekday === null) return null;
  return { hour, weekday };
}

/* --------------------------------------------------------------- helpers -- */

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `[20, 24)` reads as "20:00–00:00" — the end hour is exclusive. */
function windowLabel(start: number, end: number, timeZone: string): string {
  return `${pad2(start)}:00–${pad2(end % HOURS_PER_DAY)}:00 ${timeZone}`;
}

interface WindowCandidate {
  start: number;
  end: number;
  span: number;
  n: number;
  avg: number;
}

/* ----------------------------------------------------------------- build -- */

/**
 * The hour x weekday grid, plus the contiguous hour ranges that genuinely beat
 * the overall average.
 *
 * Every one of the 168 cells is returned, so the caller renders a complete
 * grid; an empty cell carries `n: 0` and `avg_engagement: null` — never 0,
 * because 0 is a measurement and null is an absence.
 *
 * A window is only reported when it (a) clears `minWindowN`, (b) beats the
 * overall average, and (c) starts and ends on an hour that actually has posts.
 * Rule (c) keeps a claim tight: padding an empty hour onto either edge would
 * widen the stated window without adding a single post to it. Empty hours in
 * the MIDDLE of a window are allowed — a quiet 21:00 between a busy 20:00 and
 * 22:00 is part of the same evening.
 *
 * Windows never wrap past midnight: a range spanning the day boundary mixes
 * two different local evenings and its label would be ambiguous.
 */
export function buildTiming(
  posts: readonly TimingPost[],
  opts: BuildTimingOptions = {},
): TimingResult {
  const account: Account | 'all' = opts.account ?? 'all';
  const timeZone = opts.timeZone ?? AMMAN_TIME_ZONE;
  const minWindowN = positiveIntOr(opts.minWindowN, MIN_WINDOW_N);
  const maxWindows = positiveIntOr(opts.maxWindows, MAX_BEST_WINDOWS);
  const maxWindowHours = Math.min(
    positiveIntOr(opts.maxWindowHours, MAX_WINDOW_HOURS),
    HOURS_PER_DAY,
  );

  const cellN = new Array<number>(HOURS_PER_DAY * DAYS_PER_WEEK).fill(0);
  const cellSum = new Array<number>(HOURS_PER_DAY * DAYS_PER_WEEK).fill(0);
  const hourN = new Array<number>(HOURS_PER_DAY).fill(0);
  const hourSum = new Array<number>(HOURS_PER_DAY).fill(0);

  let totalN = 0;
  let totalSum = 0;

  for (const post of posts) {
    if (account !== 'all' && post.account !== account) continue;
    // A post whose engagement is not a real number is not measured as 0.
    if (!Number.isFinite(post.engagement)) continue;
    const cell = toLocalCell(post.posted_at, timeZone);
    if (!cell) continue;

    const index = cell.weekday * HOURS_PER_DAY + cell.hour;
    cellN[index] += 1;
    cellSum[index] += post.engagement;
    hourN[cell.hour] += 1;
    hourSum[cell.hour] += post.engagement;
    totalN += 1;
    totalSum += post.engagement;
  }

  const cells: TimingCell[] = [];
  for (let weekday = 0; weekday < DAYS_PER_WEEK; weekday += 1) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      const index = weekday * HOURS_PER_DAY + hour;
      const n = cellN[index];
      cells.push({
        hour,
        weekday,
        n,
        avg_engagement: n > 0 ? round2(cellSum[index] / n) : null,
      });
    }
  }

  const overallAvgRaw = totalN > 0 ? totalSum / totalN : 0;

  const candidates: WindowCandidate[] = [];
  if (overallAvgRaw > 0) {
    for (let start = 0; start < HOURS_PER_DAY; start += 1) {
      if (hourN[start] === 0) continue; // never starts on an empty hour
      let n = 0;
      let sum = 0;
      for (let span = 1; span <= maxWindowHours && start + span <= HOURS_PER_DAY; span += 1) {
        const end = start + span;
        n += hourN[end - 1];
        sum += hourSum[end - 1];
        if (hourN[end - 1] === 0) continue; // never ends on an empty hour
        if (n < minWindowN) continue; // stated minimum: excluded, not caveated
        const avg = sum / n;
        if (avg <= overallAvgRaw) continue; // a "best" window has to beat the mean
        candidates.push({ start, end, span, n, avg });
      }
    }
  }

  candidates.sort(
    (a, b) =>
      b.avg - a.avg || // strongest first
      b.n - a.n || // then the one resting on more posts
      a.span - b.span || // then the tightest claim
      a.start - b.start,
  );

  const best: TimingReport['best_windows'] = [];
  const claimed = new Array<boolean>(HOURS_PER_DAY).fill(false);

  for (const candidate of candidates) {
    if (best.length >= maxWindows) break;
    let overlaps = false;
    for (let hour = candidate.start; hour < candidate.end; hour += 1) {
      if (claimed[hour]) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    for (let hour = candidate.start; hour < candidate.end; hour += 1) claimed[hour] = true;

    best.push({
      label: windowLabel(candidate.start, candidate.end, timeZone),
      hours: [candidate.start, candidate.end],
      n: candidate.n,
      avg_engagement: round2(candidate.avg),
      multiple_vs_overall: round2(candidate.avg / overallAvgRaw),
    });
  }

  return {
    cells,
    best_windows: best,
    overall_avg: totalN > 0 ? round2(overallAvgRaw) : 0,
    total_n: totalN,
    account,
    min_window_n: minWindowN,
    time_zone: timeZone,
  };
}
