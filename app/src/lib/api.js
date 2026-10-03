/* SRAL LIMS data client: Supabase Auth (email + password) and PostgREST (schema "lims") over fetch.
   No SDK, no build dependency — same house style as foodwatertesting.com and Prachar. */
(function (global) {
  'use strict';
  const CFG = global.LIMS_CONFIG || {};
  const BASE = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
  const KEY = CFG.publishableKey || '';
  const STORE = 'lims.session.v1';
  const SCHEMA = 'lims';

  let session = null;
  try { session = JSON.parse(global.localStorage.getItem(STORE) || 'null'); } catch (e) { session = null; }
  let refreshing = null;
  const listeners = [];

  function save(s) {
    session = s;
    try {
      if (s) global.localStorage.setItem(STORE, JSON.stringify(s));
      else global.localStorage.removeItem(STORE);
    } catch (e) { /* private mode: keep the session in memory only */ }
    listeners.forEach((fn) => { try { fn(s); } catch (e) { /* ignore */ } });
  }

  function friendly(status, body) {
    const msg = body && (body.message || body.msg || body.error_description || body.error);
    const code = body && body.code;
    if (code === 'P0001' && msg) return msg;
    if (code === '42501' || status === 403) return 'You don’t have permission to do that.';
    if (code === '23505') return 'That already exists.';
    if (code === '23514') return 'One of the values isn’t allowed here. Check the form and try again.';
    if (code === '23503') return 'This refers to something that no longer exists. Refresh and try again.';
    if (code === 'PGRST301' || status === 401) return 'Your session has ended. Sign in again.';
    if (status === 429) return 'Too many requests just now. Wait a minute and try again.';
    if (code === 'invalid_grant' || /invalid.*(login|credentials)/i.test(msg || '')) return 'Email or password is incorrect.';
    if (msg && status < 500) return String(msg);
    return 'The server could not complete that (' + status + '). Please try again in a moment.';
  }

  class ApiError extends Error {
    constructor(status, body) {
      super(friendly(status, body));
      this.status = status;
      this.body = body || {};
      this.code = this.body.code || '';
    }
  }

  async function raw(method, path, opts) {
    opts = opts || {};
    const headers = Object.assign({ apikey: KEY }, opts.headers || {});
    if (opts.auth !== false && session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    let body = opts.body;
    if (body !== undefined && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(BASE + path, { method: method, headers: headers, body: body, cache: 'no-store' });
    } catch (e) {
      throw new ApiError(0, { message: 'No connection to the server. Check the internet and try again.' });
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { message: text }; } }
    return { res: res, data: data };
  }

  async function authed(method, path, opts) {
    await ensureFresh();
    let r = await raw(method, path, opts);
    if (r.res.status === 401 && session && session.refresh_token) {
      await refresh(true);
      r = await raw(method, path, opts);
    }
    if (!r.res.ok) throw new ApiError(r.res.status, r.data);
    return r;
  }

  // ---------- auth ----------
  function withExpiry(t) {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: t.expires_at || (now + Number(t.expires_in || 3600)),
      user: t.user || (session && session.user) || null
    };
  }

  async function signIn(email, password) {
    const r = await raw('POST', '/auth/v1/token?grant_type=password', { auth: false, body: { email: email, password: password } });
    if (!r.res.ok) throw new ApiError(r.res.status, r.data);
    save(withExpiry(r.data));
    return session;
  }

  async function refresh(force) {
    if (!session || !session.refresh_token) return null;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const r = await raw('POST', '/auth/v1/token?grant_type=refresh_token', { auth: false, body: { refresh_token: session.refresh_token } });
      if (!r.res.ok) {
        if (r.res.status >= 400 && r.res.status < 500) save(null);
        throw new ApiError(r.res.status, r.data);
      }
      save(withExpiry(r.data));
      return session;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  async function ensureFresh() {
    if (!session) return;
    const now = Math.floor(Date.now() / 1000);
    if (session.expires_at && session.expires_at - now < 60) await refresh();
  }

  async function signOut() {
    try { if (session) await raw('POST', '/auth/v1/logout', {}); } catch (e) { /* ignore */ }
    save(null);
  }

  async function changePassword(newPassword) {
    const r = await authed('PUT', '/auth/v1/user', { body: { password: newPassword } });
    return r.data;
  }

  // ---------- PostgREST (schema "lims") ----------
  function enc(v) { return v === null ? 'null' : encodeURIComponent(String(v)); }
  function qs(o) {
    const parts = ['select=' + encodeURIComponent(o.select || '*')];
    (o.where || []).forEach((w) => {
      const col = w[0], op = w[1], val = w[2];
      if (op === 'or') parts.push('or=' + encodeURIComponent(val));
      else if (op === 'is') parts.push(col + '=is.' + (val === null ? 'null' : val));
      else parts.push(col + '=' + op + '.' + enc(val));
    });
    if (o.order) parts.push('order=' + encodeURIComponent(o.order));
    if (o.limit != null) parts.push('limit=' + Number(o.limit));
    if (o.offset != null) parts.push('offset=' + Number(o.offset));
    return parts.join('&');
  }

  async function select(table, o) {
    o = o || {};
    const headers = { 'Accept-Profile': SCHEMA };
    if (o.count) headers.Prefer = 'count=exact';
    const r = await authed('GET', '/rest/v1/' + table + '?' + qs(o), { headers: headers });
    let total = null;
    const cr = r.res.headers.get('Content-Range');
    if (cr && cr.indexOf('/') >= 0) { const t = cr.split('/')[1]; total = t === '*' ? null : Number(t); }
    return { rows: r.data || [], total: total };
  }

  async function update(table, patch, where) {
    const r = await authed('PATCH', '/rest/v1/' + table + '?' + qs({ where: where }), {
      body: patch, headers: { 'Content-Profile': SCHEMA, Prefer: 'return=representation' }
    });
    return r.data || [];
  }

  async function rpc(fn, args) {
    const r = await authed('POST', '/rest/v1/rpc/' + fn, { body: args || {}, headers: { 'Content-Profile': SCHEMA } });
    return r.data;
  }

  global.LimsApi = {
    ApiError: ApiError,
    get session() { return session; },
    onSession: (fn) => listeners.push(fn),
    signIn: signIn,
    signOut: signOut,
    changePassword: changePassword,
    refresh: refresh,
    select: select,
    update: update,
    rpc: rpc
  };
})(window);
