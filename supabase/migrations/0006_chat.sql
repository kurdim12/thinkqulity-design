-- ThinkQuality Studio -- v4.1: the CHAT transcript.
-- Additive only: 0001_init.sql, 0002_v3_ingestion.sql, 0003_strategist.sql,
-- 0004_v4_visual.sql and 0005_mcp_reservations.sql are applied and are never
-- rewritten (hard rule 6).
--
-- ---------------------------------------------------------------------------
-- WHAT THIS STORES, AND WHY EACH COLUMN EXISTS
--
-- The chat surface is a WINDOW and a DISPATCHER, not a second brain. Two
-- consequences shape this schema:
--
--   1. NO DELIVERABLE TEXT LIVES HERE. Concepts, campaigns, reports, guidelines,
--      rewrites and digests are dispatched to the features that already own
--      them, with their brain gates intact, and each writes to its own table
--      (hard rule 17). `cards` therefore holds a REFERENCE to what a dispatch
--      produced -- ids, a title, a status -- not the artefact. A copy of a
--      deliverable stored here would be a second source of truth that no gate
--      guards.
--   2. THE LAW REPORT IS PART OF THE MESSAGE. `law_report` is the audit trail
--      for hard rule 16: every assistant turn is buffered server-side, linted
--      against the blocks it was given and the tool results it received, and
--      only then delivered. A reply that had a number STRIPPED must be able to
--      say so afterwards, from the row, without re-running anything. A message
--      with no report is a message that was never gated, which is a bug worth
--      being able to detect.
--
-- `content` defaults to '' rather than being nullable: an assistant turn that
-- dispatched a card and said nothing is an EMPTY string, not an unknown one.
-- Nullable text here would make "said nothing" and "was never recorded"
-- indistinguishable, and rule 2 -- absent is absent, never a stand-in -- cuts
-- both ways.
--
-- `est_usd` is numeric and NULLABLE, and null is load-bearing: this app prices a
-- call only from a rate copied off a vendor page into src/lib/agent/rates.ts
-- (hard rule 15). A model nobody has priced yields null and a stated reason --
-- never 0, which would read as "this turn was free".
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- One conversation. `title` is nullable because a conversation is created
-- before anybody knows what it is about; a placeholder title would be a
-- fabricated summary of a thread with no turns in it.
-- ---------------------------------------------------------------------------
create table conversations (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- One turn. `role` is checked rather than free text so a fourth role cannot
-- appear without a migration deciding what it means.
--
--   user      -- what the operator typed.
--   assistant -- a BUFFERED, LINTED reply. Nothing streams before the lint
--                passes, so a row of this role is by construction a reply that
--                was gated -- `law_report` says how it fared.
--   tool      -- a tool result, stored verbatim as it was fed back to the
--                model, because it is half of the context the linter checked
--                the reply against. Without it the audit trail is unreadable:
--                a number can be sourced by a tool result that nothing recorded.
--
-- ON DELETE CASCADE: a deleted conversation must not leave orphan turns. The
-- transcript is the conversation; there is nothing to keep once it is gone.
-- ---------------------------------------------------------------------------
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')),
  content text not null default '',
  cards jsonb,
  tool_calls jsonb,
  law_report jsonb,
  est_usd numeric,
  created_at timestamptz default now()
);

-- Reading a conversation is always "this thread, in order", so the index is the
-- composite the read actually uses rather than one on conversation_id alone.
create index chat_messages_conversation_created_idx
  on chat_messages (conversation_id, created_at);

-- Listing conversations is always newest-first.
create index conversations_created_at_idx on conversations (created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: deny-all, exactly as in 0001, 0002, 0003, 0004 and 0005. No policies are
-- defined, so the anon key that reaches the browser can read nothing and write
-- nothing. Every read and write goes through the service-role key, which
-- bypasses RLS.
--
-- This matters more here than anywhere else in the schema: a transcript is the
-- one table that accumulates the operator's own words. Deny-all with no policy
-- is the state where a leaked anon key reads none of it.
-- ---------------------------------------------------------------------------
alter table conversations  enable row level security;
alter table chat_messages  enable row level security;
