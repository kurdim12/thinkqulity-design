'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Descriptions, List, Segmented, Tag, Typography } from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { useQuality } from '@/components/Providers';
import { apiGet, describeError } from '@/lib/client/api';
import { PageHeader, ErrorState, LoadingBlock } from '@/components/ui';

interface HealthCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface HealthResponse {
  operator: { id: string; email: string };
  allowlist: string[];
  checks: HealthCheck[];
  models: { standard: string; high: string };
  features: string[];
}

export default function SettingsPage() {
  const { t, tt } = useLocale();
  const { quality, setQuality } = useQuality();
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setHint(null);
    apiGet<HealthResponse>('/api/health')
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

  return (
    <div className="tq-page">
      <PageHeader
        title={t.nav.settings}
        subtitle={tt('إعدادات التشغيل وصحة البيئة.', 'Operating configuration and environment health.')}
      />

      <Card title={tt('نموذج التوليد', 'Generation model')}>
        <Segmented
          value={quality}
          onChange={(value) => setQuality(value as 'standard' | 'high')}
          options={[
            { label: t.header.standard, value: 'standard' },
            { label: t.header.high, value: 'high' },
          ]}
        />
        {loading ? (
          <LoadingBlock rows={2} />
        ) : error ? (
          <ErrorState error={error} hint={hint} onRetry={load} />
        ) : data ? (
          <Descriptions size="small" column={1} style={{ marginBlockStart: 16 }}>
            <Descriptions.Item label={t.header.standard}>
              <code dir="ltr">{data.models.standard}</code>
            </Descriptions.Item>
            <Descriptions.Item label={t.header.high}>
              <code dir="ltr">{data.models.high}</code>
            </Descriptions.Item>
          </Descriptions>
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBlockStart: 8 }}>
          {tt('يُطبَّق الاختيار على عملية التوليد التالية.', 'The choice applies to the next generation.')}
        </Typography.Text>
      </Card>

      <Card title={tt('قائمة المشغّلين المسموح لهم', 'Operator allowlist')} style={{ marginBlockStart: 16 }}>
        {loading ? (
          <LoadingBlock rows={3} />
        ) : error ? (
          <ErrorState error={error} hint={hint} onRetry={load} />
        ) : data ? (
          <>
            <List
              size="small"
              dataSource={data.allowlist}
              renderItem={(email) => (
                <List.Item>
                  <code dir="ltr">{email}</code>
                  {email === data.operator.email ? (
                    <Tag color="gold" style={{ marginInlineStart: 8 }}>
                      {tt('أنت', 'You')}
                    </Tag>
                  ) : null}
                </List.Item>
              )}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBlockStart: 8 }}>
              {tt(
                'تُضبط هذه القائمة عبر متغيّر البيئة ALLOWED_EMAILS وتتطلب إعادة تشغيل الخادم.',
                'This list is set via the ALLOWED_EMAILS environment variable and requires a server restart.',
              )}
            </Typography.Text>
          </>
        ) : null}
      </Card>

      <Card title={tt('فحوصات البيئة', 'Environment health')} style={{ marginBlockStart: 16 }}>
        {loading ? (
          <LoadingBlock rows={3} />
        ) : error ? (
          <ErrorState error={error} hint={hint} onRetry={load} />
        ) : data ? (
          <List
            size="small"
            dataSource={data.checks}
            renderItem={(check) => (
              <List.Item>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Badge status={check.ok ? 'success' : 'error'} text={check.label} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {check.detail}
                  </Typography.Text>
                </div>
              </List.Item>
            )}
          />
        ) : null}
      </Card>

      <Card title={tt('قدرات الوكيل', 'Agent features')} style={{ marginBlockStart: 16 }}>
        {loading ? (
          <LoadingBlock rows={2} />
        ) : error ? (
          <ErrorState error={error} hint={hint} onRetry={load} />
        ) : data ? (
          <>
            <div>
              {data.features.map((feature) => (
                <Tag key={feature}>{feature}</Tag>
              ))}
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBlockStart: 8 }}>
              {tt(
                'تُضاف القدرات بملف واحد في lib/agent/features ثم إدخال في السجل.',
                'Features are added with one file in lib/agent/features plus a registry entry.',
              )}
            </Typography.Text>
          </>
        ) : null}
      </Card>
    </div>
  );
}
