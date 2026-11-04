-- ============================================================================
-- Access control foundation for Catbird — role + per-hotel model.
--   owner   : sees every hotel (role, not a hardcoded account — grantable to
--             others later by setting their role to 'owner')
--   manager : sees only the hotel(s) mapped to them in user_properties
--
-- This migration ONLY adds the access model + helper functions. It does NOT
-- change any existing table's RLS yet (that's the next, separate migration),
-- so applying this is safe and invisible to the running app.
-- ============================================================================

-- 1. Profile per auth user, carrying the role ------------------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'manager' check (role in ('owner','manager')),
  created_at timestamptz not null default now()
);

-- 2. Manager -> hotel mapping (owners need no rows; they see all) -----------
--    `property` holds the hotel code (WKFCW, RDURM, HDUTT, ...), matching the
--    `property` / `hotel_code` columns on the data tables.
create table if not exists public.user_properties (
  user_id  uuid not null references auth.users(id) on delete cascade,
  property text not null,
  primary key (user_id, property)
);

-- 3. Helper functions (SECURITY DEFINER so they can read profiles under RLS) -
create or replace function public.is_owner()
  returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role = 'owner'
  );
$$;

-- True if the current user is an owner, or a manager mapped to `code`.
create or replace function public.can_see(code text)
  returns boolean
  language sql stable security definer set search_path = public
as $$
  select public.is_owner() or exists (
    select 1 from public.user_properties
    where user_id = auth.uid() and property = code
  );
$$;

-- 4. Auto-create a profile when a new auth user signs up -------------------
--    New users default to 'manager' with no hotel mapping (so they see
--    nothing until an owner grants them a hotel or promotes them).
create or replace function public.handle_new_user()
  returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 5. RLS on the access tables themselves -----------------------------------
--    A user may read their own profile + hotel mappings; owners may read all.
--    Writes happen via the service role (edge functions / admin), which
--    bypasses RLS — so no write policies are granted to normal users here.
alter table public.profiles        enable row level security;
alter table public.user_properties enable row level security;

drop policy if exists "profiles self or owner read" on public.profiles;
create policy "profiles self or owner read" on public.profiles
  for select using (user_id = auth.uid() or public.is_owner());

drop policy if exists "user_properties self or owner read" on public.user_properties;
create policy "user_properties self or owner read" on public.user_properties
  for select using (user_id = auth.uid() or public.is_owner());
