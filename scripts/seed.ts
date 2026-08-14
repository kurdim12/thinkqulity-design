/**
 * Seeds the singleton brand row with the verified client facts.
 *
 *   npm run seed
 *
 * Idempotent: re-running refreshes the facts and leaves voice examples,
 * palette, typography and audience notes untouched. It never invents a value —
 * every fact below carries source "seed-2026-06".
 */
import { createClient } from '@supabase/supabase-js';

interface SeedFact {
  key: string;
  label_en: string;
  label_ar: string;
  value: string;
  source: string;
}

const SOURCE = 'seed-2026-06';

const FACTS: SeedFact[] = [
  { key: 'person', label_en: 'Person', label_ar: 'الشخص', value: 'Ahmad Kahtan', source: SOURCE },
  {
    key: 'positioning',
    label_en: 'Positioning line',
    label_ar: 'سطر التموضع',
    value: 'باحث · كاتب · مدرّب في السلوك الإنساني',
    source: SOURCE,
  },
  {
    key: 'personal_ig',
    label_en: 'Personal Instagram',
    label_ar: 'إنستغرام الشخصي',
    value: '@ahmadkahtan_',
    source: SOURCE,
  },
  {
    key: 'personal_followers',
    label_en: 'Personal followers',
    label_ar: 'متابعو الحساب الشخصي',
    value: '~84.5K (verified account, as of the 2026-06 scrape)',
    source: SOURCE,
  },
  {
    key: 'academy_ig',
    label_en: 'Academy Instagram',
    label_ar: 'إنستغرام الأكاديمية',
    value: '@thinkquality_academyy',
    source: SOURCE,
  },
  {
    key: 'academy',
    label_en: 'Academy',
    label_ar: 'الأكاديمية',
    value: 'Personal development + public speaking training, Amman, Jordan',
    source: SOURCE,
  },
  {
    key: 'contact',
    label_en: 'Public contact',
    label_ar: 'وسيلة التواصل',
    value: 'wa.me/962791995030',
    source: SOURCE,
  },
  {
    key: 'anchors',
    label_en: 'Known anchors',
    label_ar: 'المنشورات المرجعية',
    value: 'Two posts at ~13K and ~12K engagement led the 2026-06 ranking',
    source: SOURCE,
  },
];

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
        'Copy .env.example to .env.local and fill it in, then run `npm run seed` again.',
    );
    process.exitCode = 1;
    return;
  }

  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: existing, error: readError } = await db
    .from('brand')
    .select('voice_examples, palette, typography, audience_notes, status')
    .eq('id', 1)
    .maybeSingle();

  if (readError) {
    console.error(`Could not read the brand row: ${readError.message}`);
    console.error('Has supabase/migrations/0001_init.sql been applied to this project?');
    process.exitCode = 1;
    return;
  }

  const { error } = await db.from('brand').upsert({
    id: 1,
    facts: FACTS,
    voice_examples: existing?.voice_examples ?? [],
    palette: existing?.palette ?? null,
    typography: existing?.typography ?? null,
    audience_notes: existing?.audience_notes ?? null,
    status: existing?.status ?? 'seed',
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error(`Seed failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Seeded ${FACTS.length} facts (source: ${SOURCE}).`);
  console.log(
    existing
      ? 'Existing voice examples, palette, typography and audience notes were preserved.'
      : 'Brand row created. Palette and typography stay empty until real assets land.',
  );
}

void main();
