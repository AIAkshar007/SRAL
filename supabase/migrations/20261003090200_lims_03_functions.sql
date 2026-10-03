-- SRAL LIMS: workflow functions. Every write to samples/sample_tests/certificates/staff_profile
-- goes through one of these; each enforces the real role + state-machine rules and writes its own
-- audit_log row, so the audit trail can never be skipped by a UI bug.

create or replace function lims._log(p_table text, p_row uuid, p_action text, p_detail jsonb default null)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into lims.audit_log (actor, table_name, row_id, action, detail)
  values (auth.uid(), p_table, p_row, p_action, p_detail);
$$;
revoke all on function lims._log(text, uuid, text, jsonb) from public, anon, authenticated;

-- ---------- bootstrap: called once on every sign-in; creates the profile on first sign-in ----------
create or replace function lims.bootstrap(p_full_name text default null)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile lims.staff_profile;
  v_email   text;
begin
  select id into v_profile from lims.staff_profile where id = auth.uid();
  if not found then
    select email into v_email from auth.users where id = auth.uid();
    insert into lims.staff_profile (id, full_name)
    values (auth.uid(), coalesce(nullif(btrim(p_full_name), ''), split_part(coalesce(v_email, 'New user'), '@', 1)))
    returning * into v_profile;
    perform lims._log('staff_profile', v_profile.id, 'staff_profile_created', jsonb_build_object('role', v_profile.role));
  else
    select * into v_profile from lims.staff_profile where id = auth.uid();
  end if;
  return json_build_object(
    'id', v_profile.id, 'full_name', v_profile.full_name, 'role', v_profile.role, 'active', v_profile.active
  );
end;
$$;
revoke all on function lims.bootstrap(text) from public, anon, authenticated;
grant execute on function lims.bootstrap(text) to authenticated;

-- ---------- accession a sample ----------
create or replace function lims.accession_sample(
  p_client_id      uuid,
  p_sample_group   lims.sample_group,
  p_category_slug  text,
  p_description    text,
  p_matrix         text default null,
  p_collected_at   timestamptz default null,
  p_collected_by   text default null,
  p_condition      text default null,
  p_container_type text default null,
  p_quantity       text default null,
  p_notes          text default null,
  p_test_ids       uuid[] default '{}'
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sample   lims.samples;
  v_prefix   text;
  v_seq      bigint;
  v_tat      int;
  v_test_id  uuid;
begin
  if not lims.has_role(array['frontdesk','reviewer','admin']::lims.staff_role[]) then
    raise exception 'Only front desk, reviewer or admin accounts can log in a new sample.' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) < 2 then
    raise exception 'Describe the sample (what it is, where it was taken).' using errcode = 'P0001';
  end if;
  if not exists (select 1 from lims.clients where id = p_client_id) then
    raise exception 'Select a client before logging the sample.' using errcode = 'P0001';
  end if;

  v_prefix := case p_sample_group when 'water' then 'WAT' else 'FOO' end;
  v_seq := lims.next_number('sample_' || v_prefix || '_' || to_char(now(), 'YYYY'));

  -- turnaround: the longest default turnaround among the requested tests, falling back to the
  -- site's standard 3-5 working day promise (5, the safe upper bound) when nothing is picked yet.
  select coalesce(max(default_turnaround_days), 5) into v_tat
  from lims.test_catalog where id = any(p_test_ids);

  insert into lims.samples (
    lims_number, client_id, sample_group, category_slug, description, matrix,
    collected_at, collected_by, received_by, condition_on_receipt, container_type, quantity, notes,
    due_date, created_by
  ) values (
    'SRAL/' || v_prefix || '/' || to_char(now(), 'YYYY') || '/' || lpad(v_seq::text, 6, '0'),
    p_client_id, p_sample_group, nullif(btrim(coalesce(p_category_slug, '')), ''), btrim(p_description), nullif(btrim(coalesce(p_matrix, '')), ''),
    p_collected_at, nullif(btrim(coalesce(p_collected_by, '')), ''), auth.uid(), nullif(btrim(coalesce(p_condition, '')), ''),
    nullif(btrim(coalesce(p_container_type, '')), ''), nullif(btrim(coalesce(p_quantity, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''),
    (current_date + make_interval(days => v_tat)), auth.uid()
  ) returning * into v_sample;

  foreach v_test_id in array coalesce(p_test_ids, '{}') loop
    insert into lims.sample_tests (sample_id, test_catalog_id) values (v_sample.id, v_test_id)
    on conflict (sample_id, test_catalog_id) do nothing;
  end loop;

  perform lims._log('samples', v_sample.id, 'sample_created', jsonb_build_object('lims_number', v_sample.lims_number, 'test_count', coalesce(array_length(p_test_ids, 1), 0)));
  return json_build_object('ok', true, 'id', v_sample.id, 'lims_number', v_sample.lims_number);
end;
$$;
revoke all on function lims.accession_sample(uuid, lims.sample_group, text, text, text, timestamptz, text, text, text, text, text, uuid[]) from public, anon, authenticated;
grant execute on function lims.accession_sample(uuid, lims.sample_group, text, text, text, timestamptz, text, text, text, text, text, uuid[]) to authenticated;

-- ---------- add a test to an already-logged sample (e.g. client asks for one more parameter) ----------
create or replace function lims.add_sample_test(p_sample_id uuid, p_test_catalog_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status lims.sample_status;
begin
  if not lims.has_role(array['frontdesk','reviewer','admin']::lims.staff_role[]) then
    raise exception 'Only front desk, reviewer or admin accounts can add a test to a sample.' using errcode = 'P0001';
  end if;
  select status into v_status from lims.samples where id = p_sample_id;
  if not found then raise exception 'That sample no longer exists.' using errcode = 'P0001'; end if;
  if v_status in ('reported', 'rejected') then
    raise exception 'This sample is already %, and cannot take new tests. Log a new sample instead.', v_status using errcode = 'P0001';
  end if;
  insert into lims.sample_tests (sample_id, test_catalog_id) values (p_sample_id, p_test_catalog_id)
  on conflict (sample_id, test_catalog_id) do nothing;
  perform lims._log('samples', p_sample_id, 'test_assigned', jsonb_build_object('test_catalog_id', p_test_catalog_id, 'reason', 'added after accessioning'));
  return json_build_object('ok', true);
end;
$$;
revoke all on function lims.add_sample_test(uuid, uuid) from public, anon, authenticated;
grant execute on function lims.add_sample_test(uuid, uuid) to authenticated;

-- ---------- assign an analyst to a parameter (the worklist) ----------
create or replace function lims.assign_analyst(p_sample_test_id uuid, p_analyst_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sample_id uuid;
  v_role      lims.staff_role;
begin
  if not lims.has_role(array['reviewer','admin']::lims.staff_role[]) then
    raise exception 'Only a reviewer or admin can assign work to an analyst.' using errcode = 'P0001';
  end if;
  select role into v_role from lims.staff_profile where id = p_analyst_id and active;
  if v_role is null or v_role not in ('analyst', 'reviewer', 'admin') then
    raise exception 'That person is not an active analyst.' using errcode = 'P0001';
  end if;
  update lims.sample_tests
     set assigned_analyst = p_analyst_id, assigned_by = auth.uid(), assigned_at = now()
   where id = p_sample_test_id and status = 'pending'
   returning sample_id into v_sample_id;
  if not found then
    raise exception 'That test is not waiting for assignment (it may already have a result).' using errcode = 'P0001';
  end if;
  update lims.samples set status = 'in_testing', updated_at = now()
   where id = v_sample_id and status = 'received';
  perform lims._log('sample_tests', p_sample_test_id, 'test_assigned', jsonb_build_object('analyst_id', p_analyst_id));
  return json_build_object('ok', true);
end;
$$;
revoke all on function lims.assign_analyst(uuid, uuid) from public, anon, authenticated;
grant execute on function lims.assign_analyst(uuid, uuid) to authenticated;

-- ---------- enter a result ----------
create or replace function lims.enter_result(
  p_sample_test_id uuid, p_value text, p_unit text default null,
  p_instrument text default null, p_tested_at timestamptz default now()
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row       lims.sample_tests;
  v_catalog   lims.test_catalog;
  v_sample_id uuid;
  v_numeric   numeric;
  v_within    boolean;
  v_remaining int;
begin
  select * into v_row from lims.sample_tests where id = p_sample_test_id;
  if not found then raise exception 'That test no longer exists.' using errcode = 'P0001'; end if;
  if not (lims.has_role(array['admin']::lims.staff_role[]) or (lims.current_role() = 'analyst' and v_row.assigned_analyst = auth.uid())
          or (lims.current_role() in ('reviewer') and v_row.assigned_analyst = auth.uid())) then
    raise exception 'You can only enter a result for a test assigned to you.' using errcode = 'P0001';
  end if;
  if v_row.status not in ('pending', 'entered') then
    raise exception 'This result has already been reviewed and cannot be edited here. Ask a reviewer to reopen it.' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_value, ''))) < 1 then
    raise exception 'Enter a result value.' using errcode = 'P0001';
  end if;

  select * into v_catalog from lims.test_catalog where id = v_row.test_catalog_id;
  v_within := null;
  begin
    v_numeric := p_value::numeric;
    if v_catalog.permissible_limit_lo is not null and v_catalog.permissible_limit_hi is not null then
      v_within := v_numeric between v_catalog.permissible_limit_lo and v_catalog.permissible_limit_hi;
    elsif v_catalog.permissible_limit_hi is not null then
      v_within := v_numeric <= v_catalog.permissible_limit_hi;
    elsif v_catalog.permissible_limit_lo is not null then
      v_within := v_numeric >= v_catalog.permissible_limit_lo;
    end if;
  exception when invalid_text_representation then
    v_within := null; -- non-numeric result (e.g. "Absent"); limit comparison is left to the reviewer
  end;

  update lims.sample_tests
     set result_value = btrim(p_value), result_unit = nullif(btrim(coalesce(p_unit, '')), ''),
         within_limit = v_within, instrument = nullif(btrim(coalesce(p_instrument, '')), ''),
         tested_at = coalesce(p_tested_at, now()), entered_by = auth.uid(), entered_at = now(),
         status = 'entered'
   where id = p_sample_test_id
   returning sample_id into v_sample_id;

  select count(*) into v_remaining from lims.sample_tests where sample_id = v_sample_id and status = 'pending';
  if v_remaining = 0 then
    update lims.samples set status = 'under_review', updated_at = now()
     where id = v_sample_id and status in ('received', 'in_testing');
  end if;

  perform lims._log('sample_tests', p_sample_test_id, 'result_entered', jsonb_build_object('value', p_value, 'within_limit', v_within));
  return json_build_object('ok', true, 'within_limit', v_within);
end;
$$;
revoke all on function lims.enter_result(uuid, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function lims.enter_result(uuid, text, text, text, timestamptz) to authenticated;

-- ---------- review a result (approve or send back) ----------
create or replace function lims.review_result(p_sample_test_id uuid, p_decision text, p_comment text default null)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row        lims.sample_tests;
  v_sample_id  uuid;
  v_remaining  int;
  v_rejected   int;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'Decision must be approve or reject.' using errcode = 'P0001';
  end if;
  if not lims.has_role(array['reviewer','admin']::lims.staff_role[]) then
    raise exception 'Only a reviewer or admin can review a result.' using errcode = 'P0001';
  end if;
  select * into v_row from lims.sample_tests where id = p_sample_test_id;
  if not found then raise exception 'That test no longer exists.' using errcode = 'P0001'; end if;
  if v_row.status <> 'entered' then
    raise exception 'This result is not waiting for review.' using errcode = 'P0001';
  end if;
  if v_row.entered_by = auth.uid() and not lims.has_role(array['admin']::lims.staff_role[]) then
    raise exception 'The analyst who entered a result cannot also review it — ask another reviewer.' using errcode = 'P0001';
  end if;
  if p_decision = 'reject' and char_length(btrim(coalesce(p_comment, ''))) < 2 then
    raise exception 'Say why the result is being sent back, so the analyst knows what to fix.' using errcode = 'P0001';
  end if;

  update lims.sample_tests
     set status = (case p_decision when 'approve' then 'approved' else 'rejected' end)::lims.test_status,
         review_comment = nullif(btrim(coalesce(p_comment, '')), ''),
         reviewed_by = auth.uid(), reviewed_at = now(),
         approved_by = case when p_decision = 'approve' then auth.uid() else null end,
         approved_at = case when p_decision = 'approve' then now() else null end
   where id = p_sample_test_id
   returning sample_id into v_sample_id;

  -- a rejected result goes back to the analyst as a fresh pending item (same assignment, cleared result)
  if p_decision = 'reject' then
    update lims.sample_tests
       set status = 'pending', result_value = null, result_unit = null, within_limit = null,
           entered_by = null, entered_at = null
     where id = p_sample_test_id;
    update lims.samples set status = 'in_testing', updated_at = now() where id = v_sample_id;
  else
    select count(*) filter (where status <> 'approved') into v_remaining from lims.sample_tests where sample_id = v_sample_id;
    if v_remaining = 0 then
      update lims.samples set status = 'approved', updated_at = now() where id = v_sample_id;
    end if;
  end if;

  perform lims._log('sample_tests', p_sample_test_id, case p_decision when 'approve' then 'result_approved' else 'result_rejected' end,
    jsonb_build_object('comment', p_comment));
  return json_build_object('ok', true);
end;
$$;
revoke all on function lims.review_result(uuid, text, text) from public, anon, authenticated;
grant execute on function lims.review_result(uuid, text, text) to authenticated;

-- ---------- put a sample on hold / reject the whole sample / resume ----------
create or replace function lims.set_sample_status(p_sample_id uuid, p_status lims.sample_status, p_reason text default null)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old lims.sample_status;
begin
  if not lims.has_role(array['reviewer','admin']::lims.staff_role[]) then
    raise exception 'Only a reviewer or admin can change a sample''s status directly.' using errcode = 'P0001';
  end if;
  if p_status not in ('on_hold', 'rejected', 'received') then
    raise exception 'That status can only be reached through the normal workflow (assign, enter, review).' using errcode = 'P0001';
  end if;
  select status into v_old from lims.samples where id = p_sample_id;
  if not found then raise exception 'That sample no longer exists.' using errcode = 'P0001'; end if;
  if p_status = 'rejected' and char_length(btrim(coalesce(p_reason, ''))) < 2 then
    raise exception 'Say why the sample is being rejected.' using errcode = 'P0001';
  end if;
  update lims.samples set status = p_status, notes = case when p_reason is not null then coalesce(notes || E'\n', '') || '[' || p_status || '] ' || p_reason else notes end, updated_at = now()
   where id = p_sample_id;
  perform lims._log('samples', p_sample_id, 'sample_status_changed', jsonb_build_object('from', v_old, 'to', p_status, 'reason', p_reason));
  return json_build_object('ok', true);
end;
$$;
revoke all on function lims.set_sample_status(uuid, lims.sample_status, text) from public, anon, authenticated;
grant execute on function lims.set_sample_status(uuid, lims.sample_status, text) to authenticated;

-- ---------- issue a certificate of analysis ----------
create or replace function lims.issue_certificate(p_sample_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status lims.sample_status;
  v_cert   lims.certificates;
  v_seq    bigint;
begin
  if not lims.has_role(array['reviewer','admin']::lims.staff_role[]) then
    raise exception 'Only a reviewer or admin can issue a certificate.' using errcode = 'P0001';
  end if;
  select status into v_status from lims.samples where id = p_sample_id;
  if not found then raise exception 'That sample no longer exists.' using errcode = 'P0001'; end if;
  if v_status <> 'approved' then
    raise exception 'Every result on this sample must be reviewed and approved before a certificate can be issued.' using errcode = 'P0001';
  end if;
  if exists (select 1 from lims.certificates where sample_id = p_sample_id and voided_at is null) then
    raise exception 'A certificate has already been issued for this sample.' using errcode = 'P0001';
  end if;

  v_seq := lims.next_number('certificate_' || to_char(now(), 'YYYY'));
  insert into lims.certificates (sample_id, certificate_number, issued_by)
  values (p_sample_id, 'SRAL/COA/' || to_char(now(), 'YYYY') || '/' || lpad(v_seq::text, 6, '0'), auth.uid())
  returning * into v_cert;

  update lims.samples set status = 'reported', updated_at = now() where id = p_sample_id;
  perform lims._log('certificates', v_cert.id, 'certificate_issued', jsonb_build_object('certificate_number', v_cert.certificate_number, 'sample_id', p_sample_id));
  return json_build_object('ok', true, 'certificate_number', v_cert.certificate_number, 'id', v_cert.id);
end;
$$;
revoke all on function lims.issue_certificate(uuid) from public, anon, authenticated;
grant execute on function lims.issue_certificate(uuid) to authenticated;

-- ---------- admin: set another user's role / active flag ----------
create or replace function lims.set_staff_role(p_user_id uuid, p_role lims.staff_role, p_active boolean default true)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old lims.staff_profile;
begin
  if not lims.has_role(array['admin']::lims.staff_role[]) then
    raise exception 'Only an admin can change a staff member''s role.' using errcode = 'P0001';
  end if;
  if p_user_id = auth.uid() and p_role <> 'admin' then
    raise exception 'You cannot remove your own admin access. Ask another admin to do it.' using errcode = 'P0001';
  end if;
  select * into v_old from lims.staff_profile where id = p_user_id;
  if not found then raise exception 'That person has not signed in yet, so there is no profile to update.' using errcode = 'P0001'; end if;
  update lims.staff_profile set role = p_role, active = p_active, updated_at = now() where id = p_user_id;
  perform lims._log('staff_profile', p_user_id, 'staff_role_changed', jsonb_build_object('from_role', v_old.role, 'to_role', p_role, 'active', p_active));
  return json_build_object('ok', true);
end;
$$;
revoke all on function lims.set_staff_role(uuid, lims.staff_role, boolean) from public, anon, authenticated;
grant execute on function lims.set_staff_role(uuid, lims.staff_role, boolean) to authenticated;

-- ---------- dashboard counts (one round trip for the home screen) ----------
create or replace function lims.dashboard_counts()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'received',     (select count(*) from lims.samples where status = 'received'),
    'in_testing',   (select count(*) from lims.samples where status = 'in_testing'),
    'under_review', (select count(*) from lims.samples where status = 'under_review'),
    'approved',     (select count(*) from lims.samples where status = 'approved'),
    'reported_today', (select count(*) from lims.samples where status = 'reported' and updated_at::date = current_date),
    'overdue',      (select count(*) from lims.samples where status not in ('reported','rejected') and due_date < current_date),
    'my_pending_tests', (select count(*) from lims.sample_tests where assigned_analyst = auth.uid() and status = 'pending'),
    'pending_review',   (select count(*) from lims.sample_tests where status = 'entered')
  )
  where lims.current_role() is not null;
$$;
revoke all on function lims.dashboard_counts() from public, anon, authenticated;
grant execute on function lims.dashboard_counts() to authenticated;
