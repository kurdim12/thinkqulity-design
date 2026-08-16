import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkWebBudget,
  decodeBody,
  estimateWebFetch,
  fetchExternal,
  guardUrl,
  pageTitle,
  readReserveOutcome,
  MAX_FETCHES_PER_DAY,
  MAX_PAGE_BYTES,
  MAX_REDIRECTS,
  type FetchExternalOptions,
  type ReserveRequest,
  type Retrieval,
  type SettleRequest,
  type WebLedger,
} from '../src/lib/web/fetch.ts';
import {
  clientClaims,
  clientIdentity,
  externalFact,
  externalFactRow,
  renderExternalFacts,
  scanClientClaim,
  type ClientIdentity,
  type ExternalFact,
  type ExternalFactDraft,
  type RetrievalEvidence,
} from '../src/lib/web/facts.ts';
import { parseRenderedMeasures } from '../src/lib/brain/law/source-keys.ts';
import { substitute, valueMap } from '../src/lib/brain/substitute.ts';
import type { BasisRef, ExternalFactRow } from '../src/lib/types/db.ts';

/**
 * ===========================================================================
 * RULE 21 AND RULE 22, EXECUTED
 * ===========================================================================
 * The failure this file is about is a single sentence: a follower count read on
 * some directory page, presented as THE follower count. Everything below is an
 * attempt to produce that sentence through a different door, and an assertion
 * that the door is shut structurally rather than by a check somebody remembered
 * to write.
 *
 * THE CENTREPIECE IS "the composition", far below. Rule 20 (the model does not
 * type quantities) and rule 21 (external knowledge has no source_key) each leave
 * a gap alone. Together they close it, and that composition is executed against
 * the REAL substitution engine rather than described.
 *
 * EVERY INVISIBLE CHARACTER IS WRITTEN AS A CODEPOINT AND NEVER AS ITSELF, and
 * the last test in this file is the CONTROL for every scan here: this project has
 * twice produced a FALSE CLEAN SCAN from a pattern carrying a byte nobody could see.
 */

/* ---------------------------------------------------------------- fixtures */

/** The proven handles, from the canonical facts. Not a guess. */
const IDENTITY: ClientIdentity = clientIdentity(
  ['ahmadkahtan_', 'Ahmad Kahtan'],
  ['thinkquality_academyy', 'Think Quality Academy'],
);

const RETRIEVAL: RetrievalEvidence = {
  retrieval_id: '11111111-2222-3333-4444-555555555555',
  final_url: 'https://directory.example.org/profiles/thinkquality',
  retrieved_at: '2026-08-16T09:30:00.000Z',
  page_title: 'Academy directory',
};

/* EVERY INVISIBLE IS AN ESCAPE, NEVER THE CHARACTER. Hard rule 7 forbids a raw
 * control byte in any file, and the final test in this file scans these very
 * sources for one — a literal here would fail it, which is the point. An escape
 * is reviewable; the character is not. */
const ZWSP = String.fromCodePoint(0x200b); // ZERO WIDTH SPACE. Category Cf.
const CGJ = String.fromCodePoint(0x034f); // COMBINING GRAPHEME JOINER. Category Mn: the round-3 door.
const RLM = String.fromCodePoint(0x200f); // RIGHT-TO-LEFT MARK. Category Cf.
const NUL = String.fromCodePoint(0x0000); // Category Cc: the byte behind two false clean scans here.

function draft(over: Partial<ExternalFactDraft> = {}): ExternalFactDraft {
  return { claim: 'Amman hosts several training academies.', topic: 'amman_training', kind: 'statement', ...over };
}

/** A fact, built through the real constructor so nothing here bypasses the ratchet. */
function makeFact(over: Partial<ExternalFactDraft> = {}, retrieval = RETRIEVAL): ExternalFact {
  const result = externalFact(retrieval, draft(over), IDENTITY);
  assert.equal(result.ok, true, 'fixture failed to build');
  if (!result.ok) throw new Error('unreachable');
  return result.fact;
}

/* ============================================================================
 * 1. AN EXTERNAL FACT CANNOT CARRY A SOURCE KEY
 * ==========================================================================*/

/**
 * THE TYPE-LEVEL HALF. These are not comments: `Assert<T extends true>` fails to
 * compile when handed `false`, so `npx tsc --noEmit` IS the assertion and a
 * regression is a build break rather than a red test.
 */
type Assert<T extends true> = T;

/** An object carrying a source_key is not an ExternalFact. */
type _KeyedIsNotAFact = Assert<
  { retrieval_id: string; claim: string; source_url: string; retrieved_at: string; source_key: string } extends
    ExternalFact
    ? false
    : true
>;
/** An ExternalFact is not a BasisRef, so it can be handed to nothing that takes evidence. */
type _FactIsNotEvidence = Assert<ExternalFact extends BasisRef ? false : true>;
/** Nor is the persisted row, which is the shape that crosses the wire. */
type _RowIsNotEvidence = Assert<ExternalFactRow extends BasisRef ? false : true>;
/** And evidence is not a fact: it carries no URL and no retrieval date. */
type _EvidenceIsNotAFact = Assert<BasisRef extends ExternalFact ? false : true>;

test('type level: a source_key is refused, in both directions', () => {
  // The four assertions above are checked by tsc. This body exists so the
  // runtime suite records that they were claimed, and so a reader looking for
  // the guarantee finds it named in the test list.
  const checks: Array<_KeyedIsNotAFact | _FactIsNotEvidence | _RowIsNotEvidence | _EvidenceIsNotAFact> = [
    true,
    true,
    true,
    true,
  ];
  assert.deepEqual(checks, [true, true, true, true]);
});

test('runtime: a draft carrying a source_key is refused', () => {
  /* Built with Object.assign rather than a literal: the literal would be a
   * COMPILE error (which is the point of the type), and this test is about the
   * OTHER half — a draft that crossed a JSON boundary, came off a model, or was
   * read back out of a database, where `source_key?: never` has been erased. */
  const hostile: ExternalFactDraft = Object.assign(draft({ kind: 'statistic' }), {
    source_key: 'profiles.academy.followers',
  });

  const result = externalFact(RETRIEVAL, hostile, IDENTITY);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'source-key-present');
  assert.match(result.detail, /source_url/);
});

test('runtime: an undefined source_key is still a source_key', () => {
  // `hasOwnProperty`, not a truthiness test. `{source_key: undefined}` reads as
  // absent to `draft.source_key === undefined`, and a check written that way
  // would wave through the exact shape a JSON round-trip produces.
  const sneaky: ExternalFactDraft = Object.assign(draft(), { source_key: undefined });
  const result = externalFact(RETRIEVAL, sneaky, IDENTITY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'source-key-present');
});

test('the stored row has no source_key column to write into', () => {
  const row = externalFactRow(makeFact());
  assert.equal(Object.hasOwn(row, 'source_key'), false);
  // And the columns that rule 21 requires ARE there.
  assert.equal(typeof row['source_url'], 'string');
  assert.equal(typeof row['retrieved_at'], 'string');
  assert.equal(row['retrieval_id'], RETRIEVAL.retrieval_id);
});

/* ============================================================================
 * 2. source_url AND retrieved_at ARE REQUIRED
 * ==========================================================================*/

test('a fact cannot be built without a ledgered retrieval', () => {
  const missing: Array<[string, RetrievalEvidence]> = [
    ['no retrieval id', { ...RETRIEVAL, retrieval_id: '' }],
    ['no source url', { ...RETRIEVAL, final_url: '   ' }],
    ['no retrieved_at', { ...RETRIEVAL, retrieved_at: '' }],
  ];

  for (const [why, retrieval] of missing) {
    const result = externalFact(retrieval, draft(), IDENTITY);
    assert.equal(result.ok, false, why);
    if (!result.ok) assert.equal(result.reason, 'unretrieved', why);
  }
});

test('a source url that is not https is refused', () => {
  const result = externalFact({ ...RETRIEVAL, final_url: 'http://directory.example.org/x' }, draft(), IDENTITY);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'insecure-source');
});

test('a blank claim and a blank topic are both refused', () => {
  const blankClaim = externalFact(RETRIEVAL, draft({ claim: `  ${ZWSP} ` }), IDENTITY);
  // A claim of nothing but an invisible is not a claim. It trims to a lone
  // format character, which is non-empty by `length` and empty to a reader --
  // so this asserts the claim survives as text rather than pretending it is
  // blank, and the value stored is exactly what was published.
  assert.equal(blankClaim.ok, true);

  const reallyBlank = externalFact(RETRIEVAL, draft({ claim: '   \n  ' }), IDENTITY);
  assert.equal(reallyBlank.ok, false);
  if (!reallyBlank.ok) assert.equal(reallyBlank.reason, 'blank-claim');

  const noTopic = externalFact(RETRIEVAL, draft({ topic: '  ' }), IDENTITY);
  assert.equal(noTopic.ok, false);
  if (!noTopic.ok) assert.equal(noTopic.reason, 'blank-topic');
});

test('the claim is stored VERBATIM, digits and all', () => {
  const published = 'thinkquality_academyy  --  4,200 followers';
  const fact = makeFact({ claim: published, kind: 'statistic', topic: 'directory_listing' });
  assert.equal(fact.claim, published);
});

/* ============================================================================
 * 3. A CLAIM ABOUT THE CLIENT'S OWN ACCOUNTS IS FLAGGED
 * ==========================================================================*/

test('a web claim about the academy follower count is flagged, with the measure named', () => {
  const result = externalFact(
    RETRIEVAL,
    draft({ claim: 'thinkquality_academyy has 4,200 followers.', kind: 'statistic', topic: 'directory_listing' }),
    IDENTITY,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.fact.about_client, true);
  assert.equal(result.fact.client_account, 'academy');
  assert.equal(result.fact.client_measure, 'followers');
  // The caller declared nothing; the scan raised it. That is the ratchet firing.
  assert.equal(result.escalated, true);
});

test('the personal handle is routed to the personal account', () => {
  const fact = makeFact({ claim: 'ahmadkahtan_ is verified on Instagram.', kind: 'statistic', topic: 'x' });
  assert.equal(fact.client_account, 'personal');
  assert.equal(fact.client_measure, 'verification');
});

test('Arabic works too: «متابع» names the followers measure', () => {
  const fact = makeFact({
    claim: 'حساب thinkquality_academyy لديه اربعة الاف متابع',
    kind: 'statistic',
    topic: 'directory_listing',
  });
  assert.equal(fact.about_client, true);
  assert.equal(fact.client_measure, 'followers');
});

test('THE RATCHET ONLY TURNS ONE WAY: declaring "about the world" cannot clear the flag', () => {
  // A careless or hostile caller says nothing about the client. The scan sees
  // the handle anyway, and the flag goes up. Nothing in the API lowers it.
  const result = externalFact(
    RETRIEVAL,
    draft({ claim: 'A profile page for thinkquality_academyy lists 4,200 followers.', kind: 'statistic', topic: 'x' }),
    IDENTITY,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fact.about_client, true);
  assert.equal(result.escalated, true);
});

test('the flag is found in the URL and the title too, not only the sentence', () => {
  // Directory pages routinely name the account in the path and not in the
  // sentence: "This account has 4,200 followers" is about nobody, textually.
  const fact = makeFact(
    { claim: 'This account has 4,200 followers.', kind: 'statistic', topic: 'listing' },
    {
      ...RETRIEVAL,
      final_url: 'https://directory.example.org/ig/thinkquality_academyy',
      page_title: 'Profile',
    },
  );
  assert.equal(fact.about_client, true);
  assert.equal(fact.client_account, 'academy');
});

test('INVISIBLES DO NOT HIDE A HANDLE FROM THE SCAN', () => {
  /* The round-3 exploit was a \p{Mn} character splitting a number. The same
   * trick against a handle would file a client claim as an ordinary world fact.
   * The scan strips \p{Cf} and \p{Mn} from its WORKING COPY only. */
  const spelt = `thinkquality${ZWSP}_academ${CGJ}yy has 4,200 followers`;
  const scan = scanClientClaim(spelt, IDENTITY);
  assert.equal(scan.account, 'academy');
  assert.equal(scan.measure, 'followers');

  const fact = makeFact({ claim: spelt, kind: 'statistic', topic: 'x' });
  assert.equal(fact.about_client, true);
  // And what is STORED is still exactly what was published, invisibles included.
  assert.equal(fact.claim, spelt);
});

test('a genuine world claim is not flagged, so the flag still means something', () => {
  const fact = makeFact({ claim: 'Jordan hosted a training expo in Amman.', topic: 'jordan_market' });
  assert.equal(fact.about_client, false);
  assert.equal(fact.client_account, null);
  assert.equal(fact.client_measure, null);
  assert.deepEqual(clientClaims([fact]), []);
});

test('a caller may RAISE the flag on a claim the scan would miss', () => {
  const result = externalFact(
    RETRIEVAL,
    Object.assign(draft({ claim: 'The academy listed here is inactive.', topic: 'x' }), {
      about: { account: 'academy' as const, measure: 'post_count' as const },
    }),
    IDENTITY,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fact.about_client, true);
  assert.equal(result.fact.client_measure, 'post_count');
  assert.equal(result.escalated, false); // declared, not detected
});

test('an empty client identity is a configuration fault and throws', () => {
  // An empty identity silently disables the whole rule-21 check, which would
  // file a client follower count as an ordinary world fact. Hostile DATA never
  // throws in this module; broken CONFIG always does.
  assert.throws(() => clientIdentity([], ['thinkquality_academyy']), /personal side is empty/);
  assert.throws(() => clientIdentity(['ahmadkahtan_'], ['  ', '@']), /academy side is empty/);
});

/* ============================================================================
 * 4. THE RENDERER IS UNMISTAKABLY EXTERNAL
 * ==========================================================================*/

test('the rendered block says "published elsewhere, unverified" on every claim', () => {
  const rendered = renderExternalFacts([
    makeFact({ claim: 'Amman has many academies.', topic: 'amman' }),
    makeFact({ claim: 'thinkquality_academyy has 4,200 followers.', kind: 'statistic', topic: 'listing' }),
  ]);

  const claimLines = rendered.split('\n').filter((line) => line.startsWith('(published elsewhere'));
  assert.equal(claimLines.length, 2);
  for (const line of claimLines) assert.match(line, /unverified/);
  assert.match(rendered, /<external_knowledge>/);
  assert.match(rendered, /Nothing in this block is a measurement/);
});

test('a flagged claim carries a warning naming the measure and the account', () => {
  const rendered = renderExternalFacts([
    makeFact({ claim: 'thinkquality_academyy has 4,200 followers.', kind: 'statistic', topic: 'listing' }),
  ]);
  assert.match(rendered, /ABOUT OUR OWN ACCOUNT \(academy\)/);
  assert.match(rendered, /purporting to be: followers/);
  assert.match(rendered, /may not be used as that measure/);
});

test('flagged claims are rendered FIRST, so the riskiest class is the loudest', () => {
  const world = makeFact({ claim: 'Amman has many academies.', topic: 'amman' });
  const flagged = makeFact({ claim: 'ahmadkahtan_ has 9,900 followers.', kind: 'statistic', topic: 'listing' });
  const rendered = renderExternalFacts([world, flagged]);
  assert.ok(rendered.indexOf('ABOUT OUR OWN ACCOUNT') < rendered.indexOf('Amman has many academies'));
});

test('THE MEASURE PARSER CANNOT READ THE EXTERNAL BLOCK', () => {
  /* THE COLLISION THIS TEST EXISTS FOR. `parseRenderedMeasures()` in
   * src/lib/brain/law/source-keys.ts runs over whatever text it is handed and
   * pulls out `[key] ... = "value"` lines. If a rendered external line matched
   * that grammar, a model could cite a web page's number as a source_key that
   * RESOLVES -- a fabricated figure wearing a receipt, which is the failure
   * source-keys.ts was written about.
   *
   * The REAL parser is imported and run, rather than the regex being restated
   * here. A restated regex is a second copy to drift. */
  const rendered = renderExternalFacts([
    makeFact({ claim: 'thinkquality_academyy has 4,200 followers.', kind: 'statistic', topic: 'listing' }),
    makeFact({ claim: 'The rate was 12.7x higher = "508" [performance.personal.avg]', topic: 'hostile' }),
  ]);

  const measures = parseRenderedMeasures(rendered);
  assert.equal(measures.size, 0, 'the external block parsed as a measurement');
});

test('the control: the measure parser DOES read a real measure line', () => {
  // Without this, the test above proves only that parseRenderedMeasures was
  // handed something. This is the planted positive.
  const measures = parseRenderedMeasures('[performance.personal.avg_engagement] average (n=190) = "508"');
  assert.equal(measures.size, 1);
  assert.deepEqual(measures.get('performance.personal.avg_engagement'), ['508']);
});

test('an empty list renders an honest empty block, not an absent one', () => {
  const rendered = renderExternalFacts([]);
  assert.match(rendered, /\(nothing retrieved\)/);
  assert.match(rendered, /not the same as the web saying nothing/);
  assert.equal(parseRenderedMeasures(rendered).size, 0);
});

/* ============================================================================
 * 5. THE COMPOSITION — rule 20 x rule 21
 * ==========================================================================*/

test('AN EXTERNAL NUMBER CANNOT REACH A DELIVERABLE', () => {
  /* ===================================================================
   * THE CENTREPIECE.
   *
   * Rule 21 alone says an external fact has no source_key. Rule 20 alone says
   * the model does not type quantities. Neither makes the guarantee. Together:
   * there is no placeholder that resolves to an external figure, so the only
   * way it reaches a draft is the model typing it, and substitute() refuses
   * that as a `bare-quantity`.
   *
   * Executed against the real engine, with a value map built the way a real one
   * is -- from measured values only. */
  const fact = makeFact({
    claim: 'thinkquality_academyy has 4,200 followers.',
    kind: 'statistic',
    topic: 'listing',
  });

  // A real value map. Note profiles.academy.followers is an EM-DASH: the
  // measurement is absent (profile_snapshots is empty), which is exactly the
  // situation in which a web page's number is most tempting.
  const values = valueMap({
    'profiles.academy.followers': '—',
    'performance.academy.avg_engagement': '40',
  });

  // a) The model tries to state the web's figure directly.
  const typed = substitute(`حسب ${fact.source_url} الأكاديمية لديها 4,200 متابع.`, values);
  assert.equal(typed.deliverable, false);
  assert.ok(typed.violations.some((violation) => violation.kind === 'bare-quantity'));

  // b) The model tries to cite it as if it were a measurement.
  const cited = substitute('المتابعون: {{external.academy.followers}}', values);
  assert.equal(cited.deliverable, false);
  assert.ok(cited.violations.some((violation) => violation.kind === 'unknown-key'));
  assert.equal(cited.final.includes('4,200'), false);
  assert.equal(cited.final.includes('external.academy.followers'), false);

  // c) What IS deliverable: the honest sentence, with the absence stated as an
  //    em-dash and the external source named in words with no figure.
  const honest = substitute(
    `المتابعون: {{profiles.academy.followers}}. دليل خارجي ينشر رقما مختلفا؛ راجع ${fact.source_url}`,
    values,
  );
  assert.equal(honest.deliverable, true);
  assert.match(honest.final, /—/);
});

test('an external fact contributes nothing to any value map', () => {
  // There is no field to build one from. `externalFactRow` is the only shape
  // this module offers a persistence layer, and it carries no key.
  const row = externalFactRow(makeFact({ claim: 'x has 4,200 followers.', kind: 'statistic', topic: 't' }));
  const keyish = Object.keys(row).filter((name) => name.includes('key'));
  assert.deepEqual(keyish, []);
});

/* ============================================================================
 * 6. THE NETWORK BOUNDARY — SSRF
 * ==========================================================================*/

test('a fetch to a private address is refused, in every spelling', () => {
  const refused: Array<[string, string]> = [
    ['https://127.0.0.1/admin', 'ip-literal'],
    ['https://10.0.0.5/', 'ip-literal'],
    ['https://192.168.1.1/', 'ip-literal'],
    ['https://169.254.169.254/latest/meta-data/', 'ip-literal'], // the cloud metadata service
    /* The four spellings of 127.0.0.1 that nobody enumerates correctly. MEASURED
     * against this runtime: WHATWG parsing normalises all of them to the dotted
     * form BEFORE the guard runs, so each ends in a numeric final label and the
     * positive rule ("a host must look like a public name") refuses it as the
     * address it is. No range table, no base arithmetic, nothing to enumerate. */
    ['https://0177.0.0.1/', 'ip-literal'], // octal
    ['https://2130706433/', 'ip-literal'], // decimal
    ['https://0x7f000001/', 'ip-literal'], // hex
    ['https://[::1]/', 'ip-literal'],
    ['https://[::ffff:127.0.0.1]/', 'ip-literal'], // IPv4-mapped IPv6
    ['https://localhost/', 'not-a-public-name'],
    ['https://localhost.localdomain/', 'reserved-suffix'],
    ['https://db.internal/', 'reserved-suffix'],
    ['https://printer.local/', 'reserved-suffix'],
    ['https://metadata.google.internal/', 'reserved-suffix'],
    ['https://supabase/', 'not-a-public-name'],
    ['http://example.org/', 'not-https'],
    ['file:///etc/passwd', 'not-https'],
    ['data:text/html,<b>hi</b>', 'not-https'],
    ['gopher://example.org/', 'not-https'],
    ['https://example.org:8080/', 'non-default-port'],
    ['https://user:pw@example.org/', 'credentials-in-url'],
    ['https://example.org@127.0.0.1/', 'credentials-in-url'],
    ['not a url at all', 'unparseable'],
  ];

  for (const [url, reason] of refused) {
    const verdict = guardUrl(url);
    assert.equal(verdict.ok, false, `${url} was allowed`);
    if (!verdict.ok) assert.equal(verdict.reason, reason, url);
  }
});

test('the control: an ordinary public URL IS allowed', () => {
  // Without this, the battery above proves only that guardUrl says no to
  // everything. This is the planted negative.
  for (const url of [
    'https://example.org/',
    'https://www.jordantimes.com/news/local/story',
    'https://sub.domain.co.uk/a/b?q=1#f',
    'https://example.org./trailing-dot-is-a-legal-absolute-name',
    'https://xn--mgbh0fb.xn--kgbechtv/',
  ]) {
    const verdict = guardUrl(url);
    assert.equal(verdict.ok, true, `${url} was refused`);
  }
});

/* --------------------------------------------------------- the fake ledger */

interface Recorder {
  ledger: WebLedger;
  /** Every call in order, so ORDERING can be asserted rather than assumed. */
  order: string[];
  reserved: ReserveRequest[];
  settled: SettleRequest[];
}

function recorder(opts: { granted?: boolean; used?: number } = {}): Recorder {
  const order: string[] = [];
  const reserved: ReserveRequest[] = [];
  const settled: SettleRequest[] = [];
  const granted = opts.granted ?? true;

  return {
    order,
    reserved,
    settled,
    ledger: {
      async reserve(request) {
        order.push('reserve');
        reserved.push(request);
        return {
          granted,
          retrieval_id: granted ? 'ret-0001' : null,
          fetches_reserved_today: opts.used ?? 1,
        };
      },
      async settle(request) {
        order.push(`settle:${request.status}`);
        settled.push(request);
      },
    },
  };
}

function options(over: Partial<FetchExternalOptions> = {}): FetchExternalOptions {
  return {
    url: 'https://directory.example.org/profiles/thinkquality',
    trigger: { kind: 'operator', operator: 'ops@alkurdi.studio' },
    ammanDay: '2026-08-16',
    retrievedAt: '2026-08-16T09:30:00.000Z',
    ...over,
  };
}

/** A response with a real body stream, so readCapped runs for real. */
function html(body: string, init: { status?: number; type?: string; length?: number } = {}): Response {
  const headers = new Headers({ 'content-type': init.type ?? 'text/html; charset=utf-8' });
  if (init.length !== undefined) headers.set('content-length', String(init.length));
  return new Response(body, { status: init.status ?? 200, headers });
}

test('THE LEDGER ROW IS WRITTEN BEFORE THE NETWORK', () => {
  const rec = recorder();
  const order = rec.order;

  return fetchExternal(rec.ledger, options({
    fetchImpl: async () => {
      order.push('fetch');
      return html('<title>Hi</title><p>ok</p>');
    },
  })).then((outcome) => {
    assert.equal(outcome.ok, true);
    // Reserve, THEN fetch, THEN settle. Not reserve-after, not settle-before.
    assert.deepEqual(order, ['reserve', 'fetch', 'settle:ok']);
    assert.equal(rec.reserved[0].host, 'directory.example.org');
    assert.equal(rec.reserved[0].trigger, 'operator');
    assert.equal(rec.reserved[0].triggered_by, 'ops@alkurdi.studio');
    assert.equal(rec.settled[0].status, 'ok');
    assert.equal(rec.settled[0].http_status, 200);
  });
});

test('a refused URL is LEDGERED and KEEPS its unit, and no request goes out', async () => {
  const rec = recorder();
  let calls = 0;

  const outcome = await fetchExternal(rec.ledger, options({
    url: 'https://169.254.169.254/latest/meta-data/',
    fetchImpl: async () => {
      calls += 1;
      return html('secrets');
    },
  }));

  assert.equal(calls, 0, 'a request went out to a refused host');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, 'refused-url');
  assert.equal(outcome.retrieval_id, 'ret-0001');

  // The reservation happened BEFORE the guard, on purpose: a refusal that cost
  // nothing would let anything probe ten thousand internal addresses for free.
  assert.deepEqual(rec.order, ['reserve', 'settle:refused']);
  const settled = rec.settled[0];
  assert.equal(settled.status, 'refused');
  // A refusal reached NOTHING. The database's CHECK constraint says the same.
  assert.equal(settled.http_status, null);
  assert.equal(settled.final_url, null);
  assert.equal(settled.bytes, null);
});

test('A REDIRECT TO A PRIVATE ADDRESS IS REFUSED', async () => {
  /* The reason `redirect: 'manual'` exists in this module. With `follow`, the
   * platform walks the chain and lands on the host the guard already refused --
   * the guard would have run once, on the URL that was never the target. */
  const rec = recorder();
  const seen: string[] = [];

  const outcome = await fetchExternal(rec.ledger, options({
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data/' },
      });
    },
  }));

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, 'redirect-refused');
  assert.match(outcome.detail, /169\.254\.169\.254/);
  assert.deepEqual(seen, ['https://directory.example.org/profiles/thinkquality']);
  // 'failed', not 'refused': a request HAD gone out, and the schema refuses a
  // 'refused' row that reached something.
  assert.equal(rec.settled[0].status, 'failed');
  assert.equal(rec.settled[0].http_status, 302);
});

test('the request is made with redirect: manual, so the platform never walks the chain', async () => {
  /* THE GAP THIS CLOSES. The test above proves the hand-walking code re-guards
   * every hop — but it drives a STUB, and a stub ignores `redirect`. Flip the
   * real call to `follow` and that test still passes while the platform quietly
   * follows the chain to the host the guard refused, leaving the hand-walking
   * code dead. So the init itself is asserted, which is the only thing the seam
   * cannot fake away. */
  const rec = recorder();
  const inits: RequestInit[] = [];

  await fetchExternal(rec.ledger, options({
    fetchImpl: async (_url, init) => {
      inits.push(init);
      return html('ok');
    },
  }));

  assert.equal(inits.length, 1);
  assert.equal(inits[0].redirect, 'manual');
  assert.equal(inits[0].method, 'GET');
  assert.ok(inits[0].signal !== undefined, 'no abort signal was attached');
});

test('an unreadable reservation answer reads as a REFUSAL', () => {
  /* The narrowing is pure and exported precisely so this is executable without a
   * database. Every one of these is an answer the code cannot read, and every
   * one of them must refuse — a false refusal costs a lookup, and the other
   * direction spends a cap unit nobody counted. */
  const unreadable: unknown[] = [
    null,
    undefined,
    'granted',
    [],
    [{ granted: true }], // granted, but no id: nothing to settle against
    [{ granted: 'true', retrieval_id: 'x' }], // the string, not the boolean
    [{ retrieval_id: 'x', fetches_reserved_today: 3 }], // no verdict at all
    { granted: true, retrieval_id: 7 }, // an id that is not a string
  ];

  for (const data of unreadable) {
    const outcome = readReserveOutcome(data, null);
    assert.equal(outcome.granted, false, JSON.stringify(data ?? null));
    assert.equal(outcome.retrieval_id, null);
  }

  // An error refuses whatever the payload says.
  assert.equal(
    readReserveOutcome([{ granted: true, retrieval_id: 'ret-1' }], { message: 'boom' }).granted,
    false,
  );

  // The control: a well-formed grant IS honoured, or the eight above prove nothing.
  const good = readReserveOutcome([{ granted: true, retrieval_id: 'ret-1', fetches_reserved_today: 4 }], null);
  assert.deepEqual(good, { granted: true, retrieval_id: 'ret-1', fetches_reserved_today: 4 });
});

test('a RELATIVE redirect is resolved before it is guarded', async () => {
  const rec = recorder();
  const seen: string[] = [];

  const outcome = await fetchExternal(rec.ledger, options({
    fetchImpl: async (url) => {
      seen.push(url);
      if (seen.length === 1) {
        return new Response(null, { status: 301, headers: { location: '/moved/here' } });
      }
      return html('<title>Moved</title>arrived');
    },
  }));

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(seen, [
    'https://directory.example.org/profiles/thinkquality',
    'https://directory.example.org/moved/here',
  ]);
  assert.deepEqual(outcome.redirects, ['https://directory.example.org/moved/here']);
  assert.equal(outcome.retrieval.final_url, 'https://directory.example.org/moved/here');
  assert.equal(outcome.retrieval.requested_url, 'https://directory.example.org/profiles/thinkquality');
});

test('a redirect loop stops at the hop limit', async () => {
  const rec = recorder();
  let calls = 0;

  const outcome = await fetchExternal(rec.ledger, options({
    fetchImpl: async (url) => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: `${url}/again` } });
    },
  }));

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, 'too-many-redirects');
  assert.equal(calls, MAX_REDIRECTS + 1);
});

test('the day cap refuses without touching the network', async () => {
  const rec = recorder({ granted: false, used: MAX_FETCHES_PER_DAY });
  let calls = 0;

  const outcome = await fetchExternal(rec.ledger, options({
    fetchImpl: async () => {
      calls += 1;
      return html('x');
    },
  }));

  assert.equal(calls, 0);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, 'capped');
    assert.equal(outcome.fetches_reserved_today, MAX_FETCHES_PER_DAY);
    assert.equal(outcome.retrieval_id, null);
  }
  // Nothing to settle: no row was taken.
  assert.deepEqual(rec.order, ['reserve']);
});

test('dailyCap may LOWER the ceiling and may never raise it', async () => {
  const low = recorder();
  await fetchExternal(low.ledger, options({ dailyCap: 3, fetchImpl: async () => html('x') }));
  assert.equal(low.reserved[0].limit, 3);

  const greedy = recorder();
  await fetchExternal(greedy.ledger, options({ dailyCap: 10_000, fetchImpl: async () => html('x') }));
  assert.equal(greedy.reserved[0].limit, MAX_FETCHES_PER_DAY);

  const nonsense = recorder();
  await fetchExternal(nonsense.ledger, options({ dailyCap: -1, fetchImpl: async () => html('x') }));
  assert.equal(nonsense.reserved[0].limit, MAX_FETCHES_PER_DAY);
});

test('a scheduled fetch ledgers the schedule name; there is no third trigger', async () => {
  const rec = recorder();
  await fetchExternal(
    rec.ledger,
    options({
      trigger: { kind: 'schedule', schedule: 'weekly-brand-watch' },
      fetchImpl: async () => html('x'),
    }),
  );
  assert.equal(rec.reserved[0].trigger, 'schedule');
  assert.equal(rec.reserved[0].triggered_by, 'weekly-brand-watch');

  /* And there is no `{ kind: 'agent' }` to pass. That is checked by tsc, not
   * here: `FetchTrigger` is a two-member union, so a third member is a compile
   * error at the call site. The database carries the same CHECK, verified
   * against the live project when 0008 was applied. */
});

test('a non-text response is not read', async () => {
  const rec = recorder();
  const outcome = await fetchExternal(rec.ledger, options({
    fetchImpl: async () => html(`MZ${NUL}binary`, { type: 'application/octet-stream' }),
  }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.reason, 'not-text');
  assert.equal(rec.settled[0].status, 'failed');
});

test('a non-2xx is a failure, and its status is ledgered', async () => {
  const rec = recorder();
  const outcome = await fetchExternal(rec.ledger, options({
    fetchImpl: async () => html('not found', { status: 404 }),
  }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, 'http-error');
    assert.equal(outcome.http_status, 404);
  }
  assert.equal(rec.settled[0].http_status, 404);
});

test('the byte cap is enforced on the DECLARED length and on the ACTUAL bytes', async () => {
  // Declared: refused before a byte is read.
  const declared = recorder();
  const big = await fetchExternal(declared.ledger, options({
    fetchImpl: async () => html('small', { length: MAX_PAGE_BYTES + 1 }),
  }));
  assert.equal(big.ok, false);
  if (!big.ok) assert.equal(big.reason, 'not-text');

  // Actual: a server need not declare a length, and need not declare an honest
  // one. The body is cut at the cap and the page is still usable.
  const actual = recorder();
  const outcome = await fetchExternal(actual.ledger, options({
    fetchImpl: async () => html('a'.repeat(MAX_PAGE_BYTES + 5_000)),
  }));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.bytes, MAX_PAGE_BYTES);
  assert.equal(actual.settled[0].bytes, MAX_PAGE_BYTES);
  assert.match(actual.settled[0].note ?? '', /Truncated/);
});

test('a transport failure is a settled row, never a throw', async () => {
  const rec = recorder();
  const outcome = await fetchExternal(rec.ledger, options({
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
  }));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, 'transport');
    assert.match(outcome.detail, /socket hang up/);
  }
  assert.equal(rec.settled[0].status, 'failed');
});

/* ============================================================================
 * 7. RULES 9 AND 15 — ESTIMATE BEFORE SPEND
 * ==========================================================================*/

test('an unverifiable price BLOCKS, and blocks before the ledger', async () => {
  const rec = recorder();
  let calls = 0;
  const outcome = await fetchExternal(rec.ledger, options({
    provider: 'openrouter_web_plugin',
    fetchImpl: async () => {
      calls += 1;
      return html('x');
    },
  }));

  assert.equal(calls, 0);
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, 'unpriced');
    assert.equal(outcome.retrieval_id, null);
  }
  /* NOTHING WAS LEDGERED, and that placement is deliberate: a pricing failure is
   * a CONFIGURATION fault, identical for every URL and useless for probing. If
   * it burned a cap unit, an operator would fix their config and find the day
   * already spent. A GUARD failure is an INPUT fault and is charged (above). */
  assert.deepEqual(rec.order, []);
});

test('an unknown provider is indistinguishable from an unpriced one', () => {
  for (const provider of ['openrouter_web_plugin', 'search_api', 'whatever']) {
    const estimate = estimateWebFetch({ provider, queries: 1 });
    assert.equal(estimate.usd, null, provider);
    assert.equal(checkWebBudget({ estimate, budgetUsd: 100 }).allowed, false, provider);
  }
});

test('the budget decision table matches checkBudget in budget.ts', () => {
  const priced = estimateWebFetch({ provider: 'direct', queries: 1 });
  const unpriced = estimateWebFetch({ provider: 'search_api', queries: 1 });

  // null estimate -> BLOCKED, whatever the budget.
  assert.equal(checkWebBudget({ estimate: unpriced, budgetUsd: null }).allowed, false);
  assert.equal(checkWebBudget({ estimate: unpriced, budgetUsd: 999 }).allowed, false);
  // null budget -> no ceiling configured, so nothing to exceed.
  assert.equal(checkWebBudget({ estimate: priced, budgetUsd: null }).allowed, true);
  assert.equal(checkWebBudget({ estimate: priced, budgetUsd: undefined }).allowed, true);
  // zero is a REAL ceiling of zero; an estimate of exactly $0.00 clears it.
  assert.equal(checkWebBudget({ estimate: priced, budgetUsd: 0 }).allowed, true);
  // negative / NaN -> a misconfiguration, never read as unlimited.
  assert.equal(checkWebBudget({ estimate: priced, budgetUsd: -1 }).allowed, false);
  assert.equal(checkWebBudget({ estimate: priced, budgetUsd: Number.NaN }).allowed, false);
});

test('a priced direct fetch reports its estimate on the ledger row', async () => {
  const rec = recorder();
  const outcome = await fetchExternal(rec.ledger, options({ fetchImpl: async () => html('x') }));
  assert.equal(rec.reserved[0].estimated_usd, 0);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.estimated_usd, 0);
});

/* ============================================================================
 * 8. DECODING AND TITLES
 * ==========================================================================*/

test('a declared charset is honoured, and an unknown one falls back', () => {
  const utf8 = new TextEncoder().encode('مرحبا');
  assert.equal(decodeBody(utf8, 'text/html; charset=utf-8'), 'مرحبا');
  assert.equal(decodeBody(utf8, 'text/html; charset=not-a-charset'), 'مرحبا');
  assert.equal(decodeBody(utf8, null), 'مرحبا');
});

test('the page title is read, entity-decoded and collapsed', () => {
  assert.equal(pageTitle('<html><head><title>  Think &amp; Quality \n Academy </title>'), 'Think & Quality Academy');
  assert.equal(pageTitle('<title lang="ar">أكاديمية</title>'), 'أكاديمية');
  assert.equal(pageTitle('<title></title>'), null);
  assert.equal(pageTitle('<p>no title here</p>'), null);
  // `&amp;lt;` must not become `<`: &amp; is decoded LAST.
  assert.equal(pageTitle('<title>&amp;lt;b&amp;gt;</title>'), '&lt;b&gt;');
});

test('the title reaches the retrieval, and the retrieval builds the fact', async () => {
  const rec = recorder();
  const outcome = await fetchExternal(rec.ledger, options({
    fetchImpl: async () => html('<title>Academy directory</title><p>4,200 followers</p>'),
  }));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const retrieval: Retrieval = outcome.retrieval;
  assert.equal(retrieval.page_title, 'Academy directory');

  // The whole chain, end to end: a ledgered fetch produces a retrieval, and
  // ONLY a retrieval can produce a fact.
  const result = externalFact(
    retrieval,
    draft({ claim: 'thinkquality_academyy has 4,200 followers.', kind: 'statistic', topic: 'listing' }),
    IDENTITY,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fact.retrieval_id, 'ret-0001');
  assert.equal(result.fact.about_client, true);
  assert.equal(result.fact.page_title, 'Academy directory');
});

/* ============================================================================
 * 9. THE CONTROL — hard rule 7, and this project's two false clean scans
 * ==========================================================================*/

test('no source file this task owns carries a raw control or format byte', () => {
  /* Hard rule 7 forbids a raw control byte in any file, and this project has
   * TWICE produced a false clean scan from a pattern carrying a byte nobody
   * could see. So the pattern is exercised against a CONTROL first: a string
   * with the planted positives and no NUL. If the control finds nothing, the
   * scan is broken and the clean result below would be meaningless. */
  const FORBIDDEN = /[\p{Cc}\p{Cf}]/gu;
  const allowed = new Set(['\n', '\r', '\t']);

  const control = `ok${ZWSP}here${RLM}and${NUL}a nul`;
  const found = [...control.matchAll(FORBIDDEN)].map((match) => match[0]);
  assert.equal(found.length, 3, 'THE CONTROL FAILED: the scan finds nothing, so a clean result proves nothing');
  assert.deepEqual(found, [ZWSP, RLM, NUL]);

  for (const file of [
    'src/lib/web/fetch.ts',
    'src/lib/web/facts.ts',
    'supabase/migrations/0008_external_facts.sql',
    'tests/external-facts.test.ts',
  ]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const hits = [...text.matchAll(FORBIDDEN)]
      .map((match) => match[0])
      .filter((character) => !allowed.has(character));
    assert.deepEqual(
      hits.map((character) => `U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? '????'}`),
      [],
      `${file} carries an invisible character`,
    );
  }
});

test('the control: the client scan DOES find a plainly spelled handle', () => {
  // The planted positive for every scanClientClaim assertion above. If this
  // fails, "not flagged" results elsewhere prove nothing at all.
  const plain = scanClientClaim('thinkquality_academyy has followers', IDENTITY);
  assert.equal(plain.account, 'academy');
  assert.equal(plain.measure, 'followers');

  const absent = scanClientClaim('a completely unrelated sentence', IDENTITY);
  assert.equal(absent.account, null);
});
