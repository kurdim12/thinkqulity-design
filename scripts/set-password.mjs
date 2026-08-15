/**
 * Sets (or resets) an operator's password locally.
 *
 *   node --env-file=.env.local scripts/set-password.mjs
 *
 * Reads SET_PASSWORD_EMAIL and SET_PASSWORD_VALUE from the environment —
 * never from a CLI argument, so the password never lands in shell history.
 *
 * Safe because it is a local script: it needs the service-role key from
 * .env.local, which is git-ignored and never leaves this machine. It is
 * deliberately NOT an HTTP endpoint.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const email = process.env.SET_PASSWORD_EMAIL?.trim().toLowerCase();
const password = process.env.SET_PASSWORD_VALUE;

if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

if (!email || !password) {
  console.error('Usage:');
  console.error('  SET_PASSWORD_EMAIL=you@example.com SET_PASSWORD_VALUE=... \\');
  console.error('    node --env-file=.env.local scripts/set-password.mjs');
  console.error('');
  console.error('Both SET_PASSWORD_EMAIL and SET_PASSWORD_VALUE must be set. The password is');
  console.error('read from the environment, never from a CLI argument, to keep it out of shell');
  console.error('history.');
  process.exit(1);
}

const allowed = (process.env.ALLOWED_EMAILS ?? '')
  .split(/[,\s]+/)
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.includes('@'));

if (!allowed.includes(email)) {
  console.error(`"${email}" is not in ALLOWED_EMAILS, so the app would reject it anyway.`);
  console.error(`Allowed: ${allowed.join(', ')}`);
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data: existing } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
const found = existing?.users?.find((u) => u.email?.toLowerCase() === email);

let userId = found?.id;

if (!userId) {
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (createError || !created?.user) {
    console.error(`Could not create the operator user: ${createError?.message ?? 'unknown error'}`);
    process.exit(1);
  }
  userId = created.user.id;
  console.log(`Created operator user ${email}.`);
}

const { error: updateError } = await db.auth.admin.updateUserById(userId, { password });

if (updateError) {
  console.error(`Could not set the password: ${updateError.message}`);
  process.exit(1);
}

console.log(email);
console.log('password set');
