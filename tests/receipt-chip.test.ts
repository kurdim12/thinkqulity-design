import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ABSENT_FIGURE_CLASS,
  EM_DASH,
  FIGURE_CLASS,
  RECEIPT_FIGURE_CLASS,
  TOKENS,
  resolveReceipt,
  type ReceiptInput,
} from '../src/lib/theme.ts';

/* ===========================================================================
 * THE RECEIPT CHIP, AND THE TOKENS IT IS DRAWN WITH.
 *
 * These tests are about the chip's LOGIC, never its pixels. That is not a
 * limitation dressed up as a principle: the thing that can silently go wrong
 * about a receipt is not its border radius, it is whether it appears at all.
 * A chip that renders over a value with no key is a promise the product cannot
 * keep, and it looks perfect in a screenshot.
 *
 * `node --test --experimental-strip-types` cannot load a .tsx file, which is
 * exactly why `resolveReceipt` lives in src/lib/theme.ts and the component is a
 * thin renderer over it — every decision the chip makes is reachable from here.
 * ======================================================================== */

const GLOBALS_CSS = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

/** The one real measurement in the live database, used so nothing here is invented. */
const PERSONAL_AVG: ReceiptInput = {
  value: '508',
  sourceKey: 'profiles.personal.avg_engagement',
  n: 190,
  computedAt: '2026-08-14',
  label: 'متوسط التفاعل — الحساب الشخصي',
  href: '/data',
};

/* ------------------------------------------------------- with a source key -- */

test('a value with a source key resolves to a receipt, verbatim', () => {
  const resolved = resolveReceipt(PERSONAL_AVG);
  assert.equal(resolved.kind, 'receipt');
  if (resolved.kind !== 'receipt') return;

  assert.equal(resolved.figure.text, '508');
  assert.equal(resolved.sourceKey, 'profiles.personal.avg_engagement');
  assert.equal(resolved.n, '190');
  assert.equal(resolved.computedAt, '2026-08-14');
  assert.equal(resolved.label, 'متوسط التفاعل — الحساب الشخصي');
  assert.equal(resolved.href, '/data');
  assert.equal(resolved.figure.className, RECEIPT_FIGURE_CLASS);
});

test('a receipt is never opened onto nothing', () => {
  // Every shape that still produces a chip must produce a chip with something
  // under it. A popover with an empty body is worse than no chip at all: it
  // teaches the reader that the dotted underline means nothing.
  const shapes: ReceiptInput[] = [
    PERSONAL_AVG,
    { value: '40', sourceKey: 'profiles.academy.avg_engagement' },
    { value: '33,176', sourceKey: 'posts.top.engagement', n: 0 },
    { value: '0', sourceKey: 'analyses.count', computedAt: '2026-08-14' },
    { value: ' 320 ', sourceKey: ' posts.count ', label: '   ', href: '   ' },
  ];

  for (const shape of shapes) {
    const resolved = resolveReceipt(shape);
    assert.equal(resolved.kind, 'receipt', `expected a receipt for ${JSON.stringify(shape)}`);
    if (resolved.kind !== 'receipt') continue;
    assert.ok(resolved.sourceKey.length > 0, 'a receipt always names its key');
    assert.ok(resolved.figure.text.length > 0, 'a receipt always shows a value');
    assert.ok(resolved.n.length > 0, 'the sample-size row is always filled');
    assert.ok(resolved.computedAt.length > 0, 'the computed-at row is always filled');
  }
});

test('blank label and href become null rather than empty rows', () => {
  const resolved = resolveReceipt({ value: '320', sourceKey: 'posts.count', label: '', href: '  ' });
  assert.equal(resolved.kind, 'receipt');
  if (resolved.kind !== 'receipt') return;
  // null is what the component branches on: no label heading, and no dead link
  // to a surface that was never named.
  assert.equal(resolved.label, null);
  assert.equal(resolved.href, null);
});

/* ---------------------------------------------------- without a source key -- */

test('a value with no source key is plain text, not a dangling chip', () => {
  for (const sourceKey of [undefined, null, '', '   ']) {
    const resolved = resolveReceipt({ value: '508', sourceKey });
    assert.equal(resolved.kind, 'plain', `sourceKey ${JSON.stringify(sourceKey)} must not chip`);
    assert.equal(resolved.figure.text, '508');
    assert.equal(resolved.figure.className, FIGURE_CLASS);
    assert.ok(
      !resolved.figure.className.includes('tq-receipt-figure'),
      'plain text must not wear the receipt underline',
    );
  }
});

test('an absent value is an em-dash and never a zero', () => {
  for (const value of [undefined, null, '', '   ', EM_DASH, '–', ` ${EM_DASH} `]) {
    const resolved = resolveReceipt({ value });
    assert.equal(resolved.kind, 'absent', `${JSON.stringify(value)} must resolve as absent`);
    assert.equal(resolved.figure.text, EM_DASH);
    assert.notEqual(resolved.figure.text, '0');
    assert.equal(resolved.figure.className, ABSENT_FIGURE_CLASS);
  }
});

test('an absent value stays absent even when a source key is offered', () => {
  // The tempting bug: a key exists, so chip it — and the reader presses a dash
  // and is told a measurement was taken. It was not.
  const resolved = resolveReceipt({ value: null, sourceKey: 'comments.count', n: 0 });
  assert.equal(resolved.kind, 'absent');
  assert.equal(resolved.figure.text, EM_DASH);
});

test('a measured zero is a receipt, because zero is not absence', () => {
  const resolved = resolveReceipt({ value: '0', sourceKey: 'analyses.count', n: 320 });
  assert.equal(resolved.kind, 'receipt');
  assert.equal(resolved.figure.text, '0');
});

/* --------------------------------------------------------- RTL isolation -- */

test('the figure is LTR-isolated and tabular in every outcome', () => {
  const outcomes = [
    resolveReceipt(PERSONAL_AVG),
    resolveReceipt({ value: '508' }),
    resolveReceipt({ value: null }),
  ];

  for (const resolved of outcomes) {
    // The direction travels with the resolution, so a figure dropped into
    // Arabic prose cannot be rendered without it: «متوسط 508 تفاعل» keeps the
    // 508 reading left-to-right inside a right-to-left sentence.
    assert.equal(resolved.figure.dir, 'ltr', `${resolved.kind} figure lost its direction`);
    assert.ok(
      resolved.figure.className.split(' ').includes('tq-num'),
      `${resolved.kind} figure lost tq-num, which carries the isolation and tabular figures`,
    );
  }
});

test('the classes the resolution hands out are the ones globals.css defines', () => {
  for (const className of [FIGURE_CLASS, RECEIPT_FIGURE_CLASS, ABSENT_FIGURE_CLASS]) {
    for (const name of className.split(' ')) {
      assert.ok(
        GLOBALS_CSS.includes(`.${name}`),
        `${name} is handed to the DOM but styled nowhere`,
      );
    }
  }
});

/* -------------------------------------------- it never invents a quantity -- */

test('the figure is exactly the string it was given', () => {
  // Hard rule 20 at the last inch: no grouping, no rounding, no re-localising,
  // no digit transliteration. Whatever was measured is what is shown.
  const values = [
    '508',
    '1234567',
    '33,176',
    '٥٠٨',
    '12.7x',
    '0.0',
    '-4',
    '+18%',
    'لا جديد يستحق قرار',
  ];

  for (const value of values) {
    const bare = resolveReceipt({ value });
    assert.equal(bare.figure.text, value);
    const chipped = resolveReceipt({ value: ` ${value} `, sourceKey: 'k' });
    assert.equal(chipped.figure.text, value, 'only surrounding whitespace may be removed');
  }
});

test('a sample size is shown only when it is a whole count', () => {
  const cases: [number | null | undefined, string][] = [
    [190, '190'],
    [0, '0'],
    [undefined, EM_DASH],
    [null, EM_DASH],
    [-1, EM_DASH],
    [1.5, EM_DASH],
    [Number.NaN, EM_DASH],
    [Number.POSITIVE_INFINITY, EM_DASH],
  ];

  for (const [n, expected] of cases) {
    const resolved = resolveReceipt({ value: '508', sourceKey: 'k', n });
    assert.equal(resolved.kind, 'receipt');
    if (resolved.kind !== 'receipt') continue;
    assert.equal(resolved.n, expected, `n=${String(n)}`);
  }
});

test('an undated measurement says so instead of guessing', () => {
  for (const computedAt of [undefined, null, '', '   ']) {
    const resolved = resolveReceipt({ value: '508', sourceKey: 'k', computedAt });
    assert.equal(resolved.kind, 'receipt');
    if (resolved.kind !== 'receipt') continue;
    assert.equal(resolved.computedAt, EM_DASH);
  }

  const dated = resolveReceipt({ value: '508', sourceKey: 'k', computedAt: ' 2026-08-14 ' });
  assert.equal(dated.kind, 'receipt');
  if (dated.kind !== 'receipt') return;
  assert.equal(dated.computedAt, '2026-08-14');
});

/* ------------------------------------------------------------- the tokens -- */

const MARKED_BLOCK = /\/\* tq-colour-tokens:start \*\/([\s\S]*?)\/\* tq-colour-tokens:end \*\//;

function declaredTokens(css: string): Record<string, string> {
  const block = MARKED_BLOCK.exec(css);
  assert.ok(block, 'globals.css lost its tq-colour-tokens markers');
  const declared: Record<string, string> = {};
  for (const line of block[1].split(/\r?\n/)) {
    const match = /^\s*(--tq-[a-z0-9-]+)\s*:\s*(.+?)\s*;\s*$/.exec(line);
    if (match) declared[match[1]] = match[2];
  }
  return declared;
}

test('globals.css and theme.ts declare the same colours, character for character', () => {
  // This is what makes "a colour cannot be defined twice" true rather than
  // hoped for: the CSS the browser reads and the record antd is themed from
  // are the same list, and drift in either direction fails here.
  assert.deepEqual(declaredTokens(GLOBALS_CSS), { ...TOKENS });
});

/** Every colour literal written outside the marked block, in source order. */
function strayColours(css: string): string[] {
  // Comments are stripped after the marked block is removed, so prose may name
  // a colour without the scan mistaking the sentence for a declaration.
  const outside = css.replace(MARKED_BLOCK, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...(outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []), ...(outside.match(/\brgba?\(/g) ?? [])];
}

const CONTROL_CSS = [
  '/* tq-colour-tokens:start */',
  ':root {',
  '  --tq-paper: #F7F5F1;',
  '  --tq-lift: rgba(23, 21, 15, 0.02);',
  '}',
  '/* tq-colour-tokens:end */',
  '/* prose may name #BADBAD and rgba(1, 2, 3, 0.4) without being a declaration */',
  '.planted { color: #C9A227; background: rgba(0, 0, 0, 0.5); border-color: var(--tq-line); }',
].join('\n');

test('the colour scan catches what it claims to catch', () => {
  // A scan that silently matches nothing would pass the check below on any file
  // at all, so it is first run against a control with planted positives and a
  // planted near-miss in a comment.
  assert.deepEqual(strayColours(CONTROL_CSS), ['#C9A227', 'rgba(']);
  assert.deepEqual(declaredTokens(CONTROL_CSS), {
    '--tq-paper': '#F7F5F1',
    '--tq-lift': 'rgba(23, 21, 15, 0.02)',
  });
});

test('no colour literal is written outside the token block', () => {
  assert.deepEqual(
    strayColours(GLOBALS_CSS),
    [],
    'a colour outside the token block is a second definition of a colour',
  );
});

test('no two tokens are the same colour under different names', () => {
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(TOKENS)) {
    const previous = seen.get(value);
    assert.equal(previous, undefined, `${name} repeats the value of ${String(previous)}`);
    seen.set(value, name);
  }
});
