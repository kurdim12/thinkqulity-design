/**
 * Law: deterministic checks the model cannot argue with.
 *
 * Every function here is pure and dependency-free — no database, no network,
 * no model. That is the whole point: the Judge can be persuaded, Law cannot.
 * Because they are pure they are also exhaustively testable, and they are.
 */
export interface LawResult {
  /** Stable identifier, e.g. "palette-claims". */
  check: string;
  passed: boolean;
  /** What was actually found. Shown to the operator verbatim. */
  evidence: string;
  source: 'law';
  /**
   * A violation is a hard fail. A warning is a smell — register-score is a
   * warning by design, because a heuristic must never veto a human's writing.
   */
  severity: 'violation' | 'warning';
  detail?: Record<string, unknown>;
}

export function pass(check: string, evidence: string, detail?: Record<string, unknown>): LawResult {
  return { check, passed: true, evidence, source: 'law', severity: 'violation', detail };
}

export function fail(
  check: string,
  evidence: string,
  severity: 'violation' | 'warning' = 'violation',
  detail?: Record<string, unknown>,
): LawResult {
  return { check, passed: false, evidence, source: 'law', severity, detail };
}

/** One decimal digit, in any script. Not global: it is asked about one character. */
const ONE_DIGIT = /^\p{Nd}$/u;

/**
 * The value of one decimal digit, whatever script wrote it.
 *
 * Two mechanisms, because neither alone covers everything. NFKD folds the digits
 * that have an ASCII compatibility mapping — full-width ５, mathematical 𝟝 — and
 * that also settles the mathematical alphanumeric blocks, which are the one
 * place where several ten-digit runs sit back to back. Everything else is a
 * block of exactly ten code points starting at its own zero, so the value is the
 * distance down to the first code point that is no longer a digit.
 *
 * A digit this cannot read would come back with the wrong value, and the wrong
 * value simply fails to match any evidence — the failure direction is a number
 * that gets stripped, never one that gets through.
 */
function digitValue(digit: string): string {
  const folded = digit.normalize('NFKD');
  if (folded.length === 1 && folded >= '0' && folded <= '9') return folded;

  const code = digit.codePointAt(0) ?? 0;
  let distance = 0;
  while (distance < 9 && ONE_DIGIT.test(String.fromCodePoint(code - distance - 1))) {
    distance += 1;
  }
  return String(distance);
}

/**
 * EVERY Unicode decimal digit → ASCII, so numbers compare across scripts.
 *
 * There is exactly one digit normaliser in this app and this is it. It used to
 * cover Arabic-Indic and extended Arabic-Indic only, which meant full-width
 * ８８１２３ and Devanagari ८८१२३ were invisible to the claims-linter's claim side
 * — a draft could state a figure in either and be checked against nothing at
 * all. `\p{Nd}` is the whole class, so no numeral script is a free pass.
 *
 * NOTE FOR CALLERS: this does not preserve string length. An astral digit is two
 * UTF-16 units and becomes one, so an offset taken in the output does not mean
 * the same thing in the input. Nothing depends on that any more —
 * src/lib/brain/law/claims-linter.ts scans the ORIGINAL text and normalises each
 * quantity it finds — and nothing should start to.
 */
export function normaliseDigits(input: string): string {
  return input.replace(/\p{Nd}/gu, digitValue);
}
