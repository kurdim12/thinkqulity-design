import { fail, normaliseDigits, pass, type LawResult } from './types.ts';

/**
 * A metric claim is a number the reader will take as fact: a count in the
 * hundreds, a percentage, a multiplier. Those must appear in the context the
 * agent was given. Small bare numbers (قانون الـ٣, "3 concepts", a weekday)
 * are not claims and are deliberately ignored — flagging them would train the
 * operator to skim past violations.
 */
const METRIC = /(\d[\d,]*(?:\.\d+)?)\s*(%|×|x\b)?/g;

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

/** Does the context contain this number, in any common notation? */
function contextHas(context: string, claim: Claim): boolean {
  const plain = String(claim.value);
  const withCommas = claim.value.toLocaleString('en-US');
  return (
    context.includes(claim.raw) || context.includes(plain) || context.includes(withCommas)
  );
}

export function claimsLinter(output: string, context: string): LawResult {
  const claims = extract(output);
  if (claims.length === 0) {
    return pass('claims-linter', 'No metric claims made.');
  }

  const normalisedContext = normaliseDigits(context);
  const unsourced = claims.filter((c) => !contextHas(normalisedContext, c));

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
