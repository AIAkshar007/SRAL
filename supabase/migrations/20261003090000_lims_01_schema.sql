-- SRAL LIMS: core schema (lives in the same Supabase project as the public website and Prachar,
-- in its own "lims" schema, isolated from both by grants + row-level security).
-- Applied to project SRAL (jbuhflpfapdhwpgnpbkm).

create schema if not exists lims;
comment on schema lims is 'Sadguru Research & Analysis Laboratory — internal LIMS (sral.foodtesting.com). Not exposed to anon.';
revoke all on schema lims from public, anon, authenticated;
grant usage on schema lims to authenticated;
grant usage on schema lims to service_role;

-- ---------- enums ----------
do $$ begin
  create type lims.staff_role as enum ('pending', 'frontdesk', 'analyst', 'reviewer', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lims.sample_group as enum ('water', 'food');
exception when duplicate_object then null; end $$;

do $$ begin
  -- received: logged in, nothing tested yet · in_testing: at least one result entered or assigned
  -- under_review: every assigned test has a result awaiting review · approved: every test reviewed+approved
  -- reported: a certificate has been issued · rejected: the sample itself was rejected (contamination, short volume, etc.)
  -- on_hold: paused (awaiting client instruction, payment, etc.)
  create type lims.sample_status as enum ('received', 'in_testing', 'under_review', 'approved', 'reported', 'rejected', 'on_hold');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lims.test_status as enum ('pending', 'entered', 'reviewed', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

-- ---------- atomic sequence numbers (lims_number, certificate_number) ----------
create table if not exists lims.counters (
  key   text primary key,
  value bigint not null default 0
);
revoke all on lims.counters from public, anon, authenticated;

create or replace function lims.next_number(p_key text)
returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into lims.counters (key, value) values (p_key, 1)
  on conflict (key) do update set value = lims.counters.value + 1
  returning value;
$$;
revoke all on function lims.next_number(text) from public, anon, authenticated;

-- ---------- staff ----------
create table if not exists lims.staff_profile (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null,
  role       lims.staff_role not null default 'pending',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_profile_name_len check (char_length(full_name) between 1 and 120)
);
comment on table lims.staff_profile is 'One row per LIMS login (auth.users), separate from the public website and from Prachar.';
revoke all on lims.staff_profile from public, anon, authenticated;

-- ---------- clients (who the sample belongs to) ----------
create table if not exists lims.clients (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  contact_name text,
  phone        text,
  email        text,
  address      text,
  gstin        text,
  notes        text,
  created_by   uuid references lims.staff_profile (id),
  created_at   timestamptz not null default now(),
  constraint clients_name_len check (char_length(name) between 2 and 200),
  constraint clients_phone_fmt check (phone is null or phone ~ '^\+?[0-9 ()-]{6,20}$'),
  constraint clients_email_fmt check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
revoke all on lims.clients from public, anon, authenticated;

-- ---------- test catalog (the parameters SRAL offers, matching the public site's 12 categories) ----------
create table if not exists lims.test_catalog (
  id                  uuid primary key default gen_random_uuid(),
  category_slug       text not null,       -- matches foodwatertesting.com category slugs, e.g. 'drinking-water-testing'
  category_label      text not null,       -- e.g. 'Drinking water (IS 10500)'
  sample_group        lims.sample_group not null,
  parameter_name       text not null,
  method               text,
  unit                 text,
  permissible_limit    text,                -- kept as text: limits are often ranges or "Absent/100ml", not single numbers
  permissible_limit_lo numeric,              -- numeric bound, when the limit is a simple min/max (used for auto in/out-of-limit flagging)
  permissible_limit_hi numeric,
  default_turnaround_days int not null default 5,
  active                boolean not null default true,
  sort_order            int not null default 0,
  constraint test_catalog_name_len check (char_length(parameter_name) between 1 and 160)
);
comment on table lims.test_catalog is 'The parameter list SRAL tests for, seeded from the public site''s 12 service categories.';
revoke all on lims.test_catalog from public, anon, authenticated;
create index if not exists test_catalog_category_idx on lims.test_catalog (category_slug);

-- ---------- samples ----------
create table if not exists lims.samples (
  id                 uuid primary key default gen_random_uuid(),
  lims_number        text not null unique,          -- e.g. SRAL/WAT/2026/000123
  client_id          uuid not null references lims.clients (id),
  sample_group       lims.sample_group not null,
  category_slug      text,                            -- predominant category, for quick filtering (a sample can carry tests from more than one)
  description        text not null,                   -- what the sample is, e.g. "Borewell water, Ground floor"
  matrix             text,                              -- e.g. "Groundwater", "Packaged milk", free text
  collected_at       timestamptz,
  collected_by       text,                               -- who physically collected it (may not be a staff login)
  received_at        timestamptz not null default now(),
  received_by        uuid references lims.staff_profile (id),
  condition_on_receipt text,
  container_type       text,
  quantity              text,
  notes                 text,
  status                lims.sample_status not null default 'received',
  due_date              date,
  created_by            uuid references lims.staff_profile (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint samples_description_len check (char_length(description) between 2 and 300),
  constraint samples_notes_len check (coalesce(char_length(notes), 0) <= 2000)
);
comment on table lims.samples is 'One row per physical sample accessioned at the lab.';
revoke all on lims.samples from public, anon, authenticated;
create index if not exists samples_status_idx on lims.samples (status);
create index if not exists samples_client_idx on lims.samples (client_id);
create index if not exists samples_created_at_idx on lims.samples (created_at desc);

-- ---------- sample_tests (the worklist: one row per parameter assigned to a sample) ----------
create table if not exists lims.sample_tests (
  id               uuid primary key default gen_random_uuid(),
  sample_id        uuid not null references lims.samples (id) on delete cascade,
  test_catalog_id  uuid not null references lims.test_catalog (id),
  status           lims.test_status not null default 'pending',
  assigned_analyst uuid references lims.staff_profile (id),
  assigned_by      uuid references lims.staff_profile (id),
  assigned_at      timestamptz,
  result_value     text,
  result_unit      text,
  within_limit     boolean,                     -- null = not yet determinable (no numeric limit, or no result yet)
  instrument       text,
  tested_at        timestamptz,
  entered_by       uuid references lims.staff_profile (id),
  entered_at       timestamptz,
  review_comment   text,
  reviewed_by      uuid references lims.staff_profile (id),
  reviewed_at      timestamptz,
  approved_by      uuid references lims.staff_profile (id),
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint sample_tests_one_per_sample unique (sample_id, test_catalog_id),
  constraint sample_tests_result_len check (coalesce(char_length(result_value), 0) <= 300),
  constraint sample_tests_comment_len check (coalesce(char_length(review_comment), 0) <= 2000)
);
comment on table lims.sample_tests is 'The worklist: one row per parameter assigned to a sample, carrying its own result and review.';
revoke all on lims.sample_tests from public, anon, authenticated;
create index if not exists sample_tests_sample_idx on lims.sample_tests (sample_id);
create index if not exists sample_tests_analyst_idx on lims.sample_tests (assigned_analyst);
create index if not exists sample_tests_status_idx on lims.sample_tests (status);

-- ---------- certificates (Certificate of Analysis) ----------
create table if not exists lims.certificates (
  id                  uuid primary key default gen_random_uuid(),
  sample_id           uuid not null references lims.samples (id),
  certificate_number  text not null unique,     -- e.g. SRAL/COA/2026/000045
  issued_by           uuid references lims.staff_profile (id),
  issued_at           timestamptz not null default now(),
  voided_at           timestamptz,
  voided_by           uuid references lims.staff_profile (id),
  void_reason         text
);
comment on table lims.certificates is 'A certificate is a numbered, timestamped record that a report was issued for a sample; the PDF itself is generated on demand from the sample''s approved results, not stored.';
revoke all on lims.certificates from public, anon, authenticated;
create index if not exists certificates_sample_idx on lims.certificates (sample_id);

-- ---------- audit log (append-only; every workflow RPC writes here itself) ----------
create table if not exists lims.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid references lims.staff_profile (id),
  table_name text not null,
  row_id     uuid not null,
  action     text not null,
  detail     jsonb,
  constraint audit_action_chk check (action in (
    'sample_created', 'test_assigned', 'result_entered', 'result_reviewed', 'result_approved',
    'result_rejected', 'sample_status_changed', 'certificate_issued', 'certificate_voided',
    'staff_role_changed', 'staff_profile_created'
  ))
);
comment on table lims.audit_log is 'Append-only. Every workflow-changing RPC writes its own row here; never edited or deleted from the app.';
revoke all on lims.audit_log from public, anon, authenticated;
create index if not exists audit_log_row_idx on lims.audit_log (table_name, row_id, at desc);
create index if not exists audit_log_at_idx on lims.audit_log (at desc);
