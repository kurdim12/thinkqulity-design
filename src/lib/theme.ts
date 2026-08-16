import type { ThemeConfig } from 'antd';

/* ===========================================================================
 * THE DESIGN SYSTEM — one place, one definition per colour.
 *
 * The thesis of v6 is that everything in this product derives from the brand's
 * own data, INCLUDING the interface's colour. So the shell is disciplined
 * monochrome — paper, ink, one hairline — and the only chroma allowed is
 *
 *   1. the client's SAMPLED palette (the #48C0C0 family, measured out of their
 *      own images by src/lib/vision/colors.ts), in brand contexts only, and
 *   2. the grounding states, which carry ALL the semantic weight there is:
 *      data green, hypothesis amber, failure red. Nothing else is coloured.
 *
 * WHY THE TOKENS ARE A RECORD AND NOT A PILE OF CONSTANTS. The keys below are
 * the literal CSS custom-property names declared in src/app/globals.css between
 * its `tq-colour-tokens` markers, and tests/receipt-chip.test.ts reads that file
 * and asserts the two agree key for key and character for character. A colour
 * therefore cannot be defined twice: change one side and the suite fails, and
 * there is nowhere else in the tree a colour is allowed to come from. The named
 * exports below are views onto this record, not second copies of it.
 * ======================================================================== */

export const TOKENS = {
  /* -- the shell: paper, ink, one line, one muted voice ------------------- */
  '--tq-paper': '#F7F5F1',
  '--tq-surface': '#FFFDFA',
  '--tq-ink': '#17150F',
  '--tq-line': '#E7E2D9',
  '--tq-muted': '#8A8378',

  /* -- the client's sampled palette. Brand-context moments ONLY ----------- */
  '--tq-brand': '#48C0C0',
  '--tq-brand-light': '#78D8D8',
  /** The one member dark enough to carry text on paper. */
  '--tq-brand-ink': '#1F6E6E',

  /* -- grounding states. Reserved: nothing else may use these ------------- */
  '--tq-data': '#2E6B4F',
  '--tq-data-tint': '#EDF2ED',
  '--tq-data-line': '#CBDCCF',
  '--tq-hypothesis': '#8A5F0B',
  '--tq-hypothesis-tint': '#F6EFE0',
  '--tq-hypothesis-line': '#E6D5AF',
  '--tq-failure': '#9B2C1F',
  '--tq-failure-tint': '#F7EAE7',
  '--tq-failure-line': '#E6C6BF',

  /* -- the only transparencies. Named so nobody re-types an alpha --------- */
  '--tq-ink-06': 'rgba(23, 21, 15, 0.06)',
  '--tq-ink-55': 'rgba(23, 21, 15, 0.55)',
  '--tq-lift': 'rgba(23, 21, 15, 0.02)',
  '--tq-paper-10': 'rgba(247, 245, 241, 0.10)',
  '--tq-paper-62': 'rgba(247, 245, 241, 0.62)',
} as const;

export type TokenName = keyof typeof TOKENS;

export const PAPER = TOKENS['--tq-paper'];
export const SURFACE = TOKENS['--tq-surface'];
export const INK = TOKENS['--tq-ink'];
export const LINE = TOKENS['--tq-line'];
export const MUTED = TOKENS['--tq-muted'];
export const BRAND = TOKENS['--tq-brand'];
export const BRAND_INK = TOKENS['--tq-brand-ink'];
export const DATA = TOKENS['--tq-data'];
export const HYPOTHESIS = TOKENS['--tq-hypothesis'];
export const FAILURE = TOKENS['--tq-failure'];

/**
 * @deprecated v5 name. The studio's chrome is no longer charcoal-and-gold:
 * `CHARCOAL` is now `INK` and `GOLD` resolves to `MUTED`, because v6 reserves
 * every colour that is not paper or ink for the grounding states. Both stay
 * exported only so surfaces outside this change set still compile; each call
 * site is listed in the handover and should move to a token or to nothing.
 */
export const CHARCOAL = INK;
/** @deprecated See `CHARCOAL`. An accent rule is now a hairline, not a colour. */
export const GOLD = MUTED;

/* ===========================================================================
 * THE ANTD SKIN
 *
 * Keep antd's bones — its focus management, its portals, its RTL plumbing —
 * and replace its skin entirely. colorPrimary is INK, not the brand teal:
 * primary is a level of emphasis, and in this product emphasis is weight, not
 * hue. The brand teal reaches the screen only through `brandContextTheme`,
 * which a Brand surface opts into by nesting a ConfigProvider.
 * ======================================================================== */

export const studioTheme: ThemeConfig = {
  token: {
    colorPrimary: INK,
    colorInfo: INK,
    colorLink: INK,
    colorLinkHover: MUTED,
    colorTextBase: INK,
    colorBgLayout: PAPER,
    colorBgContainer: SURFACE,
    colorBorder: LINE,
    colorBorderSecondary: LINE,
    colorSuccess: DATA,
    colorWarning: HYPOTHESIS,
    colorError: FAILURE,
    borderRadius: 10,
    borderRadiusLG: 10,
    borderRadiusSM: 6,
    fontSize: 15,
    fontSizeSM: 13,
    fontSizeLG: 18,
    fontSizeHeading1: 48,
    fontSizeHeading2: 34,
    fontSizeHeading3: 24,
    fontSizeHeading4: 18,
    fontSizeHeading5: 15,
    lineHeight: 1.7,
    controlHeight: 36,
    // Almost none: one hairline, and a 2% lift where something rises.
    boxShadow: `0 1px 0 ${LINE}`,
    boxShadowSecondary: `0 2px 10px ${TOKENS['--tq-lift']}`,
    boxShadowTertiary: `0 1px 0 ${LINE}`,
    motionDurationFast: '0.14s',
    motionDurationMid: '0.24s',
    motionDurationSlow: '0.32s',
    wireframe: false,
  },
  components: {
    Layout: {
      headerBg: SURFACE,
      siderBg: INK,
      bodyBg: PAPER,
      headerHeight: 60,
    },
    Menu: {
      darkItemBg: INK,
      darkSubMenuItemBg: INK,
      darkItemColor: TOKENS['--tq-paper-62'],
      darkItemSelectedBg: TOKENS['--tq-paper-10'],
      darkItemSelectedColor: PAPER,
      darkItemHoverColor: PAPER,
    },
    Card: {
      headerFontSize: 15,
      headerHeight: 48,
      paddingLG: 24,
      colorBorderSecondary: LINE,
    },
    Statistic: {
      titleFontSize: 13,
      colorTextDescription: MUTED,
    },
    Table: {
      headerBg: 'transparent',
      headerColor: MUTED,
      borderColor: LINE,
      rowHoverBg: TOKENS['--tq-lift'],
    },
    Segmented: {
      trackBg: TOKENS['--tq-ink-06'],
      itemSelectedBg: SURFACE,
      itemSelectedColor: INK,
    },
    Tooltip: {
      colorBgSpotlight: INK,
      colorTextLightSolid: PAPER,
    },
    Popover: {
      colorBgElevated: SURFACE,
    },
    Button: {
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Alert: {
      colorInfoBg: TOKENS['--tq-ink-06'],
      colorInfoBorder: LINE,
      colorSuccessBg: TOKENS['--tq-data-tint'],
      colorSuccessBorder: TOKENS['--tq-data-line'],
      colorWarningBg: TOKENS['--tq-hypothesis-tint'],
      colorWarningBorder: TOKENS['--tq-hypothesis-line'],
      colorErrorBg: TOKENS['--tq-failure-tint'],
      colorErrorBorder: TOKENS['--tq-failure-line'],
    },
  },
};

/**
 * The ONLY way the client's teal reaches the interface. A Brand surface wraps
 * the part of itself that is genuinely about the brand in
 * `<ConfigProvider theme={brandContextTheme}>`; everything outside stays
 * monochrome. Scoping it to a nested provider rather than the root is what
 * keeps "brand-context moments only" enforceable instead of aspirational.
 */
export const brandContextTheme: ThemeConfig = {
  token: {
    colorPrimary: BRAND_INK,
    colorLink: BRAND_INK,
  },
};

/* ===========================================================================
 * THE RECEIPT — the rule that decides whether a number may wear one.
 *
 * WHY THIS LIVES HERE AND NOT IN ReceiptChip.tsx. It is a rule, not a render:
 * it is pure, it has no React in it, and it is the one piece of the chip that
 * must be TESTED rather than eyeballed. `node --test --experimental-strip-types`
 * cannot load a `.tsx` file at all, so logic that lives beside JSX is logic
 * that ships unverified. It sits in the design system because it IS part of the
 * design system: "what may be shown as a receipt" is a visual contract with the
 * reader, in exactly the way a colour token is.
 *
 * The contract, in one line: A CHIP IS A PROMISE THAT THE NUMBER HAS A HOME.
 * A chip that opens an empty popover is worse than no chip — it teaches the
 * reader that the dotted underline means nothing. So the resolution below has
 * three outcomes and no fourth, and two of them are not chips.
 * ======================================================================== */

export const EM_DASH = '—';
const EN_DASH = '–';

/** Every figure in the product carries `tq-num`: tabular, LTR-isolated. */
export const FIGURE_CLASS = 'tq-num';
export const RECEIPT_FIGURE_CLASS = 'tq-num tq-receipt-figure';
export const ABSENT_FIGURE_CLASS = 'tq-num tq-receipt-absent';

export interface ReceiptInput {
  /**
   * The value as it was measured, VERBATIM. A string, never a number — the same
   * reason `BasisRef.value` in src/lib/types/db.ts is a string: nothing between
   * the measurement and the screen is allowed to round, rescale, group or
   * re-localise it. Absent means absent; it never means zero (hard rule 2).
   */
  value: string | null | undefined;
  /** The key the value was filed under. Without one there is no receipt. */
  sourceKey?: string | null;
  /** Sample size. Computed in code, never typed by a model. */
  n?: number | null;
  /** When the measurement was taken, as stored. */
  computedAt?: string | null;
  /** What the measure is, in the reader's words. */
  label?: string | null;
  /** The row's home surface, so the reader can go and look. */
  href?: string | null;
}

/**
 * What the component renders. `dir` and `className` travel WITH the resolution
 * rather than being applied by the component, so there is exactly one code path
 * that can put a figure on screen and it is the one the tests read: an RTL
 * isolation failure becomes a test failure instead of a screenshot review.
 */
export interface ReceiptFigure {
  /** Exactly the text that will be displayed. Never derived from anything else. */
  text: string;
  className: string;
  dir: 'ltr';
}

export type ReceiptResolution =
  /** Has a key: underline it, and let the reader open the receipt. */
  | {
      kind: 'receipt';
      figure: ReceiptFigure;
      sourceKey: string;
      /** Display-ready. `EM_DASH` when there is no honest sample size. */
      n: string;
      /** Display-ready. `EM_DASH` when the measurement is undated. */
      computedAt: string;
      label: string | null;
      href: string | null;
    }
  /** A real value with no key: it is text, not evidence. No underline. */
  | { kind: 'plain'; figure: ReceiptFigure }
  /** Nothing was measured. An em-dash, and never a zero. */
  | { kind: 'absent'; figure: ReceiptFigure };

/** Trimmed, or null when there is nothing there. Never returns an empty string. */
function present(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A sample size is a whole count of things that were looked at. Anything that
 * is not one — a fraction, a negative, NaN, Infinity — is not a smaller n, it
 * is a broken n, and the honest rendering of a broken n is an em-dash. Zero IS
 * valid and prints as "0": "we looked at none of them" is a real answer.
 */
function sampleSize(n: number | null | undefined): string {
  if (typeof n !== 'number') return EM_DASH;
  if (!Number.isInteger(n) || n < 0) return EM_DASH;
  return String(n);
}

export function resolveReceipt(input: ReceiptInput): ReceiptResolution {
  const value = present(input.value);

  // An absence that already rendered as a dash is still an absence. Re-chipping
  // it would put a receipt on the word "unknown".
  if (value === null || value === EM_DASH || value === EN_DASH) {
    return { kind: 'absent', figure: { text: EM_DASH, className: ABSENT_FIGURE_CLASS, dir: 'ltr' } };
  }

  const sourceKey = present(input.sourceKey);
  if (sourceKey === null) {
    return { kind: 'plain', figure: { text: value, className: FIGURE_CLASS, dir: 'ltr' } };
  }

  return {
    kind: 'receipt',
    figure: { text: value, className: RECEIPT_FIGURE_CLASS, dir: 'ltr' },
    sourceKey,
    n: sampleSize(input.n),
    computedAt: present(input.computedAt) ?? EM_DASH,
    label: present(input.label),
    href: present(input.href),
  };
}
