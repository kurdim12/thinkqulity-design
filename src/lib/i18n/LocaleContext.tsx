'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { dict, type Dict, type Locale } from './dict';
import { LOCALE_COOKIE, COOKIE_MAX_AGE } from '@/lib/prefs';

interface LocaleValue {
  locale: Locale;
  isRTL: boolean;
  dir: 'rtl' | 'ltr';
  t: Dict;
  /** Inline picker: `tt('عربي', 'English')`. */
  tt: (ar: string, en: string) => string;
  setLocale: (next: Locale) => void;
}

const LocaleCtx = createContext<LocaleValue | null>(null);

export function LocaleProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const router = useRouter();

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
      // Flip the document immediately so there is no frame of wrong direction,
      // then let the server re-render <html dir> to match.
      document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
      document.documentElement.lang = next;
      router.refresh();
    },
    [router],
  );

  const value = useMemo<LocaleValue>(
    () => ({
      locale,
      isRTL: locale === 'ar',
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      t: dict[locale] as Dict,
      tt: (ar: string, en: string) => (locale === 'ar' ? ar : en),
      setLocale,
    }),
    [locale, setLocale],
  );

  return <LocaleCtx.Provider value={value}>{children}</LocaleCtx.Provider>;
}

export function useLocale(): LocaleValue {
  const ctx = useContext(LocaleCtx);
  if (!ctx) throw new Error('useLocale must be used inside <LocaleProvider>.');
  return ctx;
}
