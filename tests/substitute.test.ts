import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSourceKey,
  REDACTED,
  substitute,
  valueMap,
  type SubstituteResult,
} from '../src/lib/brain/substitute.ts';

/**
 * ===========================================================================
 * THE ATTACK TESTS COME FIRST, AND EVERY ONE OF THEM ACTUALLY HAPPENED
 * ===========================================================================
 * Rounds 1 to 3 of the number-linter each closed the exploit in front of it and
 * each was reopened by the next spelling of the same idea. So these are not
 * "cases": they are the exploit log, and what they assert is that each one is
 * now structurally impossible rather than newly enumerated.
 *
 * EVERY INVISIBLE CHARACTER IS WRITTEN AS AN ESCAPE. Hard rule 7 forbids a raw
 * control byte in any file, and this project has twice produced a FALSE CLEAN
 * SCAN from a pattern carrying a byte nobody could see. An escape in the source is
 * reviewable; the character itself is not. The final test in this file is the CONTROL
 * for that claim - it carries the planted positives and no NUL, and asserts that a
 * scan really does find them.
 */

/** The zero-width and invisible characters the exploits were spelled with. */
const CGJ = '\u034F'; // COMBINING GRAPHEME JOINER - \p{Mn}. The round-3 door.
const ZWSP = '\u200B'; // ZERO WIDTH SPACE - \p{Cf}.
const RLM = '\u200F'; // RIGHT-TO-LEFT MARK - \p{Cf}.
const ARABIC_THOUSANDS = '\u066C'; // ARABIC THOUSANDS SEPARATOR - a separator, not a space.

/**
 * The keyed truth, from the CANONICAL FACTS: one snapshot, 2026-08-14, personal
 * n=190 avg 508, academy n=130 avg 40. Values are strings this codebase computed
 * — the model never sees a number it can retype, only a name for one.
 */
const VALUES = valueMap({
  'performance.personal.avg_engagement': '508',
  'performance.academy.avg_engagement': '40',
  'performance.personal.post_count': '190',
  'performance.snapshot.taken_on': '2026-08-14',
  'performance.gap.personal_vs_academy': '12.7×',
  /* A key MINTED FROM DATA: `keySegment()` keeps \p{N}, so a cluster a model
   * named "88123" mints a key with 88123 in it. See the test below. */
  'performance.clusters.88123.n': '12',
  /* A caption, verbatim, digits and all. This is why "a number inside a quoted
   * span" is NOT an exception in the engine — a quote is a value. */
  'audience.captions.headcount': 'عدد المتدربين 88123 متدرب',
  /* A swatch. The palette is a closed set the app holds, so a hex is a value. */
  'brand.palette.turquoise': '#48C0C0',
  /* An absence. Rule 2: absent is an em-dash, never a zero. */
  'profiles.academy.followers': '—',
});

/* ------------------------------------------------------------- helpers -- */

const kindsOf = (result: SubstituteResult): string[] =>
  result.violations.map((violation) => violation.kind);

const rawsOf = (result: SubstituteResult): (string | undefined)[] =>
  result.violations.map((violation) => violation.raw);

const run = (draft: string): SubstituteResult => substitute(draft, VALUES);

/* ========================================================================= */
/* 1. THE EXPLOIT LOG                                                        */
/* ========================================================================= */

test('ATTACK «٨٨<U+034F>٥٠٨» typed directly: both halves are violations', () => {
  /* THE ROUND-3 COUNTER-EXAMPLE, VERBATIM. It renders to the operator as ٨٨٥٠٨.
   * U+034F is \p{Mn}: not a joiner and not blank, so the claims-linter splits it
   * into ٨٨ and ٥٠٨, drops the head under its 100 floor and checks only the
   * sourced tail. There is no floor here — the model may not type digits at all
   * — so the head is exactly as loud as the tail. */
  const result = run(`المتوسط ٨٨${CGJ}٥٠٨ متابع`);

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity', 'bare-quantity']);
  assert.deepEqual(rawsOf(result), ['٨٨', '٥٠٨']);
  assert.equal(result.substitutions.length, 0);
});

test('ATTACK the same, with the tail as an honest placeholder: the head still fails', () => {
  /* The shape the exploit really takes: cite the number you have, type the digits
   * you want in front of it. The head is not under a floor, it is OUTSIDE THE
   * SUBSTITUTED SPAN — a position, not a pattern, and positions cannot be
   * respelled. */
  const result = run(`٨٨${CGJ}{{performance.personal.avg_engagement}}`);

  assert.equal(result.final, `٨٨${CGJ}508`);
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.equal(result.violations[0].raw, '٨٨');
  /* The tail is a real substitution and is reported as one. */
  assert.deepEqual([...result.substitutions], [
    { key: 'performance.personal.avg_engagement', value: '508', start: 3, end: 6 },
  ]);
});

test('ATTACK «٨٨٬٥٠٨» (U+066C thousands separator) typed directly', () => {
  /* The linter's claim side once did not know U+066C, so this read as 88 and 508
   * — 88 under the floor, 508 sourcing itself. One quantity, one violation. */
  const result = run(`المتوسط ٨٨${ARABIC_THOUSANDS}٥٠٨ متابع`);

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), [`٨٨${ARABIC_THOUSANDS}٥٠٨`]);
});

test('ATTACK a zero-width space inside the digits', () => {
  const result = run(`88${ZWSP}508 متابع`);

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), [`88${ZWSP}508`]);
});

test('ATTACK a bidi mark inside the digits', () => {
  const result = run(`٨٨${RLM}٥٠٨`);

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
});

test('ATTACK full-width ８８１２３', () => {
  const result = run('التفاعل ８８１２３');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), ['８８１２３']);
});

test('ATTACK Devanagari ८८१२३', () => {
  const result = run('التفاعل ८८१२३');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), ['८८१२३']);
});

test('ATTACK superscript ⁸⁸¹²³, which no decimal tokeniser can see', () => {
  /* \p{No}, NOT \p{Nd}. `quantities()` models decimal digits and only decimal
   * digits — correctly, since a superscript cannot be canonicalised into a
   * positional number — so this string is INVISIBLE to it and would sail through
   * a check built only on it. The separate non-decimal rule is what catches it,
   * and this test is why that rule exists. */
  const result = run('التفاعل ⁸⁸¹²³');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), ['⁸⁸¹²³']);
});

test('ATTACK a vulgar fraction and a Roman numeral are refused too', () => {
  const result = run('نصف ½ الجمهور، الفصل Ⅻ');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity', 'bare-quantity']);
  assert.deepEqual(rawsOf(result), ['½', 'Ⅻ']);
});

/* ========================================================================= */
/* 2. THE KEY IS NOT A NUMBER, AND AN UNKNOWN KEY NEVER ECHOES               */
/* ========================================================================= */

test('an unknown key is a violation, and the key is NOT echoed into the text', () => {
  const result = run('المتوسط {{performance.personal.avg_reach}} لكل منشور');

  assert.equal(result.final, 'المتوسط [?] لكل منشور');
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['unknown-key']);
  /* Reported, so the operator can fix the draft... */
  assert.equal(result.violations[0].key, 'performance.personal.avg_reach');
  /* ...and absent from the text, which is the path to the reader. */
  assert.equal(result.final.includes('avg_reach'), false);
  assert.equal(result.final.includes('{{'), false);
  assert.equal(result.final.includes('}}'), false);
  assert.equal(result.substitutions.length, 0);
});

test('an unknown key whose SEGMENTS ARE DIGITS leaks none of them', () => {
  /* The hint's question: is `{{performance.clusters.88508.n}}` a way to write
   * 88508? No — the output is drawn from the value map, so a key that resolves
   * to nothing emits nothing. */
  const result = run('عدد {{performance.clusters.88508.n}} منشور');

  assert.equal(result.final, 'عدد [?] منشور');
  assert.equal(result.final.includes('88508'), false);
  assert.equal(result.final.includes('8'), false);
  assert.deepEqual(kindsOf(result), ['unknown-key']);
  assert.equal(result.violations[0].key, 'performance.clusters.88508.n');
});

test('a KNOWN key containing digits substitutes its VALUE; the key digits never appear', () => {
  /* `keySegment()` keeps \p{N}, so a cluster labelled "88123" really does mint
   * this key. What lands is 12 — the count this codebase computed — and 88123
   * was only ever a name. */
  const result = run('عدد المنشورات {{performance.clusters.88123.n}}');

  assert.equal(result.final, 'عدد المنشورات 12');
  assert.equal(result.final.includes('88123'), false);
  assert.equal(result.deliverable, true);
  assert.deepEqual([...result.substitutions], [
    { key: 'performance.clusters.88123.n', value: '12', start: 14, end: 16 },
  ]);
});

test('a placeholder whose contents are digits is malformed, and the digits do not land', () => {
  /* A key must begin with an ASCII lowercase letter, which is what makes "a key
   * is not a quantity" structural rather than hopeful. */
  const arabic = run('المتوسط {{٨٨٥٠٨}} متابع');
  assert.equal(arabic.final, 'المتوسط [?] متابع');
  assert.equal(arabic.final.includes('٨٨٥٠٨'), false);
  assert.deepEqual(kindsOf(arabic), ['malformed-placeholder']);

  const ascii = run('{{88508}}');
  assert.equal(ascii.final, REDACTED);
  assert.equal(ascii.deliverable, false);
  assert.deepEqual(kindsOf(ascii), ['malformed-placeholder']);
});

test('the value map is a Map, so inherited object keys resolve to nothing', () => {
  /* Against an object literal, `{{constructor}}` would find Object.prototype's
   * and substitute a function's source into a deliverable. A Map has no
   * inherited keys, so unknown means unknown. */
  const result = substitute('{{constructor}} و {{tostring}}', valueMap({}));

  assert.equal(result.final, '[?] و [?]');
  assert.deepEqual(kindsOf(result), ['unknown-key', 'unknown-key']);
  assert.equal(result.final.includes('function'), false);
});

test('`__proto__` is not even a well-formed key', () => {
  const result = run('{{__proto__}}');

  assert.equal(result.final, REDACTED);
  assert.deepEqual(kindsOf(result), ['malformed-placeholder']);
});

/* ========================================================================= */
/* 3. A LEGITIMATE DRAFT                                                     */
/* ========================================================================= */

test('a clean draft: every number a placeholder, all keys known, values verbatim', () => {
  const draft =
    'متوسط التفاعل على الحساب الشخصي {{performance.personal.avg_engagement}} ' +
    'مقابل {{performance.academy.avg_engagement}} للأكاديمية.';

  const result = substitute(draft, VALUES);

  /* Asserted as an exact string: the Arabic around each substitution is
   * untouched, character for character, and nothing was normalised in passing. */
  assert.equal(result.final, 'متوسط التفاعل على الحساب الشخصي 508 مقابل 40 للأكاديمية.');
  assert.equal(result.deliverable, true);
  assert.deepEqual([...result.violations], []);
  assert.deepEqual(
    result.substitutions.map((made) => [made.key, made.value]),
    [
      ['performance.personal.avg_engagement', '508'],
      ['performance.academy.avg_engagement', '40'],
    ],
  );
  /* Each recorded span really does hold its value in the final text. */
  for (const made of result.substitutions) {
    assert.equal(result.final.slice(made.start, made.end), made.value);
  }
});

test('a value carrying its own digits and separators survives intact', () => {
  const result = run('اللقطة بتاريخ {{performance.snapshot.taken_on}}');

  assert.equal(result.final, 'اللقطة بتاريخ 2026-08-14');
  assert.equal(result.deliverable, true);
  assert.deepEqual([...result.violations], []);
});

test('a value that is a unit-carrying figure passes; the model adding the unit does not', () => {
  const supplied = run('الفارق {{performance.gap.personal_vs_academy}}');
  assert.equal(supplied.final, 'الفارق 12.7×');
  assert.equal(supplied.deliverable, true);

  /* "12.7x" is the exact fabrication src/lib/brain/law/source-keys.ts was
   * written about. A unit is part of the figure — a unit the model chose is a
   * magnitude the model chose. */
  const typed = run('الفارق {{performance.personal.avg_engagement}}٪');
  assert.equal(typed.final, 'الفارق 508٪');
  assert.equal(typed.deliverable, false);
  assert.deepEqual(kindsOf(typed), ['glued-value']);
});

test('an absent measurement is an em-dash and is deliverable', () => {
  const result = run('متابعو الأكاديمية {{profiles.academy.followers}}');

  assert.equal(result.final, 'متابعو الأكاديمية —');
  assert.equal(result.deliverable, true);
});

test('prose with no placeholder and no numeral is deliverable and untouched', () => {
  const draft = 'النص لا يحتوي على أرقام، والفكرة تقاس بالوضوح لا بالحجم.';
  const result = run(draft);

  assert.equal(result.final, draft);
  assert.equal(result.deliverable, true);
  assert.deepEqual([...result.violations], []);
});

test('an empty draft is deliverable and empty', () => {
  const result = run('');

  assert.equal(result.final, '');
  assert.equal(result.deliverable, true);
  assert.deepEqual([...result.violations], []);
});

/* ========================================================================= */
/* 4. WELDING SOMETHING ONTO A REAL VALUE                                    */
/* ========================================================================= */

test('digits typed against the front of a substituted value are a violation', () => {
  const result = run('{{performance.personal.avg_engagement}}');
  assert.equal(result.final, '508');

  const glued = run('٥{{performance.personal.avg_engagement}}');
  assert.equal(glued.final, '٥508');
  assert.equal(glued.deliverable, false);
  assert.deepEqual(kindsOf(glued), ['glued-value']);
  assert.equal(glued.violations[0].raw, '٥508');
});

test('an invisible between typed digits and a real value does not split the claim', () => {
  /* The tokeniser joins across \p{Cf}, so this is ONE quantity that runs across
   * the edge of the substituted span — not a small bare number beside a sourced
   * one. */
  const result = run(`٨٨${ZWSP}{{performance.personal.avg_engagement}}`);

  assert.equal(result.final, `٨٨${ZWSP}508`);
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['glued-value']);
});

test('two substituted values side by side on one line read as one figure, and are refused', () => {
  /* The residual the claims-linter names in its own header and cannot close: it
   * cannot tell which of two neighbouring numbers is evidence. Here both are
   * known to be values, so «٨٨ ٥٠٨» spelled as two honest placeholders is
   * refusable. */
  const result = run('{{performance.personal.post_count}} {{performance.personal.avg_engagement}}');

  assert.equal(result.final, '190 508');
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['glued-value']);
  assert.equal(result.violations[0].raw, '190 508');
});

test('the same two values on two lines are fine — a line break is a separation a reader sees', () => {
  const result = run('{{performance.personal.post_count}}\n{{performance.personal.avg_engagement}}');

  assert.equal(result.final, '190\n508');
  assert.equal(result.deliverable, true);
  assert.deepEqual([...result.violations], []);
});

test('two values separated by words are fine', () => {
  const result = run('{{performance.personal.post_count}} منشورا بمتوسط {{performance.personal.avg_engagement}}');

  assert.equal(result.final, '190 منشورا بمتوسط 508');
  assert.equal(result.deliverable, true);
});

/* ========================================================================= */
/* 4b. ROUND 4 — THE GLUE TABLE                                              */
/*                                                                           */
/* The round-3 door, one level up. Here the model types NO DIGIT AT ALL: it   */
/* writes two HONEST placeholders and welds them with one character that      */
/* renders nothing. Both halves resolve, both are figures this codebase       */
/* computed, the law passes — and the operator reads a number no row holds.   */
/*                                                                           */
/* WHY A TABLE AND NOT A CASE. Rounds 1 to 3 each closed one invisible        */
/* character and were reopened by the next, because the question asked was    */
/* "is this gap made of KNOWN-INVISIBLE characters" — an enumeration racing   */
/* an alphabet that grows every Unicode release, a race this project has now  */
/* lost four times. The engine asks the INVERTED question: "does this gap     */
/* contain a character that actually puts ink on the page". So every row      */
/* below is refused for the same reason rather than by name, and a character  */
/* invented next year is refused before anyone hears of it. The table is      */
/* evidence that the inversion holds, not the mechanism that holds it.        */
/* ========================================================================= */

/**
 * Characters that MUST NOT count as separation between two substituted values.
 * Every invisible one is an escape, per this file's rule; each row names the
 * Unicode category that puts it here, and the CONTROL at the end of the file
 * asserts those categories — which is what stops this table from quietly
 * holding an ordinary space in place of the thing it claims to hold.
 */
const GLUE: readonly (readonly [string, string])[] = [
  /* Marks. `\p{Mn}` was the round-3 door: not blank, not a joiner, not \p{Cf}. */
  ['U+034F COMBINING GRAPHEME JOINER (Mn)', CGJ],
  ['U+FE00 VARIATION SELECTOR-1 (Mn)', '\uFE00'],
  ['U+FE0F VARIATION SELECTOR-16 (Mn)', '\uFE0F'],
  ['U+180B MONGOLIAN FREE VARIATION SELECTOR ONE (Mn)', '\u180B'],
  ['U+0303 COMBINING TILDE (Mn)', '\u0303'],
  ['U+064B ARABIC FATHATAN (Mn)', '\u064B'],
  ['U+20E0 COMBINING ENCLOSING CIRCLE BACKSLASH (Me)', '\u20E0'],
  ['U+0903 DEVANAGARI SIGN VISARGA (Mc, a SPACING mark)', '\u0903'],
  /* Letters that draw nothing. `\p{L}` is not a synonym for "visible". */
  ['U+3164 HANGUL FILLER (Lo, zero width)', '\u3164'],
  ['U+115F HANGUL CHOSEONG FILLER (Lo, zero width)', '\u115F'],
  ['U+1160 HANGUL JUNGSEONG FILLER (Lo, zero width)', '\u1160'],
  ['U+0640 ARABIC TATWEEL (Lm — a joining stroke, not a word)', '\u0640'],
  /* A symbol that draws nothing: width without ink is still not separation. */
  ['U+2800 BRAILLE PATTERN BLANK (So, renders blank)', '\u2800'],
  /* The blanks the earlier rounds already held, kept as rows so the inverted
   * rule is shown to hold everything the enumerating rule held. */
  ['U+0020 SPACE (Zs)', ' '],
  ['U+00A0 NO-BREAK SPACE (Zs)', '\u00A0'],
  ['U+2007 FIGURE SPACE (Zs)', '\u2007'],
  ['U+202F NARROW NO-BREAK SPACE (Zs)', '\u202F'],
  ['U+0009 CHARACTER TABULATION (Cc)', '\u0009'],
  ['U+200B ZERO WIDTH SPACE (Cf)', ZWSP],
  ['U+200F RIGHT-TO-LEFT MARK (Cf)', RLM],
  ['U+2060 WORD JOINER (Cf)', '\u2060'],
  ['U+FEFF ZERO WIDTH NO-BREAK SPACE (Cf)', '\uFEFF'],
  ['U+00AD SOFT HYPHEN (Cf)', '\u00AD'],
  /* The two separators that live INSIDE a figure. U+066C is what an Arabic
   * reader reads as a thousands group and `,` is what an English reader reads
   * as one, so neither can be what ENDS one figure and starts the next:
   * «508٬40» is 50 840 to the reader, spelled as two honest placeholders. */
  ['U+066C ARABIC THOUSANDS SEPARATOR (Po)', ARABIC_THOUSANDS],
  ['U+002C COMMA (Po)', ','],
];

test('BREAK 1 EXECUTED: two honest placeholders glued by U+034F deliver 50840', () => {
  /* The break exactly as the operator received it. The model typed no digit;
   * both halves are measurements it was entitled to cite; the character
   * between them is not blank, not `\p{Cf}` and not a joiner — so the gap rule
   * read the two values as SEPARATED and the side-by-side rule never fired. */
  const result = run(
    'متوسط التفاعل {{performance.personal.avg_engagement}}' +
      `${CGJ}{{performance.academy.avg_engagement}} لكل منشور`,
  );

  assert.equal(result.final, `متوسط التفاعل 508${CGJ}40 لكل منشور`);
  /* What the operator's eye receives, with the invisible taken back out. */
  assert.equal(result.final.replaceAll(CGJ, '').includes('50840'), true);

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['glued-value']);
  assert.deepEqual(rawsOf(result), [`508${CGJ}40`]);
});

for (const [name, glue] of GLUE) {
  test(`GLUE ${name} is not separation`, () => {
    const result = run(
      '{{performance.personal.avg_engagement}}' +
        `${glue}{{performance.academy.avg_engagement}}`,
    );

    assert.equal(result.final, `508${glue}40`);
    assert.equal(
      result.deliverable,
      false,
      `"508${glue}40" was delivered — ${name} let two values read as one figure`,
    );
    assert.deepEqual(kindsOf(result), ['glued-value']);
  });
}

/**
 * Characters that MUST count as separation, so a legitimate sentence still
 * works. An inverted rule is only worth having if the deliverable stays
 * writable: a word, a mark of punctuation a reader can name, or a line.
 */
const SEPARATION: readonly (readonly [string, string])[] = [
  ['an Arabic word', ' مقابل '],
  ['an English word', ' and '],
  ['a single Arabic letter', ' و '],
  ['U+060C ARABIC COMMA (a list mark, never a digit group)', '، '],
  ['a newline', '\n'],
  ['U+2028 LINE SEPARATOR', '\u2028'],
  ['an em dash (Pd)', ' — '],
  ['a solidus (Po)', ' / '],
  ['a plus sign (Sm)', ' + '],
];

for (const [name, gap] of SEPARATION) {
  test(`SEPARATION ${name} really separates`, () => {
    const result = run(
      '{{performance.personal.avg_engagement}}' +
        `${gap}{{performance.academy.avg_engagement}}`,
    );

    assert.equal(result.final, `508${gap}40`);
    assert.equal(
      result.deliverable,
      true,
      `"508${gap}40" was refused — ${name} is separation a reader can see`,
    );
    assert.deepEqual([...result.violations], []);
  });
}

test('BREAK 1 the same glue also reopened the calendar-year exception', () => {
  /* WHAT THIS FOUND, AND WHY IT NOW PASSES FOR A DIFFERENT REASON — stated
   * because a test that quietly changes mechanism is a test that stops proving
   * anything. The gap predicate had a SECOND caller: `touchesInline()`, which
   * the calendar-year exception used to ask whether a year stood pressed
   * against a figure. Asked as "is the gap blank", U+034F answered "not blank,
   * so they stand apart", the year kept its exception, and «2026<U+034F>508»
   * shipped DELIVERABLE — reading 2026508 to the operator. One predicate served
   * both rules, which is why the fix went into the predicate.
   *
   * The rule-21 work then removed the calendar-year exception outright, and
   * `touchesInline()` went with it. So this case is now refused one step
   * earlier — a year is simply a quantity — and the assertion below is
   * unchanged either way. It is kept as the standing guard that this exact
   * string is never delivered again, by whichever rule gets to it first. */
  const result = run(`خطة 2026${CGJ}{{performance.personal.avg_engagement}}`);

  assert.equal(result.final, `خطة 2026${CGJ}508`);
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), ['2026']);
});

test('CONTROL a grouping separator that really groups is caught by POSITION, not by the gap rule', () => {
  /* `190,508` is a grammatical thousands group, so the tokeniser returns ONE
   * quantity running across the edge of both spans — refused by position
   * before any gap rule is consulted. It is the control for the `٬` and `,`
   * rows above: those are refused by the GAP rule, because a two-digit tail is
   * an ungrammatical group and the tokeniser hands back two quantities. Both
   * spellings are refused; this test records which rule does it, so a later
   * change to one cannot silently be credited to the other. */
  const result = run(
    '{{performance.personal.post_count}},{{performance.personal.avg_engagement}}',
  );

  assert.equal(result.final, '190,508');
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['glued-value']);
  assert.deepEqual(rawsOf(result), ['190,508']);
});

/* ========================================================================= */
/* 5. THE DELIMITERS                                                         */
/* ========================================================================= */

test('nested braces leave litter, which is reported rather than absorbed', () => {
  const result = run('{{{{performance.personal.avg_engagement}}}}');

  assert.equal(result.final, '{{508}}');
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['stray-delimiter', 'stray-delimiter']);
});

test('the bidi-mirrored spelling does not parse and is reported', () => {
  /* In an Arabic paragraph `{{key}}` may DISPLAY as `}}key{{`. Text actually
   * stored that way is not a placeholder, and is not treated as one. */
  const draft = '}}performance.personal.avg_engagement{{';
  const result = run(draft);

  assert.equal(result.final, draft);
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['stray-delimiter', 'stray-delimiter']);
});

test('there is exactly one spelling: inner spaces are a malformed placeholder', () => {
  const result = run('{{ performance.personal.avg_engagement }}');

  assert.equal(result.final, REDACTED);
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['malformed-placeholder']);
});

test('a value containing braces is inert: substitution is one pass, never a second round', () => {
  const values = valueMap({ 'audience.captions.braced': 'نص فيه {{x}} حرفيا' });
  const result = substitute('{{audience.captions.braced}}', values);

  assert.equal(result.final, 'نص فيه {{x}} حرفيا');
  assert.equal(result.deliverable, true);
  assert.deepEqual([...result.violations], []);
});

/* ========================================================================= */
/* 6. THE EXCEPTIONS — one test that it passes, one that the nearest thing    */
/*    to it does not                                                         */
/* ========================================================================= */

test('REMOVED EXCEPTION a bare calendar year is now a quantity like any other', () => {
  /* This used to pass, and that is the point. «رقم متابعين قدره 2026» — a
   * follower figure of 2026 — satisfied every clause of the old form check and
   * shipped. The label and the magnitude sit in the same positions in both
   * languages, so nothing in the text separates them; see the note where the
   * exception used to be in src/lib/brain/substitute.ts for why it could not be
   * bounded and what removing it costs. */
  const result = run('خطة 2026 تقوم على متوسط {{performance.personal.avg_engagement}}.');

  assert.equal(result.final, 'خطة 2026 تقوم على متوسط 508.');
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), ['2026']);
});

test('REMOVED EXCEPTION the year in Arabic-Indic digits is refused too', () => {
  const result = run('خطة ٢٠٢٦');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
});

test('WHAT STILL DELIVERS a date the value map holds, substituted', () => {
  /* The cost of removing the exception is bounded by this: a REAL date is a
   * measured value with a key, so it reaches the reader as substituted digits
   * exactly as before. What is gone is the model TYPING one. */
  const result = run('اللقطة بتاريخ {{performance.snapshot.taken_on}}');

  assert.equal(result.final, 'اللقطة بتاريخ 2026-08-14');
  assert.equal(result.deliverable, true);
  assert.deepEqual([...result.violations], []);
});

test('NEAREST MISS a grouped four-digit figure is not a year', () => {
  /* `2,026` is a figure spelled like a year. The exception is exactly four
   * digits with nothing hidden between them. */
  const result = run('الوصول 2,026');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), ['2,026']);
});

test('NEAREST MISS a four-digit number outside 1900-2100 is not a year', () => {
  const result = run('الوصول 9500');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
});

test('NEAREST MISS a year carrying a unit is a rate, not a date', () => {
  const result = run('نمو 2026٪');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
});

test('NEAREST MISS a year pressed inline against a substituted value stops being a label', () => {
  /* "2026 508" reads as one figure. A label that touches a figure is not a label
   * any more. */
  const result = run('2026 {{performance.personal.avg_engagement}}');

  assert.equal(result.final, '2026 508');
  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), ['2026']);
});

test('NEAREST MISS an invisible inside a year breaks the exception', () => {
  const result = run(`خطة 20${ZWSP}26`);

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
});

test('EXCEPTION single-digit list ordinals at the head of a line pass', () => {
  const arabic = run('١. ابدأ بالسؤال\n٢. اربط بالقصة\n٣. اختم بالدعوة');
  assert.equal(arabic.deliverable, true);
  assert.deepEqual([...arabic.violations], []);

  /* `.`, `)` and `-` — the third because «١- » is how the Arabic side of this
   * product actually numbers a list. */
  const latin = run('1. first\n2) second\n3- third');
  assert.equal(latin.deliverable, true);
});

test('NEAREST MISS a two-digit ordinal is a number', () => {
  /* Two digits would except `٨٨.` at the head of a line, and `٨٨` is the exact
   * head of the attack this file exists to close. */
  const result = run('10. البند العاشر');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
  assert.deepEqual(rawsOf(result), ['10']);
});

test('NEAREST MISS the same digit mid-sentence is a number', () => {
  const result = run('ابدأ 1. بالسؤال');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
});

test('NEAREST MISS a range at the head of a line is not an ordinal', () => {
  const result = run('5-10 منشورات');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity', 'bare-quantity']);
  assert.deepEqual(rawsOf(result), ['5', '10']);
});

test('NEAREST MISS a bare small number in prose is a number, and must be spelled or sourced', () => {
  /* There is no sub-100 floor here — that floor was the round-3 door. A draft
   * that wants to say "three" writes «ثلاث». */
  const result = run('قانون الـ3 خطوات');

  assert.equal(result.deliverable, false);
  assert.deepEqual(kindsOf(result), ['bare-quantity']);
});

test('REJECTED EXCEPTION a quoted span is not an exception — it is a value', () => {
  /* The brief offers "a number inside a verbatim quoted span the system itself
   * supplied" as a candidate exception. It is not one, and does not need to be:
   * a quote the system supplied arrives through the value map like every other
   * datum, and its digits are inside the substituted span already. */
  const quoted = run('قال العميل: «{{audience.captions.headcount}}»');
  assert.equal(quoted.final, 'قال العميل: «عدد المتدربين 88123 متدرب»');
  assert.equal(quoted.deliverable, true);
  assert.deepEqual([...quoted.violations], []);

  /* The same digits typed rather than quoted are a fabrication. */
  const typed = run('قال العميل: «عدد المتدربين 88123 متدرب»');
  assert.equal(typed.deliverable, false);
  assert.deepEqual(kindsOf(typed), ['bare-quantity']);
});

test('REJECTED EXCEPTION a hex colour is not an exception — the palette is a closed set', () => {
  /* Unlike the calendar, the palette is enumerable and this app already holds
   * it, so a swatch is a placeholder. `paletteRefs()` already asks storyboard
   * frames to name a swatch rather than type a hex; this is the same rule
   * applied to prose, and it makes an off-brand hex unwritable rather than
   * merely detectable. */
  const named = run('استخدم {{brand.palette.turquoise}} في العنوان');
  assert.equal(named.final, 'استخدم #48C0C0 في العنوان');
  assert.equal(named.deliverable, true);

  const typed = run('استخدم #48C0C0 في العنوان');
  assert.equal(typed.deliverable, false);
  assert.equal(kindsOf(typed).every((kind) => kind === 'bare-quantity'), true);
});

/* ========================================================================= */
/* 7. THE REPORT                                                             */
/* ========================================================================= */

test('violations of several kinds are all reported, and the draft is not deliverable', () => {
  const result = run(`٨٨${CGJ}{{performance.personal.avg_reach}} في {{ x }} و ⁸⁸`);

  assert.equal(result.deliverable, false);
  /* Placeholder faults first, in draft order; then what the finished text
   * asserts, in final order. */
  assert.deepEqual(kindsOf(result), [
    'unknown-key',
    'malformed-placeholder',
    'bare-quantity',
    'bare-quantity',
  ]);
  assert.equal(result.violations[0].frame, 'draft');
  assert.equal(result.violations[2].frame, 'final');
  assert.equal(result.final.includes('avg_reach'), false);
});

test('every violation locates itself in the text its frame names', () => {
  const result = run('المتوسط {{performance.personal.avg_reach}}');
  const violation = result.violations[0];

  assert.equal(violation.frame, 'draft');
  assert.equal(
    'المتوسط {{performance.personal.avg_reach}}'.slice(violation.start, violation.end),
    '{{performance.personal.avg_reach}}',
  );
});

test('a bare quantity locates itself in the FINAL text, where the draft has no such position', () => {
  const result = run('٨٨{{performance.snapshot.taken_on}}');
  const violation = result.violations[0];

  assert.equal(violation.frame, 'final');
  assert.equal(result.final.slice(violation.start, violation.end), violation.raw);
});

test('substitution is deterministic: the same draft and map give the same answer', () => {
  const draft = 'متوسط {{performance.personal.avg_engagement}} على {{performance.personal.post_count}} منشور';

  assert.deepEqual(run(draft), run(draft));
});

test('isSourceKey agrees with what the engine accepts', () => {
  assert.equal(isSourceKey('performance.personal.avg_engagement'), true);
  assert.equal(isSourceKey('performance.clusters.88123.n'), true);
  assert.equal(isSourceKey('audience.questions.1'), true);
  /* Arabic segments are real: `keySegment()` keeps \p{L}, so a cluster labelled
   * in Arabic mints an Arabic segment. */
  assert.equal(isSourceKey('performance.clusters.نصائح'), true);

  assert.equal(isSourceKey('88508'), false);
  assert.equal(isSourceKey('٨٨٥٠٨'), false);
  assert.equal(isSourceKey('1performance'), false);
  assert.equal(isSourceKey('Performance.personal'), false);
  assert.equal(isSourceKey('performance..personal'), false);
  assert.equal(isSourceKey('performance.personal.'), false);
  assert.equal(isSourceKey('performance personal'), false);
  assert.equal(isSourceKey(''), false);
  assert.equal(isSourceKey(`performance.${ZWSP}personal`), false);
});

/* ========================================================================= */
/* 8. THE CONTROL FOR THIS FILE'S OWN INVISIBLES                             */
/* ========================================================================= */

test('CONTROL the invisible characters these tests are built from are really there', () => {
  /* Twice in this project a scan came back clean because the pattern or the
   * control carried a byte nobody could see. So: assert that each escape above
   * is the character it claims to be, and that a plain digit scan really does
   * fail to see the ones the exploits rely on. A test suite that quietly used
   * ordinary spaces would pass every attack test while proving nothing. */
  assert.equal(/\p{Mn}/u.test(CGJ), true);
  assert.equal(/\p{Cf}/u.test(CGJ), false, 'U+034F is a mark, not a format character');
  assert.equal(/\p{Cf}/u.test(ZWSP), true);
  assert.equal(/\p{Cf}/u.test(RLM), true);
  assert.equal(/\s/u.test(CGJ), false, 'U+034F is not blank, which is why the claim split');
  assert.equal(ARABIC_THOUSANDS.codePointAt(0), 0x066c);

  /* The planted positives, with no NUL anywhere in the control. */
  const control = `٨٨${CGJ}٥٠٨ ${ZWSP} ${RLM} ⁸⁸`;
  assert.equal(control.includes('\u0000'), false, 'a NUL in a control silently zeroes every scan');
  assert.deepEqual(control.match(/\p{Nd}+/gu), ['٨٨', '٥٠٨']);
  assert.deepEqual(control.match(/[\p{No}\p{Nl}]+/gu), ['⁸⁸']);
});

test('CONTROL every GLUE row is one code point, and it is the one its name claims', () => {
  /* The table is only evidence if its rows really hold what they say. A row
   * that had quietly become an ordinary space would pass its own test for the
   * wrong reason and prove nothing about the character it names. */
  const NAMED = /^U\+([0-9A-F]{4}) /u;
  const LINE_BREAK = /[\n\r\u2028\u2029\u0085\u000B\u000C]/u;

  for (const [name, glue] of GLUE) {
    assert.equal([...glue].length, 1, `${name} is not a single code point`);
    assert.equal(glue.includes('\u0000'), false, `${name} carries a NUL`);

    const named = NAMED.exec(name);
    assert.notEqual(named, null, `${name} does not begin with its code point`);
    assert.equal(
      glue.codePointAt(0),
      Number.parseInt(named === null ? '' : named[1], 16),
      `${name} is not the code point its name claims`,
    );

    /* No row is a line break: a line break is the one blank that DOES
     * separate, so a stray one here would make its row pass for a reason the
     * row was not written to test. */
    assert.equal(LINE_BREAK.test(glue), false, `${name} is a line break`);
  }
});

test('CONTROL the OLD rule really was blind to these, which is why it opened', () => {
  /* THE POINT OF THE INVERSION, as a measurement rather than a claim. The rule
   * that shipped asked whether the gap matched [\s\p{Cf}\p{Cc}] — "is every
   * character in here one I ALREADY KNOW to be invisible". Fifteen rows of the
   * table fall outside that class: thirteen a reader cannot see at all, and the
   * two grouping separators a reader sees as PART OF the number. The old rule
   * called every one of them separation and let two substituted values stand as
   * one figure. Fifteen is not a bug count; it is the size of the enumeration
   * gap on the day it was measured, and the next Unicode release makes it
   * bigger. The inverted rule has no such number to grow. */
  const OLD_BLANK_RUN = /^[\s\p{Cf}\p{Cc}]*$/u;

  const missed = GLUE.filter(([, glue]) => !OLD_BLANK_RUN.test(glue));
  assert.equal(
    missed.length,
    15,
    `the old class missed: ${missed.map(([name]) => name).join('; ')}`,
  );
  assert.equal(OLD_BLANK_RUN.test(CGJ), false, 'U+034F is the round-3 door, by name');

  /* And it held the ten blanks — which is why the blanks are rows too: the
   * inverted rule must keep everything the enumerating rule already held. */
  assert.equal(GLUE.filter(([, glue]) => OLD_BLANK_RUN.test(glue)).length, 10);

  /* Every SEPARATION row is the opposite: something in it draws. Asserted
   * through the same categories the engine admits, so this control fails if a
   * row is ever softened into an invisible. */
  const INK = /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{N}\p{P}\p{Sm}\p{Sc}\n\r\u2028\u2029]/u;
  for (const [name, gap] of SEPARATION) {
    assert.equal(INK.test(gap), true, `${name} draws nothing`);
  }
});
