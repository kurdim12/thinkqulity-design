'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Card, Form, Input, Segmented, Typography, App } from 'antd';
import { MailOutlined, NumberOutlined } from '@ant-design/icons';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { apiSend, describeError } from '@/lib/client/api';
import { GOLD } from '@/lib/theme';

export function LoginForm({ missingEnv }: { missingEnv: string[] }) {
  const { t, tt, locale, setLocale } = useLocale();
  const { message } = App.useApp();
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const configured = missingEnv.length === 0;

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      await apiSend('/api/auth/otp', 'POST', { email });
      setStep('code');
      message.success(tt('أرسلنا رمزًا إلى بريدك.', 'We sent a code to your inbox.'));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    setBusy(true);
    setError(null);
    try {
      const { error: authError } = await supabaseBrowser().auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: code.trim(),
        type: 'email',
      });
      if (authError) throw new Error(authError.message);
      const next = params.get('next');
      router.replace(next && next.startsWith('/') ? next : '/dashboard');
      router.refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tq-login">
      <Card style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBlockEnd: 18 }}>
          <div>
            <div style={{ color: GOLD, fontWeight: 700, fontSize: 17 }}>{t.appName}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.byline}
            </Typography.Text>
          </div>
          <div className="tq-inline-end">
            <Segmented
              size="small"
              value={locale}
              onChange={(v) => setLocale(v as 'en' | 'ar')}
              options={[
                { label: 'EN', value: 'en' },
                { label: 'عربي', value: 'ar' },
              ]}
            />
          </div>
        </div>

        {!configured && (
          <Alert
            type="error"
            showIcon
            style={{ marginBlockEnd: 16 }}
            message={tt('الإعداد غير مكتمل', 'Setup incomplete')}
            description={
              <>
                <div>
                  {tt(
                    'المتغيّرات التالية غير مضبوطة في .env.local:',
                    'These environment variables are not set in .env.local:',
                  )}
                </div>
                <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
                  {missingEnv.map((key) => (
                    <li key={key}>
                      <code>{key}</code>
                    </li>
                  ))}
                </ul>
              </>
            }
          />
        )}

        {error && (
          <Alert
            type="error"
            showIcon
            style={{ marginBlockEnd: 16 }}
            message={error.message}
            description={error.hint}
          />
        )}

        {step === 'email' ? (
          <Form layout="vertical" onFinish={() => void sendCode()}>
            <Form.Item
              label={tt('البريد الإلكتروني للمشغّل', 'Operator email')}
              required
              help={tt(
                'العناوين المدرجة في ALLOWED_EMAILS فقط تستطيع الدخول.',
                'Only addresses listed in ALLOWED_EMAILS can sign in.',
              )}
            >
              <Input
                size="large"
                dir="ltr"
                autoComplete="email"
                inputMode="email"
                prefix={<MailOutlined />}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={!configured}
              />
            </Form.Item>
            <Button
              type="primary"
              size="large"
              block
              htmlType="submit"
              loading={busy}
              disabled={!configured || !email.includes('@')}
            >
              {tt('أرسل رمز الدخول', 'Send sign-in code')}
            </Button>
          </Form>
        ) : (
          <Form layout="vertical" onFinish={() => void verifyCode()}>
            <Form.Item
              label={tt('الرمز المكوّن من ٦ أرقام', '6-digit code')}
              help={tt(`أُرسل إلى ${email}`, `Sent to ${email}`)}
              required
            >
              <Input
                size="large"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                prefix={<NumberOutlined />}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
              />
            </Form.Item>
            <Button
              type="primary"
              size="large"
              block
              htmlType="submit"
              loading={busy}
              disabled={code.trim().length < 6}
            >
              {tt('تسجيل الدخول', 'Sign in')}
            </Button>
            <Button
              type="link"
              block
              style={{ marginBlockStart: 8 }}
              onClick={() => {
                setStep('email');
                setCode('');
                setError(null);
              }}
            >
              {tt('استخدام بريد آخر', 'Use a different email')}
            </Button>
          </Form>
        )}
      </Card>
    </div>
  );
}
