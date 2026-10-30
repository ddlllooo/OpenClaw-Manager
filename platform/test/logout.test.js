'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
process.env.MANAGER_AUTH_TOKEN = 'logout-fixture-token-0123456789abcdef';
const security = require('../src/security');
const app = express();
app.use(security.middleware);
app.get('/api/private', (req, res) => res.json({ ok: true }));
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: connected\n\n');
});
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!security.authenticated(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    const unbind = security.bindSession(req, () => ws.terminate());
    ws.once('close', unbind);
  });
});
let base, port;
test.before(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  port = server.address().port; process.env.MANAGER_PORT = String(port);
  base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
  for (const ws of wss.clients) ws.terminate();
  wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
});
async function session() {
  const response = await fetch(base + '/api/session', { headers: { Authorization: 'Bearer ' + security.managementToken() } });
  assert.equal(response.status, 200);
  return { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await response.json()).csrf, 'Content-Type': 'application/json' };
}

test('logout requires CSRF and trusted origin, revokes only the current session and expires its cookie', async () => {
  const first = await session(), second = await session();
  for (const headers of [{ Cookie: first.Cookie, 'Content-Type': 'application/json' }, { ...first, 'X-CSRF-Token': 'wrong' }, { ...first, Origin: 'https://attacker.invalid' }]) {
    assert.equal((await fetch(base + '/api/session', { method: 'DELETE', headers, body: '{}' })).status, 403);
  }
  assert.equal((await fetch(base + '/api/private', { headers: first })).status, 200);
  const response = await fetch(base + '/api/session', { method: 'DELETE', headers: first, body: '{}' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /openclaw_manager_session=;/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(base + '/api/private', { headers: first })).status, 401);
  assert.equal((await fetch(base + '/api/session', { headers: first })).status, 401);
  assert.equal((await fetch(base + '/api/private', { headers: second })).status, 200);
  const next = await session();
  assert.notEqual(next.Cookie, first.Cookie);
});

test('logout terminates existing SSE and WebSocket connections for that session', { timeout: 10000 }, async () => {
  const headers = await session();
  const stream = await new Promise((resolve, reject) => http.get(base + '/api/events', { headers }, response => {
    response.on('error', () => {}); response.resume(); resolve(response);
  }).on('error', reject));
  const streamClosed = new Promise(resolve => stream.once('close', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal`, { headers });
  await once(ws, 'open'); const socketClosed = once(ws, 'close');
  assert.equal((await fetch(base + '/api/session', { method: 'DELETE', headers, body: '{}' })).status, 200);
  await Promise.all([streamClosed, socketClosed]);
  assert.equal(ws.readyState, WebSocket.CLOSED);
  assert.equal((await fetch(base + '/api/private', { headers })).status, 401);
});
