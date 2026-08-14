-- ThinkQuality Studio — initial schema
-- Run against a fresh Supabase project (SQL Editor, or `supabase db push`).

create extension if not exists "pgcrypto";

create table brand (
  id int primary key default 1 check (id = 1),          -- singleton
  facts jsonb not null default '{}',                     -- seeded facts, sourced
  voice_examples jsonb not null default '[]',            -- [{text, source_url, engagement}]
  palette jsonb,                                         -- null until assets land
  typography jsonb,
  audience_notes text,
  status text not null default 'seed',                   -- seed | live
  updated_at timestamptz default now()
);

create table snapshots (
  id uuid primary key default gen_random_uuid(),
  taken_on date not null,
  stats jsonb not null,          -- {followers, avg_engagement, top_format, diff_vs_prev}
  raw_meta jsonb,
  created_at timestamptz default now()
);

create table posts (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid references snapshots(id) on delete cascade,
  account text not null check (account in ('personal','academy')),
  ig_id text not null,
  url text, caption text, media_type text,
  likes int, comments int, engagement int not null,
  posted_at timestamptz, rank int,
  unique (snapshot_id, ig_id)
);

create table pillars (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null, name_en text,
  post_count int not null, avg_engagement numeric not null,
  hook_pattern text, example_post_ids uuid[],
  generated_from uuid references snapshots(id)
);

create table concepts (
  id uuid primary key default gen_random_uuid(),
  title text not null, pillar_id uuid references pillars(id),
  format text not null check (format in ('reel','carousel','static','story')),
  hook_ar text not null, caption_ar text not null,
  visual_direction text not null,
  why text not null, grounding text not null check (grounding in ('data','hypothesis')),
  status text not null default 'draft' check (status in ('draft','approved','shipped','rejected')),
  target_week date, account text default 'academy',
  shipped_url text, shipped_engagement int,              -- backfilled by refresh
  created_at timestamptz default now()
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null, objective text not null,
  plan jsonb not null,           -- full contract object
  status text default 'draft', created_at timestamptz default now()
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  month date not null, body_md text not null,
  status text default 'draft', created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Indexes for the access patterns the app actually uses.
-- ---------------------------------------------------------------------------
create index snapshots_taken_on_idx on snapshots (taken_on desc);
create index posts_snapshot_rank_idx on posts (snapshot_id, rank);
create index posts_account_idx on posts (account);
create index posts_url_idx on posts (url);
create index concepts_status_idx on concepts (status);
create index concepts_target_week_idx on concepts (target_week);
create index pillars_generated_from_idx on pillars (generated_from);
create index reports_month_idx on reports (month desc);

-- ---------------------------------------------------------------------------
-- RLS: deny-all by default. Every read and write in this app goes through an
-- auth-gated Next.js route handler using the service-role key, which bypasses
-- RLS. The anon key (which reaches the browser) can therefore see nothing.
-- ---------------------------------------------------------------------------
alter table brand      enable row level security;
alter table snapshots  enable row level security;
alter table posts      enable row level security;
alter table pillars    enable row level security;
alter table concepts   enable row level security;
alter table campaigns  enable row level security;
alter table reports    enable row level security;
