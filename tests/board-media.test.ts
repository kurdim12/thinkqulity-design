import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Account } from '../src/lib/types/db.ts';
import type { MirrorCandidate, MirrorIndex, PostMedia } from '../src/lib/ingest/media.ts';

/* ---------------------------------------------------------------- loader --
 * src/lib/ingest/media.ts is an app module: it imports through the `@/*` alias
 * and pulls `isObject`/`pickString` out of apify.ts, which reaches `HttpError`
 * in a module that imports next/server. Node resolves neither, so these hooks
 * teach this process the one alias rule from tsconfig.json (`@/*` -> `./src/*`)
 * and swap HttpError for a stand-in — the same two hooks tests/ingest.test.ts
 * already uses, for the same two reasons.
 *
 * Only the resolution is faked. The module under test is the real one, and so
 * is `@/lib/env`, which is why MIRROR_MEDIA below is set on `process.env` and
 * genuinely read rather than stubbed to a convenient answer.
 * ------------------------------------------------------------------------ */

const SRC = new URL('../src/', import.meta.url).href;
const AUTH_STUB = 'stub:lib-auth';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/auth') return { url: AUTH_STUB, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      return { url: `${new URL(specifier.slice(2), SRC).href}.ts`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === AUTH_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export class HttpError extends Error {' +
          '  constructor(status, message, hint) {' +
          '    super(message);' +
          '    this.name = "HttpError";' +
          '    this.status = status;' +
          '    this.hint = hint;' +
          '  }' +
          '}',
      };
    }
    return nextLoad(url, context);
  },
});

// Dynamic, because the hooks must be registered before the module evaluates.
const {
  readMirrorIndex,
  postMediaFor,
  mirrorCoverage,
  mirrorPathFor,
  mirrorReadPath,
  mirrorPostMedia,
  mirrorMediaEnabled,
  skippedMirrorReport,
} = await import('../src/lib/ingest/media.ts');

/* =============================================================== what this ==
 * THE READER SHIPS WITH THE WRITER — and this file is the half that can be
 * EXECUTED without a network, a model key or a Supabase project.
 *
 * The v3 review's finding was that MIRROR_MEDIA's behaviour reached no surface.
 * v4 reverses it by giving the Board an image slot, and the load-bearing claim
 * underneath that slot is narrow and testable: a card renders an <img> only for
 * a post the BUCKET LISTING proved holds an object. Everything else — the flag
 * being off, a payload with no image URL, an expired CDN link, a listing that
 * refused — has to arrive at the card as an em-dash it can explain, never as a
 * broken image and never as a zero.
 *
 * So the tests below are mostly about the difference between `false` and
 * `null`. `false` is "the listing answered and this post has no object".
 * `null` is "nobody could tell". Rendering those the same way would be the
 * fabricated fact hard rule 2 exists to stop, and it is the one mistake this
 * reader could plausibly make.
 *
 * WHAT IS NOT PROVEN HERE. No real Supabase Storage call, no real Instagram CDN
 * fetch, and no browser: `fetch` and the storage client are stubs, so what is
 * executed is this module's logic, not the services around it. The Board page
 * itself is a React component with no test harness in this project — its
 * invariant is checked structurally at the bottom of this file, which is weaker
 * than running it and is labelled as such.
 * ========================================================================= */

/* --------------------------------------------------------- the fake store -- */

interface ListCall {
  bucket: string;
  prefix: string;
  limit: number;
  offset: number;
}

interface UploadCall {
  bucket: string;
  path: string;
  bytes: number;
  contentType: string;
}

interface StorageObject {
  name: string;
}

interface ListResult {
  data: StorageObject[] | null;
  error: { message: string } | null;
}

type Lister = (call: ListCall) => ListResult;

interface FakeStore {
  db: SupabaseClient;
  listCalls: ListCall[];
  uploads: UploadCall[];
}

/**
 * A Supabase client with exactly the two storage methods this module calls.
 *
 * The cast goes through `unknown` rather than through `any`, which the project
 * bans in tests as strictly as in src/. What that buys: if media.ts ever starts
 * calling a third storage method, this stub throws "is not a function" at the
 * call site instead of quietly answering undefined.
 */
function fakeStore(lister: Lister, uploadError: string | null = null): FakeStore {
  const listCalls: ListCall[] = [];
  const uploads: UploadCall[] = [];

  const storage = {
    from(bucket: string) {
      return {
        list(prefix: string, options: { limit: number; offset: number }): Promise<ListResult> {
          const call: ListCall = { bucket, prefix, limit: options.limit, offset: options.offset };
          listCalls.push(call);
          // Synchronous throw inside an async boundary, which is what a fetch
          // failure inside the storage client looks like from here.
          return Promise.resolve().then(() => lister(call));
        },
        upload(
          path: string,
          body: ArrayBuffer,
          options: { contentType: string; upsert: boolean },
        ): Promise<{ error: { message: string } | null }> {
          uploads.push({
            bucket,
            path,
            bytes: body.byteLength,
            contentType: options.contentType,
          });
          return Promise.resolve({
            error: uploadError === null ? null : { message: uploadError },
          });
        },
      };
    },
  };

  return { db: { storage } as unknown as SupabaseClient, listCalls, uploads };
}

/** A listing that answers, completely, with whatever the prefix holds. */
function fromObjects(objects: Record<string, string[]>): Lister {
  return ({ prefix, limit, offset }) => {
    const names = objects[prefix] ?? [];
    return {
      data: names.slice(offset, offset + limit).map((name) => ({ name })),
      error: null,
    };
  };
}

/** A listing that always fills its page, so paging never reaches the end. */
function endless(): Lister {
  return ({ prefix, limit, offset }) => ({
    data: Array.from({ length: limit }, (_unused, index) => ({
      name: `${prefix.replace(/\//g, '-')}-${offset + index}`,
    })),
    error: null,
  });
}

const PERSONAL: Account = 'personal';
const ACADEMY: Account = 'academy';
const PERSONAL_PREFIX = 'post-media/personal';
const ACADEMY_PREFIX = 'post-media/academy';

/** A real-shaped Instagram id: numeric, 19 digits. */
const IG_A = '3200000000000000001';
const IG_B = '3200000000000000002';

function entryOf(index: MirrorIndex, account: Account) {
  const entry = index.accounts.get(account);
  if (entry === undefined) assert.fail(`the index holds no entry for ${account}`);
  return entry;
}

/* ================================================================= paging == */

test('no accounts means no requests, and an empty index is a complete answer', async () => {
  const store = fakeStore(fromObjects({}));
  const index = await readMirrorIndex(store.db, []);

  assert.equal(store.listCalls.length, 0);
  assert.equal(index.accounts.size, 0);
  assert.equal(index.complete, true);
  assert.equal(index.error, null);
});

test('one listing per DISTINCT account, however many posts are asked about', async () => {
  const store = fakeStore(fromObjects({}));
  // 320 posts, the size of the real corpus, across the two real accounts.
  const accounts: Account[] = Array.from({ length: 320 }, (_unused, index) =>
    index % 2 === 0 ? PERSONAL : ACADEMY,
  );

  const index = await readMirrorIndex(store.db, accounts);

  // The claim this protects: a Board of 320 cards costs 2 subrequests, not 320.
  assert.equal(store.listCalls.length, 2);
  assert.deepEqual(
    store.listCalls.map((call) => call.prefix).sort(),
    [ACADEMY_PREFIX, PERSONAL_PREFIX],
  );
  assert.equal(index.accounts.size, 2);
  assert.equal(index.complete, true);
});

test('a missing prefix is a COMPLETE answer — which is the state of the corpus today', async () => {
  // Nothing has ever been mirrored: posts.raw is null on all 320 stored rows,
  // so there was never a URL to copy from. An empty listing is not a failure.
  const store = fakeStore(fromObjects({}));
  const index = await readMirrorIndex(store.db, [PERSONAL]);

  const entry = entryOf(index, PERSONAL);
  assert.equal(entry.names.size, 0);
  assert.equal(entry.complete, true);
  assert.equal(entry.error, null);

  const media = postMediaFor(index, PERSONAL, IG_A);
  // false, not null: the listing answered, and the answer was "no object".
  assert.equal(media.mirrored, false);
  assert.equal(media.src, null);
  // The path is still stated, so an operator can check the object for himself.
  assert.equal(media.path, `${PERSONAL_PREFIX}/${IG_A}`);
});

test('paging walks past the first page and keeps every name', async () => {
  const many = Array.from({ length: 2500 }, (_unused, index) => `ig-${index}`);
  const store = fakeStore(fromObjects({ [PERSONAL_PREFIX]: many }));

  const index = await readMirrorIndex(store.db, [PERSONAL]);
  const entry = entryOf(index, PERSONAL);

  assert.equal(entry.names.size, 2500);
  assert.equal(entry.complete, true);
  // Offsets advance by the page size, never repeat.
  const offsets = store.listCalls.map((call) => call.offset);
  assert.deepEqual([...new Set(offsets)], offsets);
});

/* ============================================== false is not null, ever == */

test('a listing that REFUSES makes absence unknown, and presence still proven', async () => {
  // Page 0 answers in full, page 1 refuses: the names gathered are real, the
  // ones past them are not knowable.
  const store = fakeStore(({ prefix, limit, offset }) => {
    if (prefix !== PERSONAL_PREFIX) return { data: [], error: null };
    if (offset === 0) {
      const page = Array.from({ length: limit }, (_unused, i) =>
        i === 0 ? IG_A : `filler-${i}`,
      );
      return { data: page.map((name) => ({ name })), error: null };
    }
    return { data: null, error: { message: 'storage said no' } };
  });

  const index = await readMirrorIndex(store.db, [PERSONAL]);
  const entry = entryOf(index, PERSONAL);

  assert.equal(entry.complete, false);
  assert.equal(entry.error, 'storage said no');
  assert.equal(index.complete, false);
  assert.equal(index.error, 'storage said no');

  // Present in a page that DID come back: proven, and renderable.
  const found = postMediaFor(index, PERSONAL, IG_A);
  assert.equal(found.mirrored, true);
  assert.equal(found.src, `/api/assets?path=${encodeURIComponent(`${PERSONAL_PREFIX}/${IG_A}`)}`);

  // Absent from an INCOMPLETE listing: unknown. This is the whole test file.
  const missing = postMediaFor(index, PERSONAL, IG_B);
  assert.equal(missing.mirrored, null, 'an unread listing must not be reported as "no image"');
  assert.equal(missing.src, null);
  assert.equal(missing.path, `${PERSONAL_PREFIX}/${IG_B}`);
});

test('a listing that THROWS degrades to unknown instead of failing the board', async () => {
  const store = fakeStore(({ prefix }) => {
    if (prefix === PERSONAL_PREFIX) throw new Error('connection reset');
    return { data: [], error: null };
  });

  // The property: this call resolves. /api/board has already assembled
  // captions, engagement and analyses by the time it runs, and losing all of
  // that because a thumbnail listing timed out would be the wrong trade.
  const index = await readMirrorIndex(store.db, [PERSONAL, ACADEMY]);

  assert.equal(index.complete, false);
  assert.equal(index.error, 'connection reset');
  assert.equal(postMediaFor(index, PERSONAL, IG_A).mirrored, null);
  // The other account was still listed, and its answer is still complete.
  assert.equal(entryOf(index, ACADEMY).complete, true);
  assert.equal(postMediaFor(index, ACADEMY, IG_A).mirrored, false);
});

test('running out of pages is incomplete WITHOUT an error — a different fact', async () => {
  const store = fakeStore(endless());
  const index = await readMirrorIndex(store.db, [PERSONAL]);
  const entry = entryOf(index, PERSONAL);

  assert.equal(entry.complete, false);
  assert.equal(entry.error, null, 'nothing refused, so there is no message to invent');
  assert.equal(postMediaFor(index, PERSONAL, IG_A).mirrored, null);
});

test('an account that was never listed is unknown, not empty', async () => {
  const store = fakeStore(fromObjects({ [PERSONAL_PREFIX]: [IG_A] }));
  const index = await readMirrorIndex(store.db, [PERSONAL]);

  const media = postMediaFor(index, ACADEMY, IG_A);
  assert.equal(media.mirrored, null);
  assert.equal(media.src, null);
});

test('an ig_id that cannot name an object is a PROVEN false', async () => {
  const store = fakeStore(fromObjects({}));
  const index = await readMirrorIndex(store.db, [PERSONAL]);

  for (const unusable of ['../escape', 'a/b', '', 'x'.repeat(65)]) {
    // The writer refuses the same ids, so there is nowhere for bytes to hide.
    assert.equal(mirrorPathFor(PERSONAL, unusable), null, `mirrorPathFor accepted ${unusable}`);
    const media = postMediaFor(index, PERSONAL, unusable);
    assert.equal(media.mirrored, false);
    assert.equal(media.path, null);
    assert.equal(media.src, null);
  }
});

/* ======================================================== what a card gets == */

test('src is the auth-gated route, never a signed URL', async () => {
  const store = fakeStore(fromObjects({ [PERSONAL_PREFIX]: [IG_A] }));
  const index = await readMirrorIndex(store.db, [PERSONAL]);
  const media = postMediaFor(index, PERSONAL, IG_A);

  const src = media.src;
  if (src === null) assert.fail('a mirrored post must carry a src');

  assert.ok(src.startsWith('/api/assets?path='), src);
  // Hard rule 4, as a shape check: a signed Supabase URL is absolute, names a
  // host, and carries a token. None of those can appear here.
  assert.ok(!src.includes('://'), 'src must be a route path, not an absolute URL');
  assert.ok(!/token=/i.test(src), 'src must not carry a token');
  assert.ok(!/supabase/i.test(src), 'src must not name the storage host');
  assert.equal(src, mirrorReadPath(`${PERSONAL_PREFIX}/${IG_A}`));
  // The slashes are encoded, so the query cannot be read as a second path.
  assert.ok(!src.slice('/api/assets?path='.length).includes('/'));
});

test('the three coverage counts are measured, and they sum', () => {
  const media: PostMedia[] = [
    { mirrored: true, path: 'p/1', src: '/api/assets?path=p%2F1' },
    { mirrored: true, path: 'p/2', src: '/api/assets?path=p%2F2' },
    { mirrored: false, path: 'p/3', src: null },
    { mirrored: null, path: 'p/4', src: null },
    { mirrored: null, path: null, src: null },
  ];

  const coverage = mirrorCoverage(media);
  assert.deepEqual(coverage, { examined: 5, mirrored: 2, not_mirrored: 1, unknown: 2 });
  assert.equal(
    coverage.mirrored + coverage.not_mirrored + coverage.unknown,
    coverage.examined,
    'every card must land in exactly one state',
  );
});

test('an unreadable index raises `unknown` rather than shrinking `mirrored`', async () => {
  // The failure mode this guards: reporting "0 images" for a listing that never
  // answered, which reads as a measurement and is not one.
  const store = fakeStore(() => ({ data: null, error: { message: 'nope' } }));
  const index = await readMirrorIndex(store.db, [PERSONAL]);

  const coverage = mirrorCoverage(
    [IG_A, IG_B].map((igId) => postMediaFor(index, PERSONAL, igId)),
  );
  assert.equal(coverage.mirrored, 0);
  assert.equal(coverage.not_mirrored, 0);
  assert.equal(coverage.unknown, 2);
});

/* ============================================== the writer, same index === */

test('MIRROR_MEDIA off: the pass reads nothing, downloads nothing, reports itself', async () => {
  const previous = process.env.MIRROR_MEDIA;
  delete process.env.MIRROR_MEDIA;
  try {
    assert.equal(mirrorMediaEnabled(), false);

    const store = fakeStore(fromObjects({}));
    const candidates: MirrorCandidate[] = [
      { account: PERSONAL, ig_id: IG_A, raw: { displayUrl: 'https://scontent.cdninstagram.com/a.jpg' } },
    ];

    const result = await mirrorPostMedia(candidates, store.db, {
      fetchImpl: () => assert.fail('a disabled pass must not fetch'),
    });

    assert.equal(result.enabled, false);
    assert.equal(result.mirrored, 0);
    assert.equal(result.considered, 1, 'it was handed one candidate, so it says one');
    assert.equal(store.listCalls.length, 0, 'a disabled pass must not list the bucket');
    assert.equal(store.uploads.length, 0);
    assert.equal(result.index_error, null);
    assert.ok(result.reason !== null);

    // "Did not run" and "ran and mirrored nothing" stay apart: the skipped
    // report has no candidate count at all, because no list was ever built.
    assert.equal(skippedMirrorReport().considered, null);
  } finally {
    if (previous === undefined) delete process.env.MIRROR_MEDIA;
    else process.env.MIRROR_MEDIA = previous;
  }
});

test('MIRROR_MEDIA on: the pass skips what the index already holds and stores the rest', async () => {
  const previous = process.env.MIRROR_MEDIA;
  process.env.MIRROR_MEDIA = 'true';
  try {
    assert.equal(mirrorMediaEnabled(), true);

    // IG_A is already in the bucket; IG_B is not.
    const store = fakeStore(fromObjects({ [PERSONAL_PREFIX]: [IG_A] }));
    const candidates: MirrorCandidate[] = [
      { account: PERSONAL, ig_id: IG_A, raw: { displayUrl: 'https://scontent.cdninstagram.com/a.jpg' } },
      { account: PERSONAL, ig_id: IG_B, raw: { displayUrl: 'https://scontent.cdninstagram.com/b.jpg' } },
      // Not an Instagram CDN host: refused before any request is made.
      { account: PERSONAL, ig_id: '3200000000000000003', raw: { displayUrl: 'https://example.com/c.jpg' } },
      // No image URL anywhere in the payload.
      { account: PERSONAL, ig_id: '3200000000000000004', raw: { caption: 'نص فقط' } },
    ];

    const fetched: string[] = [];
    const result = await mirrorPostMedia(candidates, store.db, {
      fetchImpl: (url) => {
        fetched.push(url);
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
        );
      },
    });

    assert.equal(result.enabled, true);
    assert.equal(result.considered, 4);
    assert.equal(result.already_mirrored, 1, 'the index is what stops the re-download');
    assert.equal(result.skipped.untrusted_host, 1);
    assert.equal(result.skipped.no_media_url, 1);
    assert.equal(result.attempted, 1);
    assert.equal(result.mirrored, 1);
    assert.equal(result.bytes_stored, 4);
    assert.equal(result.index_complete, true);
    assert.equal(result.index_error, null);
    assert.equal(result.error, null);

    assert.deepEqual(fetched, ['https://scontent.cdninstagram.com/b.jpg']);
    assert.deepEqual(
      store.uploads.map((upload) => upload.path),
      [`${PERSONAL_PREFIX}/${IG_B}`],
    );
    assert.equal(store.uploads[0].contentType, 'image/jpeg');

    // And the object the pass just wrote is exactly the one a card would read.
    const index = await readMirrorIndex(
      fakeStore(fromObjects({ [PERSONAL_PREFIX]: [IG_A, IG_B] })).db,
      [PERSONAL],
    );
    assert.equal(postMediaFor(index, PERSONAL, IG_B).src, mirrorReadPath(`${PERSONAL_PREFIX}/${IG_B}`));
  } finally {
    if (previous === undefined) delete process.env.MIRROR_MEDIA;
    else process.env.MIRROR_MEDIA = previous;
  }
});

test('a listing failure inside the pass is reported in words, not just as a flag', async () => {
  const previous = process.env.MIRROR_MEDIA;
  process.env.MIRROR_MEDIA = 'true';
  try {
    const store = fakeStore(() => ({ data: null, error: { message: 'listing unavailable' } }));
    const candidates: MirrorCandidate[] = [
      { account: PERSONAL, ig_id: IG_A, raw: { displayUrl: 'https://scontent.cdninstagram.com/a.jpg' } },
    ];

    const result = await mirrorPostMedia(candidates, store.db, {
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array([9]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        ),
    });

    assert.equal(result.index_complete, false);
    assert.equal(result.index_error, 'listing unavailable');
    // Unknown absence costs a re-download, which is wasteful and never wrong.
    assert.equal(result.mirrored, 1);
    assert.ok(
      result.warnings.some((line) => line.includes('listing unavailable')),
      'the reason must reach the operator, not only the boolean',
    );
  } finally {
    if (previous === undefined) delete process.env.MIRROR_MEDIA;
    else process.env.MIRROR_MEDIA = previous;
  }
});

/* ====================================================== structural checks == */

/**
 * WEAKER THAN THE TESTS ABOVE, and labelled so. There is no React test harness
 * in this project, so the Board card's invariant — an <img> is rendered only
 * for a post whose object was PROVEN present — is checked by reading the source
 * rather than by rendering it. A structural check can only fail loudly when the
 * guard is deleted; it cannot prove the component behaves.
 *
 * Every regex below is sanity-checked against a string known to be present in
 * the same file first, so an empty match means "absent", not "my regex is
 * wrong" — which is the failure mode that makes a green structural test worse
 * than none.
 */
const BOARD_PAGE = readFileSync(new URL('../src/app/(app)/board/page.tsx', import.meta.url), 'utf8');
const BOARD_ROUTE = readFileSync(new URL('../src/app/api/board/route.ts', import.meta.url), 'utf8');
const MEDIA_MODULE = readFileSync(new URL('../src/lib/ingest/media.ts', import.meta.url), 'utf8');

test('the regexes below can find something — the negative control', () => {
  assert.match(BOARD_PAGE, /PostMediaSlot/);
  assert.match(BOARD_ROUTE, /readMirrorIndex/);
  assert.match(MEDIA_MODULE, /postMediaFor/);
});

test('the card renders an <img> only behind the proven-present guard', () => {
  assert.match(BOARD_PAGE, /post\.media\.mirrored === true && src !== null/);

  // One <img> ELEMENT on the screen, and it sits inside PostMediaSlot. The
  // negative lookahead excludes `<img>` written as prose in the doc comments —
  // an element is always `<img` followed by an attribute or a newline, never by
  // a closing bracket. Checked both ways below so neither count is taken on
  // faith: the element count is 1, and the prose count is what is left over.
  const elements = BOARD_PAGE.match(/<img(?!>)/g) ?? [];
  const mentions = BOARD_PAGE.match(/<img\b/g) ?? [];
  assert.equal(elements.length, 1, `expected one <img> element, found ${elements.length}`);
  assert.ok(mentions.length > elements.length, 'the doc comments should still describe it');

  const slot = BOARD_PAGE.indexOf('function PostMediaSlot');
  const nextComponent = BOARD_PAGE.indexOf('function AnalysisStamp');
  assert.ok(slot >= 0 && nextComponent > slot);
  const element = BOARD_PAGE.search(/<img(?!>)/);
  assert.ok(element > slot && element < nextComponent, 'the <img> must live inside PostMediaSlot');
});

test('nothing on the read path mints or names a signed URL (rule 4)', () => {
  for (const [name, source] of [
    ['board/page.tsx', BOARD_PAGE],
    ['api/board/route.ts', BOARD_ROUTE],
    ['ingest/media.ts', MEDIA_MODULE],
  ] as const) {
    assert.ok(!/createSignedUrl/.test(source), `${name} must not mint a signed URL`);
    assert.ok(!/signedUrl/.test(source), `${name} must not handle a signed URL`);
  }
  // The one place that does is the route that redirects to it, unchanged.
  assert.match(BOARD_PAGE, /\/api\/assets/);
});

test('no NUL or other raw control bytes in the files this phase touched', () => {
  for (const [name, source] of [
    ['board/page.tsx', BOARD_PAGE],
    ['api/board/route.ts', BOARD_ROUTE],
    ['ingest/media.ts', MEDIA_MODULE],
  ] as const) {
    // Counted per code unit, not by grep: a NUL makes grep treat a file as
    // binary and withhold matches, which would silently defeat every check
    // above it (hard rule 7).
    for (let i = 0; i < source.length; i += 1) {
      const code = source.charCodeAt(i);
      const control = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
      if (control) assert.fail(`${name} holds a raw control byte 0x${code.toString(16)} at ${i}`);
    }
  }
});
