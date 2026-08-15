import { fail, pass, type LawResult } from './types.ts';
import { paletteClaims } from './palette-claims.ts';
import type { DominantColor, PaletteMatch, PaletteVerdict } from '../../types/db.ts';

/**
 * Is the image on-palette? Decided by arithmetic, not by a model.
 *
 * `paletteClaims` polices what the model SAYS about colour. This polices what
 * an image IS: the colours counted out of it by src/lib/vision/colors.ts,
 * checked against the brand's sampled swatches. Same family, opposite subject,
 * so the two must never disagree about what "on-palette" means — hence the one
 * normaliser rule below.
 *
 * Law discipline holds: pure, no model, no I/O, no environment, explicit `.ts`
 * imports. The two imports outside this directory are TYPE-ONLY and therefore
 * erased entirely, both by tsc and by node's type stripping, so nothing new
 * executes when this module loads. They are imported rather than restated
 * because `PaletteMatch` is the shape the database column already holds; a
 * second local copy of it could drift from the column it is written into,
 * which is exactly the failure this check exists to prevent elsewhere.
 */

/**
 * How far apart two colours may be and still count as the same swatch.
 *
 * Not a magic number and not a taste call — it is bounded from above by the
 * palette itself. The two closest DIFFERENT swatches in the recorded palette
 * (turquoise/sky, and turquoise_light/mint) sit 53.64 apart on the distance
 * function below. A tolerance at or above that would let one brand colour be
 * "matched" by a different brand colour, turning the check into a coin toss
 * between adjacent swatches. 40 sits clearly under that ceiling — roughly
 * three quarters of it — leaving room for the small per-channel drift that
 * re-encoding and rescaling introduce without ever reaching the next swatch.
 *
 * That ceiling is not an assertion here: tests/colors.test.ts recomputes the
 * closest pair from the real palette and fails if this constant is not below
 * it. Add a swatch nearer to an existing one and the test goes red rather than
 * this check silently mis-attributing colours.
 */
export const NEAR_MATCH_MAX_DISTANCE = 40;

/**
 * Canonical `#rrggbb`, produced by the SAME expansion `paletteClaims` uses.
 *
 * palette-claims.ts keeps its `expand()` module-private and that file is not in
 * this change's scope, so rather than write a second expander that could drift
 * from it, this routes the value through `paletteClaims` and reads back the hex
 * it recognised. One expander, one notion of colour equality, in both checks.
 *
 * The shape guard in front of it is not a second expander: `paletteClaims`
 * SCANS prose, so it will happily find `#48C` inside the malformed `#48C0` and
 * report a colour that was never written. A swatch value is not prose — it is
 * required to be a whole colour and nothing else before delegation.
 *
 * Returns null for anything that is not a colour, so an unreadable swatch is
 * reported as unreadable instead of being guessed at.
 */
export function canonicalHex(value: string): string | null {
  const trimmed = value.trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) return null;

  const claimed = paletteClaims(trimmed, null).detail?.claimed;
  if (!Array.isArray(claimed) || claimed.length !== 1) return null;

  const first: unknown = claimed[0];
  return typeof first === 'string' ? first : null;
}

function toRgb(canonical: string): [number, number, number] {
  return [
    parseInt(canonical.slice(1, 3), 16),
    parseInt(canonical.slice(3, 5), 16),
    parseInt(canonical.slice(5, 7), 16),
  ];
}

/**
 * Distance between two colours, on the "redmean" weighted-sRGB approximation.
 *
 *   d = sqrt( (2 + r/256)*dR^2 + 4*dG^2 + (2 + (255-r)/256)*dB^2 ),  r = mean red
 *
 * Plain Euclidean sRGB would be simpler and wrong in a way that matters here:
 * it treats a step of green as costing the same as a step of blue, so a check
 * built on it is stricter about colours the eye barely separates and slacker
 * about ones it separates easily. Redmean is the cheapest correction to that
 * which stays pure integer-in, float-out arithmetic — no colour-space
 * conversion, no lookup tables, no dependency, and identical on every machine.
 * It is an approximation and is called one; the threshold above is set with
 * that looseness assumed, which is why it is anchored to the palette's own
 * spacing rather than to any claim about perceptibility.
 *
 * Returns null when either argument is not a colour, never a number that would
 * be indistinguishable from a real distance.
 */
export function colorDistance(a: string, b: string): number | null {
  const left = canonicalHex(a);
  const right = canonicalHex(b);
  if (left === null || right === null) return null;

  const [r1, g1, b1] = toRgb(left);
  const [r2, g2, b2] = toRgb(right);

  const meanRed = (r1 + r2) / 2;
  const dR = r1 - r2;
  const dG = g1 - g2;
  const dB = b1 - b2;

  return Math.sqrt(
    (2 + meanRed / 256) * dR * dR + 4 * dG * dG + (2 + (255 - meanRed) / 256) * dB * dB,
  );
}

/**
 * What this check needs from a colour measurement.
 *
 * Structural on purpose, exactly as `FrameLike` is: a `ColorSample` from
 * src/lib/vision/colors.ts satisfies it as-is, while the Law keeps its promise
 * of importing nothing that could grow an I/O path underneath it. If the
 * sampler ever changes the vocabulary of `distribution`, the assignment stops
 * compiling instead of quietly degrading to a default — tests/colors.test.ts
 * makes that coupling explicit by feeding a real sample straight in.
 */
export interface MeasuredColors {
  /** Largest share first; hex in any case, shorthand or full. */
  colors: DominantColor[];
  distribution: 'flat' | 'mixed' | 'continuous' | 'empty';
  /** Share of counted pixels the listed colours account for, 0-1. */
  coverage: number;
}

export interface PaletteMatchResult {
  law: LawResult;
  /**
   * Null when there was nothing to compare — no palette recorded, or no colour
   * measured. A verdict invented over an absent input would be a fabricated
   * finding, so absence stays absent (hard rule 2).
   */
  match: PaletteMatch | null;
}

interface Nearest {
  hex: string;
  /** Closest swatch by distance, whether or not it is within tolerance. */
  nearest: string | null;
  /**
   * The swatch this colour is ATTRIBUTED to — null when the closest one is
   * further away than the tolerance. Kept separate from `nearest` so a failing
   * colour can still say what it was closest to and by how much, which is the
   * difference between "off-palette" and a usable finding.
   */
  swatch: string | null;
  distance: number | null;
}

const CHECK = 'palette-match';

/** Names the colour, what it was closest to, and by how much — or says it is unreadable. */
function describeNearest(entry: Nearest): string {
  if (entry.nearest === null || entry.distance === null) {
    return `${entry.hex} (unreadable as a colour)`;
  }
  return `${entry.hex} (nearest ${entry.nearest} at ${entry.distance})`;
}

/**
 * Check an image's counted colours against the brand's swatches.
 *
 * Verdicts follow the definition `PaletteMatch` already carries in db.ts —
 * 'warn' is a real middle answer, "some brand colour present but not the
 * primary", and is not rounded to either side:
 *
 *   fail  no measured colour is within tolerance of any swatch
 *   warn  a swatch is used, but the image's LARGEST colour is not one
 *   pass  the largest colour is a brand swatch
 *
 * With one override that outranks all three: a 'continuous' image — a
 * photograph or a full-frame gradient — cannot be graded. Its dominant colours
 * are lighting and subject, not design decisions, and they will sometimes land
 * near a brand swatch by accident. Such an image gets 'warn' and a WARNING,
 * never a pass it did not earn and never a violation for being a photograph.
 * Failing a portrait for not being turquoise would be the check misreading its
 * own subject.
 *
 * Severity mirrors that: only a real off-palette graphic is a violation. Every
 * "cannot tell" outcome is a warning, so an unmeasurable image never blocks,
 * on the same principle that makes register-score a warning by design.
 */
export function paletteMatch(
  measured: MeasuredColors,
  swatches: Record<string, string> | null | undefined,
): PaletteMatchResult {
  const entries = Object.entries(swatches ?? {});

  if (entries.length === 0) {
    return {
      law: fail(
        CHECK,
        'No brand palette is recorded, so the image cannot be checked against one. Unlike an invented hex in generated text, an image the client already published is not at fault here — the gap is in our record of the brand.',
        'warning',
        { measured: measured.colors.map((c) => c.hex), swatches: 0 },
      ),
      match: null,
    };
  }

  const readable: { name: string; hex: string }[] = [];
  const unreadable: string[] = [];
  for (const [name, value] of entries) {
    const hex = canonicalHex(value);
    if (hex === null) unreadable.push(name);
    else readable.push({ name, hex });
  }

  if (readable.length === 0) {
    return {
      law: fail(
        CHECK,
        `Every recorded swatch (${unreadable.join(', ')}) is unreadable as a colour, so there is nothing to compare against.`,
        'warning',
        { unreadable },
      ),
      match: null,
    };
  }

  if (measured.colors.length === 0 || measured.distribution === 'empty') {
    return {
      law: fail(
        CHECK,
        'No colour was measured from this image, so it is undetermined rather than off-palette.',
        'warning',
        { distribution: measured.distribution, unreadable },
      ),
      match: null,
    };
  }

  // Every measured colour is attributed to its NEAREST swatch, not to the first
  // one within tolerance. With a tolerance below the palette's own spacing at
  // most one swatch can ever be in range, but "nearest" is what the sentence
  // means and it stays correct if that spacing ever narrows.
  const nearest: Nearest[] = measured.colors.map((colour) => {
    let bestName: string | null = null;
    let bestDistance: number | null = null;

    for (const swatch of readable) {
      const distance = colorDistance(colour.hex, swatch.hex);
      if (distance === null) continue;
      if (bestDistance === null || distance < bestDistance) {
        bestDistance = distance;
        bestName = swatch.name;
      }
    }

    const withinTolerance = bestDistance !== null && bestDistance <= NEAR_MATCH_MAX_DISTANCE;
    return {
      hex: colour.hex,
      nearest: bestName,
      swatch: withinTolerance ? bestName : null,
      distance: bestDistance === null ? null : Math.round(bestDistance * 10) / 10,
    };
  });

  const hitNames = new Set(
    nearest.map((n) => n.swatch).filter((name): name is string => name !== null),
  );
  // Declaration order, so two images of the same brand list swatches the same way.
  const matched = readable.map((s) => s.name).filter((name) => hitNames.has(name));
  const unmatched = readable.map((s) => s.name).filter((name) => !hitNames.has(name));
  const offending = nearest.filter((n) => n.swatch === null).map((n) => n.hex);

  // The largest share, taken by comparison rather than by trusting the order —
  // `colors` is documented as share-ranked, and this does not need it to be.
  const primary = measured.colors.reduce((best, colour) =>
    colour.share > best.share ? colour : best,
  );
  const primaryEntry = nearest.find((n) => n.hex === primary.hex);
  const primaryMatched = primaryEntry !== undefined && primaryEntry.swatch !== null;

  const detail: Record<string, unknown> = {
    matched,
    unmatched,
    offending,
    nearest,
    primary: primary.hex,
    distribution: measured.distribution,
    coverage: measured.coverage,
    tolerance: NEAR_MATCH_MAX_DISTANCE,
    ...(unreadable.length > 0 ? { unreadable } : {}),
  };

  if (measured.distribution === 'continuous') {
    const verdict: PaletteVerdict = 'warn';
    return {
      law: fail(
        CHECK,
        `Colour is spread too thinly across this image to read as a palette — it looks like a photograph or a full-frame gradient, where dominant colours are lighting and subject rather than design choices. ${matched.length > 0 ? `${matched.join(', ')} happen to fall within ${NEAR_MATCH_MAX_DISTANCE} of a measured colour, but that is proximity, not a brand decision, and is not scored as one.` : 'No brand swatch is nearby either way.'} Verdict held at "warn".`,
        'warning',
        { ...detail, verdict },
      ),
      match: { matched, unmatched, verdict },
    };
  }

  if (matched.length === 0) {
    const verdict: PaletteVerdict = 'fail';
    return {
      law: fail(
        CHECK,
        `None of the image's dominant colours is a brand swatch. Off-palette: ${nearest.map(describeNearest).join(', ')}. Tolerance is ${NEAR_MATCH_MAX_DISTANCE}.`,
        'violation',
        { ...detail, verdict },
      ),
      match: { matched, unmatched, verdict },
    };
  }

  if (!primaryMatched) {
    const verdict: PaletteVerdict = 'warn';
    return {
      law: fail(
        CHECK,
        `The image uses ${matched.join(', ')}, but its largest colour ${primary.hex} (${Math.round(primary.share * 100)}% of counted pixels) is not a brand swatch. Brand colour is present, just not leading.`,
        'warning',
        { ...detail, verdict },
      ),
      match: { matched, unmatched, verdict },
    };
  }

  const verdict: PaletteVerdict = 'pass';
  return {
    law: pass(
      CHECK,
      `Largest colour ${primary.hex} is ${primaryEntry?.swatch ?? matched[0]}; ${matched.length} of ${readable.length} swatch(es) present${offending.length > 0 ? `, alongside off-palette ${offending.join(', ')}` : ''}.`,
      { ...detail, verdict },
    ),
    match: { matched, unmatched, verdict },
  };
}
