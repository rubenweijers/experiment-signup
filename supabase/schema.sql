-- Experiment sign-up schema. Idempotent: safe to re-run in the Supabase SQL Editor.
-- Anonymous visitors reach the data only through the three public RPCs below.
-- The Gmail mailer (apps-script/mailer.gs) uses two more, which require its secret.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.slots (
  id         uuid primary key default gen_random_uuid(),
  start_time timestamptz not null,
  end_time   timestamptz not null,
  room       text not null default 'Lab Room',
  is_active  boolean not null default true,
  notes      text,
  -- One slot runs one group. These are set by the researcher, never public.
  group_id   text unique,
  condition  text not null check (condition in ('2P', '3P')),
  -- No overbooking: a slot seats exactly its group, so capacity cannot drift from condition.
  capacity   int generated always as (case condition when '2P' then 2 else 3 end) stored,
  created_at timestamptz default now(),
  check (end_time > start_time)
);

-- Upgrades a database created when capacity was set by hand. Slots with no
-- condition yet become 3P unless their capacity was 2.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'slots'
               and column_name = 'capacity' and is_generated = 'NEVER') then
    update public.slots set condition = case when capacity = 2 then '2P' else '3P' end
      where condition is null;
    alter table public.slots drop column capacity;
    alter table public.slots alter column condition set not null;
    alter table public.slots
      add column capacity int generated always as (case condition when '2P' then 2 else 3 end) stored;
  end if;
end;
$$;

create table if not exists public.signups (
  id           uuid primary key default gen_random_uuid(),
  slot_id      uuid not null references public.slots (id) on delete cascade,
  first_name   text not null check (char_length(first_name) between 1 and 100),
  email        text not null check (
                 char_length(email) <= 254
                 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  status       text not null default 'booked'
               check (status in ('booked', 'confirmed', 'cancelled', 'no_show', 'completed')),
  cancel_token uuid default gen_random_uuid() unique,
  client_hash  text,
  reminded_at  timestamptz,
  created_at   timestamptz default now()
);

alter table public.signups add column if not exists reminded_at timestamptz;
alter table public.signups add column if not exists confirmation_sent_at timestamptz;
alter table public.signups add column if not exists final_reminded_at timestamptz;

-- Upgrades a database created when phone numbers were collected, and deletes them.
alter table public.signups drop column if exists phone;

create index if not exists signups_slot_id_idx on public.signups (slot_id);

-- A person holds one seat at a time and cannot return after taking part. The
-- index closes the race that the slot lock in book_slot cannot: two concurrent
-- bookings by the same person on different slots.
create unique index if not exists signups_one_per_email on public.signups (lower(email))
  where status in ('booked', 'confirmed', 'completed');

-- Supabase Auth lets anyone holding the public key register, and every registered
-- user gets the `authenticated` role. So `authenticated` alone must not unlock
-- participant data: access requires a row here as well.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- The Gmail mailer's secret. No API role can read it; copy it from the SQL Editor.
create table if not exists public.mailer_secret (
  secret uuid primary key default gen_random_uuid()
);

insert into public.mailer_secret (secret)
select gen_random_uuid()
where not exists (select 1 from public.mailer_secret);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

alter table public.slots       enable row level security;
alter table public.signups     enable row level security;
alter table public.admin_users enable row level security;
alter table public.mailer_secret enable row level security;

drop policy if exists slots_admin_all on public.slots;
create policy slots_admin_all on public.slots
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists signups_admin_all on public.signups;
create policy signups_admin_all on public.signups
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------

-- Never exposes capacity or seat counts: a slot is listed, or it is not.
create or replace function public.get_available_slots()
returns table (id uuid, start_time timestamptz, end_time timestamptz, room text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.start_time, s.end_time, s.room
  from public.slots s
  where s.is_active
    and s.start_time > now()
    and (select count(*) from public.signups su
         where su.slot_id = s.id and su.status in ('booked', 'confirmed')) < s.capacity
  order by s.start_time, s.id;
$$;

-- The version that took a phone number.
drop function if exists public.book_slot(uuid, text, text, text, text);

-- Raises SLOT_UNAVAILABLE, SLOT_FULL, ALREADY_BOOKED, TOO_MANY_REQUESTS or INVALID_INPUT.
create or replace function public.book_slot(
  p_slot_id     uuid,
  p_first_name  text,
  p_email       text,
  p_client_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot   public.slots%rowtype;
  v_email  text := lower(btrim(p_email));
  v_token  uuid;
begin
  if exists (select 1 from public.signups
             where client_hash = p_client_hash
               and created_at > now() - interval '60 seconds') then
    raise exception 'TOO_MANY_REQUESTS';
  end if;

  select * into v_slot from public.slots where id = p_slot_id for update;

  if not found or not v_slot.is_active or v_slot.start_time <= now() then
    raise exception 'SLOT_UNAVAILABLE';
  end if;

  if exists (select 1 from public.signups
             where lower(email) = v_email
               and status in ('booked', 'confirmed', 'completed')) then
    raise exception 'ALREADY_BOOKED';
  end if;

  if (select count(*) from public.signups
      where slot_id = p_slot_id and status in ('booked', 'confirmed')) >= v_slot.capacity then
    raise exception 'SLOT_FULL';
  end if;

  insert into public.signups (slot_id, first_name, email, client_hash)
  values (p_slot_id, btrim(p_first_name), v_email, p_client_hash)
  returning cancel_token into v_token;

  return jsonb_build_object(
    'start_time',   v_slot.start_time,
    'end_time',     v_slot.end_time,
    'room',         v_slot.room,
    'cancel_token', v_token
  );
exception
  when unique_violation then
    raise exception 'ALREADY_BOOKED';
  when check_violation or not_null_violation then
    raise exception 'INVALID_INPUT';
end;
$$;

-- Raises INVALID_TOKEN or CANNOT_CANCEL. Repeating a cancellation is harmless.
-- A started session cannot be cancelled, so a saved link cannot rewrite its record.
create or replace function public.cancel_booking(p_cancel_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_status text;
  v_slot   public.slots%rowtype;
begin
  select su.id, su.status into v_id, v_status
  from public.signups su
  where su.cancel_token = p_cancel_token
  for update;

  if not found then
    raise exception 'INVALID_TOKEN';
  end if;

  select s.* into v_slot
  from public.slots s
  join public.signups su on su.slot_id = s.id
  where su.id = v_id;

  if v_status <> 'cancelled' then
    if v_status not in ('booked', 'confirmed') or v_slot.start_time <= now() then
      raise exception 'CANNOT_CANCEL';
    end if;
    update public.signups set status = 'cancelled' where id = v_id;
  end if;

  return jsonb_build_object(
    'start_time', v_slot.start_time,
    'end_time',   v_slot.end_time,
    'room',       v_slot.room
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Mailer RPCs
-- ---------------------------------------------------------------------------

-- Raises FORBIDDEN. A confirmation and a 24-hour reminder go only to 'booked' people.
-- The 1-hour reminder also goes to people who have since confirmed; a walk-in has
-- no confirmation email on record, so gets nothing. Someone who books inside a
-- reminder's window skips that reminder.
create or replace function public.get_pending_emails(p_secret uuid)
returns table (
  id           uuid,
  kind         text,
  first_name   text,
  email        text,
  cancel_token uuid,
  start_time   timestamptz,
  end_time     timestamptz,
  room         text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.mailer_secret ms where ms.secret = p_secret) then
    raise exception 'FORBIDDEN';
  end if;

  return query
    select su.id,
           case
             when su.confirmation_sent_at is null then 'confirmation'
             when s.start_time <= now() + interval '1 hour' then 'final_reminder'
             else 'reminder'
           end,
           su.first_name, su.email, su.cancel_token, s.start_time, s.end_time, s.room
    from public.signups su
    join public.slots s on s.id = su.slot_id
    where s.start_time > now()
      and (
        (su.status = 'booked' and su.confirmation_sent_at is null)
        or (su.status = 'booked'
            and su.confirmation_sent_at is not null
            and su.reminded_at is null
            and s.start_time > now() + interval '1 hour'
            and s.start_time <= now() + interval '24 hours'
            and su.created_at < s.start_time - interval '24 hours')
        or (su.status in ('booked', 'confirmed')
            and su.confirmation_sent_at is not null
            and su.final_reminded_at is null
            and s.start_time <= now() + interval '1 hour'
            and su.created_at < s.start_time - interval '1 hour'))
    order by s.start_time, su.created_at;
end;
$$;

-- Raises FORBIDDEN.
create or replace function public.mark_email_sent(p_secret uuid, p_signup_id uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.mailer_secret ms where ms.secret = p_secret) then
    raise exception 'FORBIDDEN';
  end if;

  update public.signups su
  set confirmation_sent_at = case when p_kind = 'confirmation' then now() else su.confirmation_sent_at end,
      reminded_at          = case when p_kind = 'reminder' then now() else su.reminded_at end,
      final_reminded_at    = case when p_kind = 'final_reminder' then now() else su.final_reminded_at end
  where su.id = p_signup_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Supabase's default privileges grant new objects directly to anon and
-- authenticated, so revoking from PUBLIC alone would change nothing.
revoke all on public.slots, public.signups, public.admin_users, public.mailer_secret from public, anon, authenticated;
grant select, insert, update, delete on public.slots, public.signups to authenticated;

revoke all on function public.is_admin() from public, anon, authenticated;
revoke all on function public.get_available_slots() from public, anon, authenticated;
revoke all on function public.book_slot(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.cancel_booking(uuid) from public, anon, authenticated;
revoke all on function public.get_pending_emails(uuid) from public, anon, authenticated;
revoke all on function public.mark_email_sent(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.is_admin() to authenticated;
-- authenticated too: a researcher signed in on the same origin hits the public page with that role.
grant execute on function public.get_available_slots() to anon, authenticated;
grant execute on function public.book_slot(uuid, text, text, text) to anon, authenticated;
grant execute on function public.cancel_booking(uuid) to anon, authenticated;
-- anon because the mailer calls with the public key; the secret is what protects these.
grant execute on function public.get_pending_emails(uuid) to anon;
grant execute on function public.mark_email_sent(uuid, uuid, text) to anon;
