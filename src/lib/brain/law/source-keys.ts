import { fail, normaliseDigits, pass, type LawResult } from './types.ts';

/**
 * Law: every cited number is a number somebody measured.
 *
 * ===========================================================================
 * WHAT THIS CHECK IS FOR
 * ===========================================================================
 * The strategist prompt says "never state a number that is not verbatim from a
 * source_key in your blocks". A prompt asks. This file enforces — deterministic,
 * pure, no model, no argument. It closes the two gaps a prompt cannot:
 *
 *   1. THE INVENTED CITATION. A model that wants a key badly enough will write
 *      one that sounds right (`performance.reels.growth`). The claim then
 *      arrives wearing a receipt, which is strictly worse than arriving with
 *      none: an uncited claim gets read sceptically, a falsely-cited one does
 *      not. So a key that the blocks did not emit is a violation, always.
 *
 *   2. SILENT ARITHMETIC. This is the failure this check exists for. Give a
 *      model 508 and 40 under two honest keys and it will helpfully report
 *      "12.7x" — a number nobody measured, assembled from two that were, and
 *      therefore impossible to audit and impossible to reproduce next week.
 *      There is no prompt wording that reliably stops this and no way to spot
 *      it by reading the sentence, because the sentence looks *better* than the
 *      honest one. It is caught here instead, structurally: a quoted value must
 *      appear in the blocks CHARACTER FOR CHARACTER under the key it is filed
 *      against. 12.7 is not in the blocks, so 12.7 does not ship. If the ratio
 *      is worth stating, code computes it and it gets a key of its own.
 *
 * ===========================================================================
 * WHY "UNDER THAT KEY" AND NOT "ANYWHERE IN THE BLOCKS"
 * ===========================================================================
 * BasisRef in src/lib/types/db.ts states the contract this implements: the
 * value "must equal, character for character, the value rendered under
 * `source_key`". Matching loosely against the whole document would let a real
 * value be filed under the wrong key — the academy's average cited as the
 * personal account's — which is a true number attached to a false claim, and
 * the reader has no way to catch it. The key is part of the assertion, so the
 * key is part of the check.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY NOT A VIOLATION
 * ===========================================================================
 * A statement with `grounding: 'hypothesis'` and an EMPTY basis passes, and
 * this is by design — do not "fix" it later. A hypothesis honestly labelled as
 * one is the escape hatch that makes the whole rule survivable: without it, a
 * model forbidden to speak uncited would start inventing citations to say
 * anything at all, which is the exact failure in (1). Hard rule 3 asks every
 * claim to carry its grounding, not every claim to carry evidence. What is NOT
 * excused is a hypothesis that cites something: a fabricated key is a violation
 * whatever grounding the sentence wears.
 *
 * `grounding: 'data'` with an empty basis is a violation — that is a claim
 * calling itself measured while naming no measurement.
 *
 * ===========================================================================
 * PURITY
 * ===========================================================================
 * Everything here is a pure function of its arguments: no database, no network,
 * no model, no clock, no environment. Inputs are plain data — the citations,
 * the key set the blocks emitted, and the rendered blocks themselves — so the
 * Law layer stays independent of the agent layer that produces them. Callers
 * pass `collectSourceKeys(data)` and `renderStrategistBlocks(data)` from
 * src/lib/agent/strategist/blocks.ts, which are built from the same block list
 * and therefore cannot disagree with each other.
 */

/** Mirrors `Grounding` in src/lib/types/db.ts, structurally, to keep Law free of app types. */
export type ClaimGrounding = 'data' | 'hypothesis';

/** Mirrors `BasisRef`: the key of a rendered value, and that value as text. */
export interface BasisLike {
  source_key: string;
  value: string;
}

/**
 * One statement from the payload with its citations attached.
 *
 * `where` is a human-readable path — `wins[0]`, `decisions[2].basis` — and
 * exists only so a violation can point at the offending statement instead of
 * saying "somewhere in the payload". Flattening a `StrategistPayload` into
 * these belongs to the caller, not here: the Law layer takes plain data so it
 * never has to track a payload shape.
 */
export interface CitedClaim {
  where: string;
  grounding: ClaimGrounding;
  basis: readonly BasisLike[];
}

export interface SourceKeysInput {
  /** Every statement in the payload that carries a grounding. */
  claims: readonly CitedClaim[];
  /** Every key the blocks emitted — `collectSourceKeys(data)`. */
  emitted: Iterable<string>;
  /** The blocks exactly as the agent read them — `renderStrategistBlocks(data)`. */
  blocks: string;
}

/**
 * The inverse of `renderMeasure()` in blocks.ts, which writes
 * `[key] label (n=…, as_of=…) = "value"` with the value through
 * `JSON.stringify`. The lazy prefix plus the `$` anchor means the LAST
 * `= "…"` on the line is the value, so a label containing quotes — and there
 * are several — cannot be mistaken for one. An absence line begins with
 * `(no measurement)` and never matches, which is the point: it has no key and
 * no value to cite.
 */
const MEASURE_LINE = /^\[([^\]]+)\].*?= ("(?:[^"\\]|\\.)*")$/;

/** JSON string → text. Returns null rather than throwing: Law never throws on hostile input. */
function decodeValue(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Every keyed value the blocks actually rendered, by key. A list per key rather
 * than a single value because a duplicated key must not silently shadow one of
 * its two meanings — if it ever happened, both would have to be honoured here.
 */
export function parseRenderedMeasures(blocks: string): Map<string, string[]> {
  const rendered = new Map<string, string[]>();

  for (const line of blocks.split(/\r?\n/)) {
    const match = MEASURE_LINE.exec(line);
    if (!match) continue;
    const value = decodeValue(match[2]);
    if (value === null) continue;
    const existing = rendered.get(match[1]);
    if (existing) existing.push(value);
    else rendered.set(match[1], [value]);
  }

  return rendered;
}

interface AlteredValue {
  where: string;
  key: string;
  quoted: string;
  /** What the blocks say under that key, or null when the key rendered nothing. */
  rendered: string | null;
}

/** Digits normalised so «٥٠٨» and "508" are the same figure. Nothing else is touched. */
function comparable(value: string): string {
  return normaliseDigits(value);
}

export function sourceKeys(input: SourceKeysInput): LawResult {
  const emitted = new Set(input.emitted);
  const rendered = parseRenderedMeasures(input.blocks);

  const anywhere = new Set<string>();
  for (const values of rendered.values()) {
    for (const value of values) anywhere.add(comparable(value));
  }

  const refs = input.claims.flatMap((claim) =>
    claim.basis.map((ref) => ({ where: claim.where, ref })),
  );

  /* -- a) a citation must name a key the blocks emitted -------------------- */

  const invented = refs.filter(({ ref }) => !emitted.has(ref.source_key));
  if (invented.length > 0) {
    const list = invented.map(({ where, ref }) => `${where} → "${ref.source_key}"`).join('; ');
    return fail(
      'source-keys',
      `${invented.length} citation(s) name a source key the context blocks never emitted: ${list}. ` +
        'A fabricated citation is worse than an uncited claim — either the key was invented, or it ' +
        'names something that was not measured and therefore has no value to quote.',
      'violation',
      { invented: [...new Set(invented.map(({ ref }) => ref.source_key))], citations: refs.length },
    );
  }

  /* -- b) a cited value must be the value the blocks rendered -------------- */

  const altered: AlteredValue[] = refs.flatMap(({ where, ref }): AlteredValue[] => {
    const quoted = comparable(ref.value);
    const under = rendered.get(ref.source_key);

    if (under !== undefined) {
      if (under.some((value) => comparable(value) === quoted)) return [];
      return [{ where, key: ref.source_key, quoted: ref.value, rendered: under[0] }];
    }
    // The key resolved but no line carries it: fall back to the whole document
    // rather than reporting a value error for what is really a blocks mismatch.
    if (anywhere.has(quoted)) return [];
    return [{ where, key: ref.source_key, quoted: ref.value, rendered: null }];
  });

  if (altered.length > 0) {
    const list = altered
      .map((item) =>
        item.rendered === null
          ? `${item.where} [${item.key}] quoted "${item.quoted}", which appears nowhere in the blocks`
          : `${item.where} [${item.key}] quoted "${item.quoted}", blocks say "${item.rendered}"`,
      )
      .join('; ');
    return fail(
      'source-keys',
      `${altered.length} cited value(s) are not what the blocks say under that key: ${list}. ` +
        'A figure that is not in the blocks is a figure the agent computed, and no computed figure ' +
        'may be stated — ask for it as its own measurement instead.',
      'violation',
      {
        altered: altered.map((item) => ({ where: item.where, key: item.key, quoted: item.quoted })),
        citations: refs.length,
      },
    );
  }

  /* -- c) a claim calling itself measured must name a measurement ---------- */

  const uncited = input.claims.filter(
    (claim) => claim.grounding === 'data' && claim.basis.length === 0,
  );
  if (uncited.length > 0) {
    const list = uncited.map((claim) => claim.where).join(', ');
    return fail(
      'source-keys',
      `${uncited.length} statement(s) are marked grounding "data" but cite nothing: ${list}. ` +
        'Either attach the source key it rests on, or label it a hypothesis and say so out loud.',
      'violation',
      { uncited: uncited.map((claim) => claim.where) },
    );
  }

  /* -- pass ---------------------------------------------------------------- */

  const hypotheses = input.claims.filter((claim) => claim.grounding === 'hypothesis').length;

  if (input.claims.length === 0) {
    return pass('source-keys', 'No claim was made, so nothing needed a source.', {
      citations: 0,
      claims: 0,
    });
  }

  if (refs.length === 0) {
    return pass(
      'source-keys',
      `${input.claims.length} statement(s), none citing a measurement and none claiming to be data.`,
      { citations: 0, claims: input.claims.length, hypotheses },
    );
  }

  return pass(
    'source-keys',
    `All ${refs.length} citation(s) across ${input.claims.length} statement(s) resolve to a key the ` +
      'blocks emitted and quote its value verbatim.',
    { citations: refs.length, claims: input.claims.length, hypotheses },
  );
}
