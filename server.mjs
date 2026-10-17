import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workspace } from './lib/workspace.mjs';
import { Config, redact } from './lib/config.mjs';
import { Gemini } from './lib/gemini.mjs';
import { runAgent } from './lib/agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export async function createServer({ workspaceDir = path.join(here, 'workspace'), dataDir = path.join(here, '.araina'), gemini: g } = {}) {
  await fs.mkdir(workspaceDir, { recursive: true });
  const ws = new Workspace(workspaceDir), config = await new Config(dataDir).load();
  const gemini = g || new Gemini(config);
  const sessions = new Map(); // in-memory chat history per session

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) req.destroy(); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      // Local-only hardening: reject foreign Host (DNS rebinding) and require a custom header on writes (CSRF).
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'Bad host' });
      if (req.method !== 'GET' && req.headers['x-araina'] !== '1') return json(res, 403, { error: 'Missing X-Araina header' });

      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(await fs.readFile(path.join(here, 'public/index.html'))); }
      if (url.pathname === '/api/config') {
        if (req.method === 'POST') { await config.set(await body(req)); }
        if (req.method === 'DELETE') { await config.clearKey(); }
        return json(res, 200, config.public());
      }
      if (url.pathname === '/api/models') return json(res, 200, { models: await gemini.listModels() });
      if (req.method === 'POST' && url.pathname === '/api/test') { const m = await gemini.listModels(); return json(res, 200, { ok: true, modelCount: m.length }); }
      if (req.method === 'GET' && url.pathname === '/api/files') return json(res, 200, { files: await ws.list() });
      if (url.pathname === '/api/file') {
        const p = url.searchParams.get('path') || '';
        if (req.method === 'GET') return json(res, 200, { content: await ws.read(p) });
        if (req.method === 'PUT') return json(res, 200, await ws.write(p, (await body(req)).content ?? ''));
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const { sessionId = 'default', message } = await body(req);
        const history = sessions.get(sessionId) || [];
        history.push({ role: 'user', parts: [{ text: message }] });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const emit = e => res.write(`data: ${JSON.stringify(e)}\n\n`);
        try { sessions.set(sessionId, await runAgent({ gemini, ws, history, emit })); }
        catch (e) { emit({ type: 'error', error: redact(e.message, config.apiKey) }); history.pop(); }
        emit({ type: 'done' }); return res.end();
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) { if (!res.headersSent) json(res, e.status || 500, { error: redact(e.message, config.apiKey) }); else res.end(); }
  });
  return { server, config, ws };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = await createServer(); const port = Number(process.env.PORT) || 3000;
  server.listen(port, '127.0.0.1', () => console.log(`Araina running at http://localhost:${port}`));
}
