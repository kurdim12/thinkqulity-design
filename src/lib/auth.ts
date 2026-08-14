import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';
import { isAllowedEmail } from '@/lib/env';

export interface Operator {
  id: string;
  email: string;
}

/** Returns the signed-in, allow-listed operator, or null. */
export async function getOperator(): Promise<Operator | null> {
  try {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.email) return null;
    if (!isAllowedEmail(data.user.email)) return null;
    return { id: data.user.id, email: data.user.email };
  } catch {
    // Supabase env missing — treated as "not signed in" so the app can still
    // build and render the login screen with a configuration warning.
    return null;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly hint?: string;

  // Fields are assigned explicitly rather than via parameter properties so the
  // module also runs under Node's strip-only TypeScript loader.
  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.hint = hint;
  }
}

/** Route-handler gate. Throws HttpError(401) when the caller isn't an operator. */
export async function requireOperator(): Promise<Operator> {
  const operator = await getOperator();
  if (!operator) {
    throw new HttpError(401, 'Not signed in, or this email is not on the allowlist.');
  }
  return operator;
}

/** Turns thrown errors into the JSON error envelope every route uses. */
export function errorResponse(err: unknown) {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message, hint: err.hint ?? null }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : 'Unexpected server error.';
  return NextResponse.json({ error: message, hint: null }, { status: 500 });
}
