/**
 * Ingests Canon — the operator's guideline resources and inspiration notes.
 *   npm run ingest:canon -- ./refs/guideline-anatomy.md
 *   npm run ingest:canon -- https://example.com/article --kind principle
 *
 * Canon is retrieval material, never generation material. It contributes
 * STRUCTURE and PRINCIPLE — what a serious guideline contains, how a voice
 * section is framed — and its text is quoted with attribution. Another brand's
 * actual content must never end up in a Think Quality deliverable, which is why
 * chunks keep their document and source and are returned verbatim.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const kindArg = args.includes('--kind') ? args[args.indexOf('--kind') + 1] : 'guideline_structure';
const KINDS = ['guideline_structure', 'principle', 'inspiration_note', 'internal'];

if (!target) {
  console.error('Usage: npm run ingest:canon -- <path|url> [--kind guideline_structure|principle|inspiration_note|internal]');
  process.exit(1);
}
if (!KINDS.includes(kindArg)) {
  console.error(`--kind must be one of: ${KINDS.join(', ')}`);
  process.exit(1);
}

/* ------------------------------------------------------------ tagging --- */

const TAG_RULES = [
  ['structure', /\b(structure|section|contents|anatomy|table of contents|chapter|framework)\b/i],
  ['voice', /\b(voice|tone|register|copy|wording|messaging|language)\b/i],
  ['color', /\b(colou?r|palette|swatch|hex|primary colou?r|accent)\b/i],
  ['typography', /\b(typograph|typeface|font|weight|kerning|leading|type scale)\b/i],
  ['layout', /\b(layout|grid|spacing|composition|margin|hierarchy)\b/i],
  ['logo-usage', /\b(logo|mark|lockup|clear ?space|wordmark)\b/i],
  ['social', /\b(social|instagram|reel|story|post|feed|caption)\b/i],
  ['arabic-specific', /(arabic|rtl|kashida|[؀-ۿ])/i],
];

function tagsFor(text) {
  const tags = TAG_RULES.filter(([, re]) => re.test(text)).map(([tag]) => tag);
  // Everything is at least structural — an untagged chunk is unreachable.
  return tags.length > 0 ? tags : ['structure'];
}

/* ----------------------------------------------------------- chunking --- */

function chunk(text, size = 900, overlap = 150) {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= size) return clean.length > 0 ? [clean] : [];

  const paragraphs = clean.split(/\n\n+/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > size && current.length > 0) {
      chunks.push(current.trim());
      current = current.slice(Math.max(0, current.length - overlap)) + '\n\n' + para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 40);
}

/* ---------------------------------------------------------- embedding --- */
/* Mirrors src/lib/brain/canon/embed.ts. Kept in step deliberately: if the app
   and the ingester disagree on the vector space, retrieval silently degrades
   to lexical instead of failing loudly. */

const LOCAL_DIM = 384;
const provider = (process.env.EMBEDDING_PROVIDER ?? 'local').toLowerCase();

function hash(token, seed) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function tokenise(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(Boolean);
}

function localEmbed(text) {
  const v = new Array(LOCAL_DIM).fill(0);
  for (const token of tokenise(text)) {
    v[hash(token, 0) % LOCAL_DIM] += 1;
    v[hash(token, 101) % LOCAL_DIM] += 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

async function embedAll(texts) {
  if (provider !== 'openai') return texts.map(localEmbed);
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    console.error('EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set.');
    process.exit(1);
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small', input: texts }),
  });
  if (!res.ok) {
    console.error(`Embedding failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

/* -------------------------------------------------------------- main --- */

let raw = '';
let title = '';
let sourceUrl = null;

if (/^https?:\/\//i.test(target)) {
  const res = await fetch(target, { headers: { 'user-agent': 'ThinkQualityStudio/1.0' } });
  if (!res.ok) {
    console.error(`Could not fetch ${target} — HTTP ${res.status}`);
    process.exit(1);
  }
  const html = await res.text();
  raw = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]{2,}/g, ' ');
  title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? target).trim().slice(0, 200);
  sourceUrl = target;
} else {
  const file = path.resolve(target);
  if (!existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }
  raw = readFileSync(file, 'utf8');
  title = path.basename(file);
}

const chunks = chunk(raw);
if (chunks.length === 0) {
  console.error('Nothing usable to ingest — the source had no extractable text.');
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data: doc, error: docError } = await db
  .from('canon_documents')
  .insert({
    title,
    source_url: sourceUrl,
    kind: kindArg,
    license_note:
      'Retrieval only. Structure and principle may inform generated guidelines; this text is never reproduced in client-facing output.',
  })
  .select('id')
  .single();

if (docError) {
  console.error(`Could not create the canon document: ${docError.message}`);
  process.exit(1);
}

const embeddings = await embedAll(chunks);

const rows = chunks.map((content, i) => ({
  document_id: doc.id,
  content,
  tags: tagsFor(content),
  embedding: JSON.stringify(embeddings[i]),
}));

const { error: chunkError } = await db.from('canon_chunks').insert(rows);
if (chunkError) {
  console.error(`Could not save chunks: ${chunkError.message}`);
  process.exit(1);
}

const tagCounts = {};
for (const row of rows) for (const tag of row.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;

console.log(`\n"${title}"`);
console.log(`  kind:      ${kindArg}`);
console.log(`  chunks:    ${rows.length}`);
console.log(`  embedder:  ${provider} (${provider === 'openai' ? 'model dim' : LOCAL_DIM} dims)`);
console.log(`  tags:      ${Object.entries(tagCounts).map(([t, n]) => `${t}×${n}`).join(', ')}`);
console.log('\nCanon is retrieval-only: quoted with attribution, never copied into client output.\n');
