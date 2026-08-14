import { NextResponse } from 'next/server';
import { getOperator } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * "Is the session I just established an allowed operator?"
 *
 * The callback page establishes the session in the browser, then asks this.
 * A valid Supabase session for an address that is not on ALLOWED_EMAILS gets
 * 403 here and is signed straight back out.
 */
export async function GET() {
  const operator = await getOperator();
  if (!operator) {
    return NextResponse.json(
      { error: 'That address is not on the operator allowlist.' },
      { status: 403 },
    );
  }
  return NextResponse.json({ operator });
}
