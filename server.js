import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeProvider } from './lib/claude.js';
import { createCodexProvider } from './lib/codex.js';

const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const CACHE_SECONDS = Math.max(30, Number(process.env.REFRESH_SECONDS ?? 60));
const allowRefresh = (process.env.ALLOW_TOKEN_REFRESH ?? 'true') !== 'false';

const providers = [
  createClaudeProvider({ dir: process.env.CLAUDE_DIR ?? join(homedir(), '.claude'), allowRefresh }),
  createCodexProvider({ dir: process.env.CODEX_DIR ?? join(homedir(), '.codex'), allowRefresh }),
];

// One cache entry per provider. A failed fetch keeps the last good numbers
// on screen (marked stale) instead of blanking the card.
const cache = new Map();

async function getProvider(p, force) {
  const entry = cache.get(p.id) ?? {};
  const age = entry.checkedAt ? (Date.now() - entry.checkedAt) / 1000 : Infinity;
  const minAge = force ? 15 : CACHE_SECONDS;
  if (age < minAge) return entry.result;
  if (entry.inflight) return entry.inflight;

  entry.inflight = (async () => {
    try {
      const data = await p.fetch();
      entry.good = { ...data, fetchedAt: new Date().toISOString() };
      entry.result = { id: p.id, name: p.name, ok: true, stale: false, ...entry.good };
    } catch (err) {
      console.error(`[${p.id}] ${err.message}`);
      entry.result = entry.good
        ? { id: p.id, name: p.name, ok: true, stale: true, error: err.message, ...entry.good }
        : { id: p.id, name: p.name, ok: false, error: err.message, plan: null, windows: [], notes: [] };
    } finally {
      entry.checkedAt = Date.now();
      entry.inflight = null;
    }
    return entry.result;
  })();
  cache.set(p.id, entry);
  return entry.inflight;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  try {
    if (url.pathname === '/api/usage') {
      const force = url.searchParams.get('force') === '1';
      const results = await Promise.all(providers.map((p) => getProvider(p, force)));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ providers: results, cacheSeconds: CACHE_SECONDS, serverTime: new Date().toISOString() }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(here, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }).end(html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`Usage dashboard on http://0.0.0.0:${PORT} (cache ${CACHE_SECONDS}s, token renewal ${allowRefresh ? 'on' : 'off'})`);
});
