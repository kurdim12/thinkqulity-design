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

/** Anything a reader sees as blank, including the invisibles. Empty counts. */
const BLANK_RUN = /^[\s\p{Cf}\p{Cc}]*$/u;

/** Every character that ends a line. A line break is a separation a reader sees. */
const LINE_BREAK = /[\n\r\u2028\u2029\u0085\u000B\u000C]/u;

/** Exactly four ASCII digits after normalisation: no separator, no invisible. */
const FOUR_BARE_DIGITS = /^\d{4}$/;

/** 1900 to 2100, spelled as digits. Mirrors the claims-linter; no arithmetic. */
const YEAR = /^(?:19\d\d|20\d\d|2100)$/;

/** One digit, 1 to 9, after normalisation. Never a two-digit head like `٨٨`. */
const SINGLE_ORDINAL_DIGIT = /^[1-9]$/;

/**
 * What may follow a list ordinal: `1.` and `1)` are Markdown, `١-` is how the
 * Arabic side of this product actually numbers a list. Whatever follows must
 * then end the line or be blank, so `5-10` is not an ordinal.
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
 * Whether `[from, to)` is blank AND holds no line break.
 *
 * The claims-linter counts a newline as blank, deliberately: it cannot tell a
 * value from a claim, so it must assume the worst about a gap. This engine KNOWS
 * which characters it wrote, so it can afford the true rule — a line break is a
 * separation a reader sees, two numbers on two lines are two numbers, and two
 * numbers with nothing but spaces between them on ONE line are one figure
 * wearing a gap.
 */
function inlineGap(text: string, from: number, to: number): boolean {
  const gap = text.slice(from, to);
  return BLANK_RUN.test(gap) && !LINE_BREAK.test(gap);
}

/** Nothing but spaces and tabs back to the start of the line. */
function atLineStart(text: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i -= 1) {
    const character = text[i];
    if (character === ' ' || character === '\t') continue;
    return LINE_BREAK.test(character);
  }
  return true;
}

/**
 * EXCEPTION 1 — A CALENDAR YEAR.
 *
 * The principle both exceptions answer to: DIGITS MAY BE A LABEL, NEVER A
 * MAGNITUDE. A year names a position in the calendar the way a word names a
 * month; nobody reads a follower count out of «خطة 2026». And unlike a palette
 * or a metric, the calendar is an OPEN set — the system cannot enumerate every
 * year the model might legitimately name, so there is no placeholder to offer
 * instead. That is the whole justification, and it is why the palette did NOT
 * get an exception: a swatch comes from a closed set this app already holds, so
 * `#48C0C0` is a placeholder, exactly as `paletteRefs()` already asks frames to
 * name a swatch rather than type a hex.
 *
 * The form is nailed shut around that meaning: exactly four digits with nothing
 * hidden between them, inside 1900–2100, carrying no unit, touching no letter,
 * and not sitting inline beside another quantity. `2,026` is a figure and fails.
 * `2026٪` is a rate and fails. `٢٠٢٦` beside a substituted value fails.
 *
 * THE RESIDUAL: a draft may write "2026" and mean it as a count. 201 values are
 * reachable this way and none of them is a figure this client's accounts hold.
 * It is a door, it is the narrowest one that keeps the calendar writable, and it
 * is stated here rather than discovered later.
 */
function isCalendarYear(quantity: Quantity): boolean {
  if (quantity.marked || !quantity.bounded) return false;
  if (!FOUR_BARE_DIGITS.test(normaliseDigits(quantity.raw))) return false;
  return YEAR.test(quantity.key);
}

/**
 * EXCEPTION 2 — A SINGLE-DIGIT LIST ORDINAL AT THE HEAD OF A LINE.
 *
 * Same principle: `١.` names a position in a list, and a reader parses it as
 * structure before they parse it as a number. Like the calendar and unlike a
 * measurement, list positions are an open sequence the system cannot enumerate.
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

    if (isCalendarYear(quantity) && !touchesInline(final, found, index)) continue;
    if (isListOrdinal(final, quantity)) continue;

    quantityFaults.push({
      kind: 'bare-quantity',
      frame: 'final',
      start: quantity.start,
      end: quantity.end,
      raw: quantity.raw,
      evidence:
        `"${quantity.raw}" is a quantity the draft typed directly. Internal quantities reach the ` +
        'screen only by code substituting a placeholder that names a source key; the permitted ' +
        'exceptions are a bare calendar year and a single-digit list ordinal at the head of a line.',
    });
  }

  /* -- two values with nothing but a gap between them --------------------- */

  /* The claims-linter names this residual in its own header and cannot close
   * it: it cannot tell which of two neighbouring numbers is evidence. Here both
   * sides are known to be substituted values, so «٨٨ ٥٠٨» written as two honest
   * placeholders — which a reader reads as 88508 — is refusable, and refused. */
  for (let index = 0; index + 1 < found.length; index += 1) {
    const left = owners[index];
    const right = owners[index + 1];
    if (left === null || right === null || left === right) continue;
    if (!inlineGap(final, found[index].end, found[index + 1].start)) continue;
    quantityFaults.push({
      kind: 'glued-value',
      frame: 'final',
      start: found[index].start,
      end: found[index + 1].end,
      raw: final.slice(found[index].start, found[index + 1].end),
      evidence:
        'Two substituted values stand side by side on one line with nothing but blank space ' +
        'between them, which reads as a single larger figure. Put words between them, or a line.',
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

/**
 * Whether the quantity at `index` stands inline beside another quantity.
 *
 * Only the calendar-year exception consults this: a year is a label, but a label
 * pressed against a figure on the same line stops reading as one. Declared after
 * `substitute()` because it belongs to the exception, not to the pass.
 */
function touchesInline(text: string, found: readonly Quantity[], index: number): boolean {
  const here = found[index];
  if (index > 0 && inlineGap(text, found[index - 1].end, here.start)) return true;
  if (index + 1 < found.length && inlineGap(text, here.end, found[index + 1].start)) return true;
  return false;
}
