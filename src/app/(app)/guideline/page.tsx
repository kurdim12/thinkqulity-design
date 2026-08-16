'use client';

import { useEffect, useMemo, useState } from 'react';
import { App, Alert, Anchor, Button, Col, Row, Select, Space, Tag, Typography } from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import { PageHeader, ArabicText, EmptyState, ErrorState, LoadingBlock } from '@/components/ui';

type GuidelineStatus = 'draft' | 'approved';

interface SectionLine {
  text: string;
  source: string;
}

interface Section {
  key: string;
  title_ar: string;
  lines: SectionLine[];
}

interface GuidelineRow {
  id: string;
  version: number;
  status: GuidelineStatus;
  created_at: string;
  sections: Section[];
}

interface GuidelinesListResponse {
  guidelines: GuidelineRow[];
}

interface GuidelineGenerateResponse {
  result: { warnings: string[]; sections: Section[] };
  persisted: { guideline: GuidelineRow };
  brain?: { judge: { score: number; needs_human: boolean }; law: { violations: unknown[] } };
}

interface GuidelinePatchResponse {
  guideline: GuidelineRow;
}

export default function GuidelinePage() {
  const { tt } = useLocale();
  const { message, notification } = App.useApp();

  const [guidelines, setGuidelines] = useState<GuidelineRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<GuidelinesListResponse>('/api/guidelines');
      setGuidelines(data.guidelines);
      if (data.guidelines.length > 0 && !selectedId) {
        setSelectedId(data.guidelines[0].id);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => guidelines?.find((g) => g.id === selectedId) ?? null,
    [guidelines, selectedId],
  );

  const handleGenerate = async () => {
    setGenerating(true);
    setNeedsReview(false);
    try {
      const res = await apiSend<GuidelineGenerateResponse>('/api/generate/guideline', 'POST', {});
      setGuidelines((prev) => [res.persisted.guideline, ...(prev ?? [])]);
      setSelectedId(res.persisted.guideline.id);
      if (res.brain?.judge.needs_human) setNeedsReview(true);
      notification.success({
        message: tt('تم إنشاء نسخة جديدة', 'New version generated'),
      });
    } catch (err) {
      const { message: msg, hint } = describeError(err);
      notification.error({ message: msg, description: hint ?? undefined });
    } finally {
      setGenerating(false);
    }
  };

  const handleApprove = async () => {
    if (!selected) return;
    setApproving(true);
    try {
      const res = await apiSend<GuidelinePatchResponse>(`/api/guidelines/${selected.id}`, 'PATCH', {
        status: 'approved',
      });
      setGuidelines((prev) => (prev ?? []).map((g) => (g.id === res.guideline.id ? res.guideline : g)));
      message.success(tt('تم الاعتماد', 'Approved'));
    } catch (err) {
      const { message: msg, hint } = describeError(err);
      notification.error({ message: msg, description: hint ?? undefined });
    } finally {
      setApproving(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="tq-page">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .ant-layout-sider, .ant-layout-header { display: none !important; }
          body { background: #fff !important; color: #000 !important; }
        }
        @page { size: A4; margin: 18mm; }
      `}</style>

      <PageHeader
        title={tt('دليل العلامة', 'Brand Guideline')}
        subtitle={tt(
          'مبني من بيانات العلامة نفسها — كل سطر له مصدر.',
          "Built from the brand's own data — every line carries its source.",
        )}
        extra={
          <Space className="no-print" wrap>
            {guidelines && guidelines.length > 0 ? (
              <Select
                value={selectedId ?? undefined}
                onChange={(v: string) => setSelectedId(v)}
                style={{ minWidth: 140 }}
                options={guidelines.map((g) => ({
                  value: g.id,
                  label: `v${g.version} · ${g.status === 'approved' ? tt('معتمد', 'Approved') : tt('مسودة', 'Draft')}`,
                }))}
              />
            ) : null}
            <Button loading={generating} onClick={handleGenerate}>
              {tt('إنشاء نسخة جديدة', 'Generate new version')}
            </Button>
            <Button
              type="primary"
              disabled={!selected || selected.status === 'approved'}
              loading={approving}
              onClick={handleApprove}
            >
              {tt('اعتماد', 'Approve')}
            </Button>
            <Button onClick={handlePrint} disabled={!selected}>
              {tt('طباعة / PDF', 'Print / PDF')}
            </Button>
          </Space>
        }
      />

      {needsReview ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBlockEnd: 16 }}
          message={tt('هذه النسخة تحتاج قراءة بشرية', 'This version needs a human read')}
          description={tt(
            'رصد القاضي فيها ما لا يستطيع الحسم فيه. اقرأ الأسطر ومصادرها أدناه، وإما أن تعتمدها كما هي أو تولّد نسخة أخرى.',
            'The Judge flagged something it could not settle. Read the lines and their sources below, then either approve this version or generate another.',
          )}
        />
      ) : null}

      {loading ? <LoadingBlock rows={6} /> : null}
      {!loading && error ? <ErrorState error={error.message} hint={error.hint} onRetry={load} /> : null}

      {!loading && !error && guidelines && guidelines.length === 0 ? (
        <EmptyState
          title={tt('لا دليل بعد', 'No guideline yet')}
          description={tt(
            'الدليل هو العلامة مكتوبةً بأسطر قابلة للاقتباس: النبرة، والمحاور، وما يُقال وما لا يُقال — وكل سطر يحمل مصدره من بيانات العلامة نفسها.',
            'The guideline is the brand written down in quotable lines — the register, the pillars, what is said and what is not — and every line carries the source it came from.',
          )}
          hint={tt(
            'تُبنى من عقل العلامة كما هو الآن. أمثلة صوت أكثر تعني نبرة أدقّ.',
            'Built from the Brand Brain as it stands. More voice examples, sharper register.',
          )}
          actionLabel={tt('أنشئ النسخة الأولى', 'Write version 1')}
          onAction={handleGenerate}
        />
      ) : null}

      {!loading && !error && selected ? (
        <div dir="rtl">
          <Row gutter={[16, 16]}>
            <Col xs={0} md={6} className="no-print">
              <Anchor
                items={selected.sections.map((s) => ({
                  key: s.key,
                  href: `#${s.key}`,
                  title: s.title_ar,
                }))}
              />
            </Col>
            <Col xs={24} md={18}>
              {selected.sections.map((section) => (
                <div key={section.key} style={{ marginBlockEnd: 24 }}>
                  <Typography.Title level={4} id={section.key} dir="auto" className="tq-ar">
                    {section.title_ar}
                  </Typography.Title>
                  {section.lines.map((line, i) => (
                    <div
                      key={i}
                      style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBlockEnd: 8, flexWrap: 'wrap' }}
                    >
                      <ArabicText style={{ flex: 1 }}>{line.text}</ArabicText>
                      <Tag style={{ fontSize: 11 }}>{line.source}</Tag>
                    </div>
                  ))}
                </div>
              ))}
            </Col>
          </Row>
        </div>
      ) : null}
    </div>
  );
}
