'use client';

import { useEffect, useState } from 'react';
import { App, Alert, Button, Col, DatePicker, Input, List, Popconfirm, Row, Switch, Tag } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dayjs, { type Dayjs } from 'dayjs';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import { PageHeader, EmptyState, ErrorState, LoadingBlock, WarningList } from '@/components/ui';
import { formatDate, formatDateTime, toIsoDate } from '@/lib/date';
import type { ReportRow } from '@/lib/types/db';

interface ReportsListResponse {
  reports: ReportRow[];
}

interface ReportGenerateResponse {
  feature: string;
  model: string;
  attempts: number;
  usage: unknown;
  result: { warnings: string[]; body_md: string };
  persisted: { report: ReportRow };
}

interface ReportPatchResponse {
  report: ReportRow;
}

export default function ReportsPage() {
  const { t, tt, locale } = useLocale();
  const { message, notification } = App.useApp();

  const [reports, setReports] = useState<ReportRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [month, setMonth] = useState<Dayjs | null>(dayjs().startOf('month'));
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<{ message: string; hint: string | null } | null>(null);

  const [editing, setEditing] = useState(false);
  const [draftMd, setDraftMd] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<ReportsListResponse>('/api/reports');
      setReports(data.reports);
      if (data.reports.length > 0 && !selectedId) {
        setSelectedId(data.reports[0].id);
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

  const selected = reports?.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    setEditing(false);
    if (selected) setDraftMd(selected.body_md);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerate = async () => {
    if (!month) return;
    setGenerating(true);
    setGenError(null);
    try {
      const res = await apiSend<ReportGenerateResponse>('/api/generate/report', 'POST', {
        month: toIsoDate(month.startOf('month')),
      });
      setReports((prev) => [res.persisted.report, ...(prev ?? [])]);
      setSelectedId(res.persisted.report.id);
      setWarnings(res.result.warnings ?? []);
      notification.success({
        message: tt('تم إنشاء التقرير', 'Report generated'),
        description: tt(`بواسطة النموذج ${res.model}`, `Generated with ${res.model}`),
      });
    } catch (err) {
      setGenError(describeError(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!selected) return;
    try {
      const res = await apiSend<ReportPatchResponse>(`/api/reports/${selected.id}`, 'PATCH', {
        body_md: draftMd,
      });
      setReports((prev) => (prev ?? []).map((r) => (r.id === res.report.id ? res.report : r)));
      setEditing(false);
      message.success(t.common.save);
    } catch (err) {
      const { message: msg, hint } = describeError(err);
      notification.error({ message: msg, description: hint ?? undefined });
    }
  };

  const handleApprovedToggle = async (checked: boolean) => {
    if (!selected) return;
    try {
      const res = await apiSend<ReportPatchResponse>(`/api/reports/${selected.id}`, 'PATCH', {
        status: checked ? 'approved' : 'draft',
      });
      setReports((prev) => (prev ?? []).map((r) => (r.id === res.report.id ? res.report : r)));
    } catch (err) {
      const { message: msg, hint } = describeError(err);
      notification.error({ message: msg, description: hint ?? undefined });
    }
  };

  const handleDelete = async (report: ReportRow) => {
    try {
      await apiSend(`/api/reports/${report.id}`, 'DELETE');
      setReports((prev) => (prev ?? []).filter((r) => r.id !== report.id));
      if (selectedId === report.id) setSelectedId(null);
      message.success(tt('تم الحذف', 'Deleted'));
    } catch (err) {
      const { message: msg, hint } = describeError(err);
      notification.error({ message: msg, description: hint ?? undefined });
    }
  };

  const handleCopy = async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(selected.body_md);
    message.success(t.common.copied);
  };

  const handleDownload = () => {
    if (!selected) return;
    const blob = new Blob([selected.body_md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `thinkquality-${selected.month}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="tq-page">
      <PageHeader
        title={t.nav.reports}
        subtitle={tt('تقرير شهري بالعربية، جاهز للمراجعة.', 'A monthly client report in Arabic, ready for your review.')}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBlockEnd: 16 }}
        message="لا يُرسل شيء للعميل إلا بموافقتك"
        description={tt('هذه الشاشة تكتب وتراجع فقط. لا يوجد زر إرسال.', 'This screen only writes and reviews. There is no send button.')}
      />

      <div style={{ display: 'flex', gap: 8, marginBlockEnd: 16, flexWrap: 'wrap' }}>
        <DatePicker picker="month" value={month} onChange={(v) => setMonth(v)} allowClear={false} />
        <Button type="primary" loading={generating} onClick={handleGenerate}>
          {t.common.generate}
        </Button>
      </div>

      {genError ? (
        <ErrorState error={genError.message} hint={genError.hint} onRetry={undefined} />
      ) : null}

      {loading ? <LoadingBlock rows={6} /> : null}
      {!loading && error ? <ErrorState error={error.message} hint={error.hint} onRetry={load} /> : null}

      {!loading && !error && reports && reports.length === 0 ? (
        <EmptyState
          description={tt('لم يُنشأ أي تقرير بعد.', 'No report has been generated yet.')}
          actionLabel={tt('ولّد تقرير الشهر', "Generate this month's report")}
          onAction={handleGenerate}
        />
      ) : null}

      {!loading && !error && reports && reports.length > 0 ? (
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <List
              bordered
              dataSource={reports}
              renderItem={(report) => (
                <List.Item
                  key={report.id}
                  onClick={() => setSelectedId(report.id)}
                  style={{
                    cursor: 'pointer',
                    background: report.id === selectedId ? 'var(--ant-color-primary-bg)' : undefined,
                    paddingInline: 12,
                  }}
                  actions={[
                    <Popconfirm
                      key="delete"
                      title={tt('حذف التقرير؟', 'Delete this report?')}
                      onConfirm={(e) => {
                        e?.stopPropagation();
                        handleDelete(report);
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button size="small" danger type="text" onClick={(e) => e.stopPropagation()}>
                        {t.common.delete}
                      </Button>
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    title={formatDate(report.month, locale)}
                    description={
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Tag color={report.status === 'approved' ? 'green' : 'default'}>
                          {report.status === 'approved' ? tt('معتمد', 'Approved') : tt('مسودة', 'Draft')}
                        </Tag>
                        <span className="tq-muted" style={{ fontSize: 12 }}>
                          {formatDateTime(report.created_at, locale)}
                        </span>
                      </div>
                    }
                  />
                </List.Item>
              )}
            />
          </Col>
          <Col xs={24} md={16}>
            {selected ? (
              <div>
                <WarningList warnings={warnings} />
                <div style={{ display: 'flex', gap: 8, marginBlockEnd: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  {!editing ? (
                    <Button onClick={() => setEditing(true)}>{t.common.edit}</Button>
                  ) : (
                    <Button type="primary" onClick={handleSave}>
                      {t.common.save}
                    </Button>
                  )}
                  <Button onClick={handleCopy}>{t.common.copy}</Button>
                  <Button onClick={handleDownload}>{t.common.download} .md</Button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginInlineStart: 'auto' }}>
                    <span>{tt('معتمد', 'Approved')}</span>
                    <Switch
                      checked={selected.status === 'approved'}
                      onChange={handleApprovedToggle}
                    />
                  </div>
                </div>

                {editing ? (
                  <Input.TextArea
                    dir="auto"
                    rows={20}
                    value={draftMd}
                    onChange={(e) => setDraftMd(e.target.value)}
                  />
                ) : (
                  <div dir="rtl" className="tq-ar tq-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.body_md}</ReactMarkdown>
                  </div>
                )}
              </div>
            ) : (
              <EmptyState description={tt('اختر تقريرًا لعرضه.', 'Select a report to preview it.')} />
            )}
          </Col>
        </Row>
      ) : null}
    </div>
  );
}
