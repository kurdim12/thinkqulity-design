import { fail, pass, type LawResult } from './types.ts';

/**
 * A smell test for "does this sound like Ahmad", not a verdict.
 *
 * It compares surface statistics of the candidate against his real captions:
 * how much of it is Arabic script, how long his sentences run, how heavily he
 * uses emoji and ellipses, and whether the Levantine markers he actually
 * writes with are present. It cannot judge meaning, so it returns a WARNING
 * and is labelled heuristic everywhere it surfaces. A machine should not get
 * to veto a human's writing on the strength of character ratios.
 */

/** Markers that show up in his own captions — Levantine, not MSA. */
const DIALECT = [
  'مش', 'شو', 'هاد', 'هيك', 'بدك', 'بدي', 'كتير', 'بس', 'لسا', 'عشان',
  'ليش', 'منعيد', 'حابب', 'إنت', 'انت', 'ما في', 'يلا', 'كمان',
];

const ARABIC = /[؀-ۿ]/g;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

export interface RegisterProfile {
  arabicRatio: number;
  avgSentenceLength: number;
  emojiPer100: number;
  ellipsisPer100: number;
  dialectPer100: number;
}

export function profile(text: string): RegisterProfile {
  const chars = Math.max(text.length, 1);
  const arabic = (text.match(ARABIC) ?? []).length;
  const emoji = (text.match(EMOJI) ?? []).length;
  const ellipsis = (text.match(/…|\.\.\./g) ?? []).length;

  const sentences = text
    .split(/[.!?؟…\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const words = text.split(/\s+/).filter(Boolean).length;

  const dialect = DIALECT.reduce(
    (count, marker) => count + (text.split(marker).length - 1),
    0,
  );

  return {
    arabicRatio: arabic / chars,
    avgSentenceLength: sentences.length > 0 ? words / sentences.length : words,
    emojiPer100: (emoji / chars) * 100,
    ellipsisPer100: (ellipsis / chars) * 100,
    dialectPer100: (dialect / Math.max(words, 1)) * 100,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** 100 when identical, falling off with relative distance. */
function closeness(candidate: number, reference: number, tolerance: number): number {
  const distance = Math.abs(candidate - reference);
  return Math.max(0, 100 - (distance / Math.max(tolerance, 1e-6)) * 100);
}

export function registerScore(
  candidate: string,
  voiceExamples: string[],
  threshold = 45,
): LawResult {
  if (voiceExamples.length === 0) {
    return fail(
      'register-score',
      'No voice examples recorded, so the register cannot be compared to anything. Add real captions to the Brand Brain.',
      'warning',
      { heuristic: true, score: null },
    );
  }

  const target = voiceExamples.map(profile);
  const candidateProfile = profile(candidate);

  const reference: RegisterProfile = {
    arabicRatio: mean(target.map((p) => p.arabicRatio)),
    avgSentenceLength: mean(target.map((p) => p.avgSentenceLength)),
    emojiPer100: mean(target.map((p) => p.emojiPer100)),
    ellipsisPer100: mean(target.map((p) => p.ellipsisPer100)),
    dialectPer100: mean(target.map((p) => p.dialectPer100)),
  };

  const parts = [
    { name: 'Arabic script ratio', score: closeness(candidateProfile.arabicRatio, reference.arabicRatio, 0.5), weight: 3 },
    { name: 'sentence length', score: closeness(candidateProfile.avgSentenceLength, reference.avgSentenceLength, 12), weight: 2 },
    { name: 'emoji density', score: closeness(candidateProfile.emojiPer100, reference.emojiPer100, 2), weight: 1 },
    { name: 'ellipsis habit', score: closeness(candidateProfile.ellipsisPer100, reference.ellipsisPer100, 2), weight: 1 },
    { name: 'dialect markers', score: closeness(candidateProfile.dialectPer100, reference.dialectPer100, 8), weight: 2 },
  ];

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const score = Math.round(parts.reduce((sum, p) => sum + p.score * p.weight, 0) / totalWeight);

  const weakest = [...parts].sort((a, b) => a.score - b.score)[0];

  if (score < threshold) {
    return fail(
      'register-score',
      `Heuristic register match ${score}/100 against ${voiceExamples.length} real captions — furthest off on ${weakest.name}. This is a smell test, not a verdict.`,
      'warning',
      { heuristic: true, score, candidate: candidateProfile, reference },
    );
  }

  return pass(
    'register-score',
    `Heuristic register match ${score}/100 against ${voiceExamples.length} real captions.`,
    { heuristic: true, score, candidate: candidateProfile, reference },
  );
}
