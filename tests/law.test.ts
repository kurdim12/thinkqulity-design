import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimsLinter,
  frameStructure,
  guidelineStructure,
  paletteClaims,
  paletteRefs,
  registerScore,
  runLaw,
  TBD_AR,
  type FrameLike,
  type GuidelineSection,
} from '../src/lib/brain/law/index.ts';
/* Imported from the file rather than the barrel, as tests/chat-lint.test.ts
 * does: `contextQuantities` is the MECHANISM behind the claims-linter's new
 * boundary rules, not part of the Law's public surface, and asserting the token
 * set directly says what the rules are instead of inferring them from a verdict. */
import { contextQuantities } from '../src/lib/brain/law/claims-linter.ts';

/* ------------------------------------------------------------- fixtures -- */

/** The real sampled palette. */
const SWATCHES = {
  turquoise: '#48C0C0',
  turquoise_light: '#78D8D8',
  mint: '#60D8C0',
  sky: '#60C0D8',
  ink: '#181818',
  charcoal: '#303030',
  paper: '#F0F0F0',
  ember: '#D84800',
};

/** Real captions from the account, trimmed. */
const VOICE = [
  'الموضوع مش نكد 😅',
  '#مش بالعناد … موده ورحمه ،، لتسكنوا اليها …',
  'أمر ما لقيت من ألم الهوى …!',
  'اخطر وأصعب من الخيانه الظاهره …',
  'البرّ هين … تكسب الناس باللين …',
];

/** The off-brand draft used in the demo: wrong colour, invented metric. */
const OFF_BRAND =
  'Our new campaign uses a bold #7B2FF7 gradient and drives 340% more engagement ' +
  'than any previous post, reaching 92% of our target demographic.';

/* -------------------------------------------------------- palette-claims -- */

test('palette-claims passes when no colour is named', () => {
  const r = paletteClaims('نص عربي بدون أي لون', SWATCHES);
  assert.equal(r.passed, true);
  assert.equal(r.source, 'law');
});

test('palette-claims accepts a colour the brand owns', () => {
  const r = paletteClaims('Use #48C0C0 for the headline.', SWATCHES);
  assert.equal(r.passed, true);
});

test('palette-claims accepts shorthand equal to a brand colour', () => {
  const r = paletteClaims('background #FFF over #F0F0F0', { ...SWATCHES, white: '#FFFFFF' });
  assert.equal(r.passed, true);
});

test('palette-claims REJECTS an invented colour and names it', () => {
  const r = paletteClaims(OFF_BRAND, SWATCHES);
  assert.equal(r.passed, false);
  assert.equal(r.severity, 'violation');
  assert.match(r.evidence, /#7b2ff7/i);
});

test('palette-claims rejects any colour when the brand has no palette', () => {
  const r = paletteClaims('Use #48C0C0.', null);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /no palette/i);
});

/* ----------------------------------------------------------- palette-refs -- */

test('palette-refs resolves names that exist', () => {
  assert.equal(paletteRefs(['turquoise', 'ink'], SWATCHES).passed, true);
});

test('palette-refs rejects an unknown swatch name', () => {
  const r = paletteRefs(['turquoise', 'neon_pink'], SWATCHES);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /neon_pink/);
});

/* --------------------------------------------------------- claims-linter -- */

const CONTEXT =
  'avg_engagement personal 508, academy 40. top post engagement 33176. post_count 320.';

test('claims-linter passes numbers that appear in the context', () => {
  const r = claimsLinter('حقق المنشور 33176 تفاعلاً، ومتوسط الحساب 508.', CONTEXT);
  assert.equal(r.passed, true);
});

test('claims-linter REJECTS an invented percentage', () => {
  const r = claimsLinter(OFF_BRAND, CONTEXT);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /340|92/);
});

test('claims-linter ignores small bare numbers that are not claims', () => {
  const r = claimsLinter('قانون الـ3 خطوات، و5 أفكار.', CONTEXT);
  assert.equal(r.passed, true);
});

test('claims-linter ignores a year but catches a marked multiplier', () => {
  assert.equal(claimsLinter('ورشة 2025 كانت ممتازة.', CONTEXT).passed, true);
  assert.equal(claimsLinter('حقق 13× أكثر تفاعلاً.', CONTEXT).passed, false);
});

test('claims-linter reads Arabic-Indic digits', () => {
  const r = claimsLinter('حقق ٣٤٠٪ نمواً.', CONTEXT);
  assert.equal(r.passed, false);
});

/* ------------------------------------------------- claims-linter: tokens --
 *
 * A CLAIM IS SOURCED BY A WHOLE TOKEN, NEVER BY A SUBSTRING.
 *
 * `context.includes("508")` is true of `ig_id: 1750899508`, and the contexts
 * this check runs against are full of 19-digit Instagram ids, uuids and ISO
 * timestamps — so almost any three-digit figure could be "found" inside one.
 * That was executed against the chat gate and it delivered a follower count no
 * row has ever held.
 *
 * These tests fix the boundary rules in both directions, because a check that
 * stopped matching real numbers would be a worse bug than the one it replaced.
 * ------------------------------------------------------------------------ */

/** One claim, one context, asked of the real check. */
function sourced(claim: string, context: string): boolean {
  return claimsLinter(`القيمة ${claim} في القياس.`, context).passed;
}

/**
 * The token set itself, so a boundary rule can be read off the test.
 *
 * STRINGS, not numbers: the linter compares canonical spellings, because
 * `Number("17509995080123456") === Number("17509995080123457")` is true and an
 * id that rounds onto its neighbour sources a figure nobody measured. Sorted
 * numerically all the same, so the expectations below stay readable.
 */
function tokens(context: string): string[] {
  return [...contextQuantities(context)].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
}

test('the context tokeniser splits on boundaries, not inside quantities', () => {
  // A digit run glued to a letter is an identifier fragment, not a quantity.
  assert.deepEqual(tokens('ig_id 1750899508 and uuid 550e8400-e29b-41d4'), ['1750899508']);
  // Separators hold a quantity together; markers end it without hiding it.
  assert.deepEqual(tokens('96,520 then 507.97 then 340% then 13×'), [
    '13',
    '340',
    '507.97',
    '96520',
  ]);
  // Both scripts reach the same quantities, which is why one normaliser runs.
  assert.deepEqual(tokens('٩٦٬٥٢٠ و ٥٠٧٫٩٧ و ٣٤٠٪'), ['340', '507.97', '96520']);
  // A date yields its parts, and none of them is the id beside it. `08` and `8`
  // are one key: a canonical spelling carries no leading zero.
  assert.deepEqual(tokens('2026-08-14 at 10:45'), ['8', '10', '14', '45', '2026']);
  // In a real ISO instant the letters swallow the parts they touch: 14 and 10
  // are glued to the T and the seconds to the Z, so none of them is a quantity
  // anybody may quote. Only the month and the minutes survive, and both are far
  // below the threshold at which a bare number counts as a claim at all.
  assert.deepEqual(tokens('2026-08-14T10:45:00Z'), ['8', '45', '2026']);
  // A blocks line yields exactly the sample size and the figure, plus the date.
  // Production no longer lints against a line in this shape — the key half is
  // not evidence, so run.ts and blocks.ts hand the linter the VALUES alone —
  // but the tokeniser's own boundary rules are still stated here, at the level
  // they live at.
  assert.deepEqual(
    tokens('[performance.personal.avg_engagement] mean (n=190, as_of=2026-08-14) = "508"'),
    ['8', '14', '190', '508', '2026'],
  );
});

test('claims-linter REJECTS a number that appears only inside a longer one', () => {
  assert.equal(sourced('508', 'ig_id: 1750899508'), false);
  assert.equal(sourced('899', 'ig_id: 1750899508'), false);
  // The id sources ITSELF, and only itself.
  assert.equal(sourced('1750899508', 'ig_id: 1750899508'), true);
});

test('claims-linter still passes a number that is a whole token', () => {
  assert.equal(sourced('508', 'avg_engagement = "508"'), true);
  assert.equal(sourced('508', 'the mean was 508.'), true);
  assert.equal(sourced('508', '(n=508, as_of=2026-08-14)'), true);
  assert.equal(sourced('508', 'a range of 508–600'), true);
});

test('claims-linter does not read a quantity out of a uuid or a timestamp', () => {
  // Every hex group here is glued to a letter, so none of them is a quantity.
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(sourced('550', uuid), false);
  assert.equal(sourced('8400', uuid), false);
  assert.equal(sourced('716', uuid), false);
  // The all-digit group is a token and does source itself.
  assert.equal(sourced('446655440000', uuid), true);
});

test('claims-linter keeps a thousands separator inside one token, in both scripts', () => {
  // Written with commas, quoted plain — and the other way round.
  assert.equal(sourced('96520', 'total = 96,520'), true);
  assert.equal(sourced('96,520', 'total = 96520'), true);
  // The Arabic-Indic thousands separator U+066C behaves as the comma does.
  assert.equal(sourced('96520', 'المجموع ٩٦٬٥٢٠'), true);
  assert.equal(sourced('٩٦٥٢٠', 'total = 96,520'), true);
  // And a separator does NOT split the token into pieces anyone may quote.
  assert.equal(sourced('520', 'total = 96,520'), false);
  assert.equal(sourced('520', 'المجموع ٩٦٬٥٢٠'), false);
});

test('claims-linter keeps a decimal point inside one token, in both scripts', () => {
  assert.equal(sourced('507.97', 'mean = 507.97'), true);
  // 507 is not 507.97. The point does not end a token and start a new one.
  assert.equal(sourced('507', 'mean = 507.97'), false);
  // Neither half of a decimal is quotable on its own. Both probes are three
  // digits on purpose: a shorter fraction would pass this check by being under
  // the claim threshold rather than by being unsourced, which would make the
  // assertion true for the wrong reason.
  assert.equal(sourced('1507', 'mean = 1507.972'), false);
  assert.equal(sourced('972', 'mean = 1507.972'), false);
  // The Arabic-Indic decimal separator U+066B behaves as the point does.
  assert.equal(sourced('507.97', 'المتوسط ٥٠٧٫٩٧'), true);
  assert.equal(sourced('507', 'المتوسط ٥٠٧٫٩٧'), false);
});

test('claims-linter lets a unit marker end a token rather than hide it', () => {
  // %, the Arabic ٪, and × all follow a quantity; none of them is a letter, so
  // none of them buries the number in front of it.
  assert.equal(claimsLinter('نما ٣٤٠٪.', 'growth 340% year on year').passed, true);
  assert.equal(claimsLinter('حقق 13× أكثر.', 'multiple 13× the average').passed, true);
  assert.equal(claimsLinter('حقق 13× أكثر.', 'multiple 13x the average').passed, true);
  // A trailing x is the one letter allowed to end a token, because `13x` is
  // read as a marked claim on the output side too.
  assert.equal(sourced('340', 'growth 340%'), true);
});

/* ============================================ the executed exploits, replayed ==
 *
 * This file used to hold TWO definitions of "a number": one that found CLAIMS in
 * a draft and one that found EVIDENCE in a context. Every disagreement between
 * them was a door, and four of them were walked through against the running
 * gate. Each is replayed below as the attack it was, with its true-positive
 * control beside it, because a check that stopped finding real numbers would be
 * a worse bug than the ones it replaced.
 *
 * The probe numbers are the ones the proofs used. None of them is a measurement
 * of anything: 88123 is the laundering probe, 88508 the split probe, and the two
 * ids below are an id and its off-by-one neighbour. They are invented on
 * purpose — that is what makes them traps.
 * ============================================================================= */

/** 88508, in Arabic-Indic digits, waiting to be split by one separator. */
const SPLIT_HEAD = '٨٨';
const SPLIT_TAIL = '٥٠٨';

/**
 * Every separator the executed attack used. Not one of them is exotic: the
 * Arabic thousands separator is how the figure is spelled correctly, and the
 * rest are the space characters any keyboard and any copy-paste produce.
 */
const SPLIT_SEPARATORS: readonly { name: string; char: string }[] = [
  { name: 'U+066C, the Arabic thousands separator', char: '\u066C' },
  { name: 'a plain space', char: '\u0020' },
  { name: 'a no-break space', char: '\u00A0' },
  { name: 'a narrow no-break space', char: '\u202F' },
  { name: 'a zero-width space', char: '\u200B' },
  { name: 'a zero-width non-joiner', char: '\u200C' },
  { name: 'a right-to-left mark', char: '\u200F' },
  { name: 'a newline', char: '\n' },
];

test('EXPLOIT 1 — a claim cannot be split into a sub-100 head and a sourced tail', () => {
  // CONTEXT sources 508 and nothing sources 88508, so every draft below states a
  // figure no measurement holds. The head is under the claim floor, which is
  // exactly what used to make it disappear silently.
  assert.equal(CONTEXT.includes('88508'), false, 'the trap is real: nothing sources it');
  for (const separator of SPLIT_SEPARATORS) {
    const draft = `عدد المتابعين ${SPLIT_HEAD}${separator.char}${SPLIT_TAIL} متابع.`;
    assert.equal(
      claimsLinter(draft, CONTEXT).passed,
      false,
      `${separator.name}: the figure passed with only its tail sourced`,
    );
  }
});

test('EXPLOIT 2 — a comma list does not manufacture the number it spells', () => {
  // "ids: 1,2,3" used to yield the single evidence token 123.
  assert.equal(sourced('123', 'ids: 1,2,3'), false);
  assert.equal(sourced('123', 'ranks: 1, 2, 3'), false);
  // THE CONTROL. A real grouped figure is still one quantity, in both scripts,
  // and still sources itself however the claim spells it.
  assert.equal(sourced('96520', 'total = 96,520'), true);
  assert.equal(sourced('96,520', 'total = 96520'), true);
  assert.equal(sourced('96520', 'المجموع ٩٦٬٥٢٠'), true);
});

/** An id past 2^53, and the id one digit away from it. */
const BIG_ID = '17509995080123456';
const BIG_ID_NEIGHBOUR = '17509995080123457';

test('EXPLOIT 3 — an id does not source its off-by-one neighbour', () => {
  // The two ids are ONE JavaScript number, which is why comparing by value was
  // the defect. If this assertion ever fails, the exploit is gone from the
  // language and this test can go with it.
  assert.equal(Number(BIG_ID) === Number(BIG_ID_NEIGHBOUR), true);
  assert.equal(sourced(BIG_ID_NEIGHBOUR, `ig_id: ${BIG_ID}`), false);
  // THE CONTROL. The id still sources itself, exactly and only.
  assert.equal(sourced(BIG_ID, `ig_id: ${BIG_ID}`), true);
});

test('EXPLOIT 4 — no numeral script is invisible to the claim extractor', () => {
  // 88123 in full-width and in Devanagari digits, against an EMPTY context.
  // Neither used to be seen as a claim at all, so both were delivered.
  assert.equal(claimsLinter('عدد المتدربين ８８１２３ متدرب.', '').passed, false);
  assert.equal(claimsLinter('عدد المتدربين ८८१२३ متدرب.', '').passed, false);
  // THE CONTROL. One normaliser, so every script reaches the same quantity and a
  // context that really does state the figure still sources it.
  assert.equal(claimsLinter('عدد المتدربين ８８１２３ متدرب.', 'trainees = 88123').passed, true);
  assert.equal(claimsLinter('عدد المتدربين ८८१२३ متدرب.', 'trainees = 88123').passed, true);
});

/* --------------------------------------------------------- register-score -- */

test('register-score rates his own caption highly', () => {
  const r = registerScore('البرّ هين … تكسب الناس باللين …', VOICE);
  assert.equal(r.passed, true);
  assert.equal(r.detail?.heuristic, true);
});

test('register-score flags English marketing copy — as a WARNING, never a veto', () => {
  const r = registerScore(OFF_BRAND, VOICE);
  assert.equal(r.passed, false);
  assert.equal(r.severity, 'warning');
});

test('register-score cannot score with no voice examples, and says so', () => {
  const r = registerScore('أي نص', []);
  assert.equal(r.passed, false);
  assert.equal(r.severity, 'warning');
  assert.equal(r.detail?.score, null);
});

/* ----------------------------------------------------- guideline-structure -- */

function sectionsWithAll(): GuidelineSection[] {
  return [
    'positioning', 'audience', 'voice', 'color',
    'typography', 'logo_usage', 'social', 'arabic_specific',
  ].map((key) => ({
    key,
    title_ar: key,
    lines: [{ text: 'محتوى', source: 'brand.facts' }],
  }));
}

test('guideline-structure passes a complete, fully sourced document', () => {
  assert.equal(guidelineStructure(sectionsWithAll()).passed, true);
});

test('guideline-structure REJECTS a missing mandatory section', () => {
  const sections = sectionsWithAll().filter((s) => s.key !== 'arabic_specific');
  const r = guidelineStructure(sections);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /arabic_specific/);
});

test('guideline-structure REJECTS an unsourced line', () => {
  const sections = sectionsWithAll();
  sections[0].lines.push({ text: 'ادعاء بلا مصدر', source: '' });
  const r = guidelineStructure(sections);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /no source/i);
});

test('guideline-structure REJECTS an empty section rather than letting it be invented', () => {
  const sections = sectionsWithAll();
  sections[2].lines = [];
  const r = guidelineStructure(sections);
  assert.equal(r.passed, false);
  assert.match(r.evidence, new RegExp(TBD_AR));
});

/* ------------------------------------------------------- frame-structure -- */

const FRAMES: FrameLike[] = [
  { order: 1, scene_beat_ar: 'مشهد', overlay_ar: 'نص', shot_direction: 'close', duration_s: 3, palette_ref: 'ink' },
  { order: 2, scene_beat_ar: 'مشهد', overlay_ar: 'نص', shot_direction: 'wide', duration_s: 4, palette_ref: 'turquoise' },
];

test('frame-structure accepts ordered, timed frames', () => {
  const r = frameStructure(FRAMES);
  assert.equal(r.passed, true);
  assert.equal(r.detail?.totalSeconds, 7);
});

test('frame-structure rejects a gap in the order', () => {
  const r = frameStructure([FRAMES[0], { ...FRAMES[1], order: 3 }]);
  assert.equal(r.passed, false);
});

test('frame-structure rejects an impossible duration', () => {
  const r = frameStructure([{ ...FRAMES[0], duration_s: 0 }]);
  assert.equal(r.passed, false);
});

test('frame-structure rejects an empty storyboard', () => {
  assert.equal(frameStructure([]).passed, false);
});

/* -------------------------------------------------------------- runLaw --- */

test('runLaw passes clean output and reports every applicable check', () => {
  const report = runLaw({
    text: 'البرّ هين … تكسب الناس باللين … استخدم #48C0C0 للعنوان.',
    context: CONTEXT,
    swatches: SWATCHES,
    voiceExamples: VOICE,
  });
  assert.equal(report.passed, true);
  assert.equal(report.violations.length, 0);
  assert.equal(report.results.length, 3);
});

test('runLaw FAILS the off-brand draft with more than one violation', () => {
  const report = runLaw({
    text: OFF_BRAND,
    context: CONTEXT,
    swatches: SWATCHES,
    voiceExamples: VOICE,
  });
  assert.equal(report.passed, false);
  assert.ok(report.violations.length >= 2, 'expected palette and claims violations');
  assert.ok(report.warnings.length >= 1, 'expected the register warning');
  assert.ok(report.violations.every((v) => v.source === 'law'));
});

test('runLaw skips checks whose inputs were not supplied', () => {
  const report = runLaw({ text: 'نص', swatches: SWATCHES });
  assert.equal(report.results.length, 1);
  assert.equal(report.passed, true);
});
