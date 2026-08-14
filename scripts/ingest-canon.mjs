/**
 * Ingests Canon — the operator's guideline resources and inspiration notes.
 *   npm run ingest:canon -- ./refs/guideline-anatomy.md
 *   npm run ingest:canon -- https://example.com/article --kind principle
 *
 * Safe to re-run. The same source updates its own document in place rather than
 * accumulating duplicates, so re-embedding is this command again. Which
 * embedder ran — and why — is printed on every run.
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
/* Mirrors src/lib/brain/canon/embed.ts — embeddingMode() there, resolved the
   same way here. Kept in step deliberately: if the app and the ingester
   disagree on the vector space, retrieval silently degrades to lexical instead
   of failing loudly.

   One env var decides it:
     EMBEDDING_PROVIDER = local | openai      (unset = local)

   `openai` also needs OPENAI_API_KEY. Without one the run falls back to the
   keyless local embedder rather than refusing — but it never pretends: the
   mode that actually ran is printed on every run, with the reason. */

const LOCAL_DIM = 384;

const requestedProvider =
  (process.env.EMBEDDING_PROVIDER ?? 'local').toLowerCase() === 'openai' ? 'openai' : 'local';
const openaiKey = process.env.OPENAI_API_KEY?.trim();
const openaiModel = process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small';

const provider = requestedProvider === 'openai' && openaiKey ? 'openai' : 'local';

const providerReason =
  requestedProvider === 'openai' && !openaiKey
    ? 'EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set — fell back to local'
    : provider === 'openai'
      ? `EMBEDDING_PROVIDER=openai, key present, model ${openaiModel}`
      : 'EMBEDDING_PROVIDER unset or local — keyless local embedder';

if (provider !== requestedProvider) {
  console.warn(`\n!  ${providerReason}.`);
  console.warn('   Set OPENAI_API_KEY and re-run this command to re-embed with the real model.');
}

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
  // Reached only when the key is present — a missing key already fell back.
  // A key that is present but rejected is a real failure, so it still exits.
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${openaiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: openaiModel, input: texts }),
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

const LICENSE_NOTE =
  'Retrieval only. Structure and principle may inform generated guidelines; this text is never reproduced in client-facing output.';

/* Embed before touching the database. It is the step that costs money and the
   step most likely to fail, and a re-ingest must not have deleted the previous
   chunks before finding that out. */
const embeddings = await embedAll(chunks);
const dimension = embeddings[0]?.length ?? 0;

/* --------------------------------------------------------- re-runnable --- */
/* A canon document is identified by what it was made from: its title and its
   source URL. Re-running the same source replaces that document's chunks in
   place instead of leaving a second copy behind — so re-embedding, whether
   after a provider switch or after the source itself changed, is just this
   command again. */

let lookup = db.from('canon_documents').select('id').eq('title', title);
lookup = sourceUrl === null ? lookup.is('source_url', null) : lookup.eq('source_url', sourceUrl);

const { data: existing, error: lookupError } = await lookup.limit(1);
if (lookupError) {
  console.error(`Could not look up the canon document: ${lookupError.message}`);
  process.exit(1);
}

let documentId = existing?.[0]?.id ?? null;
const wasExisting = documentId !== null;
let replacedChunks = 0;

if (wasExisting) {
  // The kind can be corrected on a re-run; the identity stays the source.
  const { error: updateError } = await db
    .from('canon_documents')
    .update({ kind: kindArg, license_note: LICENSE_NOTE })
    .eq('id', documentId);
  if (updateError) {
    console.error(`Could not update the canon document: ${updateError.message}`);
    process.exit(1);
  }

  const { data: removed, error: clearError } = await db
    .from('canon_chunks')
    .delete()
    .eq('document_id', documentId)
    .select('id');
  if (clearError) {
    console.error(`Could not clear the previous chunks: ${clearError.message}`);
    process.exit(1);
  }
  replacedChunks = removed?.length ?? 0;
} else {
  const { data: doc, error: docError } = await db
    .from('canon_documents')
    .insert({ title, source_url: sourceUrl, kind: kindArg, license_note: LICENSE_NOTE })
    .select('id')
    .single();

  if (docError) {
    console.error(`Could not create the canon document: ${docError.message}`);
    process.exit(1);
  }
  documentId = doc.id;
}

const rows = chunks.map((content, i) => ({
  document_id: documentId,
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
console.log(
  `  document:  ${wasExisting ? `updated in place — ${replacedChunks} previous chunk(s) replaced` : 'created'}`,
);
console.log(`  chunks:    ${rows.length}`);
// The dimension is measured from the vectors that came back, not assumed.
console.log(`  embedder:  ${provider} (${dimension} dims) — ${providerReason}`);
console.log(`  tags:      ${Object.entries(tagCounts).map(([t, n]) => `${t}×${n}`).join(', ')}`);
console.log('\nCanon is retrieval-only: quoted with attribution, never copied into client output.\n');
