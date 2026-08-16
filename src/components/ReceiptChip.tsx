'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Popover } from 'antd';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { resolveReceipt, type ReceiptInput } from '@/lib/theme';

/* ===========================================================================
 * THE RECEIPT CHIP — every number in the product, and the proof under it.
 *
 * The thesis of this product is that a figure without a provenance is not an
 * insight, it is a rumour. This component is that thesis made touchable: press
 * a number and it tells you the key it was filed under, how many things were
 * counted, when they were counted, and where the rows live.
 *
 * It is the only element in the interface allowed to show off, and it earns it
 * by refusing to. Three behaviours matter more than the flourish:
 *
 *   DEGRADES HONESTLY. No source key, no chip. The dotted underline is a
 *   promise; a chip that opens an empty popover breaks the promise for every
 *   other chip on the screen. Without a key the value is plain text, and with
 *   no value at all it is an em-dash — never a zero (hard rule 2). The decision
 *   is made by `resolveReceipt` in src/lib/theme.ts, which is pure and tested.
 *
 *   READS OUT LOUD. The popover copy is duplicated into a visually-hidden span
 *   inside the button, so a screen-reader user gets the receipt without opening
 *   anything, and a keyboard user reaches it with Tab because it is a real
 *   <button> and closes it with Escape.
 *
 *   NEVER INVENTS. The rendered figure is the exact string it was handed:
 *   no grouping, no rounding, no re-localising. Same reason `BasisRef.value` is
 *   typed `string` — see the note there. The one number this file composes at
 *   all is `n`, and only to decide whether it is showable.
 * ======================================================================== */

export type ReceiptChipProps = ReceiptInput & {
  /** Applied to the figure alongside `tq-num`, e.g. a hero stat's size class. */
  className?: string;
};

export function ReceiptChip({ className, ...input }: ReceiptChipProps) {
  const { tt } = useLocale();
  const [open, setOpen] = useState(false);
  const resolved = resolveReceipt(input);
  const figureClass = className
    ? `${resolved.figure.className} ${className}`
    : resolved.figure.className;

  /* Nothing was measured. Say so, quietly, and offer nothing to press. */
  if (resolved.kind === 'absent') {
    return (
      <span className={figureClass} dir={resolved.figure.dir}>
        {resolved.figure.text}
        <span className="tq-sr-only" dir="auto">
          {tt('لا قياس', 'not measured')}
        </span>
      </span>
    );
  }

  /* A real value with no key. Text, not evidence — so it wears no underline. */
  if (resolved.kind === 'plain') {
    return (
      <span className={figureClass} dir={resolved.figure.dir}>
        {resolved.figure.text}
      </span>
    );
  }

  const keyLabel = tt('المفتاح', 'Source key');
  const nLabel = tt('عدد العينة', 'Sample size');
  const atLabel = tt('حُسب في', 'Computed at');
  const openLabel = tt('افتح الصف', 'Open the rows');

  /* The same facts as the popover, as text, for readers who never open it. */
  const spoken = [
    resolved.label,
    `${keyLabel}: ${resolved.sourceKey}`,
    `${nLabel}: ${resolved.n}`,
    `${atLabel}: ${resolved.computedAt}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' — ');

  const receipt = (
    <div className="tq-receipt-body">
      {resolved.label ? (
        <div className="tq-receipt-label" dir="auto">
          {resolved.label}
        </div>
      ) : null}
      <dl style={{ margin: 0 }}>
        <div className="tq-receipt-row">
          <dt>{keyLabel}</dt>
          <dd className="tq-receipt-key">{resolved.sourceKey}</dd>
        </div>
        <div className="tq-receipt-row">
          <dt>{nLabel}</dt>
          <dd className="tq-num">{resolved.n}</dd>
        </div>
        <div className="tq-receipt-row">
          <dt>{atLabel}</dt>
          <dd className="tq-num">{resolved.computedAt}</dd>
        </div>
      </dl>
      {resolved.href ? (
        <Link className="tq-receipt-link" href={resolved.href} onClick={() => setOpen(false)}>
          {openLabel}
        </Link>
      ) : null}
    </div>
  );

  return (
    <Popover
      content={receipt}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="top"
      rootClassName="tq-receipt-popover"
    >
      <button
        type="button"
        className="tq-receipt"
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <span className={figureClass} dir={resolved.figure.dir}>
          {resolved.figure.text}
        </span>
        <span className="tq-sr-only" dir="auto">
          {spoken}
        </span>
      </button>
    </Popover>
  );
}
