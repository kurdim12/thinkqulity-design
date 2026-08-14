'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Col, Descriptions, Row, Statistic, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, describeError } from '@/lib/client/api';
import { PageHeader, SeedAlert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui';
import { formatDate, formatSignedNumber } from '@/lib/date';
import type { BrandRow, SnapshotRow, PostRow } from '@/lib/types/db';

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

export default function DashboardPage() {
  const { t, tt, locale } = useLocale();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

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
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
  const daysWarning = days_since_snapshot !== null && days_since_snapshot > 45;

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

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={tt('المتابعون — الحساب الشخصي', 'Followers — personal')}
              value={stats?.followers.personal ?? '—'}
              valueStyle={{ direction: 'ltr' }}
              className="tq-num"
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={tt('المتابعون — الأكاديمية', 'Followers — academy')}
              value={stats?.followers.academy ?? '—'}
              valueStyle={{ direction: 'ltr' }}
              className="tq-num"
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <div className="tq-muted" style={{ marginBlockEnd: 4 }}>
              {tt('متوسط التفاعل', 'Average engagement')}
            </div>
            <div>
              {t.common.academy}:{' '}
              <span className="tq-num">{stats?.avg_engagement.academy ?? '—'}</span>
            </div>
            <div>
              {t.common.personal}:{' '}
              <span className="tq-num">{stats?.avg_engagement.personal ?? '—'}</span>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={tt('أيام منذ آخر لقطة', 'Days since last snapshot')}
              value={days_since_snapshot ?? '—'}
              valueStyle={{ direction: 'ltr', color: daysWarning ? '#cf1322' : undefined }}
              className="tq-num"
            />
            {daysWarning ? (
              <div className="tq-muted" style={{ marginBlockStart: 4, fontSize: 12 }}>
                {tt(
                  'التقرير الشهري يرفض بيانات أقدم من ٤٥ يومًا',
                  'Monthly reports refuse data older than 45 days',
                )}
              </div>
            ) : null}
          </Card>
        </Col>
      </Row>

      <Card
        title={tt('الفرق عن اللقطة السابقة', 'Change vs previous snapshot')}
        style={{ marginBlockStart: 16 }}
      >
        {diff === null ? (
          <EmptyState
            description={tt('لا توجد لقطة سابقة للمقارنة.', 'No previous snapshot to compare against.')}
            actionLabel={tt('رفع تصدير', 'Upload an export')}
            href="/data"
          />
        ) : (
          <Descriptions size="small" column={{ xs: 1, sm: 2 }}>
            <Descriptions.Item label={tt('اللقطة السابقة', 'Previous snapshot')}>
              <span className="tq-num">{formatDate(diff.previous_taken_on, locale)}</span>
            </Descriptions.Item>
            <Descriptions.Item label={tt('منشورات جديدة', 'New posts')}>
              <span className="tq-num">{diff.new_post_count}</span>
            </Descriptions.Item>
            <Descriptions.Item label={tt('فرق المتابعين — الشخصي', 'Followers delta — personal')}>
              <span className="tq-num">{formatSignedNumber(diff.followers.personal)}</span>
            </Descriptions.Item>
            <Descriptions.Item label={tt('فرق المتابعين — الأكاديمية', 'Followers delta — academy')}>
              <span className="tq-num">{formatSignedNumber(diff.followers.academy)}</span>
            </Descriptions.Item>
            <Descriptions.Item label={tt('فرق متوسط التفاعل — الشخصي', 'Avg engagement delta — personal')}>
              <span className="tq-num">{formatSignedNumber(diff.avg_engagement.personal)}</span>
            </Descriptions.Item>
            <Descriptions.Item label={tt('فرق متوسط التفاعل — الأكاديمية', 'Avg engagement delta — academy')}>
              <span className="tq-num">{formatSignedNumber(diff.avg_engagement.academy)}</span>
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      <Card title={tt('أعلى ٥ منشورات', 'Top 5 posts')} style={{ marginBlockStart: 16 }}>
        {top_posts.length === 0 ? (
          <EmptyState
            description={tt('لم يتم رفع أي تصدير بعد.', 'No export has been ingested yet.')}
            actionLabel={tt('رفع تصدير Apify', 'Upload an Apify export')}
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
