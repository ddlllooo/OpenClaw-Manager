'use strict';

const http = require('http');
const history = new Map();

const STATS_INTERVAL_MS = Number(process.env.STATS_INTERVAL_MS || 3000);
const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 10000);

// ── SSE event bus ────────────────────────────────────────────────────────────
const clients = new Set();

function addClient(res) {
  clients.add(res);
}

function removeClient(res) {
  clients.delete(res);
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { if (!res.write(payload)) { clients.delete(res); res.end(); } } catch { clients.delete(res); }
  }
}

// ── Monitored instance registry ──────────────────────────────────────────────
// id -> { port, containerId, image }
const monitored = new Map();

function track(instance) {
  monitored.set(instance.id, {
    id: instance.id,
    port: instance.port,
    containerId: instance.containerId,
    image: instance.image,
  });
}

function untrack(id) {
  monitored.delete(id);
}

// ── Health probe ─────────────────────────────────────────────────────────────
// /healthz (liveness) and /readyz (readiness) on the published host port are
// unauthenticated per OpenClaw docs.
function probe(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', chunk => { if (body.length < 4096) body += chunk; });
      res.on('end', () => { let valid = false; try { const data = JSON.parse(body); valid = data.ok === true || data.ready === true; } catch {} resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 && valid, code: res.statusCode }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 0 }); });
    req.on('error', () => resolve({ ok: false, code: 0 }));
  });
}

async function healthCheck(entry) {
  const base = await require('./gateway-address').base(entry.port);
  const [live, ready] = await Promise.all([
    probe(`${base}/healthz`),
    probe(`${base}/readyz`),
  ]);
  return {
    id: entry.id,
    health: {
      live: live.ok,
      liveCode: live.code,
      ready: ready.ok,
      readyCode: ready.code,
      checkedAt: Date.now(),
    },
  };
}

// ── Loops ────────────────────────────────────────────────────────────────────
let timers = [];
let stopped = true;
async function pooled(entries, fn, concurrency = 3) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (cursor < entries.length) { const entry = entries[cursor++]; try { await fn(entry); } catch {} }
  }));
}
function loop(fn, interval) {
  const tick = async () => {
    try { await fn(); } catch {} finally { if (!stopped) { const timer = setTimeout(tick, interval); timer.unref(); timers.push(timer); if (timers.length > 10) timers = timers.slice(-10); } }
  };
  tick();
}
function startLoops(getState) {
  if (!stopped) return;
  stopped = false;
  loop(() => pooled([...monitored.values()], async entry => {
    const runtime = getState(entry.id);
    if (!runtime || runtime.state !== 'running') return;
    const stats = await require('./docker').getStats(entry.containerId);
    const memUsed = Math.max(0, stats.memUsed - stats.memCache);
    const sample = { id: entry.id, cpuPercent: Number(stats.cpuPercent.toFixed(2)), memUsed,
      memLimit: stats.memLimit, memPercent: stats.memLimit ? Number((memUsed / stats.memLimit * 100).toFixed(2)) : 0,
      net: stats.net, ts: Date.now() };
    const samples = history.get(entry.id) || [];
    samples.push(sample); if (samples.length > 120) samples.shift(); history.set(entry.id, samples);
    broadcast('stats', sample);
  }), STATS_INTERVAL_MS);
  loop(() => pooled([...monitored.values()], async entry => {
    const runtime = getState(entry.id);
    if (!runtime || runtime.state !== 'running') return;
    const result = await healthCheck(entry);
    result.state = runtime.state; runtime.health = result.health;
    broadcast('health', result);
  }), HEALTH_INTERVAL_MS);
  const heartbeat = setInterval(() => { for (const res of clients) { try { if (!res.write(': heartbeat\n\n')) res.end(); } catch {} } }, 15000);
  heartbeat.unref(); timers.push(heartbeat);
}
function stopLoops() { stopped = true; for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } timers = []; for (const client of clients) client.end(); clients.clear(); }
module.exports = { addClient, removeClient, broadcast, track, untrack, startLoops, stopLoops,
  STATS_INTERVAL_MS, HEALTH_INTERVAL_MS, history, probe };
