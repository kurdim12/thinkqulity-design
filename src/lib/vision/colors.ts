/**
 * Dominant colours, COUNTED — never asked of a model.
 *
 * `DominantColor.share` is documented in src/lib/types/db.ts as safe to be a
 * number precisely because it is counted in code over decoded pixels. This is
 * that code. A model that could return a share could return 0.42 for an image
 * it never opened; a counter cannot, so nothing here calls one.
 *
 * Hard rule 13 also lands here: this module READS pixels. It has no path that
 * writes one, and it never will.
 *
 * The input is a DECODED pixel buffer, not a URL and not an encoded file. Two
 * reasons: tests then need no network and no image codec, and decoding is a
 * dependency decision this module has no business making on its own. Whoever
 * mirrors an image decodes it and hands the bytes over. (Nothing is mirrored
 * today: `posts.raw` is null for all 320 stored rows, so the June media URLs
 * are expired and there is nothing to fetch until a refresh scrape runs. This
 * module is written against that future, and is fully testable without it.)
 *
 * Pure: no I/O, no environment reads, no clock, no randomness. The same buffer
 * gives the same answer on every machine and in every run, so it runs unchanged
 * under `node --test --experimental-strip-types` — which is why the one import
 * is type-only and carries an explicit `.ts` extension, exactly as the Law
 * modules and the audience population do.
 *
 * ---------------------------------------------------------------------------
 * THE METHOD, AND WHAT IT CANNOT DO
 *
 * Quantise each channel into fixed buckets of QUANT_STEP, count pixels per
 * bucket, and report the biggest buckets by the MEAN of the pixels that landed
 * in each — the mean rather than the bucket centre, so a flat graphic reports
 * the exact colour it actually used instead of the nearest lattice point.
 *
 * That works because a flat graphic IS a few colours. It does not work on a
 * photograph, and the honest thing is to say so rather than to return a
 * confident-looking answer:
 *
 *   - Flat graphics (a title card, a quote card, a logo lockup) collapse to a
 *     handful of buckets. The measurement means what it appears to mean.
 *   - Gradients FRAGMENT. A smooth sweep crosses many buckets and no single one
 *     dominates. This module deliberately does not merge neighbouring buckets to
 *     paper over that — merging would make a gradient look flat, which is the
 *     one thing that must not happen.
 *   - Photographs behave like gradients, only worse. A photo of a face has no
 *     brand palette to measure: its colours are lighting and skin, not design
 *     decisions. Reporting "38% #C89878" for such an image as though it were a
 *     brand choice would be a fabricated finding dressed as arithmetic.
 *
 * So the same fragmentation that defeats the measurement is used to DETECT it.
 * `distribution` classifies how concentrated the mass is, and `confident` is
 * false for 'continuous' images. Downstream, src/lib/brain/law/palette-match.ts
 * refuses to hand a photograph a passing brand verdict on that basis.
 *
 * Other honest limits, stated rather than discovered later:
 *   - Bucket boundaries are hard. Two colours a single step apart can land in
 *     different buckets, and antialiased edges generate intermediate colours
 *     that belong to neither shape they separate. This inflates `distinct_buckets`
 *     for line art and small text.
 *   - Nothing here is perceptual. Buckets are cut in sRGB with equal steps, so
 *     equal steps are not equally visible. The perceptual question is asked
 *     later, once, by the Law check's distance function — not twice, differently.
 *   - Share is share OF SAMPLED, OPAQUE PIXELS. Both denominators are returned
 *     (`sampled_pixels`, `counted_pixels`) so a caller can never mistake one for
 *     a count of the whole image.
 * ---------------------------------------------------------------------------
 */

import type { DominantColor } from '../types/db.ts';

/**
 * Channel width of one quantisation bucket, in 0-255 units.
 *
 * 16 gives 16 levels per channel and so 4096 possible buckets. Larger steps
 * merge more colours (and would eventually make a gradient look flat); smaller
 * steps split more (and would eventually make a flat graphic with antialiasing
 * look continuous). This is a declared method parameter, chosen, not measured —
 * it is exported so that any surface quoting a share can also quote the setting
 * that produced it.
 */
export const QUANT_STEP = 16;

/** Buckets per channel, derived from QUANT_STEP so the two cannot disagree. */
export const LEVELS_PER_CHANNEL = Math.ceil(256 / QUANT_STEP);

/**
 * Ceiling on pixels inspected per image.
 *
 * 65536 is one 256x256 image's worth. Above it the buffer is walked with a
 * stride rather than pixel by pixel, which bounds the work for a 4K frame
 * without changing the shape of the answer: dominant colours are a question
 * about proportions, and proportions survive subsampling.
 */
export const MAX_SAMPLED_PIXELS = 65536;

/**
 * Minimum alpha for a pixel to count, on 0-255.
 *
 * At least half opaque. A pixel you can barely see is not a colour the image
 * uses, and counting fully transparent padding would dilute every share by
 * however much empty canvas the exporter left behind. Skipped pixels are
 * reported as `transparent_pixels` rather than silently dropped.
 */
export const ALPHA_FLOOR = 128;

/** How many colours are returned at most, largest share first. */
export const DEFAULT_MAX_COLORS = 6;

/**
 * How many of the biggest buckets are summed to judge concentration.
 *
 * Five is the neighbourhood of a designed graphic: a background, a heading, a
 * body colour, an accent, and one more for the logo.
 */
export const CONCENTRATION_BUCKETS = 5;

/**
 * Share of counted pixels the top CONCENTRATION_BUCKETS must reach to call an
 * image 'flat' — i.e. almost everything is a handful of colours.
 */
export const FLAT_CONCENTRATION_MIN = 0.9;

/**
 * The floor for 'mixed'. Below this the mass is spread so thinly across buckets
 * that no small set of colours describes the image, which is what a photograph
 * or a full-frame gradient looks like from here.
 */
export const MIXED_CONCENTRATION_MIN = 0.5;

/**
 * How the image's colour mass is spread.
 *
 * 'empty' is not a spread at all — it is "nothing was counted", which happens
 * for a fully transparent buffer. It exists so that absence is a value rather
 * than a zero pretending to be a measurement (hard rule 2).
 */
export type ColorDistribution = 'flat' | 'mixed' | 'continuous' | 'empty';

/**
 * A decoded image. `data` is row-major, top-left first, 8 bits per channel,
 * `channels` values per pixel — the layout every common decoder and
 * `CanvasRenderingContext2D.getImageData()` already produce.
 */
export interface PixelBuffer {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA. */
  channels: 3 | 4;
}

export interface ColorSampleOptions {
  /** Defaults to DEFAULT_MAX_COLORS. */
  maxColors?: number;
}

/**
 * What was measured, and everything needed to judge whether it means anything.
 *
 * The extra counts are not debug noise: `colors` alone cannot be read honestly.
 * A share is a fraction of `counted_pixels`, which is a subset of
 * `sampled_pixels`, which is a subset of `total_pixels`, and a surface that
 * quotes the first without access to the rest is quoting a number whose
 * denominator it cannot name.
 */
export interface ColorSample {
  /** Largest share first. Hex is lowercase `#rrggbb`. */
  colors: DominantColor[];
  distribution: ColorDistribution;
  /** Share of counted pixels the returned `colors` account for, 0-1. */
  coverage: number;
  /**
   * Whether a brand-palette comparison against these colours is meaningful.
   * False for 'continuous' and 'empty' images. See the module note.
   */
  confident: boolean;
  /** Every pixel in the image. */
  total_pixels: number;
  /** Pixels actually visited (equals total_pixels when stride is 1). */
  sampled_pixels: number;
  /** Sampled pixels that met ALPHA_FLOOR. The denominator of every share. */
  counted_pixels: number;
  /** Sampled pixels rejected for being too transparent to count as colour. */
  transparent_pixels: number;
  /** Distinct quantisation buckets that received at least one counted pixel. */
  distinct_buckets: number;
  /** 1 means every pixel was visited. */
  stride: number;
  /**
   * Plain-language statement of what this measurement is and is not. Diagnostic
   * English for an operator or a log, deliberately NOT user-facing UI copy —
   * the bilingual surfaces render the numbers, not this sentence.
   */
  note: string;
}

/** Lowercase `#rrggbb` from three 0-255 channel values. */
export function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

interface Bucket {
  count: number;
  /** Running channel sums, so the reported colour is the members' mean. */
  sumR: number;
  sumG: number;
  sumB: number;
}

/**
 * The stride that keeps the walk under MAX_SAMPLED_PIXELS.
 *
 * Exported because the aliasing hazard it dodges is worth being able to test.
 * Walking a row-major buffer with a stride that divides the width visits the
 * SAME columns on every row, so an image with vertical structure — a striped
 * background, a side-aligned Arabic text column — would be measured through a
 * comb aligned to its own stripes. Bumping such a stride by one costs nothing
 * and breaks the lock, and it stays fully deterministic: no randomness is used
 * anywhere in this module, so two runs over one buffer cannot disagree.
 */
export function strideFor(totalPixels: number, width: number): number {
  if (totalPixels <= MAX_SAMPLED_PIXELS) return 1;
  const base = Math.ceil(totalPixels / MAX_SAMPLED_PIXELS);
  return width % base === 0 ? base + 1 : base;
}

/**
 * Count the dominant colours of a decoded image.
 *
 * Throws on a malformed buffer rather than measuring it. A buffer whose length
 * disagrees with its declared dimensions is a caller bug, and measuring it
 * anyway would produce shares over a denominator nobody intended — a fabricated
 * number arriving by arithmetic, which is worse than an obvious error because
 * it looks computed.
 */
export function dominantColors(image: PixelBuffer, options: ColorSampleOptions = {}): ColorSample {
  const { data, width, height, channels } = image;

  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError(
      `dominantColors: width and height must be positive integers; got ${width}x${height}.`,
    );
  }
  if (channels !== 3 && channels !== 4) {
    throw new TypeError(`dominantColors: channels must be 3 or 4; got ${String(channels)}.`);
  }

  const totalPixels = width * height;
  const expectedBytes = totalPixels * channels;
  if (data.length !== expectedBytes) {
    throw new TypeError(
      `dominantColors: buffer is ${data.length} bytes but ${width}x${height} at ${channels} channels needs ${expectedBytes}.`,
    );
  }

  const maxColors = Math.max(1, Math.trunc(options.maxColors ?? DEFAULT_MAX_COLORS));
  const stride = strideFor(totalPixels, width);

  const buckets = new Map<number, Bucket>();
  let sampled = 0;
  let counted = 0;
  let transparent = 0;

  for (let i = 0; i < totalPixels; i += stride) {
    sampled += 1;
    const offset = i * channels;

    if (channels === 4 && data[offset + 3] < ALPHA_FLOOR) {
      transparent += 1;
      continue;
    }

    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    counted += 1;

    const key =
      (Math.floor(r / QUANT_STEP) * LEVELS_PER_CHANNEL + Math.floor(g / QUANT_STEP)) *
        LEVELS_PER_CHANNEL +
      Math.floor(b / QUANT_STEP);

    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, { count: 1, sumR: r, sumG: g, sumB: b });
    } else {
      existing.count += 1;
      existing.sumR += r;
      existing.sumG += g;
      existing.sumB += b;
    }
  }

  if (counted === 0) {
    return {
      colors: [],
      distribution: 'empty',
      coverage: 0,
      confident: false,
      total_pixels: totalPixels,
      sampled_pixels: sampled,
      counted_pixels: 0,
      transparent_pixels: transparent,
      distinct_buckets: 0,
      stride,
      note:
        `No pixel met the alpha floor of ${ALPHA_FLOOR}/255, so no colour was measured. ` +
        `This is "not determined", not "no colour".`,
    };
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      hex: toHex(bucket.sumR / bucket.count, bucket.sumG / bucket.count, bucket.sumB / bucket.count),
      count: bucket.count,
    }))
    // Count descending, then hex ascending: ties must not depend on Map order,
    // or two runs over the same image could rank two equal colours differently.
    .sort((a, b) => (b.count - a.count) || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));

  const concentration =
    ranked.slice(0, CONCENTRATION_BUCKETS).reduce((sum, entry) => sum + entry.count, 0) / counted;

  const distribution: ColorDistribution =
    concentration >= FLAT_CONCENTRATION_MIN
      ? 'flat'
      : concentration >= MIXED_CONCENTRATION_MIN
        ? 'mixed'
        : 'continuous';

  const kept = ranked.slice(0, maxColors);
  const colors: DominantColor[] = kept.map((entry) => ({
    hex: entry.hex,
    share: entry.count / counted,
  }));

  // Summed as integer counts and divided once, not as a running total of the
  // shares above. Adding four floats that each rounded on their own division
  // gives 0.9999999999999999 for an image that is entirely accounted for, and a
  // coverage that reads as "some was withheld" when none was is a wrong number
  // however small the error.
  const coverage = kept.reduce((sum, entry) => sum + entry.count, 0) / counted;
  const confident = distribution === 'flat' || distribution === 'mixed';

  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  const note =
    distribution === 'continuous'
      ? `Colour is spread across ${buckets.size} buckets; the top ${CONCENTRATION_BUCKETS} hold only ` +
        `${pct(concentration)} of counted pixels. This reads as a photograph or a full-frame gradient, ` +
        `where dominant colours are lighting and subject rather than design choices, so these colours ` +
        `are not a brand palette and must not be compared to one as though they were.`
      : `Colour is concentrated: the top ${CONCENTRATION_BUCKETS} of ${buckets.size} buckets hold ` +
        `${pct(concentration)} of counted pixels, consistent with a designed graphic. Shares are ` +
        `fractions of ${counted} counted pixels, sampled at a stride of ${stride} with ` +
        `${QUANT_STEP}-unit quantisation.`;

  return {
    colors,
    distribution,
    coverage,
    confident,
    total_pixels: totalPixels,
    sampled_pixels: sampled,
    counted_pixels: counted,
    transparent_pixels: transparent,
    distinct_buckets: buckets.size,
    stride,
    note,
  };
}
