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
