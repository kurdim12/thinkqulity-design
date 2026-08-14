import { fail, pass, type LawResult } from './types.ts';

const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g;

function expand(hex: string): string {
  const body = hex.slice(1).toLowerCase();
  if (body.length !== 3) return `#${body}`;
  return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
}

/**
 * Any colour the output names must be a colour the brand actually owns.
 *
 * This is the check that catches the most common and most embarrassing
 * failure: a model inventing a plausible hex for a client who has a sampled,
 * evidenced palette. Shorthand (#4CC) is expanded before comparison so
 * equivalent notations don't read as violations.
 */
export function paletteClaims(
  text: string,
  swatches: Record<string, string> | null | undefined,
): LawResult {
  const found = [...new Set((text.match(HEX) ?? []).map(expand))];

  if (found.length === 0) {
    return pass('palette-claims', 'No colour values claimed.');
  }

  if (!swatches || Object.keys(swatches).length === 0) {
    return fail(
      'palette-claims',
      `Output names ${found.length} colour(s) — ${found.join(', ')} — but the brand has no palette recorded, so none of them can be verified.`,
      'violation',
      { claimed: found, allowed: [] },
    );
  }

  const allowed = new Set(Object.values(swatches).map((v) => expand(v.trim())));
  const offending = found.filter((hex) => !allowed.has(hex));

  if (offending.length > 0) {
    return fail(
      'palette-claims',
      `${offending.join(', ')} ${offending.length === 1 ? 'is' : 'are'} not in the brand palette. Allowed: ${[...allowed].join(', ')}.`,
      'violation',
      { claimed: found, offending, allowed: [...allowed] },
    );
  }

  return pass('palette-claims', `All ${found.length} colour reference(s) exist in the palette.`, {
    claimed: found,
  });
}

/** Storyboard frames reference palette entries by NAME, not by hex. */
export function paletteRefs(
  refs: (string | null | undefined)[],
  swatches: Record<string, string> | null | undefined,
): LawResult {
  const named = refs.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  if (named.length === 0) return pass('palette-refs', 'No palette references used.');

  const allowed = new Set(Object.keys(swatches ?? {}).map((k) => k.toLowerCase()));
  if (allowed.size === 0) {
    return fail(
      'palette-refs',
      `Frames reference ${named.length} palette name(s) but the brand has no palette recorded.`,
      'violation',
      { referenced: named },
    );
  }

  const offending = [...new Set(named.filter((r) => !allowed.has(r.trim().toLowerCase())))];
  if (offending.length > 0) {
    return fail(
      'palette-refs',
      `Unknown palette name(s): ${offending.join(', ')}. Available: ${[...allowed].join(', ')}.`,
      'violation',
      { referenced: named, offending, allowed: [...allowed] },
    );
  }

  return pass('palette-refs', `All ${named.length} palette reference(s) resolve.`);
}
