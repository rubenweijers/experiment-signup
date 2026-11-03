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
  -- The group size, not the sign-up limit, so it cannot drift from condition.
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
alter table public.signups add column if not exists session_cancelled_at timestamptz;
alter table public.signups add column if not exists cancellation_sent_at timestamptz;
alter table public.signups add column if not exists session_confirmed_at timestamptz;
alter table public.signups add column if not exists session_confirmation_sent_at timestamptz;
alter table public.signups add column if not exists released_at timestamptz;

-- Upgrades a database created when phone numbers were collected, and deletes them.
alter table public.signups drop column if exists phone;

create index if not exists signups_slot_id_idx on public.signups (slot_id);

-- A person may sign up for several sessions, but holds one seat per session, is
-- confirmed for one session at a time and cannot return after taking part.
drop index if exists public.signups_one_per_email;
create unique index if not exists signups_one_seat_per_slot on public.signups (slot_id, lower(email))
  where status in ('booked', 'confirmed', 'completed');
create unique index if not exists signups_one_session_per_email on public.signups (lower(email))
  where status in ('confirmed', 'completed');

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

-- Never exposes capacity or seat counts: a slot is listed, or it is not. A slot takes
-- 6 sign-ups in either condition, because people sign up for several, and leaves the
-- list once it has 6 or its group is confirmed. book_slots applies the same two limits.
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
         where su.slot_id = s.id and su.status in ('booked', 'confirmed')) < 6
    and (select count(*) from public.signups su
         where su.slot_id = s.id and su.status = 'confirmed') < s.capacity
  order by s.start_time, s.id;
$$;

-- The versions that took a phone number and a single slot.
drop function if exists public.book_slot(uuid, text, text, text, text);
drop function if exists public.book_slot(uuid, text, text, text);

-- Raises SLOT_UNAVAILABLE, SLOT_FULL, ALREADY_SIGNED_UP, ALREADY_BOOKED, TOO_MANY_REQUESTS
-- or INVALID_INPUT. All the sign-ups are saved, or none of them.
create or replace function public.book_slots(
  p_slot_ids    uuid[],
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
  v_slot     public.slots%rowtype;
  v_slot_id  uuid;
  v_email    text := lower(btrim(p_email));
  v_token    uuid;
  v_bookings jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(p_slot_ids), 0) = 0 then
    raise exception 'INVALID_INPUT';
  end if;

  if exists (select 1 from public.signups
             where client_hash = p_client_hash
               and created_at > now() - interval '60 seconds') then
    raise exception 'TOO_MANY_REQUESTS';
  end if;

  if exists (select 1 from public.signups
             where lower(email) = v_email
               and status in ('confirmed', 'completed')) then
    raise exception 'ALREADY_BOOKED';
  end if;

  -- Locks in a fixed order, so two people choosing the same slots cannot deadlock.
  for v_slot_id in select distinct unnest(p_slot_ids) order by 1 loop
    select * into v_slot from public.slots where id = v_slot_id for update;

    if not found or not v_slot.is_active or v_slot.start_time <= now() then
      raise exception 'SLOT_UNAVAILABLE';
    end if;

    if exists (select 1 from public.signups
               where slot_id = v_slot_id
                 and lower(email) = v_email
                 and status in ('booked', 'confirmed', 'completed')) then
      raise exception 'ALREADY_SIGNED_UP';
    end if;

    if (select count(*) from public.signups
        where slot_id = v_slot_id and status in ('booked', 'confirmed')) >= 6
       or (select count(*) from public.signups
           where slot_id = v_slot_id and status = 'confirmed') >= v_slot.capacity then
      raise exception 'SLOT_FULL';
    end if;

    insert into public.signups (slot_id, first_name, email, client_hash)
    values (v_slot_id, btrim(p_first_name), v_email, p_client_hash)
    returning cancel_token into v_token;

    v_bookings := v_bookings || jsonb_build_object(
      'start_time',   v_slot.start_time,
      'end_time',     v_slot.end_time,
      'room',         v_slot.room,
      'cancel_token', v_token
    );
  end loop;

  return v_bookings;
exception
  when unique_violation then
    raise exception 'ALREADY_SIGNED_UP';
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
-- Researcher RPCs
-- ---------------------------------------------------------------------------

-- Raises FORBIDDEN, SLOT_NOT_FOUND or CANNOT_CANCEL. Closes the slot and frees its
-- seats; the mailer then tells the people who held them. The slot lock makes a
-- concurrent book_slots either land before this, and be cancelled, or fail.
create or replace function public.cancel_session(p_slot_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN';
  end if;

  select s.start_time into v_start from public.slots s where s.id = p_slot_id for update;

  if not found then
    raise exception 'SLOT_NOT_FOUND';
  end if;
  if v_start <= now() then
    raise exception 'CANNOT_CANCEL';
  end if;

  update public.slots set is_active = false where id = p_slot_id;

  update public.signups
  set status = 'cancelled', session_cancelled_at = now()
  where slot_id = p_slot_id and status in ('booked', 'confirmed');
end;
$$;

-- The version that confirmed everyone in a slot.
drop function if exists public.confirm_session(uuid);

-- Raises FORBIDDEN, SLOT_NOT_FOUND, CANNOT_CONFIRM, INVALID_SELECTION or WRONG_GROUP_SIZE.
-- Invites exactly the people who fill the group; the mailer then tells them. Their
-- sign-ups for other sessions give up those seats without an email, because the
-- confirmation already says so. Anyone not invited stays 'booked', as a waiting list.
-- Participants the researcher added are confirmed already, so they count towards the
-- group but get no email.
create or replace function public.confirm_session(p_slot_id uuid, p_signup_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot    public.slots%rowtype;
  v_invited int;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_slot from public.slots s where s.id = p_slot_id for update;

  if not found then
    raise exception 'SLOT_NOT_FOUND';
  end if;
  if v_slot.start_time <= now() then
    raise exception 'CANNOT_CONFIRM';
  end if;

  select count(*) into v_invited from public.signups su
  where su.id = any (p_signup_ids) and su.slot_id = p_slot_id and su.status = 'booked';

  if v_invited = 0 or v_invited <> cardinality(p_signup_ids) then
    raise exception 'INVALID_SELECTION';
  end if;
  if v_invited + (select count(*) from public.signups su
                  where su.slot_id = p_slot_id and su.status = 'confirmed') <> v_slot.capacity then
    raise exception 'WRONG_GROUP_SIZE';
  end if;

  update public.signups su
  set status = 'confirmed', session_confirmed_at = now()
  where su.id = any (p_signup_ids);

  update public.signups other
  set status = 'cancelled', released_at = now()
  where other.status = 'booked'
    and other.slot_id <> p_slot_id
    and lower(other.email) in (select lower(su.email) from public.signups su
                               where su.slot_id = p_slot_id and su.status = 'confirmed');
end;
$$;

-- ---------------------------------------------------------------------------
-- Mailer RPCs
-- ---------------------------------------------------------------------------

-- Raises FORBIDDEN. The 'confirmation' kind is the provisional sign-up email; the mailer
-- merges one person's into a single email. 'session_confirmed' follows confirm_session.
-- Both reminders go only to people who got that email: the first at 18:00 the day before,
-- the second 1 hour before. Someone confirmed after a reminder's time skips that reminder.
-- A session cancellation goes to everyone cancel_session removed, added by the researcher or not.
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
             when su.status = 'cancelled' then 'session_cancelled'
             when su.session_confirmed_at is not null and su.session_confirmation_sent_at is null then 'session_confirmed'
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
        or (su.status = 'confirmed'
            and su.session_confirmed_at is not null
            and su.session_confirmation_sent_at is null)
        or (su.status = 'confirmed'
            and su.session_confirmation_sent_at is not null
            and su.reminded_at is null
            and s.start_time > now() + interval '1 hour'
            and now() >= (((s.start_time at time zone 'Europe/Amsterdam')::date - 1) + time '18:00') at time zone 'Europe/Amsterdam'
            and su.session_confirmed_at < (((s.start_time at time zone 'Europe/Amsterdam')::date - 1) + time '18:00') at time zone 'Europe/Amsterdam')
        or (su.status = 'confirmed'
            and su.session_confirmation_sent_at is not null
            and su.final_reminded_at is null
            and s.start_time <= now() + interval '1 hour'
            and su.session_confirmed_at < s.start_time - interval '1 hour')
        or (su.status = 'cancelled'
            and su.session_cancelled_at is not null
            and su.cancellation_sent_at is null))
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
      session_confirmation_sent_at = case when p_kind = 'session_confirmed' then now() else su.session_confirmation_sent_at end,
      reminded_at          = case when p_kind = 'reminder' then now() else su.reminded_at end,
      final_reminded_at    = case when p_kind = 'final_reminder' then now() else su.final_reminded_at end,
      cancellation_sent_at = case when p_kind = 'session_cancelled' then now() else su.cancellation_sent_at end
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
revoke all on function public.book_slots(uuid[], text, text, text) from public, anon, authenticated;
revoke all on function public.cancel_booking(uuid) from public, anon, authenticated;
revoke all on function public.cancel_session(uuid) from public, anon, authenticated;
revoke all on function public.confirm_session(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.get_pending_emails(uuid) from public, anon, authenticated;
revoke all on function public.mark_email_sent(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.cancel_session(uuid) to authenticated;
grant execute on function public.confirm_session(uuid, uuid[]) to authenticated;
-- authenticated too: a researcher signed in on the same origin hits the public page with that role.
grant execute on function public.get_available_slots() to anon, authenticated;
grant execute on function public.book_slots(uuid[], text, text, text) to anon, authenticated;
grant execute on function public.cancel_booking(uuid) to anon, authenticated;
-- anon because the mailer calls with the public key; the secret is what protects these.
grant execute on function public.get_pending_emails(uuid) to anon;
grant execute on function public.mark_email_sent(uuid, uuid, text) to anon;
