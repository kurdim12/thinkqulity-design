-- ThinkQuality Studio -- v5: EXTERNAL KNOWLEDGE. Rules 21 and 22.
-- Additive only: 0001_init.sql through 0006_chat.sql are applied and are never
-- rewritten (hard rule 6). 0007_chat_dispatch_reservation.sql is WRITTEN AND NOT
-- APPLIED; this file touches nothing it touches, so the two are independent and
-- may be applied in either order.
--
-- ===========================================================================
-- WHAT THIS SCHEMA IS FOR, AND THE ONE FAILURE IT EXISTS TO PREVENT
-- ===========================================================================
-- The operator wants the agent to understand the two brands and the wider web,
-- not only the ingested rows. The danger is the exact failure this product was
-- built to prevent: a follower count read on some directory page, presented as
-- THE follower count.
--
-- RULE 21 IS THE ANSWER AND IT HAS TO BE STRUCTURAL. A follower count read on a
-- website is not a follower count. It is a CLAIM SOMEBODY PUBLISHED. Those are
-- different kinds of thing, they are stored in different tables, they are typed
-- so that neither is assignable to the other (src/lib/web/facts.ts), and only
-- one of them can ever be a `source_key`.
--
-- THE KEY FACT ABOUT THIS FILE IS A COLUMN THAT IS ABSENT. `external_facts` has
-- no `source_key` and never will. `source_key` is the name of a value THIS
-- CODEBASE COMPUTED, and it is the only thing src/lib/brain/substitute.ts will
-- substitute into a deliverable. A claim off a web page has no such name, so it
-- can never be substituted, so under rule 20 -- the model does not type
-- quantities -- an external NUMBER cannot reach a deliverable at all. Rules 20
-- and 21 compose into a guarantee neither makes alone, and it is a guarantee
-- about the schema, not about anybody's diligence.
--
-- ===========================================================================
-- WHY A SEPARATE LEDGER AND NOT `scrape_runs` -- ASKED, AND ANSWERED NO
-- ===========================================================================
-- `scrape_runs` (0002) was read before this was written. It genuinely does not
-- fit, on four counts, and forcing it would corrupt a ledger that currently
-- means one thing:
--
--   1. It is ACTOR-SHAPED. `actor text not null` and `input jsonb not null` are
--      an Apify call: a named actor and the JSON it was handed. A GET of a URL
--      has neither. Writing 'fetch' into `actor` is a false row in a ledger,
--      which is the same sin as a false number on a screen (0007 makes exactly
--      this argument about reusing 'generate_concepts' for a chat dispatch).
--   2. Its `kind` CHECK is ('posts','profile','comments','monitor') -- four
--      kinds of Instagram scrape. Widening it to admit the whole web would
--      change what every existing row means by association.
--   3. IT COUNTS NOTHING. `scrape_runs` is a record, and the cap that guards it
--      lives outside in src/lib/ingest/budget.ts as an estimate-then-block over
--      money. Rule 22 needs a COUNT that is atomic against concurrent isolates,
--      which is a different mechanism (see below), and bolting it onto
--      `scrape_runs` would put a fetch counter in the scrape path.
--   4. IT HAS NO `triggered_by`. Rule 22's whole content is that a fetch is
--      operator-triggered or explicitly scheduled. A ledger that cannot say
--      WHICH, and WHO, does not discharge the rule.
--
-- ===========================================================================
-- THE CAP FOLLOWS 0005's SHAPE, FOR 0005's REASON
-- ===========================================================================
-- 0005_mcp_reservations.sql moved the unit of account from the OUTCOME to the
-- RESERVATION because "read `used`, then act" is not atomic across concurrent
-- Worker isolates: N simultaneous requests each read the same `used` and each
-- pass. That reasoning is about concurrency, not about models, so it applies
-- here unchanged and `web_reserve_fetch` below is the same one-statement
-- check-and-increment under the contended row's lock.
--
-- IT IS A SEPARATE ATOM FROM `mcp_cap_days`, DELIBERATELY. Adding 'web_fetch'
-- to `mcp_reservations.tool` would make a web read and a client deliverable
-- compete for one ceiling, so a day of research could refuse the concept the
-- research was for. They are different resources with different ceilings and
-- they get different counters.
--
-- IT IS SIMPLER THAN 0005 IN ONE WAY, AND THAT IS ON PURPOSE. 0005 needs
-- `greatest(reserved_units, p_durable_used)` because two independent measures of
-- the same day overlap, and it needs a 'released' status because a model call
-- that never billed should hand its units back. Neither applies here:
--
--   * There is ONE measure. Nothing else counts fetches, so there is nothing to
--     reconcile against and nothing to double-charge.
--   * NOTHING IS EVER RELEASED, and that is the interesting decision. A URL the
--     SSRF guard refuses is settled 'refused' and KEEPS its unit. Rule 22 is
--     "no silent network", which is a bound on ACTIVITY and not only on money:
--     if a refusal were free, an agent or a hostile payload could probe ten
--     thousand private addresses for nothing and leave a cap that never moved.
--     An attempt that had to be refused is precisely the activity worth
--     bounding. So the counter is monotone within a day, `web_settle_retrieval`
--     records the outcome and never touches the day row, and there is no refund
--     path to get wrong.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- One row per Amman day: how many external fetches have been ATTEMPTED.
--
-- A single row is the thing concurrent callers contend on, which is what makes
-- the check-and-increment lockable. `reserved_fetches` only ever moves through
-- `web_reserve_fetch` below, and only ever upward.
--
-- `amman_day` is supplied by the app and never by now(). This file calls no
-- clock at all, for 0005's reason: the app already has one notion of the Amman
-- civil day (ammanIsoDate in src/lib/mcp/tools.ts) and a second definition
-- living in SQL could disagree with it across a midnight boundary.
-- ---------------------------------------------------------------------------
create table web_fetch_days (
  amman_day date primary key,
  reserved_fetches int not null default 0 check (reserved_fetches >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RULE 22's LEDGER: one row per fetch ATTEMPT, written BEFORE the request.
--
-- WHY THE ROW PRECEDES THE NETWORK, and not the other way round. A ledger
-- written afterwards records only what succeeded, so the two things most worth
-- seeing -- the request that was refused, and the request that hung -- are the
-- two it cannot show. Writing first also means the row is the reservation: the
-- unit is taken in the same statement that creates the record of what it was
-- taken for, so a counted fetch with no row, or a row with no count, is not a
-- state this schema can reach.
--
-- COLUMNS, AND WHY EACH ONE IS HERE
--   url          the URL AS REQUESTED, verbatim. Not normalised, not cleaned:
--                what was asked for is the thing under audit.
--   host         the parsed, lowercased host. Denormalised out of `url` so a
--                per-host pattern ("something fetched this domain 400 times")
--                is one index scan rather than 400 URL parses.
--   final_url    where the redirect chain actually ended. Null until settled,
--                and null on a refusal -- nowhere was reached. A fetch that
--                lands somewhere other than where it was aimed is the single
--                most important thing an SSRF audit needs to see, so it is a
--                column and not a note.
--   trigger      'operator' or 'schedule'. RULE 22 IS THIS CHECK CONSTRAINT.
--                There is no 'agent' and no 'tool' value, so a fetch on a
--                model's own initiative mid-sentence is not a row this table can
--                hold -- it FAILS CLOSED, exactly as 0005's `tool` check does.
--                A third trigger would need its own migration, which is the
--                point at which somebody has to justify it.
--   triggered_by WHO or WHICH: the operator's email, or the schedule's name.
--                "Operator-triggered" is not discharged by a boolean.
--   estimated_usd  null = NOT ESTIMATED, never "free" -- the same semantics as
--                `scrape_runs.estimated_usd`, and rule 15: an unverifiable price
--                blocks. See WEB_PROVIDER_RATES in src/lib/web/fetch.ts, where a
--                null rate refuses the call before it reaches this table.
--   status       reserved -- open; the attempt is in flight.
--                ok       -- a response was received (any HTTP status).
--                refused  -- the guard refused it. NO REQUEST WENT OUT.
--                failed   -- a request went out and did not complete.
--   http_status  the status line, when there was one. Null otherwise.
--   bytes        bytes actually read, capped. Null when nothing was read.
--   note         why, in words, for a refusal or a failure.
-- ---------------------------------------------------------------------------
create table web_retrievals (
  id uuid primary key default gen_random_uuid(),
  amman_day date not null references web_fetch_days(amman_day),
  url text not null,
  host text not null,
  final_url text,
  trigger text not null check (trigger in ('operator','schedule')),
  triggered_by text not null check (length(btrim(triggered_by)) > 0),
  estimated_usd numeric,
  status text not null default 'reserved'
    check (status in ('reserved','ok','refused','failed')),
  http_status int,
  bytes int check (bytes >= 0),
  note text,
  requested_at timestamptz not null default now(),
  settled_at timestamptz,
  -- A settled row carries the instant it settled; an open one does not. The
  -- database enforces the pairing rather than trusting every writer.
  constraint web_retrievals_settled_pairing check (
    (status = 'reserved' and settled_at is null) or
    (status <> 'reserved' and settled_at is not null)
  ),
  -- A refusal never reached the network, so it can have neither a status line
  -- nor a destination. Enforced here because "refused" is the row an auditor
  -- reads most carefully, and a refusal carrying an http_status would mean the
  -- guard ran after the request -- which is the bug this constraint detects.
  constraint web_retrievals_refusal_reached_nothing check (
    status <> 'refused' or (http_status is null and final_url is null and bytes is null)
  )
);

create index web_retrievals_day_idx on web_retrievals (amman_day, requested_at desc);
create index web_retrievals_host_idx on web_retrievals (host, requested_at desc);
create index web_retrievals_open_idx on web_retrievals (amman_day) where status = 'reserved';

-- ---------------------------------------------------------------------------
-- EXTERNAL FACTS: what somebody published, filed as what somebody published.
--
-- THE COLUMN THAT IS NOT HERE IS THE DESIGN. There is no `source_key`, no
-- `value`, no `n`, no `as_of`. Those are the vocabulary of a MEASUREMENT
-- (`Measure` in src/lib/agent/strategist/blocks.ts, `BasisRef` in
-- src/lib/types/db.ts), and this table holds no measurements. A row here is a
-- sentence somebody else wrote, stored verbatim, wearing the URL it was written
-- at and the moment it was read. Do not add a `source_key` to this table.
--
--   retrieval_id   NOT NULL, and referencing the ledger. THIS IS HOW "THE
--                  LEDGER ROW IS WRITTEN BEFORE THE MAPPING" IS ENFORCED rather
--                  than merely intended: a fact whose fetch was never ledgered
--                  has no id to point at, and Postgres refuses the insert. On
--                  delete restrict (the default) so a ledger row cannot be
--                  removed out from under the claims it produced.
--   claim          THE CLAIM VERBATIM AS PUBLISHED. Not summarised, not
--                  rounded, not translated -- a paraphrase is a second author's
--                  work and it is no longer quotable. Non-blank by constraint.
--   source_url     where it was read. Rule 21: an external fact CARRIES ITS
--                  URL. Denormalised from `web_retrievals.final_url` on purpose
--                  -- the fact must be self-describing when it is read alone,
--                  because the renderer that shows it to a model shows the row,
--                  not the join.
--   page_title     the page's own title. Null means the page carried none --
--                  which is a fact about the page, not an unknown.
--   retrieved_at   NOT NULL. Rule 21: an external fact carries its retrieval
--                  date. A web claim with no date is indistinguishable from a
--                  web claim from 2019.
--   topic          the entity or subject this claim is filed under, so a
--                  context render can ask for "what the web says about X"
--                  without scanning every row.
--   kind           what CLASS of claim it is. A statistic and a definition
--                  carry different risk: the first invites being read as a
--                  measurement, the second does not.
--   confidence     'unverified' by default AND THERE IS NO VALUE MEANING TRUE.
--                  Not an oversight -- rule 21 says external knowledge is never
--                  a measurement of anything, so no amount of corroboration
--                  promotes a claim into a measure. 'corroborated' means a
--                  second external source said the same thing (two claims, not
--                  a fact). 'contradicted' means THIS SYSTEM'S OWN MEASUREMENT
--                  disagrees, which is the most valuable row in the table.
--   about_client   THE RULE 21 FLAG. True when the claim is about one of the
--                  client's own accounts. Set by a ONE-WAY RATCHET in
--                  src/lib/web/facts.ts: a caller may raise it, and no caller
--                  can lower it -- an independent scan for the canonical handles
--                  can only ever escalate.
--   client_account / client_measure
--                  which handle, and which measure the claim purports to be.
--                  Present only when `about_client`, enforced below, so the
--                  flag can never be a bare boolean nobody can act on.
--
-- WHY STORE-AND-MARK RATHER THAN REFUSE OUTRIGHT. The full argument is in
-- src/lib/web/facts.ts; the short form is that refusal needs a DETECTOR to
-- decide what to refuse, and a detector that gates STORAGE fails open when it
-- misses -- the claim lands unmarked in whatever the caller does instead.
-- Marking fails toward "stored, unmarked, and still structurally incapable of
-- becoming a figure", because no external fact of any kind can mint a
-- source_key. Only one of those two failure modes is bounded by something other
-- than the detector's accuracy. Storing also keeps the genuinely useful row:
-- "the web publishes X about this account, we measure Y" is a real finding and
-- it is only expressible if X is written down.
-- ---------------------------------------------------------------------------
create table external_facts (
  id uuid primary key default gen_random_uuid(),
  retrieval_id uuid not null references web_retrievals(id),
  claim text not null check (length(btrim(claim)) > 0),
  source_url text not null check (source_url like 'https://%'),
  page_title text,
  retrieved_at timestamptz not null,
  topic text not null check (length(btrim(topic)) > 0),
  kind text not null check (kind in ('statistic','statement','definition','event','listing')),
  confidence text not null default 'unverified'
    check (confidence in ('unverified','corroborated','contradicted')),
  about_client boolean not null default false,
  client_account text check (client_account in ('personal','academy')),
  client_measure text check (
    client_measure in ('followers','following','post_count','engagement','verification')
  ),
  created_at timestamptz not null default now(),
  -- A claim about the client names WHICH account; a claim about anything else
  -- names none. `client_measure` stays optional inside the flagged case: a page
  -- may say something about the academy that is not one of the five measures.
  constraint external_facts_client_pairing check (
    (about_client and client_account is not null) or
    (not about_client and client_account is null and client_measure is null)
  ),
  -- The same claim recorded twice off one page is a duplicate, and duplicates
  -- would read as corroboration by an operator counting rows.
  unique (retrieval_id, claim)
);

create index external_facts_topic_idx on external_facts (topic, retrieved_at desc);
create index external_facts_retrieval_idx on external_facts (retrieval_id);
-- Partial: the operator's most important question is "what does the web claim
-- about US", and it should be one cheap scan however large the table grows.
create index external_facts_about_client_idx on external_facts (client_account, retrieved_at desc)
  where about_client;

comment on table external_facts is
  'Claims published elsewhere, stored verbatim with URL and retrieval date. NOT measurements. '
  'This table deliberately has no source_key column: a source_key names a value this codebase '
  'computed, and nothing here was computed here. Do not add one.';

-- ---------------------------------------------------------------------------
-- web_reserve_fetch -- CHECK AND INCREMENT IN ONE STATEMENT, then ledger.
--
-- THE STATEMENT THAT DOES THE WORK:
--
--     update web_fetch_days d
--        set reserved_fetches = d.reserved_fetches + 1
--      where d.amman_day = p_day
--        and d.reserved_fetches + 1 <= p_limit
--     returning d.reserved_fetches into v_after;
--
-- The predicate reads `d.reserved_fetches` from the very row the UPDATE writes,
-- so it is evaluated under that row's lock rather than before it. Under READ
-- COMMITTED a concurrent uncommitted update makes this statement BLOCK, and on
-- the other transaction's commit Postgres re-fetches the new row version and
-- RE-EVALUATES the WHERE clause against it (EvalPlanQual). If the predicate no
-- longer holds, zero rows come back, FOUND is false and the caller is refused.
-- Two callers therefore cannot both pass a limit test that reads the same row.
-- That is a property of the row lock and not of timing, and it is the property
-- a read-then-write pair cannot have at any isolation level. The reasoning, and
-- the wording, are 0005's -- because it is the same mechanism, and a second
-- derivation that drifted would be worse than a citation.
--
-- The `insert ... on conflict do nothing` only ensures the row EXISTS; it
-- grants nothing. If it loses a race it waits for the winner and does nothing;
-- if the winner ABORTS the row is absent, the UPDATE matches nothing and the
-- caller is refused -- a false refusal, the safe direction to be wrong in.
--
-- THE LEDGER ROW IS INSERTED IN THE SAME TRANSACTION AS THE INCREMENT, so the
-- count and the record of what was counted commit together or not at all.
--
-- VOLATILE (stated, not assumed): it writes. SECURITY INVOKER: it grants no
-- privilege of its own, and EXECUTE is revoked from anon and authenticated
-- below.
--
-- Returns exactly one row either way. `fetches_reserved_today` is reported even
-- on refusal, so a refusal can say how much of the window is gone rather than
-- only that it is full.
-- ---------------------------------------------------------------------------
create function web_reserve_fetch(
  p_day date,
  p_url text,
  p_host text,
  p_trigger text,
  p_triggered_by text,
  p_limit int,
  p_estimated_usd numeric
)
returns table (granted boolean, retrieval_id uuid, fetches_reserved_today int)
language plpgsql
volatile
as $$
declare
  v_after int;
  v_id uuid;
begin
  if p_day is null then
    raise exception 'web_reserve_fetch: p_day is required; this function never decides what day it is';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'web_reserve_fetch: p_limit must be a positive integer';
  end if;
  if p_url is null or length(btrim(p_url)) = 0 then
    raise exception 'web_reserve_fetch: p_url is required';
  end if;
  if p_host is null or length(btrim(p_host)) = 0 then
    raise exception 'web_reserve_fetch: p_host is required';
  end if;

  -- Ensure the contended row exists. Grants nothing on its own.
  insert into web_fetch_days (amman_day) values (p_day) on conflict (amman_day) do nothing;

  -- The one statement. Check and increment, under the row's lock.
  update web_fetch_days d
     set reserved_fetches = d.reserved_fetches + 1,
         updated_at = now()
   where d.amman_day = p_day
     and d.reserved_fetches + 1 <= p_limit
  returning d.reserved_fetches into v_after;

  if found then
    -- `trigger` and `triggered_by` are checked by the table, not here: a bad
    -- trigger must abort the whole function so the unit is rolled back with it.
    insert into web_retrievals (amman_day, url, host, trigger, triggered_by, estimated_usd)
    values (p_day, p_url, lower(btrim(p_host)), p_trigger, p_triggered_by, p_estimated_usd)
    returning id into v_id;

    return query select true, v_id, v_after;
    return;
  end if;

  select coalesce(max(d.reserved_fetches), 0) into v_after
    from web_fetch_days d
   where d.amman_day = p_day;

  return query select false, null::uuid, v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- web_settle_retrieval -- record the outcome of one attempt, exactly once.
--
-- IT NEVER TOUCHES `web_fetch_days`. There is no refund: see the header. This
-- function only writes down what happened, which makes double-settlement
-- harmless rather than merely guarded -- but it is guarded anyway, by
-- `and status = 'reserved'`, so the FIRST outcome recorded is the one that
-- stands and a late error cannot overwrite a success.
--
-- 'refused' carries no http_status, no final_url and no bytes; the table
-- constraint enforces that and this function does not restate it, because a
-- second copy of a rule is a second place for it to drift.
-- ---------------------------------------------------------------------------
create function web_settle_retrieval(
  p_retrieval uuid,
  p_status text,
  p_http_status int,
  p_bytes int,
  p_final_url text,
  p_note text
)
returns table (settled_status text)
language plpgsql
volatile
as $$
begin
  if p_status is null or p_status not in ('ok','refused','failed') then
    raise exception 'web_settle_retrieval: p_status must be ok, refused or failed';
  end if;

  update web_retrievals r
     set status = p_status,
         http_status = p_http_status,
         bytes = p_bytes,
         final_url = p_final_url,
         note = p_note,
         settled_at = now()
   where r.id = p_retrieval
     and r.status = 'reserved';

  if not found then
    -- Already settled, or no such retrieval. Idempotent, and silent about
    -- which, because both mean "this call changed nothing".
    return query select 'already_settled'::text;
    return;
  end if;

  return query select p_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: deny-all, exactly as in 0001 through 0006. No policies are defined, so
-- the anon key that reaches the browser can read nothing and write nothing.
-- Every read and write goes through the service-role key, which bypasses RLS.
--
-- REVOKING FROM `public` IS NOT ENOUGH -- the lesson 0005 paid for. Supabase
-- ships DEFAULT PRIVILEGES granting EXECUTE on every new function in `public`
-- to `anon` and `authenticated` DIRECTLY, not through the PUBLIC pseudo-role,
-- so `revoke ... from public` leaves those two grants standing. Both roles are
-- named explicitly.
-- ---------------------------------------------------------------------------
alter table web_fetch_days  enable row level security;
alter table web_retrievals  enable row level security;
alter table external_facts  enable row level security;

revoke all on function web_reserve_fetch(date, text, text, text, text, int, numeric)
  from public, anon, authenticated;
revoke all on function web_settle_retrieval(uuid, text, int, int, text, text)
  from public, anon, authenticated;

grant execute on function web_reserve_fetch(date, text, text, text, text, int, numeric) to service_role;
grant execute on function web_settle_retrieval(uuid, text, int, int, text, text) to service_role;
