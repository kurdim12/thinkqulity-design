'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { askScopeHref, type AskScope, type AskScopeKind } from '@/lib/chat/scope';

/* ===========================================================================
 * ASK ABOUT THIS — the chat, as a layer instead of a tab.
 *
 * One line on the object itself: press it and the chat opens already pointed at
 * this post, this concern, this proposed decision. What travels is the typed
 * reference from src/lib/chat/scope.ts — a kind and identifiers — and the note
 * at the top of that file is where the reasoning lives, because the decision
 * that matters is the one it makes: `label` below is used in this component and
 * nowhere else, and is deliberately not part of what is serialised.
 *
 * THIS IS AN AFFORDANCE, NOT A CALL TO ACTION. It is 13px, unbordered,
 * unbackgrounded and last in its row — deliberately the same weight as the
 * card's own «فتح» link, because it is the same kind of thing. It gains an
 * underline when you are on it and does nothing at all when you are not: no
 * transition, no lift, no hover card. The receipt chip is the one element in
 * this product allowed to show off; three hundred of these on a Board would be
 * a rash.
 *
 * IT IS INK AND NOT MUTED, AND THAT IS NOT A LOUDNESS DECISION. `--tq-muted`
 * on `--tq-paper` measures 3.45:1, which is fine for the metadata it was drawn
 * for and not fine for a control a person has to find and press. Ink at 13px
 * with nothing around it is quiet the way a small thing is quiet, rather than
 * the way a faint thing is — and it matches `colorLink` in src/lib/theme.ts, so
 * the two links at the foot of a Board card read as the peers they are.
 *
 * IT DISAPPEARS RATHER THAN DISAPPOINT. `askScopeHref` returns null for a scope
 * that would not survive its own round trip — a `post_id` that is not a uuid is
 * a `string` as far as tsc is concerned — and this renders nothing at all in
 * that case. A link that lands on a refusal is a dead button, which is the
 * thing this version exists to stop shipping.
 * ======================================================================== */

/**
 * The invitation, per kind. Predefined and keyed by the same closed tuple the
 * scope is (hard rule 19), rather than composed from the object's own words —
 * «اسأل عن "<caption>"» would put the post's author in the button's own copy.
 */
const ASK_COPY: Record<AskScopeKind, { ar: string; en: string }> = {
  post: { ar: 'اسأل عن هذا البوست', en: 'Ask about this post' },
  digest_entry: { ar: 'اسأل عن هذا البند', en: 'Ask about this item' },
};

/**
 * How much of the object's own text goes into the accessible name. A Board with
 * three hundred cards on it otherwise announces "Ask about this post" three
 * hundred times, which tells a screen-reader user which button they are on and
 * nothing about which post it belongs to. The cut is taken at a whitespace
 * boundary for the reason the chat route's `titleFrom` gives: a slice through
 * «508» leaves «50» on a screen, a quantity that appears in no source.
 */
const LABEL_MAX = 72;

function shorten(label: string): string | null {
  const flat = label.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  if (flat.length <= LABEL_MAX) return flat;
  const head = flat.slice(0, LABEL_MAX);
  const boundary = head.lastIndexOf(' ');
  return `${boundary > 20 ? head.slice(0, boundary) : head}…`;
}

export interface AskAboutProps {
  /** The typed reference. Serialised; carries identifiers only. */
  scope: AskScope;
  /**
   * The object in the reader's own words — a caption, a statement, a headline.
   * Used ONLY in this button's accessible name. It is not encoded, not sent,
   * and never reaches a model: the chat route re-derives what it needs from the
   * row `scope` names. See the note in src/lib/chat/scope.ts.
   */
  label?: string;
}

export function AskAbout({ scope, label }: AskAboutProps) {
  const { locale } = useLocale();
  const [lit, setLit] = useState(false);
  const [focused, setFocused] = useState(false);

  const href = askScopeHref(scope);
  if (href === null) return null;

  const copy = ASK_COPY[scope.kind];
  const named = label === undefined ? null : shorten(label);
  /** Pointer and keyboard get the same state; there is only one here. */
  const active = lit || focused;

  return (
    <Link
      href={href}
      // Every card on the Board carries one of these and every href is
      // distinct, so the default would put three hundred prefetches of one
      // route on the wire the moment the list renders (hard rule 22).
      prefetch={false}
      onMouseEnter={() => setLit(true)}
      onMouseLeave={() => setLit(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: 'inline-block',
        fontSize: 'var(--tq-fs-1)',
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
        color: 'var(--tq-ink)',
        textDecoration: active ? 'underline' : 'none',
        textUnderlineOffset: '0.25em',
        outline: focused ? '2px solid var(--tq-ink)' : 'none',
        outlineOffset: '2px',
        borderRadius: 'var(--tq-radius-sm)',
      }}
    >
      {locale === 'ar' ? copy.ar : copy.en}
      {named === null ? null : (
        <span className="tq-sr-only" dir="auto">
          {` — ${named}`}
        </span>
      )}
    </Link>
  );
}
