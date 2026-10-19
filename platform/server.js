'use strict';

const path = require('path');
const express = require('express');

const dockermod = require('./src/docker');
const store = require('./src/instances');
const monitor = require('./src/monitor');
const instancesRouter = require('./src/routes/instances');
const configRouter = require('./src/routes/config');
const imagesRouter = require('./src/routes/images');
const openclawRouter = require('./src/routes/openclaw');
const sessionsRouter = require('./src/routes/sessions');
const featuresRouter = require('./src/routes/features');
const managementRouter = require('./src/routes/management');
const startupRouter = require('./src/routes/startup');
const terminal = require('./src/terminal');
const security = require('./src/security');
const operations = require('./src/operations');
const backups = require('./src/backups');
const BUILD = '2026.10.16-device-labels2';
const startedAt = new Date().toISOString();

const app = express();
const PORT = Number(process.env.MANAGER_PORT || 18080);

// ── Runtime state snapshot ───────────────────────────────────────────────────
// state: running | exited | paused | missing | error
const runtimeState = new Map(); // id -> { state, health, error }

async function syncRuntimeState() {
  let containers;
  try { containers = await dockermod.listContainersByLabel(); } catch {
    for (const entry of runtimeState.values()) { entry.error = 'Docker 不可达，状态暂未更新'; entry.state = 'unknown'; }
    return;
  }
  const byInstance = new Map(containers.filter(c => !c.name.includes('-rollback-')).map((c) => [c.instanceId, c]));

  for (const id of store.listInstanceIds()) {
    let entry = runtimeState.get(id) || { state: 'unknown', health: null, error: null };
    const inst = (() => { try { return store.loadInstance(id); } catch { return null; } })();
    if (!inst) { runtimeState.delete(id); continue; }

    const c = byInstance.get(id);
    if (!c) {
      entry.state = inst.containerId ? 'missing' : 'not-created';
    } else {
      entry.error = null;
      entry.dockerHealth = c.dockerHealth;
      entry.state = c.state; // docker states: created | running | paused | restarting | removing | exited | dead
      if (inst.containerId !== c.containerId) {
        inst.containerId = c.containerId;
        store.saveInstance(inst);
      }
    }
    runtimeState.set(id, entry);
    monitor.track(inst);
  }

  // Drop state for deleted instances.
  const known = new Set(store.listInstanceIds());
  for (const id of [...runtimeState.keys()]) {
    if (!known.has(id)) runtimeState.delete(id);
  }
}

function getState(id) {
  return runtimeState.get(id) || null;
}

// ── App wiring ───────────────────────────────────────────────────────────────
if(process.env.MANAGER_CONTAINERIZED==='1')app.use(require('./src/ssh-origins').middleware);
app.use(security.middleware);
app.get('/api/version', (req, res) => res.json({ build: BUILD, startedAt, capabilities: ['terminal', 'config-revisions', 'safe-recreate', 'session-auth', 'daily-backup', 'cross-platform', 'ssh-deployment', 'ssh-image-transfer', 'device-switching', 'saved-ssh-devices', 'ssh-auto-reconnect', 'ssh-device-editing'] }));
app.use('/api/instances', operations.middleware);
app.use('/api/instances/:id/chat/stream', express.json({ limit: '30mb' }));
app.use(express.json({ limit: '1mb' }));
if (process.env.OPENCLAW_WEB_LAUNCH_TOKEN) {
  const crypto = require('crypto');
  app.get('/_launcher/identity', (req,res) => res.json({identity:crypto.createHash('sha256').update(process.env.OPENCLAW_WEB_LAUNCH_TOKEN).digest('hex')}));
  app.post('/api/launcher/stop', (req,res) => {
    if (req.body?.token !== process.env.OPENCLAW_WEB_LAUNCH_TOKEN) return res.status(403).json({error:'后台身份校验失败'});
    res.json({ok:true});setImmediate(() => process.emit('SIGTERM'));
  });
}
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/system', async (req, res, next) => {
  try {
    const info = await dockermod.dockerInfo();
    res.json({
      ...info,
      memTotalGiB: Number((info.memTotal / 1024 ** 3).toFixed(1)),
      instances: store.listInstanceIds().length,
      build: BUILD, startedAt,
    });
  } catch (err) { next(err); }
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  monitor.addClient(res);
  req.on('close', () => monitor.removeClient(res));
});

app.get('/api/instances/:id/history', (req, res) => res.json({ samples: monitor.history.get(req.params.id) || [] }));
app.use('/api/instances', instancesRouter);
app.use('/api/instances', configRouter);
app.use('/api/instances', openclawRouter);
app.use('/api/instances', sessionsRouter);
app.use('/api/instances', featuresRouter);
app.use('/api/instances', managementRouter);
app.use('/api/images', imagesRouter);
app.use('/api/backups', backups.router);
app.use('/api/startup', startupRouter);
app.use('/api/connections', require('./src/routes/connections'));

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// Error handler (keeps JSON shape; dockerode errors get friendly messages).
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  console.error('[api-error]', err.statusCode || '', String(err.message || 'API failure').replace(/(?:sk-|token[=: ]|secret[=: ])[A-Za-z0-9_-]+/gi, '[redacted]').slice(0, 300));
  res.status(status).json({ error: dockermod.shortDockerError(err) });
});

// ── Boot ─────────────────────────────────────────────────────────────────────
let listenServer = null;

async function main() {
  await syncRuntimeState();
  instancesRouter.bind(getState, syncRuntimeState);
  listenServer = await new Promise((resolve) => {
    const srv = app.listen(PORT, process.env.MANAGER_BIND_ADDRESS || '127.0.0.1', () => {
      console.log(`OpenClaw Manager listening on http://127.0.0.1:${PORT}`);
      console.log(`Docker socket: ${dockermod.docker.modem.socketPath}`);
      resolve(srv);
    });
    srv.on('error', err => { console.error('监听失败:', err.message); process.exit(1); });
  });

  monitor.startLoops(getState);
  try{require('./src/routes/connections').startConnections();}catch{console.error('SSH 设备恢复失败，请检查设备存储和加密密钥；已保留原文件。');}
  terminal.parseUpgrades(listenServer);
  require('./src/retention').start();

  // periodic reconciliation so externally-stopped/removed containers reflect
  let reconciling = false;
  app.set('reconcileTimer', setInterval(async () => {
    if (reconciling) return; reconciling = true;
    try { await syncRuntimeState(); } catch {} finally { reconciling = false; }
  }, 5000));

  // Exported for the Electron shell (electron/main.js); harmless in bare node.
  app.set('listenServer', listenServer);
  return listenServer;
}

module.exports = { app };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  require('./src/routes/connections').closeConnections();
  monitor.stopLoops(); clearInterval(app.get('reconcileTimer'));
  require('./src/retention').stop();
  for (const ws of terminal.clients) ws.close();
  listenServer?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
main().catch((err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
