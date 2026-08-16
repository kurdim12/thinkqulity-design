'use client';

import Link from 'next/link';
import { Alert, Button, Empty, Typography } from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import type { ConceptFormat, ConceptStatus, Grounding } from '@/lib/types/db';

/* ===========================================================================
 * SHARED PRIMITIVES.
 *
 * Two rules hold across this file and are the reason it exists at all:
 *
 *   COLOUR IS SPENT ON GROUNDING AND NOTHING ELSE. A tag that says "measured"
 *   or "hypothesis" is coloured because the colour is the message. A tag that
 *   says "carousel" is not, because a format is not a claim about the world.
 *   The old palette gave reels magenta and carousels blue, which spent the
 *   reader's whole colour vocabulary on the least meaningful distinction on the
 *   screen and left grounding to compete with it. Format and status separate by
 *   weight and border now; grounding keeps the hue.
 *
 *   MOTION AND SKELETONS ARE DECLARED ONCE. Every surface gets the same single
 *   orchestrated entrance and the same placeholder, so no screen invents its
 *   own. Both honour prefers-reduced-motion, in src/app/globals.css.
 * ======================================================================== */

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

/**
 * Arabic display type — Reem Kufi. TITLES ONLY: digest headlines, guideline
 * heads, hero stat labels. It is a restraint, and the moment it wraps a
 * paragraph it stops being one. `dir="auto"` because a headline that opens with
 * a Latin handle must still read right-to-left.
 */
export function Display({
  children,
  level,
  className,
  style,
}: {
  children: React.ReactNode;
  /** Renders h1/h2/h3; omit for a div, when the title is not a document heading. */
  level?: 1 | 2 | 3;
  className?: string;
  style?: React.CSSProperties;
}) {
  const Tag = level === 1 ? 'h1' : level === 2 ? 'h2' : level === 3 ? 'h3' : 'div';
  return (
    <Tag dir="auto" className={`tq-display ${className ?? ''}`} style={style}>
      {children}
    </Tag>
  );
}

/** A CSS custom property is a valid style value; declaring it keeps `any` out. */
interface RevealStyle extends React.CSSProperties {
  '--tq-reveal-index'?: string;
}

/**
 * The one orchestrated moment a surface is allowed. Wrap the blocks that make
 * up a screen and pass their order; they arrive once, 55ms apart, and then
 * nothing on the page moves again. Nothing here loops and nothing is ambient.
 */
export function Reveal({
  children,
  index = 0,
  className,
  style,
}: {
  children: React.ReactNode;
  index?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const revealStyle: RevealStyle = { ...style, '--tq-reveal-index': String(index) };
  return (
    <div className={`tq-reveal ${className ?? ''}`} style={revealStyle}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- skeletons -- */

export function SkeletonLine({
  width = '100%',
  height = 13,
}: {
  width?: number | string;
  height?: number;
}) {
  return <span className="tq-skeleton" style={{ width, height }} />;
}

/** Ragged on purpose: equal bars read as a table, and what is loading is prose. */
function Lines({ rows }: { rows: number }) {
  const widths = ['92%', '78%', '85%', '64%', '88%', '71%'];
  return (
    <div className="tq-stack">
      {Array.from({ length: Math.max(1, rows) }, (_, i) => (
        <SkeletonLine key={i} width={widths[i % widths.length]} />
      ))}
    </div>
  );
}

/** One live region per loading surface — nested ones announce over each other. */
function LoadingRegion({ children }: { children: React.ReactNode }) {
  const { tt } = useLocale();
  return (
    <div role="status" aria-live="polite">
      <span className="tq-sr-only">{tt('جارٍ التحميل', 'Loading')}</span>
      {children}
    </div>
  );
}

export function SkeletonLines({ rows = 4 }: { rows?: number }) {
  return (
    <LoadingRegion>
      <Lines rows={rows} />
    </LoadingRegion>
  );
}

/** A figure-sized placeholder, so a stat does not collapse and then jump. */
export function SkeletonStat() {
  return (
    <LoadingRegion>
      <div style={{ display: 'grid', gap: 10 }}>
        <SkeletonLine width={96} height={13} />
        <SkeletonLine width={140} height={34} />
      </div>
    </LoadingRegion>
  );
}

export function SkeletonCards({ count = 3, rows = 3 }: { count?: number; rows?: number }) {
  return (
    <LoadingRegion>
      <div style={{ display: 'grid', gap: 16 }}>
        {Array.from({ length: Math.max(1, count) }, (_, i) => (
          <div className="tq-skeleton-card" key={i}>
            <Lines rows={rows} />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <SkeletonLines rows={rows} />;
}

/* ------------------------------------------------------------------ tags -- */

export function GroundingTag({ grounding }: { grounding: Grounding }) {
  const { t } = useLocale();
  const isData = grounding === 'data';
  return (
    <span className={`tq-tag ${isData ? 'tq-tag--data' : 'tq-tag--hypothesis'}`}>
      {isData ? t.grounding.data : t.grounding.hypothesis}
    </span>
  );
}

const FORMAT_LABELS: Record<ConceptFormat, { ar: string; en: string }> = {
  reel: { ar: 'ريل', en: 'Reel' },
  carousel: { ar: 'كاروسيل', en: 'Carousel' },
  static: { ar: 'صورة ثابتة', en: 'Static' },
  story: { ar: 'ستوري', en: 'Story' },
};

export function FormatTag({ format }: { format: ConceptFormat }) {
  const { locale } = useLocale();
  const meta = FORMAT_LABELS[format];
  return <span className="tq-tag">{locale === 'ar' ? meta.ar : meta.en}</span>;
}

/**
 * Weight, not hue: a draft is dashed and unfinished, an approved concept is
 * stated in ink, a shipped one is filled, a rejected one is struck through.
 * Red is not spent here — a human saying no is not a failure of the system.
 */
const STATUS_LABELS: Record<ConceptStatus, { ar: string; en: string; variant: string }> = {
  draft: { ar: 'مسودة', en: 'Draft', variant: 'tq-tag--quiet' },
  approved: { ar: 'معتمدة', en: 'Approved', variant: 'tq-tag--stated' },
  shipped: { ar: 'منشورة', en: 'Shipped', variant: 'tq-tag--done' },
  rejected: { ar: 'مرفوضة', en: 'Rejected', variant: 'tq-tag--quiet tq-tag--struck' },
};

export function statusLabel(status: ConceptStatus, locale: 'ar' | 'en'): string {
  return locale === 'ar' ? STATUS_LABELS[status].ar : STATUS_LABELS[status].en;
}

export function StatusTag({ status }: { status: ConceptStatus }) {
  const { locale } = useLocale();
  return (
    <span className={`tq-tag ${STATUS_LABELS[status].variant}`}>
      {statusLabel(status, locale)}
    </span>
  );
}

/* ----------------------------------------------------------------- state -- */

/** Shown wherever the agent's output depends on brand.status. */
export function SeedAlert({ status }: { status: 'seed' | 'live' }) {
  const { t } = useLocale();
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
          {/* The dictionary already names this button; a second wording of it
              in this file is how the two drift apart. */}
          <Button size="small">{t.seedWarning.cta}</Button>
        </Link>
      }
    />
  );
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

/**
 * AN EMPTY STATE IS AN INVITATION, NOT A NOTICE.
 *
 * Almost every table in this product is empty today — no analyses, no comments,
 * no profile snapshots, no decisions, no references. These are therefore the
 * most-read screens in the app, not its edge cases, and each one answers three
 * questions in this order:
 *
 *   `title`        what this will show once it has something.
 *   `description`  the one action that fills it.
 *   `hint`         what that action costs, when it costs anything.
 *
 * `title` and `hint` are optional so the smallest cases stay one line. What is
 * NOT allowed here is the fourth sentence the old copy kept reaching for — the
 * one explaining what the screen refuses to do.
 */
export function EmptyState({
  title,
  description,
  hint,
  actionLabel,
  onAction,
  href,
}: {
  /** What the surface holds when it is not empty. */
  title?: string;
  description: string;
  /** The price of the action, in the operator's terms. Omit when it is free. */
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
  href?: string;
}) {
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <span>
          {title ? (
            <span dir="auto" style={{ display: 'block', color: 'var(--tq-ink)' }}>
              {title}
            </span>
          ) : null}
          <span dir="auto" className="tq-muted" style={{ display: 'block' }}>
            {description}
          </span>
          {hint ? (
            <span
              dir="auto"
              className="tq-muted"
              style={{ display: 'block', fontSize: 'var(--tq-fs-1)', marginBlockStart: 4 }}
            >
              {hint}
            </span>
          ) : null}
        </span>
      }
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

/**
 * WHAT HAPPENED, THEN WHAT TO DO ABOUT IT.
 *
 * This used to headline every failure with "Something went wrong" and demote
 * the real message to the body — so every error in the product looked identical
 * at a glance and the operator had to read past a shrug to find out which one it
 * was. The message the route sent IS the headline now; the hint it sent is the
 * fix and sits directly under it.
 */
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
      message={<span dir="auto">{error}</span>}
      description={
        hint ? (
          <Typography.Text type="secondary" dir="auto" style={{ fontSize: 12 }}>
            {hint}
          </Typography.Text>
        ) : null
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
