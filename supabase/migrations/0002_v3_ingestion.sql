-- ThinkQuality Studio — v3 ingestion schema.
-- Additive only: 0001_init.sql is applied and is never rewritten.
-- Adds the scrape ledger, profile history, the comment corpus, audience
-- insights, and the post fields apify/instagram-scraper already returns but
-- v1 dropped on the floor.

-- ---------------------------------------------------------------------------
-- Every scrape run is ledgered: what was asked for, what it was estimated to
-- cost before it ran, what came back, and where the untouched raw payload
-- lives. Hard rule 8 (raw is sacred) and hard rule 9 (estimate before spend)
-- both depend on this table existing before any actor is called.
-- `estimated_usd` is null when the actor's published rate could not be
-- verified — a null there means "not estimated", never "free".
-- ---------------------------------------------------------------------------
create table scrape_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('posts','profile','comments','monitor')),
  actor text not null,
  input jsonb not null,                                  -- the actor input, verbatim
  estimated_usd numeric,                                 -- null = could not be estimated
  actual_results int,
  status text not null default 'done',
  raw_path text,                                         -- storage path of the raw payload
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Profile-level history, one row per account per day. Follower counts are the
-- one number the post scraper does not reliably return, so they get their own
-- dated series rather than being back-filled into snapshots.stats.
-- ---------------------------------------------------------------------------
create table profile_snapshots (
  id uuid primary key default gen_random_uuid(),
  account text not null check (account in ('personal','academy')),
  taken_on date not null,
  followers int, following int, posts_count int,
  bio text, external_url text, is_verified boolean,
  raw jsonb not null,                                    -- complete profile payload
  unique (account, taken_on)
);

-- ---------------------------------------------------------------------------
-- The comment corpus. Read at aggregate level only — themes, questions,
-- register, timing. Hard rule 10: commenters are an audience, not targets, so
-- nothing downstream builds a per-commenter profile from author_handle.
-- ---------------------------------------------------------------------------
create table comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references posts(id) on delete cascade,
  ig_comment_id text not null,
  author_handle text,
  text_content text not null,
  likes int,
  posted_at timestamptz,
  raw jsonb not null,
  unique (post_id, ig_comment_id)
);

-- ---------------------------------------------------------------------------
-- Aggregate audience findings derived from one scrape run. `timing` is
-- computed in code from posted_at x engagement (hard rule 11) and always
-- carries its n; `grounding` says whether the row is data or hypothesis.
-- ---------------------------------------------------------------------------
create table audience_insights (
  id uuid primary key default gen_random_uuid(),
  generated_from uuid references scrape_runs(id),
  themes jsonb not null,                                 -- AudienceTheme[]
  questions jsonb not null,                              -- AudienceQuestion[]
  register_notes text,
  timing jsonb,                                          -- TimingReport | null
  grounding text not null default 'data',
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- posts: additive columns for fields the actor already returns. All nullable —
-- the 320 rows already stored predate them and stay valid. Nothing here is
-- invented: every column maps to a field apify/instagram-scraper emits.
-- ---------------------------------------------------------------------------
alter table posts add column video_play_count int;
alter table posts add column video_view_count int;
alter table posts add column video_duration numeric;
alter table posts add column product_type text;
alter table posts add column location_name text;
alter table posts add column location_id text;
alter table posts add column hashtags text[];
alter table posts add column mentions text[];
alter table posts add column first_comment text;
alter table posts add column owner_username text;
alter table posts add column owner_id text;
alter table posts add column is_sponsored boolean;
alter table posts add column dimensions jsonb;
alter table posts add column raw jsonb;                  -- the item, untouched

-- ---------------------------------------------------------------------------
-- Indexes for the access patterns v3 actually uses.
-- ---------------------------------------------------------------------------
create index comments_post_id_idx on comments (post_id);
create index profile_snapshots_account_taken_on_idx on profile_snapshots (account, taken_on desc);
create index scrape_runs_created_at_idx on scrape_runs (created_at desc);
create index audience_insights_generated_from_idx on audience_insights (generated_from);
create index posts_posted_at_idx on posts (posted_at);

-- ---------------------------------------------------------------------------
-- RLS: deny-all, exactly as in 0001. No policies are defined, so the anon key
-- that reaches the browser can read nothing. Every read and write goes through
-- an auth-gated route handler using the service-role key, which bypasses RLS.
-- ---------------------------------------------------------------------------
alter table scrape_runs        enable row level security;
alter table profile_snapshots  enable row level security;
alter table comments           enable row level security;
alter table audience_insights  enable row level security;
