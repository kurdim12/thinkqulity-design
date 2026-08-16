import { fail, normaliseDigits, pass, type LawResult } from './types.ts';

/**
 * A metric claim is a number the reader will take as fact: a count in the
 * hundreds, a percentage, a multiplier. Those must appear in the context the
 * agent was given. Small bare numbers (قانون الـ٣, "3 concepts", a weekday)
 * are not claims and are deliberately ignored — flagging them would train the
 * operator to skim past violations.
 */
const METRIC = /(\d[\d,]*(?:\.\d+)?)\s*(%|×|x\b)?/g;

/**
 * ===========================================================================
 * A CLAIM IS SOURCED BY A WHOLE TOKEN, NEVER BY A SUBSTRING
 * ===========================================================================
 *
 * This check used to ask `context.includes("508")`, which is true of the string
 * `ig_id: 1750899508`. That was not a theoretical weakness: the chat context is
 * built from the strategist blocks AND every tool result, so it carries 19-digit
 * Instagram ids, uuids and ISO timestamps, and almost any three-digit figure can
 * be found somewhere inside one of them. `المعدل 508` linted clean against a
 * context whose only 508 was the tail of an id.
 *
 * So the context is TOKENISED instead, once per lint, and a claim is sourced
 * only when the whole token equals it:
 *
 *   1. A token is a maximal digit run. `1750899508` yields ONE token worth
 *      1750899508 and nothing else — the id can source itself and no part of
 *      itself.
 *   2. A run touching a LETTER on either side is not a quantity, it is a
 *      fragment of an identifier, and it yields no token at all. That is what
 *      keeps the hex groups of a uuid (`550e8400-e29b-…`) from donating 550,
 *      8400 and 29 to the evidence pool. The one exception is a trailing `x`
 *      standing for a multiplier, because `METRIC` above reads `13x` as a
 *      marked claim and the two halves of this file must agree about it.
 *   3. The separators that legitimately sit INSIDE one quantity in this product
 *      hold the token together: the decimal point, the thousands comma, and
 *      their Arabic-Indic counterparts U+066B (decimal) and U+066C (thousands).
 *      `96,520` and `٩٦٬٥٢٠` are one token each, not two. The markers that
 *      legitimately FOLLOW one — `%`, `٪`, `×` — are none of them letters, so
 *      they end a token without hiding it.
 *
 * Comparison is by VALUE, not by spelling, so `96,520`, `96520` and `٩٦٥٢٠` are
 * the same evidence — which is the whole reason `normaliseDigits` runs first.
 * There is no second digit normaliser in this file.
 */
const QUANTITY_TOKEN =
  /(?<![\p{L}\p{N}])\d+(?:[.,٫٬]\d+)*(?=[xX](?![\p{L}\p{N}])|[^\p{L}\p{N}]|$)/gu;

/** Thousands separators are noise; the Arabic decimal separator is a point. */
function tokenValue(token: string): number {
  return Number(token.replace(/[,٬]/g, '').replace(/٫/g, '.'));
}

/**
 * Every quantity the context actually states, as numbers.
 *
 * ONCE PER LINT, deliberately. The chat context is the blocks plus every tool
 * result of the turn and it runs on every turn; scanning it per claim would be
 * a full pass over that string for each number in the reply.
 */
export function contextQuantities(context: string): Set<number> {
  const values = new Set<number>();
  for (const match of normaliseDigits(context).matchAll(QUANTITY_TOKEN)) {
    const value = tokenValue(match[0]);
    if (Number.isFinite(value)) values.add(value);
  }
  return values;
}

interface Claim {
  raw: string;
  value: number;
  marked: boolean;
}

function extract(text: string): Claim[] {
  const normalised = normaliseDigits(text);
  const claims: Claim[] = [];

  for (const match of normalised.matchAll(METRIC)) {
    const raw = match[1];
    const marked = Boolean(match[2]);
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    // A four-digit number on its own is almost always a year; skip unless marked.
    const isYear = !marked && value >= 1900 && value <= 2100 && !raw.includes(',');
    if (isYear) continue;
    if (marked || value >= 100) claims.push({ raw, value, marked });
  }

  return claims;
}

export function claimsLinter(output: string, context: string): LawResult {
  const claims = extract(output);
  if (claims.length === 0) {
    return pass('claims-linter', 'No metric claims made.');
  }

  const sourced = contextQuantities(context);
  const unsourced = claims.filter((c) => !sourced.has(c.value));

  if (unsourced.length > 0) {
    const list = [...new Set(unsourced.map((c) => c.raw + (c.marked ? '' : '')))].join(', ');
    return fail(
      'claims-linter',
      `${unsourced.length} number(s) appear in the output but nowhere in the data it was given: ${list}.`,
      'violation',
      { unsourced: unsourced.map((c) => c.raw), checked: claims.length },
    );
  }

  return pass(
    'claims-linter',
    `All ${claims.length} metric claim(s) trace back to the provided data.`,
    { checked: claims.map((c) => c.raw) },
  );
}
