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

/** The token set itself, sorted, so a boundary rule can be read off the test. */
function tokens(context: string): number[] {
  return [...contextQuantities(context)].sort((a, b) => a - b);
}

test('the context tokeniser splits on boundaries, not inside quantities', () => {
  // A digit run glued to a letter is an identifier fragment, not a quantity.
  assert.deepEqual(tokens('ig_id 1750899508 and uuid 550e8400-e29b-41d4'), [1750899508]);
  // Separators hold a quantity together; markers end it without hiding it.
  assert.deepEqual(tokens('96,520 then 507.97 then 340% then 13×'), [13, 340, 507.97, 96520]);
  // Both scripts reach the same numbers, which is why normaliseDigits runs first.
  assert.deepEqual(tokens('٩٦٬٥٢٠ و ٥٠٧٫٩٧ و ٣٤٠٪'), [340, 507.97, 96520]);
  // A date yields its parts, and none of them is the id beside it.
  assert.deepEqual(tokens('2026-08-14 at 10:45'), [8, 10, 14, 45, 2026]);
  // In a real ISO instant the letters swallow the parts they touch: 14 and 10
  // are glued to the T and the seconds to the Z, so none of them is a quantity
  // anybody may quote. Only the month and the minutes survive, and both are far
  // below the threshold at which a bare number counts as a claim at all.
  assert.deepEqual(tokens('2026-08-14T10:45:00Z'), [8, 45, 2026]);
  // A blocks line yields exactly the sample size and the figure, plus the date.
  assert.deepEqual(
    tokens('[performance.personal.avg_engagement] mean (n=190, as_of=2026-08-14) = "508"'),
    [8, 14, 190, 508, 2026],
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
