// Runs the Worker in Node with a stand-in for the static-assets binding, replicating wrangler's
// not_found_handling: "single-page-application" (unmatched paths serve dist/index.html with 200).
import fs from 'node:fs';
import path from 'node:path';
import worker from '../index.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.resolve(HERE, '..', '..', 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

function fileResponse(file, status) {
  return new Response(fs.readFileSync(file), { status, headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } });
}

export const ASSETS = {
  async fetch(input) {
    const req = input instanceof Request ? input : new Request(input);
    const p = decodeURIComponent(new URL(req.url).pathname);
    const abs = path.join(DIST, p === '/' ? 'index.html' : p);
    if (!abs.startsWith(DIST)) return new Response('bad', { status: 400 });
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return fileResponse(abs, 200);
    return fileResponse(path.join(DIST, 'index.html'), 200); // SPA fallback
  }
};

export async function call(url, init) {
  return worker.fetch(new Request(url, Object.assign({ redirect: 'manual' }, init || {})), { ASSETS });
}
