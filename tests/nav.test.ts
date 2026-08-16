import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DEMOTED,
  MOVED,
  NAV,
  NAV_KEYS,
  SURFACES,
  label,
  navKeyFor,
  surfaceFor,
  titleFor,
  type MovedUrl,
} from '../src/lib/nav.ts';

/* ===========================================================================
 * THE IA CUT.
 *
 * These tests are not about how the sidebar looks. They are about the one
 * thing a nav cut can silently get wrong: a URL that used to work and now
 * goes nowhere. An operator's bookmark, a link inside a digest that was
 * stored months ago, and the chat's dispatch targets are all links this
 * release did not write and cannot see.
 *
 * So the gate is not "the nav has five entries" — that is one assertion and
 * the easy half. The gate is that every screen on disk is CLASSIFIED: it is
 * one of the five, or it is demoted and still reachable, or its URL redirects
 * to a live surface. A sixteenth screen appearing with no decision attached
 * fails here, which is what stops the sprawl returning one route at a time.
 *
 * Shell.tsx cannot be imported — `node --test --experimental-strip-types`
 * cannot load a .tsx file. That is exactly why src/lib/nav.ts exists and the
 * component is a thin renderer over it: every decision the nav makes is
 * reachable from here.
 * ======================================================================== */

const REPO = fileURLToPath(new URL('..', import.meta.url));
const APP_DIR = join(REPO, 'src', 'app', '(app)');

/**
 * Every route folder under (app) that actually renders something — a directory
 * holding a page.tsx. One level deep, which is the shape this app has and the
 * shape the IA is about; a nested route would be a sub-page of a surface, not
 * a surface.
 *
 * Controlled below against a planted fixture. A scan that silently matched
 * nothing would make every "is it classified" assertion below pass on an empty
 * list, which is the one way this whole file could be a lie.
 */
function discoverRoutes(appDir: string): string[] {
  return readdirSync(appDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(appDir, entry.name, 'page.tsx')))
    .map((entry) => `/${entry.name}`)
    .sort();
}

test('the route scanner finds route folders and only route folders', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tq-nav-'));
  mkdirSync(join(fixture, 'alpha'));
  writeFileSync(join(fixture, 'alpha', 'page.tsx'), 'export default function A() {}\n');
  // A directory with no page.tsx is not a route.
  mkdirSync(join(fixture, 'beta'));
  writeFileSync(join(fixture, 'beta', 'helper.ts'), 'export const x = 1;\n');
  // A file is not a route, even one named like the real layout beside it.
  writeFileSync(join(fixture, 'layout.tsx'), 'export default function L() {}\n');

  assert.deepEqual(discoverRoutes(fixture), ['/alpha']);
});

const ROUTES = discoverRoutes(APP_DIR);

test('the scan sees the real app, not an empty list', () => {
  // Planted positives: one surface that is in the nav, one that is demoted and
  // one whose screen was deleted this release. If the scanner ever returns
  // nothing, this is where it is caught rather than three tests later.
  for (const known of ['/chat', '/concepts', '/audience']) {
    assert.ok(ROUTES.includes(known), `expected the scan to find ${known}`);
  }
});

/* --------------------------------------------------------------- the five -- */

test('the left nav is exactly five surfaces, in order', () => {
  assert.equal(NAV.length, 5);
  assert.deepEqual(
    NAV.map((surface) => surface.key),
    ['/chat', '/board', '/brand', '/digest', '/data'],
  );
  assert.deepEqual([...NAV_KEYS], NAV.map((surface) => surface.key));
});

test('every nav entry is labelled in both locales', () => {
  for (const surface of NAV) {
    assert.notEqual(surface.ar.trim(), '', `${surface.key} has no Arabic label`);
    assert.notEqual(surface.en.trim(), '', `${surface.key} has no English label`);
    assert.equal(label(surface, 'ar'), surface.ar);
    assert.equal(label(surface, 'en'), surface.en);
  }
});

test('no two surfaces claim the same route', () => {
  const keys = SURFACES.map((surface) => surface.key);
  assert.equal(new Set(keys).size, keys.length);
});

/* ------------------------------------------------- nothing is unaccounted -- */

test('every screen on disk is in exactly one state: nav, demoted, or moved', () => {
  const nav = new Set<string>(NAV.map((surface) => surface.key));
  const demoted = new Set<string>(DEMOTED.map((surface) => surface.key));
  const moved = new Set<string>(Object.keys(MOVED));

  for (const route of ROUTES) {
    const states = [nav.has(route), demoted.has(route), moved.has(route)].filter(Boolean).length;
    assert.equal(
      states,
      1,
      `${route} is in ${states} of {nav, demoted, moved} — every screen needs exactly one`,
    );
  }

  // ...and nothing is classified that does not exist. A demoted entry pointing
  // at a folder nobody kept is a nav item that 404s.
  for (const key of [...nav, ...demoted, ...moved]) {
    assert.ok(ROUTES.includes(key), `${key} is classified but has no page.tsx`);
  }
});

test('the cut is 15 screens to 5 nav entries', () => {
  assert.equal(ROUTES.length, NAV.length + DEMOTED.length + Object.keys(MOVED).length);
  assert.equal(ROUTES.length, 15);
});

/* ------------------------------------------------------- the moved routes -- */

const MOVED_KEYS = Object.keys(MOVED) as MovedUrl[];

test('a moved URL lands on a live surface, never on another redirect', () => {
  for (const from of MOVED_KEYS) {
    const to = MOVED[from];
    assert.ok(surfaceFor(to) !== null, `${from} redirects to ${to}, which is not a live surface`);
    assert.ok(!MOVED_KEYS.includes(to as MovedUrl), `${from} redirects into another redirect`);
  }
});

test('a moved URL is not a surface — it has a destination, not a title', () => {
  for (const from of MOVED_KEYS) {
    assert.equal(surfaceFor(from), null);
    assert.equal(titleFor(from, 'ar'), '');
    assert.equal(navKeyFor(from), null);
  }
});

test('each moved page.tsx is a redirect stub that reads its own destination', () => {
  for (const from of MOVED_KEYS) {
    const source = readFileSync(join(APP_DIR, from.slice(1), 'page.tsx'), 'utf8');
    // Reads the map rather than hardcoding a path: the map and the redirect
    // cannot drift, and a key that is not in the map is a tsc error.
    assert.match(source, /redirect\(MOVED\[/, `${from} does not redirect through MOVED`);
    assert.ok(
      source.includes(`MOVED['${from}']`),
      `${from}/page.tsx redirects through a different key`,
    );
    // The screen is gone, not commented out.
    assert.ok(!source.includes("'use client'"), `${from} still ships a client screen`);
    assert.ok(source.split('\n').length < 40, `${from} is not a stub`);
  }
});

/* -------------------------------------------------------- titles and state -- */

test('every live screen names itself in the header, in both locales', () => {
  for (const surface of SURFACES) {
    for (const locale of ['ar', 'en'] as const) {
      assert.notEqual(
        titleFor(surface.key, locale),
        '',
        `${surface.key} has no ${locale} header title`,
      );
    }
    // A path inside a surface still belongs to it.
    assert.equal(titleFor(`${surface.key}/anything`, 'en'), label(surface, 'en'));
  }
});

test('an unowned path gets no title rather than a guess', () => {
  assert.equal(titleFor('/login', 'en'), '');
  assert.equal(titleFor('/', 'ar'), '');
});

test('the sidebar highlights a nav screen and nothing on a demoted one', () => {
  assert.equal(navKeyFor('/board'), '/board');
  assert.equal(navKeyFor('/digest'), '/digest');
  for (const surface of DEMOTED) {
    assert.equal(navKeyFor(surface.key), null, `${surface.key} lit up a nav entry it is not`);
  }
});

test('matching is on a segment boundary, not a string prefix', () => {
  // /data must not claim a future /database, and /board must not claim /brand.
  assert.equal(navKeyFor('/database'), null);
  assert.equal(navKeyFor('/data/import'), '/data');
  assert.equal(navKeyFor('/brand'), '/brand');
  assert.equal(navKeyFor('/board'), '/board');
});

/* ------------------------------------------------------- dispatch targets -- */

/**
 * Extracts the quoted paths out of a `const NAME ... = { ... };` block.
 * Controlled below — an extractor that found nothing would make the dispatch
 * assertion pass no matter what dispatch.ts says.
 */
function pathsInBlock(source: string, declaration: string): string[] {
  const start = source.indexOf(declaration);
  if (start === -1) return [];
  const end = source.indexOf('};', start);
  if (end === -1) return [];
  return [...source.slice(start, end).matchAll(/'(\/[a-z-]+)'/g)].map((m) => m[1]);
}

test('the path extractor actually extracts', () => {
  const control = [
    "const FEATURE_HREF: Record<DispatchableFeature, string> = {",
    "  concepts: '/concepts',",
    "  ghost: '/nowhere',",
    '};',
  ].join('\n');
  assert.deepEqual(
    pathsInBlock(control, 'const FEATURE_HREF'),
    ['/concepts', '/nowhere'],
  );
  assert.deepEqual(pathsInBlock(control, 'const ABSENT'), []);
});

test('every chat dispatch target still resolves', () => {
  const dispatch = readFileSync(join(REPO, 'src', 'lib', 'agent', 'chat', 'dispatch.ts'), 'utf8');
  const targets = pathsInBlock(dispatch, 'const FEATURE_HREF');
  assert.ok(targets.length > 0, 'found no dispatch targets — the extractor or the block moved');

  for (const target of targets) {
    const live = surfaceFor(target) !== null;
    const moved = MOVED_KEYS.includes(target as MovedUrl);
    assert.ok(live || moved, `dispatch sends the operator to ${target}, which resolves to nothing`);
  }
});

/* ------------------------------------------------------------ hygiene -- */

const CONTROL_BYTES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

test('the control-byte scan catches planted bytes and clears clean Arabic', () => {
  assert.match('left \u200E mark', CONTROL_BYTES);
  assert.match('bell \u0007 here', CONTROL_BYTES);
  assert.doesNotMatch('الدردشة — Chat\ttab\nline', CONTROL_BYTES);
});

test('the files this cut wrote carry no control or bidi bytes', () => {
  const files = [
    join(REPO, 'src', 'lib', 'nav.ts'),
    join(REPO, 'src', 'components', 'Shell.tsx'),
    join(APP_DIR, 'audience', 'page.tsx'),
    join(APP_DIR, 'decisions', 'page.tsx'),
    fileURLToPath(import.meta.url),
  ];
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), CONTROL_BYTES, `${file} carries a control byte`);
  }
});

test('the shell never links to a screen that no longer exists', () => {
  const shell = readFileSync(join(REPO, 'src', 'components', 'Shell.tsx'), 'utf8');
  for (const from of MOVED_KEYS) {
    assert.ok(!shell.includes(`"${from}"`), `Shell.tsx still links to ${from}`);
    assert.ok(!shell.includes(`'${from}'`), `Shell.tsx still links to ${from}`);
  }
});
