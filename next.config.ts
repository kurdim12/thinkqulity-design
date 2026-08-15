import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * The two Supabase values the BROWSER needs. Both are public by design: the URL
 * is the project's address and the anon key is a JWT whose role is `anon` — a
 * key that RLS (deny-all on every table) grants nothing to. They ship in the
 * client bundle regardless; declaring them here just makes the inlining not
 * depend on the build machine's environment.
 *
 * Why here and not only in the host's build variables: on 2026-08-15 the
 * Cloudflare Workers Builds run compiled `undefined` into the client bundle
 * because the values were not present while `next build` ran — the dashboard
 * has separate build-time and runtime variable sections and the two are easy to
 * confuse. A build-machine env var still wins if set (`process.env.X ?? literal`),
 * so a different Supabase project is one env var away; the literal is the floor.
 *
 * NEVER put a secret here. This file is tracked, and Next inlines `env` entries
 * into public JavaScript. The service-role key does not belong within a mile.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://ftqzykrweiwbrsnogniz.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ0cXp5a3J3ZWl3YnJzbm9nbml6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MTc5NjUsImV4cCI6MjEwMjI5Mzk2NX0.AfcYqPdxhN_Fw9L7hRsYa6ZC8ZTAYegMEuf8w3f3MmY';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
  },
  // A stray lockfile in the user profile makes Next guess the wrong workspace
  // root; pin it to this project.
  outputFileTracingRoot: path.join(__dirname),
  // antd v5 ships untranspiled ESM helpers; this keeps the server bundle happy.
  transpilePackages: ['antd', '@ant-design/icons', 'rc-util', 'rc-pagination', 'rc-picker'],
  experimental: {
    // Keeps antd's per-component CSS-in-JS extraction fast in dev.
    optimizePackageImports: ['antd', '@ant-design/icons'],
  },
};

export default nextConfig;
