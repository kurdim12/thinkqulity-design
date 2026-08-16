'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Card, Col, Descriptions, Row, Space, Statistic, Table, Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, describeError } from '@/lib/client/api';
import {
  PageHeader,
  SeedAlert,
  EmptyState,
  ErrorState,
  GroundingTag,
  LoadingBlock,
} from '@/components/ui';
import { formatDate, formatNumber, formatSignedNumber } from '@/lib/date';
import { MAX_SNAPSHOT_AGE_DAYS } from '@/lib/snapshots';
import { GOLD } from '@/lib/theme';
import { distinctPosts } from '@/lib/audience/posts';
import { buildTiming, toLocalCell, HOURS_PER_DAY, type TimingResult } from '@/lib/audience/timing';
import type {
  Account,
  BrandRow,
  PostRow,
  ProfileSnapshotRow,
  SnapshotRow,
} from '@/lib/types/db';

interface ConceptCounts {
  draft: number;
  approved: number;
  shipped: number;
  rejected: number;
}

interface DashboardResponse {
  brand: BrandRow;
  snapshot: SnapshotRow | null;
  days_since_snapshot: number | null;
  top_posts: PostRow[];
  concept_counts: ConceptCounts;
}

/* --------------------------------------------------------- profile history -- */

/** Mirrors the `accounts` half of GET /api/profile. */
interface ProfileDelta {
  previous_taken_on: string;
  days_between: number | null;
  followers: number | null;
  following: number | null;
  posts_count: number | null;
}

interface AccountHistory {
  latest: ProfileSnapshotRow | null;
  previous: ProfileSnapshotRow | null;
  /** Null until a SECOND profile snapshot exists for that account. */
  delta: ProfileDelta | null;
}

interface ProfileResponse {
  handles: Record<Account, string>;
  accounts: Record<Account, AccountHistory>;
}

interface PostsResponse {
  posts: PostRow[];
}

type LoadError = { message: string; hint: string | null };

/* ------------------------------------------------------------- recomputing -- */

/**
 * The 508-vs-40 opener is recomputed here from the snapshot's own post rows.
 * `snapshots.stats.avg_engagement` holds the same figures, but a stored number
 * is a number that can go stale silently — this one cannot: it is the mean of
 * the rows the table is showing, and it travels with its n.
 *
 * A post whose engagement is not a real number is skipped rather than counted
 * as 0, exactly as the timing engine does.
 */
interface AccountEngagement {
  n: number;
  /** Null when n is 0 — an average of nothing is an absence, not a zero. */
  avg: number | null;
}

function summariseEngagement(posts: PostRow[]): Record<Account, AccountEngagement> {
  const tally: Record<Account, { n: number; sum: number }> = {
    personal: { n: 0, sum: 0 },
    academy: { n: 0, sum: 0 },
  };

  for (const post of posts) {
    if (!Number.isFinite(post.engagement)) continue;
    const bucket = tally[post.account];
    bucket.n += 1;
    bucket.sum += post.engagement;
  }

  return {
    personal: {
      n: tally.personal.n,
      avg: tally.personal.n > 0 ? tally.personal.sum / tally.personal.n : null,
    },
    academy: {
      n: tally.academy.n,
      avg: tally.academy.n > 0 ? tally.academy.sum / tally.academy.n : null,
    },
  };
}

/* ----------------------------------------------------------- timing strip -- */

interface HourBucket {
  hour: number;
  n: number;
  avg: number | null;
  /**
   * Whether the hour cleared the SAME minimum n that buildTiming() enforced on
   * best_windows. A sub-threshold hour still carries its n and its average —
   * they are measurements — but the strip refuses to rank it.
   */
  reportable: boolean;
}

/**
 * The 24-hour strip, collapsed across weekdays.
 *
 * It re-walks the posts through the timing engine's own `toLocalCell` rather
 * than re-adding the report's per-cell averages: those are rounded to two
 * decimals, and a sum rebuilt from rounded means is a slightly different number
 * than the one /audience shows. Same conversion, same skip rules, exact totals.
 *
 * `minN` is not a threshold of the strip's own invention: the caller passes the
 * effective `min_window_n` off the TimingResult, so the at-a-glance bar and the
 * careful best_windows list can never disagree about what counts as enough
 * posts (hard rule 11).
 */
function hourlyStrip(posts: PostRow[], timeZone: string, minN: number): HourBucket[] {
  const counts = new Array<number>(HOURS_PER_DAY).fill(0);
  const sums = new Array<number>(HOURS_PER_DAY).fill(0);

  for (const post of posts) {
    if (!Number.isFinite(post.engagement)) continue;
    const cell = toLocalCell(post.posted_at, timeZone);
    if (!cell) continue;
    counts[cell.hour] += 1;
    sums[cell.hour] += post.engagement;
  }

  return Array.from({ length: HOURS_PER_DAY }, (_, hour) => ({
    hour,
    n: counts[hour],
    avg: counts[hour] > 0 ? sums[hour] / counts[hour] : null,
    reportable: counts[hour] >= minN,
  }));
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Labels every sixth hour; the rest of the axis stays quiet. */
const HOUR_LABEL_EVERY = 6;

/** GOLD as "r, g, b" so a bar can vary its alpha without re-declaring the hex. */
function hexToRgbTriplet(hex: string): string {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ].join(', ');
}

const GOLD_RGB = hexToRgbTriplet(GOLD);

/**
 * Three different facts, three different appearances. They must never share a
 * visual language, because a reader glancing at the strip is reading the shape,
 * not the tooltip:
 *
 * - NO_POSTS_STYLE — nothing was published in that hour. Hatched, dashed, no
 *   fill. Identical to the empty cell on /audience, so the two surfaces read as
 *   one language.
 * - BELOW_MIN_STYLE — posts exist, but fewer than the report's `min_window_n`,
 *   so their average is one loud post wearing a trend coat. Flat neutral, solid
 *   border, a centre dot: measured, deliberately NOT coloured. It is on purpose
 *   nowhere near the bottom of the gold ramp — "too few to rank" and "ranked,
 *   and weak" are different claims and must not look alike.
 * - the gold ramp — n >= min_window_n, alpha proportional to the hour's average.
 */
const NO_POSTS_STYLE: React.CSSProperties = {
  background:
    'repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(28, 27, 25, 0.1) 3px, rgba(28, 27, 25, 0.1) 4px)',
  border: '1px dashed rgba(28, 27, 25, 0.28)',
};

const BELOW_MIN_STYLE: React.CSSProperties = {
  background: 'rgba(28, 27, 25, 0.04)',
  border: '1px solid rgba(28, 27, 25, 0.3)',
};

const BELOW_MIN_DOT: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: '50%',
  background: 'rgba(28, 27, 25, 0.45)',
};

const RANKED_BAR_BORDER = '1px solid var(--tq-line)';

/* ---------------------------------------------------------- follower card -- */

/**
 * One account's follower count, always with the date it was measured on.
 *
 * The only follower figure this app ever had was the seeded string in
 * brand.facts, which is undated prose with a source label. It is deliberately
 * NOT a fallback here: when profile_snapshots is empty this card shows an
 * em-dash and the scrape that would fill it. The seed survives as history in
 * the Brand Brain, and nowhere else.
 */
function FollowerCard({
  title,
  handle,
  history,
  loading,
  error,
}: {
  title: string;
  handle: string | null;
  history: AccountHistory | null;
  loading: boolean;
  error: LoadError | null;
}) {
  const { t, tt, locale } = useLocale();

  const latest = history?.latest ?? null;
  const followers = latest?.followers ?? null;
  const delta = history?.delta ?? null;

  return (
    <Card>
      <Statistic
        title={title}
        value={followers === null ? '—' : formatNumber(followers)}
        valueStyle={{ direction: 'ltr' }}
        className="tq-num"
      />

      {handle ? (
        <div className="tq-muted tq-num" style={{ fontSize: 12, marginBlockStart: 2 }}>
          {`@${handle}`}
        </div>
      ) : null}

      {loading ? (
        <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 6 }}>
          {`${t.common.loading}…`}
        </div>
      ) : error ? (
        <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 6 }}>
          <div>{error.message}</div>
          {error.hint ? <div>{error.hint}</div> : null}
        </div>
      ) : latest === null ? (
        <div style={{ fontSize: 12, marginBlockStart: 6 }}>
          <div className="tq-muted">
            {tt(
              'لا توجد لقطة بروفايل لهذا الحساب بعد.',
              'No profile snapshot has been taken for this account yet.',
            )}
          </div>
          <Link href="/data">
            {tt('شغّل مسح البروفايل من شاشة البيانات', 'Run the profile scrape on the Data screen')}
          </Link>
        </div>
      ) : (
        <>
          <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 6 }}>
            {tt('حتى', 'as of')}{' '}
            <span className="tq-num">{formatDate(latest.taken_on, locale)}</span>
          </div>

          {followers === null ? (
            <div className="tq-muted" style={{ fontSize: 12 }}>
              {tt(
                'تلك اللقطة لم تُعِد عدد متابعين.',
                'That snapshot returned no follower count.',
              )}
            </div>
          ) : null}

          <div style={{ marginBlockStart: 8 }}>
            <div className="tq-muted" style={{ fontSize: 12 }}>
              {tt('التغير عن اللقطة السابقة', 'Change vs previous snapshot')}
            </div>
            <div>
              <span className="tq-num">
                {delta === null ? '—' : formatSignedNumber(delta.followers)}
              </span>
              {delta !== null ? (
                <span className="tq-muted" style={{ fontSize: 12 }}>
                  {' · '}
                  {tt('مقابل', 'vs')}{' '}
                  <span className="tq-num">{formatDate(delta.previous_taken_on, locale)}</span>
                </span>
              ) : null}
            </div>
            {delta === null ? (
              <div className="tq-muted" style={{ fontSize: 12 }}>
                {tt(
                  'يظهر بعد وجود لقطة بروفايل ثانية لهذا الحساب.',
                  'Shown once a second profile snapshot exists for this account.',
                )}
              </div>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}

/* ================================================================ the page == */

export default function DashboardPage() {
  const { t, tt, locale } = useLocale();

  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<LoadError | null>(null);

  const [posts, setPosts] = useState<PostRow[] | null>(null);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState<LoadError | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setHint(null);
    apiGet<DashboardResponse>('/api/dashboard')
      .then((res) => setData(res))
      .catch((err) => {
        const desc = describeError(err);
        setError(desc.message);
        setHint(desc.hint);
      })
      .finally(() => setLoading(false));

    // Follower history is its own round trip: /api/dashboard reads `snapshots`,
    // and follower counts do not live there. A failure on one must not blank
    // the other, so they carry separate error state.
    setProfileLoading(true);
    setProfileError(null);
    apiGet<ProfileResponse>('/api/profile')
      .then((res) => setProfile(res))
      .catch((err) => setProfileError(describeError(err)))
      .finally(() => setProfileLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const snapshotId = data?.snapshot?.id ?? null;

  const loadPosts = useCallback((id: string | null) => {
    if (!id) {
      setPosts(null);
      setPostsError(null);
      setPostsLoading(false);
      return;
    }
    setPostsLoading(true);
    setPostsError(null);
    apiGet<PostsResponse>(`/api/snapshots/${id}/posts`)
      .then((res) => setPosts(res.posts))
      .catch((err) => setPostsError(describeError(err)))
      .finally(() => setPostsLoading(false));
  }, []);

  useEffect(() => {
    loadPosts(snapshotId);
  }, [loadPosts, snapshotId]);

  /**
   * ONE population for this whole page, collapsed by the shared rule.
   *
   * `/api/snapshots/{id}/posts` filters on a single snapshot_id, and `posts` is
   * UNIQUE (snapshot_id, ig_id), so the collapse is provably a no-op today.
   * It runs anyway for two reasons: every surface that reports a post count
   * must apply the SAME rule as /audience rather than each trusting its own
   * query shape, and if that endpoint is ever widened this page will collapse
   * the re-scrapes instead of silently counting each post twice.
   * `duplicates_collapsed` is shown whenever it is not zero — a dedupe nobody
   * can see is a number changed in secret.
   */
  const population = useMemo(() => (posts === null ? null : distinctPosts(posts)), [posts]);

  const engagement = useMemo(
    () => (population === null ? null : summariseEngagement(population.posts)),
    [population],
  );

  const timing = useMemo<TimingResult | null>(
    () =>
      population === null || population.posts.length === 0 ? null : buildTiming(population.posts),
    [population],
  );

  const hourly = useMemo(
    () =>
      population === null || timing === null
        ? null
        : hourlyStrip(population.posts, timing.time_zone, timing.min_window_n),
    [population, timing],
  );

  /**
   * The top of the ramp, taken from RANKED hours only.
   *
   * Dividing by a peak that a single post set would compress every honest hour
   * against one unrepeatable reading — the same defect the bars themselves had.
   * Stays 0 when no hour clears the minimum, and 0 is handled at the fill: it
   * means "no ramp", not "an average of zero".
   */
  const peakHourAvg = useMemo(() => {
    if (hourly === null) return 0;
    let peak = 0;
    for (const bucket of hourly) {
      if (!bucket.reportable || bucket.avg === null) continue;
      if (bucket.avg > peak) peak = bucket.avg;
    }
    return peak;
  }, [hourly]);

  if (loading) {
    return (
      <div className="tq-page">
        <PageHeader title={t.nav.dashboard} />
        <LoadingBlock rows={6} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="tq-page">
        <PageHeader title={t.nav.dashboard} />
        <ErrorState error={error} hint={hint} onRetry={load} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="tq-page">
        <PageHeader title={t.nav.dashboard} />
        <ErrorState error={t.common.error} onRetry={load} />
      </div>
    );
  }

  const { brand, snapshot, days_since_snapshot, top_posts, concept_counts } = data;
  const stats = snapshot?.stats ?? null;
  const diff = stats?.diff_vs_prev ?? null;
  // The same constant the report feature refuses on, not a second copy of 45.
  const daysWarning = days_since_snapshot !== null && days_since_snapshot > MAX_SNAPSHOT_AGE_DAYS;

  // The headline ratio, only when both sides are real measurements.
  const personalAvg = engagement?.personal.avg ?? null;
  const academyAvg = engagement?.academy.avg ?? null;
  const ratio =
    personalAvg !== null && academyAvg !== null && academyAvg > 0 ? personalAvg / academyAvg : null;

  const measuredPosts = population === null ? 0 : population.posts.length;
  const timedPosts = timing?.total_n ?? 0;
  const untimedPosts = measuredPosts - timedPosts;

  const columns: ColumnsType<PostRow> = [
    {
      title: tt('الترتيب', 'Rank'),
      dataIndex: 'rank',
      key: 'rank',
      width: 70,
      render: (rank: number | null) => <span className="tq-num">{rank ?? '—'}</span>,
    },
    {
      title: t.common.account,
      dataIndex: 'account',
      key: 'account',
      width: 100,
      render: (account: PostRow['account']) => (
        <Tag>{account === 'personal' ? t.common.personal : t.common.academy}</Tag>
      ),
    },
    {
      title: tt('التفاعل', 'Engagement'),
      dataIndex: 'engagement',
      key: 'engagement',
      render: (value: number) => <span className="tq-num">{value}</span>,
    },
    {
      title: tt('الإعجابات', 'Likes'),
      dataIndex: 'likes',
      key: 'likes',
      render: (value: number | null) => <span className="tq-num">{value ?? '—'}</span>,
    },
    {
      title: tt('التعليقات', 'Comments'),
      dataIndex: 'comments',
      key: 'comments',
      render: (value: number | null) => <span className="tq-num">{value ?? '—'}</span>,
    },
    {
      title: tt('مقتطف التعليق', 'Caption excerpt'),
      dataIndex: 'caption',
      key: 'caption',
      render: (caption: string | null) =>
        caption ? (
          <span dir="auto" className="tq-ar">
            {caption.length > 90 ? `${caption.slice(0, 90)}…` : caption}
          </span>
        ) : (
          '—'
        ),
    },
    {
      title: tt('رابط', 'Link'),
      dataIndex: 'url',
      key: 'url',
      render: (url: string | null) =>
        url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {tt('فتح', 'Open')}
          </a>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <div className="tq-page">
      <PageHeader title={t.nav.dashboard} />
      <SeedAlert status={brand.status} />

      {/* ---------- the opener: recomputed, never a stored constant ---------- */}
      <Card
        title={tt('متوسط التفاعل لكل منشور', 'Average engagement per post')}
        extra={<GroundingTag grounding="data" />}
      >
        {postsLoading ? (
          <LoadingBlock rows={2} />
        ) : postsError ? (
          <ErrorState
            error={postsError.message}
            hint={postsError.hint}
            onRetry={() => loadPosts(snapshotId)}
          />
        ) : snapshot === null ||
          population === null ||
          population.posts.length === 0 ||
          engagement === null ? (
          <EmptyState
            title={tt('لا منشورات مخزّنة', 'No posts stored')}
            description={tt(
              'مع أول تصدير تقرأ هنا متوسط التفاعل لكل حساب، وعدد المنشورات وراء كل متوسط، والفارق بين الشخصي والأكاديمية.',
              'With the first export this reads out the average engagement per account, how many posts each average rests on, and how far the personal account sits from the academy.',
            )}
            actionLabel={tt('ارفع تصدير Apify', 'Ingest an Apify export')}
            href="/data"
          />
        ) : (
          <>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={8}>
                <Statistic
                  title={t.common.personal}
                  value={
                    engagement.personal.avg === null
                      ? '—'
                      : formatNumber(Math.round(engagement.personal.avg))
                  }
                  valueStyle={{ direction: 'ltr' }}
                  className="tq-num"
                />
                <div className="tq-muted" style={{ fontSize: 12 }}>
                  {'n = '}
                  <span className="tq-num">{formatNumber(engagement.personal.n)}</span>
                </div>
              </Col>
              <Col xs={24} sm={8}>
                <Statistic
                  title={t.common.academy}
                  value={
                    engagement.academy.avg === null
                      ? '—'
                      : formatNumber(Math.round(engagement.academy.avg))
                  }
                  valueStyle={{ direction: 'ltr' }}
                  className="tq-num"
                />
                <div className="tq-muted" style={{ fontSize: 12 }}>
                  {'n = '}
                  <span className="tq-num">{formatNumber(engagement.academy.n)}</span>
                </div>
              </Col>
              <Col xs={24} sm={8}>
                <Statistic
                  title={tt('الشخصي مقابل الأكاديمية', 'Personal vs academy')}
                  value={ratio === null ? '—' : `×${ratio.toFixed(1)}`}
                  valueStyle={{ direction: 'ltr' }}
                  className="tq-num"
                />
                {ratio === null ? (
                  <div className="tq-muted" style={{ fontSize: 12 }}>
                    {tt(
                      'يحتاج متوسطاً حقيقياً على الجانبين.',
                      'Needs a real average on both sides.',
                    )}
                  </div>
                ) : null}
              </Col>
            </Row>

            <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 12 }}>
              {tt('محسوبة الآن من صفوف لقطة', 'Recomputed now from the rows of the')}{' '}
              <span className="tq-num">{formatDate(snapshot.taken_on, locale)}</span>{' '}
              {tt('— وليست رقماً مخزّناً.', 'snapshot — not a stored constant.')}
              {population.duplicates_collapsed > 0 ? (
                <>
                  {' '}
                  <span className="tq-num">
                    {formatNumber(population.duplicates_collapsed)}
                  </span>{' '}
                  {tt(
                    'صفاً كان إعادة مسح لمنشور محسوب أصلاً، فطُوي ولم يُحتسب مرتين.',
                    'row(s) were re-scrapes of a post already counted, so they were collapsed rather than counted twice.',
                  )}
                </>
              ) : null}
            </div>
          </>
        )}
      </Card>

      {/* --------------------------- followers ---------------------------- */}
      <Row gutter={[16, 16]} style={{ marginBlockStart: 16 }}>
        <Col xs={24} sm={12} lg={8}>
          <FollowerCard
            title={tt('المتابعون — الحساب الشخصي', 'Followers — personal')}
            handle={profile?.handles.personal ?? null}
            history={profile?.accounts.personal ?? null}
            loading={profileLoading}
            error={profileError}
          />
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <FollowerCard
            title={tt('المتابعون — الأكاديمية', 'Followers — academy')}
            handle={profile?.handles.academy ?? null}
            history={profile?.accounts.academy ?? null}
            loading={profileLoading}
            error={profileError}
          />
        </Col>
        <Col xs={24} sm={12} lg={8}>
          <Card>
            <Statistic
              title={tt('أيام منذ آخر لقطة', 'Days since last snapshot')}
              value={days_since_snapshot ?? '—'}
              valueStyle={{ direction: 'ltr', color: daysWarning ? '#cf1322' : undefined }}
              className="tq-num"
            />
            {daysWarning ? (
              <div className="tq-muted" style={{ marginBlockStart: 4, fontSize: 12 }}>
                {/* The figure is read from the rule itself and is LTR-isolated
                    like every other number on this page, rather than typed into
                    a sentence where it can quietly stop being true. */}
                {tt('التقرير الشهري يرفض لقطة أقدم من ', 'A monthly report refuses a snapshot older than ')}
                <span className="tq-num">{formatNumber(MAX_SNAPSHOT_AGE_DAYS)}</span>
                {tt(' يوماً. شغّل مسحاً جديداً.', ' days. Run a fresh scrape.')}
              </div>
            ) : null}
          </Card>
        </Col>
      </Row>

      <p className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8, marginBlockEnd: 0 }}>
        {tt(
          'كل عدد متابعين هنا يأتي من لقطة بروفايل ويحمل تاريخها. الرقم المكتوب في عقل العلامة نصٌّ أوّلي لا قياس، فيبقى هناك سجلاً ولا يظهر في هذه البطاقات.',
          'Every follower count here comes from a profile snapshot and carries its date. The figure written into the Brand Brain is seeded prose, not a measurement, so it stays there as history and never appears on these cards.',
        )}
      </p>

      {/* ----------------------------- timing -----------------------------
          The link out of here used to name the Audience screen, and v6 deleted
          that screen — /audience now redirects to Board, which is not where the
          stored timing report lives. A link whose label promises one surface and
          whose href lands on another is worse than no link, so it is gone; the
          card states its own coverage instead of pointing at a report it cannot
          vouch for. This card recomputes live over ONE snapshot's posts, which
          is the only population `/api/snapshots/{id}/posts` can return. */}
      <Card
        title={tt('أفضل أوقات النشر — أحدث لقطة', 'Best posting windows — latest snapshot')}
        style={{ marginBlockStart: 16 }}
      >
        {postsLoading ? (
          <LoadingBlock rows={2} />
        ) : postsError ? (
          <ErrorState
            error={postsError.message}
            hint={postsError.hint}
            onRetry={() => loadPosts(snapshotId)}
          />
        ) : population === null ||
          population.posts.length === 0 ||
          timing === null ||
          hourly === null ? (
          <EmptyState
            title={tt('لا منشورات مخزّنة', 'No posts stored')}
            description={tt(
              'يُحسب التوقيت من وقت النشر مضروباً في التفاعل: اليوم كلّه ساعةً ساعة، وأيّ ساعة تستحق النشر فيها فعلاً.',
              'Timing is computed from publish time against engagement: the whole day, hour by hour, and which hours are actually worth posting in.',
            )}
            actionLabel={tt('ارفع تصدير Apify', 'Ingest an Apify export')}
            href="/data"
          />
        ) : timing.total_n === 0 ? (
          <div>
            <span className="tq-num" style={{ fontSize: 22 }}>
              —
            </span>
            <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 4 }}>
              {tt(
                'لا يحمل أي منشور مخزّن وقت نشر، والتوقيت يُحسب من وقت النشر × التفاعل.',
                'No stored post carries a publish time, and timing is computed from posted_at × engagement.',
              )}
            </div>
            <Link href="/data">
              {tt(
                'ارفع تصديراً يتضمن وقت النشر أو شغّل مسحاً جديداً',
                'Ingest an export that carries posted_at, or run a fresh scrape',
              )}
            </Link>
          </div>
        ) : (
          <>
            {/* `.tq-num` carries `direction: ltr; unicode-bidi: isolate`, so the
                strip and its axis stay LTR — 00 on the start edge, 23 on the
                end edge — whichever way the page reads. */}
            <div
              className="tq-num"
              style={{ display: 'flex', gap: 2, alignItems: 'stretch', marginBlockEnd: 4 }}
            >
              {hourly.map((bucket) => {
                const hourText = `${pad2(bucket.hour)}:00`;
                const avgText =
                  bucket.avg === null ? '—' : formatNumber(Math.round(bucket.avg));
                const minText = formatNumber(timing.min_window_n);
                // A ranked hour clears the report's own minimum. peakHourAvg is
                // 0 only when no hour is ranked at all, or when every ranked
                // hour averages 0 — in both cases there is no ramp to place the
                // bar on, so it sits at the floor rather than inventing a top.
                const fill =
                  bucket.reportable && bucket.avg !== null
                    ? `rgba(${GOLD_RGB}, ${(
                        0.15 + 0.85 * (peakHourAvg > 0 ? bucket.avg / peakHourAvg : 0)
                      ).toFixed(3)})`
                    : null;
                const ariaLabel =
                  bucket.n === 0
                    ? tt(`${hourText} — لا منشورات`, `${hourText} — no posts`)
                    : fill !== null
                      ? tt(
                          `${hourText} — ${formatNumber(bucket.n)} منشوراً، متوسط التفاعل ${avgText}`,
                          `${hourText} — ${formatNumber(bucket.n)} post(s), average engagement ${avgText}`,
                        )
                      : tt(
                          `${hourText} — ${formatNumber(bucket.n)} منشوراً فقط، دون الحد الأدنى ${minText}، فلا تُرتَّب. متوسطها ${avgText}`,
                          `${hourText} — only ${formatNumber(bucket.n)} post(s), below the minimum of ${minText}, so it is not ranked. Its average is ${avgText}`,
                        );

                return (
                  <Tooltip
                    key={bucket.hour}
                    title={
                      <span>
                        <span className="tq-num">{hourText}</span>
                        {' · '}
                        {bucket.n === 0 ? (
                          tt('لا منشورات', 'no posts')
                        ) : (
                          <>
                            {'n = '}
                            <span className="tq-num">{formatNumber(bucket.n)}</span>
                            {' · '}
                            {tt('متوسط', 'avg')} <span className="tq-num">{avgText}</span>
                            {fill === null ? (
                              <>
                                {' · '}
                                {tt('دون الحد الأدنى ', 'below the minimum ')}
                                <span className="tq-num">{minText}</span>
                                {tt('، فلا تُرتَّب', ', so it is not ranked')}
                              </>
                            ) : null}
                          </>
                        )}
                      </span>
                    }
                  >
                    <div
                      role="img"
                      aria-label={ariaLabel}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        height: 32,
                        borderRadius: 2,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        ...(bucket.n === 0
                          ? NO_POSTS_STYLE
                          : fill === null
                            ? BELOW_MIN_STYLE
                            : { background: fill, border: RANKED_BAR_BORDER }),
                      }}
                    >
                      {bucket.n > 0 && fill === null ? (
                        <span aria-hidden="true" style={BELOW_MIN_DOT} />
                      ) : null}
                    </div>
                  </Tooltip>
                );
              })}
            </div>

            <div
              className="tq-num tq-muted"
              style={{ display: 'flex', gap: 2, fontSize: 10, marginBlockEnd: 8 }}
            >
              {hourly.map((bucket) => (
                <div key={bucket.hour} style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
                  {bucket.hour % HOUR_LABEL_EVERY === 0 ? pad2(bucket.hour) : ''}
                </div>
              ))}
            </div>

            {/* The minimum is stated here, on the surface, not only in a
                tooltip: the rule that governs the picture has to be readable
                without hovering 24 bars. */}
            <Space wrap size={16} align="center" style={{ marginBlockEnd: 12 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span
                  aria-hidden="true"
                  style={{ width: 18, height: 18, borderRadius: 2, ...NO_POSTS_STYLE }}
                />
                <span className="tq-muted" style={{ fontSize: 12 }}>
                  {tt('لا منشورات في هذه الساعة', 'No posts in this hour')}
                </span>
              </span>

              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 2,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    ...BELOW_MIN_STYLE,
                  }}
                >
                  <span style={BELOW_MIN_DOT} />
                </span>
                <span className="tq-muted" style={{ fontSize: 12 }}>
                  {tt('دون ', 'Fewer than ')}
                  <span className="tq-num">{formatNumber(timing.min_window_n)}</span>
                  {tt(' منشورات — تُقاس ولا تُرتَّب', ' posts — measured, not ranked')}
                </span>
              </span>

              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {/* The ramp is a numeric scale like the hour axis, so it is
                    LTR-isolated too: the gradient is painted left-to-right and
                    a flipped row would put the peak label at the pale end. */}
                <span
                  dir="ltr"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <span className="tq-num" style={{ fontSize: 12 }}>
                    {peakHourAvg > 0 ? formatNumber(0) : '—'}
                  </span>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 96,
                      height: 12,
                      borderRadius: 2,
                      border: RANKED_BAR_BORDER,
                      background: `linear-gradient(to right, rgba(${GOLD_RGB}, 0.15), rgba(${GOLD_RGB}, 1))`,
                    }}
                  />
                  <span className="tq-num" style={{ fontSize: 12 }}>
                    {peakHourAvg > 0 ? formatNumber(Math.round(peakHourAvg)) : '—'}
                  </span>
                </span>
                <span className="tq-muted" style={{ fontSize: 12 }}>
                  {tt('متوسط التفاعل للساعة', 'Average engagement per hour')}
                </span>
              </span>
            </Space>

            {timing.best_windows.length === 0 ? (
              <div className="tq-muted" style={{ fontSize: 13 }}>
                {tt('لم تتجاوز أي نافذة المتوسط العام مع بلوغ الحد الأدنى n = ', 'No window beats the overall average while clearing the minimum n = ')}
                <span className="tq-num">{formatNumber(timing.min_window_n)}</span>
                {'.'}
              </div>
            ) : (
              <div>
                {timing.best_windows.map((window) => (
                  <div key={window.label} style={{ marginBlockEnd: 6 }}>
                    <span className="tq-num">{window.label}</span>
                    {' · '}
                    <span className="tq-num">{`×${window.multiple_vs_overall.toFixed(1)}`}</span>{' '}
                    <span className="tq-muted">{tt('مقابل المتوسط العام', 'vs overall average')}</span>
                    {' · '}
                    <span className="tq-muted">{'n = '}</span>
                    <span className="tq-num">{formatNumber(window.n)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 8 }}>
              {tt('محسوبة من', 'Computed from')}{' '}
              <span className="tq-num">{formatNumber(timedPosts)}</span>{' '}
              {tt('منشوراً يحمل وقت نشر، من أصل', 'posts carrying a publish time, out of')}{' '}
              <span className="tq-num">{formatNumber(measuredPosts)}</span>
              {untimedPosts > 0 ? (
                <>
                  {tt('؛ ', '; ')}
                  <span className="tq-num">{formatNumber(untimedPosts)}</span>{' '}
                  {tt('بلا وقت نشر ولم تُحتسب.', 'carry none and were left out.')}
                </>
              ) : (
                '.'
              )}
            </div>

            {/* Exactly what this card covers, so a different figure elsewhere
                reads as a different population rather than a contradiction. */}
            <div className="tq-muted" style={{ fontSize: 12, marginBlockStart: 4 }}>
              {tt('من منشورات لقطة', 'From the posts in the')}{' '}
              <span className="tq-num">
                {snapshot === null ? '—' : formatDate(snapshot.taken_on, locale)}
              </span>{' '}
              {tt(
                'وحدها — ولقطة أخرى تعطي أرقاماً أخرى دون أن يكون أحدهما خطأً.',
                'snapshot alone — another snapshot gives other figures, and neither is wrong.',
              )}
            </div>
          </>
        )}
      </Card>

      {/* ------------------- change vs previous snapshot ------------------- */}
      <Card
        title={tt('الفرق عن اللقطة السابقة', 'Change vs previous snapshot')}
        style={{ marginBlockStart: 16 }}
      >
        {diff === null ? (
          <EmptyState
            title={tt('لقطة واحدة فقط حتى الآن', 'Only one snapshot so far')}
            description={tt(
              'الحركة تحتاج قياسين. مع اللقطة الثانية يظهر هنا ما جدّ من منشورات وكيف تحرّك متوسط التفاعل في كل حساب.',
              'Movement needs two readings. Once a second snapshot exists, this shows what was published in between and how the average for each account moved.',
            )}
            actionLabel={tt('ارفع تصديراً جديداً', 'Ingest a newer export')}
            href="/data"
          />
        ) : (
          <>
            <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
              <Descriptions.Item label={tt('اللقطة السابقة', 'Previous snapshot')}>
                <span className="tq-num">{formatDate(diff.previous_taken_on, locale)}</span>
              </Descriptions.Item>
              <Descriptions.Item label={tt('منشورات جديدة', 'New posts')}>
                <span className="tq-num">{diff.new_post_count}</span>
              </Descriptions.Item>
              <Descriptions.Item label={tt('فرق متوسط التفاعل — الشخصي', 'Avg engagement delta — personal')}>
                <span className="tq-num">{formatSignedNumber(diff.avg_engagement.personal)}</span>
              </Descriptions.Item>
              <Descriptions.Item label={tt('فرق متوسط التفاعل — الأكاديمية', 'Avg engagement delta — academy')}>
                <span className="tq-num">{formatSignedNumber(diff.avg_engagement.academy)}</span>
              </Descriptions.Item>
            </Descriptions>
            {/* Follower movement is measured in profile_snapshots, not here — one
                question, one answer. */}
            <div className="tq-muted" style={{ fontSize: 12 }}>
              {tt(
                'حركة المتابعين تُقاس من لقطات البروفايل أعلاه.',
                'Follower movement is measured from the profile snapshots above.',
              )}
            </div>
          </>
        )}
      </Card>

      <Card title={tt('أعلى ٥ منشورات', 'Top 5 posts')} style={{ marginBlockStart: 16 }}>
        {top_posts.length === 0 ? (
          <EmptyState
            title={tt('لا منشورات بعد', 'No posts yet')}
            description={tt(
              'أعلى المنشورات تفاعلاً، ومعها الإعجابات والتعليقات ومقتطف النص ورابط المنشور نفسه.',
              'The posts that pulled the most engagement, with their likes, comments, a slice of the caption, and a link to the post itself.',
            )}
            actionLabel={tt('ارفع تصدير Apify', 'Ingest an Apify export')}
            href="/data"
          />
        ) : (
          <Table<PostRow>
            size="small"
            rowKey="id"
            pagination={false}
            columns={columns}
            dataSource={top_posts}
            scroll={{ x: true }}
          />
        )}
      </Card>

      <Card title={tt('حالة الأفكار', 'Concept status')} style={{ marginBlockStart: 16 }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={6}>
            <Statistic title={tt('مسودة', 'Draft')} value={concept_counts.draft} className="tq-num" />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic
              title={tt('معتمدة', 'Approved')}
              value={concept_counts.approved}
              className="tq-num"
            />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic
              title={tt('منشورة', 'Shipped')}
              value={concept_counts.shipped}
              className="tq-num"
            />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic
              title={tt('مرفوضة', 'Rejected')}
              value={concept_counts.rejected}
              className="tq-num"
            />
          </Col>
        </Row>
        <div style={{ marginBlockStart: 12 }}>
          <Link href="/concepts">{tt('عرض كل الأفكار', 'View all concepts')}</Link>
        </div>
      </Card>
    </div>
  );
}
