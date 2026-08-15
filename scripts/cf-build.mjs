#!/usr/bin/env node
/**
 * cf-build — the Cloudflare Workers build, wrapped so a secret cannot ship.
 *
 * WHY THIS EXISTS
 * ---------------
 * `opennextjs-cloudflare build` runs a step (`compileEnvFiles`) that reads the
 * project's .env files straight off disk and writes their values, verbatim, into
 * `.open-next/cloudflare/next-env.mjs`:
 *
 *   node_modules/@opennextjs/cloudflare/dist/cli/build/open-next/compile-env-files.js
 *     -> extractProjectEnvVars(mode, buildOpts)  // reads .env, .env.<mode>,
 *                                                // .env.local, .env.<mode>.local
 *
 * The adapter's runtime template then imports that file:
 *
 *   node_modules/@opennextjs/cloudflare/dist/cli/templates/init.js
 *     import * as nextEnvVars from "./next-env.mjs";
 *
 * so it is bundled into the worker that `wrangler deploy` uploads. Reading .env
 * from disk is the important detail: scrubbing `process.env` for the child
 * process is NOT enough on its own — the file itself has to be free of secrets
 * while the adapter runs.
 *
 * Note the runtime precedence in init.js:
 *
 *   for (const [key, value] of Object.entries(env)) process.env[key] = value;      // bindings, unconditional
 *   for (const key in nextEnvVars[mode]) process.env[key] ??= nextEnvVars[mode][key]; // baked, fill-only
 *
 * Real Worker bindings and secrets still win, so the baked copy never shadows
 * anything. That is not the problem. The problems are that (a) the secret is
 * sitting in the ~10 MB `worker.js` uploaded to Cloudflare (wrangler prints the
 * exact size as "Total Upload" on every dry-run; it is not fixed here because it
 * changes from build to build), readable by anyone who can pull the script, and (b)
 * because the baked copy silently fills the gap,
 * `wrangler secret put` becomes optional and its absence goes unnoticed. After
 * this script, Worker bindings and secrets are the ONLY source of server-side
 * values at runtime — which is the documented Cloudflare model.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 *   1. Backs up `.env.local`, then rewrites it in place containing ONLY the
 *      `NEXT_PUBLIC_*` entries — the ones that legitimately get inlined into the
 *      client bundle. Every other key is simply absent while the adapter runs,
 *      so it has nothing to bake.
 *   2. Also strips those same non-public keys from the child process's env, so a
 *      value exported in the developer's shell cannot be inlined either.
 *   3. Runs the real adapter build.
 *   4. Restores `.env.local` byte-for-byte.
 *   5. Scans the produced artifacts for the literal value of every non-public
 *      key. Any hit deletes the build output and exits non-zero.
 *
 * CRASH / CTRL-C BEHAVIOUR — read this before changing the file handling
 * ---------------------------------------------------------------------
 * The real `.env.local` is COPIED to `.env.cf-build-backup.local` before the
 * original is overwritten, so its contents exist in two places at every instant;
 * there is no window in which the only copy is in memory.
 *
 *   - Normal exit, thrown error, or a failed build -> the `finally` block
 *     restores `.env.local` and deletes the backup.
 *   - Ctrl-C (SIGINT), SIGTERM, SIGHUP -> handled: restore, then exit 130.
 *     A synchronous `process.on('exit')` hook is the last-ditch net.
 *   - SIGKILL, a power cut, or closing the terminal window on Windows (which
 *     Node cannot intercept) -> no handler runs, so `.env.local` is left in its
 *     sanitised state AND `.env.cf-build-backup.local` is left on disk holding
 *     the real contents. Nothing is lost. The next run of this script detects
 *     the stray backup at startup and restores from it automatically before
 *     doing anything else; a developer can also just rename it back by hand.
 *
 * Two builds at once would defeat all of the above — they would interleave the
 * backup and restore of the same file. `.env.cf-build-lock.local` is taken
 * atomically at startup and a second run refuses to start while the first is
 * alive. A lock left by a killed process is detected as stale (its pid no
 * longer exists) and cleared, so it can never wedge the build permanently.
 *
 * The backup and lock filenames are deliberate on two counts:
 *   - `.gitignore` line 10 is `.env*.local`, which already matches it
 *     (verified with `git check-ignore -v`), so a real-secret file can never
 *     become an untracked surprise or get committed.
 *   - Next.js and the adapter only ever read `.env`, `.env.<mode>`, `.env.local`
 *     and `.env.<mode>.local` for mode in {production, development, test}.
 *     `.env.cf-build-backup.local` is none of those, so the backup is invisible
 *     to both and cannot leak back into the build it is protecting.
 *
 * LIMITS OF THE SCAN — it is a safety net, not a proof
 * ----------------------------------------------------
 *   - Short values are skipped (see MIN_SCAN_LENGTH). Matching a 5-character
 *     value like `false` against a ~10 MB bundle finds thousands of innocent
 *     hits; the flag would be noise and would fail every build. So short values
 *     are NOT checked. They are reported by name at the end so the omission is
 *     visible rather than silent. Keep genuine secrets long.
 *   - A value that is already written into the project's own source is NOT
 *     treated as a leak, because its presence in the bundle is explained by the
 *     source and cannot be attributed to env baking. This project really has
 *     such a case: `src/lib/ingest/handles.ts` hardcodes CANONICAL_HANDLES and
 *     treats IG_HANDLE_PERSONAL / IG_HANDLE_ACADEMY as optional overrides, so
 *     both handles are compiled in no matter what .env.local says. Without this
 *     control the assertion would fail every single build on a value that never
 *     leaked. Such keys are reported as a WARNING naming the source file, never
 *     silently dropped — if the value is genuinely secret, being in a tracked
 *     source file is a worse problem than being in the bundle, and the warning
 *     is where you find that out.
 *   - A false positive is still possible: if a non-public value happens to also
 *     be a legitimate substring of the bundle for some reason that is not in the
 *     source tree (a common word, a string a dependency also contains), the
 *     build fails even though nothing leaked.
 *   - A false negative is possible: the scan looks for the literal bytes only.
 *     A value that is re-encoded on the way in — base64, URL-encoding, chunked
 *     across a minified string concat, or compressed — would not be found.
 *   - Only values present in `.env.local` are searched. A secret that reaches
 *     the bundle from some other source is out of scope here. The one such
 *     source this script CAN see coming is the other env files the adapter
 *     reads (`.env`, `.env.<mode>`, `.env.<mode>.local`, listed in
 *     OTHER_ADAPTER_ENV_FILES): those would be baked unsanitised and their
 *     values would not be in the needle set, so the scan could not catch them.
 *     Their mere existence therefore aborts the build before anything runs.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as util from 'node:util';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env.local');
const BACKUP_FILE = path.join(PROJECT_ROOT, '.env.cf-build-backup.local');
const LOCK_FILE = path.join(PROJECT_ROOT, '.env.cf-build-lock.local');
const OUTPUT_DIR = path.join(PROJECT_ROOT, '.open-next');

/** Keys with this prefix are meant to be inlined into the client bundle. */
const PUBLIC_PREFIX = 'NEXT_PUBLIC_';

/**
 * Every env file the adapter's `extractProjectEnvVars` reads OTHER than
 * `.env.local` (node_modules/@opennextjs/cloudflare/dist/cli/utils/
 * extract-project-env-vars.js: `.env`, `.env.<mode>`, `.env.local`,
 * `.env.<mode>.local` for each of production / development / test — and the
 * output file gets one export per mode, so a `.env.development.local` is baked
 * just as surely as `.env.production`). This script sanitises `.env.local`
 * only, so if any of these exists it would reach the bundle untouched AND
 * unscanned. `.env.example` is not in the list: the adapter never reads it.
 */
const OTHER_ADAPTER_ENV_FILES = [
  '.env',
  '.env.production', '.env.production.local',
  '.env.development', '.env.development.local',
  '.env.test', '.env.test.local',
];

/**
 * Values shorter than this are not searched for. Chosen so the real
 * credentials, handles and addresses in this project are all covered while
 * flags and small integers (`false`, `3`) are not. Raising it hides real
 * secrets; lowering it produces noise. See "LIMITS OF THE SCAN" above.
 */
const MIN_SCAN_LENGTH = 12;

const require_ = createRequire(import.meta.url);
const log = (msg = '') => process.stdout.write(`${msg}\n`);
const rel = (p) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/');

/* ------------------------------------------------------------------ parsing */

/**
 * Parse .env text into a key -> value map.
 *
 * The adapter parses with `@dotenvx/dotenvx`. That is a transitive dependency,
 * not one this project declares, so it is used only when it resolves and
 * Node's built-in `util.parseEnv` is the guaranteed path. Where the two
 * disagree about a value, BOTH readings are searched for later — the needle set
 * should cover anything the adapter might have baked, not just our own reading.
 *
 * @param {string} text
 * @returns {Array<Record<string, string>>} one map per parser that succeeded
 */
function parseEnvAllWays(text) {
  const results = [util.parseEnv(text)];
  try {
    const { parse } = require_('@dotenvx/dotenvx');
    if (typeof parse === 'function') results.push(parse(text));
  } catch {
    // Not resolvable — the built-in reading stands alone. Not an error.
  }
  return results;
}

/**
 * Is a quoted value terminated within `body`?
 *
 * @param {string} body
 * @param {string} quote
 * @returns {boolean}
 */
function isQuoteClosed(body, quote) {
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\') {
      i += 1;
      continue;
    }
    if (body[i] === quote) return true;
  }
  return false;
}

/**
 * Split .env text into records, keeping each record's original lines verbatim.
 * A record is either one assignment (possibly spanning lines, when its value is
 * quoted and the quote does not close on the first line) or one non-assignment
 * line such as a comment or a blank.
 *
 * Keeping the raw lines matters: the surviving NEXT_PUBLIC_* entries are
 * written back byte-identical, so no re-quoting or re-escaping of our own can
 * change what the build sees.
 *
 * @param {string} text
 * @returns {Array<{ key: string | null, lines: string[] }>}
 */
function splitEnvRecords(text) {
  const lines = text.split(/\r?\n/);
  /** @type {Array<{ key: string | null, lines: string[] }>} */
  const records = [];
  const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

  for (let i = 0; i < lines.length; i += 1) {
    const match = assignment.exec(lines[i]);
    if (match === null) {
      records.push({ key: null, lines: [lines[i]] });
      continue;
    }
    const key = match[1];
    const collected = [lines[i]];
    const rest = match[2];
    const opening = /^\s*(['"`])/.exec(rest);
    if (opening !== null) {
      const quote = opening[1];
      let body = rest.slice(rest.indexOf(quote) + 1);
      while (!isQuoteClosed(body, quote) && i + 1 < lines.length) {
        i += 1;
        collected.push(lines[i]);
        body += `\n${lines[i]}`;
      }
    }
    records.push({ key, lines: collected });
  }
  return records;
}

/* ------------------------------------------------------------------- lock */

/*
 * Only one build may hold `.env.local` at a time. Without this, two concurrent
 * runs interleave their backup/restore and can leave the developer with a
 * sanitised `.env.local` and no backup — the exact outcome this script exists
 * to prevent. This is not hypothetical: two runs overlapped in this repo during
 * development, which is how the gap was found.
 *
 * `wx` makes creation atomic — whoever creates the file wins, and the loser
 * never touches `.env.local`. A lock whose owning process is gone is stale and
 * gets cleared, so a killed build does not block the next one forever.
 *
 * The name matches `.gitignore`'s `.env*.local` (same reasoning as the backup)
 * and is not a filename Next.js or the adapter reads.
 */

let lockHeld = false;

/**
 * @param {number} pid
 * @returns {boolean} whether a process with this pid currently exists
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

/**
 * @returns {boolean} whether the lock was acquired
 */
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), {
        flag: 'wx',
      });
      lockHeld = true;
      return true;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
    }

    /** @type {number | null} */
    let ownerPid = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (typeof parsed.pid === 'number') ownerPid = parsed.pid;
    } catch {
      // Unreadable or truncated lock — treat as stale below.
    }

    if (ownerPid !== null && processAlive(ownerPid)) {
      log(`FAIL  Another cf-build is already running (pid ${ownerPid}).`);
      log('      Two builds cannot share .env.local: they would interleave the');
      log('      backup and restore and could destroy it. Wait for that build to');
      log(`      finish, or delete ${rel(LOCK_FILE)} if you know it is dead.`);
      return false;
    }

    log(`! Clearing a stale lock (${rel(LOCK_FILE)}${ownerPid === null ? '' : `, pid ${ownerPid} is gone`}).`);
    fs.rmSync(LOCK_FILE, { force: true });
  }
  log(`FAIL  Could not acquire ${rel(LOCK_FILE)}.`);
  return false;
}

/** Release the lock, but only if this process owns it. Idempotent. */
function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  fs.rmSync(LOCK_FILE, { force: true });
}

/* ------------------------------------------------- env file save / restore */

let restored = false;

/**
 * Put the developer's `.env.local` back exactly as it was and remove the
 * backup. Synchronous and idempotent so it is safe from an `exit` handler.
 */
function restoreEnvFile() {
  if (restored) return;
  if (!fs.existsSync(BACKUP_FILE)) {
    restored = true;
    return;
  }
  fs.copyFileSync(BACKUP_FILE, ENV_FILE);
  fs.rmSync(BACKUP_FILE, { force: true });
  restored = true;
}

/**
 * A backup present before we start means a previous run was killed outright.
 * Restore from it rather than backing up the sanitised leftovers over it.
 */
function recoverStrayBackup() {
  if (!fs.existsSync(BACKUP_FILE)) return;
  log(`! Found ${rel(BACKUP_FILE)} from an interrupted earlier run.`);
  fs.copyFileSync(BACKUP_FILE, ENV_FILE);
  fs.rmSync(BACKUP_FILE, { force: true });
  log(`  Restored ${rel(ENV_FILE)} from it and removed the backup.\n`);
}

/* --------------------------------------------------------------- scanning */

/**
 * Every file under `dir`, recursively.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) files.push(path.join(entry.parentPath, entry.name));
  }
  return files;
}

/**
 * Search every file under `roots` for the literal bytes of each needle.
 * Files are compared as raw buffers, so a hit inside a minified bundle, a
 * source map or a non-UTF-8 file is caught the same way.
 *
 * @param {Array<{ label: string, dir: string }>} roots
 * @param {Array<{ key: string, value: string }>} needles
 * @returns {{ leaks: Array<{ key: string, file: string }>, fileCount: number }}
 */
function scanForLeaks(roots, needles) {
  /** @type {Array<{ key: string, file: string }>} */
  const leaks = [];
  const seen = new Set();
  let fileCount = 0;

  const buffers = needles.map((n) => ({ key: n.key, buf: Buffer.from(n.value, 'utf8') }));

  for (const root of roots) {
    for (const file of listFiles(root.dir)) {
      fileCount += 1;
      const contents = fs.readFileSync(file);
      for (const needle of buffers) {
        if (!contents.includes(needle.buf)) continue;
        const where = `${root.label}/${path.relative(root.dir, file).split(path.sep).join('/')}`;
        const id = `${needle.key} :: ${where}`;
        if (seen.has(id)) continue;
        seen.add(id);
        leaks.push({ key: needle.key, file: where });
      }
    }
  }
  return { leaks, fileCount };
}

/**
 * Directories the pre-existence scan does not descend into. Build output and
 * dependencies are excluded because a hit there would defeat the point: the
 * question is whether the value is in code a human wrote and committed.
 */
const SOURCE_SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.open-next', '.wrangler', 'out', 'build',
]);

/**
 * Files a human could have written the value into: the project tree minus
 * dependencies, build output, and the .env files themselves (a value is in
 * .env.local by definition, and that tells us nothing).
 *
 * @returns {string[]}
 */
function listSourceFiles() {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SOURCE_SCAN_SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile() && !entry.name.startsWith('.env')) {
        files.push(path.join(dir, entry.name));
      }
    }
  };
  walk(PROJECT_ROOT);
  return files;
}

/**
 * Split needles by whether the value is already committed in the project's own
 * source. A value that is already in source will appear in the bundle whatever
 * .env.local contains, so finding it there proves nothing about env baking.
 *
 * Every matching file is listed, not just the first: the first hit is often a
 * doc that merely mentions the value, while the file that actually puts it in
 * the bundle is somewhere in src/. Naming only one would point at the wrong
 * place to fix.
 *
 * @param {Array<{ key: string, value: string }>} needles
 * @returns {{ fromEnvOnly: Array<{ key: string, value: string }>,
 *             inSource: Array<{ key: string, files: string[] }> }}
 */
function partitionBySourcePresence(needles) {
  const sourceFiles = listSourceFiles();
  /** @type {Array<{ key: string, value: string }>} */
  const fromEnvOnly = [];
  /** @type {Array<{ key: string, files: string[] }>} */
  const inSource = [];

  for (const needle of needles) {
    const buf = Buffer.from(needle.value, 'utf8');
    const hits = sourceFiles.filter((file) => fs.readFileSync(file).includes(buf)).map(rel);
    if (hits.length === 0) fromEnvOnly.push(needle);
    else inSource.push({ key: needle.key, files: hits });
  }
  return { fromEnvOnly, inSource };
}

/* -------------------------------------------------------------- child runs */

/**
 * Locate a CLI entry inside an installed package by walking node_modules
 * upwards from the project root.
 *
 * Deliberately NOT `require.resolve`: both packages here declare an `exports`
 * map, and `@opennextjs/cloudflare` maps `./*` to `./dist/api/*.js`, so
 * resolving a subpath through it rewrites the request into something that does
 * not exist. The CLI entry is not an exported subpath in the first place — it
 * is a `bin`. Walking the directory tree asks the question we actually mean and
 * still handles a hoisted install.
 *
 * @param {string} packageName e.g. "wrangler" or "@opennextjs/cloudflare"
 * @param {string} binRelativePath path to the CLI entry inside that package
 * @returns {string | null}
 */
function resolvePackageBin(packageName, binRelativePath) {
  let dir = PROJECT_ROOT;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...packageName.split('/'), binRelativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Run a Node CLI from node_modules and stream its output through.
 *
 * @param {string} packageName
 * @param {string} binRelativePath path to the CLI entry inside that package
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {number} exit code
 */
function runNodeCli(packageName, binRelativePath, args, env) {
  const entry = resolvePackageBin(packageName, binRelativePath);
  if (entry === null) {
    log(`FAIL  Cannot find ${packageName}/${binRelativePath} under node_modules — is the dependency installed?`);
    return 1;
  }
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });
  if (result.error) {
    log(`FAIL  ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/* -------------------------------------------------------------------- main */

function main() {
  log('cf-build — secret-safe Cloudflare Workers build\n');

  if (!acquireLock()) return 1;

  // Registered as soon as the lock is held, so every later exit path — normal
  // return, throw, failed build, Ctrl-C — both restores .env.local and frees
  // the lock. Both operations are idempotent and synchronous, which is what
  // makes them safe to run from an `exit` handler.
  const cleanup = () => {
    restoreEnvFile();
    releaseLock();
  };
  process.on('exit', cleanup);
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }

  recoverStrayBackup();

  // Refuse to build while any OTHER adapter-read env file exists. Those files
  // are neither sanitised nor searched by this script, so a secret in one of
  // them would be baked into next-env.mjs and the scan below could not see it.
  // Keep `.env.local` as the single env file, or extend this script first.
  const otherEnvFiles = OTHER_ADAPTER_ENV_FILES.filter((name) => fs.existsSync(path.join(PROJECT_ROOT, name)));
  if (otherEnvFiles.length > 0) {
    log(`FAIL  Found env file(s) the adapter would bake but this script does not sanitise:`);
    for (const name of otherEnvFiles) log(`        ${name}`);
    log('      Their values are outside the leak scan, so the artifact could not be');
    log('      asserted clean. Move what you need into .env.local and remove them.');
    log('      Nothing was built. Your .env.local is untouched.');
    return 1;
  }

  if (!fs.existsSync(ENV_FILE)) {
    log(`No ${rel(ENV_FILE)} — nothing to sanitise, nothing to scan for.`);
    log('Running the adapter build directly.\n');
    return runNodeCli('@opennextjs/cloudflare', 'dist/cli/index.js', ['build'], process.env);
  }

  const originalText = fs.readFileSync(ENV_FILE, 'utf8');
  const parsings = parseEnvAllWays(originalText);
  const allKeys = [...new Set(parsings.flatMap((p) => Object.keys(p)))].sort();
  const publicKeys = allKeys.filter((k) => k.startsWith(PUBLIC_PREFIX));
  const privateKeys = allKeys.filter((k) => !k.startsWith(PUBLIC_PREFIX));

  // Needles: every reading of every non-public value, deduplicated. Empty and
  // short values are held back and reported instead of matched.
  /** @type {Array<{ key: string, value: string }>} */
  const needles = [];
  /** @type {string[]} */
  const skipped = [];
  for (const key of privateKeys) {
    const values = [...new Set(parsings.map((p) => p[key]).filter((v) => typeof v === 'string'))];
    const usable = values.filter((v) => v.length >= MIN_SCAN_LENGTH);
    if (usable.length === 0) {
      const longest = values.reduce((n, v) => Math.max(n, v.length), 0);
      skipped.push(`${key} (${longest === 0 ? 'empty' : `${longest} chars`})`);
      continue;
    }
    for (const value of usable) needles.push({ key, value });
  }

  // Values already committed in the project's own source are excused from the
  // leak test (they would be in the bundle regardless of .env.local) but are
  // reported loudly, because a genuinely secret value sitting in a tracked file
  // is a worse problem than one in the bundle.
  const { fromEnvOnly, inSource } = partitionBySourcePresence(needles);

  log(`Keys in ${rel(ENV_FILE)}: ${allKeys.length}`);
  log(`  inlined into the build (${PUBLIC_PREFIX}*): ${publicKeys.length === 0 ? '—' : publicKeys.join(', ')}`);
  log(`  withheld from the build:                   ${privateKeys.length === 0 ? '—' : privateKeys.join(', ')}`);
  if (inSource.length > 0) {
    log('');
    log('WARN  These values are already committed in the project source, so they');
    log('      will be in the bundle no matter what .env.local holds. They are');
    log('      excluded from the leak test below — it could not pass otherwise.');
    log('      If any of them is actually secret, fix the source file, not this build:');
    for (const entry of inSource) log(`        ${entry.key} -> ${entry.files.join(', ')}`);
  }
  log('');

  // Build the sanitised file from the original lines, unchanged.
  const records = splitEnvRecords(originalText);
  const sanitisedText = [
    '# TEMPORARY — written by scripts/cf-build.mjs for the duration of one build.',
    '# The real file is at .env.cf-build-backup.local and is restored on exit.',
    '# If you are reading this outside a running build, that build was killed:',
    '# rename .env.cf-build-backup.local back to .env.local, or just re-run',
    '# `npm run cf:build`, which restores it automatically at startup.',
    '',
    ...records.filter((r) => r.key !== null && r.key.startsWith(PUBLIC_PREFIX)).flatMap((r) => r.lines),
    '',
  ].join('\n');

  // Prove the sanitised text still parses to exactly the public entries, with
  // identical values, before anything is written to disk.
  for (const parsed of parseEnvAllWays(sanitisedText)) {
    const got = Object.keys(parsed).sort();
    const missing = publicKeys.filter((k) => !got.includes(k));
    const extra = got.filter((k) => !publicKeys.includes(k));
    if (missing.length > 0 || extra.length > 0) {
      log('FAIL  Sanitised .env.local did not round-trip.');
      if (missing.length > 0) log(`      Lost: ${missing.join(', ')}`);
      if (extra.length > 0) log(`      Unexpectedly kept: ${extra.join(', ')}`);
      log('      Nothing was written. Your .env.local is untouched.');
      return 1;
    }
    for (const key of publicKeys) {
      const before = parsings.map((p) => p[key]);
      if (!before.includes(parsed[key])) {
        log(`FAIL  Sanitised .env.local changed the value of ${key}.`);
        log('      Nothing was written. Your .env.local is untouched.');
        return 1;
      }
    }
  }

  // The child's env: drop every non-public key this project defines, so a value
  // exported in the developer's shell cannot be inlined either. Unrelated OS
  // variables (PATH, SystemRoot, ...) are left alone — the build needs them.
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = { ...process.env };
  for (const key of privateKeys) delete childEnv[key];

  // From here the real file is on disk in two places at once, never one.
  // The cleanup handlers registered at lock acquisition already cover it.
  fs.copyFileSync(ENV_FILE, BACKUP_FILE);

  let buildStatus;
  try {
    fs.writeFileSync(ENV_FILE, sanitisedText);
    log(`Sanitised ${rel(ENV_FILE)} (backup: ${rel(BACKUP_FILE)}). Running adapter build.\n`);
    buildStatus = runNodeCli('@opennextjs/cloudflare', 'dist/cli/index.js', ['build'], childEnv);
  } finally {
    restoreEnvFile();
    log(`\nRestored ${rel(ENV_FILE)}.`);
  }

  if (buildStatus !== 0) {
    log(`\nFAIL  Adapter build exited ${buildStatus}. No artifact to check.`);
    return buildStatus;
  }

  /* ---- the assertion ---- */

  log('\n--- artifact secret scan ---\n');

  if (fromEnvOnly.length === 0) {
    log('No non-public value is both long enough to search for and absent from the');
    log('project source. There is nothing this scan can assert. Treat the build as');
    log('UNVERIFIED rather than clean.');
    if (skipped.length > 0) log(`  Not checked (too short/empty): ${skipped.join(', ')}`);
    if (inSource.length > 0) {
      log(`  Not checked (already in source): ${[...new Set(inSource.map((e) => e.key))].join(', ')}`);
    }
    return 0;
  }

  // Two roots are scanned, and both are needed.
  //
  //   .open-next/    what the adapter produced. This is where the baked file
  //                  (cloudflare/next-env.mjs) lives, so a leak here names its
  //                  actual origin instead of a minified offset.
  //   wrangler out/  what `deploy` actually uploads. wrangler re-bundles
  //                  .open-next/worker.js through esbuild, following imports
  //                  and inlining them; the audit found the key in THIS output,
  //                  not by reading next-env.mjs. Scanning only .open-next
  //                  would be scanning a proxy for the thing that ships.
  //
  // `--dry-run` builds the bundle and stops: no upload, no API call, no network
  // spend. The temp directory is outside the repo (so it can never be committed
  // even if this process dies) and is deleted below.
  const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-build-scan-'));
  /** @type {Array<{ label: string, dir: string }>} */
  const roots = [{ label: '.open-next', dir: OUTPUT_DIR }];
  try {
    log(`Bundling with wrangler --dry-run to inspect the bytes deploy would upload.`);
    const dryRunStatus = runNodeCli('wrangler', 'bin/wrangler.js',
      ['deploy', '--dry-run', '--outdir', scanDir], childEnv);
    if (dryRunStatus !== 0) {
      log(`\nFAIL  wrangler --dry-run exited ${dryRunStatus}; the uploaded bundle could not be`);
      log('      inspected. Refusing to report the artifact clean on partial evidence.');
      fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
      log(`      Deleted ${rel(OUTPUT_DIR)}.`);
      return dryRunStatus;
    }
    roots.push({ label: 'wrangler-bundle', dir: scanDir });

    const checkedKeys = [...new Set(fromEnvOnly.map((n) => n.key))];
    log(`\nSearching for ${fromEnvOnly.length} value(s) across ${checkedKeys.length} non-public key(s).`);
    const { leaks, fileCount } = scanForLeaks(roots, fromEnvOnly);
    log(`Scanned ${fileCount} file(s) in ${roots.map((r) => r.label).join(' and ')}.`);

    if (leaks.length > 0) {
      log('\nFAIL  SECRET FOUND IN THE BUILD OUTPUT. This must not be deployed.\n');
      for (const leak of leaks) log(`      ${leak.key} -> ${leak.file}`);
      log('\n      (Key names only. The values are not printed.)');
      fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
      log(`      Deleted ${rel(OUTPUT_DIR)} so it cannot be deployed.`);
      return 1;
    }

    log('\nPASS  No withheld value appears in the build output.');
    for (const key of checkedKeys) log(`      clean: ${key}`);
    if (skipped.length > 0) {
      log(`\n      Not checked (empty or under ${MIN_SCAN_LENGTH} chars — would match noise):`);
      for (const entry of skipped) log(`        ${entry}`);
    }
    if (inSource.length > 0) {
      log('\n      Not checked (already committed in the source, see WARN above):');
      for (const key of [...new Set(inSource.map((e) => e.key))]) log(`        ${key}`);
    }
    log('\n      Every server-side value must now come from a Worker binding or');
    log('      `wrangler secret put`. There is no baked fallback left.');
    return 0;
  } finally {
    fs.rmSync(scanDir, { recursive: true, force: true });
  }
}

process.exitCode = main();
