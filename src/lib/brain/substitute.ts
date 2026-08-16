import { quantities, type Quantity } from './law/claims-linter.ts';
import { normaliseDigits } from './law/types.ts';

/**
 * ===========================================================================
 * THE SUBSTITUTION ENGINE — the model does not type numbers
 * ===========================================================================
 *
 * Three rounds of hardening the number-linter each closed an exploit and each
 * was reopened by a new one. Round 3's counter-example was the original attack
 * verbatim through a different door: «٨٨<U+034F>٥٠٨» renders to the operator as ٨٨٥٠٨,
 * but U+034F is `\p{Mn}` — not a joiner, not blank — so the claim splits, the
 * head falls under the linter's 100 floor and vanishes, and only the sourced
 * tail is ever checked. There are more zero-width characters than anyone will
 * enumerate correctly, and the next one is already in the next Unicode version.
 *
 * TEXT-MATCHING NUMBERS IS THE WRONG PRIMITIVE FOR A HARD GUARANTEE. It is a
 * detector, and a detector is a race between an enumeration and an alphabet.
 *
 * So this file changes what the model is allowed to WRITE. It emits a
 * placeholder naming a source key; code substitutes the value. A number the
 * model cannot write is a number it cannot fabricate, whatever it spells it in.
 * The claims-linter stays, downstream, as defence in depth — but it is no
 * longer the thing that makes the guarantee true. This is.
 *
 * ---------------------------------------------------------------------------
 * WHY `{{key}}`
 * ---------------------------------------------------------------------------
 *   - UNAMBIGUOUS AGAINST THE PROSE. Neither Arabic nor English writes a doubled
 *     brace. `{` and `}` carry no meaning in CommonMark or remark-gfm either, so
 *     a placeholder that survives to the renderer renders as itself instead of
 *     silently becoming a link, an emphasis run or a footnote — which is what
 *     `[[…]]` risks, sitting one character away from Markdown's link syntax.
 *   - ONE SPELLING, EXACTLY. `{{key}}` and nothing else: no inner spaces, no
 *     `{{ key }}`, no nesting. Every near-miss is reported rather than guessed
 *     at, because a syntax with variants is a syntax with a lookalike.
 *   - READABLE IN A STORED DRAFT. A reviewer reading `{{performance.personal.
 *     avg_engagement}}` can see exactly what was claimed and against what. (In
 *     an Arabic paragraph the braces mirror under the bidi algorithm and may
 *     DISPLAY as `}}key{{`; that is a rendering of the same bytes. Text that is
 *     actually stored as `}}key{{` does not parse, and is reported.)
 *
 * ---------------------------------------------------------------------------
 * WHY A KEY CONTAINING DIGITS IS NOT A WAY TO WRITE A NUMBER
 * ---------------------------------------------------------------------------
 * Keys really do carry digits: `keySegment()` in src/lib/agent/strategist/
 * blocks.ts preserves `\p{N}`, so a cluster a model named "88123" mints
 * `performance.clusters.88123.n`. The digits in that key never reach a reader,
 * and not because they are filtered — because there is no path that copies them:
 *
 *   - the key RESOLVES → what is emitted is `values.get(key)`, a string this
 *     codebase computed. The key was only ever a name for it.
 *   - the key DOES NOT RESOLVE → nothing is emitted. Not the key, not the
 *     placeholder, not a guess. A redaction marker with no digits in it goes in
 *     instead and the draft is not deliverable.
 *
 * The output is drawn from the value map and from nowhere else, so an unknown
 * key is structurally incapable of echoing. That is the whole answer, and it is
 * why the key grammar can afford to be permissive about digits — it only has to
 * guarantee that a key is not ITSELF a quantity, which it does by requiring the
 * first character to be an ASCII lowercase letter.
 *
 * ---------------------------------------------------------------------------
 * AND THEN: WHAT THE MODEL TYPED ANYWAY
 * ---------------------------------------------------------------------------
 * Substitution alone would still let a draft state `٨٨٥٠٨` in plain prose. So
 * the result is scanned, and every numeral in it must be accounted for:
 *
 *   1. `quantities()` from src/lib/brain/law/claims-linter.ts finds every
 *      decimal quantity. IT IS IMPORTED, NEVER RE-IMPLEMENTED — two tokenisers
 *      that nearly agree is the root cause of the last three failures, and that
 *      file's header is a list of the doors their disagreements opened.
 *   2. A quantity is legitimate ONLY if it lies WHOLLY INSIDE ONE SUBSTITUTED
 *      SPAN. Not "appears in the value map", not "matches something" — occupies
 *      character positions this engine itself wrote. `٨٨` typed next to a
 *      substituted `٥٠٨` is not inside the span, so the round-3 attack is not a
 *      matching failure here, it is a position failure, and positions do not
 *      have a Unicode alphabet to lose a race against.
 *   3. `quantities()` models `\p{Nd}` and only `\p{Nd}`, by design — a
 *      superscript is not a decimal digit and cannot be canonicalised into a
 *      positional number. So `⁸⁸¹²³` is INVISIBLE to it. Every `\p{No}` and
 *      `\p{Nl}` character outside a substituted span is therefore refused by a
 *      separate rule, stated separately because it is a separate claim: those
 *      classes carry no legitimate meaning in a deliverable at all.
 *
 * ---------------------------------------------------------------------------
 * THE RESIDUAL, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * This engine governs NUMERALS. A magnitude spelled in words — "eighty-eight
 * thousand", «ثمانية وثمانون ألف» — is not a numeral and is not caught here,
 * and no tokeniser will catch it. That is the Judge's problem and the operator's
 * problem, and it is deliberately left visible rather than papered over: the
 * guarantee this file makes is exact, and an exact guarantee is worth more than
 * a vague one. What it does buy is that the spelled-out fabrication has to be
 * written in words, where it reads as an assertion rather than as a measurement.
 *
 * PURITY. No model, no I/O, no network, no clock, no environment. Same draft and
 * same value map, same answer, forever.
 */

/* ==================================================== the placeholder ===== */

/** The opening delimiter. Exported so a prompt can quote it from one place. */
export const OPEN = '{{';
/** The closing delimiter. */
export const CLOSE = '}}';

/**
 * What replaces a placeholder that did not resolve.
 *
 * NOT an em-dash. Rule 2's em-dash means "this was measured and the measurement
 * is absent", which is an honest, deliverable statement; a placeholder that
 * failed means "this draft is broken", which is not. Making the two look alike
 * would let a faulty draft pass for a clean one the moment somebody stopped
 * reading `deliverable`. It contains no digit in any script, so it can neither
 * become a quantity nor join two.
 */
export const REDACTED = '[?]';

/**
 * `{{…}}` with no brace inside it. The inner class excludes both braces so a
 * placeholder can never swallow another one, and so `{{{{k}}}}` leaves its outer
 * braces behind as visible litter to be reported rather than absorbing them.
 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/gu;

/** A doubled brace that did NOT form a placeholder. Litter, and reported. */
const STRAY_DELIMITER = /\{\{|\}\}/gu;

/**
 * A SOURCE KEY.
 *
 * Dot-separated segments of `[\p{L}\p{N}_]`, which is exactly the alphabet
 * `keySegment()` mints — it strips everything outside `\p{L}\p{N}_`, so marks,
 * spaces and punctuation cannot appear in a real key and are refused here. That
 * the two agree is deliberate: a grammar narrower than the minter would make
 * real keys unreachable (a cluster labelled in Arabic mints an Arabic segment),
 * and a grammar wider than the minter would accept keys nothing can produce.
 *
 * THE FIRST CHARACTER IS AN ASCII LOWERCASE LETTER. Every namespace root in this
 * app is one — `performance`, `audience`, `profiles` — and the requirement is
 * what makes "a key is not a quantity" a structural fact rather than an
 * observation: `{{٨٨٥٠٨}}` and `{{88508}}` are not keys, they are malformed
 * placeholders, and they are reported without their contents reaching the text.
 */
const KEY = /^[a-z][\p{L}\p{N}_]*(?:\.[\p{L}\p{N}_]+)*$/u;

/** A key longer than this is not a key, it is a payload. */
const KEY_MAX_LENGTH = 200;

/** How much of an offending string a violation quotes back at the operator. */
const SNIPPET_MAX_LENGTH = 80;

/* ========================================================= the numerals == */

/**
 * The numeral classes `quantities()` does not model.
 *
 * `\p{No}` is superscripts, subscripts, vulgar fractions and circled digits;
 * `\p{Nl}` is Roman numerals and their kin. None of them is a decimal digit, so
 * none can be tokenised into a positional quantity — which is why the claims
 * linter is right not to try, and why `⁸⁸¹²³` sails straight past it. There is
 * no sentence in a bilingual analysis deliverable that needs one, so rather than
 * decide what each of them means, none of them may appear outside a value.
 */
const NON_DECIMAL_NUMERAL = /[\p{No}\p{Nl}]+/gu;

/**
 * ===========================================================================
 * WHAT SEPARATES TWO FIGURES IS STATED POSITIVELY. THE INVERSION IS THE POINT.
 * ===========================================================================
 * The rule that shipped here asked the NEGATIVE question — "is this gap made
 * only of characters I ALREADY KNOW to be invisible?" — spelled as the class
 * `[\s\p{Cf}\p{Cc}]`. That is an enumeration of the invisible, and the
 * invisible is not a finite set: it is whatever the next Unicode release adds.
 * This project has now lost that race four times, and the fourth loss needed NO
 * TYPED DIGIT AT ALL. Two honest placeholders — `{{personal}}` and
 * `{{academy}}`, both resolving, both citing figures this codebase computed —
 * were welded with U+034F and delivered as `508<U+034F>40`. The operator read
 * 50840. U+034F is `\p{Mn}`: not blank, not `\p{Cf}`, so the gap tested as "not
 * blank", the two values were called SEPARATED, and the side-by-side rule below
 * never fired. U+FE00, U+180B and U+0303 do the same, and so will the character
 * added next year.
 *
 * SO THE TEST IS INVERTED. Two substituted values are ADJACENT — one figure —
 * UNLESS something between them actually puts ink on the page. Not "unless a
 * known invisible is absent": UNLESS A VISIBLE IS PRESENT. The consequence is
 * the entire reason for the change: THE DEFAULT ANSWER FOR A CHARACTER NOBODY
 * HAS CLASSIFIED IS "NOT A SEPARATOR", so a zero-width character invented after
 * this file was written is refused on the day it is invented, with no edit
 * here. The unknown now falls on the CLOSED side of the door. The cost is paid
 * in the other direction, knowingly: a gap this class does not recognise
 * refuses a draft that may have been honest, and an operator rewrites a
 * sentence. A false refusal is an annoyance. A false delivery is a fabricated
 * measurement, and this file exists because those are not the same size.
 *
 * A NARROW POSITIVE SET IS THE SAFE ONE, so these are only the categories every
 * member of which carries a glyph:
 *
 *   `\p{Lu}\p{Ll}\p{Lt}`  cased letters — always drawn.
 *   `\p{Lo}`              the letters of uncased scripts. EVERY Arabic letter
 *                         is `\p{Lo}`, so this is what keeps «508 مقابل 40»
 *                         writable on the Arabic side of the product.
 *   `\p{N}`               numerals of every class.
 *   `\p{P}`               punctuation — «،», the dash, the full stop, the
 *                         bracket, the percent sign.
 *   `\p{Sm}\p{Sc}`        mathematical operators and currency signs: `×`, `+`,
 *                         `→`, `$`. Each is a glyph with a name.
 *
 * AND WHAT IS LEFT OUT MATTERS MORE THAN WHAT IS IN:
 *
 *   `\p{Lm}`   modifier letters. U+0640 TATWEEL is one, and it draws a joining
 *              stroke INSIDE a word, never a boundary between two figures.
 *   `\p{M}`    every mark, combining OR spacing. A mark attaches to what
 *              precedes it — which is exactly what U+034F, U+0303 and U+0903 do
 *              — and an attachment is the opposite of a gap.
 *   `\p{Z}`    the spaces. Deliberate and load-bearing: two figures with
 *              nothing but blank between them are one figure wearing a gap,
 *              which is «٨٨ ٥٠٨», the round-2 attack.
 *   `\p{C}`    format, control, surrogate, private-use — and UNASSIGNED. That
 *              last one is where the future goes: a code point this runtime has
 *              never heard of is `\p{Cn}`, so it bears no ink, so it does not
 *              separate, so it cannot glue two figures together.
 *   `\p{Sk}`   modifier symbols, and
 *   `\p{So}`   other symbols — the block holding U+2800 BRAILLE PATTERN BLANK,
 *              which renders as an empty cell. Width with no ink is precisely
 *              the trick this rule exists to refuse.
 */
const BEARS_INK = /[\p{Lu}\p{Ll}\p{Lt}\p{Lo}\p{N}\p{P}\p{Sm}\p{Sc}]/gu;

/**
 * The glyph-less members of the classes above, as UNICODE ITSELF marks them.
 *
 * `\p{Lo}` holds the four HANGUL FILLERS — U+115F, U+1160, U+3164, U+FFA0 —
 * letters that draw nothing, so the category test alone would call them
 * separation.
 *
 * THIS IS NOT THE OLD RACE RUN AGAIN, and the difference is the reason it is
 * admissible: this property and `\p{Lo}` are read from the SAME Unicode table
 * in the SAME runtime. A letter this engine can see is a letter whose ignorable
 * status it can also see, so the two cannot fall out of step. The list that lost
 * the race was hand-written in this file and every new Unicode version outran
 * it; this one ships with the character it describes.
 */
const DRAWS_NOTHING = /\p{Default_Ignorable_Code_Point}/u;

/**
 * The separators that live INSIDE one figure.
 *
 * The first four are exactly what claims-linter.ts names GROUP_SEPARATOR and
 * DECIMAL_SEPARATOR, re-spelled rather than imported because this module needs
 * them only as an EXCLUSION, and that makes the drift direction safe: a list
 * WIDER than the tokeniser's refuses more, never less.
 *
 * A CHARACTER A READER READS AS PART OF A NUMBER CANNOT BE WHAT ENDS ONE NUMBER
 * AND BEGINS THE NEXT. `{{personal}}٬{{academy}}` renders `508٬40`, which an
 * Arabic reader reads as 50 840; `{{personal}},{{academy}}` renders `508,40`.
 * Both are the original attack assembled from two honest placeholders, and
 * neither character separates them.
 *
 * FIX 2 EXTENDS THIS PAST THE TOKENISER'S FOUR, because the same reading holds
 * for three more spellings the tokeniser does not model as a group separator at
 * all — so `quantities()` hands back TWO quantities either side of them, exactly
 * as it does for an ungrammatical `٬` or `,` tail, and this is the rule that
 * has to refuse the pair. This is a claim about what a READER reads, not about
 * ink — U+0027, U+2019 and U+00B7 are all visible glyphs, and `separatesFigures`
 * would otherwise call every one of them separation:
 *
 *   U+0027 APOSTROPHE           the Swiss digit-group mark: 1'234'567.
 *   U+2019 RIGHT SINGLE QUOTE   the same mark's "smart quote" spelling, which is
 *                               what a word processor or a chat client actually
 *                               emits for a typed apostrophe.
 *   U+00B7 MIDDLE DOT           the ISO 31-0 / older British group mark used in
 *                               scientific and typeset figures: 1·234·567.
 *
 * `{{personal}}'{{academy}}` renders `508'40`, `{{personal}}’{{academy}}` renders
 * `508’40`, `{{personal}}·{{academy}}` renders `508·40` — three more spellings of
 * the same attack, closed the same way as the original two.
 *
 * U+060C ARABIC COMMA is deliberately absent — it is a list mark and never
 * groups digits, so «508، 40» reads as two figures and is delivered. So is
 * the plain single quote used as a QUOTATION mark rather than a digit group
 * (there is no separate code point for that use — U+0027 does both jobs in
 * plain ASCII text, and this rule accepts the cost of treating every instance
 * as the narrower, safer reading: refusing an occasional honest quotation mark
 * between two figures costs an operator a rewritten sentence, exactly the
 * trade this file's header describes for the inverted gap rule above).
 */
const FIGURE_INTERNAL = /[,٬.٫'’·]/u;

/**
 * Every character the ORDINAL exception (`atLineStart`, below) treats as ending
 * a line. Kept exactly as it was — this constant is NOT the fix for the
 * contradiction that used to live in `separatesFigures()`; `atLineStart`'s own
 * comment already audits it and explains why it is left alone. It answers one
 * question only — "does the text one step back end at a line start" — which is
 * unrelated to whether a gap between two figures visibly separates them.
 */
const LINE_BREAK = /[\n\r\u2028\u2029\u0085\u000B\u000C]/u;

/**
 * The one character that actually breaks a line under the chat surface's own
 * CSS (`white-space: pre-wrap`, a plain text node — src/app/(app)/chat/page.tsx
 * ~1608). `separatesFigures()` used to grant separation for the whole
 * `LINE_BREAK` class above, which was two rules pretending to be one: the
 * file's header says a control character "bears no ink, so it does not
 * separate", and a code point that does not even break the line is a smaller
 * claim to grant than that.
 *
 * MEASURED IN REAL CHROME, under that exact CSS, against the baseline
 * "50840" = 40.44px (the width the two substituted values would render as if
 * glued into one figure):
 *
 *   U+000C FORM FEED        40.44px  no line break  identical width to "50840"
 *   U+000D CARRIAGE RETURN  40.44px  no line break  identical width to "50840"
 *   U+2028 / U+2029         44.55px  no line break  same width as a SPACE
 *   U+0085 / U+000B         50.13px  no line break
 *   U+000A LINE FEED        24.27px  LINE BREAK     (the one that actually wraps)
 *
 * Every row except U+000A renders as if it had put no line break there at
 * all — the width a reader sees is the width of an invisible or blank gap —
 * so granting separation on their account was shipping a glued figure under
 * cover of a rule that sounded like it was about something visible. Only
 * U+000A breaks a line under `pre-wrap`; a CRLF pair breaks it too because it
 * CONTAINS a U+000A, and a bare U+000D does not — which matching only U+000A
 * gets right without a special case.
 */
const HARD_LINE_BREAK = /\n/u;

/** One digit, 1 to 9, after normalisation. Never a two-digit head like `٨٨`. */
const SINGLE_ORDINAL_DIGIT = /^[1-9]$/;

/**
 * What may follow a list ordinal: `1.` and `1)` are Markdown, `١-` is how the
 * Arabic side of this product actually numbers a list. Whatever follows must
 * then end the line or be blank, so `5-10` is not an ordinal.
 *
 * AUDITED ALONGSIDE THE GAP RULE. This blank class enumerates too, but it sits
 * on the PERMISSIVE side of its rule — matching GRANTS the exception — so a
 * character it does not know refuses the draft instead of shipping it. Same
 * direction as everything else here: the unknown is a violation, never a pass.
 */
const ORDINAL_TAIL = /^[.)\-](?:$|[\s\p{Cf}])/u;

/* ============================================================== the API == */

/** One placeholder that resolved, with where its value landed in `final`. */
export interface Substitution {
  key: string;
  /** The value as the value map held it, character for character. */
  value: string;
  /** Offsets into `final`. */
  start: number;
  end: number;
}

export type ViolationKind =
  /** A placeholder named a key the value map does not hold. */
  | 'unknown-key'
  /** `{{…}}` whose contents are not a source key. */
  | 'malformed-placeholder'
  /** A doubled brace outside any placeholder. */
  | 'stray-delimiter'
  /** Digits the model typed that touch no substituted value. */
  | 'bare-quantity'
  /** Digits, a unit or a second value welded onto a substituted value. */
  | 'glued-value';

export interface SubstitutionViolation {
  kind: ViolationKind;
  /**
   * WHICH TEXT `start` and `end` index. Placeholder faults are located in the
   * draft, because that is the text the operator has to edit; quantity faults
   * are located in `final`, because the draft has no such position — the
   * quantity may not have existed before substitution.
   */
  frame: 'draft' | 'final';
  start: number;
  end: number;
  /** Operator-facing. Diagnostics — never deliverable text. */
  evidence: string;
  /**
   * The key that failed to resolve, for `unknown-key`.
   *
   * The report carries it and `final` never does. The operator cannot fix a
   * draft against "some key was wrong", and a violation record is a lint result
   * shown as a fault — the same shape `claimsLinter()` already uses when it
   * quotes the unsourced figures back. What matters is that this string is not
   * on the path to the reader; `final` is, and the key is not in it.
   */
  key?: string;
  /** The offending text, verbatim and truncated. Never a substituted value. */
  raw?: string;
}

export interface SubstituteResult {
  /**
   * The draft with every resolved placeholder replaced by its value and every
   * unresolved one redacted. Safe to store and to show whatever the verdict —
   * it never contains a key, a placeholder or a guess — but it is only fit to
   * SEND when `deliverable` is true.
   */
  final: string;
  substitutions: readonly Substitution[];
  /** Empty means the draft states no quantity this codebase did not compute. */
  violations: readonly SubstitutionViolation[];
  /** `violations.length === 0`. Named so a caller reads the intent, not the count. */
  deliverable: boolean;
}

/**
 * Whether a string is a well-formed source key. Exported so the prompt builder
 * and the block assembler can check a key against the same grammar the engine
 * enforces, instead of a second one that nearly agrees.
 */
export function isSourceKey(text: string): boolean {
  return text.length > 0 && text.length <= KEY_MAX_LENGTH && KEY.test(text);
}

/**
 * A value map from a plain record.
 *
 * THE ENGINE TAKES A `Map`, NOT AN OBJECT, and this is the reason: `{{tostring}}`
 * against an object literal would find `Object.prototype.toString` and substitute
 * a function's source into the deliverable, and `{{constructor}}` likewise. A
 * `Map` has no inherited keys, so an unknown key is unknown — which is the one
 * property the whole design rests on. `Object.entries` copies own enumerable
 * properties only, so this builder cannot reintroduce the problem.
 */
export function valueMap(entries: Readonly<Record<string, string>>): Map<string, string> {
  return new Map(Object.entries(entries));
}

/* ========================================================= the internals = */

interface Span {
  start: number;
  end: number;
}

function snippet(text: string): string {
  return text.length <= SNIPPET_MAX_LENGTH ? text : `${text.slice(0, SNIPPET_MAX_LENGTH)}…`;
}

/** The substituted span that wholly contains `[start, end)`, or null. */
function spanAround(spans: readonly Span[], start: number, end: number): Span | null {
  for (const span of spans) {
    if (span.start <= start && end <= span.end) return span;
  }
  return null;
}

/**
 * Whether any substituted span overlaps `[start, end)` at all.
 *
 * A zero-length span — an empty value — counts when it sits strictly inside the
 * range, which is what stops `5{{empty}}08` from quietly reading as 508.
 */
function overlapsSpan(spans: readonly Span[], start: number, end: number): boolean {
  for (const span of spans) {
    if (span.start < end && start < span.end) return true;
  }
  return false;
}

/**
 * Whether anything in `[from, to)` really separates two figures.
 *
 * TRUE REQUIRES A POSITIVE FINDING: either a line break, or one character that
 * bears ink and is neither ignorable nor part of a number. Everything else —
 * every blank, every mark, every format character, every code point this
 * runtime has never heard of — leaves the two figures ADJACENT. That is the
 * inversion, and it is stated as a loop over what was found rather than as a
 * test on what was absent so that the failing direction stays visible: this
 * function returns false when it finds nothing, and finding nothing is the
 * normal outcome for a character it does not know.
 *
 * A LINE BREAK IS SEPARATION, and it is the one blank that is. The claims-linter
 * counts a newline as blank because it cannot tell a value from a claim and must
 * assume the worst; this engine knows which characters it wrote, so it can
 * afford the true rule — two figures on two lines are two figures.
 *
 * The predicate this replaced was `inlineGap()`, which asked whether the gap was
 * BLANK and answered the same question backwards. It is gone rather than
 * renamed: leaving it would leave the old question askable.
 *
 * EXPORTED so src/lib/agent/chat/run.ts can ask the SAME question about two
 * TYPED quantities the way this file already asks it about two substituted
 * ones. FIX 3's counterpart lives there rather than here because it is a
 * decision about which typed violations the gate excuses, not about what
 * separates two figures — that question has exactly one answer, and this is
 * it.
 */
export function separatesFigures(text: string, from: number, to: number): boolean {
  const gap = text.slice(from, to);
  if (HARD_LINE_BREAK.test(gap)) return true;

  BEARS_INK.lastIndex = 0;
  for (const found of gap.matchAll(BEARS_INK)) {
    const character = found[0];
    if (DRAWS_NOTHING.test(character)) continue;
    if (FIGURE_INTERNAL.test(character)) continue;
    return true;
  }
  return false;
}

/**
 * Nothing but spaces and tabs back to the start of the line.
 *
 * AUDITED ALONGSIDE THE GAP RULE ABOVE AND DELIBERATELY LEFT ALONE. It asks the
 * same shape of question — "is there anything between here and the line start?"
 * — but it already answers POSITIVELY: it returns true only where it FINDS a
 * line break (or the start of the text), and any character it does not
 * recognise, invisible or not, makes it return false. Returning false DENIES
 * the ordinal exception, so the unknown already falls on the closed side of
 * this door. Inverting it would change no answer; widening what it skips would
 * open one, which is why it skips exactly two characters.
 */
function atLineStart(text: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i -= 1) {
    const character = text[i];
    if (character === ' ' || character === '\t') continue;
    return LINE_BREAK.test(character);
  }
  return true;
}

/**
 * ===========================================================================
 * THE CALENDAR-YEAR EXCEPTION IS GONE. A YEAR IS A QUANTITY.
 * ===========================================================================
 * It used to be exception 1: exactly four bare digits inside 1900–2100,
 * unmarked, bounded, not inline beside another quantity. It is REMOVED, and
 * this note is what stands in its place because a deleted exception that leaves
 * no argument behind gets re-added by the next reader.
 *
 * WHAT IT DELIVERED. «رقم متابعين قدره 2026» — a follower figure of 2026 —
 * passed every clause of the form check and shipped untouched, as did 1987.
 * 201 values were typeable, and a follower count is exactly the kind of figure
 * that lands inside that range. The controls held (4200 chipped, `2,026`
 * chipped) which is what made the door invisible: the exception was working
 * precisely as written, and what was written was wrong.
 *
 * WHY IT COULD NOT BE BOUNDED INSTEAD. The brief for the surviving exception is
 * that digits may be a LABEL, never a MAGNITUDE, and a bound has to separate
 * the two from the text alone. It cannot be done here:
 *
 *   * NOT BY POSITION. Both languages put the counted noun AFTER the numeral
 *     ("2026 followers", «٢٠٢٦ متابع») AND admit the prepositional order with
 *     the noun before it ("a follower figure of 2026", «رقم متابعين قدره
 *     2026»). A calendar label takes both shapes too — «خطة 2026», "August
 *     2026". The label and the magnitude occupy the same positions, so no
 *     positional rule tells them apart. That is the difference between this
 *     exception and the one below, which survives BECAUSE it is positional: a
 *     single digit at the head of a line, followed by a list marker, is
 *     somewhere no measurement is ever written.
 *   * NOT BY VOCABULARY. Requiring a calendar word beside the year («عام»,
 *     "August") is an enumeration, and it would still admit «عام 2026 متابع»
 *     while refusing «خطة 2026» — the one phrase the exception existed for. A
 *     rule that rejects its own motivating case and still passes the attack is
 *     not a bound.
 *
 * That leaves the value test itself — "is it between 1900 and 2100" — and a
 * test on the VALUE of a number is the primitive this whole file was written to
 * abandon (see the header). The year exception was the last place it survived.
 *
 * WHAT IT COSTS, PLAINLY. The model can no longer type a year at all.
 *
 *   * DATES ARE UNAFFECTED, and they are the common case: a real date reaches
 *     the reader as a substituted value already — `{{performance.snapshot.
 *     taken_on}}` emits `2026-08-14`, digits and all, from the value map.
 *   * A YEAR USED AS A LABEL — «خطة 2026», "the 2026 plan" — must now be
 *     written in words («الخطة القادمة», "next year's plan") or dropped. That
 *     is a real loss of natural phrasing and it is the whole bill.
 *   * A CALENDAR NAMESPACE WAS CONSIDERED AND REJECTED. `{{calendar.2026}}`
 *     resolving to "2026" would restore the phrasing, but it hands back exactly
 *     the same 201 values through a different door — «لديها {{calendar.2026}}
 *     متابع» delivers the identical sentence. It would move the fabrication
 *     into the draft where a reviewer might see it, and change nothing about
 *     what ships. An exception wearing a placeholder is still an exception.
 */

/**
 * THE ONE EXCEPTION — A SINGLE-DIGIT LIST ORDINAL AT THE HEAD OF A LINE.
 *
 * The principle: DIGITS MAY BE A LABEL, NEVER A MAGNITUDE. `١.` names a
 * position in a list, and a reader parses it as structure before they parse it
 * as a number. Unlike a measurement, list positions are an open sequence the
 * system cannot enumerate, so there is no placeholder to offer instead.
 *
 * WHAT MAKES IT ADMISSIBLE WHERE THE CALENDAR YEAR WAS NOT: this is a test on
 * POSITION, not on value. Any digit 1–9 qualifies — the check never asks what
 * the number IS. It asks where it sits, and it sits somewhere a measurement is
 * never written.
 *

 * ONE DIGIT, 1 TO 9. Two digits would except `٨٨.` at the head of a line, and
 * `٨٨` is the exact head of the attack this file exists to close. A list past
 * nine items is bulleted, or numbered by whatever renders it — a cost paid
 * knowingly, and a cheap one.
 *
 * AT THE HEAD OF A LINE, after nothing but indentation, followed by `.`, `)` or
 * `-` and then blank or end of text. Mid-sentence there is no list to be part
 * of, so mid-sentence it is a number.
 */
function isListOrdinal(text: string, quantity: Quantity): boolean {
  if (quantity.marked || !quantity.bounded) return false;
  if (!SINGLE_ORDINAL_DIGIT.test(normaliseDigits(quantity.raw))) return false;
  if (!atLineStart(text, quantity.start)) return false;
  return ORDINAL_TAIL.test(text.slice(quantity.end, quantity.end + 2));
}

/* ============================================================== the engine */

/**
 * Substitute a drafted text against the values this codebase computed.
 *
 * `draft` is what the model wrote. `values` is the keyed truth. Nothing else is
 * consulted, and nothing from `draft` is ever copied into a numeric position of
 * `final` — every digit in the result either came out of `values` or is reported
 * as a violation.
 */
export function substitute(draft: string, values: ReadonlyMap<string, string>): SubstituteResult {
  const substitutions: Substitution[] = [];
  const placeholderFaults: SubstitutionViolation[] = [];
  const pieces: string[] = [];
  let length = 0;

  /** Append to `final`, returning where the appended text starts. */
  const emit = (text: string): number => {
    const at = length;
    pieces.push(text);
    length += text.length;
    return at;
  };

  /** Litter check on the text BETWEEN placeholders — never on a value. */
  const scanLiteral = (literal: string, offset: number): void => {
    STRAY_DELIMITER.lastIndex = 0;
    for (const stray of literal.matchAll(STRAY_DELIMITER)) {
      placeholderFaults.push({
        kind: 'stray-delimiter',
        frame: 'draft',
        start: offset + stray.index,
        end: offset + stray.index + stray[0].length,
        raw: stray[0],
        evidence:
          `A stray "${stray[0]}" that forms no placeholder. A placeholder is exactly ` +
          `${OPEN}key${CLOSE} — one spelling, so a near-miss is reported instead of guessed at.`,
      });
    }
  };

  /* -- one pass over the draft: literal, placeholder, literal, ... --------- */

  let cursor = 0;
  PLACEHOLDER.lastIndex = 0;
  for (const match of draft.matchAll(PLACEHOLDER)) {
    const start = match.index;
    const end = start + match[0].length;

    const literal = draft.slice(cursor, start);
    scanLiteral(literal, cursor);
    emit(literal);
    cursor = end;

    const key = match[1];

    if (!isSourceKey(key)) {
      placeholderFaults.push({
        kind: 'malformed-placeholder',
        frame: 'draft',
        start,
        end,
        raw: snippet(key),
        evidence:
          `"${OPEN}${snippet(key)}${CLOSE}" is not a source key. A key is dot-separated ` +
          'segments of letters, numerals and underscores, beginning with an ASCII lowercase ' +
          'letter — which is what makes a key structurally incapable of being a number.',
      });
      emit(REDACTED);
      continue;
    }

    const value = values.get(key);
    if (value === undefined) {
      placeholderFaults.push({
        kind: 'unknown-key',
        frame: 'draft',
        start,
        end,
        key,
        evidence:
          `No value was computed under the source key "${key}", so nothing was substituted. ` +
          'The key is not echoed and the placeholder is not left standing: a name that resolves ' +
          'to no measurement must leave no trace a reader could mistake for one.',
      });
      emit(REDACTED);
      continue;
    }

    /* THE ONLY PLACE A VALUE ENTERS THE TEXT. It is emitted verbatim and it is
     * never re-scanned for placeholders — the loop reads `draft`, so a value
     * that happened to contain `{{…}}` is inert text, not a second round. */
    const at = emit(value);
    substitutions.push({ key, value, start: at, end: at + value.length });
  }

  const tail = draft.slice(cursor);
  scanLiteral(tail, cursor);
  emit(tail);

  const final = pieces.join('');
  const spans: Span[] = substitutions.map((made) => ({ start: made.start, end: made.end }));

  /* -- what does the finished text assert, and who wrote it? -------------- */

  const quantityFaults: SubstitutionViolation[] = [];
  const found = quantities(final);
  const owners = found.map((quantity) => spanAround(spans, quantity.start, quantity.end));

  for (const [index, quantity] of found.entries()) {
    const owner = owners[index];

    if (owner !== null) {
      /* A value, intact. The one thing still to check is whether the model
       * welded a UNIT onto it: `%` turns 41 into a rate and `×` turns 12.7 into
       * a multiple, and a unit the model chose is a magnitude the model chose —
       * that is the "12.7x" fabrication src/lib/brain/law/source-keys.ts was
       * written about, assembled from a value it did not have to type. If a
       * figure carries a unit, the unit is part of the value. */
      if (quantity.marked && quantity.markerEnd > owner.end) {
        quantityFaults.push({
          kind: 'glued-value',
          frame: 'final',
          start: quantity.start,
          end: quantity.markerEnd,
          raw: final.slice(quantity.start, quantity.markerEnd),
          evidence:
            `A unit was typed onto the substituted value "${final.slice(owner.start, owner.end)}". ` +
            'A unit is part of the figure — if the measurement is a rate or a multiple, the value ' +
            'carries the sign and the model does not add one.',
        });
      }
      continue;
    }

    if (overlapsSpan(spans, quantity.start, quantity.end)) {
      quantityFaults.push({
        kind: 'glued-value',
        frame: 'final',
        start: quantity.start,
        end: quantity.end,
        raw: quantity.raw,
        evidence:
          `"${quantity.raw}" is not a value this code substituted — it runs across the edge of ` +
          'one. Digits typed against a real figure make a new figure nobody measured.',
      });
      continue;
    }

    if (isListOrdinal(final, quantity)) continue;

    quantityFaults.push({
      kind: 'bare-quantity',
      frame: 'final',
      start: quantity.start,
      end: quantity.end,
      raw: quantity.raw,
      evidence:
        `"${quantity.raw}" is a quantity the draft typed directly. Internal quantities reach the ` +
        'screen only by code substituting a placeholder that names a source key; the one permitted ' +
        'exception is a single-digit list ordinal at the head of a line. A year is not an exception: ' +
        'it names a position in the calendar to a reader and a magnitude to anyone who wants one.',
    });
  }

  /* -- two values with nothing but a gap between them --------------------- */

  /* The claims-linter names this residual in its own header and cannot close
   * it: it cannot tell which of two neighbouring numbers is evidence. Here both
   * sides are known to be substituted values, so «٨٨ ٥٠٨» written as two honest
   * placeholders — which a reader reads as 88508 — is refusable, and refused.
   *
   * THE QUESTION IS ASKED POSITIVELY, and this is the one place it is asked: a
   * pair stays glued unless `separatesFigures()` FINDS something between them.
   * Asked the other way round — "unless the gap is made of invisibles I know" —
   * this rule shipped `508<U+034F>40` as deliverable. */
  for (let index = 0; index + 1 < found.length; index += 1) {
    const left = owners[index];
    const right = owners[index + 1];
    if (left === null || right === null || left === right) continue;
    if (separatesFigures(final, found[index].end, found[index + 1].start)) continue;
    quantityFaults.push({
      kind: 'glued-value',
      frame: 'final',
      start: found[index].start,
      end: found[index + 1].end,
      raw: final.slice(found[index].start, found[index + 1].end),
      evidence:
        'Two substituted values stand side by side with nothing VISIBLE between them — no word, ' +
        'no punctuation, no line — which reads as a single larger figure. Whatever stands between ' +
        'two figures has to be something the reader can actually see.',
    });
  }

  /* -- the numerals the tokeniser does not model -------------------------- */

  NON_DECIMAL_NUMERAL.lastIndex = 0;
  for (const numeral of final.matchAll(NON_DECIMAL_NUMERAL)) {
    const start = numeral.index;
    const end = start + numeral[0].length;
    if (spanAround(spans, start, end) !== null) continue;
    quantityFaults.push({
      kind: 'bare-quantity',
      frame: 'final',
      start,
      end,
      raw: numeral[0],
      evidence:
        `"${numeral[0]}" is a numeral outside the decimal digits — a superscript, a fraction or ` +
        'a numeral letter. It is invisible to every decimal tokeniser, which is exactly why it ' +
        'may not appear: a deliverable states its figures as substituted values or not at all.',
    });
  }

  const violations = [...placeholderFaults, ...quantityFaults];

  return {
    final,
    substitutions,
    violations,
    deliverable: violations.length === 0,
  };
}

/* `touchesInline()` used to be declared here. It had exactly one caller — the
 * calendar-year exception — and it went out with it. The two-values-side-by-side
 * rule inside `substitute()` never used it; it asks about the gap directly. */
