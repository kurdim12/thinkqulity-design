'use client';

import Link from 'next/link';
import { Alert, Button, Empty, Skeleton, Tag, Typography } from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import type { ConceptFormat, ConceptStatus, Grounding } from '@/lib/types/db';

export function PageHeader({
  title,
  subtitle,
  extra,
}: {
  title: string;
  subtitle?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="tq-page-header" style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
      <div style={{ flex: 1 }}>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {extra ? <div>{extra}</div> : null}
    </div>
  );
}

/** Shown wherever the agent's output depends on brand.status. */
export function SeedAlert({ status }: { status: 'seed' | 'live' }) {
  const { t, tt } = useLocale();
  if (status === 'live') return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBlockEnd: 16 }}
      message={t.seedWarning.title}
      description={t.seedWarning.body}
      action={
        <Link href="/data">
          <Button size="small">{tt('إلى البيانات', 'Go to Data')}</Button>
        </Link>
      }
    />
  );
}

export function GroundingTag({ grounding }: { grounding: Grounding }) {
  const { t } = useLocale();
  return (
    <Tag color={grounding === 'data' ? 'green' : 'orange'} style={{ marginInlineEnd: 0 }}>
      {grounding === 'data' ? t.grounding.data : t.grounding.hypothesis}
    </Tag>
  );
}

const FORMAT_LABELS: Record<ConceptFormat, { ar: string; en: string; color: string }> = {
  reel: { ar: 'ريل', en: 'Reel', color: 'magenta' },
  carousel: { ar: 'كاروسيل', en: 'Carousel', color: 'blue' },
  static: { ar: 'صورة ثابتة', en: 'Static', color: 'default' },
  story: { ar: 'ستوري', en: 'Story', color: 'purple' },
};

export function FormatTag({ format }: { format: ConceptFormat }) {
  const { locale } = useLocale();
  const meta = FORMAT_LABELS[format];
  return <Tag color={meta.color}>{locale === 'ar' ? meta.ar : meta.en}</Tag>;
}

const STATUS_LABELS: Record<ConceptStatus, { ar: string; en: string; color: string }> = {
  draft: { ar: 'مسودة', en: 'Draft', color: 'default' },
  approved: { ar: 'معتمدة', en: 'Approved', color: 'gold' },
  shipped: { ar: 'منشورة', en: 'Shipped', color: 'green' },
  rejected: { ar: 'مرفوضة', en: 'Rejected', color: 'red' },
};

export function statusLabel(status: ConceptStatus, locale: 'ar' | 'en'): string {
  return locale === 'ar' ? STATUS_LABELS[status].ar : STATUS_LABELS[status].en;
}

export function StatusTag({ status }: { status: ConceptStatus }) {
  const { locale } = useLocale();
  return <Tag color={STATUS_LABELS[status].color}>{statusLabel(status, locale)}</Tag>;
}

/**
 * Arabic content always carries dir="auto" so a caption that mixes Arabic and a
 * Latin handle or URL still renders in the right order.
 */
export function ArabicText({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div dir="auto" className={`tq-ar ${className ?? ''}`} style={style}>
      {children}
    </div>
  );
}

/** Every empty state names what is missing and the action that fills it. */
export function EmptyState({
  description,
  actionLabel,
  onAction,
  href,
}: {
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  href?: string;
}) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={<span className="tq-muted">{description}</span>}
      style={{ paddingBlock: 32 }}
    >
      {actionLabel ? (
        href ? (
          <Link href={href}>
            <Button type="primary">{actionLabel}</Button>
          </Link>
        ) : (
          <Button type="primary" onClick={onAction}>
            {actionLabel}
          </Button>
        )
      ) : null}
    </Empty>
  );
}

export function ErrorState({
  error,
  hint,
  onRetry,
}: {
  error: string;
  hint?: string | null;
  onRetry?: () => void;
}) {
  const { t } = useLocale();
  return (
    <Alert
      type="error"
      showIcon
      message={t.common.error}
      description={
        <>
          <div>{error}</div>
          {hint ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {hint}
            </Typography.Text>
          ) : null}
        </>
      }
      action={
        onRetry ? (
          <Button size="small" onClick={onRetry}>
            {t.common.retry}
          </Button>
        ) : null
      }
      style={{ marginBlockEnd: 16 }}
    />
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <Skeleton active paragraph={{ rows }} />;
}

/** Renders agent warnings verbatim — they are part of the honesty contract. */
export function WarningList({ warnings }: { warnings: string[] }) {
  const { tt } = useLocale();
  if (warnings.length === 0) return null;
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBlockEnd: 16 }}
      message={tt('ملاحظات الوكيل', 'Agent warnings')}
      description={
        <ul style={{ margin: 0, paddingInlineStart: 18 }}>
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      }
    />
  );
}
