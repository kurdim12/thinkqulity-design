/**
 * Setup doctor.  npm run doctor
 *
 * Verifies the things that silently fail later: env presence, that the
 * service-role key actually reaches the database, that the schema is applied,
 * and that the Brand Brain is seeded.
 *
 * Never prints a secret's value — only whether it is set and how long it is.
 */
import { createClient } from '@supabase/supabase-js';

const TABLES = ['brand', 'snapshots', 'posts', 'pillars', 'concepts', 'campaigns', 'reports'];

let failures = 0;
const pass = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  FAIL  ${msg}`);
};

function present(key) {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
}

console.log('\nEnvironment');

for (const key of [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ALLOWED_EMAILS',
]) {
  const value = present(key);
  if (value) {
    pass(`${key} — ${key.includes('KEY') ? `set (${value.length} chars)` : value}`);
  } else {
    fail(`${key} is not set`);
  }
}

const openrouter = present('OPENROUTER_API_KEY');
const anthropic = present('ANTHROPIC_API_KEY');
const provider =
  present('AI_PROVIDER')?.toLowerCase() ?? (openrouter ? 'openrouter' : anthropic ? 'anthropic' : null);

if (provider === 'openrouter' && openrouter) {
  pass(`OPENROUTER_API_KEY — set (${openrouter.length} chars); provider: openrouter`);
} else if (provider === 'anthropic' && anthropic) {
  pass(`ANTHROPIC_API_KEY — set (${anthropic.length} chars); provider: anthropic`);
} else {
  fail('No model provider key set — generation will fail. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY.');
}

const url = present('NEXT_PUBLIC_SUPABASE_URL');
const serviceKey = present('SUPABASE_SERVICE_ROLE_KEY');

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

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
