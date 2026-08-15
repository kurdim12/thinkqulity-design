import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireEnv } from '@/lib/env';
import { requireOperator, errorResponse, HttpError } from '@/lib/auth';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const MIN_PASSWORD_LENGTH = 10;

/**
 * Lets a signed-in operator change their own password.
 *
 * 1. requireOperator() — must already be signed in.
 * 2. Re-verify current_password with a FRESH, non-persisting anon client
 *    (not the request's session-bound client) so a stolen session cookie
 *    alone cannot rotate the password without the current one.
 * 3. Only then does the service-role admin client update it.
 */
export async function POST(request: Request) {
  try {
    const operator = await requireOperator();

    const body: unknown = await request.json().catch(() => ({}));
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const currentPassword = typeof record.current_password === 'string' ? record.current_password : '';
    const newPassword = typeof record.new_password === 'string' ? record.new_password : '';

    if (currentPassword.length === 0) {
      throw new HttpError(400, 'Enter your current password.');
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const verifier = createClient(
      requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
      requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
      { auth: { persistSession: false } },
    );

    const { error: verifyError } = await verifier.auth.signInWithPassword({
      email: operator.email,
      password: currentPassword,
    });

    if (verifyError) {
      throw new HttpError(401, 'Current password is incorrect.');
    }

    const { error: updateError } = await supabaseAdmin().auth.admin.updateUserById(operator.id, {
      password: newPassword,
    });

    if (updateError) {
      throw new HttpError(502, `Supabase could not update the password: ${updateError.message}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
