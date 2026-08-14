import dayjs, { type Dayjs } from 'dayjs';
import 'dayjs/locale/ar';
import 'dayjs/locale/en';

/**
 * The Arabic dayjs locale renders Arabic-Indic digits (٢٠٢٦). That is right for
 * display and wrong for anything we send to Postgres, so every value that
 * crosses the API boundary goes through here and is formatted in `en` first.
 */
export function toIsoDate(value: Dayjs): string {
  return value.locale('en').format('YYYY-MM-DD');
}

/** Monday of the week containing `value`, as an ISO date. */
export function weekStartIso(value: Dayjs): string {
  const day = value.locale('en');
  const offset = (day.day() + 6) % 7; // dayjs: 0 = Sunday
  return day.subtract(offset, 'day').format('YYYY-MM-DD');
}

export function formatDate(iso: string | null | undefined, locale: 'ar' | 'en'): string {
  if (!iso) return '—';
  const d = dayjs(iso);
  if (!d.isValid()) return '—';
  return d.locale(locale === 'ar' ? 'ar' : 'en').format('D MMMM YYYY');
}

export function formatDateTime(iso: string | null | undefined, locale: 'ar' | 'en'): string {
  if (!iso) return '—';
  const d = dayjs(iso);
  if (!d.isValid()) return '—';
  return d.locale(locale === 'ar' ? 'ar' : 'en').format('D MMM YYYY · HH:mm');
}

/** Numbers stay Latin-digit everywhere: they are metrics, not prose. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatSignedNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const formatted = new Intl.NumberFormat('en-US').format(Math.abs(value));
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '−'}${formatted}`;
}
