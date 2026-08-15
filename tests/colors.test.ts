import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHA_FLOOR,
  CONCENTRATION_BUCKETS,
  DEFAULT_MAX_COLORS,
  MAX_SAMPLED_PIXELS,
  QUANT_STEP,
  dominantColors,
  strideFor,
  toHex,
  type ColorSample,
  type PixelBuffer,
} from '../src/lib/vision/colors.ts';
import {
  NEAR_MATCH_MAX_DISTANCE,
  canonicalHex,
  colorDistance,
  paletteMatch,
  type MeasuredColors,
} from '../src/lib/brain/law/palette-match.ts';
import { runLaw } from '../src/lib/brain/law/index.ts';
import type { DominantColor } from '../src/lib/types/db.ts';

/* ------------------------------------------------------------- fixtures -- */

/**
 * The real sampled palette — the same eight values tests/law.test.ts uses.
 * Not invented for this file: the threshold test below derives its ceiling from
 * these, so a fake palette would prove nothing about the real one.
 */
const SWATCHES = {
  turquoise: '#48C0C0',
  turquoise_light: '#78D8D8',
  mint: '#60D8C0',
  sky: '#60C0D8',
  ink: '#181818',
  charcoal: '#303030',
  paper: '#F0F0F0',
  ember: '#D84800',
};

const TURQUOISE: [number, number, number] = [72, 192, 192];
const INK: [number, number, number] = [24, 24, 24];

/** Build an RGBA buffer from a per-pixel function. */
function rgba(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number, number],
): PixelBuffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const [r, g, b, a] = at(x, y);
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { data, width, height, channels: 4 };
}

/** Build an RGB (no alpha) buffer from a per-pixel function. */
function rgb(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number],
): PixelBuffer {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const [r, g, b] = at(x, y);
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
    }
  }
  return { data, width, height, channels: 3 };
}

/**
 * A flat two-colour graphic: 60 columns turquoise, 40 columns ink. This is what
 * a quote card looks like to a sampler — exactly two colours, exact shares.
 */
const TWO_COLOUR = rgba(100, 100, (x) => {
  const [r, g, b] = x < 60 ? TURQUOISE : INK;
  return [r, g, b, 255];
});

/**
 * A photograph-shaped image: three channels sweeping independently, so colour
 * mass fragments across many buckets the way skin, lighting and background do.
 * The sweep passes THROUGH the neighbourhood of the brand turquoise, which is
 * the point — it is the case where an ungated check would report a brand match
 * that the image never intended.
 */
const PHOTOGRAPH = rgb(128, 128, (x, y) => [
  60 + (x % 40),
  180 + (y % 40),
  180 + ((x * y) % 40),
]);

function shareOf(sample: ColorSample, hex: string): number | null {
  const found = sample.colors.find((c) => c.hex === hex);
  return found === undefined ? null : found.share;
}

function measured(colors: DominantColor[], distribution: MeasuredColors['distribution']): MeasuredColors {
  return { colors, distribution, coverage: colors.reduce((sum, c) => sum + c.share, 0) };
}

/* ------------------------------------------------ colours are COUNTED ---- */

test('a flat two-colour image yields exactly those two colours with exact shares', () => {
  const sample = dominantColors(TWO_COLOUR);

  assert.equal(sample.colors.length, 2);
  assert.equal(sample.colors[0].hex, '#48c0c0');
  assert.equal(sample.colors[1].hex, '#181818');
  assert.equal(sample.colors[0].share, 0.6);
  assert.equal(sample.colors[1].share, 0.4);

  // Shares are a fraction of counted pixels, and every denominator is stated.
  assert.equal(sample.total_pixels, 10000);
  assert.equal(sample.sampled_pixels, 10000);
  assert.equal(sample.counted_pixels, 10000);
  assert.equal(sample.transparent_pixels, 0);
  assert.equal(sample.stride, 1);
  assert.equal(sample.distinct_buckets, 2);
  assert.equal(sample.coverage, 1);
  assert.equal(sample.distribution, 'flat');
  assert.equal(sample.confident, true);
});

test('the reported hex is the members mean, not the bucket centre', () => {
  // #48c0c0 and #4ac2c2 are 2 units apart per channel and share a bucket at a
  // 16-unit step. A sampler reporting the lattice point would say #404040-ish;
  // this one must say the average of what it actually saw.
  const drifted = rgba(10, 10, (x) => (x < 5 ? [72, 192, 192, 255] : [74, 194, 194, 255]));
  const sample = dominantColors(drifted);

  assert.equal(sample.distinct_buckets, 1);
  assert.equal(sample.colors.length, 1);
  assert.equal(sample.colors[0].hex, '#49c1c1');
  assert.equal(sample.colors[0].share, 1);
});

test('dominant colours are emitted lowercase regardless of input', () => {
  const sample = dominantColors(TWO_COLOUR);
  for (const colour of sample.colors) {
    assert.equal(colour.hex, colour.hex.toLowerCase());
    assert.match(colour.hex, /^#[0-9a-f]{6}$/);
  }
});

test('a three-channel buffer is measured the same as a four-channel one', () => {
  const opaque = rgb(100, 100, (x) => (x < 60 ? TURQUOISE : INK));
  const sample = dominantColors(opaque);
  assert.equal(sample.colors[0].hex, '#48c0c0');
  assert.equal(sample.colors[0].share, 0.6);
  assert.equal(sample.counted_pixels, 10000);
});

test('pixels under the alpha floor are excluded from the denominator, not counted as a colour', () => {
  // Half the image is fully transparent turquoise. A sampler that counted it
  // would report a 50% share for a colour nobody can see.
  const halfClear = rgba(100, 100, (x) => {
    const [r, g, b] = TURQUOISE;
    return x < 50 ? [r, g, b, 255] : [r, g, b, 0];
  });
  const sample = dominantColors(halfClear);

  assert.equal(sample.transparent_pixels, 5000);
  assert.equal(sample.counted_pixels, 5000);
  assert.equal(sample.colors.length, 1);
  assert.equal(sample.colors[0].share, 1, 'share is of COUNTED pixels, not of the canvas');
  assert.equal(ALPHA_FLOOR, 128);
});

test('a fully transparent image reports "empty", never a colour or a zero', () => {
  const clear = rgba(20, 20, () => [72, 192, 192, 0]);
  const sample = dominantColors(clear);

  assert.equal(sample.distribution, 'empty');
  assert.equal(sample.colors.length, 0);
  assert.equal(sample.confident, false);
  assert.equal(sample.counted_pixels, 0);
  assert.match(sample.note, /not determined/);
});

test('a malformed buffer throws instead of being measured', () => {
  const short: PixelBuffer = { data: new Uint8Array(10), width: 4, height: 4, channels: 4 };
  assert.throws(() => dominantColors(short), /64/);

  assert.throws(
    () => dominantColors({ data: new Uint8Array(0), width: 0, height: 0, channels: 4 }),
    /positive integers/,
  );
});

test('maxColors truncates the list but never the denominator', () => {
  const four = rgba(100, 100, (x) => {
    if (x < 40) return [72, 192, 192, 255];
    if (x < 70) return [24, 24, 24, 255];
    if (x < 90) return [240, 240, 240, 255];
    return [216, 72, 0, 255];
  });

  const all = dominantColors(four);
  assert.equal(all.colors.length, 4);
  assert.equal(all.coverage, 1);

  const top2 = dominantColors(four, { maxColors: 2 });
  assert.equal(top2.colors.length, 2);
  assert.equal(top2.counted_pixels, 10000);
  assert.equal(Math.round(top2.coverage * 100) / 100, 0.7, 'coverage says how much was withheld');
  assert.equal(DEFAULT_MAX_COLORS, 6);
});

/* --------------------------------------------------- sampling honesty ---- */

test('stride is 1 below the cap and avoids locking onto a column', () => {
  assert.equal(strideFor(MAX_SAMPLED_PIXELS, 1024), 1);
  assert.equal(strideFor(MAX_SAMPLED_PIXELS + 1, 1023), 2);

  // 4096x4096: the natural stride of 256 divides the width, which would visit
  // the same 16 columns on every row. It must be bumped off that lock.
  const width = 4096;
  const natural = Math.ceil((width * width) / MAX_SAMPLED_PIXELS);
  assert.equal(width % natural, 0, 'fixture must actually trigger the hazard');
  assert.equal(strideFor(width * width, width), natural + 1);
  assert.notEqual((width * width) % strideFor(width * width, width), 0);
});

test('sampling is deterministic: the same buffer measures identically twice', () => {
  const first = dominantColors(PHOTOGRAPH);
  const second = dominantColors(PHOTOGRAPH);
  assert.deepEqual(first, second);
});

/* ------------------------------------- a photograph has no brand palette -- */

test('a photograph is classified continuous and low-confidence, not flat', () => {
  const sample = dominantColors(PHOTOGRAPH);

  assert.equal(sample.distribution, 'continuous');
  assert.equal(sample.confident, false);
  assert.ok(
    sample.distinct_buckets > CONCENTRATION_BUCKETS,
    `expected fragmentation, got ${sample.distinct_buckets} buckets`,
  );
  assert.ok(sample.coverage < 0.5, `top colours cover ${sample.coverage} of the image`);
  assert.match(sample.note, /photograph|gradient/);
});

test('a photograph gets a low-confidence verdict rather than a false brand match', () => {
  const sample = dominantColors(PHOTOGRAPH);
  const result = paletteMatch(sample, SWATCHES);

  assert.notEqual(result.match, null);
  assert.equal(result.match?.verdict, 'warn', 'a photograph is never graded pass or fail');
  assert.equal(result.law.passed, false);
  assert.equal(result.law.severity, 'warning', 'being a photograph is not a violation');
  assert.match(result.law.evidence, /photograph|gradient/);
});

test('the confidence gate is what holds the photograph back, not luck', () => {
  // Same colours, two distributions. Only the classification differs, so if the
  // continuous case still passed, the gate would be doing nothing.
  const colors: DominantColor[] = [
    { hex: '#48c0c0', share: 0.6 },
    { hex: '#993311', share: 0.4 },
  ];

  assert.equal(paletteMatch(measured(colors, 'flat'), SWATCHES).match?.verdict, 'pass');
  assert.equal(paletteMatch(measured(colors, 'continuous'), SWATCHES).match?.verdict, 'warn');
});

/* --------------------------------------------------- the Law verdicts ---- */

test('an off-brand hex fails the check, and the evidence names it', () => {
  // #48c0a2 is turquoise with the blue pulled down: closest swatch is turquoise
  // at 49.4, past the tolerance of 40, and nothing else is near.
  const result = paletteMatch(measured([{ hex: '#48c0a2', share: 1 }], 'flat'), SWATCHES);

  assert.equal(result.law.passed, false);
  assert.equal(result.law.severity, 'violation');
  assert.ok(result.law.evidence.includes('#48c0a2'), 'the offending hex must be named');
  assert.ok(result.law.evidence.includes('turquoise'), 'so must what it was closest to');
  assert.equal(result.match?.verdict, 'fail');
  assert.deepEqual(result.match?.matched, []);
  assert.equal(result.match?.unmatched.length, Object.keys(SWATCHES).length);
});

test('brand colour present but not leading is a warn, not a pass and not a fail', () => {
  const result = paletteMatch(
    measured(
      [
        { hex: '#993311', share: 0.7 },
        { hex: '#48c0c0', share: 0.3 },
      ],
      'flat',
    ),
    SWATCHES,
  );

  assert.equal(result.match?.verdict, 'warn');
  assert.deepEqual(result.match?.matched, ['turquoise']);
  assert.equal(result.law.severity, 'warning');
  assert.ok(result.law.evidence.includes('#993311'));
});

test('the largest colour matching a swatch is a pass', () => {
  const result = paletteMatch(
    measured(
      [
        { hex: '#48c0c0', share: 0.6 },
        { hex: '#181818', share: 0.4 },
      ],
      'flat',
    ),
    SWATCHES,
  );

  assert.equal(result.law.passed, true);
  assert.equal(result.match?.verdict, 'pass');
  assert.deepEqual(result.match?.matched, ['turquoise', 'ink']);
  assert.equal(result.match?.unmatched.includes('ember'), true);
});

test('matched and unmatched hold swatch NAMES, never hex values', () => {
  const result = paletteMatch(measured([{ hex: '#48c0c0', share: 1 }], 'flat'), SWATCHES);
  const names = [...(result.match?.matched ?? []), ...(result.match?.unmatched ?? [])];

  assert.equal(names.length, Object.keys(SWATCHES).length);
  for (const name of names) {
    assert.equal(name.startsWith('#'), false, `${name} looks like a hex`);
    assert.equal(Object.hasOwn(SWATCHES, name), true);
  }
});

test('the primary colour is taken by share, not by array position', () => {
  const outOfOrder = measured(
    [
      { hex: '#993311', share: 0.2 },
      { hex: '#48c0c0', share: 0.8 },
    ],
    'flat',
  );
  assert.equal(paletteMatch(outOfOrder, SWATCHES).match?.verdict, 'pass');
});

/* ------------------------------------------------- absence stays absent -- */

test('no recorded palette yields a warning and a null match, never a verdict', () => {
  for (const swatches of [null, undefined, {}]) {
    const result = paletteMatch(measured([{ hex: '#48c0c0', share: 1 }], 'flat'), swatches);
    assert.equal(result.match, null, 'no palette cannot produce a verdict');
    assert.equal(result.law.severity, 'warning', 'the gap is in our record, not in the image');
    assert.equal(result.law.passed, false);
  }
});

test('an unmeasured image is undetermined, not off-palette', () => {
  const empty = paletteMatch(measured([], 'empty'), SWATCHES);
  assert.equal(empty.match, null);
  assert.equal(empty.law.severity, 'warning');
  assert.match(empty.law.evidence, /undetermined/);

  // The real sampler's own empty output must travel the same road.
  const clear = dominantColors(rgba(8, 8, () => [1, 2, 3, 0]));
  assert.equal(paletteMatch(clear, SWATCHES).match, null);
});

test('unreadable swatches are named as unreadable rather than silently dropped', () => {
  const broken = paletteMatch(measured([{ hex: '#48c0c0', share: 1 }], 'flat'), {
    turquoise: 'turquoise-ish',
    ink: 'rgb(24,24,24)',
  });
  assert.equal(broken.match, null);
  assert.match(broken.law.evidence, /turquoise, ink/);
  assert.equal(broken.law.severity, 'warning');

  // One readable swatch is enough to proceed, but the bad one is still reported.
  const partial = paletteMatch(measured([{ hex: '#48c0c0', share: 1 }], 'flat'), {
    turquoise: '#48C0C0',
    ink: 'not a colour',
  });
  assert.equal(partial.match?.verdict, 'pass');
  assert.deepEqual(partial.law.detail?.unreadable, ['ink']);
  assert.deepEqual(partial.match?.unmatched, [], 'an unreadable swatch is not an unmatched one');
});

/* ------------------------------------------------ the tolerance itself --- */

test('the tolerance is below the closest pair in the real palette', () => {
  // This is the constant's whole justification, recomputed from the palette
  // rather than asserted. If a swatch is ever added closer to an existing one
  // than the tolerance, this goes red instead of the check quietly attributing
  // one brand colour to a different brand swatch.
  const names = Object.keys(SWATCHES) as (keyof typeof SWATCHES)[];
  let closest = Number.POSITIVE_INFINITY;
  let pair = '';

  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const distance = colorDistance(SWATCHES[names[i]], SWATCHES[names[j]]);
      assert.notEqual(distance, null);
      if (distance !== null && distance < closest) {
        closest = distance;
        pair = `${names[i]}/${names[j]}`;
      }
    }
  }

  assert.ok(
    NEAR_MATCH_MAX_DISTANCE < closest,
    `tolerance ${NEAR_MATCH_MAX_DISTANCE} must stay under the closest pair ${pair} at ${closest.toFixed(2)}`,
  );
});

test('near-match tolerance behaves on both sides of the threshold', () => {
  // Two colours one unit of blue apart, either side of the line from ink:
  //   #18182f -> ink at 39.18 (inside 40)
  //   #181830 -> ink at 40.89 (outside 40)
  // Neither is near any other swatch: charcoal, the runner-up, sits at ~59.5.
  const inside = colorDistance('#18182f', SWATCHES.ink);
  const outside = colorDistance('#181830', SWATCHES.ink);
  assert.notEqual(inside, null);
  assert.notEqual(outside, null);
  assert.ok(inside !== null && inside < NEAR_MATCH_MAX_DISTANCE);
  assert.ok(outside !== null && outside > NEAR_MATCH_MAX_DISTANCE);

  const matched = paletteMatch(measured([{ hex: '#18182f', share: 1 }], 'flat'), SWATCHES);
  assert.equal(matched.match?.verdict, 'pass');
  assert.deepEqual(matched.match?.matched, ['ink']);

  const rejected = paletteMatch(measured([{ hex: '#181830', share: 1 }], 'flat'), SWATCHES);
  assert.equal(rejected.match?.verdict, 'fail');
  assert.deepEqual(rejected.match?.matched, []);
  assert.ok(rejected.law.evidence.includes('#181830'));
  assert.ok(rejected.law.evidence.includes('ink'), 'name the swatch it just missed');
});

test('a colour is attributed to its nearest swatch, and the distance is inspectable', () => {
  const result = paletteMatch(measured([{ hex: '#18182f', share: 1 }], 'flat'), SWATCHES);
  const nearest = result.law.detail?.nearest;

  assert.ok(Array.isArray(nearest));
  assert.deepEqual(nearest[0], { hex: '#18182f', nearest: 'ink', swatch: 'ink', distance: 39.2 });
  assert.equal(result.law.detail?.tolerance, NEAR_MATCH_MAX_DISTANCE);
});

test('distance is symmetric and zero for identical colours', () => {
  assert.equal(colorDistance('#48c0c0', '#48c0c0'), 0);
  assert.equal(
    colorDistance(SWATCHES.turquoise, SWATCHES.ember),
    colorDistance(SWATCHES.ember, SWATCHES.turquoise),
  );
});

/* ---------------------------------------------------- hex casing & form -- */

test('hex comparison is case-insensitive in both directions', () => {
  // The palette is stored uppercase; the sampler emits lowercase. If casing
  // leaked into the comparison, every measured colour would be off-brand.
  assert.equal(colorDistance('#48c0c0', '#48C0C0'), 0);
  assert.equal(canonicalHex('#48C0C0'), '#48c0c0');
  assert.equal(canonicalHex('#48c0c0'), '#48c0c0');

  const lowerMeasured = paletteMatch(measured([{ hex: '#48c0c0', share: 1 }], 'flat'), SWATCHES);
  assert.equal(lowerMeasured.match?.verdict, 'pass');

  const upperMeasured = paletteMatch(measured([{ hex: '#48C0C0', share: 1 }], 'flat'), {
    turquoise: '#48c0c0',
  });
  assert.equal(upperMeasured.match?.verdict, 'pass');

  const mixed = paletteMatch(measured([{ hex: '#48C0c0', share: 1 }], 'flat'), {
    turquoise: '#48c0C0',
  });
  assert.equal(mixed.match?.verdict, 'pass');
});

test('shorthand hex expands the same way palette-claims expands it', () => {
  assert.equal(canonicalHex('#4CC'), '#44cccc');
  assert.equal(canonicalHex(' #4cc '), '#44cccc');

  const result = paletteMatch(measured([{ hex: '#44cccc', share: 1 }], 'flat'), { teal: '#4CC' });
  assert.equal(result.match?.verdict, 'pass');
  assert.deepEqual(result.match?.matched, ['teal']);
});

test('canonicalHex refuses anything that is not a whole colour', () => {
  // #48C0 is the trap: a prose scanner finds #48C inside it and reports a
  // colour that was never written. A swatch value is not prose.
  for (const bad of ['#48C0', '#48C0C', '#', '', 'turquoise', '48C0C0', '#GGGGGG', '#48C0C0 #181818']) {
    assert.equal(canonicalHex(bad), null, `${bad} must not parse as a colour`);
  }
  assert.equal(colorDistance('#48C0', '#48c0c0'), null);
});

/* --------------------------------------------------------- integration --- */

test('a ColorSample feeds paletteMatch directly, with no adapter', () => {
  // The compile-time half of this matters as much as the runtime half: if the
  // sampler's vocabulary drifts from what the Law accepts, this stops compiling.
  const sample: ColorSample = dominantColors(TWO_COLOUR);
  const asMeasured: MeasuredColors = sample;
  const result = paletteMatch(asMeasured, SWATCHES);

  assert.equal(result.match?.verdict, 'pass');
  assert.deepEqual(result.match?.matched, ['turquoise', 'ink']);
  assert.equal(shareOf(sample, '#48c0c0'), 0.6);
});

test('runLaw runs the check only when colours were actually measured', () => {
  const withoutColours = runLaw({ text: 'No colour named.', swatches: SWATCHES });
  assert.equal(
    withoutColours.results.some((r) => r.check === 'palette-match'),
    false,
    'an unmeasured post gets no check rather than a vacuous pass',
  );

  const withColours = runLaw({
    text: 'No colour named.',
    swatches: SWATCHES,
    measuredColors: dominantColors(TWO_COLOUR),
  });
  const results = withColours.results.filter((r) => r.check === 'palette-match');
  assert.equal(results.length, 1);
  assert.equal(results[0].passed, true);
  assert.equal(results[0].source, 'law');
  assert.equal(withColours.passed, true);
});

test('an off-palette image blocks through runLaw, a photograph does not', () => {
  const offPalette = runLaw({
    text: '',
    swatches: SWATCHES,
    measuredColors: measured([{ hex: '#48c0a2', share: 1 }], 'flat'),
  });
  assert.equal(offPalette.passed, false);
  assert.equal(offPalette.violations.some((r) => r.check === 'palette-match'), true);

  const photo = runLaw({
    text: '',
    swatches: SWATCHES,
    measuredColors: dominantColors(PHOTOGRAPH),
  });
  assert.equal(photo.passed, true, 'a warning never blocks');
  assert.equal(photo.warnings.some((r) => r.check === 'palette-match'), true);
});

/* -------------------------------------------------- exported constants --- */

test('the method parameters are exported so a quoted share can quote its settings', () => {
  assert.equal(QUANT_STEP, 16);
  assert.equal(CONCENTRATION_BUCKETS, 5);
  assert.equal(MAX_SAMPLED_PIXELS, 65536);
  assert.equal(toHex(71.5, 199.4, 0), '#48c700');
  assert.equal(toHex(-5, 300, 255), '#00ffff');
});
