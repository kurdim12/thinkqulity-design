import { fail, pass, type LawResult } from './types.ts';

/** The placeholder a guideline must use when the data to fill a section is absent. */
export const TBD_AR = 'سيُحدد لاحقاً';

/** Sections a brand guideline is not allowed to omit. */
export const REQUIRED_SECTIONS = [
  'positioning',
  'audience',
  'voice',
  'color',
  'typography',
  'logo_usage',
  'social',
  'arabic_specific',
] as const;

export type RequiredSection = (typeof REQUIRED_SECTIONS)[number];

export interface GuidelineSection {
  key: string;
  title_ar: string;
  lines: { text: string; source: string }[];
}

/** Every mandatory section present; nothing invented where data is missing. */
export function guidelineStructure(sections: GuidelineSection[]): LawResult {
  const present = new Set(sections.map((s) => s.key));
  const missing = REQUIRED_SECTIONS.filter((key) => !present.has(key));

  if (missing.length > 0) {
    return fail(
      'guideline-structure',
      `Missing mandatory section(s): ${missing.join(', ')}.`,
      'violation',
      { missing, present: [...present] },
    );
  }

  const unsourced = sections.flatMap((section) =>
    section.lines
      .filter((line) => !line.source || line.source.trim().length === 0)
      .map((line) => `${section.key}: "${line.text.slice(0, 60)}"`),
  );

  if (unsourced.length > 0) {
    return fail(
      'guideline-structure',
      `${unsourced.length} line(s) carry no source — every line in a guideline must say where it came from. First: ${unsourced[0]}`,
      'violation',
      { unsourced },
    );
  }

  const empty = sections.filter((s) => s.lines.length === 0);
  if (empty.length > 0) {
    return fail(
      'guideline-structure',
      `Section(s) ${empty.map((s) => s.key).join(', ')} are empty. A section with no data must say «${TBD_AR}» and name what would fill it.`,
      'violation',
      { empty: empty.map((s) => s.key) },
    );
  }

  return pass(
    'guideline-structure',
    `All ${REQUIRED_SECTIONS.length} mandatory sections present, every line sourced.`,
  );
}

/** Storyboard frames must be ordered, timed and actually filmable. */
export interface FrameLike {
  order: number;
  scene_beat_ar: string;
  overlay_ar: string;
  shot_direction: string;
  duration_s: number;
  palette_ref: string | null;
}

export function frameStructure(frames: FrameLike[]): LawResult {
  if (frames.length === 0) {
    return fail('frame-structure', 'A storyboard with no frames is not a storyboard.');
  }

  const orders = frames.map((f) => f.order);
  const expected = Array.from({ length: frames.length }, (_, i) => i + 1);
  if (orders.slice().sort((a, b) => a - b).join(',') !== expected.join(',')) {
    return fail(
      'frame-structure',
      `Frame order must be 1..${frames.length} with no gaps or repeats; got ${orders.join(', ')}.`,
      'violation',
      { orders },
    );
  }

  const badDuration = frames.filter((f) => !(f.duration_s > 0) || f.duration_s > 60);
  if (badDuration.length > 0) {
    return fail(
      'frame-structure',
      `Frame ${badDuration[0].order} has an unusable duration (${badDuration[0].duration_s}s). Each frame must run between 0 and 60 seconds.`,
      'violation',
      { orders: badDuration.map((f) => f.order) },
    );
  }

  const total = frames.reduce((sum, f) => sum + f.duration_s, 0);
  return pass(
    'frame-structure',
    `${frames.length} frames, ${total}s total, ordered and timed.`,
    { totalSeconds: total },
  );
}
