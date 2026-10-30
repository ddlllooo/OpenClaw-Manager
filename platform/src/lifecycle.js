'use strict';
const store = require('./instances');
const dm = require('./docker');
const http = require('http');
const fs = require('fs');
const path = require('path');
async function ready(port, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const base=await require('./gateway-address').base(port);
    const ok = await new Promise(resolve => {
      const req = http.get(`${base}/readyz`, { timeout: 2000 }, res => {
        let body = ''; res.on('data', c => { body += c; });
        res.on('end', () => { try { resolve(res.statusCode === 200 && JSON.parse(body).ready === true); } catch { resolve(false); } });
      });
      req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}
async function replace(instance, start = true) {
  if (start) await require('./storage').assertCanStart(instance.id);
  let old = null;
  if (instance.containerId) {
    try { old = await dm.inspectContainer(instance.containerId); }
    catch (err) { if (err.statusCode !== 404) throw err; }
  }
  const original = JSON.parse(JSON.stringify(instance));
  const wasRunning = Boolean(old && old.State.Running);
  const env = store.parseEnv(store.readEnvFile(instance.id));
  const oldContainer = old && dm.getContainer(old.Id);
  const createOptions = {
      instanceId: instance.id, name: instance.containerName, image: old ? old.Image : instance.image,
      hostPort: instance.port, hostIP: '127.0.0.1',
      configDir: store.configDir(instance.id), workspaceDir: store.workspaceDir(instance.id), authDir: store.authDir(instance.id),
      env: Object.entries(env).map(([k,v]) => `${k}=${v}`),
      nanoCpus: instance.resources?.nanoCpus || 0, memory: instance.resources?.memoryBytes || 0,
      cpuShares: instance.resources?.cpuShares || 0, pidsLimit: instance.resources?.pidsLimit || 0,
      template: old,
  };
  dm.validateInstanceOptions?.(createOptions);

  let newId = null, renamed = false;
  try {
    if (oldContainer) {
      if (wasRunning) await dm.stopContainer(old.Id, 30);
      await oldContainer.rename({ name: `${instance.containerName}-rollback-${Date.now()}` });
      renamed = true;
    }
    newId = await dm.createInstanceContainer(createOptions);
    if (start) {
      await dm.startContainer(newId);
      if (!await ready(instance.port)) throw new Error('新容器未就绪，已尝试回滚至原容器');
    }
    instance.containerId = newId;
    instance.envPending = false;
    instance.configPending = false;
    instance.appliedEnvKeys = Object.keys(env);
    delete instance.lastError;
    store.saveInstance(instance);
    // Keep the stopped original as a rollback artifact, without changing mounts.
    if (old) {
      instance.rollbackContainerId = old.Id;
      store.saveInstance(instance);
    }
  } catch (err) {
    if (newId) await dm.removeContainer(newId, true).catch(() => {});
    if (oldContainer && renamed) await oldContainer.rename({ name: instance.containerName });
    if (oldContainer && wasRunning) {await require('./storage').assertCanStart(instance.id);await dm.startContainer(old.Id);}
    Object.assign(instance, original);
    store.saveInstance(original);
    throw err;
  }
  // A cleanup/storage error must never enter the replacement rollback path.
  if (start) {
    try { require('./retention').instanceSucceeded(instance); }
    catch { console.warn('升级已成功，自动清理登记暂缓'); }
  }
  return instance;
}
async function start(instance) {
  await require('./storage').assertCanStart(instance.id);
  require('./container-policy').assertAgentConfig(JSON.parse(store.readOpenclawConfig(instance.id) || '{}'));
  if (instance.envPending) return replace(instance, true);
  if (instance.containerId) {
    try {
      await dm.inspectContainer(instance.containerId);
      await dm.updateResources(instance.containerId, dm.resourceOptions(instance.resources || {}));
      await dm.getContainer(instance.containerId).update({RestartPolicy:require('./startup-settings').restartPolicy(instance.id)});
      await dm.startContainer(instance.containerId).catch(err => { if (err.statusCode !== 304) throw err; });
      return instance;
    } catch (err) { if (err.statusCode !== 404) throw err; }
  }
  instance.containerId = null;
  return replace(instance, true);
}
async function restart(instance) {
  await require('./storage').assertCanStart(instance.id);
  require('./container-policy').assertAgentConfig(JSON.parse(store.readOpenclawConfig(instance.id) || '{}'));
  try {
    if (instance.envPending || !instance.containerId) return await replace(instance, true);
    await dm.restartContainer(instance.containerId);
    if (!await ready(instance.port)) throw new Error('重启后网关未就绪');
    instance.configPending = false;
    store.saveInstance(instance);
    return instance;
  } catch (err) {
    if (instance.configPending || instance.envPending) {
      for (const [name, pending] of [['openclaw.json', instance.configPending], ['.env', instance.envPending]]) {
        const file = path.join(store.configDir(instance.id), name);
        const backup = fs.existsSync(file + '.last-good') ? file + '.last-good' : file + '.bak.1';
        if (pending && fs.existsSync(backup)) store.atomicWrite(file, fs.readFileSync(backup));
      }
      instance.configPending = false; instance.envPending = false;
      store.saveInstance(instance);
      if (instance.containerId) {
        await dm.restartContainer(instance.containerId);
        if (!await ready(instance.port)) throw new Error('配置已回滚，但原网关尚未就绪，请检查日志');
      }
      throw new Error('新配置未就绪，已恢复上次配置并重启原网关');
    }
    throw err;
  }
}
module.exports = {
  replace:(instance,shouldRun=true)=>require('./run-intent').track(instance,shouldRun,()=>replace(instance,shouldRun)),
  start:instance=>require('./run-intent').track(instance,true,()=>start(instance)),
  restart:instance=>require('./run-intent').track(instance,true,()=>restart(instance)),ready,
};
