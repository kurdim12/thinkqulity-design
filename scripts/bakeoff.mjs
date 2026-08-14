/**
 * Model bake-off.  npm run bakeoff
 *
 * The default model should be chosen by looking at graded Arabic output, not
 * inherited from whatever a commit happened to set. This runs one identical
 * task across three models, stores the outputs under blind labels A/B/C, and
 * stops. Grading is a human act — see `npm run bakeoff -- --winner <model>`.
 *
 *   npm run bakeoff                      run the three models
 *   npm run bakeoff -- --show            print the blind outputs to grade
 *   npm run bakeoff -- --winner <model>  record the decision
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const apiKey = process.env.OPENROUTER_API_KEY?.trim();

if (!url || !serviceKey) {
  console.error('Missing Supabase credentials in .env.local.');
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const args = process.argv.slice(2);
const TASK = 'concepts:academy:5';

/* ------------------------------------------------------- record winner --- */
if (args.includes('--winner')) {
  const model = args[args.indexOf('--winner') + 1];
  if (!model) {
    console.error('Usage: npm run bakeoff -- --winner <model-id>');
    process.exit(1);
  }
  const { error } = await db.from('bakeoff_runs').insert({
    task: 'default_model',
    model,
    blind_label: 'winner',
    output: { decided_at: new Date().toISOString(), from_task: TASK },
  });
  if (error) {
    console.error(`Could not record the winner: ${error.message}`);
    process.exit(1);
  }
  console.log(`\nDefault model recorded: ${model}`);
  console.log('Set AI_MODEL_QUALITY / AI_MODEL_STANDARD in .env.local to match.\n');
  process.exit(0);
}

/* --------------------------------------------------------- show blinds --- */
if (args.includes('--show')) {
  const { data } = await db
    .from('bakeoff_runs')
    .select('blind_label, output, created_at')
    .eq('task', TASK)
    .order('created_at', { ascending: false })
    .limit(3);

  if (!data || data.length === 0) {
    console.error('No bake-off runs yet. Run: npm run bakeoff');
    process.exit(1);
  }

  // Deliberately does NOT print which model produced which label — that is the
  // entire point of a blind comparison.
  for (const row of data.sort((a, b) => a.blind_label.localeCompare(b.blind_label))) {
    console.log(`\n${'='.repeat(60)}\nCANDIDATE ${row.blind_label}\n${'='.repeat(60)}`);
    for (const concept of row.output?.concepts ?? []) {
      console.log(`\n· ${concept.title}  [${concept.format}, ${concept.grounding}]`);
      console.log(`  ${concept.hook_ar}`);
      console.log(`  ${String(concept.caption_ar).slice(0, 200)}`);
    }
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log('Grade on: register match vs the voice examples, hook strength, schema discipline.');
  console.log('Then: npm run bakeoff -- --winner <model-id>\n');
  process.exit(0);
}

/* ------------------------------------------------------------- run it --- */
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is not set — a bake-off needs a key to compare anything.');
  process.exit(1);
}

// Default candidates and their verified out-$/M (openrouter.ai/api/v1/models,
// read 2026-08-15), so an operator can see run cost at a glance:
//   qwen/qwen3.7-plus              $1.28
//   google/gemini-3.7-flash        $1.88
//   deepseek/deepseek-v4-pro-0813  $0.87
const MODELS = (process.env.BAKEOFF_MODELS ??
  'qwen/qwen3.7-plus,google/gemini-3.7-flash,deepseek/deepseek-v4-pro-0813')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const { data: brand } = await db.from('brand').select('*').eq('id', 1).maybeSingle();
const { data: snapshot } = await db
  .from('snapshots')
  .select('*')
  .order('taken_on', { ascending: false })
  .limit(1);

const context = JSON.stringify(
  {
    brand: {
      facts: brand?.facts,
      voice_examples: brand?.voice_examples,
      palette: brand?.palette,
    },
    latest_snapshot: snapshot?.[0]?.stats,
  },
  null,
  2,
);

const PROMPT = `<brand_and_data>\n${context}\n</brand_and_data>\n
## Task
Produce exactly 5 post concepts for the academy account. No theme given — choose
angles the data supports. Write hooks and captions in Arabic, matching the
register of the voice examples.

Return ONLY valid JSON:
{"concepts":[{"title":"string","format":"reel|carousel|static|story","hook_ar":"string","caption_ar":"string","visual_direction":"string","why":"string","grounding":"data|hypothesis"}]}`;

const labels = ['A', 'B', 'C'];
console.log(`\nRunning ${MODELS.length} model(s) on the same task…\n`);

for (let i = 0; i < MODELS.length; i += 1) {
  const model = MODELS[i];
  const label = labels[i] ?? `M${i + 1}`;
  process.stdout.write(`  ${label}  ${model} … `);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-title': 'ThinkQuality Studio bake-off',
      },
      body: JSON.stringify({
        model,
        max_tokens: 12000,
        messages: [{ role: 'user', content: PROMPT }],
      }),
    });

    if (!res.ok) {
      console.log(`FAILED (${res.status})`);
      continue;
    }

    const payload = await res.json();
    const text = payload.choices?.[0]?.message?.content ?? '';
    const match = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);

    let parsed;
    try {
      parsed = JSON.parse(match);
    } catch {
      console.log('FAILED (unparseable JSON) — that is itself a grading signal');
      parsed = { concepts: [], parse_error: true, raw: text.slice(0, 2000) };
    }

    await db.from('bakeoff_runs').insert({
      task: TASK,
      model,
      blind_label: label,
      output: parsed,
    });

    console.log(`ok — ${parsed.concepts?.length ?? 0} concepts`);
  } catch (err) {
    console.log(`FAILED (${err.message})`);
  }
}

console.log('\nNow grade them blind:  npm run bakeoff -- --show');
console.log('Then record it:        npm run bakeoff -- --winner <model-id>\n');
