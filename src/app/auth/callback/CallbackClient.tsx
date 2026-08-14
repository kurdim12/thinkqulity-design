'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, Spin, Alert, Button, Typography } from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { supabaseBrowser } from '@/lib/supabase/browser';
import { GOLD } from '@/lib/theme';

/**
 * Completes a sign-in started from an emailed link.
 *
 * Supabase can hand the session back in three different shapes depending on
 * the flow and the email template, and only one of them is visible to the
 * server:
 *
 *   #access_token=…&refresh_token=…   implicit — URL fragment, browser only
 *   ?code=…                           PKCE
 *   ?token_hash=…&type=…              hosted verifier
 *
 * The stock template produces the first, which is why this runs in the browser
 * rather than in a route handler. All three are handled so the link works
 * whatever the project's template is set to.
 */
export function CallbackClient() {
  const { tt } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  // React 18+ runs effects twice in dev; the token is single-use, so guard it.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    void (async () => {
      const supabase = supabaseBrowser();

      const hash = window.location.hash.replace(/^#/, '');
      const fragment = new URLSearchParams(hash);
      const accessToken = fragment.get('access_token');
      const refreshToken = fragment.get('refresh_token');
      const fragmentError = fragment.get('error_description') ?? fragment.get('error');

      const code = params.get('code');
      const tokenHash = params.get('token_hash');
      const type = params.get('type');
      const queryError = params.get('error_description') ?? params.get('error');

      try {
        if (fragmentError || queryError) {
          setError(fragmentError ?? queryError);
          return;
        }

        if (accessToken && refreshToken) {
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (sessionError) throw new Error(sessionError.message);
        } else if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw new Error(exchangeError.message);
        } else if (tokenHash && type) {
          const { error: otpError } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: type as 'magiclink' | 'email' | 'signup' | 'recovery' | 'invite',
          });
          if (otpError) throw new Error(otpError.message);
        } else {
          // supabase-js parses the fragment on init (detectSessionInUrl) and
          // may already have consumed it, leaving nothing for us to read. A
          // live session means the link worked — don't call that a failure.
          const { data } = await supabase.auth.getSession();
          if (!data.session) {
            setError(
              tt(
                'هذا الرابط لا يحتوي على رمز دخول. اطلب رابطًا جديدًا.',
                'That link carries no sign-in token. Request a new one.',
              ),
            );
            return;
          }
        }

        // Session exists — but a session is not the same as being an operator.
        const check = await fetch('/api/auth/me', { cache: 'no-store' });
        if (!check.ok) {
          await supabase.auth.signOut();
          const body = (await check.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? tt('غير مصرّح لهذا العنوان.', 'That address is not authorised.'));
          return;
        }

        const next = params.get('next');
        router.replace(next && next.startsWith('/') ? next : '/dashboard');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed.');
      }
    })();
  }, [params, router, tt]);

  return (
    <div className="tq-login">
      <Card style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
        <div style={{ color: GOLD, fontWeight: 700, fontSize: 17, marginBlockEnd: 16 }}>
          ThinkQuality Studio
        </div>

        {error ? (
          <>
            <Alert type="error" showIcon message={error} style={{ marginBlockEnd: 16 }} />
            <Button type="primary" block onClick={() => router.replace('/login')}>
              {tt('العودة لتسجيل الدخول', 'Back to sign in')}
            </Button>
          </>
        ) : (
          <>
            <Spin size="large" />
            <Typography.Paragraph type="secondary" style={{ marginBlockStart: 16, marginBlockEnd: 0 }}>
              {tt('جارٍ إتمام تسجيل الدخول…', 'Completing sign-in…')}
            </Typography.Paragraph>
          </>
        )}
      </Card>
    </div>
  );
}
