import { NextResponse } from 'next/server';
import { isAllowedEmail, allowedEmails } from '@/lib/env';
import { errorResponse, HttpError } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * This route exists so the operator allowlist is enforced server-side BEFORE
 * the browser ever calls Supabase with a password. It does not sign anyone
 * in — the service-role client used elsewhere in this app cannot set the
 * browser's session cookie, so that call has to happen client-side against
 * supabaseBrowser(). This route's only job is to confirm the address is
 * permitted; the client only proceeds to call signInWithPassword() after
 * this returns { ok: true }, so the allowlist can never be bypassed by
 * calling Supabase directly.
 *
 * If Supabase later rejects the browser's signInWithPassword() call with
 * "Email logins are disabled" or "Signups not allowed", that is dashboard
 * configuration, not something to fix in code: Supabase dashboard ->
 * Authentication -> Providers -> Email -> enable password-based sign-in.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => ({}));
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const email = typeof record.email === 'string' ? record.email : '';
    const password = typeof record.password === 'string' ? record.password : '';

    if (!email.includes('@')) {
      throw new HttpError(400, 'Enter a valid email address.');
    }

    if (password.length === 0) {
      throw new HttpError(400, 'Enter a password.');
    }

    if (allowedEmails().length === 0) {
      throw new HttpError(
        503,
        'No operators are configured.',
        'Set ALLOWED_EMAILS in .env.local, then restart the server.',
      );
    }

    // The allowlist check — the load-bearing line the browser's later
    // signInWithPassword() call depends on already having passed.
    if (!isAllowedEmail(email)) {
      // Same wording as an invalid password (see LoginForm.tsx) so the
      // response never reveals whether an address exists or is allowed.
      throw new HttpError(401, 'Incorrect email or password.');
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
