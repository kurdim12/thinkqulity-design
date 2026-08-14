import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireEnv, isAllowedEmail, allowedEmails } from '@/lib/env';
import { errorResponse, HttpError } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Sends a one-time sign-in code. The allowlist is enforced here, server-side,
 * before Supabase is ever asked to send anything — an address that is not on
 * ALLOWED_EMAILS never receives a code.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const email =
      typeof body === 'object' && body !== null && 'email' in body
        ? String((body as { email: unknown }).email ?? '')
        : '';

    if (!email.includes('@')) {
      throw new HttpError(400, 'Enter a valid email address.');
    }

    if (allowedEmails().length === 0) {
      throw new HttpError(
        503,
        'No operators are configured.',
        'Set ALLOWED_EMAILS in .env.local, then restart the server.',
      );
    }

    if (!isAllowedEmail(email)) {
      // Deliberately specific: this is a single-operator internal tool, not a
      // public sign-up, so telling the operator their address is not listed is
      // more useful than a vague failure.
      throw new HttpError(403, 'That address is not on the operator allowlist.');
    }

    const supabase = createClient(
      requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
      requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
      { auth: { persistSession: false } },
    );

    // Point any emailed link at our callback route rather than the bare site
    // root, which has nothing to exchange the token with.
    const origin = new URL(request.url).origin;

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: true, emailRedirectTo: `${origin}/auth/callback` },
    });

    if (error) throw new HttpError(502, `Supabase could not send the code: ${error.message}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
