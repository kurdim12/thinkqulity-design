import { fail, normaliseDigits, pass, type LawResult } from './types.ts';

/**
 * ===========================================================================
 * ONE DEFINITION OF "A NUMBER", FOR BOTH SIDES OF THE CHECK
 * ===========================================================================
 *
 * This file used to hold TWO. One regex found CLAIMS in the model's draft and a
 * different one found EVIDENCE in the context it was given, and the file's own
 * comment asserted that the two agreed. They did not, and every disagreement
 * was a door:
 *
 *   - the claim side did not know U+066C, so «٨٨٬٥٠٨» was read as 88 and 508.
 *     88 is under the claim floor and was dropped in silence; 508 is a real
 *     measured figure and sourced itself; the reader was handed a follower
 *     count no row has ever held. A plain space, a no-break space, a zero-width
 *     space, a bidi mark and a newline all did the same. No exotic character
 *     was required.
 *   - the evidence side treated any comma as a thousands separator, so the list
 *     `ids: 1,2,3` donated the token 123 and a claim of 123 linted clean.
 *
 * So there is now ONE tokeniser — `quantities()` — and it answers one question:
 * WHAT QUANTITIES DOES THIS STRING ASSERT? Both sides call it. They differ only
 * in WHICH of the quantities it returns they accept, never in where a quantity
 * begins and ends, so neither of those two attacks has anywhere left to live.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ONE QUANTITY
 * ---------------------------------------------------------------------------
 *   1. A maximal run of decimal digits, IN ANY SCRIPT. `\p{Nd}` covers
 *      Arabic-Indic, extended Arabic-Indic, full-width, Devanagari and the rest;
 *      full-width ８８１２３ used to be invisible to the claim side entirely, which
 *      made it a free pass against an empty context.
 *   2. Held together by the separators that legitimately sit INSIDE one number:
 *      the decimal point, the thousands comma, and their Arabic counterparts
 *      U+066B (decimal) and U+066C (thousands). A grouping separator counts only
 *      where it actually groups — `\d{1,3}` then groups of exactly three — so
 *      `96,520` is one quantity and `1,2,3` is three.
 *   3. Held together by INVISIBLE characters. A zero-width space, a joiner or a
 *      bidi mark between two digits is not a separator to a reader: the digits
 *      render touching, so they are one number and are read as one.
 *   4. Ended by everything else. Whitespace of any width, punctuation, a letter,
 *      a `%` — all of them close the quantity, on BOTH sides of the check.
 *
 * ---------------------------------------------------------------------------
 * WHY A VISIBLE GAP DOES NOT SILENTLY SPLIT A CLAIM
 * ---------------------------------------------------------------------------
 * A gap that a reader can SEE ends the quantity — «٨٨ ٥٠٨» is not the same text
 * as «٨٨٥٠٨». But it does not make the head vanish: a quantity standing beside
 * another quantity across nothing but blank space is not a bare small number
 * like «قانون الـ٣», it is part of a bigger written figure. So it is a CLAIM
 * regardless of the sub-100 floor, and the draft that stated it must source it.
 *
 * The residual, stated plainly: a draft that writes two SOURCED numbers side by
 * side with nothing between them still passes, and a reader may read them as one
 * figure. Closing that would mean joining quantities across a visible gap — and
 * the same rule would then join two evidence values that merely sit next to each
 * other, destroying both. The check errs towards keeping evidence honest.
 *
 * ---------------------------------------------------------------------------
 * A CLAIM IS SOURCED BY A WHOLE QUANTITY, NEVER BY A SUBSTRING
 * ---------------------------------------------------------------------------
 * This check used to ask `context.includes("508")`, which is true of the string
 * `ig_id: 1750899508`. The contexts it runs against carry Instagram ids, uuids
 * and ISO timestamps, so almost any three-digit figure can be found inside one
 * of them. A quantity that TOUCHES A LETTER OR ANOTHER NUMBER on either side is
 * a fragment of an identifier rather than a measurement, and it is not
 * `bounded` — the evidence side refuses it, which is what keeps the hex groups
 * of a uuid from donating 550, 8400 and 29 to the evidence pool. The claim side
 * accepts it, because a number glued to a word in a draft is still a number the
 * reader will read. That asymmetry is the safe direction and it is the ONLY
 * asymmetry: both sides are looking at the same quantities, in the same places.
 *
 * ---------------------------------------------------------------------------
 * COMPARISON IS BY NORMALISED STRING, NEVER BY NUMBER
 * ---------------------------------------------------------------------------
 * `Number("17509995080123456") === Number("17509995080123457")` is true, so an
 * id compared as a number sourced its off-by-one neighbour. Every comparison
 * here is between `Quantity.key`: ASCII digits, grouping separators removed, one
 * decimal point, no leading or trailing zero noise. `96,520`, `96520` and
 * `٩٦٥٢٠` are one key; two ids that differ in their last digit are two.
 *
 * There is no numeric comparison anywhere in this file. The claim floor and the
 * year rule are expressed as tests on the digits of the key — a key with three
 * or more integer digits is at least 100, and a four-digit key matching the year
 * pattern is a year — precisely so that a 17-digit id can never be rounded on
 * its way into a decision.
 *
 * PURITY. No model, no I/O, no environment, no clock. Same input, same answer.
 */

/* ============================================================ the alphabet == */

/** One decimal digit, in any script: ٥ ۵ ५ ５ 5 are all `\p{Nd}`. */
const DIGIT = '\\p{Nd}';

/**
 * Zero-width and bidi formatting marks. A reader sees nothing where one of these
 * stands, so it cannot be what separates a number from itself: ZWSP, ZWNJ, ZWJ,
 * LRM, RLM, the Arabic letter mark and the word joiner are all `\p{Cf}`.
 */
const INVISIBLE = '\\p{Cf}';

/** A digit reached across any number of invisible marks. */
const JOINED_DIGIT = `${INVISIBLE}*${DIGIT}`;

/**
 * The two separators that sit INSIDE one quantity, each written twice: once for
 * the Latin spelling and once for the Arabic. They are named here because `٫`
 * (U+066B, decimal) and `٬` (U+066C, thousands) are one pixel apart in most
 * editors and a reader must be able to tell which is which.
 */
const GROUP_SEPARATOR = '[,٬]';
const DECIMAL_SEPARATOR = '[.٫]';

/** `96,520` — one to three digits, then groups of exactly three. `1,2,3` is not. */
const GROUPED = `${DIGIT}(?:${JOINED_DIGIT}){0,2}(?:${INVISIBLE}*${GROUP_SEPARATOR}(?:${JOINED_DIGIT}){3})+`;

/** `1750899508` — a plain run, however long. */
const PLAIN = `${DIGIT}(?:${JOINED_DIGIT})*`;

/** `.97` — the fractional half, in either script. */
const FRACTION = `${INVISIBLE}*${DECIMAL_SEPARATOR}(?:${JOINED_DIGIT})+`;

/**
 * THE ONE TOKENISER'S PATTERN. Grouped first, so `96,520` is preferred over the
 * `96` a plain run would stop at. Scanned globally, left to right, longest match
 * at each position — which is what decomposes `1,2,3` into three quantities
 * rather than manufacturing one.
 */
const QUANTITY = new RegExp(`(?:${GROUPED}|${PLAIN})(?:${FRACTION})?`, 'gu');

/**
 * A unit marker following a quantity: percent in either script, the multiplication
 * sign, or a standalone `x`. `13x` and `13×` are the same claim and always were;
 * `٣٤٠٪` used to be a claim only because it cleared the floor, which meant `٥٪`
 * was not a claim at all while `5%` was. One marker set, one answer.
 */
const MARKER = /\s*(?:%|٪|×|[xX](?![\p{L}\p{N}]))/uy;

/** A letter or a number immediately here. Sticky, so no substring is copied. */
const WORD_HERE = /[\p{L}\p{N}]/uy;

/** A standalone `x` immediately here — the one letter allowed to end a quantity. */
const X_MARKER_HERE = /[xX](?![\p{L}\p{N}])/uy;

/** A letter or a number immediately before this offset. */
const WORD_BEFORE = /[\p{L}\p{N}]$/u;

/**
 * Everything a reader sees as blank: whitespace of any width, the invisible
 * formatting marks, and the control characters. Two quantities separated by
 * nothing but these are ADJACENT — they are one written figure wearing a gap.
 */
const BLANK_ONLY = /^[\s\p{Cf}\p{Cc}]+$/u;

/** 1900 to 2100, spelled as digits so no arithmetic touches a quantity. */
const YEAR = /^(?:19\d\d|20\d\d|2100)$/;

/** Exactly four digits and nothing else — `2,025` is a figure, not a year. */
const FOUR_BARE_DIGITS = /^\d{4}$/;

/**
 * A count in the hundreds is a claim; three integer digits IS "at least 100",
 * because `key` carries no leading zeros. Stated as a length rather than a
 * comparison for the reason in the header: nothing here parses a number.
 */
const CLAIM_FLOOR_DIGITS = 3;

/* =============================================================== the token == */

/** One quantity a string asserts. Produced by `quantities()` and nothing else. */
export interface Quantity {
  /** Verbatim, exactly as the text spelled it — Arabic-Indic, separators and all. */
  raw: string;
  /**
   * THE THING COMPARED: ASCII digits, no grouping separator, at most one decimal
   * point, no leading or trailing zero noise. Never a number.
   */
  key: string;
  /** Where the digits start. */
  start: number;
  /** Where the digits end. */
  end: number;
  /** Where the unit marker ends — equal to `end` when there is none. */
  markerEnd: number;
  /** A `%`, `٪`, `×` or standalone `x` follows. */
  marked: boolean;
  /** Neither side touches a letter or another number: a quantity, not a fragment. */
  bounded: boolean;
  /** Another quantity sits beside it across nothing but blank space. */
  adjacent: boolean;
}

/**
 * The canonical spelling of one quantity: ASCII digits, grouping dropped, the
 * Arabic decimal separator folded onto the point, leading zeros and trailing
 * fractional zeros removed. `08` and `8` are one key; `507.970` and `507.97` are
 * one key; `17509995080123456` and `17509995080123457` are two.
 */
function canonical(raw: string): string {
  const flat = normaliseDigits(raw)
    .replace(/\p{Cf}/gu, '')
    .replace(/[,٬]/g, '')
    .replace(/٫/g, '.');
  const point = flat.indexOf('.');
  const whole = (point === -1 ? flat : flat.slice(0, point)).replace(/^0+(?=\d)/, '');
  const fraction = (point === -1 ? '' : flat.slice(point + 1)).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * EVERY QUANTITY THIS STRING ASSERTS, in the order it asserts them.
 *
 * The single answer to "what is a number here", used by the claim side, by the
 * evidence side, and by the stripper that cuts a rejected figure back out of the
 * draft. Offsets are into the string as it was handed in — nothing is normalised
 * up front, so a span found here can be cut out of Arabic text without touching
 * a letter, a mark or a space beside it.
 */
export function quantities(text: string): Quantity[] {
  const found: Quantity[] = [];

  QUANTITY.lastIndex = 0;
  for (const match of text.matchAll(QUANTITY)) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;

    MARKER.lastIndex = end;
    const marker = MARKER.exec(text);
    const markerEnd = marker === null ? end : end + marker[0].length;

    WORD_BEFORE.lastIndex = 0;
    const leftTouches = WORD_BEFORE.test(text.slice(Math.max(0, start - 2), start));

    WORD_HERE.lastIndex = end;
    X_MARKER_HERE.lastIndex = end;
    const rightTouches = WORD_HERE.test(text) && !X_MARKER_HERE.test(text);

    found.push({
      raw,
      key: canonical(raw),
      start,
      end,
      markerEnd,
      marked: marker !== null,
      bounded: !leftTouches && !rightTouches,
      adjacent: false,
    });
  }

  // Adjacency is a property of a PAIR, so it is settled once the whole line is
  // known. A marked quantity is never adjacent on its right: the `%` is a
  // visible end to the figure, not a gap in the middle of one.
  for (let i = 0; i + 1 < found.length; i += 1) {
    const left = found[i];
    const right = found[i + 1];
    if (left.marked) continue;
    const between = text.slice(left.end, right.start);
    if (between !== '' && !BLANK_ONLY.test(between)) continue;
    left.adjacent = true;
    right.adjacent = true;
  }

  return found;
}

/**
 * The one quantity this WHOLE string asserts, or null when it asserts none or
 * more than one.
 *
 * THIS IS THE BOUNDARY BETWEEN A MEASUREMENT AND SOME TEXT WITH DIGITS IN IT.
 * A value the system produced IS a quantity — `508`, `507.97`, `+41`, `13×`. A
 * caption, a comment, a question, a title, a decision statement, a uuid, a
 * permalink, an ISO date and an hour range all merely CONTAIN digits, and none
 * of them is a measurement of anything. Callers that assemble a lint context use
 * this to decide what may enter it; see `lintEvidence()` in
 * src/lib/agent/chat/run.ts and `strategistEvidence()` in
 * src/lib/agent/strategist/blocks.ts.
 *
 * A leading sign is spelling, not a quantity: `+41` and `-7` are what
 * `formatDelta()` writes, and the sign is dropped from the key exactly as it was
 * before — a claim of 41 has always matched a delta of +41.
 */
export function wholeQuantity(value: string): string | null {
  const found = quantities(value);
  if (found.length !== 1) return null;
  const only = found[0];
  if (!only.bounded) return null;
  if (!/^[\s+\-−]*$/u.test(value.slice(0, only.start))) return null;
  if (!/^\s*$/u.test(value.slice(only.markerEnd))) return null;
  return only.key;
}

/* ========================================================== the two sides == */

/**
 * Every quantity the context OFFERS AS EVIDENCE: the bounded ones.
 *
 * ONCE PER LINT, deliberately. The chat context is the strategist's declared
 * values plus every tool result of the turn, and it runs on every turn; scanning
 * it per claim would be a full pass over that string for each number in the
 * reply.
 */
export function contextQuantities(context: string): Set<string> {
  const values = new Set<string>();
  for (const quantity of quantities(context)) {
    if (quantity.bounded) values.add(quantity.key);
  }
  return values;
}

/**
 * Whether one quantity is a CLAIM — something the reader will take as fact.
 *
 * A marked figure is always a claim: `5%` and `٥٪` are assertions at any size.
 * A quantity standing beside another across blank space is always a claim, or a
 * figure could be split into a sub-100 head and a sourced tail. Otherwise a
 * count in the hundreds is a claim and a small bare number is not — «قانون الـ٣»,
 * "3 concepts", a weekday. Flagging those would train the operator to skim past
 * violations. A bare four-digit year is not a claim either.
 */
function isClaim(quantity: Quantity): boolean {
  if (quantity.marked) return true;
  if (quantity.adjacent) return true;
  const bare = normaliseDigits(quantity.raw);
  if (FOUR_BARE_DIGITS.test(bare) && YEAR.test(quantity.key)) return false;
  const point = quantity.key.indexOf('.');
  const whole = point === -1 ? quantity.key : quantity.key.slice(0, point);
  return whole.length >= CLAIM_FLOOR_DIGITS;
}

/**
 * Every quantity a draft states as fact, with its offsets.
 *
 * Exported because the chat gate has to CUT these back out of the text when the
 * model will not withdraw them, and it must cut exactly what was linted. There
 * used to be a copy of the claim regex in src/lib/agent/chat/run.ts, mirrored by
 * hand and documented as a drift risk; it is gone, and this is why.
 */
export function claimQuantities(text: string): Quantity[] {
  return quantities(text).filter(isClaim);
}

export function claimsLinter(output: string, context: string): LawResult {
  const claims = claimQuantities(output);
  if (claims.length === 0) {
    return pass('claims-linter', 'No metric claims made.');
  }

  const sourced = contextQuantities(context);
  const unsourced = claims.filter((claim) => !sourced.has(claim.key));

  if (unsourced.length > 0) {
    const list = [...new Set(unsourced.map((claim) => claim.raw))].join(', ');
    return fail(
      'claims-linter',
      `${unsourced.length} number(s) appear in the output but nowhere in the data it was given: ${list}.`,
      'violation',
      { unsourced: unsourced.map((claim) => claim.raw), checked: claims.length },
    );
  }

  return pass(
    'claims-linter',
    `All ${claims.length} metric claim(s) trace back to the provided data.`,
    { checked: claims.map((claim) => claim.raw) },
  );
}
