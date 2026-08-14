'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Popconfirm,
  Segmented,
  Skeleton,
  Table,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadFile } from 'antd/es/upload/interface';
import dayjs, { type Dayjs } from 'dayjs';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiUpload, apiSend, describeError } from '@/lib/client/api';
import { PageHeader, EmptyState, ErrorState, LoadingBlock, ArabicText } from '@/components/ui';
import { formatDate, formatDateTime, formatSignedNumber, toIsoDate } from '@/lib/date';
import type { Account, PillarRow, PostRow, SnapshotDiff, SnapshotRow } from '@/lib/types/db';

interface SnapshotsResponse {
  snapshots: SnapshotRow[];
  pillars: PillarRow[];
}

interface PostsResponse {
  posts: PostRow[];
}

interface IngestCounts {
  posts: number;
  personal: number;
  academy: number;
  new_since_previous: number;
  duplicates_skipped: number;
  unroutable_skipped: number;
}

interface IngestResponse {
  snapshot: SnapshotRow;
  counts: IngestCounts;
  files: string[];
}

interface RefreshResponse {
  snapshot: { id: string; taken_on: string };
  previous: { id: string; taken_on: string } | null;
  diff: SnapshotDiff | null;
  facts_updated: number;
  pillars_written: number;
  pillar_warnings: string[];
  shipped: { backfilled: number; unmatched: string[] };
}

const ACCOUNTS: Account[] = ['personal', 'academy'];

export default function DataPage() {
  const { t, tt, isRTL } = useLocale();
  const { message, notification } = App.useApp();

  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [pillars, setPillars] = useState<PillarRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [takenOn, setTakenOn] = useState<Dayjs>(dayjs());
  const [ingesting, setIngesting] = useState<boolean>(false);
  const draggerRef = useRef<HTMLDivElement | null>(null);

  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [refreshResult, setRefreshResult] = useState<RefreshResponse | null>(null);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

  const [postsCache, setPostsCache] = useState<Record<string, PostRow[]>>({});
  const [postsLoading, setPostsLoading] = useState<Record<string, boolean>>({});
  const [segmentByRow, setSegmentByRow] = useState<Record<string, Account | 'all'>>({});

  const loadSnapshots = () => {
    setLoading(true);
    setError(null);
    apiGet<SnapshotsResponse>('/api/snapshots')
      .then((res) => {
        setSnapshots(res.snapshots);
        setPillars(res.pillars);
      })
      .catch((err: unknown) => setError(describeError(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleIngest = () => {
    if (fileList.length === 0) return;
    const form = new FormData();
    for (const file of fileList) {
      if (file.originFileObj) {
        form.append('files', file.originFileObj);
      }
    }
    form.append('taken_on', toIsoDate(takenOn));
    setIngesting(true);
    apiUpload<IngestResponse>('/api/ingest', form)
      .then((res) => {
        notification.success({
          message: tt('تم رفع اللقطة', 'Snapshot ingested'),
          description: tt(
            `منشورات: ${res.counts.posts} · شخصي: ${res.counts.personal} · أكاديمية: ${res.counts.academy} · جديدة منذ السابقة: ${res.counts.new_since_previous} · تكرارات محذوفة: ${res.counts.duplicates_skipped} · غير موجهة: ${res.counts.unroutable_skipped}`,
            `Posts: ${res.counts.posts} · Personal: ${res.counts.personal} · Academy: ${res.counts.academy} · New since previous: ${res.counts.new_since_previous} · Duplicates skipped: ${res.counts.duplicates_skipped} · Unroutable skipped: ${res.counts.unroutable_skipped}`,
          ),
        });
        setFileList([]);
        loadSnapshots();
      })
      .catch((err: unknown) => {
        const desc = describeError(err);
        notification.error({
          message: desc.message,
          description: desc.hint ?? undefined,
        });
      })
      .finally(() => setIngesting(false));
  };

  const handleRefresh = () => {
    setRefreshing(true);
    apiSend<RefreshResponse>('/api/refresh', 'POST')
      .then((res) => {
        setRefreshResult(res);
        setDrawerOpen(true);
        loadSnapshots();
      })
      .catch((err: unknown) => {
        const desc = describeError(err);
        notification.error({
          message: desc.message,
          description: desc.hint ?? undefined,
        });
      })
      .finally(() => setRefreshing(false));
  };

  const loadPostsFor = (snapshotId: string) => {
    if (postsCache[snapshotId] || postsLoading[snapshotId]) return;
    setPostsLoading((prev) => ({ ...prev, [snapshotId]: true }));
    apiGet<PostsResponse>(`/api/snapshots/${snapshotId}/posts`)
      .then((res) => {
        setPostsCache((prev) => ({ ...prev, [snapshotId]: res.posts }));
      })
      .catch((err: unknown) => {
        const desc = describeError(err);
        message.error(desc.message);
      })
      .finally(() => {
        setPostsLoading((prev) => ({ ...prev, [snapshotId]: false }));
      });
  };

  const scrollToDragger = () => {
    draggerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const columns: ColumnsType<SnapshotRow> = [
    {
      title: tt('التاريخ', 'Taken on'),
      dataIndex: 'taken_on',
      key: 'taken_on',
      render: (value: string) => formatDate(value, isRTL ? 'ar' : 'en'),
    },
    {
      title: tt('إجمالي المنشورات', 'Total posts'),
      key: 'post_count_total',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.post_count.personal + row.stats.post_count.academy}</span>
      ),
    },
    {
      title: tt('متوسط التفاعل (شخصي)', 'Avg engagement (personal)'),
      key: 'avg_engagement_personal',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.avg_engagement.personal ?? '—'}</span>
      ),
    },
    {
      title: tt('متوسط التفاعل (أكاديمية)', 'Avg engagement (academy)'),
      key: 'avg_engagement_academy',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.avg_engagement.academy ?? '—'}</span>
      ),
    },
    {
      title: tt('المتابعون (شخصي)', 'Followers (personal)'),
      key: 'followers_personal',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.followers.personal ?? '—'}</span>
      ),
    },
    {
      title: tt('المتابعون (أكاديمية)', 'Followers (academy)'),
      key: 'followers_academy',
      render: (_: unknown, row: SnapshotRow) => (
        <span className="tq-num">{row.stats.followers.academy ?? '—'}</span>
      ),
    },
    {
      title: tt('أفضل تنسيق (شخصي)', 'Top format (personal)'),
      key: 'top_format_personal',
      render: (_: unknown, row: SnapshotRow) => row.stats.top_format.personal ?? '—',
    },
    {
      title: tt('أفضل تنسيق (أكاديمية)', 'Top format (academy)'),
      key: 'top_format_academy',
      render: (_: unknown, row: SnapshotRow) => row.stats.top_format.academy ?? '—',
    },
    {
      title: tt('تاريخ الإنشاء', 'Created at'),
      dataIndex: 'created_at',
      key: 'created_at',
      render: (value: string) => formatDateTime(value, isRTL ? 'ar' : 'en'),
    },
  ];

  const renderExpandedRow = (row: SnapshotRow) => {
    const posts = postsCache[row.id];
    const isLoading = postsLoading[row.id];
    if (isLoading || !posts) {
      return <Skeleton active paragraph={{ rows: 3 }} />;
    }

    const segment = segmentByRow[row.id] ?? 'all';
    const filteredPosts = segment === 'all' ? posts : posts.filter((p) => p.account === segment);

    const mediaTypes = Array.from(
      new Set(posts.map((p) => p.media_type).filter((v): v is string => v !== null)),
    );

    const innerColumns: ColumnsType<PostRow> = [
      {
        title: tt('الترتيب', 'Rank'),
        dataIndex: 'rank',
        key: 'rank',
        render: (value: number | null) => <span className="tq-num">{value ?? '—'}</span>,
      },
      {
        title: t.common.account,
        dataIndex: 'account',
        key: 'account',
        render: (value: Account) => (value === 'personal' ? t.common.personal : t.common.academy),
      },
      {
        title: tt('نوع الوسائط', 'Media type'),
        dataIndex: 'media_type',
        key: 'media_type',
        filters: mediaTypes.map((mt) => ({ text: mt, value: mt })),
        onFilter: (value, record) => record.media_type === value,
        render: (value: string | null) => value ?? '—',
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
        title: tt('التفاعل', 'Engagement'),
        dataIndex: 'engagement',
        key: 'engagement',
        render: (value: number) => <span className="tq-num">{value}</span>,
      },
      {
        title: tt('تاريخ النشر', 'Posted at'),
        dataIndex: 'posted_at',
        key: 'posted_at',
        render: (value: string | null) => formatDate(value, isRTL ? 'ar' : 'en'),
      },
      {
        title: tt('مقتطف التعليق', 'Caption excerpt'),
        dataIndex: 'caption',
        key: 'caption',
        render: (value: string | null) =>
          value ? (
            <span dir="auto" className="tq-ar">
              {value.length > 80 ? `${value.slice(0, 80)}…` : value}
            </span>
          ) : (
            '—'
          ),
      },
      {
        title: '',
        key: 'open',
        render: (_: unknown, record: PostRow) =>
          record.url ? (
            <a href={record.url} target="_blank" rel="noreferrer">
              {tt('فتح', 'Open')}
            </a>
          ) : null,
      },
    ];

    return (
      <div>
        <Segmented
          style={{ marginBlockEnd: 12 }}
          value={segment}
          onChange={(value) =>
            setSegmentByRow((prev) => ({ ...prev, [row.id]: value as Account | 'all' }))
          }
          options={[
            { label: tt('الكل', 'All'), value: 'all' },
            { label: t.common.personal, value: 'personal' },
            { label: t.common.academy, value: 'academy' },
          ]}
        />
        <Table<PostRow>
          size="small"
          rowKey="id"
          columns={innerColumns}
          dataSource={filteredPosts}
          pagination={false}
          scroll={{ x: true }}
        />
      </div>
    );
  };

  const refreshButton = (
    <Popconfirm
      title={tt('تشغيل التحديث؟', 'Run refresh?')}
      description={tt(
        'سيعيد حساب الفروق، ويحدّث حقائق العلامة، ويعيد توليد المحاور، ويكمل تفاعل الأفكار المنشورة.',
        'Recomputes the diff, updates brand facts, regenerates pillars, and backfills engagement on shipped concepts.',
      )}
      onConfirm={handleRefresh}
      okText={t.common.save}
      cancelText={t.common.cancel}
    >
      <Button type="primary" loading={refreshing}>
        {tt('تشغيل التحديث', 'Run Refresh')}
      </Button>
    </Popconfirm>
  );

  if (loading) {
    return (
      <div className="tq-page">
        <PageHeader title={t.nav.data} extra={refreshButton} />
        <LoadingBlock />
      </div>
    );
  }

  if (error) {
    return (
      <div className="tq-page">
        <PageHeader title={t.nav.data} extra={refreshButton} />
        <ErrorState error={error.message} hint={error.hint} onRetry={loadSnapshots} />
      </div>
    );
  }

  return (
    <div className="tq-page">
      <PageHeader
        title={t.nav.data}
        subtitle={tt(
          'ارفع تصدير Apify، ثم شغّل التحديث ليعيد الوكيل بناء المحاور.',
          'Upload an Apify export, then run Refresh so the agent rebuilds the pillars.',
        )}
        extra={refreshButton}
      />

      <Card title={tt('رفع تصدير', 'Upload export')} style={{ marginBlockEnd: 16 }}>
        <div ref={draggerRef}>
        <Upload.Dragger
          multiple
          accept=".json,application/json"
          beforeUpload={() => false}
          fileList={fileList}
          onChange={(info) => setFileList(info.fileList)}
        >
          <p>{tt('اسحب ملفات JSON هنا أو انقر للاختيار', 'Drag JSON files here or click to select')}</p>
        </Upload.Dragger>
        <Typography.Text type="secondary" style={{ display: 'block', marginBlockStart: 8 }}>
          {tt(
            'يقبل ملفات JSON من Apify Instagram scraper. تُدمج الملفات، وتُزال التكرارات حسب معرّف المنشور، ويُوجَّه كل منشور إلى حسابه حسب اسم المستخدم.',
            'Accepts Apify Instagram-scraper JSON. Files are merged, duplicates dropped by post id, and each post routed to its account by owner username.',
          )}
        </Typography.Text>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBlockStart: 16 }}>
          <DatePicker value={takenOn} onChange={(value) => setTakenOn(value ?? dayjs())} allowClear={false} />
          <Button type="primary" disabled={fileList.length === 0} loading={ingesting} onClick={handleIngest}>
            {tt('استيراد', 'Ingest')}
          </Button>
        </div>
        </div>
      </Card>

      {snapshots.length === 0 ? (
        <EmptyState
          description={tt('لا توجد لقطات بعد.', 'No snapshots yet.')}
          actionLabel={tt('ارفع أول تصدير', 'Upload the first export')}
          onAction={scrollToDragger}
        />
      ) : (
        <Table<SnapshotRow>
          rowKey="id"
          size="small"
          scroll={{ x: true }}
          columns={columns}
          dataSource={snapshots}
          style={{ marginBlockEnd: 16 }}
          expandable={{
            onExpand: (expanded, row) => {
              if (expanded) loadPostsFor(row.id);
            },
            expandedRowRender: renderExpandedRow,
          }}
        />
      )}

      <Card title={tt('المحاور الحالية', 'Current pillars')}>
        {pillars.length === 0 ? (
          <EmptyState
            description={tt('لم تُولَّد المحاور بعد.', 'Pillars have not been generated yet.')}
            actionLabel={tt('شغّل التحديث', 'Run Refresh')}
            onAction={handleRefresh}
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            scroll={{ x: true }}
            dataSource={pillars}
            columns={[
              {
                title: tt('الاسم (عربي)', 'Name (Arabic)'),
                dataIndex: 'name_ar',
                key: 'name_ar',
                render: (value: string) => <ArabicText>{value}</ArabicText>,
              },
              {
                title: tt('الاسم (إنجليزي)', 'Name (English)'),
                dataIndex: 'name_en',
                key: 'name_en',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: tt('عدد المنشورات', 'Post count'),
                dataIndex: 'post_count',
                key: 'post_count',
                render: (value: number) => <span className="tq-num">{value}</span>,
              },
              {
                title: tt('متوسط التفاعل', 'Avg engagement'),
                dataIndex: 'avg_engagement',
                key: 'avg_engagement',
                render: (value: number) => <span className="tq-num">{value}</span>,
              },
              {
                title: tt('نمط الافتتاحية', 'Hook pattern'),
                dataIndex: 'hook_pattern',
                key: 'hook_pattern',
                render: (value: string | null) =>
                  value ? (
                    <span dir="auto" className="tq-ar">
                      {value}
                    </span>
                  ) : (
                    '—'
                  ),
              },
            ] as ColumnsType<PillarRow>}
          />
        )}
      </Card>

      <Drawer
        title={tt('نتيجة التحديث', 'Refresh result')}
        placement={isRTL ? 'left' : 'right'}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
      >
        {refreshResult ? (
          <>
            <Descriptions size="small" column={1} style={{ marginBlockEnd: 16 }}>
              <Descriptions.Item label={tt('تاريخ اللقطة', 'Snapshot taken on')}>
                {formatDate(refreshResult.snapshot.taken_on, isRTL ? 'ar' : 'en')}
              </Descriptions.Item>
              <Descriptions.Item label={tt('اللقطة السابقة', 'Previous snapshot')}>
                {refreshResult.previous
                  ? formatDate(refreshResult.previous.taken_on, isRTL ? 'ar' : 'en')
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={tt('حقائق محدّثة', 'Facts updated')}>
                <span className="tq-num">{refreshResult.facts_updated}</span>
              </Descriptions.Item>
              <Descriptions.Item label={tt('محاور مكتوبة', 'Pillars written')}>
                <span className="tq-num">{refreshResult.pillars_written}</span>
              </Descriptions.Item>
              <Descriptions.Item label={tt('أفكار مكتملة التفاعل', 'Concepts backfilled')}>
                <span className="tq-num">{refreshResult.shipped.backfilled}</span>
              </Descriptions.Item>
            </Descriptions>

            {/* Bound to a local so the null check narrows inside the map callback. */}
            {((diff) =>
              diff ? (
                <div style={{ marginBlockEnd: 16 }}>
                  {ACCOUNTS.map((account) => (
                    <div key={account} style={{ marginBlockEnd: 12 }}>
                      <Typography.Text strong>
                        {account === 'personal' ? t.common.personal : t.common.academy}
                      </Typography.Text>
                      <div>
                        {tt('المتابعون', 'Followers')}:{' '}
                        <span className="tq-num">
                          {formatSignedNumber(diff.followers[account])}
                        </span>
                      </div>
                      <div>
                        {tt('متوسط التفاعل', 'Avg engagement')}:{' '}
                        <span className="tq-num">
                          {formatSignedNumber(diff.avg_engagement[account])}
                        </span>
                      </div>
                      <div>
                        {tt('عدد المنشورات', 'Post count')}:{' '}
                        <span className="tq-num">{diff.post_count[account]}</span>
                      </div>
                    </div>
                  ))}
                  <div>
                    {tt('منشورات جديدة', 'New posts')}:{' '}
                    <span className="tq-num">{diff.new_post_count}</span>
                  </div>
                </div>
              ) : (
                <Typography.Text type="secondary">
                  {tt('لا توجد لقطة سابقة للمقارنة.', 'No previous snapshot to compare against.')}
                </Typography.Text>
              ))(refreshResult.diff)}

            {refreshResult.pillar_warnings.length > 0 ? (
              <Alert
                type="warning"
                style={{ marginBlockEnd: 16 }}
                message={tt('تحذيرات المحاور', 'Pillar warnings')}
                description={
                  <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                    {refreshResult.pillar_warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                }
              />
            ) : null}

            {refreshResult.shipped.unmatched.length > 0 ? (
              <div>
                <Typography.Text strong>
                  {tt('أفكار غير مطابقة', 'Unmatched concepts')}
                </Typography.Text>
                <ul style={{ marginBlockStart: 8, paddingInlineStart: 18 }}>
                  {refreshResult.shipped.unmatched.map((title, i) => (
                    <li key={i}>{title}</li>
                  ))}
                </ul>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {tt(
                    'لم يُعثر على منشور مطابق لهذه الأفكار — تأكد من صحة رابط إنستغرام.',
                    'No matching post was found for these concepts — check their Instagram URL.',
                  )}
                </Typography.Text>
              </div>
            ) : null}
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
