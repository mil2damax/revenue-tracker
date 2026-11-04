-- ============================================================================
-- Seed roles + per-hotel access by email. Idempotent.
--
-- PREREQUISITE: the 4 auth users must already exist (create them in the
-- Supabase dashboard: Authentication > Users > Add user, with email+password).
-- The on_auth_user_created trigger will have created their profiles rows (as
-- 'manager'); this migration promotes the owner and maps each manager's hotel.
--
-- Safe to re-run: if you add users later, re-apply the same statements in the
-- SQL editor and they'll converge without duplicating anything.
-- ============================================================================

-- Owner: sees all hotels
update public.profiles
   set role = 'owner'
 where email = 'milan@milkamhospitality.com';

-- Managers: one hotel each. `email` comes from the profiles row created at signup.
insert into public.user_properties (user_id, property)
select p.user_id, v.property
from public.profiles p
join (values
  ('rdurm.gm@milkamhospitality.com', 'RDURM'),   -- Tru Wake Forest
  ('rdutt.gm@milkamhospitality.com', 'RDUTT'),   -- Home2 Suites Raleigh North
  ('wkfcw@milkamhospitality.com',    'WKFCW')    -- Candlewood Suites
) as v(email, property) on v.email = p.email
on conflict (user_id, property) do nothing;

-- Make sure the mapped managers are role 'manager' (not accidentally owner)
update public.profiles
   set role = 'manager'
 where email in (
   'rdurm.gm@milkamhospitality.com',
   'rdutt.gm@milkamhospitality.com',
   'wkfcw@milkamhospitality.com'
 );
