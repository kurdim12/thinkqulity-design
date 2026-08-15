-- ThinkQuality Studio -- v5: the MCP spend RESERVATION.
-- Additive only: 0001_init.sql, 0002_v3_ingestion.sql, 0003_strategist.sql and
-- 0004_v4_visual.sql are applied and are never rewritten (hard rule 6).
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
--
-- The daily cap counted OUTCOMES: rows in `concepts` and `compliance_checks`.
-- Two defects follow from that, and both were real:
--
--   1. SPEND PRECEDES THE OUTCOME. check_compliance called retrieveCanon()
--      -- which can issue a BILLED embedding request on a different provider
--      key -- before it wrote the row that counted. With no judge key
--      configured the row was never written at all, so the count never moved
--      and the embedding could be repeated without limit.
--   2. READ-THEN-ACT IS NOT ATOMIC. `if (cap.used + count > cap.limit)` reads,
--      then the model call acts. On a runtime of concurrent isolates, N
--      simultaneous requests each read the same `used` and each pass.
--
-- A cap that counts outcomes cannot bound spend. So the unit of account moves
-- from the artefact to the RESERVATION: units are taken atomically BEFORE the
-- first call that can bill, and reconciled afterwards.
--
-- ---------------------------------------------------------------------------
-- THE WINDOW IS THE AMMAN DAY, AND IT IS NOT REDEFINED HERE
--
-- `p_day` is a REQUIRED parameter with no default, and nothing in this file
-- calls now(), current_date or `now() at time zone 'Asia/Amman'` to decide what
-- day it is. That is deliberate: the app already has one notion of the Amman
-- day (ammanIsoDate / ammanDayStart in src/lib/mcp/tools.ts, the same civil day
-- todayInAmman() names in src/lib/agent/features/strategist.ts), and a second
-- definition living in SQL could disagree with it at a midnight boundary. The
-- caller passes the day it also counted the durable window for, so the
-- reservation and the count are always about the same day.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- One row per Amman day: the units MCP callers hold for that window.
--
-- A single row is the thing concurrent callers contend on, which is what makes
-- the check-and-increment lockable. `reserved_units` only ever moves through
-- the two functions below.
-- ---------------------------------------------------------------------------
create table mcp_cap_days (
  amman_day date primary key,                          -- supplied by the app, never by now()
  reserved_units int not null default 0 check (reserved_units >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- One row per reservation, so the operator can see WHERE THE CAP WENT rather
-- than only that it is gone.
--
-- `tool` is checked against the two MCP tools that can spend. get_brand_facts
-- and get_latest_digest are absent on purpose: they call no model, take no
-- units, and a reservation naming one of them would be a bug worth failing on.
-- A future spending tool needs its own migration -- until then this constraint
-- refuses the reservation, which fails CLOSED.
--
-- `status`:
--   reserved -- units are held, the request is still running.
--   spent    -- a billed request provably went out. Units stay consumed.
--   unproven -- the request failed and it CANNOT be proven that nothing was
--               billed. Units stay consumed. Over-counting costs the caller a
--               request; under-counting costs the operator money.
--   released -- the request failed and nothing had been billed yet. Only this
--               status returns units to the window.
--
-- `note` says which of those it was, in words, on the row itself.
-- ---------------------------------------------------------------------------
create table mcp_reservations (
  id uuid primary key default gen_random_uuid(),
  amman_day date not null references mcp_cap_days(amman_day),
  tool text not null check (tool in ('check_compliance','generate_concepts')),
  units int not null check (units > 0),
  status text not null default 'reserved'
    check (status in ('reserved','spent','unproven','released')),
  note text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  -- A settled row carries the instant it settled; an open one does not. The
  -- database enforces the pairing rather than trusting every writer.
  constraint mcp_reservations_settled_pairing check (
    (status = 'reserved' and settled_at is null) or
    (status <> 'reserved' and settled_at is not null)
  )
);

create index mcp_reservations_day_idx on mcp_reservations (amman_day, created_at desc);
create index mcp_reservations_open_idx on mcp_reservations (amman_day) where status = 'reserved';

-- ---------------------------------------------------------------------------
-- mcp_reserve_units -- CHECK AND INCREMENT IN ONE STATEMENT.
--
-- THE STATEMENT THAT DOES THE WORK, quoted here so a reader does not have to
-- find it below:
--
--     update mcp_cap_days d
--        set reserved_units = d.reserved_units + p_units
--      where d.amman_day = p_day
--        and greatest(d.reserved_units, p_durable_used) + p_units <= p_limit
--     returning d.reserved_units into v_after;
--
-- WHY THE LOCKING IS SOUND, and why this is not a read followed by a write.
-- The predicate reads `d.reserved_units` from the very row the UPDATE is
-- writing, so it is evaluated under that row's lock rather than before it:
--
--   * The row is found by primary key. UPDATE takes a FOR UPDATE row lock on it.
--   * Under READ COMMITTED (Supabase's default), if a concurrent transaction
--     has already updated that row and not yet committed, this UPDATE BLOCKS on
--     the lock instead of proceeding on a stale snapshot.
--   * When the other transaction commits, Postgres re-fetches the NEW version
--     of the row and RE-EVALUATES the WHERE clause against it (EvalPlanQual).
--     If the predicate no longer holds, the row is not updated, zero rows come
--     back, FOUND is false, and the caller is refused.
--   * If the other transaction rolls back, the row reverts and this UPDATE
--     proceeds against the true value.
--
-- So two callers cannot both pass a limit test that reads the same row. That is
-- a property of the row lock, not of timing, and it is the property tests
-- against a read-then-write pair cannot have at any isolation level.
--
-- The `insert ... on conflict do nothing` above it only ensures the row EXISTS;
-- it grants nothing. If it loses a race it waits for the winner to commit and
-- does nothing, and both callers then contend on the UPDATE. If the winner
-- ABORTS, the row is absent, the UPDATE matches zero rows and the caller is
-- refused -- a false refusal, which is the safe direction to be wrong in.
--
-- WHY `greatest(reserved_units, p_durable_used)` AND NOT A SUM.
-- Two independent measures of the same day exist and they overlap:
--   `reserved_units`  -- units MCP took, counted before the work.
--   `p_durable_used`  -- rows in concepts + compliance_checks since the window
--                        opened, counted after the work, and including the
--                        operator's own generations in the browser.
-- An MCP call that succeeds appears in BOTH, so adding them would charge it
-- twice and quietly halve the cap. Taking the larger keeps the operator's
-- browser work squeezing MCP out of the shared ceiling -- which is the
-- behaviour the row-counting cap already had -- without double-charging.
-- THE HONEST LIMITATION: while MCP reservations are open and the operator is
-- also generating, the larger of the two can be below their true sum, so the
-- window can briefly allow more than a perfectly attributed count would. The
-- fix for that is an origin column on `concepts` and `compliance_checks`, which
-- is a schema change to those tables and is not attempted here.
--
-- VOLATILE (the default, stated rather than assumed): it writes, so the planner
-- must never cache, fold or elide a call. SECURITY INVOKER (also the default):
-- the function grants no privilege of its own, and EXECUTE is revoked from
-- PUBLIC below so only the service role can reach it.
--
-- Returns exactly one row either way: `granted` says which, and
-- `units_reserved_today` is reported even on refusal so the refusal can name
-- how much of the window is held rather than only that it is full.
-- ---------------------------------------------------------------------------
create function mcp_reserve_units(
  p_day date,
  p_tool text,
  p_units int,
  p_limit int,
  p_durable_used int
)
returns table (granted boolean, reservation_id uuid, units_reserved_today int)
language plpgsql
volatile
as $$
declare
  v_after int;
  v_id uuid;
begin
  if p_day is null then
    raise exception 'mcp_reserve_units: p_day is required; this function never decides what day it is';
  end if;
  if p_units is null or p_units <= 0 then
    raise exception 'mcp_reserve_units: p_units must be a positive integer';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'mcp_reserve_units: p_limit must be a positive integer';
  end if;
  if p_durable_used is null or p_durable_used < 0 then
    raise exception 'mcp_reserve_units: p_durable_used must be zero or more';
  end if;

  -- Ensure the contended row exists. Grants nothing on its own.
  insert into mcp_cap_days (amman_day) values (p_day) on conflict (amman_day) do nothing;

  -- The one statement. Check and increment, under the row's lock.
  update mcp_cap_days d
     set reserved_units = d.reserved_units + p_units,
         updated_at = now()
   where d.amman_day = p_day
     and greatest(d.reserved_units, p_durable_used) + p_units <= p_limit
  returning d.reserved_units into v_after;

  if found then
    insert into mcp_reservations (amman_day, tool, units)
    values (p_day, p_tool, p_units)
    returning id into v_id;

    return query select true, v_id, v_after;
    return;
  end if;

  -- Refused. Report what is actually held, so the caller can say so.
  select coalesce(max(d.reserved_units), 0) into v_after
    from mcp_cap_days d
   where d.amman_day = p_day;

  return query select false, null::uuid, v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- mcp_settle_reservation -- reconcile one reservation, exactly once.
--
-- `where id = p_reservation and status = 'reserved'` is the whole guard. The
-- UPDATE locks the reservation row; a second settlement of the same id blocks,
-- re-evaluates against the settled row, matches nothing, and reports
-- 'already_settled' without touching the day counter. Units therefore cannot be
-- released twice, which would be a refund of money that was spent.
--
-- Only 'released' returns units. 'spent' and 'unproven' both leave the window
-- consumed -- the difference between them is what the operator is told, not
-- what the cap does.
-- ---------------------------------------------------------------------------
create function mcp_settle_reservation(
  p_reservation uuid,
  p_status text,
  p_note text
)
returns table (settled_status text, units_released int)
language plpgsql
volatile
as $$
declare
  v_units int;
  v_day date;
begin
  if p_status is null or p_status not in ('spent','unproven','released') then
    raise exception 'mcp_settle_reservation: p_status must be spent, unproven or released';
  end if;

  update mcp_reservations r
     set status = p_status,
         note = p_note,
         settled_at = now()
   where r.id = p_reservation
     and r.status = 'reserved'
  returning r.units, r.amman_day into v_units, v_day;

  if not found then
    -- Already settled, or no such reservation. Idempotent and silent about
    -- which, because both mean "this call changed nothing".
    return query select 'already_settled'::text, 0;
    return;
  end if;

  if p_status = 'released' then
    update mcp_cap_days d
       set reserved_units = greatest(0, d.reserved_units - v_units),
           updated_at = now()
     where d.amman_day = v_day;

    return query select p_status, v_units;
    return;
  end if;

  return query select p_status, 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: deny-all, exactly as in 0001, 0002, 0003 and 0004. No policies are
-- defined, so the anon key that reaches the browser can read nothing and write
-- nothing. Every read and write goes through the service-role key, which
-- bypasses RLS.
--
-- The two functions are SECURITY INVOKER, so a caller who reached them would
-- still hit that same deny-all. That is the second belt, and it was MEASURED,
-- not assumed: calling /rest/v1/rpc/mcp_reserve_units with the anon key returns
--   42501  new row violates row-level security policy for table "mcp_cap_days"
--
-- REVOKING FROM `public` IS NOT ENOUGH, and finding out why is the reason this
-- block names roles. Supabase ships DEFAULT PRIVILEGES that grant EXECUTE on
-- every new function in `public` to `anon` and `authenticated` DIRECTLY -- not
-- through the PUBLIC pseudo-role -- so `revoke ... from public` leaves those
-- two grants standing. After the first attempt at this migration,
-- has_function_privilege('anon', 'mcp_reserve_units(...)', 'execute') was still
-- true. Both roles are therefore named explicitly below.
-- ---------------------------------------------------------------------------
alter table mcp_cap_days     enable row level security;
alter table mcp_reservations enable row level security;

revoke all on function mcp_reserve_units(date, text, int, int, int)
  from public, anon, authenticated;
revoke all on function mcp_settle_reservation(uuid, text, text)
  from public, anon, authenticated;

grant execute on function mcp_reserve_units(date, text, int, int, int) to service_role;
grant execute on function mcp_settle_reservation(uuid, text, text) to service_role;
