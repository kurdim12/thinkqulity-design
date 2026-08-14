import type { Metadata } from 'next';
import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { Providers } from '@/components/Providers';
import { readLocale, readQuality } from '@/lib/prefs.server';
import './globals.css';

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-arabic',
  display: 'swap',
});

const latin = Inter({
  subsets: ['latin'],
  variable: '--font-latin',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ThinkQuality Studio',
  description:
    'Brand strategist and creative director workspace for Think Quality Academy, operated by ALKURDI Studio.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, quality] = await Promise.all([readLocale(), readQuality()]);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <html lang={locale} dir={dir} className={`${arabic.variable} ${latin.variable}`}>
      <body
        style={{
          fontFamily:
            locale === 'ar'
              ? 'var(--font-arabic), var(--font-latin), system-ui, sans-serif'
              : 'var(--font-latin), var(--font-arabic), system-ui, sans-serif',
        }}
      >
        <AntdRegistry>
          <Providers initialLocale={locale} initialQuality={quality}>
            {children}
          </Providers>
        </AntdRegistry>
      </body>
    </html>
  );
}
