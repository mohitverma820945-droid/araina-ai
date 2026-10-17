import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Workspace } from '../lib/workspace.mjs';
import { Config, redact } from '../lib/config.mjs';
import { Gemini } from '../lib/gemini.mjs';
import { runAgent } from '../lib/agent.mjs';
import { createServer } from '../server.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'araina-'));
const sse = events => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
const cand = parts => ({ candidates: [{ content: { parts } }] });

test('workspace blocks path traversal and symlink escape', async () => {
  const d = await tmp(), out = await tmp(), ws = new Workspace(d);
  await assert.rejects(ws.read('../etc/passwd'), /escapes/);
  await assert.rejects(ws.write('../x.txt', 'x'), /escapes/);
  await fs.symlink(out, path.join(d, 'link'));
  await assert.rejects(ws.write('link/x.txt', 'x'), /Symlink escapes/);
});

test('workspace writes, checkpoints previous version, searches', async () => {
  const d = await tmp(), ws = new Workspace(d);
  assert.equal((await ws.write('src/a.js', 'one')).created, true);
  assert.equal((await ws.write('src/a.js', 'two')).created, false);
  const cps = await fs.readdir(path.join(d, '.araina/checkpoints'));
  assert.equal(await fs.readFile(path.join(d, '.araina/checkpoints', cps[0], 'src/a.js'), 'utf8'), 'one');
  assert.deepEqual((await ws.search('TWO')).map(h => h.path), ['src/a.js']);
});

test('config masks key and redacts it from errors', async () => {
  delete process.env.GEMINI_API_KEY;
  const c = await new Config(await tmp()).load(); await c.set({ apiKey: 'AIza-secret-1234' });
  assert.equal(c.public().masked, '••••1234'); assert.ok(!JSON.stringify(c.public()).includes('secret'));
  assert.ok(!redact('bad key AIza-secret-1234', c.apiKey).includes('secret'));
  assert.equal((await fs.stat(c.file)).mode & 0o777, 0o600);
});

test('gemini adapter: auth header, no key / no model errors, retry on 429, API error surfaced', async () => {
  const cfg = { apiKey: '', model: '' }; let calls = 0, seen;
  const g = new Gemini(cfg, { retries: 1, fetchImpl: async (u, i) => { calls++; seen = i.headers; return calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : sse([cand([{ text: 'hi' }])]); } });
  await assert.rejects(g.listModels(), /not configured/);
  cfg.apiKey = 'k'; await assert.rejects(g.stream([]).next(), /No Gemini model/);
  cfg.model = 'm'; const evs = []; for await (const e of g.stream([])) evs.push(e);
  assert.equal(calls, 2); assert.equal(seen['x-goog-api-key'], 'k'); assert.equal(evs[0].parts[0].text, 'hi');
  const bad = new Gemini(cfg, { fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 403 }) });
  await assert.rejects(bad.listModels(), /403: quota/);
});

test('agent executes a real tool call, feeds result back, then answers', async () => {
  const d = await tmp(), ws = new Workspace(d); let n = 0, secondBody;
  const g = new Gemini({ apiKey: 'k', model: 'm' }, { fetchImpl: async (u, i) => {
    n++; if (n === 2) secondBody = JSON.parse(i.body);
    return n === 1 ? sse([cand([{ functionCall: { name: 'write_file', args: { path: 'index.html', content: '<h1>Hi</h1>' } }, thoughtSignature: 'sig' }])]) : sse([cand([{ text: 'Done!' }])]);
  } });
  const events = []; await runAgent({ gemini: g, ws, history: [{ role: 'user', parts: [{ text: 'make page' }] }], emit: e => events.push(e) });
  assert.equal(await ws.read('index.html'), '<h1>Hi</h1>');
  assert.ok(events.some(e => e.type === 'tool' && e.ok) && events.some(e => e.text === 'Done!'));
  assert.equal(secondBody.contents.at(-1).parts[0].functionResponse.name, 'write_file');
  assert.equal(secondBody.contents[1].parts[0].thoughtSignature, 'sig'); // signature round-tripped
});

test('HTTP server: CSRF header, host check, file API, config never leaks key', async () => {
  const { server } = await createServer({ workspaceDir: await tmp(), dataDir: await tmp() });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'x-araina': '1', 'content-type': 'application/json' };
  assert.equal((await fetch(base + '/api/config', { method: 'POST', body: '{}' })).status, 403);
  const evil = await new Promise(r => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/config', headers: { host: 'evil.com' }, agent: false }, x => { x.resume(); r(x.statusCode); }));
  assert.equal(evil, 403);
  await fetch(base + '/api/config', { method: 'POST', headers: H, body: JSON.stringify({ apiKey: 'AIza-SUPERSECRET9', model: 'm' }) });
  const cfg = await (await fetch(base + '/api/config')).text(); assert.ok(!cfg.includes('SUPERSECRET') && cfg.includes('9'));
  await fetch(base + '/api/file?path=a/b.txt', { method: 'PUT', headers: H, body: JSON.stringify({ content: 'yo' }) });
  assert.equal((await (await fetch(base + '/api/file?path=a/b.txt')).json()).content, 'yo');
  assert.equal((await fetch(base + '/api/file?path=../../x')).status, 500);
  assert.equal((await fetch(base + '/')).status, 200);
  server.closeAllConnections(); server.close();
});
