/**
 * Demo preflight.  npm run demo:check
 *
 * Red means do not demo. Every failure names the fix, because a checklist that
 * only says "no" gets ignored five minutes before a pitch.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, fix) => {
  failures += 1;
  console.log(`  FAIL  ${label}\n        fix: ${fix}`);
};

console.log('\nDemo preflight\n');

/* ------------------------------------------------------------- config --- */
const openrouter = process.env.OPENROUTER_API_KEY?.trim();
const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
const provider = (process.env.AI_PROVIDER ?? (openrouter ? 'openrouter' : anthropic ? 'anthropic' : '')).toLowerCase();

if (!provider) {
  bad('Model provider key', 'set OPENROUTER_API_KEY in .env.local (openrouter.ai/keys) and add credit');
} else {
  // A key that is present but rejected is worse than one that is absent,
  // because it fails in front of the client rather than here.
  let live = false;
  let detail = '';
  try {
    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { authorization: `Bearer ${openrouter}` },
      });
      live = res.ok;
      detail = res.ok ? 'key accepted by OpenRouter' : `OpenRouter returned ${res.status}`;
    } else {
      live = Boolean(anthropic);
      detail = 'key present (not called)';
    }
  } catch (err) {
    detail = err.message;
  }
  live ? ok('Model provider key', detail) : bad('Model provider key', `key rejected — ${detail}`);
}

if (!url || !serviceKey) {
  bad('Supabase credentials', 'fill NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  console.log(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

/* --------------------------------------------------------------- data --- */
const [{ count: posts }, { count: analyzed }, { count: canonChunks }] = await Promise.all([
  db.from('posts').select('id', { count: 'exact', head: true }),
  db.from('post_analyses').select('id', { count: 'exact', head: true }),
  db.from('canon_chunks').select('id', { count: 'exact', head: true }),
]);

posts > 0
  ? ok('Posts ingested', `${posts}`)
  : bad('Posts ingested', 'run the monitor on the Data screen, or upload an Apify export');

if (posts > 0 && analyzed >= posts) {
  ok('Board analysed', `${analyzed}/${posts}`);
} else {
  bad(
    'Board analysed',
    `${analyzed}/${posts} — open /board and run "Analyze all" until it reads complete`,
  );
}

canonChunks > 0
  ? ok('Canon ingested', `${canonChunks} chunks`)
  : bad('Canon ingested', 'npm run ingest:canon -- ./refs/guideline-anatomy.md --kind internal');

/* ---------------------------------------------------------- guideline --- */
const { data: guidelines } = await db
  .from('brand_guidelines')
  .select('version, status')
  .order('version', { ascending: false })
  .limit(1);

const latest = guidelines?.[0];
if (latest?.status === 'approved') ok('Guideline approved', `v${latest.version}`);
else if (latest) bad('Guideline approved', `v${latest.version} is a draft — approve it on /guideline`);
else bad('Guideline approved', 'generate one on /guideline, then approve it');

/* ------------------------------------------------------------ bakeoff --- */
const { data: winner } = await db
  .from('bakeoff_runs')
  .select('model, created_at')
  .eq('task', 'default_model')
  .order('created_at', { ascending: false })
  .limit(1);

winner?.[0]
  ? ok('Bake-off winner set', `${winner[0].model}`)
  : bad(
      'Bake-off winner set',
      'npm run bakeoff, grade the blind outputs, then record the winner — the default model must be chosen, not inherited',
    );

/* -------------------------------------------------------------- brand --- */
const { data: brand } = await db
  .from('brand')
  .select('status, palette, voice_examples, knowledge, assets')
  .eq('id', 1)
  .maybeSingle();

brand?.status === 'live'
  ? ok('Brand is live', `${Object.keys(brand.palette?.swatches ?? {}).length} swatches`)
  : bad('Brand is live', 'save a palette in Brand Brain → Identity');

(brand?.voice_examples?.length ?? 0) > 0
  ? ok('Voice examples', `${brand.voice_examples.length}`)
  : bad('Voice examples', 'the register check needs real captions — see Brand Brain → Voice');

/* --------------------------------------------------- the WOW path data --- */
const { data: topPost } = await db
  .from('posts')
  .select('engagement, caption')
  .order('engagement', { ascending: false })
  .limit(1);

topPost?.[0]
  ? ok('Hero post present', `${topPost[0].engagement.toLocaleString('en-US')} engagement`)
  : bad('Hero post present', 'the Board opener needs at least one post — ingest data');

const { count: checks } = await db
  .from('compliance_checks')
  .select('id', { count: 'exact', head: true });

checks > 0
  ? ok('Compliance rehearsed', `${checks} previous check(s) — the WOW path has been run`)
  : bad('Compliance rehearsed', 'run the off-brand paste through /compliance at least once before demoing');

const { count: concepts } = await db.from('concepts').select('id', { count: 'exact', head: true });
concepts > 0
  ? ok('Warm concepts cached', `${concepts}`)
  : bad('Warm concepts cached', 'generate a batch on /concepts so a slow live run has something to fall back on');

console.log(
  failures === 0
    ? '\nAll green. Rehearse it ten times, record one clean run, then demo.\n'
    : `\n${failures} check(s) failed. Do not demo until they are green.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
