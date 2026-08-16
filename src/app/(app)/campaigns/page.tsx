'use client';

import { useEffect, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Dropdown,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Row,
  Select,
  Tag,
} from 'antd';
import type { MenuProps } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import {
  PageHeader,
  EmptyState,
  ErrorState,
  LoadingBlock,
  WarningList,
} from '@/components/ui';
import { ConceptCard } from '@/components/ConceptCard';
import { formatDate } from '@/lib/date';
import type { CampaignRow } from '@/lib/types/db';

interface CampaignsListResponse {
  campaigns: CampaignRow[];
}

interface CampaignGenerateResponse {
  feature: string;
  model: string;
  attempts: number;
  usage: unknown;
  result: unknown;
  persisted: { campaign: CampaignRow };
}

interface CampaignPatchResponse {
  campaign: CampaignRow;
}

const STATUS_OPTIONS: { value: string; ar: string; en: string; color: string }[] = [
  { value: 'draft', ar: 'مسودة', en: 'Draft', color: 'default' },
  { value: 'active', ar: 'نشطة', en: 'Active', color: 'green' },
  { value: 'archived', ar: 'مؤرشفة', en: 'Archived', color: 'default' },
];

function statusMeta(status: string) {
  return STATUS_OPTIONS.find((s) => s.value === status) ?? STATUS_OPTIONS[0];
}

export default function CampaignsPage() {
  const { t, tt, locale } = useLocale();
  const { message, notification } = App.useApp();

  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [generateForm] = Form.useForm<{ objective: string; timeframe: string; name?: string }>();

  const [renameTarget, setRenameTarget] = useState<CampaignRow | null>(null);
  const [renameForm] = Form.useForm<{ name: string }>();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<CampaignsListResponse>('/api/campaigns');
      setCampaigns(data.campaigns);
      if (data.campaigns.length > 0 && !selectedId) {
        setSelectedId(data.campaigns[0].id);
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

  const selected = campaigns?.find((c) => c.id === selectedId) ?? null;

  const handleGenerate = async () => {
    try {
      const values = await generateForm.validateFields();
      setGenerateLoading(true);
      const res = await apiSend<CampaignGenerateResponse>('/api/generate/campaign', 'POST', {
        objective: values.objective,
        timeframe: values.timeframe,
        name: values.name || null,
      });
      setCampaigns((prev) => [res.persisted.campaign, ...(prev ?? [])]);
      setSelectedId(res.persisted.campaign.id);
      setGenerateOpen(false);
      generateForm.resetFields();
      notification.success({
        message: tt('الخطة جاهزة', 'The plan is ready'),
        description: tt('حُفظت مسودّة — راجعها ثم فعّلها.', 'Saved as a draft. Read it, then set it active.'),
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return; // form validation error
      const { message: msg, hint } = describeError(err);
      notification.error({ message: msg, description: hint ?? undefined });
    } finally {
      setGenerateLoading(false);
    }
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    try {
      const values = await renameForm.validateFields();
      const res = await apiSend<CampaignPatchResponse>(
        `/api/campaigns/${renameTarget.id}`,
        'PATCH',
        { name: values.name },
      );
      setCampaigns((prev) =>
        (prev ?? []).map((c) => (c.id === res.campaign.id ? res.campaign : c)),
      );
      setRenameTarget(null);
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      const { message: msg, hint } = describeError(err);
      notification.error({ message: msg, description: hint ?? undefined });
    }
  };

  const handleStatusChange = async (campaign: CampaignRow, status: string) => {
    try {
      const res = await apiSend<CampaignPatchResponse>(`/api/campaigns/${campaign.id}`, 'PATCH', {
        status,
      });
      setCampaigns((prev) =>
        (prev ?? []).map((c) => (c.id === res.campaign.id ? res.campaign : c)),
      );
    } catch (err) {
      const { message: msg, hint } = describeError(err);
      notification.error({ message: msg, description: hint ?? undefined });
    }
  };

  const handleDelete = async (campaign: CampaignRow) => {
    try {
      await apiSend(`/api/campaigns/${campaign.id}`, 'DELETE');
      setCampaigns((prev) => (prev ?? []).filter((c) => c.id !== campaign.id));
      if (selectedId === campaign.id) setSelectedId(null);
      message.success(tt('تم الحذف', 'Deleted'));
    } catch (err) {
      const { message: msg, hint } = describeError(err);
      notification.error({ message: msg, description: hint ?? undefined });
    }
  };

  const menuFor = (campaign: CampaignRow): MenuProps => ({
    items: [
      { key: 'rename', label: tt('إعادة تسمية', 'Rename') },
      {
        key: 'status',
        label: (
          <Select
            size="small"
            value={campaign.status}
            style={{ width: 140 }}
            onClick={(e) => e.stopPropagation()}
            onChange={(value) => handleStatusChange(campaign, value)}
            options={STATUS_OPTIONS.map((s) => ({
              value: s.value,
              label: locale === 'ar' ? s.ar : s.en,
            }))}
          />
        ),
      },
    ],
    onClick: ({ key }) => {
      if (key === 'rename') {
        setRenameTarget(campaign);
        renameForm.setFieldsValue({ name: campaign.name });
      }
    },
  });

  return (
    <div className="tq-page">
      <PageHeader
        title={t.nav.campaigns}
        subtitle={tt(
          'هدف واحد ومدّة واحدة، وخطة تقول: لمن، وبأي وتيرة، وكيف نعرف أنها نجحت.',
          'One objective, one window, and a plan that says who it is for, how often, and how you will know it worked.',
        )}
        extra={
          <Button type="primary" onClick={() => setGenerateOpen(true)}>
            {tt('حملة جديدة', 'New campaign')}
          </Button>
        }
      />

      {loading ? <LoadingBlock rows={6} /> : null}
      {!loading && error ? <ErrorState error={error.message} hint={error.hint} onRetry={load} /> : null}

      {!loading && !error && campaigns && campaigns.length === 0 ? (
        <EmptyState
          title={tt('لا حملات بعد', 'No campaigns yet')}
          description={tt(
            'اكتب هدفاً ومدّة، ويعيدهما الوكيل خطةً: الشريحة، ومزيج المحاور، والوتيرة، وخطة قياس تقول ماذا تسحب ومتى.',
            'Give it an objective and a window; it comes back as a plan — the segment, the pillar mix, the cadence, and a measurement plan naming what to pull and when.',
          )}
          hint={tt(
            'تُبنى من محاورك وبياناتك المخزّنة، وتُحفظ مسودّة.',
            'Built from your pillars and the data already stored, and saved as a draft.',
          )}
          actionLabel={tt('اكتب أول حملة', 'Plan the first campaign')}
          onAction={() => setGenerateOpen(true)}
        />
      ) : null}

      {!loading && !error && campaigns && campaigns.length > 0 ? (
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <List
              bordered
              dataSource={campaigns}
              renderItem={(campaign) => {
                const meta = statusMeta(campaign.status);
                return (
                  <List.Item
                    key={campaign.id}
                    onClick={() => setSelectedId(campaign.id)}
                    style={{
                      cursor: 'pointer',
                      background: campaign.id === selectedId ? 'var(--ant-color-primary-bg)' : undefined,
                      paddingInline: 12,
                    }}
                    actions={[
                      <Dropdown key="menu" menu={menuFor(campaign)} trigger={['click']}>
                        <Button
                          size="small"
                          type="text"
                          icon={<MoreOutlined />}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </Dropdown>,
                      <Popconfirm
                        key="delete"
                        title={tt('حذف الحملة؟', 'Delete this campaign?')}
                        onConfirm={(e) => {
                          e?.stopPropagation();
                          handleDelete(campaign);
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
                      title={<span dir="auto">{campaign.name}</span>}
                      description={
                        <>
                          <div dir="auto" className="tq-ar" style={{ fontSize: 12 }}>
                            {campaign.objective}
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginBlockStart: 4 }}>
                            <Tag color={meta.color}>{locale === 'ar' ? meta.ar : meta.en}</Tag>
                            <span className="tq-muted" style={{ fontSize: 12 }}>
                              {formatDate(campaign.created_at, locale)}
                            </span>
                          </div>
                        </>
                      }
                    />
                  </List.Item>
                );
              }}
            />
          </Col>
          <Col xs={24} md={16}>
            {selected ? (
              <div>
                <WarningList warnings={selected.plan.warnings ?? []} />
                <Descriptions bordered size="small" column={1} style={{ marginBlockEnd: 16 }}>
                  <Descriptions.Item label={tt('الهدف', 'Objective')}>
                    <span dir="auto">{selected.plan.objective}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label={tt('شريحة الجمهور', 'Audience segment')}>
                    <span dir="auto">{selected.plan.audience_segment}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label={tt('الوتيرة', 'Cadence')}>
                    <span dir="auto">{selected.plan.cadence}</span>
                  </Descriptions.Item>
                  <Descriptions.Item label={tt('محاور المحتوى', 'Pillar mix')}>
                    {selected.plan.pillar_mix.length > 0 ? (
                      selected.plan.pillar_mix.map((p, i) => (
                        <Tag key={i} dir="auto">
                          {p}
                        </Tag>
                      ))
                    ) : (
                      <span>—</span>
                    )}
                  </Descriptions.Item>
                </Descriptions>

                <Card
                  size="small"
                  title={tt('خطة القياس', 'Measurement plan')}
                  style={{ marginBlockEnd: 16 }}
                >
                  <div style={{ marginBlockEnd: 8 }}>
                    <strong>{tt('المقاييس: ', 'Metrics: ')}</strong>
                    {selected.plan.measurement_plan.metrics.length > 0 ? (
                      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                        {selected.plan.measurement_plan.metrics.map((m, i) => (
                          <li key={i} dir="auto">
                            {m}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span>—</span>
                    )}
                  </div>
                  <div style={{ marginBlockEnd: 8 }} dir="auto">
                    <strong>{tt('طريقة السحب: ', 'Pull method: ')}</strong>
                    {selected.plan.measurement_plan.pull_method || '—'}
                  </div>
                  <div dir="auto">
                    <strong>{tt('التوقيت: ', 'When: ')}</strong>
                    {selected.plan.measurement_plan.when || '—'}
                  </div>
                  <p className="tq-muted" style={{ fontSize: 12, marginBlockStart: 12, marginBlockEnd: 0 }}>
                    {tt(
                      'اجمع هذه الأرقام بنفسك حين تنتهي المدة، ثم ارفع تصديراً في شاشة الداتا ليقيسها الوكيل معك.',
                      'Collect these yourself when the window closes, then ingest an export on Data so the agent measures them with you.',
                    )}
                  </p>
                </Card>

                <Row gutter={[16, 16]}>
                  {selected.plan.flagship_concepts.map((concept, i) => (
                    <Col xs={24} sm={12} key={i}>
                      <ConceptCard concept={concept} compact />
                    </Col>
                  ))}
                </Row>
              </div>
            ) : (
              <EmptyState description={tt('اختر حملة من القائمة.', 'Pick a campaign from the list.')} />
            )}
          </Col>
        </Row>
      ) : null}

      <Modal
        title={tt('حملة جديدة', 'New campaign')}
        open={generateOpen}
        onCancel={() => setGenerateOpen(false)}
        onOk={handleGenerate}
        confirmLoading={generateLoading}
        okText={t.common.generate}
        cancelText={t.common.cancel}
      >
        <Form form={generateForm} layout="vertical">
          <Form.Item
            name="objective"
            label={tt('الهدف', 'Objective')}
            rules={[{ required: true, message: tt('مطلوب', 'Required') }]}
          >
            <Input.TextArea dir="auto" rows={3} />
          </Form.Item>
          <Form.Item
            name="timeframe"
            label={tt('الإطار الزمني', 'Timeframe')}
            rules={[{ required: true, message: tt('مطلوب', 'Required') }]}
          >
            <Input dir="auto" placeholder={tt('مثال: ٦ أسابيع', 'e.g. 6 weeks')} />
          </Form.Item>
          <Form.Item name="name" label={tt('اسم الحملة (اختياري)', 'Campaign name (optional)')}>
            <Input dir="auto" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={tt('إعادة تسمية الحملة', 'Rename campaign')}
        open={renameTarget !== null}
        onCancel={() => setRenameTarget(null)}
        onOk={handleRename}
        okText={t.common.save}
        cancelText={t.common.cancel}
      >
        <Form form={renameForm} layout="vertical">
          <Form.Item
            name="name"
            label={tt('الاسم', 'Name')}
            rules={[{ required: true, message: tt('مطلوب', 'Required') }]}
          >
            <Input dir="auto" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
