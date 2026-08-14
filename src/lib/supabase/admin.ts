import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '@/lib/env';

let cached: SupabaseClient | null = null;

/**
 * Service-role client. SERVER ONLY — never import this from a 'use client' file.
 * Bypasses RLS, so every caller must already have passed `requireOperator()`.
 */
export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return cached;
}
