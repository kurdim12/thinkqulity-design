'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client — used only for the auth handshake (send OTP is
 * server-side; verifying the code here is what writes the session cookie that
 * the server reads). It never touches application tables: RLS denies the anon
 * key everything.
 */
export function supabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  return createBrowserClient(url, key);
}
