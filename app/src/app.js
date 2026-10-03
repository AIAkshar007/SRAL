/* SRAL LIMS — app shell, router and every module. Plain JS, template-string rendering,
   matches the house style of foodwatertesting.com/Prachar: no framework, no build dependency. */
(function () {
  'use strict';
  const Api = window.LimsApi;

  // ---------- dom + format helpers ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const statusLabel = (s) => String(s || '').replace(/_/g, ' ');
  function toast(msg, kind) {
    const box = $('#toast-host') || (() => { const d = document.createElement('div'); d.id = 'toast-host'; d.style.cssText = 'position:fixed;top:16px;right:16px;z-index:200;display:flex;flex-direction:column;gap:8px'; document.body.appendChild(d); return d; })();
    const n = document.createElement('div');
    n.className = 'msg ' + (kind === 'err' ? 'msg-err' : kind === 'warn' ? 'msg-warn' : 'msg-ok');
    n.style.cssText = 'box-shadow:0 4px 18px rgba(0,0,0,.12);min-width:220px';
    n.textContent = msg;
    box.appendChild(n);
    setTimeout(() => n.remove(), 5000);
  }
  function openModal(bodyHtml) {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = '<div class="modal-body">' + bodyHtml + '</div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.showModal();
    return dlg;
  }

  // ---------- state ----------
  let ME = null;            // { id, full_name, role, active }
  let CATALOG = [];         // lims.test_catalog rows
  let CATALOG_BY_ID = {};
  let STAFF = [];           // lims.staff_profile rows
  let STAFF_BY_ID = {};
  const staffName = (id) => (STAFF_BY_ID[id] && STAFF_BY_ID[id].full_name) || (id ? 'Former staff' : '—');

  function can(...roles) { return !!ME && roles.includes(ME.role); }

  async function loadReferenceData() {
    const [cat, staff] = await Promise.all([
      Api.select('test_catalog', { select: '*', where: [['active', 'eq', 'true']], order: 'sort_order.asc' }),
      Api.select('staff_profile', { select: '*', order: 'full_name.asc' })
    ]);
    CATALOG = cat.rows; CATALOG_BY_ID = {}; CATALOG.forEach((c) => { CATALOG_BY_ID[c.id] = c; });
    STAFF = staff.rows; STAFF_BY_ID = {}; STAFF.forEach((s) => { STAFF_BY_ID[s.id] = s; });
  }

  // ---------- router ----------
  const ROUTES = [];
  function addRoute(pattern, handler, opts) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; }) + '$');
    ROUTES.push({ re, names, handler, opts: opts || {} });
  }
  function navigate(path) { if (location.pathname !== path) history.pushState(null, '', path); render(); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest ? e.target.closest('a[data-link]') : null;
    if (!a) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', render);

  async function render() {
    if (!ME) return;
    const path = location.pathname;
    const content = $('#content');
    for (const r of ROUTES) {
      const m = path.match(r.re);
      if (!m) continue;
      if (r.opts.roles && !can(...r.opts.roles)) {
        content.innerHTML = '<div class="panel"><p>You don’t have access to this screen.</p></div>';
        return;
      }
      const params = {}; r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      renderNav(path);
      content.innerHTML = '<div class="empty"><span class="spinner"></span> Loading…</div>';
      try { await r.handler(params, content); }
      catch (e) { content.innerHTML = '<div class="msg msg-err">' + esc(e.message || String(e)) + '</div>'; }
      return;
    }
    content.innerHTML = '<div class="panel"><h2>Not found</h2><p><a href="/" data-link>Back to dashboard</a></p></div>';
  }

  // ---------- nav ----------
  const NAV_ITEMS = [
    { href: '/', label: 'Dashboard', roles: null },
    { href: '/samples', label: 'Samples', roles: null },
    { href: '/clients', label: 'Clients', roles: null },
    { href: '/certificates', label: 'Certificates', roles: null },
    { href: '/users', label: 'Users', roles: ['admin'] },
    { href: '/audit', label: 'Audit trail', roles: ['reviewer', 'admin'] }
  ];
  function renderNav(activePath) {
    const nav = $('#nav');
    nav.innerHTML = NAV_ITEMS.filter((it) => !it.roles || can(...it.roles)).map((it) => {
      const active = activePath === it.href || (it.href !== '/' && activePath.indexOf(it.href) === 0);
      return '<a href="' + it.href + '" data-link class="' + (active ? 'active' : '') + '">' + esc(it.label) + '</a>';
    }).join('');
    $('#me-name').textContent = ME.full_name;
    $('#me-role').textContent = ME.role;
    const title = (NAV_ITEMS.find((it) => activePath === it.href || (it.href !== '/' && activePath.indexOf(it.href) === 0)) || {}).label || 'SRAL LIMS';
    $('#page-title').textContent = title;
  }

  // ======================================================================
  // DASHBOARD
  // ======================================================================
  async function pageDashboard(params, el) {
    const counts = await Api.rpc('dashboard_counts');
    const card = (num, label, href, warn) => '<a class="card link' + (warn ? ' warn' : '') + '" href="' + href + '" data-link><div class="num">' + num + '</div><div class="label">' + esc(label) + '</div></a>';
    el.innerHTML = '' +
      '<div class="cards">' +
      card(counts.received, 'Received, not started', '/samples?status=received') +
      card(counts.in_testing, 'In testing', '/samples?status=in_testing') +
      card(counts.under_review, 'Awaiting review', '/samples?status=under_review') +
      card(counts.approved, 'Approved, not reported', '/samples?status=approved') +
      card(counts.reported_today, 'Reported today', '/samples?status=reported') +
      card(counts.overdue, 'Overdue', '/samples?overdue=1', counts.overdue > 0) +
      '</div>' +
      '<div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">' +
      card(counts.my_pending_tests, 'Assigned to me, not yet entered', '/samples?mine=1') +
      (can('reviewer', 'admin') ? card(counts.pending_review, 'Results waiting for review', '/samples?status=under_review') : '') +
      '</div>' +
      '<div class="btn-row">' +
      (can('frontdesk', 'reviewer', 'admin') ? '<a class="btn" href="/samples/new" data-link>+ New sample</a>' : '') +
      '<a class="btn btn-ghost" href="/samples" data-link>All samples</a>' +
      '</div>';
  }

  // ======================================================================
  // SAMPLES: list
  // ======================================================================
  async function pageSamples(params, el) {
    const q = new URLSearchParams(location.search);
    const status = q.get('status') || '';
    const mine = q.get('mine') === '1';
    const overdue = q.get('overdue') === '1';

    const where = [];
    if (status) where.push(['status', 'eq', status]);
    let rows;
    if (mine) {
      const myTests = await Api.select('sample_tests', { select: 'sample_id', where: [['assigned_analyst', 'eq', ME.id], ['status', 'eq', 'pending']] });
      const ids = Array.from(new Set(myTests.rows.map((r) => r.sample_id)));
      rows = ids.length ? (await Api.select('samples', { select: '*,clients(name)', order: 'created_at.desc' })).rows.filter((s) => ids.includes(s.id)) : [];
    } else {
      const r = await Api.select('samples', { select: '*,clients(name)', where, order: 'created_at.desc', limit: 200 });
      rows = overdue ? r.rows.filter((s) => s.due_date && s.due_date < new Date().toISOString().slice(0, 10) && !['reported', 'rejected'].includes(s.status)) : r.rows;
    }

    const STATUSES = ['received', 'in_testing', 'under_review', 'approved', 'reported', 'on_hold', 'rejected'];
    el.innerHTML = '' +
      '<div class="toolbar">' +
      '<div class="filters">' +
      '<a class="btn btn-sm ' + (!status && !mine && !overdue ? '' : 'btn-ghost') + '" href="/samples" data-link>All</a>' +
      STATUSES.map((s) => '<a class="btn btn-sm ' + (status === s ? '' : 'btn-ghost') + '" href="/samples?status=' + s + '" data-link>' + esc(statusLabel(s)) + '</a>').join('') +
      '</div>' +
      (can('frontdesk', 'reviewer', 'admin') ? '<a class="btn" href="/samples/new" data-link>+ New sample</a>' : '') +
      '</div>' +
      '<div class="table-wrap">' +
      (rows.length === 0 ? '<div class="empty">No samples match this filter.</div>' : '<table id="samples-table"><thead><tr><th>LIMS no.</th><th>Client</th><th>Description</th><th>Status</th><th>Due</th><th>Logged</th></tr></thead><tbody>' +
        rows.map((s) => '<tr style="cursor:pointer" data-goto="/samples/' + s.id + '">' +
          '<td class="mono">' + esc(s.lims_number) + '</td>' +
          '<td>' + esc(s.clients ? s.clients.name : '—') + '</td>' +
          '<td>' + esc(s.description) + '</td>' +
          '<td><span class="pill pill-' + s.status + '">' + esc(statusLabel(s.status)) + '</span></td>' +
          '<td>' + fmtDate(s.due_date) + '</td>' +
          '<td>' + fmtDate(s.created_at) + '</td>' +
          '</tr>').join('') + '</tbody></table>') +
      '</div>';
    const t = $('#samples-table');
    if (t) t.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-goto]'); if (tr) navigate(tr.dataset.goto); });
  }

  // ======================================================================
  // SAMPLES: new (accessioning)
  // ======================================================================
  async function pageSampleNew(params, el) {
    const clients = (await Api.select('clients', { select: 'id,name', order: 'name.asc' })).rows;
    const byGroup = { water: [], food: [] };
    CATALOG.forEach((c) => byGroup[c.sample_group].push(c));
    const catalogChecklist = (group) => {
      const byCat = {};
      byGroup[group].forEach((c) => { (byCat[c.category_label] = byCat[c.category_label] || []).push(c); });
      return Object.keys(byCat).map((label) => '<div style="margin-bottom:10px"><div class="lbl" style="margin-bottom:5px">' + esc(label) + '</div>' +
        byCat[label].map((c) => '<label style="display:flex;gap:7px;align-items:center;font-size:13px;padding:3px 0"><input type="checkbox" name="test" value="' + c.id + '" data-group="' + group + '">' + esc(c.parameter_name) + (c.unit ? ' <span class="muted">(' + esc(c.unit) + ')</span>' : '') + '</label>').join('') +
        '</div>').join('');
    };

    el.innerHTML = '' +
      '<a class="backlink" href="/samples" data-link>← All samples</a>' +
      '<div class="panel">' +
      '<h2>Log a new sample</h2>' +
      '<div id="form-msg"></div>' +
      '<form id="sample-form">' +
      '<div class="row2">' +
      '<label class="field"><span class="lbl">Client</span><select name="client_id" required><option value="">Select…</option>' + clients.map((c) => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') + '</select></label>' +
      '<label class="field"><span class="lbl">Or add a new client</span><input type="text" name="new_client_name" placeholder="Leave blank if selecting above"></label>' +
      '</div>' +
      '<label class="field"><span class="lbl">Sample group</span><select name="sample_group" id="sample-group" required><option value="water">Water</option><option value="food">Food</option></select></label>' +
      '<label class="field"><span class="lbl">Description</span><input type="text" name="description" required maxlength="300" placeholder="e.g. Borewell water, Ground floor"></label>' +
      '<div class="row2">' +
      '<label class="field"><span class="lbl">Matrix</span><input type="text" name="matrix" placeholder="e.g. Groundwater, Packaged milk"></label>' +
      '<label class="field"><span class="lbl">Collected at</span><input type="datetime-local" name="collected_at"></label>' +
      '</div>' +
      '<div class="row3">' +
      '<label class="field"><span class="lbl">Collected by</span><input type="text" name="collected_by"></label>' +
      '<label class="field"><span class="lbl">Condition on receipt</span><input type="text" name="condition" value="Good"></label>' +
      '<label class="field"><span class="lbl">Container</span><input type="text" name="container_type"></label>' +
      '</div>' +
      '<div class="row2">' +
      '<label class="field"><span class="lbl">Quantity</span><input type="text" name="quantity"></label>' +
      '<label class="field"><span class="lbl">Notes</span><input type="text" name="notes"></label>' +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="lbl" style="margin-bottom:8px">Tests to assign</div>' +
      '<div id="tests-water">' + catalogChecklist('water') + '</div>' +
      '<div id="tests-food" class="hidden">' + catalogChecklist('food') + '</div>' +
      '<div class="btn-row" style="margin-top:14px"><button class="btn" type="submit">Log sample</button></div>' +
      '</form></div>';

    $('#sample-group').addEventListener('change', (e) => {
      $('#tests-water').classList.toggle('hidden', e.target.value !== 'water');
      $('#tests-food').classList.toggle('hidden', e.target.value !== 'food');
    });

    $('#sample-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const msg = $('#form-msg'); msg.innerHTML = '';
      const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        let clientId = f.client_id.value;
        if (!clientId && f.new_client_name.value.trim()) {
          const headers = { 'Content-Profile': 'lims', Prefer: 'return=representation' };
          const r = await fetch((window.LIMS_CONFIG.supabaseUrl) + '/rest/v1/clients', {
            method: 'POST', headers: Object.assign({ apikey: window.LIMS_CONFIG.publishableKey, Authorization: 'Bearer ' + Api.session.access_token, 'Content-Type': 'application/json' }, headers),
            body: JSON.stringify({ name: f.new_client_name.value.trim() })
          });
          const created = await r.json();
          if (!r.ok) throw new Api.ApiError(r.status, created);
          clientId = created[0].id;
        }
        if (!clientId) throw new Error('Select an existing client or type a new client name.');
        const testIds = $$('input[name=test]:checked', e.target).map((i) => i.value);
        const result = await Api.rpc('accession_sample', {
          p_client_id: clientId, p_sample_group: f.sample_group.value, p_category_slug: null,
          p_description: f.description.value, p_matrix: f.matrix.value || null,
          p_collected_at: f.collected_at.value ? new Date(f.collected_at.value).toISOString() : null,
          p_collected_by: f.collected_by.value || null, p_condition: f.condition.value || null,
          p_container_type: f.container_type.value || null, p_quantity: f.quantity.value || null,
          p_notes: f.notes.value || null, p_test_ids: testIds
        });
        toast('Sample ' + result.lims_number + ' logged.', 'ok');
        navigate('/samples/' + result.id);
      } catch (err) {
        msg.innerHTML = '<div class="msg msg-err">' + esc(err.message || String(err)) + '</div>';
        btn.disabled = false;
      }
    });
  }

  // ======================================================================
  // SAMPLES: detail (worklist + results + review + certificate, all here)
  // ======================================================================
  async function pageSampleDetail(params, el) {
    const sample = (await Api.select('samples', { select: '*,clients(name,phone,email,address)', where: [['id', 'eq', params.id]] })).rows[0];
    if (!sample) { el.innerHTML = '<div class="msg msg-err">Sample not found.</div>'; return; }
    const tests = (await Api.select('sample_tests', { select: '*', where: [['sample_id', 'eq', params.id]], order: 'created_at.asc' })).rows;
    const certs = (await Api.select('certificates', { select: '*', where: [['sample_id', 'eq', params.id]] })).rows;
    const activeCert = certs.find((c) => !c.voided_at);
    const analysts = STAFF.filter((s) => s.active && ['analyst', 'reviewer', 'admin'].includes(s.role));
    const catOptions = CATALOG.filter((c) => c.sample_group === sample.sample_group && !tests.some((t) => t.test_catalog_id === c.id));

    function testRow(t) {
      const cat = CATALOG_BY_ID[t.test_catalog_id] || {};
      const withinPill = t.within_limit === true ? '<span class="pill pill-within">Within limit</span>' : t.within_limit === false ? '<span class="pill pill-outside">Outside limit</span>' : '';
      const canAssign = t.status === 'pending' && can('reviewer', 'admin');
      const canEnter = t.status === 'pending' && t.assigned_analyst && (t.assigned_analyst === ME.id || can('admin'));
      const canReview = t.status === 'entered' && can('reviewer', 'admin') && (t.entered_by !== ME.id || can('admin'));
      return '<tr>' +
        '<td>' + esc(cat.parameter_name || '—') + (cat.unit ? ' <span class="muted">(' + esc(cat.unit) + ')</span>' : '') + '<br><span class="muted" style="font-size:11.5px">' + esc(cat.method || '') + (cat.permissible_limit ? ' · limit ' + esc(cat.permissible_limit) : '') + '</span></td>' +
        '<td>' + esc(staffName(t.assigned_analyst)) + (canAssign ? '<br><select class="assign-select" data-test="' + t.id + '" style="margin-top:4px;font-size:12px"><option value="">Assign…</option>' + analysts.map((a) => '<option value="' + a.id + '">' + esc(a.full_name) + '</option>').join('') + '</select>' : '') + '</td>' +
        '<td><span class="pill pill-' + t.status + '">' + esc(statusLabel(t.status)) + '</span></td>' +
        '<td>' + (t.result_value ? esc(t.result_value) + (t.result_unit ? ' ' + esc(t.result_unit) : '') : '—') + ' ' + withinPill + (t.review_comment ? '<br><span class="muted" style="font-size:12px">' + esc(t.review_comment) + '</span>' : '') + '</td>' +
        '<td class="actions">' +
        (canEnter ? '<button class="btn btn-sm enter-btn" data-test="' + t.id + '" data-param="' + esc(cat.parameter_name || '') + '" data-unit="' + esc(cat.unit || '') + '">Enter result</button>' : '') +
        (canReview ? '<button class="btn btn-sm review-btn" data-test="' + t.id + '" data-decision="approve">Approve</button> <button class="btn btn-sm btn-ghost review-btn" data-test="' + t.id + '" data-decision="reject">Reject</button>' : '') +
        '</td></tr>';
    }

    el.innerHTML = '' +
      '<a class="backlink" href="/samples" data-link>← All samples</a>' +
      '<div class="panel">' +
      '<div class="toolbar"><h2 style="margin:0">' + esc(sample.lims_number) + ' <span class="pill pill-' + sample.status + '">' + esc(statusLabel(sample.status)) + '</span></h2>' +
      '<div class="btn-row">' +
      (sample.status === 'approved' && can('reviewer', 'admin') && !activeCert ? '<button class="btn" id="issue-cert-btn">Issue certificate</button>' : '') +
      (activeCert ? '<button class="btn btn-ghost" id="download-pdf-btn">Download Certificate (PDF)</button>' : '') +
      (can('reviewer', 'admin') && !['reported', 'rejected'].includes(sample.status) ? '<button class="btn btn-ghost" id="hold-btn">' + (sample.status === 'on_hold' ? 'Resume' : 'Hold') + '</button>' : '') +
      (can('reviewer', 'admin') && !['reported', 'rejected'].includes(sample.status) ? '<button class="btn btn-ghost" id="reject-sample-btn">Reject sample</button>' : '') +
      '</div></div>' +
      '<dl class="kv">' +
      '<dt>Client</dt><dd>' + esc(sample.clients ? sample.clients.name : '—') + '</dd>' +
      '<dt>Description</dt><dd>' + esc(sample.description) + (sample.matrix ? ' — ' + esc(sample.matrix) : '') + '</dd>' +
      '<dt>Collected</dt><dd>' + fmtDateTime(sample.collected_at) + (sample.collected_by ? ' by ' + esc(sample.collected_by) : '') + '</dd>' +
      '<dt>Received</dt><dd>' + fmtDateTime(sample.received_at) + ' by ' + esc(staffName(sample.received_by)) + '</dd>' +
      '<dt>Condition / container</dt><dd>' + esc(sample.condition_on_receipt || '—') + ' · ' + esc(sample.container_type || '—') + ' · ' + esc(sample.quantity || '—') + '</dd>' +
      '<dt>Due</dt><dd>' + fmtDate(sample.due_date) + '</dd>' +
      (sample.notes ? '<dt>Notes</dt><dd style="white-space:pre-wrap">' + esc(sample.notes) + '</dd>' : '') +
      '</dl>' +
      '</div>' +
      '<div class="toolbar"><h2 style="margin:0">Tests</h2>' +
      (can('frontdesk', 'reviewer', 'admin') && !['reported', 'rejected'].includes(sample.status) && catOptions.length ? '<select id="add-test-select"><option value="">+ Add a test…</option>' + catOptions.map((c) => '<option value="' + c.id + '">' + esc(c.category_label) + ' — ' + esc(c.parameter_name) + '</option>').join('') + '</select>' : '') +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Parameter</th><th>Analyst</th><th>Status</th><th>Result</th><th></th></tr></thead><tbody>' +
      (tests.length ? tests.map(testRow).join('') : '<tr><td colspan="5" class="empty">No tests assigned yet.</td></tr>') +
      '</tbody></table></div>';

    $$('.assign-select').forEach((sel) => sel.addEventListener('change', async (e) => {
      if (!e.target.value) return;
      try { await Api.rpc('assign_analyst', { p_sample_test_id: e.target.dataset.test, p_analyst_id: e.target.value }); toast('Assigned.', 'ok'); render(); }
      catch (err) { toast(err.message, 'err'); }
    }));

    $$('.enter-btn').forEach((btn) => btn.addEventListener('click', () => {
      const dlg = openModal(
        '<h2>Enter result — ' + esc(btn.dataset.param) + '</h2>' +
        '<form id="enter-form">' +
        '<div class="row2"><label class="field"><span class="lbl">Result</span><input name="value" required autofocus></label>' +
        '<label class="field"><span class="lbl">Unit</span><input name="unit" value="' + esc(btn.dataset.unit) + '"></label></div>' +
        '<label class="field"><span class="lbl">Instrument</span><input name="instrument"></label>' +
        '<label class="field"><span class="lbl">Tested at</span><input type="datetime-local" name="tested_at"></label>' +
        '<div id="enter-msg"></div>' +
        '<div class="modal-foot"><button type="button" class="btn btn-ghost" id="cancel">Cancel</button><button class="btn" type="submit">Save result</button></div>' +
        '</form>'
      );
      $('#cancel', dlg).addEventListener('click', () => dlg.close());
      $('#enter-form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target.elements;
        try {
          await Api.rpc('enter_result', { p_sample_test_id: btn.dataset.test, p_value: f.value.value, p_unit: f.unit.value || null, p_instrument: f.instrument.value || null, p_tested_at: f.tested_at.value ? new Date(f.tested_at.value).toISOString() : null });
          dlg.close(); toast('Result saved.', 'ok'); render();
        } catch (err) { $('#enter-msg', dlg).innerHTML = '<div class="msg msg-err">' + esc(err.message) + '</div>'; }
      });
    }));

    $$('.review-btn').forEach((btn) => btn.addEventListener('click', async () => {
      const decision = btn.dataset.decision;
      if (decision === 'approve') {
        try { await Api.rpc('review_result', { p_sample_test_id: btn.dataset.test, p_decision: 'approve' }); toast('Approved.', 'ok'); render(); }
        catch (err) { toast(err.message, 'err'); }
        return;
      }
      const dlg = openModal(
        '<h2>Send back for correction</h2><form id="reject-form">' +
        '<label class="field"><span class="lbl">Tell the analyst what to fix</span><textarea name="comment" rows="3" required></textarea></label>' +
        '<div id="reject-msg"></div>' +
        '<div class="modal-foot"><button type="button" class="btn btn-ghost" id="cancel">Cancel</button><button class="btn btn-danger" type="submit">Send back</button></div></form>'
      );
      $('#cancel', dlg).addEventListener('click', () => dlg.close());
      $('#reject-form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await Api.rpc('review_result', { p_sample_test_id: btn.dataset.test, p_decision: 'reject', p_comment: e.target.elements.comment.value }); dlg.close(); toast('Sent back to the analyst.', 'ok'); render(); }
        catch (err) { $('#reject-msg', dlg).innerHTML = '<div class="msg msg-err">' + esc(err.message) + '</div>'; }
      });
    }));

    const addSel = $('#add-test-select');
    if (addSel) addSel.addEventListener('change', async (e) => {
      if (!e.target.value) return;
      try { await Api.rpc('add_sample_test', { p_sample_id: sample.id, p_test_catalog_id: e.target.value }); render(); }
      catch (err) { toast(err.message, 'err'); }
    });

    const holdBtn = $('#hold-btn');
    if (holdBtn) holdBtn.addEventListener('click', async () => {
      try { await Api.rpc('set_sample_status', { p_sample_id: sample.id, p_status: sample.status === 'on_hold' ? 'received' : 'on_hold', p_reason: sample.status === 'on_hold' ? null : 'Put on hold from the sample screen' }); render(); }
      catch (err) { toast(err.message, 'err'); }
    });
    const rejBtn = $('#reject-sample-btn');
    if (rejBtn) rejBtn.addEventListener('click', () => {
      const dlg = openModal('<h2>Reject this sample</h2><form id="rs-form"><label class="field"><span class="lbl">Reason</span><textarea name="reason" rows="3" required></textarea></label><div id="rs-msg"></div><div class="modal-foot"><button type="button" class="btn btn-ghost" id="cancel">Cancel</button><button class="btn btn-danger" type="submit">Reject sample</button></div></form>');
      $('#cancel', dlg).addEventListener('click', () => dlg.close());
      $('#rs-form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await Api.rpc('set_sample_status', { p_sample_id: sample.id, p_status: 'rejected', p_reason: e.target.elements.reason.value }); dlg.close(); toast('Sample rejected.', 'ok'); render(); }
        catch (err) { $('#rs-msg', dlg).innerHTML = '<div class="msg msg-err">' + esc(err.message) + '</div>'; }
      });
    });
    const issueBtn = $('#issue-cert-btn');
    if (issueBtn) issueBtn.addEventListener('click', async () => {
      try { const r = await Api.rpc('issue_certificate', { p_sample_id: sample.id }); toast('Certificate ' + r.certificate_number + ' issued.', 'ok'); render(); }
      catch (err) { toast(err.message, 'err'); }
    });
    const dlBtn = $('#download-pdf-btn');
    if (dlBtn) dlBtn.addEventListener('click', () => buildCertificatePdf(sample, tests, activeCert));
  }

  // ======================================================================
  // CERTIFICATE PDF
  // ======================================================================
  function buildCertificatePdf(sample, tests, cert) {
    const M = 50, W = PdfDoc.PAGE_W - M * 2;
    const doc = new PdfDoc();
    let y = PdfDoc.PAGE_H - 60;
    const line = (dy) => { y -= dy; if (y < 90) { doc.addPage(); y = PdfDoc.PAGE_H - 60; } };

    doc.text(M, y, 'Sadguru Research & Analysis Laboratory', { size: 15, bold: true }); line(16);
    doc.text(M, y, 'Saltee Plaza, 1 K B Sarani, Room 313, Kolkata 700080, West Bengal, India', { size: 9 }); line(10);
    doc.text(M, y, '+91 93306 64877 · sadguru.laboratory@gmail.com', { size: 9 }); line(16);
    doc.text(PdfDoc.PAGE_W - M, y + 26, 'CERTIFICATE OF ANALYSIS', { size: 11, bold: true, align: 'right' });
    doc.text(PdfDoc.PAGE_W - M, y + 12, 'No. ' + (cert ? cert.certificate_number : '—'), { size: 9, align: 'right' });
    doc.line(M, y, PdfDoc.PAGE_W - M, y); line(18);

    const kv = (k, v) => { doc.text(M, y, k, { size: 9, bold: true }); doc.text(M + 115, y, v || '—', { size: 9 }); line(14); };
    kv('LIMS number', sample.lims_number);
    kv('Client', sample.clients ? sample.clients.name : '');
    kv('Sample', sample.description + (sample.matrix ? ' — ' + sample.matrix : ''));
    kv('Collected', fmtDateTime(sample.collected_at));
    kv('Received', fmtDateTime(sample.received_at));
    kv('Issued', cert ? fmtDateTime(cert.issued_at) : fmtDateTime(new Date().toISOString()));
    line(10);
    doc.line(M, y, PdfDoc.PAGE_W - M, y); line(16);

    const colX = [M, M + 210, M + 300, M + 380];
    doc.text(colX[0], y, 'Parameter', { size: 9, bold: true });
    doc.text(colX[1], y, 'Result', { size: 9, bold: true });
    doc.text(colX[2], y, 'Limit', { size: 9, bold: true });
    doc.text(colX[3], y, 'Method', { size: 9, bold: true });
    line(6); doc.line(M, y, PdfDoc.PAGE_W - M, y); line(12);

    tests.forEach((t) => {
      const cat = CATALOG_BY_ID[t.test_catalog_id] || {};
      doc.text(colX[0], y, cat.parameter_name || '', { size: 9 });
      doc.text(colX[1], y, (t.result_value || '—') + (t.result_unit ? ' ' + t.result_unit : ''), { size: 9 });
      doc.text(colX[2], y, cat.permissible_limit || '—', { size: 9 });
      doc.text(colX[3], y, cat.method || '', { size: 8 });
      line(14);
    });
    line(8); doc.line(M, y, PdfDoc.PAGE_W - M, y); line(18);

    doc.text(M, y, 'Results apply only to the sample as received. This report shall not be reproduced in part without written approval.', { size: 8 });
    line(10);
    doc.text(M, y, 'No claim is made to NABL, ISO/IEC 17025 or FSSAI-notified accreditation unless a certificate number is separately provided.', { size: 8 });
    line(26);

    const approver = tests.find((t) => t.approved_by) ;
    doc.text(M, y, 'Reviewed and approved by ' + staffName(approver ? approver.approved_by : null), { size: 9 });
    line(28);
    doc.text(M, y, '[ computer-generated certificate — regenerated from current records at the time of download ]', { size: 7.5 });

    doc.download((cert ? cert.certificate_number : sample.lims_number).replace(/\//g, '-') + '.pdf');
  }

  // ======================================================================
  // CLIENTS
  // ======================================================================
  async function pageClients(params, el) {
    const clients = (await Api.select('clients', { select: '*', order: 'name.asc' })).rows;
    el.innerHTML = '' +
      '<div class="toolbar"><div></div>' + (can('frontdesk', 'reviewer', 'admin') ? '<button class="btn" id="add-client-btn">+ Add client</button>' : '') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th></tr></thead><tbody>' +
      (clients.length ? clients.map((c) => '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.contact_name || '—') + '</td><td>' + esc(c.phone || '—') + '</td><td>' + esc(c.email || '—') + '</td></tr>').join('') : '<tr><td colspan="4" class="empty">No clients yet.</td></tr>') +
      '</tbody></table></div>';
    const btn = $('#add-client-btn');
    if (btn) btn.addEventListener('click', () => {
      const dlg = openModal('<h2>Add client</h2><form id="cf"><label class="field"><span class="lbl">Name</span><input name="name" required></label><div class="row2"><label class="field"><span class="lbl">Contact name</span><input name="contact_name"></label><label class="field"><span class="lbl">Phone</span><input name="phone"></label></div><div class="row2"><label class="field"><span class="lbl">Email</span><input name="email" type="email"></label><label class="field"><span class="lbl">GSTIN</span><input name="gstin"></label></div><label class="field"><span class="lbl">Address</span><textarea name="address" rows="2"></textarea></label><div id="cf-msg"></div><div class="modal-foot"><button type="button" class="btn btn-ghost" id="cancel">Cancel</button><button class="btn" type="submit">Add</button></div></form>');
      $('#cancel', dlg).addEventListener('click', () => dlg.close());
      $('#cf', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target.elements;
        try {
          const r = await fetch(window.LIMS_CONFIG.supabaseUrl + '/rest/v1/clients', {
            method: 'POST',
            headers: { apikey: window.LIMS_CONFIG.publishableKey, Authorization: 'Bearer ' + Api.session.access_token, 'Content-Type': 'application/json', 'Content-Profile': 'lims', Prefer: 'return=representation' },
            body: JSON.stringify({ name: f.name.value, contact_name: f.contact_name.value || null, phone: f.phone.value || null, email: f.email.value || null, gstin: f.gstin.value || null, address: f.address.value || null })
          });
          const data = await r.json();
          if (!r.ok) throw new Api.ApiError(r.status, data);
          dlg.close(); toast('Client added.', 'ok'); render();
        } catch (err) { $('#cf-msg', dlg).innerHTML = '<div class="msg msg-err">' + esc(err.message) + '</div>'; }
      });
    });
  }

  // ======================================================================
  // CERTIFICATES
  // ======================================================================
  async function pageCertificates(params, el) {
    const certs = (await Api.select('certificates', { select: '*,samples(lims_number,description,clients(name))', order: 'issued_at.desc' })).rows;
    el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Certificate no.</th><th>Sample</th><th>Client</th><th>Issued</th><th></th></tr></thead><tbody>' +
      (certs.length ? certs.map((c) => '<tr' + (c.voided_at ? ' style="opacity:.5"' : '') + '>' +
        '<td class="mono">' + esc(c.certificate_number) + (c.voided_at ? ' <span class="pill pill-rejected">Voided</span>' : '') + '</td>' +
        '<td><a href="/samples/' + c.sample_id + '" data-link>' + esc(c.samples ? c.samples.lims_number : '') + '</a> — ' + esc(c.samples ? c.samples.description : '') + '</td>' +
        '<td>' + esc(c.samples && c.samples.clients ? c.samples.clients.name : '—') + '</td>' +
        '<td>' + fmtDateTime(c.issued_at) + '</td>' +
        '<td><a href="/samples/' + c.sample_id + '" data-link class="btn btn-sm btn-ghost">Open sample</a></td>' +
        '</tr>').join('') : '<tr><td colspan="5" class="empty">No certificates issued yet.</td></tr>') +
      '</tbody></table></div>';
  }

  // ======================================================================
  // USERS (admin)
  // ======================================================================
  async function pageUsers(params, el) {
    const ROLES = ['pending', 'frontdesk', 'analyst', 'reviewer', 'admin'];
    el.innerHTML = '<p class="muted">New accounts are created in the Supabase dashboard (Authentication → Users). Once someone signs in for the first time, they appear here as “pending” until you set their role.</p>' +
      '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Active</th><th>Joined</th></tr></thead><tbody>' +
      STAFF.map((s) => '<tr>' +
        '<td>' + esc(s.full_name) + (s.id === ME.id ? ' <span class="muted">(you)</span>' : '') + '</td>' +
        '<td><select class="role-select" data-id="' + s.id + '" ' + (s.id === ME.id ? 'disabled' : '') + '>' + ROLES.map((r) => '<option value="' + r + '"' + (r === s.role ? ' selected' : '') + '>' + esc(r) + '</option>').join('') + '</select></td>' +
        '<td><input type="checkbox" class="active-check" data-id="' + s.id + '" ' + (s.active ? 'checked' : '') + ' ' + (s.id === ME.id ? 'disabled' : '') + '></td>' +
        '<td>' + fmtDate(s.created_at) + '</td>' +
        '</tr>').join('') +
      '</tbody></table></div>';

    async function applyRoleChange(id) {
      const role = $('.role-select[data-id="' + id + '"]').value;
      const active = $('.active-check[data-id="' + id + '"]').checked;
      try { await Api.rpc('set_staff_role', { p_user_id: id, p_role: role, p_active: active }); await loadReferenceData(); toast('Updated.', 'ok'); }
      catch (err) { toast(err.message, 'err'); render(); }
    }
    $$('.role-select').forEach((s) => s.addEventListener('change', () => applyRoleChange(s.dataset.id)));
    $$('.active-check').forEach((s) => s.addEventListener('change', () => applyRoleChange(s.dataset.id)));
  }

  // ======================================================================
  // AUDIT TRAIL (reviewer/admin)
  // ======================================================================
  async function pageAudit(params, el) {
    const rows = (await Api.select('audit_log', { select: '*', order: 'at.desc', limit: 200 })).rows;
    el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Table</th><th>Detail</th></tr></thead><tbody>' +
      (rows.length ? rows.map((r) => '<tr>' +
        '<td class="mono" style="white-space:nowrap">' + fmtDateTime(r.at) + '</td>' +
        '<td>' + esc(staffName(r.actor)) + '</td>' +
        '<td>' + esc(r.action.replace(/_/g, ' ')) + '</td>' +
        '<td>' + esc(r.table_name) + '</td>' +
        '<td class="mono" style="font-size:11.5px;max-width:360px;overflow-wrap:anywhere">' + esc(r.detail ? JSON.stringify(r.detail) : '') + '</td>' +
        '</tr>').join('') : '<tr><td colspan="5" class="empty">No activity yet.</td></tr>') +
      '</tbody></table></div>';
  }

  // ---------- routes ----------
  addRoute('/', pageDashboard);
  addRoute('/samples', pageSamples);
  addRoute('/samples/new', pageSampleNew, { roles: ['frontdesk', 'reviewer', 'admin'] });
  addRoute('/samples/:id', pageSampleDetail);
  addRoute('/clients', pageClients);
  addRoute('/certificates', pageCertificates);
  addRoute('/users', pageUsers, { roles: ['admin'] });
  addRoute('/audit', pageAudit, { roles: ['reviewer', 'admin'] });

  // ======================================================================
  // BOOT
  // ======================================================================
  async function showLogin(errMsg) {
    $('#login-screen').classList.remove('hidden');
    $('#app-shell').classList.add('hidden');
    $('#pending-screen').classList.add('hidden');
    if (errMsg) $('#login-msg').innerHTML = '<div class="msg msg-err">' + esc(errMsg) + '</div>';
  }

  async function showApp() {
    $('#login-screen').classList.add('hidden');
    $('#pending-screen').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
    await loadReferenceData();
    renderNav(location.pathname);
    await render();
  }

  function wireLoginForm() {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; $('#login-msg').innerHTML = '';
      try {
        await Api.signIn(f.email.value.trim(), f.password.value);
        await afterSignIn();
      } catch (err) {
        $('#login-msg').innerHTML = '<div class="msg msg-err">' + esc(err.message) + '</div>';
        btn.disabled = false;
      }
    });
  }

  async function afterSignIn() {
    const profile = await Api.rpc('bootstrap', { p_full_name: null }).catch(() => null);
    if (!profile) { await Api.signOut(); return showLogin('Could not load your profile. Try again.'); }
    if (profile.role === 'pending' || !profile.active) {
      ME = profile;
      $('#login-screen').classList.add('hidden');
      $('#app-shell').classList.add('hidden');
      $('#pending-screen').classList.remove('hidden');
      return;
    }
    ME = profile;
    await showApp();
  }

  function wireShellChrome() {
    $('#signout-btn').addEventListener('click', async () => { await Api.signOut(); location.href = '/'; });
    $('#pending-signout').addEventListener('click', async () => { await Api.signOut(); location.href = '/'; });
    $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    $('#content').addEventListener('click', (e) => { if (e.target.closest('a[data-link]') && window.innerWidth <= 860) $('#sidebar').classList.remove('open'); });
  }

  async function boot() {
    wireLoginForm();
    wireShellChrome();
    if (Api.session && Api.session.access_token) {
      await afterSignIn();
    } else {
      await showLogin();
    }
  }

  boot();
})();
