// iris serve — the contact sheet. Every render the eye has taken, side by side,
// with its defects pinned to it. The agent gets the images through MCP; this is
// the same thing for the human, because "vibe coding" only works if you can see
// the vibe.
//
// GET reads. POST looks (rendering walks the network and spawns a browser — a GET
// must never be able to do that).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { look, play, runs, getRun, shotBytes, forget, stats } from './core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const CORTEX_URL = (process.env.IRIS_CORTEX_URL || 'http://localhost:7800').replace(/\/$/, '');

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

const readBody = (req) => new Promise((resolve, reject) => {
  let s = '', n = 0;
  req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { req.destroy(); reject(new Error('body too large')); return; } s += c; });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('invalid JSON')); } });
  req.on('error', reject);
});

export function createIrisServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const q = Object.fromEntries(url.searchParams.entries());

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    try {
      if (url.pathname === '/api/stats') return json(res, 200, { ...stats(), cortex: CORTEX_URL });
      if (url.pathname === '/api/runs') return json(res, 200, runs({ limit: +q.limit || 40 }));

      if (url.pathname === '/api/run') {
        const r = getRun(q.id || '');
        return r ? json(res, 200, r) : json(res, 404, { error: 'no such run' });
      }

      // The images themselves. Guarded to a run's own directory.
      if (url.pathname === '/api/shot') {
        const bytes = shotBytes(q.id || '', q.file || '');
        if (!bytes) return json(res, 404, { error: 'no such image' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        return res.end(bytes);
      }

      // Looking is a write: it launches a browser and hits the network.
      if (url.pathname === '/api/look' || url.pathname === '/api/play') {
        if (req.method !== 'POST') return json(res, 405, { error: 'use POST — looking spawns a browser' });
        const body = await readBody(req);
        if (!body.target) return json(res, 400, { error: 'target is required (a URL or a local .html path)' });
        const run = url.pathname === '/api/play' ? await play(body.target, body) : await look(body.target, body);
        return json(res, 200, run);
      }

      if (url.pathname === '/api/run' && req.method === 'DELETE') return json(res, 200, forget(q.id || ''));
      if (url.pathname === '/api/forget') {
        if (req.method !== 'POST' && req.method !== 'DELETE') return json(res, 405, { error: 'use POST or DELETE' });
        return json(res, 200, forget(q.id || (await readBody(req)).id || ''));
      }

      if (url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'iris', ts: new Date().toISOString() });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }

    return serveStatic(res, url.pathname);
  });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      const data = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  }
}

export function serve({ port = process.env.IRIS_PORT || 7990 } = {}) {
  const server = createIrisServer();
  server.listen(port, () => {
    const s = stats();
    console.log(`\n  👁  iris serve → http://localhost:${port}`);
    console.log(`    ${s.runs} runs · ${s.passing} passing · browser: ${s.chrome || 'NOT FOUND — set IRIS_CHROME'}\n`);
  });
  return server;
}
