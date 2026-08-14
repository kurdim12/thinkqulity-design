import { NextResponse } from 'next/server';
import { requireOperator, errorResponse } from '@/lib/auth';
import { hasEnv, allowedEmails, optionalEnv } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { modelFor } from '@/lib/agent/client';
import { featureIds } from '@/lib/agent/features/registry';

export const dynamic = 'force-dynamic';

export interface HealthCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** Powers the Settings screen's env badges. Never returns a secret's value. */
export async function GET() {
  try {
    const operator = await requireOperator();

    const checks: HealthCheck[] = [
      {
        key: 'ANTHROPIC_API_KEY',
        label: 'Anthropic API key',
        ok: hasEnv('ANTHROPIC_API_KEY'),
        detail: hasEnv('ANTHROPIC_API_KEY') ? 'Present' : 'Missing — generation will fail',
      },
      {
        key: 'NEXT_PUBLIC_SUPABASE_URL',
        label: 'Supabase URL',
        ok: hasEnv('NEXT_PUBLIC_SUPABASE_URL'),
        detail: optionalEnv('NEXT_PUBLIC_SUPABASE_URL') ?? 'Missing',
      },
      {
        key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
        label: 'Supabase anon key',
        ok: hasEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
        detail: hasEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY') ? 'Present' : 'Missing',
      },
      {
        key: 'SUPABASE_SERVICE_ROLE_KEY',
        label: 'Supabase service-role key',
        ok: hasEnv('SUPABASE_SERVICE_ROLE_KEY'),
        detail: hasEnv('SUPABASE_SERVICE_ROLE_KEY') ? 'Present' : 'Missing — all data reads fail',
      },
      {
        key: 'ALLOWED_EMAILS',
        label: 'Operator allowlist',
        ok: allowedEmails().length > 0,
        detail:
          allowedEmails().length > 0
            ? `${allowedEmails().length} address(es) configured`
            : 'Empty — nobody can sign in',
      },
    ];

    let dbOk = false;
    let dbDetail = 'Not reachable';
    try {
      const { error } = await supabaseAdmin().from('brand').select('id').limit(1);
      dbOk = !error;
      dbDetail = error ? error.message : 'Schema reachable';
    } catch (err) {
      dbDetail = err instanceof Error ? err.message : 'Unknown error';
    }
    checks.push({ key: 'database', label: 'Database', ok: dbOk, detail: dbDetail });

    return NextResponse.json({
      operator,
      allowlist: allowedEmails(),
      checks,
      models: { standard: modelFor('standard'), high: modelFor('high') },
      features: featureIds(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
