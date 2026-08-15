/**
 * Demo preflight.  npm run demo:check
 *
 * Red means do not demo. Every failure names the fix, because a checklist that
 * only says "no" gets ignored five minutes before a pitch.
 */
import { createClient } from '@supabase/supabase-js';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

let failures = 0;
let notes = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, fix) => {
  failures += 1;
  console.log(`  FAIL  ${label}\n        fix: ${fix}`);
};

/**
 * A third outcome, and it earns its place rather than softening the second one.
 *
 * FAIL means "a person can make this green before the demo". Some states are
 * neither green nor fixable from this checklist: the thing is genuinely absent,
 * the reason is upstream, and no button on any screen will change it today.
 * Printing those as FAIL trains the reader to skim past red — the exact failure
 * mode the header of this file exists to prevent — and printing them as PASS
 * would be a lie. NOTE says the true thing: measured, stated, not actionable
 * here, and NOT counted toward the exit code.
 *
 * The bar is deliberately high. A NOTE must name the upstream blocker it
 * measured, and any check that could be made green by an operator action is a
 * FAIL. Nothing that was a FAIL before this comment was written is a NOTE now.
 */
const note = (label, detail) => {
  notes += 1;
  console.log(`  NOTE  ${label}\n        ${detail}`);
};

console.log('\nDemo preflight\n');

/* ------------------------------------------------------------- config --- */
const openrouter = process.env.OPENROUTER_API_KEY?.trim();
const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
const provider = (process.env.AI_PROVIDER ?? (openrouter ? 'openrouter' : anthropic ? 'anthropic' : '')).toLowerCase();

if (!provider) {
  bad('Model provider key', 'set OPENROUTER_API_KEY in .env.local (openrouter.ai/keys), the default provider, and add credit — or ANTHROPIC_API_KEY with AI_PROVIDER=anthropic to use Anthropic directly');
} else {
  // A key that is present but rejected is worse than one that is absent,
  // because it fails in front of the client rather than here.
  let live = false;
  let detail = '';
  try {
    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { authorization: `Bearer ${openrouter}` },
      });
      live = res.ok;
      detail = res.ok ? 'key accepted by OpenRouter' : `OpenRouter returned ${res.status}`;
    } else {
      live = Boolean(anthropic);
      detail = 'key present (not called)';
    }
  } catch (err) {
    detail = err.message;
  }
  live ? ok('Model provider key', detail) : bad('Model provider key', `key rejected — ${detail}`);
}

// Hard rule 9 is estimate-before-spend, and checkBudget() reads an absent
// ceiling as "nothing to exceed" — right in code, wrong on a demo laptop where
// a mistyped result count is one confirm away from a real charge.
const budgetRaw = process.env.APIFY_BUDGET_USD?.trim() ?? '';
if (budgetRaw === '') {
  bad(
    'Budget guard armed',
    'APIFY_BUDGET_USD is blank, so no ceiling exists and every scrape that can be ' +
      'estimated is allowed through — set APIFY_BUDGET_USD=<dollars> in .env.local',
  );
} else {
  const budget = Number(budgetRaw);
  Number.isFinite(budget) && budget >= 0
    ? ok('Budget guard armed', `ceiling $${budget.toFixed(2)} per scrape action`)
    : bad(
        'Budget guard armed',
        `APIFY_BUDGET_USD is "${budgetRaw}", which is not a usable ceiling — the app blocks ` +
          'every scrape rather than reading it as unlimited. Put a non-negative number in .env.local',
      );
}

if (!url || !serviceKey) {
  bad('Supabase credentials', 'fill NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  console.log(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

/* ----------------------------------------------------------- v3 schema --- */
/**
 * Without this check, "no profile snapshot" and "no comments stored" below are
 * indistinguishable from "those tables were never created". Same red line, two
 * completely different fixes: one is a scrape, the other is a migration. So the
 * four tables 0002 adds are probed first, and a missing one says so by name.
 */
const V3_MIGRATION = 'supabase/migrations/0002_v3_ingestion.sql';
const V3_TABLES = ['scrape_runs', 'profile_snapshots', 'comments', 'audience_insights'];

/** PostgREST reports an absent table as 42P01, or as a schema-cache miss. */
const isMissingTable = (error) =>
  error.code === '42P01' ||
  error.code === 'PGRST205' ||
  /schema cache|does not exist/i.test(error.message ?? '');

// A real GET, not a `head: true` count. Measured against this project: a head
// count of a table that does not exist returns 204 with error null, so a
// count-based probe would pass on the very schema it is here to catch. The same
// query as `.select('id').limit(1)` returns 404 PGRST205 with the table named.
const v3Probes = await Promise.all(
  V3_TABLES.map(async (table) => {
    const { error } = await db.from(table).select('id').limit(1);
    return { table, error };
  }),
);

const v3Missing = v3Probes.filter(({ error }) => error && isMissingTable(error));
const v3Unreadable = v3Probes.filter(({ error }) => error && !isMissingTable(error));

if (v3Missing.length > 0) {
  bad(
    'v3 tables reachable',
    `${v3Missing.map(({ table }) => table).join(', ')} not in the database — apply ${V3_MIGRATION} ` +
      '(Supabase dashboard → SQL editor → paste the file → Run; it is additive and touches no ' +
      '0001 table). Until it is applied, the profile, comments and audience checks below read as ' +
      '"nothing stored" when what is true is "nowhere to store it"',
  );
} else if (v3Unreadable.length > 0) {
  bad(
    'v3 tables reachable',
    `${v3Unreadable.map(({ table, error }) => `${table}: ${error.message}`).join('; ')} — the tables ` +
      `${V3_MIGRATION} creates are present but could not be read, so this preflight cannot see the ` +
      'v3 data at all; confirm SUPABASE_SERVICE_ROLE_KEY is the service-role key and not the anon ' +
      'key (RLS is deny-all, so the anon key reads nothing)',
  );
} else {
  ok('v3 tables reachable', `${V3_TABLES.join(', ')} — all ${V3_TABLES.length} present`);
}

/* --------------------------------------------------------------- data --- */
/**
 * `posts` is UNIQUE (snapshot_id, ig_id): one ROW per post per snapshot, so the
 * same post gets another row on every re-scrape. A `count: 'exact'` head count
 * of that table counts scrape rows, and reporting it as "Posts ingested" would
 * announce 640 posts the day the 320 real ones are scraped a second time. So the
 * rows are read and collapsed on ig_id here, exactly as distinctPosts() does in
 * src/lib/audience/posts.ts, and BOTH numbers are printed — a post count that
 * silently disagreed with the row count anyone can see in the table would be its
 * own small lie.
 *
 * The cap mirrors MAX_POSTS_SCAN in that module. Duplicated rather than imported
 * because this script is plain .mjs and the module is TypeScript.
 */
const MAX_POSTS_SCAN = 2000;
const MAX_SNAPSHOTS_SCAN = 200;
/** Sorts a row whose snapshot is not in the ranking behind every ranked one. */
const UNRANKED = Number.MAX_SAFE_INTEGER;

const [
  { data: snapshotOrder },
  { data: postRows, error: postsError },
  { data: analysisRows, error: analysesError },
  { count: canonChunks },
] = await Promise.all([
  db
    .from('snapshots')
    .select('id')
    .order('taken_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(MAX_SNAPSHOTS_SCAN),
  db
    .from('posts')
    .select('id, ig_id, snapshot_id')
    .order('engagement', { ascending: false })
    .limit(MAX_POSTS_SCAN),
  db.from('post_analyses').select('post_id'),
  db.from('canon_chunks').select('id', { count: 'exact', head: true }),
]);

// Scrape recency as a rank: newest snapshot 0, the one before it 1. A post row
// carries no timestamp of its own — posted_at is identical in every re-scrape —
// so snapshots.taken_on is the only place scrape recency lives, and without it
// "the freshest copy wins" would be a hope rather than a rule.
const snapshotRank = new Map();
for (const row of snapshotOrder ?? []) {
  if (!snapshotRank.has(row.id)) snapshotRank.set(row.id, snapshotRank.size);
}

const postRowList = postRows ?? [];
/** ig_id -> the winning row, i.e. the copy from the most recent snapshot. */
const winners = new Map();
for (const row of postRowList) {
  const rank = snapshotRank.get(row.snapshot_id) ?? UNRANKED;
  const held = winners.get(row.ig_id);
  if (held === undefined || rank < held.rank) winners.set(row.ig_id, { id: row.id, rank });
}

const rowCount = postRowList.length;
const distinctPostCount = winners.size;
const collapsedRows = rowCount - distinctPostCount;
const snapshotsSeen = new Set(postRowList.map((row) => row.snapshot_id)).size;
// A read that filled its cap may have left rows behind; how many is unknowable
// from the result, so this says "at least", never "N of M".
const postsTruncated = rowCount >= MAX_POSTS_SCAN;

if (postsError) {
  bad('Posts ingested', `the posts table could not be read — ${postsError.message}`);
} else if (distinctPostCount > 0) {
  ok(
    'Posts ingested',
    `${distinctPostCount} post(s) in ${rowCount} row(s) across ${snapshotsSeen} snapshot(s)` +
      `${collapsedRows > 0 ? `, ${collapsedRows} re-scrape row(s) collapsed` : ''}` +
      `${postsTruncated ? ` — the read stopped at its ${MAX_POSTS_SCAN}-row cap, so this is a floor` : ''}`,
  );
} else {
  bad('Posts ingested', 'run the monitor on the Data screen, or upload an Apify export');
}

// Counted against the same population, because post_analyses.post_id references
// posts.id — the ROW, not the Instagram post. An analysis written against a row
// that a later scrape superseded decorates no card on /board, so counting it as
// progress would turn this check green over a board that is visibly empty.
const analysedRowIds = new Set((analysisRows ?? []).map((row) => row.post_id));
const analysedPosts = [...winners.values()].filter((w) => analysedRowIds.has(w.id)).length;
const strandedAnalyses = (analysisRows ?? []).length - analysedPosts;
const strandedNote =
  strandedAnalyses > 0
    ? `; ${strandedAnalyses} stored analysis/analyses point at post rows a later scrape superseded, so they show on no card`
    : '';

if (analysesError) {
  bad('Board analysed', `post_analyses could not be read — ${analysesError.message}`);
} else if (distinctPostCount > 0 && analysedPosts >= distinctPostCount) {
  ok('Board analysed', `${analysedPosts}/${distinctPostCount} post(s)${strandedNote}`);
} else {
  bad(
    'Board analysed',
    `${analysedPosts}/${distinctPostCount} post(s) — open /board and run "Analyze all" until it reads complete${strandedNote}`,
  );
}

canonChunks > 0
  ? ok('Canon ingested', `${canonChunks} chunks`)
  : bad('Canon ingested', 'npm run ingest:canon -- ./refs/guideline-anatomy.md --kind internal');

/* ------------------------------------------------------------ monitor --- */
const ACCOUNTS = ['personal', 'academy'];
const HANDLE_ENV_KEY = { personal: 'IG_HANDLE_PERSONAL', academy: 'IG_HANDLE_ACADEMY' };

/** Lowercase, trimmed, no leading `@` — the normalisation handles.ts applies. */
const normaliseHandle = (raw) => {
  const cleaned = String(raw ?? '').trim().replace(/^@+/, '').trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
};

const configuredHandles = {
  personal: normaliseHandle(process.env.IG_HANDLE_PERSONAL),
  academy: normaliseHandle(process.env.IG_HANDLE_ACADEMY),
};

// The handles the stored posts actually came from. Two sources, because the
// rows ingested before the v3 columns existed carry owner_username = null: the
// scrape's own recorded usernames, plus the column later runs stamp per row.
const observedHandles = { personal: new Set(), academy: new Set() };

const { data: latestSnapshot } = await db
  .from('snapshots')
  .select('raw_meta')
  .order('created_at', { ascending: false })
  .limit(1);

const snapshotUsernames = latestSnapshot?.[0]?.raw_meta?.usernames ?? {};
for (const account of ACCOUNTS) {
  const listed = snapshotUsernames[account];
  for (const name of Array.isArray(listed) ? listed : [listed]) {
    const handle = normaliseHandle(name);
    if (handle) observedHandles[account].add(handle);
  }
}

const { data: owners } = await db
  .from('posts')
  .select('account, owner_username')
  .not('owner_username', 'is', null);
for (const row of owners ?? []) {
  const handle = normaliseHandle(row.owner_username);
  if (handle && observedHandles[row.account]) observedHandles[row.account].add(handle);
}

const handleProblems = [];
// Only a genuine mismatch earns the "watching nobody" verdict. A blank override
// still resolves to the proven default inside handles.ts, so it is unverified
// here, not broken — saying otherwise would be a failure message that lies.
let handleMismatch = false;

for (const account of ACCOUNTS) {
  const key = HANDLE_ENV_KEY[account];
  const configured = configuredHandles[account];
  const seen = [...observedHandles[account]];

  if (configured === null) {
    handleProblems.push(
      seen.length > 0
        ? `${key} is blank, so the handle falls back to a default this preflight cannot read — pin it: ${key}=${seen[0]} in .env.local, which is where the stored ${account} posts came from`
        : `${key} is blank and no stored ${account} post records a username, so there is nothing to check it against — fill it from .env.example`,
    );
  } else if (seen.length === 0) {
    handleProblems.push(
      `${key} is @${configured} but no stored ${account} post records a username, so it could not be checked against the data — run the monitor on /data`,
    );
  } else if (!observedHandles[account].has(configured)) {
    handleMismatch = true;
    handleProblems.push(
      `${key} is @${configured} but the stored ${account} posts came from ${seen.map((h) => `@${h}`).join(', ')}`,
    );
  }
}

handleProblems.length === 0
  ? ok(
      'Canonical handles',
      `${ACCOUNTS.map((a) => `@${configuredHandles[a]}`).join(' · ')} — both match the ingested data`,
    )
  : bad(
      'Canonical handles',
      `${handleProblems.join('; ')}.${
        handleMismatch
          ? ' A handle that does not match the data means the monitor is watching nobody: it polls' +
            ' an account no stored post came from, routes every scraped item to no account, and' +
            ' reports a successful run that ingested nothing.'
          : ''
      }`,
    );

/**
 * Fresh = taken within this many days. Follower counts are the one figure the
 * post export never carries, so a stale or absent profile snapshot is the
 * difference between a follower number on the Dashboard and an em-dash.
 */
const PROFILE_FRESH_DAYS = 7;
const FRESH_MEANS = `fresh means taken within ${PROFILE_FRESH_DAYS} days`;

const { data: profileRows } = await db
  .from('profile_snapshots')
  .select('account, taken_on')
  .order('taken_on', { ascending: false });

const now = new Date();
const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const ageInDays = (takenOn) =>
  Math.round((todayUtcMs - Date.parse(`${takenOn}T00:00:00Z`)) / 86_400_000);

const latestProfile = {};
for (const row of profileRows ?? []) {
  if (!Object.hasOwn(latestProfile, row.account)) latestProfile[row.account] = row.taken_on;
}

const withProfile = ACCOUNTS.filter((a) => Object.hasOwn(latestProfile, a));
const missingProfiles = ACCOUNTS.filter((a) => !Object.hasOwn(latestProfile, a));
const staleProfiles = withProfile.filter((a) => ageInDays(latestProfile[a]) > PROFILE_FRESH_DAYS);
const profileAges = withProfile.map((a) => `${a} ${ageInDays(latestProfile[a])}d`).join(', ');
const PROFILE_FIX = '/data → Automated scrapes → "Run profile scrape" (it pulls both handles in one run and estimates the cost first)';

if (missingProfiles.length === ACCOUNTS.length) {
  bad(
    'Profile snapshot fresh',
    `no profile snapshot has ever been taken, so followers render as an em-dash everywhere — ${FRESH_MEANS}; run ${PROFILE_FIX}`,
  );
} else if (missingProfiles.length > 0) {
  bad(
    'Profile snapshot fresh',
    `nothing for ${missingProfiles.join(' or ')} (have ${profileAges}) — ${FRESH_MEANS}; run ${PROFILE_FIX}`,
  );
} else if (staleProfiles.length > 0) {
  bad(
    'Profile snapshot fresh',
    `${profileAges} old — ${FRESH_MEANS}; re-run ${PROFILE_FIX}`,
  );
} else {
  ok('Profile snapshot fresh', `${profileAges} old — ${FRESH_MEANS}`);
}

/* ----------------------------------------------------------- audience --- */
const { data: insightRows } = await db
  .from('audience_insights')
  .select('created_at, grounding')
  .order('created_at', { ascending: false })
  .limit(1);

const { count: commentCount } = await db
  .from('comments')
  .select('id', { count: 'exact', head: true });

const insight = insightRows?.[0];
if (insight) {
  ok(
    'Audience insights generated',
    `latest ${String(insight.created_at).slice(0, 10)}, grounding ${insight.grounding}`,
  );
} else if ((commentCount ?? 0) === 0) {
  bad(
    'Audience insights generated',
    'no comments are stored, so there is nothing to read — run /data → Automated scrapes → ' +
      '"Run comment scrape" (aggregate only), then /audience → Generate',
  );
} else {
  bad(
    'Audience insights generated',
    `${commentCount} comment(s) stored but never analysed — open /audience and press Generate`,
  );
}

/* ---------------------------------------------------------- guideline --- */
const { data: guidelines } = await db
  .from('brand_guidelines')
  .select('version, status')
  .order('version', { ascending: false })
  .limit(1);

const latest = guidelines?.[0];
if (latest?.status === 'approved') ok('Guideline approved', `v${latest.version}`);
else if (latest) bad('Guideline approved', `v${latest.version} is a draft — approve it on /guideline`);
else bad('Guideline approved', 'generate one on /guideline, then approve it');

/* ------------------------------------------------------------ bakeoff --- */
const { data: winner } = await db
  .from('bakeoff_runs')
  .select('model, created_at')
  .eq('task', 'default_model')
  .order('created_at', { ascending: false })
  .limit(1);

winner?.[0]
  ? ok('Bake-off winner set', `${winner[0].model}`)
  : bad(
      'Bake-off winner set',
      'npm run bakeoff, grade the blind outputs, then record the winner — the default model must be chosen, not inherited',
    );

/* -------------------------------------------------------------- brand --- */
const { data: brand } = await db
  .from('brand')
  .select('status, palette, voice_examples, knowledge, assets')
  .eq('id', 1)
  .maybeSingle();

brand?.status === 'live'
  ? ok('Brand is live', `${Object.keys(brand.palette?.swatches ?? {}).length} swatches`)
  : bad('Brand is live', 'save a palette in Brand Brain → Identity');

(brand?.voice_examples?.length ?? 0) > 0
  ? ok('Voice examples', `${brand.voice_examples.length}`)
  : bad('Voice examples', 'the register check needs real captions — see Brand Brain → Voice');

/* --------------------------------------------------- the WOW path data --- */
const { data: topPost } = await db
  .from('posts')
  .select('engagement, caption')
  .order('engagement', { ascending: false })
  .limit(1);

topPost?.[0]
  ? ok('Hero post present', `${topPost[0].engagement.toLocaleString('en-US')} engagement`)
  : bad('Hero post present', 'the Board opener needs at least one post — ingest data');

const { count: checks } = await db
  .from('compliance_checks')
  .select('id', { count: 'exact', head: true });

checks > 0
  ? ok('Compliance rehearsed', `${checks} previous check(s) — the WOW path has been run`)
  : bad('Compliance rehearsed', 'run the off-brand paste through /compliance at least once before demoing');

const { count: concepts } = await db.from('concepts').select('id', { count: 'exact', head: true });
concepts > 0
  ? ok('Warm concepts cached', `${concepts}`)
  : bad('Warm concepts cached', 'generate a batch on /concepts so a slow live run has something to fall back on');

/* ============================================================== v4 surfaces ==
 *
 * The strategist, the ledger, the vision layer and the MCP door. Each of these
 * is a screen or an endpoint a demo can land on, so each gets the same
 * treatment as everything above: measured against the real deployment, and a
 * failure that names the one action that clears it.
 * ========================================================================== */

/* -------------------------------------------------------------- the digest -- */

/**
 * The strategist's output. /digest is the screen the ledger hangs off, and an
 * absent digest is an empty state there — so this is checked before the
 * decisions that a digest is what produces.
 */
const { data: digestRows, error: digestError } = await db
  .from('digests')
  // The columns 0003_strategist.sql actually declares. Named explicitly rather
  // than `select('*')` so a wrong guess fails loudly here — as it did — instead
  // of quietly rendering an undefined as an empty string in the line below.
  .select('period_from, period_to, status, created_at, sent')
  .order('created_at', { ascending: false })
  .limit(1);

const digest = digestRows?.[0];
if (digestError) {
  bad(
    'Digest exists',
    `the digests table could not be read — ${digestError.message}. Confirm SUPABASE_SERVICE_ROLE_KEY is ` +
      'the service-role key, and that supabase/migrations/0003_strategist.sql is applied',
  );
} else if (digest) {
  // `sent` is recorded by a human, by hand, in the database — nothing in this
  // app writes it (hard rule 1). So it is reported, never required.
  ok(
    'Digest exists',
    `${digest.period_from} → ${digest.period_to}, ${digest.status}, written ${String(digest.created_at).slice(0, 10)}` +
      `${digest.sent ? ' (recorded as sent)' : ' (not marked sent — a human records that by hand)'}`,
  );
} else {
  bad(
    'Digest exists',
    'no digest has ever been written, so /digest is an empty state and the decision ledger it feeds ' +
      'has nothing in it — open /digest and press Run. That run calls a model, so the provider key ' +
      'check above has to be green first',
  );
}

/* ------------------------------------------------------------- the ledger -- */

/**
 * Amman's date, assembled from NAMED parts — the same construction
 * todayInAmman() uses in src/lib/agent/features/strategist.ts, and for the same
 * reason: en-CA renders ISO-shaped dates today, and reading the segments by
 * position would let a locale-data change silently produce a plausible wrong
 * date. `past_review` is computed against Amman by /api/decisions, so a
 * preflight computing it against UTC would disagree with the screen for three
 * hours of every day.
 */
const AMMAN_TIME_ZONE = 'Asia/Amman';
const AMMAN_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: AMMAN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function todayInAmman() {
  const parts = AMMAN_DATE_FORMAT.formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const iso = `${part('year')}-${part('month')}-${part('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Could not resolve today's date in ${AMMAN_TIME_ZONE}.`);
  }
  return iso;
}

const ammanToday = todayInAmman();

/**
 * A decision past its review date with no verdict recorded is the one state the
 * ledger exists to make impossible to ignore. It is also the worst thing to
 * walk into live: the demo opens /decisions, and the top row is an overdue
 * question nobody answered.
 *
 * The population is always stated. "0 past due" over an EMPTY ledger and "0
 * past due" over forty judged decisions are different facts, and printing the
 * same green line for both would be the kind of zero-standing-in-for-absence
 * this checklist refuses everywhere else (hard rule 2).
 */
const { data: ledgerRows, error: ledgerError } = await db
  .from('decisions')
  .select('id, status, review_after, statement_ar')
  .order('review_after', { ascending: true });

if (ledgerError) {
  bad(
    'Decision ledger reviewed',
    `the decisions table could not be read — ${ledgerError.message}. Confirm ` +
      'supabase/migrations/0003_strategist.sql is applied',
  );
} else {
  const ledger = ledgerRows ?? [];
  const open = ledger.filter((row) => row.status === 'open');
  const pastDue = open.filter((row) => row.review_after <= ammanToday);

  if (pastDue.length > 0) {
    const oldest = pastDue[0];
    bad(
      'Decision ledger reviewed',
      `${pastDue.length} of ${open.length} open decision(s) are past their review date as of ` +
        `${ammanToday} in ${AMMAN_TIME_ZONE} — the oldest came due ${oldest.review_after}. Open ` +
        '/decisions, read what actually happened, and record validated / refuted / superseded with ' +
        'a note on each. There is no path back to open, so record only what you can stand behind',
    );
  } else if (ledger.length === 0) {
    // Vacuously true, and said as such. Green here means "nothing is overdue"
    // and NOT "the ledger is healthy" — there is no ledger yet.
    ok(
      'Decision ledger reviewed',
      `nothing is overdue because the ledger is empty — 0 decisions on record. It fills when a ` +
        `digest runs (checked above); the date this was computed against is ${ammanToday} in ${AMMAN_TIME_ZONE}`,
    );
  } else {
    ok(
      'Decision ledger reviewed',
      `0 of ${open.length} open decision(s) past due, ${ledger.length} on record — as of ` +
        `${ammanToday} in ${AMMAN_TIME_ZONE}`,
    );
  }
}

/* ------------------------------------------------------- the visual batch -- */

/**
 * HOW 0/320 IS REPORTED, AND WHY IT IS NOT A FAILURE TODAY.
 *
 * The vision layer describes an image that already exists (hard rule 13). For
 * it to describe anything, an image has to be reachable: the scrape has to have
 * stored a raw payload carrying a media URL, and the mirror has to have copied
 * the bytes into the private bucket before that URL expired.
 *
 * Every one of the 320 stored posts predates `posts.raw`, so there is no media
 * URL to mirror and nothing in the bucket to read. 0 described is therefore not
 * "nobody pressed the button" — it is the ONLY state reachable until a refresh
 * scrape runs, and no action on this checklist moves it. That is a NOTE: the
 * number is printed, the denominator is printed, and the upstream blocker is
 * named. Hiding it would be dishonest; failing on it would be a red line that
 * cannot be cleared, which is how a checklist becomes wallpaper.
 *
 * THE OTHER BRANCH IS A REAL FAILURE. When images ARE available and the batch
 * has not been run, the work is possible and was skipped — the demo would show
 * empty visual cards over a bucket full of thumbnails. That is a FAIL, and it
 * names the run.
 */
const [
  { count: describedCount, error: visualError },
  { count: rawCount, error: rawError },
] = await Promise.all([
  db.from('visual_features').select('id', { count: 'exact', head: true }),
  db.from('posts').select('id', { count: 'exact', head: true }).not('raw', 'is', null),
]);

/** Objects actually sitting under `post-media/<account>/`, per media.ts. */
const MIRROR_BUCKET = 'brand-assets';
const MIRROR_PREFIX = 'post-media';
let mirroredObjects = 0;
let mirrorListError = null;
for (const account of ACCOUNTS) {
  const { data, error } = await db.storage
    .from(MIRROR_BUCKET)
    .list(`${MIRROR_PREFIX}/${account}`, { limit: 1000 });
  if (error) mirrorListError = error.message;
  else mirroredObjects += data.length;
}

const described = describedCount ?? 0;
// The same denominator the Board counts in: POSTS, collapsed on ig_id, not
// scrape rows. visual_features is keyed on ig_id for exactly this reason.
const describable = distinctPostCount;

if (visualError) {
  bad(
    'Visual batch state',
    `visual_features could not be read — ${visualError.message}. Apply ` +
      'supabase/migrations/0004_v4_visual.sql (Supabase dashboard → SQL editor → paste the file → Run; ' +
      'it is additive and rewrites no earlier migration)',
  );
} else if (describable > 0 && described >= describable) {
  ok('Visual batch state', `${described}/${describable} post(s) described`);
} else if (mirrorListError !== null) {
  bad(
    'Visual batch state',
    `${described}/${describable} post(s) described, and the mirror bucket could not be listed — ` +
      `${mirrorListError}. Until that listing works this check cannot tell "no images exist" from ` +
      '"images exist and were not read", so the state is unknown rather than green or red',
  );
} else if (mirroredObjects > 0) {
  bad(
    'Visual batch state',
    `${described}/${describable} post(s) described, but ${mirroredObjects} mirrored image(s) are ` +
      `sitting in ${MIRROR_BUCKET}/${MIRROR_PREFIX}/ waiting to be read — the work is possible and ` +
      'was not done. POST /api/visual to run the batch (it estimates the cost first and refuses ' +
      'when the model has no verified rate)',
  );
} else {
  note(
    'Visual batch state',
    `${described}/${describable} post(s) described — and that is the honest floor, not a skipped step. ` +
      `${rawError ? `posts.raw could not be counted (${rawError.message}); ` : `${rawCount ?? 0} of ${describable} stored post(s) carry a raw payload; `}` +
      `${mirroredObjects} image(s) are mirrored under ${MIRROR_BUCKET}/${MIRROR_PREFIX}/. ` +
      'With no stored media URL there is nothing to mirror, and with nothing mirrored there is no ' +
      'image for the vision layer to describe — it transcribes what exists and never generates one ' +
      '(hard rule 13). This clears only after a refresh scrape stores raw payloads and MIRROR_MEDIA ' +
      'copies the bytes; no action on this checklist moves it. Do not demo a visual surface today.',
  );
}

/* ---------------------------------------------------------- the MCP door -- */

/**
 * PROVEN BY EXECUTION, NOT BY READING THE ENV.
 *
 * "MCP_ACCESS_TOKEN is set" is a config fact. What a demo needs is a BEHAVIOUR:
 * that the endpoint answers a real tools/list when the token is presented and
 * refuses one when it is not. So the real `handleMcpRequest` is imported and
 * called here, against this machine's real environment and the real database.
 *
 * The module is TypeScript and this script is .mjs, so the '@/' alias and the
 * extensionless relative imports inside src/ are resolved by the same
 * registerHooks arrangement tests/mcp.test.ts uses. `@/lib/auth` is the one
 * stub: it pulls in next/server, which cannot load outside a Next runtime, and
 * the only thing the MCP module takes from it is the HttpError shape. Nothing
 * about the gate itself is stubbed — the auth path, the registry and the cap
 * count are all the real ones.
 *
 * NO TOKEN IS EVER SYNTHESISED. If MCP_ACCESS_TOKEN is unset, the positive
 * branch is not run and is not claimed: injecting a token and then reporting
 * that the door opened would be a pass this deployment did not earn.
 */
const SRC_DIR = new URL('../src/', import.meta.url).href;
const AUTH_STUB_URL = 'stub:demo-check-lib-auth';

const tsFile = (base) => {
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/auth') return { url: AUTH_STUB_URL, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      const resolved = tsFile(new URL(specifier.slice(2), SRC_DIR).href);
      if (resolved) return { url: resolved, shortCircuit: true };
    }
    const parent = context.parentURL;
    if (specifier.startsWith('.') && parent?.startsWith('file:') && !/\.[a-z]+$/i.test(specifier)) {
      const resolved = tsFile(new URL(specifier, parent).href);
      if (resolved) return { url: resolved, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === AUTH_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export class HttpError extends Error {' +
          '  constructor(status, message, hint) {' +
          '    super(message); this.name = "HttpError"; this.status = status; this.hint = hint;' +
          '  }' +
          '}',
      };
    }
    return nextLoad(url, context);
  },
});

// Type-stripping a .ts file emits MODULE_TYPELESS_PACKAGE_JSON once per module,
// which would bury the checklist in warnings. Only that one is dropped; every
// other warning still prints, because silencing the channel wholesale is how a
// real deprecation goes unnoticed.
// Node reports this one with `name` left at the generic "Warning" and the
// identifier on `code` — which is why matching on `name` alone silently forwards
// it and prints the very noise this block exists to drop. Both are checked.
const TYPELESS = 'MODULE_TYPELESS_PACKAGE_JSON';
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.code === TYPELESS || warning.name === TYPELESS) return;
  for (const listener of defaultWarningListeners) listener(warning);
});

const MCP_FIX_SET_TOKEN =
  'set MCP_ACCESS_TOKEN in .env.local to a long random string (and bind the same value in ' +
  'production with: wrangler secret put MCP_ACCESS_TOKEN). An unset token is a CLOSED door by ' +
  'design — the endpoint refuses every call, including the one you were going to demo';

const mcpCall = (mcp, method, token) =>
  mcp.handleMcpRequest(
    new Request('https://demo-check.invalid/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
    }),
  );

let mcp = null;
try {
  mcp = await import('../src/lib/mcp/tools.ts');
} catch (err) {
  bad(
    'MCP gate',
    `src/lib/mcp/tools.ts could not be loaded, so the door was not tested at all — ${err.message}. ` +
      'This script relies on Node type-stripping; run it on the Node version in package.json',
  );
}

if (mcp) {
  const token = process.env.MCP_ACCESS_TOKEN?.trim() ?? '';
  const expectedTools = [...mcp.MCP_TOOL_NAMES].sort();

  try {
    // THE REFUSAL, proven first and proven always: it is the branch a
    // "convenient" future edit is most likely to invert.
    const anonymous = await mcpCall(mcp, 'tools/list', undefined);
    const wrongToken = await mcpCall(mcp, 'tools/list', 'demo-check-deliberately-wrong-token');

    if (anonymous.status !== 401 || wrongToken.status !== 401) {
      bad(
        'MCP gate',
        `tools/list answered ${anonymous.status} with NO token and ${wrongToken.status} with a wrong ` +
          'one; both must be 401. The MCP endpoint is not behind requireOperator() — the bearer ' +
          'token is its only door. Do not deploy until src/lib/mcp/tools.ts authorize() refuses both',
      );
    } else if (token === '') {
      bad(
        'MCP gate',
        `the door correctly refuses an unauthenticated call and a wrong token (401 on both), but ` +
          `MCP_ACCESS_TOKEN is unset, so it refuses the RIGHT token too and no MCP client can ` +
          `connect — ${MCP_FIX_SET_TOKEN}`,
      );
    } else {
      const authorised = await mcpCall(mcp, 'tools/list', token);
      const payload = await authorised.json().catch(() => null);
      const listed = (payload?.result?.tools ?? []).map((tool) => tool.name).sort();
      const matches =
        listed.length === expectedTools.length &&
        listed.every((name, index) => name === expectedTools[index]);

      if (authorised.status !== 200) {
        bad(
          'MCP gate',
          `tools/list answered ${authorised.status} with the configured MCP_ACCESS_TOKEN — the token ` +
            'in .env.local is not the one the server compares against, or the request was malformed. ' +
            'Re-issue it and set the same value on both sides',
        );
      } else if (!matches) {
        bad(
          'MCP gate',
          `tools/list answered 200 but listed [${listed.join(', ')}] where the registry declares ` +
            `[${expectedTools.join(', ')}]. The allow-list in src/lib/mcp/tools.ts and what the door ` +
            'actually serves must be the same set — reconcile them before exposing the endpoint',
        );
      } else {
        ok(
          'MCP gate',
          `refuses with no token and with a wrong one (401 on both), answers tools/list with the ` +
            `configured token (200, ${listed.length} tools: ${listed.join(', ')})`,
        );
      }
    }
  } catch (err) {
    bad(
      'MCP gate',
      `the door threw instead of answering — ${err.message}. An endpoint that throws on tools/list ` +
        'cannot be demoed; fix it in src/lib/mcp/tools.ts before exposing it',
    );
  }

  /**
   * Hard rule 14: an external caller cannot spend freely. The cap is counted
   * against the REAL tables, in the REAL Amman window, so what is reported here
   * is what an MCP client would actually meet — including the operator's own
   * work in the browser, which shares the window.
   */
  try {
    const cap = await mcp.readCapState();
    if (!Number.isFinite(cap.limit) || cap.limit <= 0) {
      bad(
        'MCP cap armed',
        `the daily generation cap resolved to ${cap.limit}, which bounds nothing — set ` +
          `${cap.env_key} to a positive integer, or unset it to take the default of ` +
          `${mcp.DEFAULT_DAILY_GENERATION_CAP}`,
      );
    } else if (cap.remaining <= 0) {
      bad(
        'MCP cap armed',
        `the cap is armed at ${cap.limit} ${cap.unit} and ${cap.used} are already used, so the next ` +
          `model-backed call — from an MCP client OR from the browser — is refused until ` +
          `${cap.resets_at} (${cap.resets_on}, ${cap.time_zone}). Either demo before generating ` +
          `anything else, or raise ${cap.env_key}`,
      );
    } else {
      ok(
        'MCP cap armed',
        `${cap.used}/${cap.limit} used, ${cap.remaining} left in the ${cap.time_zone} day, resets ` +
          `${cap.resets_at} — counted from ${Object.entries(cap.counted)
            .map(([table, n]) => `${table} ${n}`)
            .join(' + ')}`,
      );
    }
  } catch (err) {
    // readCapState() fails CLOSED: an uncounted window would otherwise read as
    // zero used, which is an open spending door. Report it the same way.
    bad(
      'MCP cap armed',
      `the cap could not be counted, so every model-backed MCP call fails closed — ${err.message}. ` +
        'Confirm the concepts and compliance_checks tables are readable with the service-role key',
    );
  }
}

/* ====================================================== the chat surface ====
 *
 * Four checks, and the ordering is the demo's own: can you REACH the screen,
 * does it ANSWER with sourced figures, is the gate that makes those answers
 * safe actually PROVEN, and can a dispatch spend anything.
 *
 * THE RULE THESE ALL OBEY: where a leg cannot be executed on this machine, it
 * is reported as not executed. It is never inferred from a leg that did run.
 * The model-dependent half of the second check is the whole reason that rule is
 * written down — with no provider key, "the model picks get_stats" cannot be
 * observed here, and a green tick claiming otherwise would be exactly the kind
 * of unsourced assertion the surface itself refuses to make.
 * ========================================================================= */

/* -- 1. the way in, in both languages ------------------------------------- */

/**
 * The nav entry is rendered by `tt(arabic, english)`, so ONE of the two strings
 * going missing is invisible in whichever locale still has one. Both halves are
 * read out of the source and checked for the script they are supposed to be in
 * — a check that only asserted "two arguments" would pass on tt('Chat','Chat').
 */
// Resolved from THIS file rather than from cwd: `npm run demo:check` happens to
// run at the project root, but a check that silently reports "the menu is
// missing" because someone invoked it from another directory would be worse
// than no check at all.
const REPO_ROOT = new URL('../', import.meta.url);
const repoPath = (rel) => fileURLToPath(new URL(rel, REPO_ROOT));

// Absolute for reading, repo-relative for the message: a fix line is something
// a person retypes, so it names the file the way the repository does.
const SHELL_REL = 'src/components/Shell.tsx';
const CHAT_PAGE_REL = 'src/app/(app)/chat/page.tsx';
const SHELL_PATH = repoPath(SHELL_REL);
const CHAT_PAGE_PATH = repoPath(CHAT_PAGE_REL);

try {
  const shell = readFileSync(SHELL_PATH, 'utf8');
  const entry = /key:\s*'\/chat'[^}]*?label:\s*tt\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/.exec(shell);

  if (!existsSync(CHAT_PAGE_PATH)) {
    bad(
      'Chat nav entry, both languages',
      `${SHELL_REL} is not the problem — ${CHAT_PAGE_REL} does not exist, so the menu item would ` +
        'route to a 404. Restore the page before linking to it',
    );
  } else if (entry === null) {
    bad(
      'Chat nav entry, both languages',
      `no \`key: '/chat'\` item with a \`label: tt('<arabic>', '<english>')\` was found in ${SHELL_REL}. ` +
        'The screen exists but nothing navigates to it, so a demo can only reach /chat by typing the ' +
        'URL. Add the item to the `items` array next to the dashboard entry',
    );
  } else {
    const [, arabic, english] = entry;
    // U+0600–U+06FF is the Arabic block; A-Za-z is the Latin one. A label in the
    // wrong script is a placeholder somebody meant to come back to.
    const arabicOk = /[؀-ۿ]/.test(arabic);
    const englishOk = /[A-Za-z]/.test(english) && !/[؀-ۿ]/.test(english);
    if (!arabicOk || !englishOk) {
      bad(
        'Chat nav entry, both languages',
        `the /chat item reads tt('${arabic}', '${english}') in ${SHELL_REL}, and ` +
          `${!arabicOk ? 'the Arabic label carries no Arabic script' : 'the English label is not Latin script'}` +
          ' — one locale would show a placeholder. Give it a real label in both',
      );
    } else {
      ok('Chat nav entry, both languages', `/chat → AR "${arabic}" · EN "${english}"`);
    }
  }
} catch (err) {
  bad(
    'Chat nav entry, both languages',
    `${SHELL_REL} could not be read, so the menu was not checked at all — ${err.message}`,
  );
}

/* -- 2. the question, answered from named lookups ------------------------- */

/**
 * «قدّيش معدل تفاعل كل حساب؟» — "what is each account's average engagement?"
 *
 * THREE LEGS, AND THE THIRD IS THE ONE THAT NEEDS A KEY:
 *   a. the named lookup `account_averages` runs against the REAL database and
 *      returns values that each carry a source_key (rule 12);
 *   b. the chat TOOL EXECUTOR resolves `get_stats` to that lookup and hands the
 *      source_keys back — this is the wiring the route depends on, and it needs
 *      no model at all;
 *   c. the model, shown this question, chooses `get_stats`. That one calls a
 *      provider and cannot be observed without a key.
 *
 * a and b are executed here every time. c is executed only when a key exists,
 * and when it does not, this check FAILS and says which leg was not run. It is
 * a FAIL rather than a NOTE because an operator can make it green by setting the
 * key that the first check on this list is already red about.
 */
const CHAT_QUESTION = 'قدّيش معدل تفاعل كل حساب؟';
const CHAT_LOOKUP = 'account_averages';

let statsModule = null;
let chatToolsModule = null;
try {
  statsModule = await import('../src/lib/agent/chat/stats.ts');
  chatToolsModule = await import('../src/lib/agent/chat/tools.ts');
} catch (err) {
  bad(
    'Chat answers the engagement question',
    `the chat modules could not be loaded, so nothing was proven — ${err.message}. This script relies ` +
      'on Node type-stripping; run it on the Node version in package.json',
  );
}

if (statsModule && chatToolsModule) {
  try {
    /* -- leg a: the lookup itself ---------------------------------------- */
    const outcome = await statsModule.runStatLookup(db, CHAT_LOOKUP, { account: 'all' });

    if (outcome.ok !== true) {
      bad(
        'Chat answers the engagement question',
        `the named lookup "${CHAT_LOOKUP}" refused (${outcome.refusal}) instead of running, so the ` +
          `question cannot be answered from sources at all. ${outcome.reason ?? ''}`.trim(),
      );
    } else {
      const result = outcome.result;
      const unsourced = result.values.filter((v) => !v.source_key || v.source_key.trim() === '');

      /* -- leg b: the executor the route actually calls -------------------- */
      const published = chatToolsModule.chatToolSpecs().map((spec) => spec.name);
      const execute = chatToolsModule.createChatToolExecutor({
        db,
        quality: 'standard',
        now: new Date(),
      });
      const toolResult = await execute({
        id: 'demo-check',
        name: 'get_stats',
        arguments: JSON.stringify({ lookup: CHAT_LOOKUP, params: { account: 'all' } }),
      });
      const toolKeys = toolResult.source_keys ?? [];

      if (!published.includes('get_stats')) {
        bad(
          'Chat answers the engagement question',
          `the lookup works, but \`get_stats\` is not among the tools the surface publishes ` +
            `(${published.join(', ')}), so the model is never offered it and the question falls back to ` +
            'prose. Publish the full CHAT_TOOL_NAMES allow-list from src/lib/agent/chat/tools.ts',
        );
      } else if (result.status === 'absent' || result.values.length === 0) {
        bad(
          'Chat answers the engagement question',
          `the lookup ran but measured nothing (status "${result.status}"), so the honest answer today ` +
            'is an em-dash. Ingest a snapshot before demoing this question',
        );
      } else if (unsourced.length > 0) {
        bad(
          'Chat answers the engagement question',
          `${unsourced.length} of ${result.values.length} value(s) carry no source_key ` +
            `(${unsourced.map((v) => v.label).join(', ')}). Rule 12 — every rendered quantity names what ` +
            'produced it — so a reply quoting these could not be linted. Fix the lookup in ' +
            'src/lib/agent/chat/stats.ts',
        );
      } else if (toolKeys.length === 0) {
        bad(
          'Chat answers the engagement question',
          'the lookup returns sourced values, but the get_stats TOOL handed back none of their ' +
            'source_keys, so the linter would treat every figure in the reply as unsourced and strip ' +
            'it. Fix the executor in src/lib/agent/chat/tools.ts',
        );
      } else {
        const summary =
          `${result.values.length} sourced value(s) over snapshot ${result.measured_over?.taken_on ?? '—'}, ` +
          `tool returned ${toolKeys.length} source_key(s) incl. ${toolKeys[0]}`;

        // Leg c. Not executed without a key, and not claimed.
        if (!provider) {
          bad(
            'Chat answers the engagement question',
            `EXECUTED: the named lookup "${CHAT_LOOKUP}" and the get_stats tool, both against the real ` +
              `database — ${summary}. NOT EXECUTED: the model leg, i.e. that «${CHAT_QUESTION}» actually ` +
              'makes the model choose get_stats, which needs a provider key. This check cannot go green ' +
              'until the "Model provider key" check above does — set the key, then re-run and ask the ' +
              'question once on /chat before the demo',
          );
        } else {
          ok('Chat answers the engagement question', `${summary} — model leg not re-run here; ask «${CHAT_QUESTION}» once on /chat to confirm`);
        }
      }
    }
  } catch (err) {
    bad(
      'Chat answers the engagement question',
      `the lookup threw instead of answering — ${err.message}. A question the operator will ask on ` +
        'stage cannot end in an exception; fix it in src/lib/agent/chat/stats.ts',
    );
  }
}

/* -- 3. the gate that makes those answers safe ---------------------------- */

/**
 * Hard rule 16 in one line: an unsourced number never reaches the screen. The
 * suite proves it with a TRAP — a fixture whose invented number appears in no
 * block — and that trap is only meaningful if the number really is absent, which
 * is itself a test.
 *
 * RUN, NOT READ. The file is executed and its TAP output parsed, because "the
 * test exists" and "the test passes" are different facts and only the second one
 * is worth a green tick. The named trap probe must be PRESENT and passing: a
 * suite that quietly lost it would otherwise report a clean run.
 */
const TRAP_TEST_FILE = 'tests/chat-lint.test.ts';
const TRAP_TEST_NAME = 'the fixture is a real trap: the invented number appears nowhere in the blocks';

try {
  const run = spawnSync(
    process.execPath,
    ['--test', '--experimental-strip-types', repoPath(TRAP_TEST_FILE)],
    { encoding: 'utf8', timeout: 120_000, cwd: fileURLToPath(REPO_ROOT) },
  );
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;

  // The TAP line for THIS test, matched exactly. `ok 12 - <name>` and
  // `not ok 12 - <name>` are the two shapes; anything else means the test did
  // not report at all, which is its own failure and not a pass.
  const escaped = TRAP_TEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trapPassed = new RegExp(`^ok \\d+ - ${escaped}$`, 'm').test(out);
  const trapFailed = new RegExp(`^not ok \\d+ - ${escaped}$`, 'm').test(out);
  const trapNamed = trapPassed || trapFailed;
  const failed = Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? 'NaN');
  const passed = Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? 'NaN');

  if (!trapNamed) {
    bad(
      'Chat number-trap probe',
      `${TRAP_TEST_FILE} ran but never reported a test called "${TRAP_TEST_NAME}". The trap is what ` +
        'proves the linter is being asked a real question rather than a vacuous one — restore it before ' +
        'trusting any other result in that file',
    );
  } else if (!Number.isFinite(failed) || !Number.isFinite(passed)) {
    bad(
      'Chat number-trap probe',
      `${TRAP_TEST_FILE} produced no readable TAP summary, so nothing was proven — exit ${run.status}. ` +
        `Run: node --test --experimental-strip-types ${TRAP_TEST_FILE}`,
    );
  } else if (failed > 0 || run.status !== 0) {
    bad(
      'Chat number-trap probe',
      `${failed} test(s) in ${TRAP_TEST_FILE} FAILED (exit ${run.status}). The claims-linter is the only ` +
        'thing standing between the model and an invented number on screen. Do not demo the chat ' +
        `surface until this is green: node --test --experimental-strip-types ${TRAP_TEST_FILE}`,
    );
  } else if (!trapPassed) {
    bad(
      'Chat number-trap probe',
      `the trap probe "${TRAP_TEST_NAME}" did not report as passing in ${TRAP_TEST_FILE}. Every other ` +
        'assertion in that file rests on it',
    );
  } else {
    ok(
      'Chat number-trap probe',
      `${passed} linter test(s) pass, including the trap probe — an invented number is repaired once, ` +
        'then stripped and chipped',
    );
  }
} catch (err) {
  bad(
    'Chat number-trap probe',
    `${TRAP_TEST_FILE} could not be executed, so the gate is unproven — ${err.message}`,
  );
}

/* -- 4. the chat cap, and the door it reserves through --------------------- */

/**
 * Hard rule 18: the chat surface opens no new spend path. Two things have to be
 * true and they fail in completely different ways.
 *
 *   THE CEILING — CHAT_DAILY_GENERATION_CAP, over the same Amman-day ledger the
 *   MCP cap spends against. Read from the real environment and the real tables.
 *
 *   THE DOOR — every dispatch reserves under `CHAT_RESERVING_TOOL` against the
 *   atom 0005 created, and `mcp_reservations.tool` carries a CHECK constraint.
 *   0005 said in terms that a future spending tool needs its own migration, and
 *   until that migration is APPLIED the insert raises, the function rolls back
 *   and every dispatch is refused. A cap with a sealed door is not "armed" — it
 *   is a surface that cannot produce a deliverable at all, which is hard rule 17
 *   dead on arrival.
 *
 * The door is probed with an insert that CANNOT WRITE: `amman_day` is a date no
 * mcp_cap_days row exists for, so the foreign key rejects the tuple no matter
 * what. Which error comes back is the answer — 23514 means the CHECK refused the
 * NAME, 23503 means the name was accepted and only the FK stopped it. A control
 * probe with a name 0005 already allows must return 23503, otherwise the probe
 * is not reaching the constraint and its verdict on the chat name means nothing.
 */
const IMPOSSIBLE_DAY = '1900-01-01';
const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';

let chatDispatchModule = null;
try {
  chatDispatchModule = await import('../src/lib/agent/chat/dispatch.ts');
} catch (err) {
  bad(
    'CHAT_DAILY_GENERATION_CAP armed',
    `src/lib/agent/chat/dispatch.ts could not be loaded, so the cap was not read — ${err.message}`,
  );
}

if (chatDispatchModule) {
  const reservingTool = chatDispatchModule.CHAT_RESERVING_TOOL;

  /* -- the ceiling ------------------------------------------------------- */
  let capState = null;
  try {
    capState = await chatDispatchModule.readChatCapState();
  } catch (err) {
    bad(
      'CHAT_DAILY_GENERATION_CAP armed',
      `the chat cap could not be counted, so every dispatch fails closed — ${err.message}. Confirm the ` +
        'concepts and compliance_checks tables are readable with the service-role key',
    );
  }

  if (capState) {
    const raw = process.env.CHAT_DAILY_GENERATION_CAP?.trim() ?? '';
    const source =
      raw === ''
        ? `default ${chatDispatchModule.DEFAULT_CHAT_DAILY_GENERATION_CAP} (${capState.env_key} unset)`
        : `${capState.env_key}=${raw}`;

    if (!Number.isFinite(capState.limit) || capState.limit <= 0) {
      bad(
        'CHAT_DAILY_GENERATION_CAP armed',
        `the chat cap resolved to ${capState.limit}, which bounds nothing — set ${capState.env_key} to a ` +
          `positive integer, or unset it to take the default of ` +
          `${chatDispatchModule.DEFAULT_CHAT_DAILY_GENERATION_CAP}`,
      );
    } else if (raw !== '' && String(capState.limit) !== raw) {
      // positiveIntEnv falls back silently, so "20.5" or "20 " becomes the
      // default while the operator believes their number is in force.
      bad(
        'CHAT_DAILY_GENERATION_CAP armed',
        `${capState.env_key} is "${raw}" but the cap in force is ${capState.limit} — the value did not ` +
          'parse as a positive integer and the built-in default took over silently. Write a bare ' +
          'positive integer in .env.local',
      );
    } else if (capState.remaining <= 0) {
      bad(
        'CHAT_DAILY_GENERATION_CAP armed',
        `the cap is armed at ${capState.limit} ${capState.unit} (${source}) and ${capState.used} are ` +
          `already used, so the next dispatch is refused until ${capState.resets_at} ` +
          `(${capState.resets_on}, ${capState.time_zone}). Either demo before generating anything else, ` +
          `or raise ${capState.env_key}`,
      );
    } else {
      ok(
        'CHAT_DAILY_GENERATION_CAP armed',
        `${capState.used}/${capState.limit} used, ${capState.remaining} left in the ${capState.time_zone} ` +
          `day (${source}), resets ${capState.resets_at}`,
      );
    }
  }

  /* -- the door ---------------------------------------------------------- */
  try {
    const probe = async (tool) => {
      const { error } = await db
        .from('mcp_reservations')
        .insert({ amman_day: IMPOSSIBLE_DAY, tool, units: 1 });
      return error;
    };

    // The control FIRST: a name 0005 already permits must reach the FK.
    const controlError = await probe('generate_concepts');
    const chatError = await probe(reservingTool);

    if (controlError?.code !== FK_VIOLATION) {
      bad(
        'Chat dispatch reservation permitted',
        `the probe is not measuring what it claims: inserting an ALREADY-PERMITTED tool name returned ` +
          `${controlError?.code ?? 'no error'} where the foreign key should have given ${FK_VIOLATION}. ` +
          'Nothing was written either way, but the verdict on the chat tool name cannot be trusted — ' +
          'check mcp_reservations against supabase/migrations/0005_mcp_reservations.sql by hand',
      );
    } else if (chatError?.code === CHECK_VIOLATION) {
      bad(
        'Chat dispatch reservation permitted',
        `mcp_reservations.tool still REFUSES '${reservingTool}', so every chat dispatch fails closed and ` +
          'the surface cannot produce a concept, campaign, report, guideline, rewrite or digest at all ' +
          '(hard rule 17). Nothing is wrong with the code — the migration is not applied. Apply ' +
          'supabase/migrations/0007_chat_dispatch_reservation.sql, which widens the CHECK to include ' +
          `'${reservingTool}'`,
      );
    } else if (chatError?.code !== FK_VIOLATION) {
      bad(
        'Chat dispatch reservation permitted',
        `probing '${reservingTool}' returned ${chatError?.code ?? 'no error'} — expected ${FK_VIOLATION} ` +
          `(name allowed, foreign key stopped the write) or ${CHECK_VIOLATION} (name refused). ` +
          `${chatError?.message ?? 'The insert may have SUCCEEDED, which would leave a bogus reservation row.'}`,
      );
    } else {
      ok(
        'Chat dispatch reservation permitted',
        `mcp_reservations.tool accepts '${reservingTool}' (probe stopped by the foreign key, ` +
          `${FK_VIOLATION}; no row written)`,
      );
    }
  } catch (err) {
    bad(
      'Chat dispatch reservation permitted',
      `the reservation constraint could not be probed, so it is unknown whether a dispatch can reserve ` +
        `— ${err.message}`,
    );
  }
}

console.log(
  failures === 0
    ? `\nAll green${notes > 0 ? ` (${notes} note(s) above — read them; they are measured states nothing on this list can change)` : ''}. Rehearse it ten times, record one clean run, then demo.\n`
    : `\n${failures} check(s) failed${notes > 0 ? `, ${notes} note(s)` : ''}. Do not demo until they are green.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
