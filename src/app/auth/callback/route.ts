import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { supabaseServer } from '@/lib/supabase/server';
import { isAllowedEmail } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Completes a sign-in started from an emailed link.
 *
 * The Concepts screen's 6-digit code path is the primary flow, but Supabase's
 * stock email template sends a link rather than a code. This route accepts
 * either shape Supabase can redirect with — PKCE (`code`) or the hosted
 * verifier (`token_hash` + `type`) — so a link click works out of the box.
 *
 * The allowlist is re-checked here: a valid link for an address that is not an
 * operator must not produce a usable session.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  const next = url.searchParams.get('next');
  const destination = next && next.startsWith('/') ? next : '/dashboard';

  const fail = (message: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, url.origin));

  try {
    const supabase = await supabaseServer();

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) return fail(error.message);
    } else if (tokenHash && type) {
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) return fail(error.message);
    } else {
      return fail('That sign-in link is missing its token. Request a new code.');
    }

    const { data } = await supabase.auth.getUser();
    if (!isAllowedEmail(data.user?.email)) {
      await supabase.auth.signOut();
      return fail('That address is not on the operator allowlist.');
    }

    return NextResponse.redirect(new URL(destination, url.origin));
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Sign-in failed.');
  }
}
