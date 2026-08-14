import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { requireEnv } from '@/lib/env';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Server client bound to the request's cookies. Used to read *who is signed in*.
 * Application data is read/written through the admin client instead, so RLS can
 * stay deny-all.
 */
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Called from a Server Component — middleware already refreshed the
            // session, so this is safe to ignore.
          }
        },
      },
    },
  );
}
