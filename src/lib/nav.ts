import { dict, type Locale } from './i18n/dict.ts';

/**
 * THE FIVE SURFACES, AND WHERE EVERYTHING ELSE WENT.
 *
 * v6 cuts the left nav from fifteen entries to five. This module is the single
 * place that says which five, what every other screen is still called, and
 * where a URL that no longer has a screen now lands.
 *
 * It holds no JSX so `node --test --experimental-strip-types` can load it. That
 * is the whole reason the nav lives here and not inside Shell.tsx: the cut is
 * then a tested fact rather than a rendering detail. tests/nav.test.ts reads
 * src/app/(app) off disk and fails if a screen exists that this file does not
 * classify — which is what stops the sprawl coming back one route at a time.
 *
 * Every route is in exactly one of three states:
 *
 *   NAV      the five. In the sidebar.
 *   DEMOTED  live, callable, linked to and dispatched to — but not in the
 *            sidebar. Demoted is not deleted: an operator's bookmark, a link
 *            inside a stored digest, and the chat's dispatch targets all still
 *            resolve to the real screen.
 *   MOVED    the URL survives, the screen does not. Its page.tsx is a redirect
 *            stub that reads its destination from MOVED below, so the map and
 *            the redirect cannot drift apart.
 */

export interface Surface {
  /** Route path, exactly as it appears under src/app/(app)/. */
  readonly key: string;
  readonly ar: string;
  readonly en: string;
}

/**
 * The five, in reading order. Chat is first because it is the way into every
 * other screen — it answers from the same data and dispatches to the same
 * features — and because the four that follow are the four things it answers
 * about: the account, the brand, the strategy, the data underneath.
 */
export const NAV_KEYS = ['/chat', '/board', '/brand', '/digest', '/data'] as const;

export type NavKey = (typeof NAV_KEYS)[number];

export interface NavSurface extends Surface {
  readonly key: NavKey;
}

/**
 * These five labels are written here rather than read from dict.ts, and that is
 * deliberate on both sides.
 *
 * The Arabic is the operator's own register — البراند and الداتا, not the
 * dictionary's عقل العلامة and البيانات. He says the loanwords; the interface
 * should not correct him into a formality he does not use. The English is one
 * word per surface for the same reason: "Brand Brain" and "Weekly digest" were
 * descriptions of features, and a nav entry is a place, not a description.
 *
 * dict.ts keeps its longer nav strings because the demoted screens below still
 * use them for their own headers, and because it is shared with other work in
 * flight. Nothing is defined twice: a surface's title comes from exactly one
 * of these two lists.
 */
export const NAV: readonly NavSurface[] = [
  { key: '/chat', ar: 'الدردشة', en: 'Chat' },
  { key: '/board', ar: 'الحساب', en: 'Board' },
  { key: '/brand', ar: 'البراند', en: 'Brand' },
  { key: '/digest', ar: 'الاستراتيجي', en: 'Strategist' },
  { key: '/data', ar: 'الداتا', en: 'Data' },
];

/**
 * Out of the nav, still in the product. Each key is a dict.ts nav key whose
 * route is `/<key>` — so these titles stay defined once, in the dictionary, and
 * a screen cannot end up with a header that says one thing and a sidebar entry
 * that said another.
 *
 * How each one is reached now:
 *   /dashboard   the account overview Board is growing into. Still the landing
 *                route (src/app/page.tsx and middleware.ts both send here), so
 *                it is reached on every sign-in even though it is not in the
 *                nav. See the note in tests/nav.test.ts.
 *   /concepts    dispatch target for `concepts` and `storyboard`; linked from
 *                the dashboard and the calendar.
 *   /campaigns   dispatch target for `campaign`.
 *   /reports     dispatch target for `report`.
 *   /calendar    reached from /concepts.
 *   /guideline   dispatch target for `guideline`. Becomes a Brand tab.
 *   /compliance  linked from the chat. Becomes a Brand tab.
 *   /settings    behind the user menu in the header.
 */
const DEMOTED_KEYS = [
  'dashboard',
  'concepts',
  'campaigns',
  'calendar',
  'reports',
  'guideline',
  'compliance',
  'settings',
] as const;

export const DEMOTED: readonly Surface[] = DEMOTED_KEYS.map((key) => ({
  key: `/${key}`,
  ar: dict.ar.nav[key],
  en: dict.en.nav[key],
}));

/** Every route that still renders a screen of its own. */
export const SURFACES: readonly Surface[] = [...NAV, ...DEMOTED];

export type MovedUrl = '/audience' | '/decisions';

/**
 * The two screens v6 deletes, and the live surface each URL now resolves to.
 *
 * /audience -> /board. The audience insight is going to Brand's audience
 * section and the comment corpus to Board's comment lens, and both are later
 * phases — so this is a choice about TODAY, not about the eventual home. Board
 * is the live surface that already renders the same post population and is the
 * named home of the comment lens; /brand today carries none of the audience
 * material at all. When Brand's audience section lands, this one line moves.
 *
 * /decisions -> /digest. The ledger is what the digest is accountable to, and
 * the Strategist surface is where a decision is written in the first place.
 *
 * A 307 (`redirect`) and not a 308 (`permanentRedirect`): both of these URLs
 * are expected to become tabs on the surface that absorbed them, and a 308 the
 * operator's browser has cached would outlive the decision that produced it.
 */
export const MOVED: Readonly<Record<MovedUrl, string>> = {
  '/audience': '/board',
  '/decisions': '/digest',
};

/**
 * Segment-boundary match, so /data claims /data and /data/anything but never a
 * future /database. `startsWith(key)` alone would.
 */
function covers(key: string, pathname: string): boolean {
  return pathname === key || pathname.startsWith(`${key}/`);
}

/** The screen a path belongs to, or null if nothing in this app owns it. */
export function surfaceFor(pathname: string): Surface | null {
  return SURFACES.find((surface) => covers(surface.key, pathname)) ?? null;
}

export function label(surface: Surface, locale: Locale): string {
  return locale === 'ar' ? surface.ar : surface.en;
}

/**
 * The header title for any path. Returns an empty string for a path this app
 * does not own, so the header renders nothing rather than a guess — every route
 * that exists is covered, and tests/nav.test.ts is what keeps that true.
 */
export function titleFor(pathname: string, locale: Locale): string {
  const surface = surfaceFor(pathname);
  return surface === null ? '' : label(surface, locale);
}

/**
 * Which of the five to light up, or null. Null is the honest answer on a
 * demoted screen: the operator is somewhere the sidebar does not go, and
 * highlighting a neighbouring entry would be a small lie about where they are.
 */
export function navKeyFor(pathname: string): NavKey | null {
  return NAV.find((surface) => covers(surface.key, pathname))?.key ?? null;
}
