// Worker behaviour checks. Usage: node worker-test.mjs
import { call } from './harness.mjs';

const SITE = 'https://sral.foodtesting.com';
let passed = 0, failed = 0;
function ok(cond, label) { if (cond) { passed++; console.log('ok   ' + label); } else { failed++; console.log('FAIL ' + label); } }

let r = await call(SITE + '/');
let t = await r.text();
ok(r.status === 200 && t.includes('SRAL LIMS'), 'home page served');
ok(t.includes('LIMS_CONFIG') && t.includes('jbuhflpfapdhwpgnpbkm.supabase.co'), 'Supabase config is embedded in the page');
ok(!/%%[A-Z]+%%/.test(t), 'no unresolved build placeholders');

const headers = r.headers;
ok(headers.get('x-frame-options') === 'DENY', 'clickjacking protection (X-Frame-Options)');
ok(headers.get('x-robots-tag') === 'noindex, nofollow', 'never indexed (this is an internal tool)');
ok((headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"), 'CSP blocks framing');
ok((headers.get('content-security-policy') || '').includes('jbuhflpfapdhwpgnpbkm.supabase.co'), 'CSP allows the Supabase project and nothing else');
ok(!(headers.get('content-security-policy') || '').includes('unsafe-inline') && !(headers.get('content-security-policy') || '').includes('unsafe-eval'), 'CSP has no unsafe-inline/unsafe-eval');
ok(headers.get('strict-transport-security') === 'max-age=31536000', 'HSTS set');

r = await call(SITE + '/samples/some-sample-id');
t = await r.text();
ok(r.status === 200 && t.includes('SRAL LIMS'), 'deep client-side route (SPA fallback) serves the app, not a 404');
const sameHeaders = r.headers;
ok(sameHeaders.get('x-frame-options') === 'DENY', 'security headers also apply to SPA-fallback responses');

r = await call(SITE + '/robots.txt');
t = await r.text();
ok(r.status === 200 && t.trim() === 'User-agent: *\nDisallow: /'.trim(), 'robots.txt disallows everything (internal tool, never crawled)');

r = await call(SITE + '/assets/app.js');
ok(r.status === 200 && (await r.text()).includes('LimsApi'), 'app.js is served and references the API client');
const assetHeaders = r.headers;
ok(assetHeaders.get('content-security-policy'), 'security headers also apply to asset responses (run_worker_first)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
