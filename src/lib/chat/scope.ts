import type { StrategistPayload } from '../types/db.ts';

/**
 * ===========================================================================
 * THE ASK SCOPE — a typed reference to one object, and nothing else
 * ===========================================================================
 *
 * The operator's complaint was that the chat is a tab rather than a layer: to
 * ask about the post in front of you, you leave the Board, open Chat, and type
 * the post back out from memory. The fix is an Ask affordance on every object
 * that can be asked about. This module is the contract that affordance travels
 * on, and src/components/AskAbout.tsx is a thin renderer over it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE DECISION THIS FILE EXISTS TO MAKE: THE LABEL DOES NOT TRAVEL.
 * ---------------------------------------------------------------------------
 * The obvious implementation of "ask about this post" is to open the chat with
 * a sentence pre-typed into it — «اسأل عن هذا البوست: <caption>». That sentence
 * is attacker-controlled text taking a free ride into the model's context: the
 * caption of an Instagram post is written by whoever wrote the post, the digest
 * statement is written by a model, and neither is the operator asking anything.
 * A scope that is a STRING is a prompt-injection surface with a nice name on it.
 *
 * So the serialised form carries a KIND and IDENTIFIERS and NOTHING ELSE:
 *
 *     post:2f1c6b6e-0f0a-4d1e-9a3b-5c6d7e8f9a0b
 *     digest_entry:9c8b…:concerns:2
 *
 * Every segment is checked against a shape before it is believed — a kind
 * against a closed tuple, an id against the canonical uuid form, a section
 * against a closed tuple, an index against a bounded decimal. There is no
 * segment in which prose can be written, so there is no segment through which
 * prose can arrive. The chat route then LOADS the object it names out of the
 * database it already trusts, and the label the reader saw on the card is
 * re-derived server-side from the row rather than accepted from the client.
 *
 * The human label is therefore a PROP OF THE COMPONENT and not a field of the
 * scope. It names the object in the button's accessible name — where a screen
 * reader needs it and a model never sees it — and it is deliberately absent
 * from `encodeAskScope`. tests/ask-about.test.ts holds that line.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE UNDER src/lib/ AND NOT A CONST IN THE COMPONENT.
 * ---------------------------------------------------------------------------
 * Two reasons, the same two that put `resolveReceipt` in src/lib/theme.ts and
 * the transcript reader in ./transcript.ts:
 *
 *   1. `node --test --experimental-strip-types` cannot load a .tsx file. A
 *      contract whose whole job is to refuse hostile input, living somewhere no
 *      test can reach it, is a contract nobody has ever executed.
 *   2. BOTH ENDS MUST READ THE SAME LIST. The affordance encodes; the chat
 *      surface decodes; a later phase's route resolves. Three copies of one
 *      grammar is how the third one drifts. This is a leaf — no zod, no React,
 *      no Supabase, one erased type import — so every end can hold it.
 * ======================================================================== */

/* ================================================================= shape == */

/** The query parameter the chat surface reads a scope out of: `/chat?about=…`. */
export const ASK_SCOPE_PARAM = 'about';

/** Where an Ask goes. Named here so the affordance and the reader agree. */
export const ASK_SCOPE_PATH = '/chat';

/**
 * THE CLOSED ALLOW-LIST OF ASKABLE OBJECTS.
 *
 * A tuple rather than the keys of a record, and membership is tested with
 * `includes` rather than a property lookup, for the reason src/lib/agent/chat/
 * tools.ts gives about `CHAT_TOOL_NAMES`: every JavaScript object answers to
 * `__proto__`, `constructor` and `toString` for free, and a lookup table would
 * hand one of them back as if it were a kind.
 *
 * Both members are MOUNTED. Nothing is listed here that no surface can reach —
 * a kind that exists only in this file is a lookup built, tested and unreachable,
 * which is the exact defect the chat tool registry was corrected for.
 */
export const ASK_SCOPE_KINDS = ['post', 'digest_entry'] as const;
export type AskScopeKind = (typeof ASK_SCOPE_KINDS)[number];

/**
 * The lists inside a stored digest payload an entry may point into. Each is a
 * plain array on `digests.payload`, so resolving one is a read of the row and
 * an index into it — no search, no matching, no guessing which entry was meant.
 *
 * `actions` and `operator_notes` are absent because no Ask is mounted on them
 * yet; they are one line here and one mount there when that phase comes.
 */
export const DIGEST_SECTIONS = [
  'corrections',
  'deltas',
  'wins',
  'concerns',
  'decisions',
] as const;
export type DigestSection = (typeof DIGEST_SECTIONS)[number];

/**
 * Compile-time proof that every section above names a LIST that actually exists
 * on the stored payload. `tsc` fails here if a section is renamed in the type
 * and not here, which is the failure mode a string union cannot otherwise catch:
 * the encoder would keep producing `digest_entry:…:wins:0` long after the field
 * stopped being called `wins`, and the refusal would arrive at the reader.
 */
type PayloadListKeys = {
  [K in keyof StrategistPayload]: StrategistPayload[K] extends readonly unknown[] ? K : never;
}[keyof StrategistPayload];
type Assert<T extends true> = T;
type SectionsNameRealLists = Assert<DigestSection extends PayloadListKeys ? true : false>;

/** One post on the Board — `posts.id`. */
export interface PostScope {
  readonly kind: 'post';
  readonly post_id: string;
}

/**
 * One entry of one stored digest, identified the only way it can be: a digest
 * has an id, but the delta, win, concern, correction and proposed decision
 * inside it are array members and have none. The triple (digest, section,
 * position) is that entry's identity — composite, but still a reference the
 * server resolves against a row rather than a description it has to interpret.
 */
export interface DigestEntryScope {
  readonly kind: 'digest_entry';
  readonly digest_id: string;
  readonly section: DigestSection;
  readonly index: number;
}

export type AskScope = PostScope | DigestEntryScope;

/* ============================================================== refusals == */

/**
 * Why a scope was not believed. A closed vocabulary rather than a message,
 * because a refusal reason gets rendered and logged, and a free-text reason is
 * one more string nobody wrote and no source explains (hard rule 2).
 *
 * `absent` is the ordinary case, not a fault: someone opened /chat directly.
 */
export const ASK_SCOPE_REFUSALS = [
  'absent',
  'too_long',
  'malformed',
  'unknown_kind',
  'wrong_arity',
  'not_an_id',
  'not_a_section',
  'not_an_index',
] as const;
export type AskScopeRefusal = (typeof ASK_SCOPE_REFUSALS)[number];

export type AskScopeResult =
  | { readonly ok: true; readonly scope: AskScope }
  | { readonly ok: false; readonly refusal: AskScopeRefusal };

/* ================================================================ grammar == */

const SEPARATOR = ':';

/**
 * The longest scope this allow-list can express is a digest entry: twelve
 * characters of kind, a 36-character uuid, an eleven-character section, four
 * digits and three separators — 66. The cap is checked BEFORE any pattern runs,
 * so a megabyte of query string is refused by a length comparison and never
 * reaches a regular expression.
 */
export const ASK_SCOPE_MAX_LENGTH = 128;

/**
 * Canonical lowercase uuid, which is the only form Postgres emits. Accepting
 * `A1B2…` as well would make one row addressable by two strings, and two
 * strings is two scope banners, two conversation titles and two of everything
 * downstream that ever keys on the encoded form.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A position in a stored list: plain decimal, no sign, no leading zero, at most
 * four digits. The bound is structural rather than measured — an index needing
 * five digits is not a position in a weekly digest, it is a payload — and the
 * leading-zero rule is what makes the encoding canonical, so `wins:01` is not a
 * second spelling of `wins:1`.
 */
const INDEX = /^(?:0|[1-9][0-9]{0,3})$/;

/** How many segments follow the kind. Checked before any segment is read. */
const ARITY: Record<AskScopeKind, number> = { post: 1, digest_entry: 3 };

export function isAskScopeKind(name: string): name is AskScopeKind {
  return (ASK_SCOPE_KINDS as readonly string[]).includes(name);
}

export function isDigestSection(name: string): name is DigestSection {
  return (DIGEST_SECTIONS as readonly string[]).includes(name);
}

/* =============================================================== encoding == */

/**
 * The scope as one canonical string. Total, and deliberately unvalidating: the
 * one gate is `parseAskScope`, and `askScopeHref` below runs the output of this
 * function back through it rather than trusting either side twice.
 */
export function encodeAskScope(scope: AskScope): string {
  if (scope.kind === 'post') {
    return `${scope.kind}${SEPARATOR}${scope.post_id}`;
  }
  return [scope.kind, scope.digest_id, scope.section, String(scope.index)].join(SEPARATOR);
}

function refuse(refusal: AskScopeRefusal): AskScopeResult {
  return { ok: false, refusal };
}

/**
 * The one gate. Everything that arrives from a URL, a link, a paste or a
 * bookmark comes through here, and nothing that fails is repaired: a scope this
 * cannot read is refused, never coerced into the nearest thing it might mean.
 */
export function parseAskScope(raw: string | null | undefined): AskScopeResult {
  if (raw === null || raw === undefined) return refuse('absent');
  if (raw.length > ASK_SCOPE_MAX_LENGTH) return refuse('too_long');

  // A value that is only whitespace is nobody asking anything. A value with
  // whitespace ANYWHERE ELSE is refused rather than trimmed into shape: a scope
  // is a reference, a reference with a space in it is prose, and the interesting
  // hostile input is exactly the sentence that opens with a plausible kind.
  // Trimming the edges would also cost canonicity — `askScopeHref` never emits a
  // padded scope, so accepting one is a second URL for one object.
  if (raw.trim().length === 0) return refuse('absent');
  if (/\s/.test(raw)) return refuse('malformed');

  const parts = raw.split(SEPARATOR);
  const kind = parts[0];
  if (!isAskScopeKind(kind)) return refuse('unknown_kind');
  if (parts.length !== ARITY[kind] + 1) return refuse('wrong_arity');

  if (kind === 'post') {
    const postId = parts[1];
    if (!UUID.test(postId)) return refuse('not_an_id');
    return { ok: true, scope: { kind: 'post', post_id: postId } };
  }

  const digestId = parts[1];
  if (!UUID.test(digestId)) return refuse('not_an_id');
  const section = parts[2];
  if (!isDigestSection(section)) return refuse('not_a_section');
  const index = parts[3];
  if (!INDEX.test(index)) return refuse('not_an_index');

  return {
    ok: true,
    scope: { kind: 'digest_entry', digest_id: digestId, section, index: Number(index) },
  };
}

/** The half of `URLSearchParams` this module needs, so a test needs no DOM. */
export interface ScopeParams {
  get(name: string): string | null;
}

/**
 * What the chat surface calls on its own search params. Absent is a refusal
 * like any other — `refusal === 'absent'` is "nobody asked about anything",
 * which is the ordinary /chat visit and not an error to report.
 */
export function readAskScope(params: ScopeParams): AskScopeResult {
  return parseAskScope(params.get(ASK_SCOPE_PARAM));
}

/**
 * Where the affordance points, or null when this scope would not survive its
 * own round trip.
 *
 * The null is the point. `AskScope` says `post_id: string`, and `tsc` cannot
 * tell a uuid from a caption — so a mount site holding a malformed id would
 * otherwise render a link onto a scope the reader's own chat screen is about to
 * refuse. A button that lands on a refusal is the dead-button failure this
 * whole version exists to remove, so there is no button: same contract as the
 * receipt chip, which shows no chip rather than an empty one.
 */
export function askScopeHref(scope: AskScope): string | null {
  const encoded = encodeAskScope(scope);
  if (!parseAskScope(encoded).ok) return null;
  return `${ASK_SCOPE_PATH}?${ASK_SCOPE_PARAM}=${encodeURIComponent(encoded)}`;
}
