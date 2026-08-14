import { cookies } from 'next/headers';
import type { Locale } from '@/lib/i18n/dict';
import { LOCALE_COOKIE, QUALITY_COOKIE, parseLocale, parseQuality, type Quality } from './prefs';

/** SERVER ONLY — imports next/headers. */

export async function readLocale(): Promise<Locale> {
  const store = await cookies();
  return parseLocale(store.get(LOCALE_COOKIE)?.value);
}

export async function readQuality(): Promise<Quality> {
  const store = await cookies();
  return parseQuality(store.get(QUALITY_COOKIE)?.value);
}
