import type { Locale } from '@/lib/i18n/dict';

/**
 * Client-safe half of the preference layer: cookie names, the Quality union and
 * pure parsers. Reading cookies on the server lives in prefs.server.ts, which
 * must never be imported from a 'use client' file.
 */

export type Quality = 'standard' | 'high';

export const LOCALE_COOKIE = 'tq_locale';
export const QUALITY_COOKIE = 'tq_quality';
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function parseLocale(value: string | undefined | null): Locale {
  return value === 'en' ? 'en' : 'ar';
}

export function parseQuality(value: string | undefined | null): Quality {
  return value === 'high' ? 'high' : 'standard';
}
