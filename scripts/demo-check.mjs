/**
 * Demo preflight.  npm run demo:check
 *
 * Red means do not demo. Every failure names the fix, because a checklist that
 * only says "no" gets ignored five minutes before a pitch.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, fix) => {
  failures += 1;
  console.log(`  FAIL  ${label}\n        fix: ${fix}`);
};

console.log('\nDemo preflight\n');

/* ------------------------------------------------------------- config --- */
const openrouter = process.env.OPENROUTER_API_KEY?.trim();
const anthropic = process.env.ANTHROPIC_API_KEY?.trim();
const provider = (process.env.AI_PROVIDER ?? (openrouter ? 'openrouter' : anthropic ? 'anthropic' : '')).toLowerCase();

if (!provider) {
  bad('Model provider key', 'set OPENROUTER_API_KEY in .env.local (openrouter.ai/keys) and add credit');
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

console.log(
  failures === 0
    ? '\nAll green. Rehearse it ten times, record one clean run, then demo.\n'
    : `\n${failures} check(s) failed. Do not demo until they are green.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
