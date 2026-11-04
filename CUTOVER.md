# Catbird Auth Cutover Runbook

Turns off the client-side PIN and turns on real logins (email + password, optional 2FA)
with per-hotel access. Project ref: **ltbjavxegskmhyjqpext**. Branch with all the code: **security-auth**.

The whole point of the staging below: **the live site keeps working until the very last step.**
Phase A is invisible to the running (PIN) app. Phase B is the only breaking change, and it's
reversible in ~1 minute.

Dashboard shortcuts:
- Users:    https://supabase.com/dashboard/project/ltbjavxegskmhyjqpext/auth/users
- MFA:      https://supabase.com/dashboard/project/ltbjavxegskmhyjqpext/auth/providers  (→ Multi-Factor Authentication)
- SQL:      https://supabase.com/dashboard/project/ltbjavxegskmhyjqpext/sql/new

---

## Pre-flight (do once, confirm with me)

1. Make sure you're on the branch and it's clean:
   ```bash
   git checkout security-auth && git status
   ```
2. See exactly which migrations `db push` would apply (should list ONLY `20261104130000_access_control`
   as new — plus any STR ones if they weren't pushed yet). **Stop and tell me what it shows before pushing.**
   ```bash
   supabase migration list
   ```

---

## Phase A — foundation (SAFE; the PIN app keeps working the whole time)

### A1. Apply the access-control migration
Creates `profiles`, `user_properties`, the `is_owner()` / `can_see()` helpers, and the
signup trigger. Touches **none** of the existing read policies, so the live app is unaffected.
```bash
supabase db push
```
Rollback: `drop table public.user_properties, public.profiles cascade;` plus
`drop function public.can_see(text); drop function public.is_owner(); drop function public.handle_new_user();`

### A2. Create the 4 login accounts (dashboard → Authentication → Users → Add user)
Tick **Auto Confirm User** for each. Password = min 8 chars.
| Email | Who |
|---|---|
| milan@milkamhospitality.com | you — owner (all hotels) |
| rdurm.gm@milkamhospitality.com | Tru Wake Forest (RDURM) |
| rdutt.gm@milkamhospitality.com | Home2 Raleigh North (RDUTT) |
| wkfcw@milkamhospitality.com | Candlewood (WKFCW) |

The signup trigger auto-creates a `profiles` row (role `manager`) for each.

### A3. Assign roles + hotels
Paste the contents of `supabase/_cutover_hold/20261104150000_seed_access.sql` into the SQL editor and run it.
It promotes you to `owner` and maps each manager to their one hotel. Idempotent — safe to re-run.

Verify:
```sql
select p.email, p.role, array_agg(up.property) as hotels
from public.profiles p
left join public.user_properties up using (user_id)
group by p.email, p.role order by p.role;
```
Expect: milan = owner (hotels {NULL}); the three managers = manager with their single code.

### A4. Deploy the owner-admin function (for in-app password resets)
```bash
supabase functions deploy admin-users
```
(No secrets to set — it uses the built-in SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY.)

### A5. Enable TOTP 2FA on the project
Dashboard → Authentication → Multi-Factor Authentication → enable **TOTP (App Authenticator)**.
(Needed for the in-app "Set up 2FA" to work. config.toml only covers local dev.)

**After Phase A: the live site is still the PIN app and still works. Nothing visible changed.**

---

## Phase B — the cutover (the ONE breaking step; do B1+B2 back-to-back)

This is the only moment the old anon-read behavior ends. Do it when you can watch it for 5 minutes.

### B1. Restore the lock migration and apply it
Locks every table to `can_see()` — after this, anonymous reads return nothing, so the app
only works for logged-in users.
```bash
git mv supabase/_cutover_hold/20261104160000_rls_per_hotel.sql supabase/migrations/20261104160000_rls_per_hotel.sql
git commit -m "Cutover: restore per-hotel RLS lock migration"
supabase db push
```

### B2. Deploy the auth frontend (merge to main → GitHub Pages redeploys)
```bash
git checkout main && git merge security-auth && git push
```

### B3. Verify (hard refresh the live site)
- Login screen appears (no PIN pad).
- Log in as **milan@** → see all 3 hotels.
- Log in as each **manager** → see only their hotel; the others are gone.
- Account menu → Change password works; owner → Manage users lists everyone; Set up 2FA shows a QR.

---

## Rollback for Phase B (fast, if anything looks wrong)

1. Frontend back to PIN:
   ```bash
   git checkout main && git revert --no-edit <merge-commit> && git push
   ```
2. Re-open reads (run in SQL editor) — restores anon read on all tables:
   ```sql
   do $$ declare t record; begin
     for t in select tablename from pg_tables where schemaname='public'
              and tablename not in ('profiles','user_properties') loop
       execute format('drop policy if exists "hotel read" on public.%I', t.tablename);
       execute format('drop policy if exists "owner read" on public.%I', t.tablename);
       execute format('create policy "anon read" on public.%I for select using (true)', t.tablename);
     end loop;
   end $$;
   ```
(Phase A objects can stay — they're invisible to the PIN app.)

---

## Deferred to after cutover (not blocking)

- **Medallia**: `upload-medallia.ps1` still uses the anon key to insert surveys. The lock migration
  intentionally leaves the medallia_surveys anon-insert policy in place, so the script keeps working.
  Follow-up: move it to a service-role edge function, then drop that anon-insert policy.
- **Retire the PIN path**: once stable, delete the `verify-pin` edge function + PIN_* secrets, and
  remove the dead `VERIFY_PIN_URL` const from index.html.
