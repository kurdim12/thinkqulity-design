/**
 * Uploads the client's own creative into Supabase Storage.
 *   npm run assets            (defaults to ../ — the folder beside the app)
 *   npm run assets -- ../art
 *
 * These are Think Quality's published posts and logo, not stock. They are what
 * the agent points at when it art-directs, and what the Brand Brain shows so a
 * human can see the house style rather than read a description of it.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

const BUCKET = 'brand-assets';
const TYPES = {
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
};

const dir = path.resolve(process.argv[2] ?? '..');
const files = readdirSync(dir)
  .filter((f) => TYPES[path.extname(f).toLowerCase()])
  .map((f) => path.join(dir, f))
  .filter((f) => statSync(f).isFile());

if (files.length === 0) {
  console.error(`No images or PDFs found in ${dir}`);
  process.exit(1);
}

/** Storage keys must be URL-safe; the source filenames have spaces and dots. */
function keyFor(name) {
  const ext = path.extname(name).toLowerCase();
  const base = path
    .basename(name, path.extname(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base}${ext}`;
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });
const assets = [];

console.log('');
for (const file of files) {
  const name = path.basename(file);
  const key = keyFor(name);
  const ext = path.extname(name).toLowerCase();
  const body = readFileSync(file);

  const { error } = await db.storage
    .from(BUCKET)
    .upload(key, body, { contentType: TYPES[ext], upsert: true });

  if (error) {
    console.log(`  FAILED  ${name} — ${error.message}`);
    continue;
  }

  const { data } = db.storage.from(BUCKET).getPublicUrl(key);
  assets.push({
    name,
    path: key,
    url: data.publicUrl,
    kind: ext === '.pdf' ? 'document' : 'creative',
    bytes: body.length,
  });
  console.log(`  uploaded  ${name}  (${(body.length / 1024).toFixed(0)} KB)`);
}

if (assets.length === 0) {
  console.error('\nNothing uploaded.');
  process.exit(1);
}

const { error } = await db
  .from('brand')
  .update({ assets, updated_at: new Date().toISOString() })
  .eq('id', 1);

if (error) {
  console.error(`\nUploaded, but could not record them on the brand row: ${error.message}`);
  process.exit(1);
}

const mb = assets.reduce((sum, a) => sum + a.bytes, 0) / 1024 / 1024;
console.log(`\n${assets.length} asset(s) in the ${BUCKET} bucket — ${mb.toFixed(1)} MB.`);
console.log('Visible in Brand Brain → Identity.\n');
