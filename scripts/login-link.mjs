/**
 * Mints a sign-in link locally.  npm run login
 *
 * Supabase's built-in SMTP is capped at a couple of auth emails per hour — it
 * exists for testing, not for use. This asks the Admin API to generate the same
 * link it would have emailed and prints it instead, so sign-in never depends on
 * mail delivery at all.
 *
 * Safe because it is a local script: it needs the service-role key from
 * .env.local, which is git-ignored and never leaves this machine. It is
 * deliberately NOT an HTTP endpoint — one that handed out sign-in links on
 * request would be a complete authentication bypass.
 *
 *   npm run login                  → first address in ALLOWED_EMAILS
 *   npm run login -- me@you.com    → a specific allow-listed address
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const allowed = (process.env.ALLOWED_EMAILS ?? '')
  .split(/[,\s]+/)
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.includes('@'));

if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

if (allowed.length === 0) {
  console.error('ALLOWED_EMAILS is empty — there is no operator to sign in as.');
  process.exit(1);
}

const requested = (process.argv[2] ?? allowed[0]).trim().toLowerCase();

if (!allowed.includes(requested)) {
  console.error(`"${requested}" is not in ALLOWED_EMAILS, so the app would reject it anyway.`);
  console.error(`Allowed: ${allowed.join(', ')}`);
  process.exit(1);
}

const port = process.env.PORT ?? '3000';
const redirectTo = `http://localhost:${port}/auth/callback`;

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

// The user may not exist yet on a fresh project; magiclink requires one.
const { data: existing } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
const found = existing?.users?.some((u) => u.email?.toLowerCase() === requested);

if (!found) {
  const { error: createError } = await db.auth.admin.createUser({
    email: requested,
    email_confirm: true,
  });
  if (createError) {
    console.error(`Could not create the operator user: ${createError.message}`);
    process.exit(1);
  }
  console.log(`Created operator user ${requested}.`);
}

const { data, error } = await db.auth.admin.generateLink({
  type: 'magiclink',
  email: requested,
  options: { redirectTo },
});

if (error) {
  console.error(`Could not generate a sign-in link: ${error.message}`);
  process.exit(1);
}

const link = data?.properties?.action_link;
if (!link) {
  console.error('Supabase returned no action_link.');
  process.exit(1);
}

console.log(`\nSign-in link for ${requested} — open it in your browser:\n`);
console.log(link);
console.log('\nSingle use, expires in about an hour. No email was sent.\n');
