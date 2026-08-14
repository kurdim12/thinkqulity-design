'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Row,
  Col,
  Card,
  Space,
  Select,
  Segmented,
  Button,
  Tag,
  Descriptions,
  Typography,
  Progress,
  Modal,
  App,
} from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import {
  PageHeader,
  EmptyState,
  ErrorState,
  LoadingBlock,
  ArabicText,
  GroundingTag,
} from '@/components/ui';
import { formatDate, formatNumber } from '@/lib/date';
import type { Grounding } from '@/lib/types/db';

type BoardAccount = 'personal' | 'academy';
type PercentileBand = 'top10' | 'top25' | 'median' | 'bottom25';

interface BoardComputed {
  vs_account_avg: number;
  vs_format_avg: number;
  percentile: number;
  days_old: number | null;
}

interface BoardAnalysis {
  computed: BoardComputed;
  cluster_label: string | null;
  explanation: string | null;
  grounding: Grounding;
  model: string | null;
  created_at: string;
}

interface BoardPost {
  id: string;
  account: BoardAccount;
  ig_id: string;
  url: string | null;
  caption: string | null;
  media_type: string | null;
  likes: number | null;
  comments: number | null;
  engagement: number;
  posted_at: string | null;
  rank: number | null;
  analysis: BoardAnalysis | null;
}

interface BoardTotals {
  posts: number;
  analyzed: number;
  account_avg: { personal: number | null; academy: number | null };
}

interface BoardResponse {
  posts: BoardPost[];
  totals: BoardTotals;
}

interface AnalyzeProgressResponse {
  total: number;
  analyzed: number;
  remaining: number;
  estimate_usd: number | null;
}

interface AnalyzeRunResponse {
  analyzed: number;
  remaining: number;
  failed: number;
}

type AccountFilter = 'all' | BoardAccount;
type BandFilter = 'all' | PercentileBand;

function vsAccountColor(value: number): string {
  if (value > 1.5) return 'green';
  if (value < 0.75) return 'red';
  return 'default';
}

export default function BoardPage() {
  const { tt, isRTL } = useLocale();
  const { notification } = App.useApp();

  const [posts, setPosts] = useState<BoardPost[]>([]);
  const [totals, setTotals] = useState<BoardTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [accountFilter, setAccountFilter] = useState<AccountFilter>('all');
  const [formatFilter, setFormatFilter] = useState<string>('all');
  const [bandFilter, setBandFilter] = useState<BandFilter>('all');

  const [progress, setProgress] = useState<AnalyzeProgressResponse | null>(null);
  const [progressLoading, setProgressLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzePercent, setAnalyzePercent] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (accountFilter !== 'all') params.set('account', accountFilter);
      if (formatFilter !== 'all') params.set('format', formatFilter);
      if (bandFilter !== 'all') params.set('band', bandFilter);
      const qs = params.toString();
      const data = await apiGet<BoardResponse>(`/api/board${qs ? `?${qs}` : ''}`);
      setPosts(data.posts);
      setTotals(data.totals);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [accountFilter, formatFilter, bandFilter]);

  const loadProgress = useCallback(async () => {
    setProgressLoading(true);
    try {
      const data = await apiGet<AnalyzeProgressResponse>('/api/board/analyze');
      setProgress(data);
    } catch (err) {
      notification.error({
        message: describeError(err).message,
        description: describeError(err).hint ?? undefined,
      });
    } finally {
      setProgressLoading(false);
    }
  }, [notification]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatOptions = useMemo(() => {
    const set = new Set<string>();
    posts.forEach((p) => {
      if (p.media_type) set.add(p.media_type);
    });
    return [
      { label: tt('الكل', 'All'), value: 'all' },
      ...Array.from(set).map((f) => ({ label: f, value: f })),
    ];
  }, [posts, tt]);

  const runAnalyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      let remaining = progress?.remaining ?? 0;
      const total = progress?.total ?? 0;
      const startAnalyzed = progress?.analyzed ?? 0;
      let currentAnalyzed = startAnalyzed;
      while (remaining > 0) {
        const res = await apiSend<AnalyzeRunResponse>('/api/board/analyze', 'POST', { limit: 25 });
        currentAnalyzed += res.analyzed;
        remaining = res.remaining;
        if (total > 0) {
          setAnalyzePercent(Math.min(100, Math.round((currentAnalyzed / total) * 100)));
        }
        setProgress((prev) =>
          prev ? { ...prev, analyzed: currentAnalyzed, remaining } : prev,
        );
        if (res.failed > 0 && res.analyzed === 0) {
          break;
        }
      }
      await loadProgress();
      await load();
    } catch (err) {
      const d = describeError(err);
      notification.error({ message: d.message, description: d.hint ?? undefined });
    } finally {
      setAnalyzing(false);
    }
  }, [progress, loadProgress, load, notification]);

  const confirmAnalyze = useCallback(() => {
    if (!progress) return;
    const estimateText =
      progress.estimate_usd === null
        ? tt('غير معروفة', 'unknown')
        : `~$${progress.estimate_usd.toFixed(2)}`;
    Modal.confirm({
      title: tt('تحليل كل المنشورات', 'Analyze all posts'),
      content: tt(
        `سيتم تحليل ${progress.remaining} منشور. التكلفة التقديرية: ${estimateText}.`,
        `This will analyze ${progress.remaining} post(s). Estimated cost: ${estimateText}.`,
      ),
      okText: tt('تحليل', 'Analyze'),
      cancelText: tt('إلغاء', 'Cancel'),
      onOk: () => runAnalyze(),
    });
  }, [progress, tt, runAnalyze]);

  const isComplete = progress !== null && progress.remaining === 0;

  const analyzeExtra = (
    <Space direction={isRTL ? 'horizontal' : 'horizontal'} align="center" wrap>
      {progress ? (
        <span className="tq-muted" style={{ fontSize: 12 }}>
          <span className="tq-num">{formatNumber(progress.analyzed)}</span>
          {' / '}
          <span className="tq-num">{formatNumber(progress.total)}</span>
        </span>
      ) : null}
      {analyzing ? (
        <Progress
          percent={analyzePercent}
          size="small"
          style={{ width: 120 }}
          status="active"
        />
      ) : null}
      {isComplete ? (
        <Tag color="green">{tt('مكتمل', 'Complete')}</Tag>
      ) : (
        <Button
          type="primary"
          loading={analyzing || progressLoading}
          disabled={progress === null || progress.remaining === 0}
          onClick={confirmAnalyze}
        >
          {tt('تحليل الكل', 'Analyze all')}
        </Button>
      )}
    </Space>
  );

  return (
    <div className="tq-page">
      <PageHeader
        title={tt('اللوحة', 'The Board')}
        subtitle={tt(
          'كل منشور مع تحليله — الأرقام محسوبة، والتفسير نمطي.',
          'Every post with its analysis — numbers computed, explanation pattern-level.',
        )}
        extra={analyzeExtra}
      />

      <p className="tq-muted" style={{ fontSize: 12, marginBlockStart: -8, marginBlockEnd: 16 }}>
        {tt('مرتّبة حسب التفاعل تنازلياً', 'Sorted by engagement, highest first')}
      </p>

      <Card size="small" style={{ marginBlockEnd: 16 }}>
        <Space wrap size="middle">
          <Segmented
            options={[
              { label: tt('الكل', 'All'), value: 'all' },
              { label: tt('شخصي', 'Personal'), value: 'personal' },
              { label: tt('أكاديمية', 'Academy'), value: 'academy' },
            ]}
            value={accountFilter}
            onChange={(v) => setAccountFilter(v as AccountFilter)}
          />
          <Select
            style={{ width: 160 }}
            value={formatFilter}
            onChange={setFormatFilter}
            options={formatOptions}
          />
          <Select<BandFilter>
            style={{ width: 180 }}
            value={bandFilter}
            onChange={setBandFilter}
            options={[
              { label: tt('كل الفئات', 'All bands'), value: 'all' },
              { label: tt('أعلى 10%', 'Top 10%'), value: 'top10' },
              { label: tt('أعلى 25%', 'Top 25%'), value: 'top25' },
              { label: tt('الوسيط', 'Median'), value: 'median' },
              { label: tt('أدنى 25%', 'Bottom 25%'), value: 'bottom25' },
            ]}
          />
        </Space>
      </Card>

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState error={error.message} hint={error.hint} onRetry={() => void load()} />
      ) : posts.length === 0 ? (
        <EmptyState
          description={tt(
            'لا توجد منشورات. شغّل المراقبة أو ارفع تصديراً.',
            'No posts. Run the monitor or upload an export.',
          )}
          actionLabel={tt('إلى البيانات', 'Go to Data')}
          href="/data"
        />
      ) : (
        <Row gutter={[16, 16]}>
          {posts.map((post) => (
            <Col xs={24} md={12} xl={8} key={post.id}>
              <Card size="small">
                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                  <Space wrap size={4}>
                    <Tag>{post.rank !== null ? `#${post.rank}` : '—'}</Tag>
                    <Tag color={post.account === 'academy' ? 'blue' : 'purple'}>
                      {post.account === 'academy' ? tt('أكاديمية', 'Academy') : tt('شخصي', 'Personal')}
                    </Tag>
                    <Tag>{post.media_type ?? '—'}</Tag>
                  </Space>

                  {post.caption ? (
                    <ArabicText>
                      <Typography.Paragraph ellipsis={{ rows: 4, expandable: true }} style={{ marginBottom: 0 }}>
                        {post.caption}
                      </Typography.Paragraph>
                    </ArabicText>
                  ) : (
                    <span className="tq-muted">—</span>
                  )}

                  <Descriptions size="small" column={2}>
                    <Descriptions.Item label={tt('التفاعل', 'Engagement')}>
                      <span className="tq-num">{formatNumber(post.engagement)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('الإعجابات', 'Likes')}>
                      <span className="tq-num">{formatNumber(post.likes)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('التعليقات', 'Comments')}>
                      <span className="tq-num">{formatNumber(post.comments)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={tt('تاريخ النشر', 'Posted')}>
                      {formatDate(post.posted_at, isRTL ? 'ar' : 'en')}
                    </Descriptions.Item>
                  </Descriptions>

                  {post.analysis ? (
                    <>
                      <Space wrap size={4}>
                        <Tag color={vsAccountColor(post.analysis.computed.vs_account_avg)}>
                          {`×${post.analysis.computed.vs_account_avg.toFixed(1)} ${tt('مقابل متوسط الحساب', 'vs account avg')}`}
                        </Tag>
                        <Tag>
                          {`×${post.analysis.computed.vs_format_avg.toFixed(1)} ${tt('مقابل متوسط الشكل', 'vs format avg')}`}
                        </Tag>
                        <Tag>{`P${post.analysis.computed.percentile}`}</Tag>
                        {post.analysis.cluster_label ? (
                          <Tag color="gold">{post.analysis.cluster_label}</Tag>
                        ) : null}
                      </Space>
                      {post.analysis.explanation ? (
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          <ArabicText className="tq-muted">{post.analysis.explanation}</ArabicText>
                          <GroundingTag grounding={post.analysis.grounding} />
                        </Space>
                      ) : null}
                    </>
                  ) : (
                    <span className="tq-muted">{tt('لم يُحلَّل بعد', 'Not analysed yet')}</span>
                  )}

                  {post.url ? (
                    <a href={post.url} target="_blank" rel="noopener noreferrer">
                      {tt('فتح', 'Open')}
                    </a>
                  ) : null}
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  );
}
