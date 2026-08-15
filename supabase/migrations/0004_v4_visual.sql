-- ThinkQuality Studio — v4 visual schema.
-- Additive only: 0001_init.sql, 0002_v3_ingestion.sql and 0003_strategist.sql
-- are applied and are never rewritten (hard rule 6).
--
-- Three things land here:
--   1. visual_features — what the vision layer TRANSCRIBED from an image.
--   2. post_analyses.ig_id — the durable fix for the snapshot boundary, done now
--      rather than "later", while the table is still empty and the backfill is free.
--   3. decisions.cap / decisions.kill_condition — two fields that were being
--      packed into and parsed back out of expected_signal.

-- ---------------------------------------------------------------------------
-- One row per post, describing what is actually IN the image. Hard rule 13:
-- describing is not generating — every column here is a transcription or a
-- classification of an image that already exists. Nothing in this table, and
-- nothing that reads it, produces or edits an image.
--
-- Keyed on `ig_id`, not on posts.id, and deliberately so. `posts` is UNIQUE
-- (snapshot_id, ig_id) — one ROW PER POST PER SNAPSHOT — so a post that appears
-- in seven scrapes has seven posts.id values and would otherwise be described
-- seven times, at seven times the model spend, for one unchanged image. The
-- image belongs to the post, not to the scrape that observed it, so the key is
-- the post's own Instagram id and the uniqueness is enforced by the database
-- rather than by whichever caller remembered to check first.
--
-- `storage_path` is where the mirrored image lives, and is nullable because
-- mirroring can legitimately have nothing to fetch: posts.raw is null for every
-- row stored before that column existed, so those media URLs are gone. Null
-- there means "not mirrored", never "no image".
--
-- `dominant_colors` is DominantColor[] — [{hex, share}] — where `share` is
-- computed in code from the pixels, never asked of a model (hard rule 11 in
-- spirit: a model does not get to assert a quantity). `palette_match` is
-- PaletteMatch — {matched, unmatched, verdict} — comparing those colors against
-- brand.palette swatch NAMES.
--
-- `grounding` carries the same 'data' | 'hypothesis' contract every generated
-- claim in this app carries (hard rule 3). The check constraint follows 0003's
-- convention rather than 0002's looser default-only column: the TypeScript type
-- is the two-member union `Grounding`, and a check makes that structural
-- instead of advisory.
-- ---------------------------------------------------------------------------
create table visual_features (
  id uuid primary key default gen_random_uuid(),
  ig_id text not null unique,                            -- the post, not the scrape row
  account text not null check (account in ('personal','academy')),
  storage_path text,                                     -- null = not mirrored
  has_face boolean, face_prominence text,
  text_in_image_ar text,                                 -- transcribed, not authored
  text_coverage text, logo_present boolean,
  dominant_colors jsonb,                                 -- DominantColor[]  [{hex, share}]
  palette_match jsonb,                                   -- PaletteMatch {matched, unmatched, verdict}
  composition_tags text[],
  model text,                                            -- null until a model has read it
  grounding text not null default 'data'
    check (grounding in ('data','hypothesis')),
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- post_analyses.ig_id — the 7th-snapshot boundary, fixed at the source.
--
-- post_analyses.post_id references posts.id, i.e. a scrape ROW. The board reads
-- posts collapsed to one row per post (distinctPosts()), so on the next scrape
-- every analysis already paid for points at a row the board no longer shows,
-- and the work goes invisible. Today that join is rebuilt in memory on every
-- request (src/app/api/board/route.ts, src/app/api/board/analyze/route.ts).
-- Carrying ig_id on the row itself retires that reconstruction.
--
-- post_id stays. It is still the truthful record of WHICH observation was read.
-- ---------------------------------------------------------------------------
alter table post_analyses add column ig_id text;

-- Backfill. posts is UNIQUE (snapshot_id, ig_id) and post_id references
-- posts.id — the primary key — so this join matches at most one posts row per
-- analysis and cannot fan out. Rows whose post_id is null, or whose post row
-- was deleted, keep ig_id null: null means "could not be resolved", and is left
-- visible rather than filled with a guess (hard rule 2).
--
-- post_analyses is EMPTY as of 2026-08-15, so this statement affects 0 rows on
-- first application. It is written for the case where there ARE rows.
update post_analyses pa
set ig_id = p.ig_id
from posts p
where pa.post_id = p.id
  and pa.ig_id is distinct from p.ig_id;

-- ---------------------------------------------------------------------------
-- decisions: cap and kill_condition as their own columns.
--
-- Both were being packed into expected_signal as prose and parsed back out by
-- two mirrored string parsers that shared no constant and were bound by no
-- test. Two additive columns retire that: a decision's ceiling and the
-- condition that kills it are structured fields, not substrings.
--
-- Nullable, because a decision may legitimately have neither — a null cap means
-- "no cap was stated", never "unlimited".
-- ---------------------------------------------------------------------------
alter table decisions add column cap text;
alter table decisions add column kill_condition text;

-- ---------------------------------------------------------------------------
-- Indexes for the access patterns v4 actually uses. `ig_id unique` on
-- visual_features already provides its own lookup index; the account index
-- serves "every visual feature for one account", mirroring posts_account_idx.
-- ---------------------------------------------------------------------------
create index post_analyses_ig_id_idx on post_analyses (ig_id);
create index visual_features_account_idx on visual_features (account);

-- ---------------------------------------------------------------------------
-- RLS: deny-all, exactly as in 0001, 0002 and 0003. No policies are defined, so
-- the anon key that reaches the browser can read nothing. Every read and write
-- goes through an auth-gated route handler using the service-role key, which
-- bypasses RLS.
-- ---------------------------------------------------------------------------
alter table visual_features enable row level security;
