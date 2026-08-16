'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Calendar, Badge, Drawer, Descriptions, Modal, Input, Space, Button, Alert, App } from 'antd';
import type { Dayjs } from 'dayjs';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
import { PageHeader, ErrorState, LoadingBlock } from '@/components/ui';
import { ConceptCard } from '@/components/ConceptCard';
import { formatDate, formatNumber, weekStartIso } from '@/lib/date';
import type { ConceptRow, PillarRow } from '@/lib/types/db';

interface ConceptsResponse {
  concepts: ConceptRow[];
  pillars: PillarRow[];
}

interface PatchResponse {
  concept: ConceptRow;
}

export default function CalendarPage() {
  const { t, tt, locale, isRTL } = useLocale();
  const { notification } = App.useApp();

  const [concepts, setConcepts] = useState<ConceptRow[]>([]);
  const [pillars, setPillars] = useState<PillarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const [selected, setSelected] = useState<ConceptRow | null>(null);

  const [shipping, setShipping] = useState<ConceptRow | null>(null);
  const [shippedUrl, setShippedUrl] = useState('');
  const [shipSaving, setShipSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<ConceptsResponse>('/api/concepts');
      setConcepts(data.concepts);
      setPillars(data.pillars);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scheduled = useMemo(
    () =>
      concepts.filter(
        (c) => (c.status === 'approved' || c.status === 'shipped') && c.target_week !== null,
      ),
    [concepts],
  );

  const pillarName = useCallback(
    (pillarId: string | null): string | null => {
      if (!pillarId) return null;
      const p = pillars.find((x) => x.id === pillarId);
      if (!p) return null;
      return locale === 'ar' ? p.name_ar : p.name_en ?? p.name_ar;
    },
    [pillars, locale],
  );

  const updateConceptLocal = useCallback((updated: ConceptRow) => {
    setConcepts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setSelected((prev) => (prev && prev.id === updated.id ? updated : prev));
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

  const cellRender = useCallback(
    (date: Dayjs) => {
      const week = weekStartIso(date);
      const items = scheduled.filter((c) => c.target_week === week);
      if (items.length === 0) return null;
      return (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {items.map((c) => (
            <li key={c.id} style={{ marginBlockEnd: 2 }}>
              <div
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(c);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    setSelected(c);
                  }
                }}
                style={{ cursor: 'pointer' }}
              >
                <Badge
                  status={c.status === 'shipped' ? 'success' : 'warning'}
                  text={
                    <span dir="auto" className="tq-ar" style={{ fontSize: 12 }}>
                      {c.title.length > 24 ? `${c.title.slice(0, 24)}…` : c.title}
                    </span>
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      );
    },
    [scheduled],
  );

  return (
    <div className="tq-page">
      <PageHeader
        title={t.nav.calendar}
        subtitle={tt(
          'ما اعتمدته وما نشرته، على الأسبوع الذي أعطيته له.',
          'What you approved and what you shipped, on the week you gave it.',
        )}
      />

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState error={error.message} hint={error.hint} onRetry={() => void load()} />
      ) : (
        <>
          <Space size="middle" style={{ marginBlockEnd: 12 }}>
            <Badge status="warning" text={tt('معتمدة', 'Approved')} />
            <Badge status="success" text={tt('منشورة', 'Shipped')} />
          </Space>

          {scheduled.length === 0 ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBlockEnd: 16 }}
              message={
                <span dir="auto">
                  {tt(
                    'التقويم فارغ حتى تُعطى فكرةٌ معتمدة أسبوعاً. حدّد الأسبوع المستهدف في شاشة الأفكار وستظهر هنا.',
                    'The calendar stays empty until an approved concept has a week. Set a target week on Concepts and it lands here.',
                  )}{' '}
                  <Link href="/concepts">{t.nav.concepts}</Link>
                </span>
              }
            />
          ) : null}

          <Calendar cellRender={cellRender} />
        </>
      )}

      <Drawer
        title={selected?.title}
        placement={isRTL ? 'left' : 'right'}
        width={520}
        open={selected !== null}
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <ConceptCard
              concept={selected}
              pillarName={pillarName(selected.pillar_id)}
              actions={{ onShip: openShip }}
            />
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t.common.account}>
                {selected.account === 'academy' ? t.common.academy : t.common.personal}
              </Descriptions.Item>
              <Descriptions.Item label={tt('الأسبوع المستهدف', 'Target week')}>
                {formatDate(selected.target_week, locale)}
              </Descriptions.Item>
              <Descriptions.Item label={tt('رابط النشر', 'Shipped URL')}>
                {selected.shipped_url ? (
                  <a href={selected.shipped_url} target="_blank" rel="noreferrer" dir="ltr">
                    {selected.shipped_url}
                  </a>
                ) : (
                  '—'
                )}
              </Descriptions.Item>
              <Descriptions.Item label={tt('التفاعل', 'Engagement')}>
                <span className="tq-num">{formatNumber(selected.shipped_engagement)}</span>
              </Descriptions.Item>
            </Descriptions>
          </Space>
        ) : null}
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
