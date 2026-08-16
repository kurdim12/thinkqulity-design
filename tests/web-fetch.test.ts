import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ===========================================================================
 * RULE 22, EXECUTED — "NO SILENT NETWORK"
 * ===========================================================================
 * tests/external-facts.test.ts already executes the network boundary's POLICY:
 * the guard, the reservation ordering, the redirect walk, the settlement. What
 * it cannot execute is the thing rule 22 is actually about, because it is not a
 * property of any one function:
 *
 *     DOES THE RULE GOVERN ANYTHING?
 *
 * A ledger nothing writes to bounds nothing. A cap nothing takes a unit from
 * bounds nothing. A guard nothing consults refuses nothing. And a paid endpoint
 * reached from a model-callable tool with no timeout is exactly the silent
 * network the rule names, however carefully the OTHER path is built.
 *
 * So the three tests at the top of this file are not about behaviour inside a
 * function. They are about REACHABILITY, and each one was RED before the change
 * that follows it:
 *
 *   1. fetchExternal had NO CALLER anywhere in src/. The machinery was correct
 *      and governed nothing.
 *   2. embed() passed NO SIGNAL to fetch(), so a hung api.openai.com held a chat
 *      turn open forever — reached from run_compliance, which a model calls
 *      mid-sentence.
 *   3. guardUrl ALLOWED https://kubernetes.default.svc/x. `.svc` is a 3-letter
 *      ASCII label, so it passes PUBLIC_TLD, and it was absent from
 *      RESERVED_SUFFIXES.
 *
 * EVERY SCAN IN THIS FILE IS SANITY-CHECKED AGAINST A CONTROL that holds the
 * planted positive and a planted negative, and against the assertion that
 * neither control carries a control byte — this project has twice produced a
 * false clean scan from a pattern holding a byte nobody could see.
 * ========================================================================= */

/* ---------------------------------------------------------------- loader --
 * src/lib/brain/canon/embed.ts imports through the `@/*` alias, which node does
 * not resolve. Same one rule as tests/needs-human.test.ts and tests/ingest.test.ts
 * teach this process: `@/*` -> `./src/*`, plus extensionless relative imports to
 * their .ts file. NOTHING is stubbed here — every module under test is the real
 * one, and the only fake in this file is a fetch implementation passed as an
 * argument.
 * ------------------------------------------------------------------------ */

const SRC = new URL('../src/', import.meta.url).href;

function tsFile(base: string): string | null {
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const url = tsFile(new URL(specifier.slice(2), SRC).href);
      if (url) return { url, shortCircuit: true };
    }
    const parent = context.parentURL;
    if (specifier.startsWith('.') && parent?.startsWith('file:') && !/\.[a-z]+$/i.test(specifier)) {
      const url = tsFile(new URL(specifier, parent).href);
      if (url) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { guardUrl, pageExcerpt, retrievalEvidenceFrom, EXCERPT_CHARS } = await import(
  '../src/lib/web/fetch.ts'
);
const { embed, embedTimeoutMs, EMBED_TIMEOUT_MS } = await import(
  '../src/lib/brain/canon/embed.ts'
);

/* ------------------------------------------------------------ the corpus -- */

const SRC_DIR = fileURLToPath(SRC);

/** Every .ts/.tsx file under src/, absolute. */
function sourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) {
      sourceFiles(path, into);
    } else if (/\.tsx?$/.test(entry)) {
      into.push(path);
    }
  }
  return into;
}

const SOURCES = sourceFiles(SRC_DIR).map((path) => ({
  path: path.slice(SRC_DIR.length).replace(/\\/g, '/'),
  text: readFileSync(path, 'utf8'),
}));

/**
 * A CALLER, as distinct from a MENTION. Both halves are required: a file that
 * names `fetchExternal` in a comment imports nothing and calls nothing, and a
 * comment is exactly what this codebase had instead of a caller.
 */
const IMPORTS_FETCH = /import\s*\{[^}]*\bfetchExternal\b[^}]*\}\s*from\s*['"][^'"]*web\/fetch['"]/s;
const CALLS_FETCH = /\bfetchExternal\s*\(/;

test('CONTROL: the caller scan sees a planted caller and is not fooled by prose', () => {
  // The planted POSITIVE — what a real caller looks like.
  const caller = [
    "import { fetchExternal, supabaseWebLedger } from '@/lib/web/fetch';",
    'const outcome = await fetchExternal(ledger, { url, trigger, ammanDay, retrievedAt });',
  ].join('\n');
  assert.equal(IMPORTS_FETCH.test(caller), true, 'the import pattern missed a real import');
  assert.equal(CALLS_FETCH.test(caller), true, 'the call pattern missed a real call');

  // The planted NEGATIVE — the state this codebase was actually in.
  const prose = ' * fetchExternal has no caller in src/. See the header.';
  assert.equal(IMPORTS_FETCH.test(prose), false, 'prose was read as an import');

  // NO CONTROL BYTE IN EITHER CONTROL. A NUL here silently zeroes every result
  // above and the scan reports a clean tree it never read.
  for (const control of [caller.replace(/\n/g, ' '), prose]) {
    assert.equal(/\p{Cc}/u.test(control), false, 'a control byte is hiding in a control string');
  }
  // And the corpus itself was really read, so an empty walk cannot pass as a
  // clean one.
  assert.ok(SOURCES.length > 100, `only ${SOURCES.length} source files were read`);
});

test('BREAK 3: rule 22 governs something — fetchExternal has a real caller in src/', () => {
  const callers = SOURCES.filter(
    (file) =>
      file.path !== '/lib/web/fetch.ts' &&
      IMPORTS_FETCH.test(file.text) &&
      CALLS_FETCH.test(file.text),
  );

  assert.ok(
    callers.length > 0,
    'fetchExternal is imported and called by nothing in src/. The ledger, the cap and the SSRF ' +
      'guard therefore bound no activity at all: rule 22 is machinery, not a rule.',
  );

  // A caller is not enough — it must be OPERATOR-TRIGGERED from a real surface,
  // which for this app means a route handler behind requireOperator().
  const routes = callers.filter((file) => file.path.startsWith('/app/api/'));
  assert.ok(
    routes.length > 0,
    `fetchExternal is called only from ${callers.map((c) => c.path).join(', ')} — no API route, ` +
      'so nothing an operator can press reaches it.',
  );
  for (const route of routes) {
    assert.match(
      route.text,
      /requireOperator\s*\(/,
      `${route.path} calls fetchExternal without requireOperator(); rule 22 says operator-triggered.`,
    );
  }
});

/* ============================================================================
 * BREAK 3, second half: THE UNLEDGERED, UNTIMED FETCH
 * ==========================================================================*/

/**
 * Runs `body` with EMBEDDING_PROVIDER=openai and a key present, then restores
 * both. The key is a literal placeholder, never a real one: this test must never
 * be capable of authenticating to anything, and the fetch it drives is a fake
 * passed in as an argument or installed on globalThis for the duration.
 */
async function withOpenAiEmbedder(body: () => Promise<void>): Promise<void> {
  const provider = process.env.EMBEDDING_PROVIDER;
  const key = process.env.OPENAI_API_KEY;
  process.env.EMBEDDING_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'not-a-key-placeholder';
  try {
    await body();
  } finally {
    if (provider === undefined) delete process.env.EMBEDDING_PROVIDER;
    else process.env.EMBEDDING_PROVIDER = provider;
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
  }
}

/** A well-formed embeddings answer, so the call under test completes normally. */
function embeddingResponse(): Response {
  return new Response(JSON.stringify({ data: [{ embedding: [0, 0, 0] }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('BREAK 3: embed() bounds the PRODUCTION fetch — the real global gets a signal', async () => {
  /* Driven through globalThis.fetch rather than through a seam ON PURPOSE. A
   * seam proves the seam. What rule 22 needs proved is that the path a Worker
   * actually takes — `fetch(...)`, the global — is the one carrying the bound. */
  await withOpenAiEmbedder(async () => {
    const real = globalThis.fetch;
    // An array, not a `let`: an assignment made inside a callback is invisible
    // to control-flow narrowing, which would type the variable `never` here.
    const seen: RequestInit[] = [];
    try {
      globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(url), 'https://api.openai.com/v1/embeddings');
        seen.push(init ?? {});
        return Promise.resolve(embeddingResponse());
      }) as typeof globalThis.fetch;

      await embed(['a query the canon layer is about to embed']);
    } finally {
      globalThis.fetch = real;
    }

    assert.equal(seen.length, 1, 'embed() never called fetch at all');
    const init = seen[0];
    assert.ok(
      init.signal instanceof AbortSignal,
      'embed() reached a paid third-party endpoint with NO abort signal. A hung api.openai.com ' +
        'holds the request open forever, and run_compliance reaches this mid-sentence.',
    );
  });
});

test('BREAK 3: the timeout FIRES — a hung embeddings endpoint is cut off', async () => {
  /* The signal above proves the bound is WIRED. This proves it BITES: the fake
   * endpoint never answers, and the only thing that can end this call is the
   * abort. Driven at 40ms through the same clamp production uses, so what is
   * executed is the real mechanism and not a shortened copy of it. */
  await withOpenAiEmbedder(async () => {
    const seen: AbortSignal[] = [];
    const started = Date.now();

    /* A ref'd timer, held for the duration and cleared below. `AbortSignal.timeout`
     * schedules an UNREF'D timer, and the fake fetch below is a bare promise with
     * no real I/O behind it — so with nothing else pending the loop would drain
     * before the abort ever fired. In production the socket refs the loop; here
     * nothing does. This keeps the process alive to observe the abort, and it
     * changes nothing about what is being observed. */
    const keepalive = setTimeout(() => undefined, 5_000);

    try {
      await assert.rejects(
        () =>
          embed(['a query nobody will ever answer'], {
            timeoutMs: 40,
            fetchImpl: (_url, init) =>
              new Promise<Response>((_resolve, reject) => {
                const signal = init.signal;
                // No signal would mean this promise never settles and the test
                // hangs — which is precisely the production behaviour it exists
                // to refuse. Fail loudly instead.
                if (!(signal instanceof AbortSignal)) {
                  reject(new Error('no abort signal was passed'));
                  return;
                }
                seen.push(signal);
                signal.addEventListener('abort', () => reject(signal.reason));
              }),
          }),
        (err: unknown) => err instanceof Error && /abort|timeout/i.test(err.message),
        'a hung endpoint was not cut off',
      );
    } finally {
      clearTimeout(keepalive);
    }

    assert.equal(seen.length, 1);
    assert.equal(seen[0].aborted, true, 'the signal never fired');
    assert.ok(Date.now() - started < 5_000, 'the abort took far longer than the ceiling asked for');
  });
});

test('the timeout is a CEILING: a caller may lower it and cannot raise it', () => {
  assert.equal(embedTimeoutMs(undefined), EMBED_TIMEOUT_MS, 'the default is the ceiling');
  assert.equal(embedTimeoutMs(40), 40, 'a lower value is honoured');
  // The case no behavioural test can see, and the reason this is exported.
  assert.equal(embedTimeoutMs(EMBED_TIMEOUT_MS * 10), EMBED_TIMEOUT_MS, 'a higher value was not clamped');
  for (const nonsense of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(embedTimeoutMs(nonsense), EMBED_TIMEOUT_MS, `${String(nonsense)} was not rejected`);
  }
});

test('the LOCAL embedder still touches no network at all', async () => {
  // The default path, and the one that must stay keyless. A regression that made
  // every canon lookup a billed request would otherwise be invisible here.
  const provider = process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_PROVIDER;
  const real = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error('the local embedder must not fetch'));
    }) as typeof globalThis.fetch;
    const vectors = await embed(['نص عربي', 'latin text']);
    assert.equal(vectors.length, 2);
  } finally {
    globalThis.fetch = real;
    if (provider !== undefined) process.env.EMBEDDING_PROVIDER = provider;
  }
  assert.equal(calls, 0, 'the local embedder reached the network');
});

/* ============================================================================
 * BREAK 3, third half: THE GUARD'S MISSING SUFFIXES
 * ==========================================================================*/

/**
 * Names that pass the SHAPE rules — two or more DNS labels, a final label of
 * ASCII letters — and are still never a host on the public internet.
 *
 * `.svc` is the one that was executed: `https://kubernetes.default.svc/x` is the
 * in-cluster API server, and on a runtime without
 * `global_fetch_strictly_public` (next dev, and this test process) nothing else
 * was refusing it.
 */
const RESERVED_INTERNAL: ReadonlyArray<readonly [string, string]> = [
  ['https://kubernetes.default.svc/api/v1/namespaces/default/secrets', 'svc'],
  ['https://my-service.my-namespace.svc/', 'svc'],
  ['https://kubernetes.default.svc.cluster/', 'cluster'],
  ['https://consul.service.consul/v1/kv/', 'consul'],
  ['https://smtp.mail/', 'mail'],
  ['https://nas.localnet/', 'localnet'],
  ['https://router.domain/', 'domain'],
];

test('BREAK 3: guardUrl refuses the reserved INTERNAL suffixes, not only the private addresses', () => {
  for (const [url, label] of RESERVED_INTERNAL) {
    const verdict = guardUrl(url);
    assert.equal(verdict.ok, false, `${url} was ALLOWED — ".${label}" is not a public suffix`);
    if (!verdict.ok) {
      assert.equal(verdict.reason, 'reserved-suffix', url);
      assert.match(verdict.detail, new RegExp(`\\.${label}`), `${url} blamed the wrong label`);
    }
  }
});

test('the suffix list covers only what the SHAPE rule leaves it — .i2p is refused earlier', () => {
  /* `.i2p` is as internal as `.onion` and is deliberately NOT in
   * RESERVED_SUFFIXES: it carries a digit, so PUBLIC_TLD refuses it before that
   * list is ever consulted. This pins the refusal AND the reason, so that an
   * entry added for it later is visibly dead rather than reassuring. */
  const verdict = guardUrl('https://something.i2p/');
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, 'not-a-public-name');
});

/* ============================================================================
 * THE REGRESSION. The addition above must not have moved anything else.
 *
 * These are the SAME cases tests/external-facts.test.ts pins, re-run here on
 * purpose: an addition to RESERVED_SUFFIXES is exactly the edit that can turn a
 * refusal reason into a different refusal reason, or turn a public control into
 * a refusal, and the file that changed should carry its own regression rather
 * than rely on another file being run.
 * ==========================================================================*/

const PRIVATE_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  ['https://127.0.0.1/admin', 'ip-literal'],
  ['https://10.0.0.5/', 'ip-literal'],
  ['https://192.168.1.1/', 'ip-literal'],
  ['https://169.254.169.254/latest/meta-data/', 'ip-literal'],
  ['https://0177.0.0.1/', 'ip-literal'],
  ['https://2130706433/', 'ip-literal'],
  ['https://0x7f000001/', 'ip-literal'],
  ['https://[::1]/', 'ip-literal'],
  ['https://[::ffff:127.0.0.1]/', 'ip-literal'],
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

test('REGRESSION: every private-address spelling still refuses, with the SAME reason', () => {
  for (const [url, reason] of PRIVATE_SPELLINGS) {
    const verdict = guardUrl(url);
    assert.equal(verdict.ok, false, `${url} was allowed`);
    if (!verdict.ok) assert.equal(verdict.reason, reason, url);
  }
  // 23 spellings already covered, 7 internal suffixes added, and `.i2p` pinned
  // separately above: 31 refusals in this file, none of them by accident.
  assert.equal(PRIVATE_SPELLINGS.length + RESERVED_INTERNAL.length + 1, 31);
});

/* ============================================================================
 * THE WIRING, AND WHY IT IS SAFE TO HAVE WIRED IT
 *
 * Filing a claim is a SECOND request, so the obvious design has the browser send
 * back the URL and the instant it was shown — which would make rule 21's two
 * load-bearing fields client input. It does not: the filing request carries an
 * ID, and `retrievalEvidenceFrom` reads both fields out of the ledger row the
 * fetch wrote before the request went out.
 * ==========================================================================*/

/** A settled 'ok' row, as `select(...)` returns it from `web_retrievals`. */
function ledgerRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    url: 'https://directory.example.org/profiles/thinkquality',
    final_url: 'https://directory.example.org/profiles/thinkquality/en',
    status: 'ok',
    settled_at: '2026-08-16T09:30:00.000Z',
    ...over,
  };
}

test('the URL and the instant come from the LEDGER, not from the caller', () => {
  const result = retrievalEvidenceFrom(ledgerRow(), 'Academy directory');
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Where the chain ENDED, not where it was aimed: a fact is filed against the
  // page that was actually read.
  assert.equal(result.retrieval.final_url, 'https://directory.example.org/profiles/thinkquality/en');
  assert.equal(result.retrieval.retrieved_at, '2026-08-16T09:30:00.000Z');
  assert.equal(result.retrieval.retrieval_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(result.retrieval.page_title, 'Academy directory');
});

test('a retrieval that read NOTHING can never be the source of a quote', () => {
  // Every status but 'ok'. 'reserved' is still in flight; 'refused' never
  // reached the network at all (final_url is null by database constraint);
  // 'failed' went out and brought nothing back. None of them read a page.
  const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
    [ledgerRow({ status: 'reserved', settled_at: null, final_url: null }), 'not-settled'],
    [ledgerRow({ status: 'refused', final_url: null }), 'not-settled'],
    [ledgerRow({ status: 'failed' }), 'not-settled'],
    // Shapes that crossed a wire and cannot be read. A row this code cannot
    // narrow is a REFUSAL, which is the safe direction to be wrong in.
    [ledgerRow({ final_url: null }), 'unreadable'],
    [ledgerRow({ settled_at: null }), 'unreadable'],
    [ledgerRow({ final_url: '   ' }), 'unreadable'],
    [ledgerRow({ id: '' }), 'unreadable'],
  ];

  for (const [row, reason] of cases) {
    const result = retrievalEvidenceFrom(row, null);
    assert.equal(result.ok, false, `${JSON.stringify(row['status'])} was accepted`);
    if (!result.ok) assert.equal(result.reason, reason, JSON.stringify(row));
  }

  // And the shapes that are not a row at all.
  for (const notARow of [null, undefined, 'a string', 42, []]) {
    const result = retrievalEvidenceFrom(notARow, null);
    assert.equal(result.ok, false, `${JSON.stringify(notARow) ?? 'undefined'} was accepted`);
  }
});

test('the excerpt is readable text, and script bodies do not survive it', () => {
  const html = [
    '<html><head><title>Directory</title>',
    '<style>.x{color:#fff}</style>',
    '<script>var secret = "do not read me";</script>',
    '</head><body><p>The academy is listed &amp; described.</p>',
    '<p>&lt;not a tag&gt;</p></body></html>',
  ].join('\n');

  const text = pageExcerpt(html, 'text/html');
  assert.equal(text.includes('do not read me'), false, 'a script body survived tag stripping');
  assert.equal(text.includes('color:#fff'), false, 'a style body survived tag stripping');
  assert.match(text, /The academy is listed & described\./);
  // `&amp;` is decoded last, so `&lt;` does not become a tag that then vanishes.
  assert.match(text, /<not a tag>/);

  // Plain text passes through undecoded — there is no markup to strip and an
  // entity in a text/plain body is literally an ampersand.
  assert.equal(pageExcerpt('a &amp; b', 'text/plain'), 'a &amp; b');

  // Bounded. An unbounded excerpt is an unbounded response body on a screen.
  const long = pageExcerpt(`<p>${'word '.repeat(4000)}</p>`, 'text/html');
  assert.ok(long.length <= EXCERPT_CHARS + 1, `excerpt was ${long.length} characters`);
});

test('the retrieval surface is reachable from a real SCREEN, not only from a route', () => {
  /* The v3 lesson exactly: a writer whose reader nobody ships is the same dead
   * machinery one level along. A route behind requireOperator() is necessary and
   * is not sufficient — something an operator can actually press has to call it. */
  const screens = SOURCES.filter(
    (file) => file.path.endsWith('.tsx') && /['"]\/api\/web['"]/.test(file.text),
  );
  assert.ok(
    screens.length > 0,
    'nothing under src/ with a UI calls /api/web, so no operator can trigger a retrieval.',
  );
  // And it must not fire on its own: a retrieval belongs to a click, not to a
  // mount. A screen that fetched on render would be a silent network by timer.
  for (const screen of screens) {
    assert.equal(
      /useEffect\([^)]*\bretrieve\b/.test(screen.text),
      false,
      `${screen.path} appears to retrieve on mount rather than on an operator action.`,
    );
  }
});

test('no file this task owns carries a raw control or format byte', () => {
  /* Hard rule 7. The scan in tests/external-facts.test.ts covers src/lib/web/*
   * and stops there, so the four files this task added or edited outside that
   * pair were covered by nothing. The RTL prose on the brand screen is the
   * reason it matters here specifically: an Arabic string is exactly where an
   * RLM or a ZWJ arrives without anybody typing one.
   *
   * THE CONTROL RUNS FIRST, for this project's own reason — it has twice
   * produced a false clean scan from a pattern carrying a byte nobody could
   * see. Every invisible below is written as a CODEPOINT and never as itself. */
  const ZWSP = String.fromCodePoint(0x200b); // Cf
  const RLM = String.fromCodePoint(0x200f); // Cf — the one Arabic prose attracts
  const NUL = String.fromCodePoint(0x0000); // Cc — the byte behind both false cleans

  const FORBIDDEN = /[\p{Cc}\p{Cf}]/gu;
  const allowed = new Set(['\n', '\r', '\t']);

  const control = `ok${ZWSP}here${RLM}and${NUL}a nul`;
  const found = [...control.matchAll(FORBIDDEN)].map((match) => match[0]);
  assert.equal(found.length, 3, 'THE CONTROL FAILED: a clean result below would prove nothing');
  assert.deepEqual(found, [ZWSP, RLM, NUL]);

  for (const file of [
    'src/lib/brain/canon/embed.ts',
    'src/app/api/web/route.ts',
    'src/app/(app)/brand/page.tsx',
    'tests/web-fetch.test.ts',
  ]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const hits = [...text.matchAll(FORBIDDEN)]
      .map((match) => match[0])
      .filter((character) => !allowed.has(character));
    assert.deepEqual(
      hits.map(
        (character) =>
          `U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0') ?? '????'}`,
      ),
      [],
      `${file} carries an invisible character`,
    );
  }
});

test('REGRESSION: the public control is still allowed', () => {
  for (const url of [
    'https://example.org/',
    'https://www.jordantimes.com/news/local/story',
    'https://sub.domain.co.uk/a/b?q=1#f',
    'https://example.org./trailing-dot-is-a-legal-absolute-name',
    'https://xn--mgbh0fb.xn--kgbechtv/',
    // The near-misses of the labels added above. A reserved suffix is the FINAL
    // label and nothing else: a public name that merely CONTAINS one is fine,
    // and an addition that broke this would be silently refusing the live web.
    'https://svc.example.org/',
    'https://mail.google.com/',
    'https://consul.hashicorp.com/docs',
    'https://domain.com/',
  ]) {
    const verdict = guardUrl(url);
    assert.equal(verdict.ok, true, `${url} was refused`);
  }
});
