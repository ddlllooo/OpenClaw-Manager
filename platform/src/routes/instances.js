'use strict';

const express = require('express');
const dockermod = require('../docker');
const store = require('../instances');
const monitor = require('../monitor');
const lifecycle = require('../lifecycle');
const allocator = require('../resource-planner');

const router = express.Router();

// Runtime state of instances, refreshed from Docker. Managed by server.js so
// both the routes and the monitor loops see the same snapshot.
let stateProvider = () => ({});
let syncFunction = async () => {};

function bind(stateFn, syncFn) {
  stateProvider = stateFn;
  syncFunction = syncFn;
}

function getState(id) {
  // stateProvider (server.js getState) already returns the state entry.
  const entry = stateProvider(id);
  return entry || null;
}

function requireInstance(req, res, next) {
  try {
    req.instance = store.loadInstance(req.params.id);
    next();
  } catch {
    res.status(404).json({ error: '实例不存在' });
  }
}

function publicView(instance) {
  const st = getState(instance.id) || {};
  return {
    id: instance.id,
    name: instance.name,
    image: instance.image,
    port: instance.port,
    uiUrl: `http://127.0.0.1:${instance.port}/`,
    envPending: Boolean(instance.envPending),
    configPending: Boolean(instance.configPending),
    resources: instance.resources,
    createdAt: instance.createdAt,
    state: st.state || 'unknown',
    health: st.health || null,
    error: st.error || null,
    dockerHealth: st.dockerHealth || null,
    lastError: instance.lastError || null,
    containerId: instance.containerId || null,
  };
}

// ── List / create ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const instances = store.listInstanceIds().map((id) => {
    try { return publicView(store.loadInstance(id)); } catch { return null; }
  }).filter(Boolean);
  const info = await dockermod.dockerInfo().catch(() => null);
  res.json({
    instances,
    system: info && {
      ...info,
      memTotalGiB: Number((info.memTotal / 1024 ** 3).toFixed(1)),
    },
  });
});

// GET /api/instances/kept — instances whose data was archived on delete.
router.get('/kept', (req, res, next) => {
  try {
    const kept = store.listKeptInstanceIds().filter((k) => !store.listInstanceIds().includes(k.id));
    res.json({ kept });
  } catch (err) { next(err); }
});

// POST /api/instances/kept/:id/restore — bring an archived instance back.
router.post('/kept/:id/restore', async (req, res, next) => {
  try {
    const inst = store.restoreKeptInstance(req.params.id);
    await syncFunction();
    monitor.broadcast('lifecycle', { id: inst.id, action: 'restored' });
    res.json({ instance: publicView(inst) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

async function resourcePlan(excludeId = null) {
  const [info, containers] = await Promise.all([
    dockermod.dockerInfo(), dockermod.listResourceContainers(),
  ]);
  // Read records after Docker responds: another create may have reserved its
  // slot while the snapshot was being fetched.
  const records = store.listInstanceIds().map(id => store.loadInstance(id));
  return allocator.planResources(info, records, containers, excludeId);
}

router.get('/recommendations', async (req, res, next) => {
  try { res.json(await resourcePlan()); } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  let reservationId;
  try {
    const body = req.body || {};
    const id = store.randomId();
    const name = (body.name || `实例-${id}`).toString().slice(0, 40);
    const image = (body.image || dockermod.DEFAULT_IMAGE).toString();
    const purpose = require('../image-purpose').imagePurpose([image]);
    if (['manager', 'build-base'].includes(purpose.kind)) {
      return res.status(400).json({ error: `${purpose.purpose}不能用于创建 OpenClaw 实例，请选择 OpenClaw 运行镜像` });
    }

    // Optional: clone model/channel configuration from an existing instance's
    // openclaw.json (everything except the per-instance gateway section).
    let clonedFrom = null;
    if (body.cloneFrom) {
      const src = store.loadInstance(String(body.cloneFrom));
      if(src.security?.profile==='ssh-sandbox-v1')throw new Error('安全实例请先创建独立目标实例，再运行 secure-instance.cjs 迁移；不能复用原实例的沙箱凭据');
      const srcCfg = store.readOpenclawConfig(src.id);
      if (srcCfg) {
        const parsed = JSON.parse(srcCfg);
        delete parsed.gateway; // never share tokens/bindings across instances
        if (body.cloneChannels !== true) delete parsed.channels;
        clonedFrom = { id: src.id, name: src.name, config: parsed };
      }
    }

    const instance = await allocator.withAllocationLock(async () => {
      const plan = await resourcePlan();
      const defaults = plan.recommended || { pidsLimit: 192 };
      const resources = normalizeResources({
        cpus: defaults.cpus, memory: defaults.memory, pidsLimit: defaults.pidsLimit,
        ...(body.resources || {}),
      });
      allocator.assertCapacity(resources, plan);
      const instance = {
        id, name, image, resources, port: store.allocatePort(body.port),
        gatewayToken: dockermod.randomToken(), containerName: `openclaw-${id}`,
        containerId: null, createdAt: new Date().toISOString(),
      };
      allocator.pending.set(id, resources);
      reservationId = id;
      store.saveInstance(instance);
      store.initInstanceFiles(instance);
      if (body.storage) await require('../storage').configurePolicy(id, body.storage);
      return instance;
    });
    const resources = instance.resources;
    const port = instance.port;
    if (clonedFrom) {
      store.mergeOpenclawConfig(id, clonedFrom.config);
    }

    // Use the local image store; only hit the registry when the image is not
    // cached locally (pre-pull via /api/images/pull avoids this at create time).
    if (await dockermod.imageExists(image)) {
      monitor.broadcast('pull', { id, status: 'done', image, fromCache: true });
    } else {
      monitor.broadcast('pull', { id, status: 'started', image });
      try {
        await dockermod.pullImage(image, (evt) => {
          monitor.broadcast('pull', {
            id,
            status: evt.status || 'progress',
            layer: evt.id || null,
            current: evt.progressDetail && evt.progressDetail.current,
            total: evt.progressDetail && evt.progressDetail.total,
            progress: evt.progress || null,
          });
        });
      } catch (err) {
        // Keep the record so the user can retry start after fixing the pull.
        instance.lastError = dockermod.shortDockerError(err);
        store.saveInstance(instance);
        monitor.broadcast('pull', { id, status: 'error', error: instance.lastError });
        return res.status(502).json({
          error: `镜像拉取失败: ${instance.lastError}。可先在“本地镜像”中预下载镜像后重试。`,
          id,
        });
      }
      monitor.broadcast('pull', { id, status: 'done', image });
    }

    const envFromDotEnv = store.parseEnv(store.readEnvFile(id));
    const env = Object.entries(envFromDotEnv).map(([k, v]) => `${k}=${v}`);

    instance.containerId = await dockermod.createInstanceContainer({
      instanceId: id,
      name: instance.containerName,
      image,
      hostPort: port,
      hostIP: '127.0.0.1',
      configDir: store.configDir(id),
      workspaceDir: store.workspaceDir(id),
      authDir: store.authDir(id),
      env,
      cpuShares: resources.cpuShares || undefined,
      nanoCpus: resources.cpus ? Math.round(resources.cpus * 1e9) : undefined,
      memory: resources.memoryBytes || undefined,
      pidsLimit: resources.pidsLimit || undefined,
    });
    store.saveInstance(instance);

    await require('../storage').assertCanStart(id);
    await dockermod.startContainer(instance.containerId);
    monitor.track(instance);
    await syncFunction();

    monitor.broadcast('lifecycle', { id, action: 'created', state: 'running', clonedFrom: clonedFrom ? clonedFrom.name : null });
    res.status(201).json({ instance: publicView(instance) });
  } catch (err) {
    next(err);
  } finally {
    if (reservationId) allocator.pending.delete(reservationId);
  }
});

function normalizeResources(input) {
  const r = {};
  if (input.cpus !== undefined && input.cpus !== null && input.cpus !== '') {
    const cpus = Number(input.cpus);
    if (!Number.isFinite(cpus) || cpus <= 0) throw new Error('CPU 核数需大于 0，请设置明确上限');
    r.cpus = cpus;
    r.nanoCpus = Math.round(cpus * 1e9);
  }
  if (input.memory !== undefined && input.memory !== null && input.memory !== '') {
    r.memoryBytes = parseMemory(input.memory);
    if (!Number.isSafeInteger(r.memoryBytes) || r.memoryBytes < 64 * 1024 * 1024) throw new Error('内存需至少 64m，请设置明确上限');
  }
  if (input.cpuShares !== undefined && input.cpuShares !== null && input.cpuShares !== '') {
    const shares = Number(input.cpuShares);
    if (!Number.isInteger(shares) || shares < 2 || shares > 262144) throw new Error('cpuShares 需在 2-262144');
    r.cpuShares = shares;
  }
  if (input.pidsLimit !== undefined && input.pidsLimit !== null && input.pidsLimit !== '') {
    const pids = Number(input.pidsLimit);
    if (!Number.isInteger(pids) || pids <= 0) throw new Error('pidsLimit 必须为正整数');
    r.pidsLimit = pids;
  }
  return r;
}

function parseMemory(v) {
  if (typeof v === 'number') return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgb]?i?b?)\s*$/i.exec(String(v));
  if (!m) throw new Error('内存格式应为如 512m / 1g / 1024');
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase().replace('ib', '').replace('b', '');
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit];
  if (!mult) throw new Error('未知内存单位');
  return Math.round(n * mult);
}

router.get('/:id/token', requireInstance, (req, res) => res.json({ token: req.instance.gatewayToken }));

// ── Rename / error handling ──────────────────────────────────────────────────
router.patch('/:id', requireInstance, express.json(), async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: '实例名称不能为空' });
    req.instance.name = name;
    store.saveInstance(req.instance);
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'renamed', name });
    res.json({ instance: publicView(req.instance) });
  } catch (err) { next(err); }
});

// Clear a stale lastError once the user has addressed it (e.g. pre-pulled the
// image) so the detail view stops showing the failure banner.
router.post('/:id/clear-error', requireInstance, async (req, res, next) => {
  try {
    delete req.instance.lastError;
    store.saveInstance(req.instance);
    await syncFunction();
    res.json({ instance: publicView(req.instance) });
  } catch (err) { next(err); }
});

// ── Lifecycle ────────────────────────────────────────────────────────────────
async function runWithCapacity(instance, action) {
  return allocator.withAllocationLock(async () => {
    const latest = store.loadInstance(instance.id);
    requireCreationFinished(latest.id);
    const current = latest.containerId ? await dockermod.inspectContainer(latest.containerId).catch(err => {
      if (err.statusCode === 404) return null;
      throw err;
    }) : null;
    let target = latest.resources || {};
    if (action === lifecycle.restart && current && !latest.envPending) {
      // A plain Docker restart retains its actual limits, including external
      // changes. A start, in contrast, reapplies the persisted desired limits.
      const h = current.HostConfig || {};
      const actualCpu = h.NanoCpus || (h.CpuQuota > 0 ? h.CpuQuota / (h.CpuPeriod || 100000) * 1e9 : 0);
      target = { ...target, nanoCpus: Math.max(target.nanoCpus || (target.cpus || 0) * 1e9, actualCpu),
        memoryBytes: Math.max(target.memoryBytes || 0, h.Memory || 0) };
    }
    allocator.assertCapacity(target, await resourcePlan(latest.id),
      current?.State?.Running ? target : null);
    await action(latest);
    return latest;
  });
}

function requireCreationFinished(id) {
  if (allocator.pending.has(id)) {
    const err = new Error('实例正在创建，请等待镜像拉取和容器创建完成');
    err.statusCode = 409;
    throw err;
  }
}

router.post('/:id/start', requireInstance, async (req, res, next) => {
  try {
    req.instance = await runWithCapacity(req.instance, lifecycle.start);
    monitor.track(req.instance);
    await syncFunction();
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'start', state: 'running' });
    res.json({ instance: publicView(req.instance) });
  } catch (err) { next(err); }
});

// Rebuild the container definition after it was removed (or never created
// because the initial image pull failed).
async function recreateContainer(instance) {
  const env = Object.entries(store.parseEnv(store.readEnvFile(instance.id)))
    .map(([k, v]) => `${k}=${v}`);
  const r = instance.resources || {};
  instance.containerId = await dockermod.createInstanceContainer({
    instanceId: instance.id,
    name: instance.containerName,
    image: instance.image,
    hostPort: instance.port,
    hostIP: '127.0.0.1',
    configDir: store.configDir(instance.id),
    workspaceDir: store.workspaceDir(instance.id),
    authDir: store.authDir(instance.id),
    env,
    cpuShares: r.cpuShares || undefined,
    nanoCpus: r.nanoCpus || undefined,
    memory: r.memoryBytes || undefined,
    pidsLimit: r.pidsLimit || undefined,
  });
  store.saveInstance(instance);
}

router.post('/:id/stop', requireInstance, async (req, res, next) => {
  try {
    await require('../run-intent').stop(req.instance.id);
    if (req.instance.containerId) {
      try {
        await dockermod.stopContainer(req.instance.containerId);
      } catch (err) {
        if (!/not running|is not running/i.test(err.message || '')) throw err;
      }
    }
    await syncFunction();
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'stop', state: 'exited' });
    res.json({ instance: publicView(req.instance) });
  } catch (err) { next(err); }
});

router.post('/:id/restart', requireInstance, async (req, res, next) => {
  try {
    req.instance = await runWithCapacity(req.instance, lifecycle.restart);
    monitor.track(req.instance);
    await syncFunction();
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'restart', state: 'running' });
    res.json({ instance: publicView(req.instance) });
  } catch (err) { next(err); }
});

// Gateway-only restart: the gateway process is the container's pid 1 and the
// in-container CLI (`openclaw gateway restart`) needs a service manager the
// image doesn't ship, so restarting the container is the only reliable way to
// bounce the gateway process itself. Unlike a full restart this also waits
// for /healthz to come back, so a "保存配置 → 重启网关" flow returns with the
// new config actually live.
router.post('/:id/gateway-restart', requireInstance, async (req, res, next) => {
  try {
    if (!req.instance.containerId) {
      return res.status(409).json({ error: '实例容器尚未创建，请先启动实例' });
    }
    req.instance = await runWithCapacity(req.instance, lifecycle.restart);
    monitor.track(req.instance);
    await syncFunction();

    // Wait (bounded) for the gateway to answer /healthz on its host port.
    const deadline = Date.now() + 60_000;
    const gatewayBase=await require('../gateway-address').base(req.instance.port);
    const probe = () => new Promise((resolve) => {
      const r = require('http').get(`${gatewayBase}/healthz`, { timeout: 2000 }, (res2) => {
        res2.resume();
        resolve(res2.statusCode >= 200 && res2.statusCode < 300);
      });
      r.on('timeout', () => { r.destroy(); resolve(false); });
      r.on('error', () => resolve(false));
    });
    let healthy = false;
    while (Date.now() < deadline) {
      healthy = await probe();
      if (healthy) break;
      await new Promise((r2) => setTimeout(r2, 2000));
    }

    monitor.broadcast('lifecycle', {
      id: req.instance.id,
      action: 'gateway-restart',
      state: healthy ? 'running' : 'starting',
      healthy,
    });
    if (!healthy) {
      return res.status(504).json({
        error: '网关已重启但 60 秒内未通过健康检查，请稍后查看健康状态或容器日志。',
      });
    }
    res.json({ ok: true, hint: '网关已重启并通过健康检查。' });
  } catch (err) { next(err); }
});

// DELETE ?keepData=1: remove the container AND drop the instance from the
// list, but keep config/workspace/auth on disk (they contain credentials; do
// not drop them silently). The data dirs are renamed to <id>.kept so a future
// instance can never collide with the leftover credentials. The container
// removal always runs first; if it fails the request errors out and neither
// the record nor the data is touched, so the user can retry.
router.delete('/:id', requireInstance, async (req, res, next) => {
  try{await require('../run-intent').stop(req.instance.id,{reason:'delete'});}catch(error){return next(error);}
  if(req.instance.security?.profile==='ssh-sandbox-v1')return res.status(409).json({error:'请先使用 secure-instance.cjs --rollback 保留执行卷快照并停止执行容器，再通过平台删除实例'});
  try {
    if (req.instance.containerId) {
      try {
        // Stop first (running containers resist a plain force-remove on some
        // daemons), then remove with force. Only "already gone" is tolerated.
        try {
          await dockermod.stopContainer(req.instance.containerId, 10);
        } catch (err) {
          if (err.statusCode !== 404 && err.statusCode !== 304 && !/not running|is not running|already stopped|no such container/i.test(err.message || '')) throw err;
        }
        await dockermod.removeContainer(req.instance.containerId, true);
      } catch (err) {
        // The container may already have been removed out-of-band.
        const inspected = await dockermod.inspectContainer(req.instance.containerId).catch(inspectError => { if (inspectError.statusCode === 404) return null; throw inspectError; });
        if (inspected) {
          throw new Error(`容器删除失败: ${dockermod.shortDockerError(err)}`);
        }
      }
    }
    monitor.untrack(req.instance.id);
    if (req.query.keepData === '1') {
      store.archiveInstanceData(req.instance.id);
    }
    store.deleteInstanceRecord(req.instance.id);
    await syncFunction();
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'deleted', keepData: req.query.keepData === '1' });
    res.json({ ok: true, keptData: req.query.keepData === '1' });
  } catch (err) { next(err); }
});

// ── Runtime resource update ──────────────────────────────────────────────────
router.patch('/:id/resources', requireInstance, async (req, res, next) => {
  try {
    await allocator.withAllocationLock(async () => {
      const latest = store.loadInstance(req.instance.id);
      requireCreationFinished(latest.id);
      const merged = { ...(latest.resources || {}), ...normalizeResources(req.body || {}) };
      allocator.assertCapacity(merged, await resourcePlan(latest.id), latest.resources || {});
      if (latest.containerId) {
        await dockermod.updateResources(latest.containerId, dockermod.resourceOptions(merged)).catch(err => {
          if (err.statusCode !== 404) throw err;
        });
      }
      store.saveInstance({ ...latest, resources: merged });
    });
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'resources-updated' });
    res.json({ instance: publicView(store.loadInstance(req.instance.id)) });
  } catch (err) { next(err); }
});

// ── Logs ─────────────────────────────────────────────────────────────────────
router.get('/:id/logs', requireInstance, async (req, res, next) => {
  try {
    if (!req.instance.containerId) return res.json({ logs: '' });
    const tail = Math.min(5000, Math.max(10, Number(req.query.tail) || 200));
    const logs = await dockermod.getContainerLogs(req.instance.containerId, tail);
    res.json({ logs: require('../confidential').scrub(logs, req.instance) });
  } catch (err) { next(err); }
});

router.bind = bind;
module.exports = router;
