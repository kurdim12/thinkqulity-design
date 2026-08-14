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

/** Arabic-Indic and extended Arabic-Indic digits → ASCII, so numbers compare. */
export function normaliseDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}
