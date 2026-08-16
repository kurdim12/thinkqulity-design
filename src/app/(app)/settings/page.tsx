'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Descriptions, Form, Input, List, Segmented, Tag, Typography, App } from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { useQuality } from '@/components/Providers';
import { apiGet, apiSend, describeError } from '@/lib/client/api';
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
  provider: 'anthropic' | 'openrouter';
  models: { standard: string; high: string };
  features: string[];
}

export default function SettingsPage() {
  const { t, tt } = useLocale();
  const { message } = App.useApp();
  const { quality, setQuality } = useQuality();
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);

  async function changePassword() {
    if (newPassword.length < 10) {
      message.error(
        tt('كلمة المرور الجديدة يجب ألا تقل عن ١٠ أحرف.', 'The new password must be at least 10 characters.'),
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      message.error(tt('كلمتا المرور غير متطابقتين.', 'The passwords do not match.'));
      return;
    }
    setPasswordBusy(true);
    try {
      await apiSend('/api/auth/change-password', 'POST', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      message.success(tt('تم تحديث كلمة المرور.', 'Password updated.'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      const desc = describeError(err);
      message.error(desc.message);
    } finally {
      setPasswordBusy(false);
    }
  }

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
        subtitle={tt(
          'أي نموذج يُستخدم، ومن يستطيع الدخول، وهل البيئة سليمة.',
          'Which model runs, who can sign in, and whether the environment is sound.',
        )}
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
            <Descriptions.Item label={tt('المزوّد', 'Provider')}>
              <code dir="ltr">{data.provider}</code>
            </Descriptions.Item>
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
          // The line under this list used to explain to the operator how a
          // developer adds a feature. He is not the one adding it.
          <div>
            {data.features.map((feature) => (
              <Tag key={feature}>{feature}</Tag>
            ))}
          </div>
        ) : null}
      </Card>

      <Card title={tt('كلمة المرور', 'Password')} style={{ marginBlockStart: 16 }}>
        <Form layout="vertical" onFinish={() => void changePassword()}>
          <Form.Item label={tt('كلمة المرور الحالية', 'Current password')}>
            <Input.Password
              dir="ltr"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </Form.Item>
          <Form.Item label={tt('كلمة المرور الجديدة', 'New password')}>
            <Input.Password
              dir="ltr"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Form.Item>
          <Form.Item label={tt('تأكيد كلمة المرور الجديدة', 'Confirm new password')}>
            <Input.Password
              dir="ltr"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={passwordBusy}
            disabled={!currentPassword || !newPassword || !confirmPassword}
          >
            {tt('حفظ', 'Save')}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
