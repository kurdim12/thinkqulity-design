import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CAPTION_EXCERPT_CHARS,
  agentContextEvidence,
  buildContextView,
  contextMeasures,
  daysSince,
  renderContextBlocks,
  type AgentContext,
} from '../src/lib/agent/context-view.ts';
import { claimsLinter, wholeQuantity } from '../src/lib/brain/law/claims-linter.ts';
import type {
  BrandRow,
  ConceptRow,
  PillarRow,
  PostRow,
  SnapshotRow,
} from '../src/lib/types/db.ts';

/* =============================================================== what this ==
 * The four app-wide context blocks are read by five surfaces, and until v5 all
 * five handed the RENDERED blocks to `runLaw` as the string the claims-linter
 * traces a number back to. The blocks JSON-dump six hundred characters of every
 * caption, every brand fact, every model-written hook and the client's whole
 * workshop corpus — so a figure somebody TYPED was evidence for a figure the
 * agent STATED. That is the round-3 attack through a door that needed no
 * Unicode trick at all: the number was simply in the evidence.
 *
 * Two properties are proved here, and the first is what makes the second safe:
 *
 *   1. WHAT THE MODEL SEES DID NOT CHANGE. `renderContextBlocks()` is asserted
 *      byte for byte against a FROZEN COPY of the pre-v5 implementation, on a
 *      fixture that exercises every branch. The model still gets the captions,
 *      the hooks and the corpus — it cannot match a register it has not been
 *      shown. Only what counts as PROOF moved.
 *   2. TEXT IS NOT EVIDENCE, STRUCTURALLY. Every laundering route below is
 *      executed twice: once against the blocks, which is what the old wiring
 *      did and which PASSES the linter — so the exploit is demonstrated, not
 *      asserted — and once against the evidence, which fails it.
 *
 * The boundary is the field's TYPE, not its characters, so the probes include
 * Arabic-Indic digits and the U+034F round-3 payload without either of them
 * being special-cased anywhere in the implementation. They are not spelled
 * literally in this file: hard rule 7 forbids raw control bytes in any file,
 * and a planted invisible character is exactly the kind of thing that silently
 * zeroes a scan (it has produced a false clean twice in this project), so every
 * invisible is built with `String.fromCodePoint`.
 *
 * WHAT THIS FILE DOES NOT EXECUTE: the five surfaces themselves. Four of them
 * need a database handle, a provider key or both. The composition each one runs
 * IS executed here (`runLaw`'s claims-linter over `agentContextEvidence`), and
 * the WIRING — that each surface passes the evidence and none passes the blocks
 * — is held by a source scan at the bottom, whose patterns are sanity-checked
 * against a control carrying both planted positives first.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------- fixtures -- */

/** U+034F COMBINING GRAPHEME JOINER: \p{Mn}, invisible, not blank, not a
 *  joiner. The character round 3 fell to. Built, never typed. */
const CGJ = String.fromCodePoint(0x034f);

/** «٨٨» CGJ «٧١٩» — renders to a reader as ٨٨٧١٩. The tail is deliberately a
 *  figure NO measurement in the fixture holds, so a pass can only have come
 *  from the caption. */
const ROUND_THREE = `٨٨${CGJ}٧١٩`;

function post(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: 'p1',
    snapshot_id: 's1',
    account: 'personal',
    ig_id: 'ig1',
    url: 'https://instagram.com/p/aaa',
    caption: 'نص عادي',
    media_type: 'Image',
    likes: 480,
    comments: 28,
    engagement: 508,
    posted_at: '2026-08-01T18:00:00Z',
    rank: 1,
    video_play_count: null,
    video_view_count: null,
    video_duration: null,
    product_type: null,
    location_name: null,
    location_id: null,
    hashtags: null,
    mentions: null,
    first_comment: null,
    owner_username: null,
    owner_id: null,
    is_sponsored: null,
    dimensions: null,
    raw: null,
    ...overrides,
  };
}

function brand(overrides: Partial<BrandRow> = {}): BrandRow {
  return {
    id: 1,
    facts: [{ key: 'trainees', value: 'عدد المتدربين 88123 متدرب', source: 'محادثة' }],
    voice_examples: [
      { text: 'مثال بصوته الحقيقي', source_url: 'https://instagram.com/p/bbb', engagement: 731 },
    ],
    knowledge: [
      {
        title: 'ورشة',
        source: 'workshop.md',
        kind: 'workshop',
        content: 'حضر الورشة 44321 شخصًا حسب ما كتبه أحمد.',
      },
    ],
    // `bytes` is a NUMBER on the row that the blocks do not render. It is the
    // control for "evidence is bounded by what the model saw".
    assets: [
      { name: 'الشخصية', path: 'a/b.png', url: 'https://x/y.png', kind: 'creative', bytes: 90123 },
    ],
    palette: { swatches: { turquoise: '#48C0C0' } },
    typography: { arabic_display: 'Tajawal', arabic_body: 'Tajawal' },
    audience_notes: 'الجمهور بحدود 55789 متابع حسب تقدير قديم',
    status: 'live',
    updated_at: '2026-08-14T00:00:00Z',
    ...overrides,
  };
}

const SNAPSHOT: SnapshotRow = {
  id: 'snap-1',
  taken_on: '2026-08-14',
  stats: {
    followers: { personal: 12000, academy: null },
    avg_engagement: { personal: 508, academy: 40 },
    top_format: { personal: 'Reel', academy: null },
    post_count: { personal: 190, academy: 130 },
    total_engagement: { personal: 96520, academy: 5200 },
    diff_vs_prev: null,
  },
  raw_meta: null,
  created_at: '2026-08-14T00:00:00Z',
};

function pillar(overrides: Partial<PillarRow> = {}): PillarRow {
  return {
    id: 'pil-1',
    name_ar: 'القيادة',
    name_en: 'Leadership',
    post_count: 34,
    avg_engagement: 612,
    hook_pattern: 'ابدأ بسؤال — نجح مع 77654 متابع',
    example_post_ids: null,
    generated_from: null,
    ...overrides,
  };
}

function concept(overrides: Partial<ConceptRow> = {}): ConceptRow {
  return {
    id: 'c1',
    title: 'فكرة',
    pillar_id: null,
    format: 'reel',
    hook_ar: 'وصلنا إلى 66543 متدرب هذا العام',
    caption_ar: 'نص',
    visual_direction: 'نص',
    why: 'نص',
    grounding: 'hypothesis',
    status: 'shipped',
    target_week: null,
    account: 'personal',
    shipped_url: null,
    shipped_engagement: 903,
    frames: null,
    created_at: '2026-08-10T00:00:00Z',
    ...overrides,
  };
}

function ctxOf(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    brand: brand(),
    latestSnapshot: SNAPSHOT,
    topPosts: [post()],
    pillars: [pillar()],
    recentConcepts: [concept()],
    ...overrides,
  };
}

/* ===================================================== 1. the frozen render */

/**
 * `renderContextBlocks()` EXACTLY as it stood before the evidence view existed,
 * copied here and frozen. Its only purpose is to be the control for "the model
 * sees the same thing it saw yesterday" — the whole change is safe only because
 * that is true, and a claim like that is worth nothing asserted.
 */
function legacyRender(ctx: AgentContext): string {
  const block = (tag: string, body: unknown): string =>
    `<${tag}>\n${JSON.stringify(body, null, 2)}\n</${tag}>`;

  const brandBlock = block('brand', {
    status: ctx.brand.status,
    facts: ctx.brand.facts,
    voice_examples: ctx.brand.voice_examples,
    palette: ctx.brand.palette,
    typography: ctx.brand.typography,
    audience_notes: ctx.brand.audience_notes,
    assets: (ctx.brand.assets ?? []).map((a) => ({ name: a.name, kind: a.kind })),
  });

  const snapshot = ctx.latestSnapshot
    ? block('latest_snapshot', {
        id: ctx.latestSnapshot.id,
        taken_on: ctx.latestSnapshot.taken_on,
        days_old: daysSince(ctx.latestSnapshot.taken_on),
        stats: ctx.latestSnapshot.stats,
        top_posts: ctx.topPosts.map((p) => ({
          id: p.id,
          account: p.account,
          rank: p.rank,
          engagement: p.engagement,
          likes: p.likes,
          comments: p.comments,
          media_type: p.media_type,
          posted_at: p.posted_at,
          url: p.url,
          caption_excerpt: p.caption ? p.caption.slice(0, 600) : null,
        })),
      })
    : '<latest_snapshot>null — no engagement export has been ingested yet.</latest_snapshot>';

  const pillars =
    ctx.pillars.length > 0
      ? block(
          'pillars',
          ctx.pillars.map((p) => ({
            name_ar: p.name_ar,
            name_en: p.name_en,
            post_count: p.post_count,
            avg_engagement: p.avg_engagement,
            hook_pattern: p.hook_pattern,
          })),
        )
      : '<pillars>[] — pillars are generated by Run Refresh once a snapshot exists.</pillars>';

  const recent =
    ctx.recentConcepts.length > 0
      ? block(
          'recent_concepts',
          ctx.recentConcepts.map((c) => ({
            title: c.title,
            format: c.format,
            hook_ar: c.hook_ar,
            status: c.status,
            grounding: c.grounding,
            account: c.account,
            shipped_engagement: c.shipped_engagement,
          })),
        )
      : '<recent_concepts>[] — nothing generated yet.</recent_concepts>';

  const knowledge =
    ctx.brand.knowledge && ctx.brand.knowledge.length > 0
      ? `<knowledge>\n${ctx.brand.knowledge
          .map((doc) => `--- source: ${doc.source} (${doc.kind}) ---\n${doc.content}`)
          .join('\n\n')}\n</knowledge>`
      : '<knowledge>[] — no workshop material loaded. Run: npm run ingest:knowledge</knowledge>';

  return [brandBlock, knowledge, snapshot, pillars, recent].join('\n\n');
}

test('the render is byte-identical to the frozen pre-v5 implementation', () => {
  assert.equal(renderContextBlocks(ctxOf()), legacyRender(ctxOf()));
});

test('the render is byte-identical on a caption long enough to be truncated', () => {
  // `legacyRender` hardcodes 600, so this is the branch that holds the excerpt
  // length to what the model actually used to be shown.
  const ctx = ctxOf({ topPosts: [post({ caption: `${'ا'.repeat(900)}نهاية` })] });
  assert.equal(renderContextBlocks(ctx), legacyRender(ctx));
});

test('the render is byte-identical on every empty branch too', () => {
  const empty = ctxOf({
    brand: brand({ knowledge: [], assets: [], palette: null, typography: null }),
    latestSnapshot: null,
    topPosts: [],
    pillars: [],
    recentConcepts: [],
  });
  assert.equal(renderContextBlocks(empty), legacyRender(empty));
  // The branch text itself, so a rewrite of the empty case is caught as well.
  assert.match(renderContextBlocks(empty), /<latest_snapshot>null — no engagement export/);
  assert.match(renderContextBlocks(empty), /<pillars>\[\] — pillars are generated/);
  assert.match(renderContextBlocks(empty), /<recent_concepts>\[\] — nothing generated yet/);
  assert.match(renderContextBlocks(empty), /<knowledge>\[\] — no workshop material loaded/);
});

test('the model still sees the caption, the hook, the fact and the corpus', () => {
  const ctx = ctxOf({ topPosts: [post({ caption: 'الحضور 88123 متدرب' })] });
  const blocks = renderContextBlocks(ctx);
  // Do NOT change what the model sees — only what counts as evidence.
  assert.ok(blocks.includes('الحضور 88123 متدرب'), 'the caption reaches the model');
  assert.ok(blocks.includes('وصلنا إلى 66543 متدرب هذا العام'), 'the hook reaches the model');
  assert.ok(blocks.includes('عدد المتدربين 88123 متدرب'), 'the brand fact reaches the model');
  assert.ok(blocks.includes('حضر الورشة 44321 شخصًا'), 'the corpus reaches the model');
});

test('a caption is still truncated at 600 characters', () => {
  // The literal, NOT the constant. Asserting `shown.length === CAPTION_EXCERPT_CHARS`
  // compares the constant to itself and survives any change to it.
  assert.equal(CAPTION_EXCERPT_CHARS, 600);
  const long = `${'ا'.repeat(600)}88123`;
  const view = buildContextView(ctxOf({ topPosts: [post({ caption: long })] }));
  const shown = view.latest_snapshot?.top_posts[0]?.caption_excerpt ?? '';
  assert.equal(shown.length, 600);
  assert.ok(!shown.includes('88123'));
});

/* ================================================= 2. the laundering routes */

/**
 * One executed laundering attempt. `blocks` is the OLD lint context and must
 * PASS — a probe whose exploit does not work proves nothing about the fix — and
 * `evidence` is the new one and must FAIL.
 */
function launders(ctx: AgentContext, draft: string): void {
  const blocks = renderContextBlocks(ctx);
  const evidence = agentContextEvidence(ctx);

  const old = claimsLinter(draft, blocks);
  assert.equal(old.passed, true, 'the OLD wiring accepted this — the exploit is real');

  const now = claimsLinter(draft, evidence);
  assert.equal(now.passed, false, 'the NEW wiring must refuse it');
}

test('a client caption cannot source a figure', () => {
  launders(ctxOf({ topPosts: [post({ caption: 'الحضور 88123 متدرب' })] }), 'المتدربون 88123.');
});

test('a caption in Arabic-Indic digits cannot source an ASCII figure', () => {
  // The linter canonicalises both sides, so ٨٨١٢٣ in a caption sourced 88123 in
  // a claim. It is not a bug in the linter — it is the right answer to the
  // wrong question, which is why the question changed.
  launders(ctxOf({ topPosts: [post({ caption: 'الحضور ٨٨١٢٣ متدرب' })] }), 'المتدربون 88123.');
});

test('the round-3 payload in a caption cannot source anything', () => {
  const ctx = ctxOf({ topPosts: [post({ caption: `الحضور ${ROUND_THREE} متدرب` })] });
  assert.ok(renderContextBlocks(ctx).includes(CGJ), 'the payload is really in the blocks');
  // The invisible splits the caption into ٨٨ and ٧١٩, both bounded, so the OLD
  // context OFFERED the tail — the original attack, arriving through this door
  // with no linter bug involved. `launders` asserts that door was open.
  launders(ctx, 'العدد ٧١٩.');
  // Every other spelling of the payload is refused too, on both halves and
  // whole, in both scripts.
  const evidence = agentContextEvidence(ctx);
  for (const claim of ['العدد ٧١٩.', 'العدد 719.', 'العدد ٨٨٧١٩.', 'العدد 88719.']) {
    assert.equal(claimsLinter(claim, evidence).passed, false, claim);
  }
});

test('a model-written hook cannot source a figure', () => {
  launders(ctxOf(), 'وصلنا إلى 66543 متدرب.');
});

test('a free-text brand fact cannot source a figure', () => {
  launders(ctxOf(), 'عدد المتدربين 88123.');
});

test('audience notes cannot source a figure', () => {
  launders(ctxOf(), 'المتابعون 55789.');
});

test('a pillar hook pattern cannot source a figure', () => {
  launders(ctxOf(), 'نجح مع 77654 متابع.');
});

test('the workshop corpus cannot source a figure', () => {
  launders(ctxOf(), 'حضر 44321 شخصًا.');
});

test('a caption that is nothing but a number is still not a measurement', () => {
  // The boundary is the field's TYPE. A string of digits in a text field is
  // text, and `wholeQuantity()` never gets the chance to be generous with it.
  const ctx = ctxOf({ topPosts: [post({ caption: '88123' })] });
  assert.ok(!agentContextEvidence(ctx).split('\n').includes('88123'));
  assert.equal(claimsLinter('المتدربون 88123.', agentContextEvidence(ctx)).passed, false);
});

/* ================================================ 3. measurements do survive */

/** Every measured quantity the blocks render, and the claim that quotes it. */
const MEASURED: readonly { what: string; draft: string }[] = [
  { what: 'a post engagement', draft: 'أقوى منشور حقق 508 تفاعلًا.' },
  { what: 'post likes', draft: 'أعجب به 480 شخصًا.' },
  { what: 'post comments', draft: 'وردت عليه 28 تعليقًا.' },
  { what: 'a snapshot follower count', draft: 'المتابعون 12000.' },
  { what: 'a snapshot average', draft: 'المعدل 508 لكل منشور.' },
  { what: 'a snapshot post count', draft: 'عدد المنشورات 190.' },
  { what: 'a snapshot total', draft: 'مجموع التفاعل 96520.' },
  { what: 'a pillar average', draft: 'معدل المحور 612.' },
  { what: 'a voice example engagement', draft: 'حقق ذلك المنشور 731 تفاعلًا.' },
  { what: 'a shipped result', draft: 'حقق المنشور المنشور 903 تفاعلًا.' },
];

for (const { what, draft } of MEASURED) {
  test(`${what} is still quotable`, () => {
    const result = claimsLinter(draft, agentContextEvidence(ctxOf()));
    assert.equal(result.passed, true, `${what} was cut out of an honest sentence: ${result.evidence}`);
  });
}

test('a figure no measurement holds is refused', () => {
  assert.equal(claimsLinter('المتابعون 99999.', agentContextEvidence(ctxOf())).passed, false);
});

/* ==================================================== 4. absence, not zero -- */

test('a null quantity contributes nothing — not a zero', () => {
  const ctx = ctxOf({
    topPosts: [post({ likes: null, comments: null, rank: null })],
    // academy followers are null in the fixture snapshot already.
  });
  const lines = agentContextEvidence(ctx).split('\n');
  assert.ok(!lines.includes('0'), 'an absent measurement must never arrive as 0');
  // …and the measures list simply has no entry for it.
  const keys = contextMeasures(ctx).map((m) => m.key);
  assert.ok(!keys.some((k) => k.endsWith('top_posts.1.likes')));
  assert.ok(!keys.some((k) => k.endsWith('followers.academy')));
  assert.ok(keys.includes('latest_snapshot.stats.followers.personal'));
});

test('a real zero is a measurement and survives', () => {
  const ctx = ctxOf({ topPosts: [post({ likes: 0 })] });
  assert.ok(contextMeasures(ctx).some((m) => m.key.endsWith('likes') && m.value === '0'));
});

/* ================================================ 5. the structural property */

test('a number on the row that the blocks do not render is not evidence', () => {
  // Evidence is bounded by what the model SAW: the view is the render, so a
  // field outside it cannot become proof. `assets[].bytes` and every unrendered
  // PostRow column (video_play_count, dimensions, raw…) are on the wrong side.
  const ctx = ctxOf();
  assert.equal(ctx.brand.assets[0]?.bytes, 90123);
  assert.ok(!renderContextBlocks(ctx).includes('90123'), 'the model was never shown it');
  assert.ok(!agentContextEvidence(ctx).split('\n').includes('90123'));
  assert.equal(claimsLinter('الحجم 90123.', agentContextEvidence(ctx)).passed, false);
});

test('every declared value is one whole quantity', () => {
  for (const line of agentContextEvidence(ctxOf()).split('\n')) {
    assert.notEqual(wholeQuantity(line), null, `not a quantity: ${line}`);
  }
});

test('no declared value carries a key, a label or any prose', () => {
  for (const line of agentContextEvidence(ctxOf()).split('\n')) {
    assert.doesNotMatch(line, /[\p{L}[\]=]/u, `prose leaked into the evidence: ${line}`);
  }
});

test('every text field in the view is absent from the evidence', () => {
  const ctx = ctxOf();
  const evidence = agentContextEvidence(ctx);
  const view = buildContextView(ctx);
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) {
      Object.values(value as Record<string, unknown>).forEach(walk);
    }
  };
  walk(view);
  assert.ok(strings.length > 0, 'the walker found no strings — it is broken, not clean');
  for (const text of strings) {
    for (const quantity of text.matchAll(/\d{3,}/gu)) {
      assert.ok(
        !evidence.split('\n').includes(quantity[0]),
        `${quantity[0]} came from text and reached the evidence`,
      );
    }
  }
});

test('an every-branch context produces evidence and never throws', () => {
  const empty: AgentContext = {
    brand: {
      ...brand(),
      facts: [],
      voice_examples: [],
      knowledge: [],
      assets: [],
      palette: null,
      typography: null,
      audience_notes: null,
    },
    latestSnapshot: null,
    topPosts: [],
    pillars: [],
    recentConcepts: [],
  };
  assert.equal(agentContextEvidence(empty), '');
  assert.deepEqual(contextMeasures(empty), []);
});

/* ================================================== 6. the five surfaces --- */

/**
 * The wiring, scanned rather than executed — four of the five surfaces need a
 * database handle or a provider key. The patterns are sanity-checked against a
 * CONTROL carrying both planted positives FIRST, because a scan that matches
 * nothing looks exactly like a scan that finds nothing wrong (this project has
 * been burned by that twice).
 */
const SURFACES: readonly string[] = [
  'src/lib/agent/features/types.ts',
  'src/lib/agent/features/strategist.ts',
  'src/lib/mcp/tools.ts',
  'src/app/api/compliance/route.ts',
  'src/lib/agent/chat/tools.ts',
];

/** `context:` fed the rendered prose. What every surface used to do. */
const RENDERED = /context:\s*(?:context\.|args\.)?blocks\b/u;
/** `context:` fed the declared values. What every surface must now do. */
const DECLARED = /context:\s*(?:context\.)?evidence\b/u;

const CONTROL = [
  'const law = runLaw({ text, context: blocks, swatches });',
  'const law = runLaw({ text, context: context.blocks, swatches });',
  'const law = runLaw({ text, context: evidence, swatches });',
  'const law = runLaw({ text, context: context.evidence, swatches });',
].join('\n');

test('the scan patterns match their planted positives', () => {
  assert.match(CONTROL, RENDERED);
  assert.match(CONTROL, DECLARED);
  assert.doesNotMatch('context: somethingElse', RENDERED);
  assert.doesNotMatch('context: somethingElse', DECLARED);
  // A control with no invisibles — newlines excepted, they are the joiner. A
  // NUL or a format character here would silently zero every result below.
  assert.doesNotMatch(CONTROL.replace(/\n/gu, ''), /\p{C}/u);
});

for (const file of SURFACES) {
  test(`${file} lints against declared evidence, not rendered prose`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, DECLARED, `${file} never passes evidence to runLaw`);
    // Every `context:` in the file that names `blocks` is the defect.
    const offenders = source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => RENDERED.test(line) && !line.startsWith('*') && !line.startsWith('//'));
    assert.deepEqual(offenders, [], `${file} still lints against the rendered blocks`);
  });
}

test('the strategist keeps the rendered blocks for the source-key check', () => {
  // `sourceKeys` compares a cited value character for character against the LINE
  // it was rendered on, which is a different question and needs the rendering.
  const source = readFileSync(
    new URL('../src/lib/agent/features/strategist.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /sourceKeys:\s*\{[^}]*\bblocks\b/u);
});
