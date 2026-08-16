'use client';

import '@ant-design/v5-patch-for-react-19';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { App as AntdApp, ConfigProvider } from 'antd';
import arEG from 'antd/locale/ar_EG';
import enUS from 'antd/locale/en_US';
import dayjs from 'dayjs';
import { LocaleProvider, useLocale } from '@/lib/i18n/LocaleContext';
import { studioTheme } from '@/lib/theme';
import { QUALITY_COOKIE, COOKIE_MAX_AGE, type Quality } from '@/lib/prefs';
import type { Locale } from '@/lib/i18n/dict';

/* ------------------------------- model quality ---------------------------- */

interface QualityValue {
  quality: Quality;
  setQuality: (next: Quality) => void;
}

const QualityCtx = createContext<QualityValue | null>(null);

function QualityProvider({
  initialQuality,
  children,
}: {
  initialQuality: Quality;
  children: React.ReactNode;
}) {
  const [quality, setQualityState] = useState<Quality>(initialQuality);

  const setQuality = useCallback((next: Quality) => {
    setQualityState(next);
    // Route handlers read this cookie, so the toggle applies to the very next
    // generation without any extra plumbing.
    document.cookie = `${QUALITY_COOKIE}=${next}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
  }, []);

  const value = useMemo(() => ({ quality, setQuality }), [quality, setQuality]);
  return <QualityCtx.Provider value={value}>{children}</QualityCtx.Provider>;
}

export function useQuality(): QualityValue {
  const ctx = useContext(QualityCtx);
  if (!ctx) throw new Error('useQuality must be used inside <Providers>.');
  return ctx;
}

/* ---------------------------------- antd ---------------------------------- */

function AntdShell({ children }: { children: React.ReactNode }) {
  const { locale, dir } = useLocale();
  dayjs.locale(locale === 'ar' ? 'ar' : 'en');

  return (
    <ConfigProvider
      direction={dir}
      locale={locale === 'ar' ? arEG : enUS}
      theme={studioTheme}
      // One orchestrated moment per surface, and the receipt chip owns the only
      // flourish. antd's click wave is a second, ambient one on every button in
      // the product, so it is turned off at the root rather than fought locally.
      wave={{ disabled: true }}
    >
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

export function Providers({
  initialLocale,
  initialQuality,
  children,
}: {
  initialLocale: Locale;
  initialQuality: Quality;
  children: React.ReactNode;
}) {
  return (
    <LocaleProvider initialLocale={initialLocale}>
      <QualityProvider initialQuality={initialQuality}>
        <AntdShell>{children}</AntdShell>
      </QualityProvider>
    </LocaleProvider>
  );
}
