/**
 * Setup doctor.  npm run doctor
 *
 * Verifies the things that silently fail later: env presence, that the
 * service-role key actually reaches the database, that the schema is applied,
 * and that the Brand Brain is seeded.
 *
 * Never prints a secret's value — only whether it is set and how long it is.
 *
 * The required/optional split and the "is this value safe to echo" allowlist
 * are IMPORTED from src/lib/env.ts rather than restated here, so this script
 * cannot drift from what the app actually reads. Reading that file needs Node's
 * type stripping, on by default from Node 22.18.
 *
 * Scope: this reads the .env.local of the machine it runs on. It answers "are
 * my bindings right HERE". It cannot see a deployed Worker's bindings — for
 * that, serve checkRequiredEnv() from an unauthenticated route and read it over
 * HTTP. Same function, same verdict, different process.
 */
import { createClient } from '@supabase/supabase-js';
import {
  allowedEmails,
  checkRequiredEnv,
  isEchoableEnv,
  optionalEnv,
} from '../src/lib/env.ts';

const TABLES = ['brand', 'snapshots', 'posts', 'pillars', 'concepts', 'campaigns', 'reports'];

let failures = 0;
const line = (marker, msg) => console.log(`  ${marker.padEnd(4)}  ${msg}`);
const pass = (msg) => line('ok', msg);
const fail = (msg) => {
  failures += 1;
  line('FAIL', msg);
};
/** Absent but optional. An em-dash, never a zero — nothing here is broken. */
const off = (msg) => line('—', msg);

/**
 * How a set value is displayed. Credentials never show their value; their
 * length is shown instead, which is enough to spot a truncated paste.
 */
function shown(key) {
  const value = optionalEnv(key);
  if (value === null) return 'not set';
  if (!isEchoableEnv(key)) return `set (${value.length} chars)`;
  if (key === 'ALLOWED_EMAILS') {
    const emails = allowedEmails();
    return `${emails.length} address(es): ${emails.join(', ')}`;
  }
  return value;
}

/* --------------------------------------------------------------- bindings -- */

const report = checkRequiredEnv();

console.log('\nEnvironment — required');

for (const status of report.required) {
  // `detail` already names the binding and, when it is missing, the exact
  // command that binds it. Never contains a value.
  if (status.ok) pass(`${status.key} — ${shown(status.key)}`);
  else fail(status.detail);
}

console.log('\nEnvironment — optional (absent means a feature is off, not a failure)');

for (const status of report.optional) {
  if (status.ok) pass(`${status.key} — ${shown(status.key)}`);
  // "bound but empty" is worth saying out loud: it means the line exists in
  // .env.local (or the secret exists on the Worker) with nothing in it.
  else if (status.blank) off(`${status.detail} · ${status.what}`);
  else off(`${status.key} — not set · ${status.what}`);
}

/* --------------------------------------------------------------- provider -- */

/**
 * Mirrors resolveProvider() in src/lib/agent/provider.ts exactly, including its
 * default: absence of configuration resolves to openrouter, and an AI_PROVIDER
 * that is set to something unrecognised is IGNORED rather than honoured.
 */
function resolveProvider() {
  const explicit = optionalEnv('AI_PROVIDER')?.toLowerCase();
  if (explicit === 'openrouter' || explicit === 'anthropic') return explicit;
  if (optionalEnv('ANTHROPIC_API_KEY') && !optionalEnv('OPENROUTER_API_KEY')) return 'anthropic';
  return 'openrouter';
}

console.log('\nModel provider');

const explicitProvider = optionalEnv('AI_PROVIDER')?.toLowerCase();
if (explicitProvider && explicitProvider !== 'openrouter' && explicitProvider !== 'anthropic') {
  fail(
    `AI_PROVIDER is set to an unrecognised value — the app ignores it silently and falls back. Use "openrouter" or "anthropic", or unset it.`,
  );
}

const provider = resolveProvider();
const keyName = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
const providerKey = optionalEnv(keyName);

if (providerKey) {
  pass(`${keyName} — set (${providerKey.length} chars); provider: ${provider}`);
} else {
  // Optional to BOOT, required to GENERATE. The app runs and stays honest
  // without it; every generation route fails until it is bound.
  fail(
    `resolved provider is "${provider}" but ${keyName} is not set — generation will fail. ` +
      `Set OPENROUTER_API_KEY (openrouter.ai/keys), the default provider, or ANTHROPIC_API_KEY with AI_PROVIDER=anthropic.`,
  );
}

/* --------------------------------------------------------------- database -- */

const url = optionalEnv('NEXT_PUBLIC_SUPABASE_URL');
const serviceKey = optionalEnv('SUPABASE_SERVICE_ROLE_KEY');

if (url && serviceKey) {
  console.log('\nDatabase (via service-role key)');
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  for (const table of TABLES) {
    const { error } = await db.from(table).select('*', { count: 'exact', head: true });
    if (error) fail(`table "${table}" — ${error.message}`);
    else pass(`table "${table}" reachable`);
  }

  const { data: brand, error: brandError } = await db
    .from('brand')
    .select('facts, palette, voice_examples, status')
    .eq('id', 1)
    .maybeSingle();

  console.log('\nBrand Brain');
  if (brandError) {
    fail(`could not read the brand row — ${brandError.message}`);
  } else if (!brand) {
    fail('brand row is missing — run: npm run seed');
  } else {
    const facts = Array.isArray(brand.facts) ? brand.facts.length : 0;
    facts > 0 ? pass(`${facts} seeded facts`) : fail('no facts — run: npm run seed');

    const unsourced = (Array.isArray(brand.facts) ? brand.facts : []).filter((f) => !f?.source);
    unsourced.length === 0
      ? pass('every fact carries a source')
      : fail(`${unsourced.length} fact(s) with no source — the provenance guarantee is broken`);

    pass(`status: ${brand.status}${brand.status === 'seed' ? ' (expected until a palette is saved)' : ''}`);
    pass(`palette: ${brand.palette ? 'set' : 'empty (expected until assets land)'}`);
    pass(`voice examples: ${Array.isArray(brand.voice_examples) ? brand.voice_examples.length : 0}`);
  }
} else {
  console.log('\nDatabase\n  skipped — URL or service-role key missing');
}

/* ---------------------------------------------------------------- summary -- */

if (!report.ok) {
  console.log(`\n${report.message}`);
}

if (report.degraded.length > 0) {
  console.log(
    `\n${report.degraded.length} optional binding(s) absent: ${report.degraded.join(', ')}`,
  );
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
