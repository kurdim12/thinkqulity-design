/**
 * Loads Ahmad's own material into the Brand Brain.  npm run ingest:knowledge
 *
 *   npm run ingest:knowledge -- "../My Deck.pdf" "../Another.pdf"
 *   npm run ingest:knowledge                      (defaults to ../*.pdf)
 *
 * This is deliberately NOT fine-tuning. The whole corpus is a few thousand
 * tokens against a million-token context window, so the agent reads all of it
 * on every request and can quote it with a citation. Fine-tuning this little
 * material would overfit to a handful of decks and teach the model nothing it
 * cannot already read.
 *
 * Requires pdftotext (ships with Git for Windows, poppler-utils on Linux/mac).
 */
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}

/** Arabic PDF text arrives with bidi control marks and shredded whitespace. */
function clean(raw) {
  return raw
    .replace(/[‎‏‪-‮⁦-⁩]/g, '') // bidi controls
    .replace(/ /g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extract(pdfPath) {
  const out = path.join(tmpdir(), `tq-${Date.now()}-${Math.abs(hash(pdfPath))}.txt`);
  try {
    execFileSync('pdftotext', ['-enc', 'UTF-8', pdfPath, out], { stdio: 'pipe' });
    const text = clean(readFileSync(out, 'utf8'));
    unlinkSync(out);
    return text;
  } catch (err) {
    console.error(`  could not read ${path.basename(pdfPath)}: ${err.message}`);
    return '';
  }
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const args = process.argv.slice(2);
const files =
  args.length > 0
    ? args
    : readdirSync(path.resolve('..'))
        .filter((f) => f.toLowerCase().endsWith('.pdf'))
        .map((f) => path.resolve('..', f));

if (files.length === 0) {
  console.error('No PDFs found. Pass paths explicitly, or put them in the parent folder.');
  process.exit(1);
}

const documents = [];

console.log('');
for (const file of files) {
  if (!existsSync(file)) {
    console.log(`  skipped (not found)  ${file}`);
    continue;
  }
  const content = extract(file);
  const name = path.basename(file);

  // A logo PDF is a vector asset, not a document — no usable prose.
  if (content.length < 200) {
    console.log(`  skipped (no text)    ${name}  — ${content.length} chars`);
    continue;
  }

  documents.push({
    title: name.replace(/\.pdf$/i, ''),
    source: name,
    kind: 'workshop_material',
    content,
  });
  console.log(`  loaded               ${name}  — ${content.length.toLocaleString()} chars`);
}

if (documents.length === 0) {
  console.error('\nNothing had extractable text.');
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const { error } = await db
  .from('brand')
  .update({ knowledge: documents, updated_at: new Date().toISOString() })
  .eq('id', 1);

if (error) {
  console.error(`\nCould not save: ${error.message}`);
  process.exit(1);
}

const totalChars = documents.reduce((sum, d) => sum + d.content.length, 0);
// Arabic runs denser per token than English; this is a deliberate over-estimate.
const roughTokens = Math.round(totalChars / 2.5);

console.log(`\n${documents.length} document(s) in the Brand Brain.`);
console.log(`~${totalChars.toLocaleString()} characters, roughly ${roughTokens.toLocaleString()} tokens.`);
console.log(`That is about ${((roughTokens / 1_000_000) * 100).toFixed(2)}% of a 1M-token context window —`);
console.log('which is why this belongs in the prompt, not in a fine-tune.\n');
