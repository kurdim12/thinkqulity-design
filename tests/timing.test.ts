import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMMAN_TIME_ZONE,
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  MAX_BEST_WINDOWS,
  MIN_WINDOW_N,
  buildTiming,
  toLocalCell,
  type TimingPost,
  type TimingResult,
} from '../src/lib/audience/timing.ts';
import type { TimingCell } from '../src/lib/types/db.ts';

/* ------------------------------------------------------------- fixtures -- */

/**
 * Amman runs three hours ahead of UTC, so a post at 18:00Z lands at 21:00
 * local. Every instant below is written as UTC and commented with the local
 * time it is meant to produce — if the conversion ever breaks, the comment and
 * the assertion disagree.
 */
function post(postedAt: string | null, engagement: number, account: 'personal' | 'academy' = 'personal'): TimingPost {
  return { account, posted_at: postedAt, engagement };
}

function times(count: number, make: () => TimingPost): TimingPost[] {
  return Array.from({ length: count }, make);
}

/** Cells are emitted weekday-major; the ordering test below locks that in. */
function cellAt(report: TimingResult, weekday: number, hour: number): TimingCell {
  return report.cells[weekday * HOURS_PER_DAY + hour];
}

/* ----------------------------------------------------------------- empty -- */

test('an empty corpus produces a full grid and no findings', () => {
  const report = buildTiming([]);

  assert.equal(report.cells.length, HOURS_PER_DAY * DAYS_PER_WEEK);
  assert.equal(report.total_n, 0);
  assert.deepEqual(report.best_windows, []);
  assert.equal(report.account, 'all');
  assert.equal(report.time_zone, AMMAN_TIME_ZONE);
  assert.equal(report.min_window_n, MIN_WINDOW_N);
  // overall_avg is 0 ONLY because total_n is 0 — the caller renders an em-dash.
  assert.equal(report.overall_avg, 0);
  assert.ok(report.cells.every((c) => c.n === 0 && c.avg_engagement === null));
});

test('cells are emitted weekday-major, every hour of every day', () => {
  const report = buildTiming([]);
  for (let weekday = 0; weekday < DAYS_PER_WEEK; weekday += 1) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      const cell = report.cells[weekday * HOURS_PER_DAY + hour];
      assert.equal(cell.weekday, weekday);
      assert.equal(cell.hour, hour);
    }
  }
});

/* ------------------------------------------------------------ empty cell -- */

test('an hour with no posts is null, never 0', () => {
  // 6 posts at 21:00 Amman (Wed 10 June 2026), nothing anywhere else.
  const report = buildTiming(times(6, () => post('2026-06-10T18:00:00Z', 100)));

  const quiet = cellAt(report, 3, 3); // Wednesday 03:00
  assert.equal(quiet.n, 0);
  assert.equal(quiet.avg_engagement, null);
  assert.notEqual(quiet.avg_engagement, 0);
});

/* ------------------------------------------------ known distribution --- */

test('the best window is the arithmetic, computed by hand', () => {
  const report = buildTiming([
    ...times(6, () => post('2026-06-10T18:00:00Z', 100)), // Wed 21:00 Amman
    ...times(6, () => post('2026-06-10T06:00:00Z', 20)), // Wed 09:00 Amman
  ]);

  // 12 posts, (6 x 100) + (6 x 20) = 720, so the overall average is 60.
  assert.equal(report.total_n, 12);
  assert.equal(report.overall_avg, 60);

  assert.deepEqual(cellAt(report, 3, 21), { hour: 21, weekday: 3, n: 6, avg_engagement: 100 });
  assert.deepEqual(cellAt(report, 3, 9), { hour: 9, weekday: 3, n: 6, avg_engagement: 20 });

  // Only the evening beats the mean. 100 / 60 = 1.666… -> 1.67.
  assert.equal(report.best_windows.length, 1);
  assert.deepEqual(report.best_windows[0], {
    label: '21:00–22:00 Asia/Amman',
    hours: [21, 22],
    n: 6,
    avg_engagement: 100,
    multiple_vs_overall: 1.67,
  });
});

test('a window never starts or ends on an empty hour, but may span one', () => {
  const report = buildTiming([
    ...times(5, () => post('2026-06-10T17:00:00Z', 300)), // Wed 20:00 Amman
    ...times(5, () => post('2026-06-10T20:00:00Z', 300)), // Wed 23:00 Amman
    ...times(10, () => post('2026-06-10T09:00:00Z', 10)), // Wed 12:00 Amman
  ]);

  // 20 posts, 1500 + 1500 + 100 = 3100, overall average 155.
  assert.equal(report.overall_avg, 155);

  // 21:00 and 22:00 are empty, but they sit INSIDE the window, so 20:00–00:00
  // wins on n (10 posts) over either single hour at the same average.
  assert.equal(report.best_windows.length, 1);
  assert.deepEqual(report.best_windows[0], {
    label: '20:00–00:00 Asia/Amman',
    hours: [20, 24],
    n: 10,
    avg_engagement: 300,
    multiple_vs_overall: 1.94, // 300 / 155 = 1.9354… -> 1.94
  });
});

/* --------------------------------------------------------- the minimum n -- */

test('a window below the stated minimum is excluded, not reported', () => {
  const posts = [
    ...times(4, () => post('2026-06-10T19:00:00Z', 1000)), // Wed 22:00 Amman, n = 4
    ...times(6, () => post('2026-06-10T06:00:00Z', 10)), // Wed 09:00 Amman
  ];

  const report = buildTiming(posts);
  // The 22:00 hour has by far the highest average and is still dropped: n = 4
  // is below MIN_WINDOW_N = 5.
  assert.equal(report.min_window_n, MIN_WINDOW_N);
  assert.deepEqual(report.best_windows, []);

  // The grid still records it — exclusion applies to the CLAIM, not the data.
  assert.deepEqual(cellAt(report, 3, 22), { hour: 22, weekday: 3, n: 4, avg_engagement: 1000 });
});

test('lowering the stated minimum reports the same window, minimum included', () => {
  const report = buildTiming(
    [
      ...times(4, () => post('2026-06-10T19:00:00Z', 1000)), // Wed 22:00 Amman
      ...times(6, () => post('2026-06-10T06:00:00Z', 10)), // Wed 09:00 Amman
    ],
    { minWindowN: 4 },
  );

  // 10 posts, 4000 + 60 = 4060, overall average 406. 1000 / 406 = 2.4630… -> 2.46.
  assert.equal(report.min_window_n, 4);
  assert.equal(report.overall_avg, 406);
  assert.deepEqual(report.best_windows[0], {
    label: '22:00–23:00 Asia/Amman',
    hours: [22, 23],
    n: 4,
    avg_engagement: 1000,
    multiple_vs_overall: 2.46,
  });
});

/* ------------------------------------------------------------- timezone -- */

test('toLocalCell moves an instant across the UTC day boundary into Amman', () => {
  // 22:30Z on Thursday 13 Aug 2026 is 01:30 on FRIDAY 14 Aug in Amman.
  assert.deepEqual(toLocalCell('2026-08-13T22:30:00Z'), { hour: 1, weekday: 5 });
  // 20:30Z the same evening is still Thursday, 23:00 local.
  assert.deepEqual(toLocalCell('2026-08-13T20:30:00Z'), { hour: 23, weekday: 4 });
});

test('the grid buckets a post by its Amman weekday, not its UTC one', () => {
  const report = buildTiming([
    ...times(5, () => post('2026-08-13T22:30:00Z', 200)), // Fri 01:30 Amman
    ...times(5, () => post('2026-08-13T09:00:00Z', 100)), // Thu 12:00 Amman
  ]);

  assert.equal(cellAt(report, 5, 1).n, 5); // Friday 01:00 — the real bucket
  assert.equal(cellAt(report, 4, 22).n, 0); // Thursday 22:00 — the UTC mirage
  assert.equal(cellAt(report, 4, 22).avg_engagement, null);

  // 10 posts, 1000 + 500 = 1500, overall 150. 200 / 150 = 1.333… -> 1.33.
  assert.deepEqual(report.best_windows[0], {
    label: '01:00–02:00 Asia/Amman',
    hours: [1, 2],
    n: 5,
    avg_engagement: 200,
    multiple_vs_overall: 1.33,
  });
});

test('the timezone is overridable and travels with the report', () => {
  const report = buildTiming(times(5, () => post('2026-08-13T22:30:00Z', 200)), {
    timeZone: 'UTC',
  });
  assert.equal(report.time_zone, 'UTC');
  assert.equal(cellAt(report, 4, 22).n, 5); // Thursday 22:00 UTC
});

/* ------------------------------------------------------------ exclusions -- */

test('a post with no usable posted_at is excluded, not bucketed at midnight', () => {
  const report = buildTiming([
    ...times(5, () => post('2026-06-10T06:00:00Z', 100)), // Wed 09:00 Amman
    post(null, 900),
    post('', 900),
    post('not-a-date', 900),
  ]);

  assert.equal(report.total_n, 5);
  assert.equal(report.overall_avg, 100);
  assert.equal(cellAt(report, 3, 0).n, 0);
});

test('a post with non-finite engagement is excluded, not counted as 0', () => {
  const report = buildTiming([
    ...times(4, () => post('2026-06-10T06:00:00Z', 100)), // Wed 09:00 Amman
    post('2026-06-10T06:00:00Z', Number.NaN),
  ]);

  assert.equal(report.total_n, 4);
  assert.equal(report.overall_avg, 100);
  assert.equal(cellAt(report, 3, 9).n, 4);
});

test('only the requested account is measured', () => {
  const posts = [
    ...times(6, () => post('2026-06-10T18:00:00Z', 100, 'personal')),
    ...times(6, () => post('2026-06-10T06:00:00Z', 40, 'academy')),
  ];

  const academy = buildTiming(posts, { account: 'academy' });
  assert.equal(academy.account, 'academy');
  assert.equal(academy.total_n, 6);
  assert.equal(academy.overall_avg, 40);
  assert.equal(cellAt(academy, 3, 21).n, 0);
});

/* --------------------------------------------------------- window limits -- */

test('windows never overlap and stop at the maximum', () => {
  const posts = [
    ...times(5, () => post('2026-06-10T02:00:00Z', 500)), // Wed 05:00 Amman
    ...times(5, () => post('2026-06-10T06:00:00Z', 400)), // Wed 09:00 Amman
    ...times(5, () => post('2026-06-10T10:00:00Z', 300)), // Wed 13:00 Amman
    ...times(5, () => post('2026-06-10T14:00:00Z', 200)), // Wed 17:00 Amman
    ...times(20, () => post('2026-06-10T17:00:00Z', 10)), // Wed 20:00 Amman
  ];

  // 40 posts, 2500 + 2000 + 1500 + 1000 + 200 = 7200, overall 180.
  const report = buildTiming(posts);
  assert.equal(report.overall_avg, 180);
  assert.equal(report.best_windows.length, MAX_BEST_WINDOWS);
  assert.deepEqual(
    report.best_windows.map((w) => w.hours),
    [
      [5, 6],
      [9, 10],
      [13, 14],
    ],
  );

  const capped = buildTiming(posts, { maxWindows: 1 });
  assert.equal(capped.best_windows.length, 1);
  assert.deepEqual(capped.best_windows[0].hours, [5, 6]);
});
