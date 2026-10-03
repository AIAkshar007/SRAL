// Cloudflare Worker for sral.foodtesting.com — serves the SRAL LIMS single-page app with
// security headers appropriate to an internal, never-indexed tool. No server-side routes:
// the browser talks to Supabase directly (its own publishable key + the user's own session
// token) exactly as Prachar does on erp.foodwatertesting.com. There is no secret here —
// the publishable key is, by design, safe to ship to the browser; every real permission
// check happens in Postgres row-level security, not in this Worker.
import CFG from './site-config.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: ${CFG.supabaseUrl}`,
  `connect-src 'self' ${CFG.supabaseUrl}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ');

const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': CSP
};

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
    return out;
  }
};
