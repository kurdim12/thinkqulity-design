'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, Button, Card, Form, Input, Segmented, Typography, App } from 'antd';
import { MailOutlined, NumberOutlined, LockOutlined } from '@ant-design/icons';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { apiSend, describeError, ApiCallError } from '@/lib/client/api';
import { GOLD } from '@/lib/theme';

// Same wording on every path (bad password, unknown email, disallowed email)
// so the UI never reveals which case actually happened.
const BAD_CREDENTIALS = {
  ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
  en: 'Incorrect email or password.',
};

export function LoginForm({ missingEnv }: { missingEnv: string[] }) {
  const { t, tt, locale, setLocale } = useLocale();
  const { message } = App.useApp();
  const router = useRouter();
  const params = useSearchParams();

  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // A failed link click redirects back here with ?error=…
  const linkError = params.get('error');
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(
    linkError ? { message: linkError, hint: null } : null,
  );

  const configured = missingEnv.length === 0;

  function redirectAfterSignIn() {
    const next = params.get('next');
    router.replace(next && next.startsWith('/') ? next : '/dashboard');
    router.refresh();
  }

  async function signInWithPassword() {
    setBusy(true);
    setError(null);
    try {
      const trimmedEmail = email.trim().toLowerCase();
      // The allowlist is enforced server-side FIRST, by a route that never
      // touches Supabase's password check. Only once that returns { ok: true }
      // does the browser call Supabase directly — so the allowlist can never
      // be bypassed by calling signInWithPassword() without going through
      // this check first.
      await apiSend('/api/auth/password', 'POST', { email: trimmedEmail, password });

      const { error: authError } = await supabaseBrowser().auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });
      if (authError) {
        // Same wording as the allowlist rejection below — a wrong password
        // must not be distinguishable from an unlisted or unknown email.
        setError({ message: tt(BAD_CREDENTIALS.ar, BAD_CREDENTIALS.en), hint: null });
        return;
      }
      redirectAfterSignIn();
    } catch (err) {
      // A 401 from /api/auth/password is the allowlist rejection; show the
      // same generic wording a bad password gets. Any other status (400
      // bad input, 503 unconfigured) is a real setup problem worth surfacing
      // as-is.
      if (err instanceof ApiCallError && err.status === 401) {
        setError({ message: tt(BAD_CREDENTIALS.ar, BAD_CREDENTIALS.en), hint: null });
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  }

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
      redirectAfterSignIn();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function switchToOtp() {
    setMode('otp');
    setStep('email');
    setError(null);
  }

  function switchToPassword() {
    setMode('password');
    setCode('');
    setError(null);
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

        {mode === 'password' ? (
          <Form layout="vertical" onFinish={() => void signInWithPassword()}>
            <Form.Item label={tt('البريد الإلكتروني للمشغّل', 'Operator email')} required>
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
            <Form.Item label={tt('كلمة المرور', 'Password')} required>
              <Input.Password
                size="large"
                dir="ltr"
                autoComplete="current-password"
                prefix={<LockOutlined />}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={!configured}
              />
            </Form.Item>
            <Button
              type="primary"
              size="large"
              block
              htmlType="submit"
              loading={busy}
              disabled={!configured || !email.includes('@') || password.length === 0}
            >
              {tt('تسجيل الدخول', 'Sign in')}
            </Button>
            <Button type="link" block style={{ marginBlockStart: 8 }} onClick={switchToOtp}>
              {tt('الدخول برمز بدلاً من ذلك', 'Sign in with a code instead')}
            </Button>
          </Form>
        ) : step === 'email' ? (
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
            <Button type="link" block style={{ marginBlockStart: 8 }} onClick={switchToPassword}>
              {tt('الدخول بكلمة المرور', 'Sign in with a password instead')}
            </Button>
          </Form>
        ) : (
          <Form layout="vertical" onFinish={() => void verifyCode()}>
            <Alert
              type="success"
              showIcon
              style={{ marginBlockEnd: 16 }}
              message={tt('تفقّد بريدك', 'Check your email')}
              description={
                <>
                  {tt('أرسلنا رسالة إلى ', 'We sent a message to ')}
                  <strong dir="ltr">{email}</strong>.{' '}
                  {tt(
                    'اضغط الرابط داخلها لتسجيل الدخول — هذا كل المطلوب.',
                    'Click the link inside it to sign in — that is all you need to do.',
                  )}
                </>
              }
            />

            <Form.Item
              label={tt('أو الصق الرمز المكوّن من ٦ أرقام', 'Or paste the 6-digit code')}
              help={tt(
                'يظهر الرمز فقط إذا كان قالب البريد يتضمّن {{ .Token }}.',
                'A code only appears if the email template includes {{ .Token }}.',
              )}
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
            <Button type="link" block onClick={switchToPassword}>
              {tt('الدخول بكلمة المرور', 'Sign in with a password instead')}
            </Button>
          </Form>
        )}
      </Card>
    </div>
  );
}
