import type { SupabaseClient } from '@supabase/supabase-js';
import type { RetrievalEvidence } from './facts.ts';

/**
 * ===========================================================================
 * THE NETWORK BOUNDARY — hard rules 22, 9 and 15
 * ===========================================================================
 *
 * Every outbound request to the open web goes through this file, and every one
 * of them is:
 *
 *   OPERATOR-TRIGGERED OR SCHEDULED. `FetchTrigger` is a union of exactly two
 *   members and there is no third. A tool cannot fetch on its own initiative
 *   mid-sentence because there is no value it could pass to say so, and
 *   `web_retrievals.trigger` carries the same CHECK in the database, so the
 *   refusal survives a caller that bypasses this module entirely.
 *
 *   LEDGERED BEFORE IT HAPPENS. The row in `web_retrievals` is written by the
 *   same statement that takes the cap unit, BEFORE the request goes out. A
 *   ledger written afterwards records only what succeeded, so the two things
 *   most worth seeing — the request that was refused and the request that hung —
 *   are the two it cannot show.
 *
 *   COUNTED. `web_reserve_fetch` is a one-statement check-and-increment under
 *   the day row's lock, for the reason 0005_mcp_reservations.sql gives at
 *   length: "read `used`, then act" is not atomic across concurrent Worker
 *   isolates.
 *
 * ---------------------------------------------------------------------------
 * THE DISCIPLINE IS media.ts's, DELIBERATELY
 * ---------------------------------------------------------------------------
 * src/lib/ingest/media.ts is the one existing outbound path with a real guard,
 * and it was read before this was written: URL parsed with `new URL()`,
 * non-https refused, host matched by exact-or-dotted-suffix rather than
 * `includes`, failure COUNTED rather than thrown, byte ceiling enforced twice.
 * This file keeps all of that and adds the three things a general web fetch
 * needs that a known-CDN fetch does not: redirects followed BY HAND with the
 * guard re-run on every hop, a body read through a capped reader instead of
 * `arrayBuffer()`, and a content-type allow-list.
 *
 * (It does NOT copy src/lib/brain/canon/embed.ts, which has no timeout at all.
 * That is a pre-existing gap, not a pattern.)
 *
 * ---------------------------------------------------------------------------
 * WHY NO HOST ALLOW-LIST, AND WHAT REPLACES IT
 * ---------------------------------------------------------------------------
 * media.ts can allow-list because it fetches Instagram's CDN and nothing else.
 * The operator's ask here is the WIDER WEB, so an allow-list would either be
 * useless or would have to be edited before every lookup. The posture is
 * therefore a documented DENY, and its shape is the one lesson v5 already paid
 * for elsewhere:
 *
 *     NO IP LITERALS AT ALL — not "no private ones".
 *
 * Enumerating the private RANGES across every spelling an IPv4 literal has
 * (`127.0.0.1`, `0177.0.0.1`, `2130706433`, `0x7f000001`, `[::ffff:127.0.0.1]`)
 * is a race between an enumeration and an alphabet, which is exactly the
 * primitive src/lib/brain/substitute.ts abandoned for numbers and for the same
 * reason. So the rule is stated POSITIVELY instead: a host must LOOK LIKE A
 * PUBLIC DNS NAME — at least two labels, a final label of ASCII letters or a
 * punycode prefix, and not one of the reserved suffixes. A public page worth
 * reading has a name.
 *
 * That rule needs no knowledge of ranges or bases, and MEASURED against this
 * runtime it does not need any: WHATWG parsing normalises all four IPv4
 * spellings above to `127.0.0.1` before the guard sees them, so each ends in a
 * numeric final label and is refused as an address. A spelling invented next
 * year either normalises the same way or fails to look like a name, and both
 * outcomes are a refusal. The check is not racing anything.
 *
 * ---------------------------------------------------------------------------
 * THE RESIDUAL, STATED PLAINLY: DNS
 * ---------------------------------------------------------------------------
 * This guard checks the NAME. It cannot check what the name RESOLVES to — no
 * resolver is reachable from a Worker — so a public name pointed at 127.0.0.1
 * (`localtest.me` and friends), or one that rebinds between the check and the
 * connection, passes this file.
 *
 * WHAT ACTUALLY CLOSES THAT, and it is already in the tree: wrangler.jsonc sets
 * the `global_fetch_strictly_public` compatibility flag, so on Workers the
 * runtime itself refuses to route a subrequest to a private address whatever DNS
 * answers. The name check is the braces — it works in `next dev`, in tests, and
 * it refuses the obvious attempt before a socket is opened — and the flag is the
 * belt. Neither is claimed to be the whole answer.
 *
 * ---------------------------------------------------------------------------
 * PURITY, AS FAR AS IT GOES
 * ---------------------------------------------------------------------------
 * `guardUrl`, `estimateWebFetch`, `checkWebBudget`, `pageTitle` and the decoding
 * helpers are pure and are exported so they can be executed with no network.
 * `fetchExternal` takes its ledger, its Amman day, its retrieval instant and
 * (optionally) its fetch implementation as ARGUMENTS: no clock, no environment
 * and no database handle is built here. That is what lets the whole path run
 * under `node --test --experimental-strip-types` against a fake.
 */

/* ============================================================ the caps ==== */

/**
 * HARD CAP — the most external fetches one Amman day will ever carry.
 *
 * A constant and not an environment variable, for MAX_MIRROR_OBJECTS's reason:
 * an operator may turn research on or off and may LOWER this for one call, but
 * cannot talk the number upwards without a code change somebody reviews. Rule 22
 * is a bound on activity, and a bound an operator can raise at will is a
 * preference.
 */
export const MAX_FETCHES_PER_DAY = 40;

/** A hung server must not hold the request open. Bounds the WHOLE redirect chain. */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Per-page ceiling, enforced on the declared `content-length` AND on the bytes
 * actually read. A quarter of media.ts's ceiling because this is text: a page
 * whose readable content does not fit in a megabyte is not a page, it is a feed.
 */
export const MAX_PAGE_BYTES = 1024 * 1024;

/** Hops followed by hand. Five is generous; a chain longer than this is a loop. */
export const MAX_REDIRECTS = 5;

/**
 * What this module is willing to read. Text only — no images, no archives, no
 * executables. A byte stream this app cannot turn into a quotable sentence has
 * no business being downloaded on the client's bandwidth.
 */
const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'application/xhtml+xml',
  'application/json',
  'application/xml',
  'text/xml',
];

/**
 * Suffixes that never name a public host. `arpa` is a real public TLD and is
 * here anyway: `in-addr.arpa` and `home.arpa` are the two things under it worth
 * refusing, and nothing under it is worth reading.
 */
const RESERVED_SUFFIXES = [
  'local', 'localhost', 'localdomain', 'internal', 'intranet', 'private', 'corp',
  'home', 'lan', 'test', 'example', 'invalid', 'onion', 'arpa', 'alt',
];

/** A public TLD: ASCII letters, or a punycode label. Never digits. */
const PUBLIC_TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

/** A DNS label. Refuses the empty label a doubled dot produces. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Digits only — an IPv4 literal's last label, in decimal or as a whole. */
const ALL_DIGITS = /^\d+$/;

/* ========================================================= rule 9 / 15 ==== */

/**
 * USD per query, by provider. `null` means NO PUBLISHED RATE HAS BEEN VERIFIED,
 * and rule 15 makes that BLOCK rather than proceed — the same contract, and the
 * same semantics for null, as ACTOR_RATES in src/lib/ingest/budget.ts.
 *
 * `direct` is zero, and the zero is a claim that deserves its reason: a plain
 * https GET from the Worker to a public URL is not billed per query by anybody.
 * Cloudflare counts it as a SUBREQUEST against a per-invocation ceiling, which
 * is a count and not a price. So money is not the binding constraint on this
 * path — MAX_FETCHES_PER_DAY is — and the zero says exactly that rather than
 * pretending the resource is free.
 *
 * The other two are the paths that DO bill per query. Neither is implemented,
 * and neither has a rate verified in this codebase, so both refuse. Adding one
 * means putting its store page in front of you and writing the number here,
 * exactly as budget.ts requires for an actor.
 */
export const WEB_PROVIDER_RATES: Readonly<Record<string, number | null>> = {
  direct: 0,
  openrouter_web_plugin: null,
  search_api: null,
};

/** The only provider `fetchExternal` implements. */
export const DIRECT_PROVIDER = 'direct';

export interface WebFetchEstimate {
  /** Estimated cost in USD, or null when it could not be computed. */
  usd: number | null;
  rate_per_query: number | null;
}

export interface WebBudgetDecision {
  allowed: boolean;
  /** Why it was blocked. Null when allowed. */
  reason: string | null;
}

/**
 * Cost of `queries` calls to a provider, before any of them are made. An
 * unknown provider and a provider with no verified rate are deliberately
 * indistinguishable: both mean "cannot estimate", and both block.
 */
export function estimateWebFetch(args: { provider: string; queries: number }): WebFetchEstimate {
  const rate = Object.hasOwn(WEB_PROVIDER_RATES, args.provider)
    ? (WEB_PROVIDER_RATES[args.provider] ?? null)
    : null;
  if (rate === null) return { usd: null, rate_per_query: null };

  const { queries } = args;
  if (!Number.isFinite(queries) || queries < 0) return { usd: null, rate_per_query: rate };

  const count = Math.ceil(queries);
  // toFixed before ceil, for budget.ts's reason: binary floating point turns
  // exact cent products into 270.00000000000003 and a naive ceil adds a cent.
  const cents = Math.ceil(Number((rate * count * 100).toFixed(6)));
  return { usd: cents / 100, rate_per_query: rate };
}

/**
 * The spend gate. Deliberately the same DECISION TABLE as `checkBudget()` in
 * src/lib/ingest/budget.ts — null estimate blocks, null budget allows, a budget
 * of zero is a real ceiling of zero, and a negative or unparseable budget blocks
 * as a misconfiguration and is never read as "unlimited". The wording differs
 * because the vocabulary differs (queries, not results; no APIFY_BUDGET_USD);
 * the behaviour does not, and tests/external-facts.test.ts pins every branch.
 */
export function checkWebBudget(args: {
  estimate: WebFetchEstimate;
  budgetUsd: number | null | undefined;
}): WebBudgetDecision {
  const budgetUsd = args.budgetUsd ?? null;

  if (args.estimate.usd === null) {
    return {
      allowed: false,
      reason:
        'Cost could not be estimated: no verified per-query rate for this provider. Blocked because ' +
        'the rule is estimate before spend, and an unverifiable price is not a low one.',
    };
  }
  if (budgetUsd === null) return { allowed: true, reason: null };
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    return {
      allowed: false,
      reason:
        `The web research budget is set to an unusable value (${String(budgetUsd)}). Fix it or clear ` +
        'it — an unreadable budget is never treated as unlimited.',
    };
  }
  if (args.estimate.usd > budgetUsd) {
    return {
      allowed: false,
      reason: `Estimated $${args.estimate.usd.toFixed(2)} exceeds the ceiling of $${budgetUsd.toFixed(2)}.`,
    };
  }
  return { allowed: true, reason: null };
}

/* ============================================================ the guard === */

export type UrlRefusal =
  /** `new URL()` could not read it. */
  | 'unparseable'
  | 'not-https'
  /** `https://user:pass@host` — a credential in a URL, and a parser-confusion classic. */
  | 'credentials-in-url'
  /** A port is how an internal service is reached on an otherwise public name. */
  | 'non-default-port'
  /** The host is an address, in any spelling. See the header. */
  | 'ip-literal'
  /** The host does not look like a public DNS name. */
  | 'not-a-public-name'
  /** `.local`, `.internal`, `.localhost` and the rest. */
  | 'reserved-suffix';

export type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: UrlRefusal; detail: string };

/**
 * Whether this URL may be requested. PURE — no network, no DNS, no clock — so
 * the whole policy can be executed against a list of hostile strings.
 *
 * Run on the URL the caller asked for AND, unchanged, on every redirect target.
 * One implementation, because a second guard that nearly agreed with this one is
 * how a redirect reaches somewhere the first hop could not.
 */
export function guardUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'unparseable', detail: 'Not a URL this runtime can parse.' };
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'not-https',
      detail: `Only https is fetched; this is ${url.protocol.replace(':', '')}. Plain http is readable ` +
        'in transit, and the other schemes (file, data, ftp, gopher) are how a fetch reads a disk.',
    };
  }

  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      reason: 'credentials-in-url',
      detail: 'A URL carrying credentials is refused: this module authenticates to nothing, and the ' +
        'userinfo field is a long-standing way to make one parser disagree with another about the host.',
    };
  }

  // URL normalises away the scheme's default port, so a non-empty `port` is
  // always an explicit one.
  if (url.port !== '') {
    return {
      ok: false,
      reason: 'non-default-port',
      detail: `Port ${url.port} was named explicitly. Public pages are served on the default https ` +
        'port; an explicit port is how an internal service is reached on a name that looks public.',
    };
  }

  const host = url.hostname.toLowerCase();

  // An IPv6 literal keeps its brackets in `hostname` and always holds a colon;
  // nothing else can put one there, the port having been split off already.
  // VERIFIED against this runtime rather than assumed: `https://[::ffff:127.0.0.1]/`
  // parses to the hostname `[::ffff:7f00:1]`, so the mapped-IPv4 spelling is
  // caught here and never reaches the label rules below.
  if (host.includes(':')) {
    return { ok: false, reason: 'ip-literal', detail: 'The host is an IPv6 address literal.' };
  }

  // A single trailing dot is a legal absolute name and must not create an empty
  // final label; anything past one dot is malformed.
  const bare = host.endsWith('.') ? host.slice(0, -1) : host;
  const labels = bare.split('.');

  if (bare.length === 0 || labels.length < 2) {
    return {
      ok: false,
      reason: 'not-a-public-name',
      detail: `"${host}" is a single label. "localhost", a container name and a search-domain ` +
        'shortcut all look like this; a public host does not.',
    };
  }
  if (!labels.every((label) => DNS_LABEL.test(label))) {
    return {
      ok: false,
      reason: 'not-a-public-name',
      detail: `"${host}" contains a label that is not a DNS label.`,
    };
  }

  const tld = labels[labels.length - 1];
  if (!PUBLIC_TLD.test(tld)) {
    // A numeric final label means the whole host was an address, whatever base
    // it was written in. Reported as what it is rather than as a bad name.
    return ALL_DIGITS.test(tld)
      ? { ok: false, reason: 'ip-literal', detail: `"${host}" is an address literal, not a name.` }
      : {
          ok: false,
          reason: 'not-a-public-name',
          detail: `"${host}" does not end in a public top-level domain.`,
        };
  }
  if (RESERVED_SUFFIXES.includes(tld)) {
    return {
      ok: false,
      reason: 'reserved-suffix',
      detail: `".${tld}" is a reserved suffix and never names a host on the public internet.`,
    };
  }

  return { ok: true, url };
}

/* ========================================================== the ledger ==== */

export interface ReserveRequest {
  /** ISO date, `YYYY-MM-DD`. Supplied; this module never decides what day it is. */
  readonly amman_day: string;
  /** The URL AS REQUESTED, verbatim. */
  readonly url: string;
  readonly host: string;
  readonly trigger: 'operator' | 'schedule';
  readonly triggered_by: string;
  readonly limit: number;
  readonly estimated_usd: number | null;
}

export interface ReserveOutcome {
  readonly granted: boolean;
  /** Null when refused. */
  readonly retrieval_id: string | null;
  readonly fetches_reserved_today: number;
}

export interface SettleRequest {
  readonly retrieval_id: string;
  readonly status: 'ok' | 'refused' | 'failed';
  readonly http_status: number | null;
  readonly bytes: number | null;
  readonly final_url: string | null;
  readonly note: string | null;
}

/**
 * The two ledger operations, as an interface rather than a Supabase client.
 *
 * So that the whole of `fetchExternal` — the guard, the reservation ordering,
 * the redirect walk, the settlement — can be EXECUTED in a test against a fake
 * that records what it was asked to do. A module whose only path to its own
 * ordering guarantee runs through a live database is a module whose ordering
 * guarantee is never tested.
 */
export interface WebLedger {
  reserve(request: ReserveRequest): Promise<ReserveOutcome>;
  /** Records an outcome. Must not throw: a settle failure may not lose a body. */
  settle(request: SettleRequest): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The first row of a `returns table (...)` RPC result, or null. */
function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return isRecord(row) ? row : null;
}

/**
 * The RPC answer, narrowed from `unknown` — the whole of it, as a pure function.
 *
 * EXPORTED AND PURE ON PURPOSE. A shape that came back over the wire has no
 * type, and the property that matters is not "it usually parses": it is that an
 * answer this code CANNOT read must be treated as A REFUSAL. That is a false
 * refusal, which is the safe direction to be wrong in and the same direction
 * 0005's own `insert ... on conflict` race resolves in. Lifting it out of the
 * Supabase closure is what makes it executable: a test can hand it a truncated
 * row, a string, a null and an error without constructing a database client.
 */
export function readReserveOutcome(
  data: unknown,
  error: { message: string } | null,
): ReserveOutcome {
  if (error !== null) return { granted: false, retrieval_id: null, fetches_reserved_today: 0 };

  const row = firstRow(data);
  const id = row === null ? null : row['retrieval_id'];
  const used = row === null ? null : row['fetches_reserved_today'];

  // `granted` must be the literal true AND an id must have come back with it. A
  // row that claims a grant with no id is unusable — there would be nothing to
  // settle against — so it is refused rather than half-honoured.
  const granted = row !== null && row['granted'] === true && typeof id === 'string';

  return {
    granted,
    // NO GRANT, NO ID. Reported as null even when the payload carried one,
    // because an id outside a grant is an invitation to settle a row that was
    // never reserved — and `web_reserve_fetch` itself returns `null::uuid` on
    // refusal, so this is the shape the database already promises.
    retrieval_id: granted && typeof id === 'string' ? id : null,
    fetches_reserved_today: typeof used === 'number' ? used : 0,
  };
}

/** The real ledger, over the two functions 0008_external_facts.sql defines. */
export function supabaseWebLedger(db: SupabaseClient): WebLedger {
  return {
    async reserve(request: ReserveRequest): Promise<ReserveOutcome> {
      const response: { data: unknown; error: { message: string } | null } = await db.rpc(
        'web_reserve_fetch',
        {
          p_day: request.amman_day,
          p_url: request.url,
          p_host: request.host,
          p_trigger: request.trigger,
          p_triggered_by: request.triggered_by,
          p_limit: request.limit,
          p_estimated_usd: request.estimated_usd,
        },
      );
      return readReserveOutcome(response.data, response.error);
    },

    async settle(request: SettleRequest): Promise<void> {
      // Swallowed on purpose. The fetch already happened and its result is
      // already in the caller's hands; throwing here would discard a page that
      // was paid for because the bookkeeping call failed. The open row is the
      // visible evidence that this happened.
      try {
        await db.rpc('web_settle_retrieval', {
          p_retrieval: request.retrieval_id,
          p_status: request.status,
          p_http_status: request.http_status,
          p_bytes: request.bytes,
          p_final_url: request.final_url,
          p_note: request.note,
        });
      } catch {
        /* deliberately ignored; see above */
      }
    },
  };
}

/* ========================================================= the retrieval == */

/**
 * Rule 22 in the type system: a fetch is triggered by a person or by a named
 * schedule, and there is no third member for a model to reach for.
 */
export type FetchTrigger =
  | { readonly kind: 'operator'; readonly operator: string }
  | { readonly kind: 'schedule'; readonly schedule: string };

/** One completed, ledgered retrieval. Satisfies `RetrievalEvidence` structurally. */
export interface Retrieval {
  readonly retrieval_id: string;
  readonly requested_url: string;
  readonly final_url: string;
  readonly retrieved_at: string;
  readonly page_title: string | null;
}

/**
 * Compile-time guard, no runtime emit: a `Retrieval` IS a `RetrievalEvidence`,
 * so `externalFact(retrieval, draft, identity)` needs no adapter. If either type
 * drifts, this file fails to compile here rather than at a call site.
 */
type Assert<T extends true> = T;
type _RetrievalIsEvidence = Assert<Retrieval extends RetrievalEvidence ? true : false>;

export type FetchRefusal =
  /** Rule 15: no verified per-query rate, or over the ceiling. Refused before the ledger. */
  | 'unpriced'
  | 'over-budget'
  /** The URL could not be parsed, so there is no host to ledger. Before the ledger. */
  | 'unparseable'
  /** The day's cap is spent. */
  | 'capped'
  /** The guard refused it. Ledgered and counted; no request went out. */
  | 'refused-url'
  /** A redirect pointed somewhere the guard refuses. Requests HAD gone out. */
  | 'redirect-refused'
  | 'too-many-redirects'
  /** Threw, timed out, or the connection failed. */
  | 'transport'
  /** Answered with a non-2xx. */
  | 'http-error'
  /** Answered with something this module will not read. */
  | 'not-text';

export type FetchOutcome =
  | {
      ok: true;
      retrieval: Retrieval;
      /** The decoded page text, capped at MAX_PAGE_BYTES. */
      body: string;
      content_type: string;
      http_status: number;
      bytes: number;
      /** True when the page was longer than the cap and was cut. */
      truncated: boolean;
      /** Every hop after the first, in order. Empty when there was no redirect. */
      redirects: readonly string[];
      fetches_reserved_today: number;
      estimated_usd: number | null;
    }
  | {
      ok: false;
      reason: FetchRefusal;
      detail: string;
      /** The ledger row, when one was taken. Null when refused before the ledger. */
      retrieval_id: string | null;
      /** Null when the cap was never consulted. */
      fetches_reserved_today: number | null;
      /** Present on `http-error` and `not-text`: the server did answer. */
      http_status: number | null;
    };

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchExternalOptions {
  readonly url: string;
  readonly trigger: FetchTrigger;
  /** ISO date, `YYYY-MM-DD`. Supplied by the caller; no clock is read here. */
  readonly ammanDay: string;
  /** ISO instant the retrieval is recorded at. Supplied for the same reason. */
  readonly retrievedAt: string;
  /** Lowers MAX_FETCHES_PER_DAY for this call. A higher value is clamped down. */
  readonly dailyCap?: number;
  /** Which priced path this is. Anything but `direct` has no verified rate and blocks. */
  readonly provider?: string;
  /** USD ceiling for this call. Null or omitted means no ceiling is configured. */
  readonly budgetUsd?: number | null;
  /** Test seam. Production passes nothing and the global `fetch` is used. */
  readonly fetchImpl?: FetchImpl;
}

/** Who or what asked, flattened for the ledger's two columns. */
function triggerColumns(trigger: FetchTrigger): { trigger: 'operator' | 'schedule'; triggered_by: string } {
  return trigger.kind === 'operator'
    ? { trigger: 'operator', triggered_by: trigger.operator }
    : { trigger: 'schedule', triggered_by: trigger.schedule };
}

/** `text/html; charset=utf-8` -> `text/html`. */
function mediaType(header: string | null): string {
  return header === null ? '' : (header.split(';')[0] ?? '').trim().toLowerCase();
}

/** The charset label, or null. Only used to pick a decoder. */
function charsetOf(header: string | null): string | null {
  if (header === null) return null;
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(header);
  return match === null ? null : match[1].toLowerCase();
}

/**
 * Reads at most `cap` bytes, then stops and cancels the rest.
 *
 * `arrayBuffer()` — what media.ts uses — buffers the WHOLE body before anything
 * can be checked, which is safe for a CDN thumbnail behind a declared
 * content-length and is not safe for an arbitrary page that may be chunked and
 * unbounded. Reading through the reader means the cap is enforced on the way in
 * rather than after the fact, so an endless response costs `cap` bytes and then
 * the connection is dropped.
 */
async function readCapped(
  response: Response,
  cap: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const body = response.body;
  if (body === null) return { bytes: new Uint8Array(0), truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      const room = cap - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, truncated };
}

/**
 * Bytes to text, honouring the declared charset when the runtime knows it.
 *
 * windows-1256 is the reason this is not hard-coded to UTF-8: Arabic pages in
 * this region are still served in it, and a mis-decoded Arabic claim is stored
 * verbatim as mojibake — which is not a fabrication, but is a claim nobody can
 * read. An unknown label falls back to UTF-8 rather than throwing.
 */
export function decodeBody(bytes: Uint8Array, contentTypeHeader: string | null): string {
  const label = charsetOf(contentTypeHeader);
  if (label !== null) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch {
      /* unknown label; fall through to utf-8 */
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

const TITLE = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i;
const ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&lt;/gi, '<'],
  [/&gt;/gi, '>'],
  [/&quot;/gi, '"'],
  [/&#0*39;|&apos;/gi, "'"],
  [/&nbsp;/gi, ' '],
  [/&amp;/gi, '&'],
];

/**
 * The page's own `<title>`, or null when it has none.
 *
 * A regex over HTML, knowingly. It is used for a LABEL and never for a claim —
 * a claim is entered by an operator or an extractor and stored verbatim — so a
 * sloppy title is cosmetic, where a sloppy claim would not be. `&amp;` is
 * decoded last so `&amp;lt;` does not become `<`.
 */
export function pageTitle(html: string): string | null {
  const match = TITLE.exec(html);
  if (match === null) return null;
  let title = match[1];
  for (const [pattern, replacement] of ENTITIES) title = title.replace(pattern, replacement);
  title = title.replace(/\s+/gu, ' ').trim();
  return title.length > 0 ? title : null;
}

/* =========================================================== the fetch ==== */

/**
 * Fetch one public page, ledgered and counted.
 *
 * ===========================================================================
 * THE ORDER OF OPERATIONS IS THE DESIGN. It is:
 *
 *   1. ESTIMATE, and block on an unverifiable price (rules 9 and 15).
 *   2. PARSE, only far enough to learn the host.
 *   3. RESERVE — the cap unit and the ledger row, in one statement.
 *   4. GUARD in full.
 *   5. FETCH, following redirects by hand and re-guarding each hop.
 *   6. SETTLE.
 *
 * WHY 1 IS BEFORE 3 AND 4 IS AFTER IT. Those two placements answer different
 * questions and it is worth being explicit:
 *
 *   * A PRICING failure is a CONFIGURATION fault. It is identical for every URL,
 *     so it cannot be used to probe anything, and charging the day's cap for it
 *     would mean an operator fixes their config and finds the day already spent.
 *     It refuses before the ledger and costs nothing.
 *   * A GUARD failure is an INPUT fault, and input is where an attack lives. It
 *     is ledgered and it KEEPS its unit. If a refusal were free, an agent or a
 *     hostile payload could probe ten thousand internal addresses for nothing
 *     against a cap that never moved. Rule 22 bounds ACTIVITY, not only money,
 *     and a refused attempt is activity.
 *
 * WHY 2 STOPS AT THE HOST. `web_retrievals.host` is NOT NULL, so a string with
 * no host cannot be ledgered at all — the schema forces the one refusal that
 * legitimately precedes the ledger, and it is the narrowest possible one.
 *
 * IT NEVER THROWS. Every failure is a settled row and a typed refusal, for
 * media.ts's reason: the work that called this has its own results already, and
 * must not lose them because a page did not load.
 */
export async function fetchExternal(
  ledger: WebLedger,
  options: FetchExternalOptions,
): Promise<FetchOutcome> {
  const provider = options.provider ?? DIRECT_PROVIDER;
  const estimate = estimateWebFetch({ provider, queries: 1 });
  const budget = checkWebBudget({ estimate, budgetUsd: options.budgetUsd ?? null });

  /* -- 1. estimate before spend ------------------------------------------ */
  if (!budget.allowed) {
    return {
      ok: false,
      reason: estimate.usd === null ? 'unpriced' : 'over-budget',
      detail: budget.reason ?? 'Blocked by the spend gate.',
      retrieval_id: null,
      fetches_reserved_today: null,
      http_status: null,
    };
  }

  /* -- 2. parse, far enough to name a host ------------------------------- */
  let host: string;
  try {
    host = new URL(options.url).hostname.toLowerCase();
    if (host.length === 0) throw new Error('no host');
  } catch {
    return {
      ok: false,
      reason: 'unparseable',
      detail:
        'That string names no host, so there is nothing to ledger and nothing to request. This is the ' +
        'one refusal that precedes the ledger for an input reason, and the schema is what forces it: ' +
        'web_retrievals.host is NOT NULL.',
      retrieval_id: null,
      fetches_reserved_today: null,
      http_status: null,
    };
  }

  /* -- 3. reserve: the unit and the row, before the network -------------- */
  const requested = options.dailyCap;
  const cap =
    typeof requested === 'number' && Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_FETCHES_PER_DAY)
      : MAX_FETCHES_PER_DAY;

  const columns = triggerColumns(options.trigger);
  const reservation = await ledger.reserve({
    amman_day: options.ammanDay,
    url: options.url,
    host,
    trigger: columns.trigger,
    triggered_by: columns.triggered_by,
    limit: cap,
    estimated_usd: estimate.usd,
  });

  const retrievalId = reservation.retrieval_id;
  if (!reservation.granted || retrievalId === null) {
    return {
      ok: false,
      reason: 'capped',
      detail:
        `The external-fetch cap for ${options.ammanDay} is spent: ${reservation.fetches_reserved_today} ` +
        `attempt(s) of ${cap} have been taken. Nothing was requested.`,
      retrieval_id: null,
      fetches_reserved_today: reservation.fetches_reserved_today,
      http_status: null,
    };
  }

  const used = reservation.fetches_reserved_today;

  /**
   * The two settled failures, as TWO functions rather than one with a flag.
   *
   * They mean different things and the difference is enforced by the database:
   * a 'refused' row reached NOTHING, so it carries no status line, no
   * destination and no byte count, and `web_retrievals_refusal_reached_nothing`
   * rejects one that does. Written as a single helper with a
   * `status === 'refused' ? null : …` ternary, that rule lived in a branch no
   * test could reach — the only 'refused' call site passes no details, so the
   * ternary was dead code that looked like a guarantee. Two functions with no
   * branch is the same rule with nothing unexercised.
   */

  /** Refused before a socket was opened. Keeps its cap unit; reached nothing. */
  const refuseBeforeNetwork = async (reason: FetchRefusal, detail: string): Promise<FetchOutcome> => {
    await ledger.settle({
      retrieval_id: retrievalId,
      status: 'refused',
      http_status: null,
      bytes: null,
      final_url: null,
      note: detail,
    });
    return {
      ok: false,
      reason,
      detail,
      retrieval_id: retrievalId,
      fetches_reserved_today: used,
      http_status: null,
    };
  };

  /** A request went out and did not yield a page. Carries what it did reach. */
  const failAfterNetwork = async (
    reason: FetchRefusal,
    detail: string,
    reached: { http_status?: number; final_url?: string; bytes?: number },
  ): Promise<FetchOutcome> => {
    await ledger.settle({
      retrieval_id: retrievalId,
      status: 'failed',
      http_status: reached.http_status ?? null,
      bytes: reached.bytes ?? null,
      final_url: reached.final_url ?? null,
      note: detail,
    });
    return {
      ok: false,
      reason,
      detail,
      retrieval_id: retrievalId,
      fetches_reserved_today: used,
      http_status: reached.http_status ?? null,
    };
  };

  /* -- 4. the guard, in full --------------------------------------------- */
  const verdict = guardUrl(options.url);
  if (!verdict.ok) {
    return refuseBeforeNetwork('refused-url', `${verdict.reason}: ${verdict.detail}`);
  }

  /* -- 5. fetch, walking the redirect chain by hand ---------------------- */
  const doFetch: FetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  // ONE signal for the WHOLE chain, so five hops cannot cost five timeouts.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  let current = verdict.url;
  const redirects: string[] = [];
  let response: Response;

  for (let hop = 0; ; hop += 1) {
    if (hop > MAX_REDIRECTS) {
      return failAfterNetwork(
        'too-many-redirects',
        `More than ${MAX_REDIRECTS} redirects from ${options.url}. A chain this long is a loop.`,
        { final_url: current.toString() },
      );
    }

    let hopResponse: Response;
    try {
      hopResponse = await doFetch(current.toString(), {
        method: 'GET',
        // MANUAL, and this is the SSRF fix rather than a preference: `follow`
        // hands the chain to the platform, which will happily land on a host
        // this module already decided it would not request.
        redirect: 'manual',
        signal,
        headers: {
          accept: ALLOWED_CONTENT_TYPES.join(', '),
          'user-agent': 'ThinkQualityStudio/1.0 (read-only research)',
        },
      });
    } catch (err) {
      return failAfterNetwork(
        'transport',
        `The request to ${current.toString()} did not complete: ${err instanceof Error ? err.message : String(err)}`,
        { final_url: current.toString() },
      );
    }

    const location = hopResponse.status >= 300 && hopResponse.status < 400
      ? hopResponse.headers.get('location')
      : null;

    if (location === null) {
      response = hopResponse;
      break;
    }

    if (hopResponse.body !== null) await hopResponse.body.cancel().catch(() => undefined);

    // A Location may be relative. Resolving it against the CURRENT url is what
    // makes the next guard run on the real target rather than on a fragment.
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return failAfterNetwork(
        'redirect-refused',
        `${current.toString()} redirected to a Location this runtime cannot parse.`,
        { http_status: hopResponse.status, final_url: current.toString() },
      );
    }

    // THE SAME GUARD, on every hop. This is the whole point of walking by hand.
    const hopVerdict = guardUrl(next);
    if (!hopVerdict.ok) {
      return failAfterNetwork(
        'redirect-refused',
        `${current.toString()} redirected to ${next}, which is refused (${hopVerdict.reason}: ${hopVerdict.detail}). ` +
          'Settled as failed rather than refused because requests had already gone out.',
        { http_status: hopResponse.status, final_url: current.toString() },
      );
    }

    redirects.push(next);
    current = hopVerdict.url;
  }

  const finalUrl = current.toString();

  if (!response.ok) {
    if (response.body !== null) await response.body.cancel().catch(() => undefined);
    return failAfterNetwork(
      'http-error',
      `${finalUrl} answered ${response.status}.`,
      { http_status: response.status, final_url: finalUrl },
    );
  }

  const header = response.headers.get('content-type');
  const type = mediaType(header);
  if (!ALLOWED_CONTENT_TYPES.includes(type)) {
    if (response.body !== null) await response.body.cancel().catch(() => undefined);
    return failAfterNetwork(
      'not-text',
      `${finalUrl} answered with ${type === '' ? 'no content type' : type}, which this module does not read.`,
      { http_status: response.status, final_url: finalUrl },
    );
  }

  // First of the two size checks: the DECLARED length, before a byte is read.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
    if (response.body !== null) await response.body.cancel().catch(() => undefined);
    return failAfterNetwork(
      'not-text',
      `${finalUrl} declares ${declared} bytes, over the ${MAX_PAGE_BYTES}-byte page limit.`,
      { http_status: response.status, final_url: finalUrl },
    );
  }

  let read: { bytes: Uint8Array; truncated: boolean };
  try {
    // Second check: the bytes ACTUALLY received, because a server is not obliged
    // to declare a length and may not declare an honest one.
    read = await readCapped(response, MAX_PAGE_BYTES);
  } catch (err) {
    return failAfterNetwork(
      'transport',
      `The body of ${finalUrl} could not be read: ${err instanceof Error ? err.message : String(err)}`,
      { http_status: response.status, final_url: finalUrl },
    );
  }

  const body = decodeBody(read.bytes, header);
  const title = type === 'text/html' || type === 'application/xhtml+xml' ? pageTitle(body) : null;

  /* -- 6. settle ---------------------------------------------------------- */
  await ledger.settle({
    retrieval_id: retrievalId,
    status: 'ok',
    http_status: response.status,
    bytes: read.bytes.byteLength,
    final_url: finalUrl,
    note: read.truncated ? `Truncated at the ${MAX_PAGE_BYTES}-byte page limit.` : null,
  });

  return {
    ok: true,
    retrieval: {
      retrieval_id: retrievalId,
      requested_url: options.url,
      final_url: finalUrl,
      retrieved_at: options.retrievedAt,
      page_title: title,
    },
    body,
    content_type: type,
    http_status: response.status,
    bytes: read.bytes.byteLength,
    truncated: read.truncated,
    redirects,
    fetches_reserved_today: used,
    estimated_usd: estimate.usd,
  };
}
