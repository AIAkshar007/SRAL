-- SRAL LIMS: role helpers, auto-first-admin bootstrap, and row-level security.
--
-- Access model: every LIMS login is a normal Supabase Auth user (auth.users), separate from the
-- public website (which has no logins at all) and from Prachar (separate "prachar" schema, separate
-- staff_profile table). A new auth user has no lims.staff_profile row and so no access anywhere in
-- this schema until one exists — see lims.bootstrap() in 03_functions.sql, which creates it on first
-- sign-in and makes the very first person to ever sign in an admin automatically (see trigger below).
-- Everyone after that starts as 'pending' until an admin sets their role.

create or replace function lims.current_role()
returns lims.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select role from lims.staff_profile where id = auth.uid() and active;
$$;
revoke all on function lims.current_role() from public, anon, authenticated;
grant execute on function lims.current_role() to authenticated;

create or replace function lims.has_role(p_roles lims.staff_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(lims.current_role() = any(p_roles), false);
$$;
revoke all on function lims.has_role(lims.staff_role[]) from public, anon, authenticated;
grant execute on function lims.has_role(lims.staff_role[]) to authenticated;

-- The first person ever to sign in becomes admin automatically; everyone after starts 'pending'
-- and needs an existing admin to activate them from the Users screen. Safe because it only ever
-- fires once per database (checks staff_profile is empty), and staff_profile rows are only ever
-- created by lims.bootstrap(), a SECURITY DEFINER function — never directly by the app.
create or replace function lims.first_user_is_admin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from lims.staff_profile) = 0 then
    new.role := 'admin';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_first_user_admin on lims.staff_profile;
create trigger trg_first_user_admin before insert on lims.staff_profile
  for each row execute function lims.first_user_is_admin();

-- ---------- row-level security ----------
alter table lims.staff_profile enable row level security;
alter table lims.clients       enable row level security;
alter table lims.test_catalog  enable row level security;
alter table lims.samples       enable row level security;
alter table lims.sample_tests  enable row level security;
alter table lims.certificates  enable row level security;
alter table lims.audit_log     enable row level security;

-- staff_profile: everyone signed in can see the staff list (small lab, names only matter for
-- assignment pickers); only admins can change role/active; your own name you can edit yourself.
grant select on lims.staff_profile to authenticated;
create policy staff_profile_select on lims.staff_profile for select to authenticated using (true);
grant update (full_name) on lims.staff_profile to authenticated;
create policy staff_profile_update_self on lims.staff_profile for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- role/active changes go through lims.set_staff_role() (SECURITY DEFINER), not direct table writes.

-- test_catalog: read-only to every active staff member; maintained by migration/seed, not the app, for v1.
grant select on lims.test_catalog to authenticated;
create policy test_catalog_select on lims.test_catalog for select to authenticated
  using (lims.current_role() is not null);

-- clients: any active staff member can read/create; only admin/reviewer can edit.
grant select, insert on lims.clients to authenticated;
grant update on lims.clients to authenticated;
create policy clients_select on lims.clients for select to authenticated
  using (lims.current_role() is not null);
create policy clients_insert on lims.clients for insert to authenticated
  with check (lims.has_role(array['frontdesk','reviewer','admin']::lims.staff_role[]));
create policy clients_update on lims.clients for update to authenticated
  using (lims.has_role(array['reviewer','admin']::lims.staff_role[]));

-- samples / sample_tests / certificates: read is open to any active staff member (small lab,
-- everyone needs to see the worklist); every write goes through a workflow RPC in 03_functions.sql,
-- which runs as the table owner (security definer) and enforces the real role + state-machine rules,
-- so there is no direct insert/update/delete grant here beyond select.
grant select on lims.samples to authenticated;
create policy samples_select on lims.samples for select to authenticated
  using (lims.current_role() is not null);

grant select on lims.sample_tests to authenticated;
create policy sample_tests_select on lims.sample_tests for select to authenticated
  using (lims.current_role() is not null);

grant select on lims.certificates to authenticated;
create policy certificates_select on lims.certificates for select to authenticated
  using (lims.current_role() is not null);

-- audit_log: reviewers and admins only (it can reveal who entered a value before it was corrected).
grant select on lims.audit_log to authenticated;
create policy audit_log_select on lims.audit_log for select to authenticated
  using (lims.has_role(array['reviewer','admin']::lims.staff_role[]));
