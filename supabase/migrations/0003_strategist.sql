-- ThinkQuality Studio — strategist schema.
-- Additive only: 0001_init.sql and 0002_v3_ingestion.sql are applied and are
-- never rewritten.
-- Adds the decision ledger and the digest record: the two things that turn a
-- run of the strategist from a paragraph into an accountable act.

-- ---------------------------------------------------------------------------
-- Every recommendation the strategist makes is written down BEFORE its result
-- is known, with the evidence it rests on and the date it is to be judged on.
-- `basis` is a BasisRef[] — [{source_key, value}] — where source_key names a
-- key emitted by src/lib/agent/strategist/blocks.ts and `value` is the block's
-- text, VERBATIM. It is stored as text on purpose: a number that travelled as
-- a string cannot have been quietly recomputed on the way here.
-- `grounding` is the same 'data' | 'hypothesis' contract every generated claim
-- in this app carries (hard rule 3), and it is a check constraint rather than
-- a convention because an unlabelled claim is the failure mode.
-- `status` starts 'open' and is only ever moved by a review that read the
-- outcome: 'validated', 'refuted', or 'superseded' by a later decision. There
-- is no 'closed' — a decision no one judged stays open and stays visible.
-- ---------------------------------------------------------------------------
create table decisions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('recommendation','experiment','alert','escalation')),
  statement_ar text not null,
  basis jsonb not null,                                  -- [{source_key, value}]
  grounding text not null check (grounding in ('data','hypothesis')),
  expected_signal text not null,                         -- what would prove it
  review_after date not null,                            -- when to judge it
  status text not null default 'open'
    check (status in ('open','validated','refuted','superseded')),
  outcome_note text,                                     -- null until reviewed
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- One strategist run over one period. `status` records whether the period
-- actually contained anything: 'quiet' is a real answer and is stored as such,
-- so a week with no movement produces a short honest digest rather than a
-- padded one. `payload` is the full StrategistPayload contract (see
-- src/lib/types/db.ts); `client_digest_ar` is the Arabic text a human would
-- send. `sent` stays false until a human sends it — nothing in this app
-- publishes anything (hard rule 1).
-- ---------------------------------------------------------------------------
create table digests (
  id uuid primary key default gen_random_uuid(),
  period_from date not null,
  period_to date not null,
  status text not null check (status in ('material','quiet')),
  payload jsonb not null,                                -- StrategistPayload
  client_digest_ar text not null,
  sent boolean not null default false,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Indexes for the access patterns the strategist actually uses: "what is due
-- for review", and "the most recent digests".
-- ---------------------------------------------------------------------------
create index decisions_status_review_after_idx on decisions (status, review_after);
create index digests_created_at_idx on digests (created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: deny-all, exactly as in 0001 and 0002. No policies are defined, so the
-- anon key that reaches the browser can read nothing. Every read and write
-- goes through an auth-gated route handler using the service-role key, which
-- bypasses RLS.
-- ---------------------------------------------------------------------------
alter table decisions  enable row level security;
alter table digests    enable row level security;
