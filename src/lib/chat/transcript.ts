/**
 * ===========================================================================
 * WHAT THE CHAT SCREEN CAN READ OUT OF A STORED TRANSCRIPT
 * ===========================================================================
 *
 * The pure half of src/app/(app)/chat/page.tsx. It is a separate module for two
 * reasons and both of them matter here more than usual:
 *
 *   1. THE BUILD-ONLY RULE. A page may export nothing but `default`, so nothing
 *      inside it can be imported by a test. Provenance display is the last thing
 *      in this app that should rest on code nobody executed.
 *   2. ONE DEFINITION. `EXTERNAL_FACTS_KIND` below is imported by BOTH the tool
 *      that emits the payload (src/lib/agent/chat/tools.ts) and the screen that
 *      renders it. This module is a leaf — it imports the Law's tokeniser and
 *      nothing else, no zod, no Supabase, no React — so a browser bundle can
 *      hold it. That is what makes one constant possible where `UNSOURCED_CHIP`
 *      had to be mirrored.
 *
 * ---------------------------------------------------------------------------
 * THE HONEST LIMIT, STATED FIRST BECAUSE THE SCREEN IS BUILT AROUND IT
 * ---------------------------------------------------------------------------
 * `runAgentChat` returns a `ChatSubstitutionReport` — `substituted_keys`,
 * `typed`, `refused`, `hard_guarantee` — which is the exact per-turn answer to
 * "which digits did code write". IT IS NEITHER PERSISTED NOR RETURNED.
 * `chat_messages` has no column for it and `/api/chat`'s POST body does not
 * carry it, so a reload cannot see it and neither can this module.
 *
 * So this module DOES NOT REPLAY THE SUBSTITUTION AND DOES NOT CLAIM TO. What
 * it can do, from the rows alone, is check a much narrower proposition:
 *
 *     the text occupying this figure's position is, character for character,
 *     a value one of this turn's own tool results declared under a source key.
 *
 * That is checkable, it is what the screen says, and it is strictly weaker than
 * "code wrote this". The gap is the point of `markFigures`'s counters: a screen
 * that quietly rounded the weaker claim up to the stronger one would be doing
 * the exact thing the whole v5 design exists to stop.
 *
 * ---------------------------------------------------------------------------
 * WHY VERBATIM EQUALITY AND NOT A CANONICAL KEY COMPARISON
 * ---------------------------------------------------------------------------
 * `substitute()` writes the value from the map INTO the text unchanged. So the
 * delivered spelling of a substituted figure is byte-identical to the declared
 * one, and demanding byte identity costs nothing in the true case while
 * refusing every near miss:
 *
 *   * «٨٨٥٠٨» does not equal '508' — and it is not even the same token, because
 *     the tokeniser reads the whole digit run.
 *   * '508٪' does not equal '508'. The span compared runs to `markerEnd`, so a
 *     unit the model welded on is inside the comparison and breaks it. This is
 *     the case the linter's own whole-token match passes, because `508٪`
 *     canonicalises to `508` and 508 really is evidence — a 12.7× fabrication
 *     with a true number inside it. Verbatim equality refuses it.
 *   * '٥٠٨' does not equal '508'. A value respelled in another digit script was
 *     retyped by the model, whatever it canonicalises to.
 *
 * Comparing canonical keys instead would accept all three. There is no case
 * where the canonical comparison is right and this one is wrong, because the
 * only thing being asked is "did this text come out of the map verbatim".
 *
 * The tokeniser is `quantities()` from the Law, IMPORTED, not restated. This
 * project has paid twice for a second definition of "a number" (see the header
 * of src/lib/brain/law/claims-linter.ts), and a display that disagreed with the
 * gate about where a figure starts would put a receipt on the wrong characters.
 */

import { quantities, wholeQuantity, type Quantity } from '../brain/law/claims-linter.ts';

/* ================================================== reading unknown records ==
 *
 * A tool row's `content` is a JSON string and a card is
 * `Record<string, unknown>`, so everything crossing that boundary is narrowed
 * at runtime. No `any`, no assertion: a field that is not the expected type
 * reads as ABSENT, and the screen renders an absence as an em-dash rather than
 * as the word "undefined".
 * ========================================================================== */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

export function readRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

export function readStrings(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function readRecords(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

/** The `source_keys` map a cap payload carries: key → what produced the figure. */
export function readSourceKeyMap(source: Record<string, unknown>): Record<string, string> {
  const raw = readRecord(source, 'source_keys');
  if (raw === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** A tool row's stored content, parsed. Null when it is not a JSON object. */
export function parseToolPayload(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // run.ts writes a one-line `TOOL ERROR (name): reason` string when an
    // executor throws. It is not JSON and it is not a failure to parse it — the
    // caller renders it verbatim.
    return null;
  }
}

/* ============================================== the values a turn declared == */

/**
 * ONE VALUE A TOOL RESULT DECLARED, as the screen reads it back.
 *
 * `value` is VERBATIM — the string `get_stats` put in the payload, which is the
 * same string it put in `sourced` and therefore the same string
 * `buildValueMap()` offered the substitution engine. Never re-formatted: see
 * the header of the chat page for why re-rounding `507.97` would make the
 * screen disagree with the gate that cleared it.
 */
export interface DeclaredValue {
  readonly source_key: string;
  readonly value: string;
  readonly label: string | null;
  readonly n: number | null;
  readonly as_of: string | null;
}

/** Verbatim value text → every key that declared exactly that text this turn. */
export type FigureIndex = ReadonlyMap<string, readonly DeclaredValue[]>;

/**
 * The index a reply is checked against.
 *
 * A `Map`, not an object, for the reason `valueMap()` gives in
 * src/lib/brain/substitute.ts: an object literal resolves `constructor` against
 * `Object.prototype`, and the strings looked up here come out of delivered text.
 *
 * ONLY VALUES THAT ARE THEMSELVES QUANTITIES ARE INDEXED. `wholeQuantity()` is
 * the Law's own boundary between a measurement and some text with digits in it,
 * so a snapshot date, an ig_id or a permalink cannot be indexed and therefore
 * cannot put a receipt under a run of digits inside a date.
 *
 * ONE VALUE MAY BE DECLARED BY SEVERAL KEYS and that is not a fault — an
 * average of 40 and a count of 40 are two measurements that agree. The screen
 * shows every key that matches rather than picking one, because picking one
 * would be the screen inventing a provenance it does not have. (The opposite
 * case — one key, two values — is a fault, and `buildValueMap()` removes the
 * key upstream so no such figure is ever delivered.)
 */
export function buildFigureIndex(values: readonly DeclaredValue[]): FigureIndex {
  const index = new Map<string, DeclaredValue[]>();
  for (const declared of values) {
    if (wholeQuantity(declared.value) === null) continue;
    const existing = index.get(declared.value);
    if (existing === undefined) {
      index.set(declared.value, [declared]);
      continue;
    }
    if (existing.some((entry) => entry.source_key === declared.source_key)) continue;
    existing.push(declared);
  }
  return index;
}

/** A run of delivered text: either prose, or a figure that resolved to a key. */
export type FigureSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'figure'; readonly text: string; readonly declared: readonly DeclaredValue[] };

export interface MarkedReply {
  /**
   * The delivered text, partitioned. Concatenating every `text` reproduces the
   * input EXACTLY — the screen decorates the reply and never edits it.
   */
  readonly segments: readonly FigureSegment[];
  /** Figures that resolved to a key stored with this turn. */
  readonly marked: number;
  /**
   * Numerals the Law's tokeniser found that did not. NOT an accusation: a
   * figure substituted from the strategist's blocks lands here too, because the
   * blocks' values are not stored on the row. The screen says which of the two
   * it is by saying what it checked against, never by guessing.
   */
  readonly unmarked: number;
}

/**
 * Is this figure one piece of a compound — a date, a time, a range, an id?
 *
 * `2026-08-14` is three quantities to the tokeniser, and `14` on its own is a
 * perfectly ordinary sample size. Without this rule, a turn that declared `14`
 * anywhere would put a receipt under the day-of-month of an unrelated date, and
 * a receipt on the wrong characters is worse than no receipt at all.
 *
 * THIS IS NOT A SECOND DEFINITION OF A NUMBER, and it must not become one. It
 * asks a narrower question — is another quantity joined to this one by nothing
 * but joining punctuation — using the neighbours the ONE tokeniser already
 * found. `Quantity.adjacent` asks the same question of blank space; this asks it
 * of everything that is neither blank nor a letter, which is what a date, a
 * clock time, a version and the round-3 invisible-mark trick all have in common.
 *
 * It costs a receipt on a hyphenated range the model wrote itself. That is the
 * right direction to lose one in.
 */
const JOINS_QUANTITIES = /^[^\s\p{L}]*$/u;

function clustered(text: string, found: readonly Quantity[], position: number): boolean {
  const here = found[position];
  const before = position > 0 ? found[position - 1] : null;
  const after = position + 1 < found.length ? found[position + 1] : null;
  if (before !== null && JOINS_QUANTITIES.test(text.slice(before.markerEnd, here.start))) return true;
  if (after !== null && JOINS_QUANTITIES.test(text.slice(here.markerEnd, after.start))) return true;
  return false;
}

/**
 * Partition delivered text into prose and figures that resolve to a key.
 *
 * THE FOUR CONDITIONS, all of them necessary:
 *
 *   `bounded`   — neither side touches a letter or another number. A figure
 *                 welded to a word is a fragment, not a quantity.
 *   `!adjacent` — no other quantity sits beside it across nothing but blank
 *                 space. The substitution engine refuses two values shoved
 *                 together; a screen that put one receipt under `508 40` would
 *                 be certifying a pair it cannot tell apart.
 *   `!clustered` — it is not one piece of a date, a time or a range. See above.
 *   verbatim    — `text.slice(start, markerEnd)` is exactly a declared value.
 *                 The slice runs THROUGH the unit marker, so `%`, `٪` and `×`
 *                 are inside the comparison rather than beside it.
 *
 * Runs over the WHOLE delivered text in one pass, so every condition is judged
 * against the figure's real neighbours. The caller splits the resulting prose
 * segments on the strip chip afterwards; a figure segment is a bare quantity
 * span and can never contain it.
 */
export function markFigures(text: string, index: FigureIndex): MarkedReply {
  const segments: FigureSegment[] = [];
  const found = quantities(text);
  let cursor = 0;
  let marked = 0;
  let unmarked = 0;

  for (let position = 0; position < found.length; position += 1) {
    const quantity = found[position];
    // Never reachable while the tokeniser returns disjoint spans in order; kept
    // because the alternative to skipping is emitting overlapping slices, which
    // would silently duplicate delivered text on the screen.
    if (quantity.start < cursor) continue;

    const span = text.slice(quantity.start, quantity.markerEnd);
    const eligible = quantity.bounded && !quantity.adjacent && !clustered(text, found, position);
    const declared = eligible ? index.get(span) : undefined;

    if (declared === undefined || declared.length === 0) {
      unmarked += 1;
      continue;
    }

    if (quantity.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, quantity.start) });
    }
    segments.push({ kind: 'figure', text: span, declared });
    cursor = quantity.markerEnd;
    marked += 1;
  }

  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });

  return { segments, marked, unmarked };
}

/* ===================================================== external knowledge == */

/**
 * The payload marker for a tool result carrying external knowledge.
 *
 * ONE DEFINITION, imported by the tool that writes it and by the screen that
 * reads it. `UNSOURCED_CHIP` is mirrored into the page because its owner
 * (src/lib/agent/chat/run.ts) drags the Anthropic SDK into any bundle that
 * imports it; this module drags nothing, so there is no reason to mirror.
 */
export const EXTERNAL_FACTS_KIND = 'external_facts';

/**
 * ONE CLAIM SOMEBODY PUBLISHED, as the screen renders it.
 *
 * Structurally `ExternalFactRow` minus the database's own columns — see
 * src/lib/web/facts.ts. `source_key?: never` is repeated here for the same
 * reason it exists there: an object carrying a source key is not assignable to
 * this type, so a renderer that took one would not compile.
 */
export interface ExternalClaim {
  readonly claim: string;
  readonly source_url: string;
  readonly page_title: string | null;
  readonly retrieved_at: string;
  readonly topic: string | null;
  readonly kind: string | null;
  readonly confidence: string | null;
  readonly about_client: boolean;
  readonly client_account: string | null;
  readonly client_measure: string | null;
  readonly source_key?: never;
}

export type ExternalRefusal = 'source-key-present' | 'unretrieved' | 'insecure-source';

/** A claim the screen REFUSED TO RENDER as external knowledge, and why. */
export interface RefusedClaim {
  readonly reason: ExternalRefusal;
  readonly detail: string;
  /** What arrived, verbatim, so the refusal can be audited rather than trusted. */
  readonly raw: Record<string, unknown>;
}

export interface ExternalReading {
  readonly claims: readonly ExternalClaim[];
  readonly refused: readonly RefusedClaim[];
}

/**
 * ===========================================================================
 * THE LAST-MILE RULE 21 CHECK
 * ===========================================================================
 * src/lib/web/facts.ts refuses a `source_key` when a fact is BUILT, and the
 * 0008 migration has no column to store one. This is the same refusal made a
 * third time, at the last boundary before pixels, and it is not redundant: the
 * screen renders whatever JSON a tool row happens to contain, and that row is
 * written from a `content` string. A claim that arrived wearing a citation is
 * shown AS A REFUSAL — never dropped, because a silently dropped claim is
 * indistinguishable from a page that published nothing.
 *
 * `hasOwnProperty` rather than a truthiness test: `source_key: null` and
 * `source_key: ''` are still a field that should not exist.
 *
 * The other two refusals are rule 21's positive half. An external claim carries
 * its URL and its retrieval date BY DEFINITION; one that carries neither is not
 * a weaker external fact, it is an unattributed sentence, which is exactly what
 * this screen must never place beside a measurement.
 */
export function readExternalClaims(payload: Record<string, unknown>): ExternalReading {
  const claims: ExternalClaim[] = [];
  const refused: RefusedClaim[] = [];

  for (const raw of readRecords(payload, 'facts')) {
    if (Object.prototype.hasOwnProperty.call(raw, 'source_key')) {
      refused.push({
        reason: 'source-key-present',
        detail:
          'This claim arrived carrying a source key. A source key names a value this codebase computed, ' +
          'and a sentence read off a web page was not computed here. It is not shown as an external fact.',
        raw,
      });
      continue;
    }

    const claim = readString(raw, 'claim');
    const sourceUrl = readString(raw, 'source_url');
    const retrievedAt = readString(raw, 'retrieved_at');

    if (claim === null || sourceUrl === null || retrievedAt === null) {
      refused.push({
        reason: 'unretrieved',
        detail:
          'An external claim carries the address it was published at and the moment it was read. ' +
          'One of the three — the claim, the URL, the retrieval instant — is missing, so this is an ' +
          'unattributed sentence rather than a retrieved fact.',
        raw,
      });
      continue;
    }

    if (!sourceUrl.startsWith('https://')) {
      refused.push({
        reason: 'insecure-source',
        detail: `A source URL must be https. This claim gives ${JSON.stringify(sourceUrl)}.`,
        raw,
      });
      continue;
    }

    claims.push({
      claim,
      source_url: sourceUrl,
      page_title: readString(raw, 'page_title'),
      retrieved_at: retrievedAt,
      topic: readString(raw, 'topic'),
      kind: readString(raw, 'kind'),
      confidence: readString(raw, 'confidence'),
      about_client: readBoolean(raw, 'about_client') ?? false,
      client_account: readString(raw, 'client_account'),
      client_measure: readString(raw, 'client_measure'),
    });
  }

  return { claims, refused };
}

/**
 * The host of a URL, for a reader who should see WHO published a claim before
 * reading it. Null when the string does not parse — never a guessed substring,
 * because a wrong host under a real claim is a false attribution.
 */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
