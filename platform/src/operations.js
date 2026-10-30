'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./instances');
const busy = new Map();
async function middleware(req, res, next) {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  const parts = req.path.split('/').filter(Boolean);
  const key = parts[0] === 'kept' ? parts[1] : (parts[0] || 'create');
  if(/^[a-z0-9_-]{1,80}$/i.test(key)&&parts[1]!=='stop'&&require('./storage').isMigrating(key))return res.status(423).json({error:'实例正在 APFS 数据迁移，禁止修改或解除保护'});
  if(/^[a-z0-9_-]{1,80}$/i.test(key)&&fs.existsSync(path.join(store.instanceDir(key),'manager','security','migration.lock')))return res.status(423).json({error:'该实例正在安全迁移或回滚，请等待完成'});
  // Cancellation must be able to reach the gateway while its chat stream owns
  // the instance operation lock. It cannot change container/config state.
  if (req.method === 'POST' && parts[1] === 'chat' && parts[2] === 'abort' && parts.length === 3) return next();
  // Keep cancellation, data maintenance and stop available while all new work
  // is fenced. This check runs before body-dependent task dispatch.
  if(/^[a-z0-9_-]{1,80}$/i.test(key)&&fs.existsSync(path.join(store.instanceDir(key),'instance.json'))&&parts[1]!=='storage'&&parts[1]!=='stop'&&parts[1]!=='diagnostics'&&req.method!=='DELETE'){
    try{await require('./storage').assertAdmission(key);}catch(error){return res.status(error.statusCode||507).json({error:error.message,code:'INSTANCE_STORAGE_PROTECTED',retryable:false});}
  }
  const maintenance = require('./maintenance-guard');
  if (maintenance.active) return res.status(409).json({ error: maintenance.conflict().message });
  if (busy.has(key)) return res.status(409).json({ error: '该实例已有操作执行中，请等待完成', operation: busy.get(key) });
  const operation = { description: req.method + ' ' + req.path };
  busy.set(key, operation);
  const release = () => { if (busy.get(key) === operation) busy.delete(key); };
  res.locals ||= {};
  res.locals.releaseManagerOperation = release;
  // Do not release on client disconnect: the Docker operation may still run.
  res.once('finish', release);
  const sendJson = res.json.bind(res);
  res.json = body => { release(); return sendJson(body); };
  // Model routes validate then atomically publish; they never need a partial
  // CLI rollback. Restoring their earlier snapshot on a conflict would erase
  // an external writer's newer configuration.
  const configMutation = /\/feishu(\/|$)/.test(req.path);
  if (configMutation && /^[a-z0-9_-]+$/i.test(key)) {
    const before = store.readOpenclawConfig(key);
    const json = res.json.bind(res);
    res.json = body => {
      if (res.statusCode >= 400 && before !== null) {
        try {
          store.atomicWrite(path.join(store.configDir(key), 'openclaw.json'), before);
        } catch { return json({ error: '操作失败，配置自动回滚失败，请从备份恢复', rollbackFailed: true }); }
      }
      return json(body);
    };
  }
  const startedAt = Date.now();
  res.once('finish', () => {
    try {
      const dir = path.dirname(store.instancesRoot());
      const file = path.join(dir, 'manager-audit.jsonl');
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - startedAt }) + '\n', { mode: 0o600 });
    } catch { /* no secrets or request bodies are logged */ }
  });
  next();
}
module.exports = { middleware, busy };
