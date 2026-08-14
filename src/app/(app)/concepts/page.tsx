'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Row,
  Col,
  Card,
  Space,
  InputNumber,
  Input,
  Select,
  Button,
  Segmented,
  Drawer,
  Form,
  Modal,
  DatePicker,
  App,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import {
  PageHeader,
  EmptyState,
  ErrorState,
  LoadingBlock,
  WarningList,
  statusLabel,
} from '@/components/ui';
import { ConceptCard } from '@/components/ConceptCard';
import { formatDate, weekStartIso } from '@/lib/date';
import type {
  AgentConcept,
  Account,
  ConceptFormat,
  ConceptRow,
  ConceptStatus,
  PillarRow,
} from '@/lib/types/db';

interface ConceptsResponse {
  concepts: ConceptRow[];
  pillars: PillarRow[];
}

interface GenerateResponse {
  feature: string;
  model: string;
  attempts: number;
  usage: { input_tokens: number; output_tokens: number };
  result: { warnings: string[]; concepts: AgentConcept[] };
  persisted: { inserted: ConceptRow[] };
}

interface PatchResponse {
  concept: ConceptRow;
}

type StatusFilter = 'all' | ConceptStatus;

export default function ConceptsPage() {
  const { t, tt, locale, isRTL } = useLocale();
  const { message, notification } = App.useApp();

  const [concepts, setConcepts] = useState<ConceptRow[]>([]);
  const [pillars, setPillars] = useState<PillarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [count, setCount] = useState<number>(3);
  const [theme, setTheme] = useState<string>('');
  const [account, setAccount] = useState<Account>('academy');
  const [generating, setGenerating] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [editing, setEditing] = useState<ConceptRow | null>(null);
  const [editForm] = Form.useForm<{
    title: string;
    hook_ar: string;
    caption_ar: string;
    visual_direction: string;
    why: string;
    format: ConceptFormat;
    pillar_id: string | null;
  }>();
  const [savingEdit, setSavingEdit] = useState(false);

  const [shipping, setShipping] = useState<ConceptRow | null>(null);
  const [shippedUrl, setShippedUrl] = useState('');
  const [shipSaving, setShipSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter === 'all' ? '' : `?status=${statusFilter}`;
      const data = await apiGet<ConceptsResponse>(`/api/concepts${qs}`);
      setConcepts(data.concepts);
      setPillars(data.pillars);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const pillarName = useCallback(
    (pillarId: string | null): string | null => {
      if (!pillarId) return null;
      const p = pillars.find((x) => x.id === pillarId);
      if (!p) return null;
      return locale === 'ar' ? p.name_ar : p.name_en ?? p.name_ar;
    },
    [pillars, locale],
  );

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await apiSend<GenerateResponse>('/api/generate/concepts', 'POST', {
        count,
        theme: theme.trim() ? theme.trim() : null,
        account,
      });
      setWarnings(res.result.warnings);
      setConcepts((prev) => [...res.persisted.inserted, ...prev]);
      notification.success({
        message: tt('تم التوليد', 'Generated'),
        description: tt(
          `تم حفظ ${res.persisted.inserted.length} فكرة كمسودة بواسطة ${res.model}.`,
          `Saved ${res.persisted.inserted.length} concept(s) as drafts using ${res.model}.`,
        ),
      });
    } catch (err) {
      const d = describeError(err);
      notification.error({ message: d.message, description: d.hint ?? undefined });
    } finally {
      setGenerating(false);
    }
  }, [count, theme, account, notification, tt]);

  const updateConceptLocal = useCallback((updated: ConceptRow) => {
    setConcepts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }, []);

  const patchConcept = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      try {
        const res = await apiSend<PatchResponse>(`/api/concepts/${id}`, 'PATCH', body);
        updateConceptLocal(res.concept);
        return res.concept;
      } catch (err) {
        const d = describeError(err);
        notification.error({ message: d.message, description: d.hint ?? undefined });
        return null;
      }
    },
    [updateConceptLocal, notification],
  );

  const handleApprove = useCallback(
    (c: ConceptRow) => {
      void patchConcept(c.id, { status: 'approved' });
    },
    [patchConcept],
  );

  const handleReject = useCallback(
    (c: ConceptRow) => {
      void patchConcept(c.id, { status: 'rejected' });
    },
    [patchConcept],
  );

  const openEdit = useCallback(
    (c: ConceptRow) => {
      setEditing(c);
      editForm.setFieldsValue({
        title: c.title,
        hook_ar: c.hook_ar,
        caption_ar: c.caption_ar,
        visual_direction: c.visual_direction,
        why: c.why,
        format: c.format,
        pillar_id: c.pillar_id,
      });
    },
    [editForm],
  );

  const closeEdit = useCallback(() => {
    setEditing(null);
    editForm.resetFields();
  }, [editForm]);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    setSavingEdit(true);
    try {
      const values = await editForm.validateFields();
      const patch: Record<string, unknown> = {};
      (Object.keys(values) as (keyof typeof values)[]).forEach((key) => {
        if (values[key] !== editing[key as keyof ConceptRow]) {
          patch[key] = values[key];
        }
      });
      if (Object.keys(patch).length > 0) {
        const updated = await patchConcept(editing.id, patch);
        if (updated) {
          message.success(t.common.save);
          closeEdit();
        }
      } else {
        closeEdit();
      }
    } catch {
      // validation error, keep drawer open
    } finally {
      setSavingEdit(false);
    }
  }, [editing, editForm, patchConcept, message, t, closeEdit]);

  const openShip = useCallback((c: ConceptRow) => {
    setShipping(c);
    setShippedUrl(c.shipped_url ?? '');
  }, []);

  const closeShip = useCallback(() => {
    setShipping(null);
    setShippedUrl('');
  }, []);

  const saveShip = useCallback(async () => {
    if (!shipping || !shippedUrl.trim()) return;
    setShipSaving(true);
    try {
      const updated = await patchConcept(shipping.id, {
        status: 'shipped',
        shipped_url: shippedUrl.trim(),
      });
      if (updated) closeShip();
    } finally {
      setShipSaving(false);
    }
  }, [shipping, shippedUrl, patchConcept, closeShip]);

  const setTargetWeek = useCallback(
    (c: ConceptRow, value: Dayjs | null) => {
      void patchConcept(c.id, { target_week: value ? weekStartIso(value) : null });
    },
    [patchConcept],
  );

  const segmentedOptions = [
    { label: tt('الكل', 'All'), value: 'all' },
    { label: statusLabel('draft', locale), value: 'draft' },
    { label: statusLabel('approved', locale), value: 'approved' },
    { label: statusLabel('shipped', locale), value: 'shipped' },
    { label: statusLabel('rejected', locale), value: 'rejected' },
  ];

  return (
    <div className="tq-page">
      <PageHeader
        title={t.nav.concepts}
        subtitle={tt(
          'يفكّر الوكيل ويقترح؛ النشر يبقى بيدك.',
          'The agent thinks and proposes; posting stays in your hands.',
        )}
      />

      <Card size="small" style={{ marginBlockEnd: 16 }}>
        <Space wrap size="middle">
          <Space size={4}>
            <span>{tt('العدد', 'Count')}</span>
            <InputNumber min={1} max={8} value={count} onChange={(v) => setCount(v ?? 1)} />
          </Space>
          <Input
            dir="auto"
            style={{ width: 220 }}
            placeholder={tt('موضوع اختياري', 'Optional theme')}
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          />
          <Select<Account>
            style={{ width: 160 }}
            value={account}
            onChange={setAccount}
            options={[
              { label: t.common.academy, value: 'academy' },
              { label: t.common.personal, value: 'personal' },
            ]}
          />
          <Button type="primary" loading={generating} onClick={() => void handleGenerate()}>
            {t.common.generate}
          </Button>
        </Space>
      </Card>

      <WarningList warnings={warnings} />

      <Segmented
        options={segmentedOptions}
        value={statusFilter}
        onChange={(v) => setStatusFilter(v as StatusFilter)}
        style={{ marginBlockEnd: 16 }}
      />

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState error={error.message} hint={error.hint} onRetry={() => void load()} />
      ) : concepts.length === 0 ? (
        <EmptyState
          description={tt('لا توجد أفكار بعد.', 'No concepts yet.')}
          actionLabel={tt('ولّد أول دفعة', 'Generate the first batch')}
          onAction={() => void handleGenerate()}
        />
      ) : (
        <Row gutter={[16, 16]}>
          {concepts.map((c) => (
            <Col xs={24} md={12} xl={8} key={c.id}>
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                <ConceptCard
                  concept={c}
                  pillarName={pillarName(c.pillar_id)}
                  compact
                  actions={{
                    onApprove: handleApprove,
                    onReject: handleReject,
                    onEdit: openEdit,
                    onShip: openShip,
                  }}
                />
                {c.status === 'approved' ? (
                  <Space size={8} align="center">
                    <span className="tq-muted" style={{ fontSize: 12 }}>
                      {tt('الأسبوع المستهدف: ', 'Target week: ')}
                      {formatDate(c.target_week, locale)}
                    </span>
                    <DatePicker
                      picker="week"
                      size="small"
                      value={c.target_week ? dayjs(c.target_week) : null}
                      onChange={(v) => setTargetWeek(c, v)}
                      allowClear
                    />
                  </Space>
                ) : null}
              </Space>
            </Col>
          ))}
        </Row>
      )}

      <Drawer
        title={t.common.edit}
        placement={isRTL ? 'left' : 'right'}
        width={520}
        open={editing !== null}
        onClose={closeEdit}
        extra={
          <Space>
            <Button onClick={closeEdit}>{t.common.cancel}</Button>
            <Button type="primary" loading={savingEdit} onClick={() => void saveEdit()}>
              {t.common.save}
            </Button>
          </Space>
        }
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="title" label={tt('العنوان', 'Title')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="hook_ar" label={tt('الخطاف', 'Hook')} rules={[{ required: true }]}>
            <Input.TextArea dir="auto" />
          </Form.Item>
          <Form.Item name="caption_ar" label={tt('النص', 'Caption')} rules={[{ required: true }]}>
            <Input.TextArea dir="auto" rows={8} />
          </Form.Item>
          <Form.Item
            name="visual_direction"
            label={tt('الاتجاه البصري', 'Visual direction')}
            rules={[{ required: true }]}
          >
            <Input.TextArea dir="auto" />
          </Form.Item>
          <Form.Item name="why" label={tt('لماذا', 'Why')} rules={[{ required: true }]}>
            <Input.TextArea dir="auto" />
          </Form.Item>
          <Form.Item name="format" label={tt('الصيغة', 'Format')} rules={[{ required: true }]}>
            <Select<ConceptFormat>
              options={[
                { label: tt('ريل', 'Reel'), value: 'reel' },
                { label: tt('كاروسيل', 'Carousel'), value: 'carousel' },
                { label: tt('صورة ثابتة', 'Static'), value: 'static' },
                { label: tt('ستوري', 'Story'), value: 'story' },
              ]}
            />
          </Form.Item>
          <Form.Item name="pillar_id" label={tt('المحور', 'Pillar')}>
            <Select
              allowClear
              options={pillars.map((p) => ({
                label: locale === 'ar' ? p.name_ar : p.name_en ?? p.name_ar,
                value: p.id,
              }))}
            />
          </Form.Item>
        </Form>
      </Drawer>

      <Modal
        title={tt('تم النشر', 'Mark shipped')}
        open={shipping !== null}
        onCancel={closeShip}
        onOk={() => void saveShip()}
        okButtonProps={{ loading: shipSaving, disabled: !shippedUrl.trim() }}
        okText={t.common.save}
        cancelText={t.common.cancel}
      >
        <p>
          {tt(
            'انشر المنشور بنفسك أولًا، ثم الصق الرابط هنا ليستطيع التحديث القادم جلب التفاعل الحقيقي.',
            'Post it yourself first, then paste the link here so the next refresh can pull in real engagement.',
          )}
        </p>
        <Input
          dir="ltr"
          placeholder="https://www.instagram.com/p/…"
          value={shippedUrl}
          onChange={(e) => setShippedUrl(e.target.value)}
        />
      </Modal>
    </div>
  );
}
