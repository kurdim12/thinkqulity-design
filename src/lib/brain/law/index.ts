import type { z } from 'zod';
import { fail, pass, type LawResult } from './types.ts';
import { paletteClaims, paletteRefs } from './palette-claims.ts';
import { paletteMatch, type MeasuredColors } from './palette-match.ts';
import { claimsLinter } from './claims-linter.ts';
import { registerScore } from './register-score.ts';
import { frameStructure, guidelineStructure, type FrameLike, type GuidelineSection } from './structure.ts';
import { sourceKeys, type SourceKeysInput } from './source-keys.ts';

export * from './types.ts';
export { paletteClaims, paletteRefs, claimsLinter, registerScore, guidelineStructure, frameStructure };
export { paletteMatch, canonicalHex, colorDistance, NEAR_MATCH_MAX_DISTANCE } from './palette-match.ts';
export type { MeasuredColors, PaletteMatchResult } from './palette-match.ts';
export { REQUIRED_SECTIONS, TBD_AR } from './structure.ts';
export type { GuidelineSection, FrameLike } from './structure.ts';
export { profile } from './register-score.ts';
export { sourceKeys, parseRenderedMeasures } from './source-keys.ts';
export type { BasisLike, CitedClaim, ClaimGrounding, SourceKeysInput } from './source-keys.ts';

/** Zod validation expressed as a Law check so it appears in the same report. */
export function schemaValid(schema: z.ZodTypeAny, value: unknown): LawResult {
  const result = schema.safeParse(value);
  if (result.success) return pass('schema-valid', 'Output matches the feature contract.');
  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return fail('schema-valid', issues, 'violation', { issues: result.error.issues.length });
}

export interface LawInput {
  /** Everything the output says, flattened to text for scanning. */
  text: string;
  /** The context blocks the agent was given, for claim tracing. */
  context?: string;
  swatches?: Record<string, string> | null;
  voiceExamples?: string[];
  paletteReferences?: (string | null | undefined)[];
  frames?: FrameLike[];
  guidelineSections?: GuidelineSection[];
  /**
   * The strategist's citations, the keys its context blocks emitted, and those
   * blocks. Supplied only by paths that cite source keys; every other feature
   * simply does not get this check rather than getting a vacuous pass.
   */
  sourceKeys?: SourceKeysInput;
  /**
   * Colours COUNTED out of an image by src/lib/vision/colors.ts. Supplied only
   * by paths that actually measured an image; an unmeasured post does not get
   * the check rather than getting a vacuous pass.
   *
   * `runLaw` surfaces the LawResult here alongside every other check. The
   * `PaletteMatch` object destined for `visual_features.palette_match` comes
   * from calling `paletteMatch()` directly — a report of verdicts is not the
   * place to also hand back a database row.
   */
  measuredColors?: MeasuredColors;
}

export interface LawReport {
  results: LawResult[];
  /** Hard failures only. Warnings never block. */
  violations: LawResult[];
  warnings: LawResult[];
  passed: boolean;
}

/**
 * Runs every check that applies to the given input. Checks are additive: a
 * feature that has no frames simply doesn't get the frame checks, rather than
 * getting a vacuous pass.
 */
export function runLaw(input: LawInput): LawReport {
  const results: LawResult[] = [paletteClaims(input.text, input.swatches)];

  if (input.context !== undefined) {
    results.push(claimsLinter(input.text, input.context));
  }
  if (input.sourceKeys !== undefined) {
    results.push(sourceKeys(input.sourceKeys));
  }
  if (input.voiceExamples !== undefined) {
    results.push(registerScore(input.text, input.voiceExamples));
  }
  if (input.paletteReferences !== undefined) {
    results.push(paletteRefs(input.paletteReferences, input.swatches));
  }
  if (input.frames !== undefined) {
    results.push(frameStructure(input.frames));
  }
  if (input.guidelineSections !== undefined) {
    results.push(guidelineStructure(input.guidelineSections));
  }
  if (input.measuredColors !== undefined) {
    results.push(paletteMatch(input.measuredColors, input.swatches).law);
  }

  const violations = results.filter((r) => !r.passed && r.severity === 'violation');
  const warnings = results.filter((r) => !r.passed && r.severity === 'warning');

  return { results, violations, warnings, passed: violations.length === 0 };
}
