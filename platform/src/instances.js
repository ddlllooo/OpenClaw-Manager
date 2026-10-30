'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

// Data root: packaged Electron app points OPENCLAW_DATA_DIR at a writable
// per-user directory; bare `node server.js` keeps the in-repo ./data layout.
const DATA_ROOT = process.env.OPENCLAW_DATA_DIR
  || path.join(__dirname, '..', 'data', 'instances');
const PORT_MIN = 19000;
const PORT_MAX = 19999;

function instancesRoot() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  return DATA_ROOT;
}

function instanceDir(id) {
  if (!/^[a-z0-9_-]{1,80}$/i.test(String(id))) throw new Error('非法实例 ID');
  const file=path.join(path.dirname(instancesRoot()),'storage',id+'.json');
  if(fs.existsSync(file)){
    const s=JSON.parse(fs.readFileSync(file,'utf8'));
    if(s.hard?.backend==='apfs-volume'&&s.hard.mountpoint){
      if(!new RegExp('^/Volumes/oc-'+id+'-[a-f0-9]{8}$').test(s.hard.mountpoint))throw new Error('APFS 实例卷路径不合法');
      return s.hard.mountpoint;
    }
  }
  return path.join(instancesRoot(), id);
}
function atomicWrite(file, content, backup = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (backup && fs.existsSync(file)) {
    for (let i = 2; i >= 1; i--) if (fs.existsSync(`${file}.bak.${i}`)) fs.renameSync(`${file}.bak.${i}`, `${file}.bak.${i+1}`);
    fs.copyFileSync(file, `${file}.bak.1`); fs.chmodSync(`${file}.bak.1`, 0o600);
  }
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      if(process.getuid?.()===0){const owner=fs.statSync(fs.existsSync(file)?file:path.dirname(file));fs.fchownSync(fd,owner.uid,owner.gid);}
      fs.writeFileSync(fd, content); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function revision(content) { return crypto.createHash('sha256').update(content || '').digest('hex'); }


function instanceFile(id) {
  return path.join(instanceDir(id), 'instance.json');
}

function configDir(id) {
  return path.join(instanceDir(id), 'openclaw');
}

function workspaceDir(id) {
  return path.join(instanceDir(id), 'workspace');
}

function authDir(id) {
  return path.join(instanceDir(id), 'auth');
}

function listInstanceIds() {
  const root = instancesRoot();
  const ids = fs.readdirSync(root).filter((name) => {
    if (name.endsWith('.kept')) return false; // archived data, not a live instance
    try {
      return fs.statSync(instanceDir(name)).isDirectory() && fs.existsSync(instanceFile(name));
    } catch {
      return false;
    }
  });
  // Newest instance first (creation time from the record itself).
  return ids.sort((a, b) => {
    const ta = (() => { try { return loadInstance(a).createdAt || ''; } catch { return ''; } })();
    const tb = (() => { try { return loadInstance(b).createdAt || ''; } catch { return ''; } })();
    return ta < tb ? 1 : -1;
  });
}

// Directories archived via archiveInstanceData (<id>.kept), available for
// restore; sorted newest first by directory mtime.
function listKeptInstanceIds() {
  const root = instancesRoot();
  return fs.readdirSync(root)
    .filter((name) => name.endsWith('.kept'))
    .filter((name) => { try { return fs.statSync(path.join(root, name)).isDirectory(); } catch { return false; } })
    .map((name) => {
      const dir = path.join(root, name);
      const id = name.replace(/\.kept$/, '');
      let name2 = null, createdAt = null;
      try {
        const inst = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
        name2 = inst.name || null;
        createdAt = inst.createdAt || null;
      } catch { /* record may be absent; keep the dir restorable anyway */ }
      return { id, name: name2 || id, createdAt, mtime: fs.statSync(dir).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Restore a previously archived instance: put the directories back under the
// original id (kept data is never merged into an existing instance). The
// container will be recreated on next start because the old container no
// longer exists; the port is re-validated so it cannot collide.
function restoreKeptInstance(id) {
  const dir = instanceDir(id);
  const kept = `${dir}.kept`;
  if (!fs.existsSync(kept)) throw new Error('保留数据不存在或已恢复');
  if (fs.existsSync(dir)) throw new Error(`实例 ${id} 已存在，不能重复恢复`);
  fs.renameSync(kept, dir);
  try {
    const inst = loadInstance(id);
    if (inst.port) {
      const used = usedPorts();
      used.delete(inst.port);
      if (used.has(inst.port) || !isPortFreeOnHost(inst.port)) {
        inst.port = allocatePort(null);
      }
    }
    inst.containerId = null;
    delete inst.rollbackContainerId;
    delete inst.lastError;
    const cfg = JSON.parse(readOpenclawConfig(id) || '{}');
    cfg.gateway ||= {}; cfg.gateway.controlUi ||= {};
    cfg.gateway.controlUi.allowedOrigins = [`http://127.0.0.1:${inst.port}`, `http://localhost:${inst.port}`];
    writeOpenclawConfig(id, JSON.stringify(cfg, null, 2) + '\n');
    saveInstance(inst);
  } catch (err) {
    // Roll back so the user doesn't end up with a half-broken live instance.
    fs.renameSync(dir, kept);
    throw err;
  }
  return loadInstance(id);
}

function loadInstance(id) {
  const raw = fs.readFileSync(instanceFile(id), 'utf8');
  const data = JSON.parse(raw);
  if (data.id !== id) throw new Error(`instance.json id mismatch: ${data.id} != ${id}`);
  return data;
}

function saveInstance(instance) {
  fs.mkdirSync(instanceDir(instance.id), { recursive: true });
  const file = instanceFile(instance.id);
  atomicWrite(file, JSON.stringify(instance, null, 2));
}

function deleteInstanceRecord(id) {
  fs.rmSync(instanceDir(id), { recursive: true, force: true });
}

// Keep the instance's data dirs (config/workspace/auth — they hold gateway
// credentials) but detach them from the instance namespace so the deleted
// instance disappears from the list. Renaming to <id>.kept also frees the
// original path, so a future instance with the same id can never inherit the
// old credentials. No restore path: to reuse the data, copy the files back by
// hand into a new instance's directories.
function archiveInstanceData(id) {
  const dir = instanceDir(id);
  const kept = `${dir}.kept`;
  if (fs.existsSync(kept)) throw new Error('保留数据已存在，请先恢复或另行备份');
  fs.renameSync(dir, kept);
}

function usedPorts() {
  const ports = new Set();
  for (const id of listInstanceIds()) {
    try {
      const inst = loadInstance(id);
      if (inst.port) ports.add(inst.port);
    } catch { /* skip unreadable records */ }
  }
  return ports;
}

function randomId() {
  return crypto.randomBytes(8).toString('hex');
}

function allocatePort(preferred) {
  const used = usedPorts();
  if (preferred) {
    const p = Number(preferred);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('端口需在 1024-65535 之间');
    if (used.has(p)) throw new Error(`端口 ${p} 已被其他实例占用`);
    if (!isPortFreeOnHost(p)) throw new Error(`端口 ${p} 已被宿主机其他进程占用`);
    return p;
  }
  for (let i = 0; i < 200; i++) {
    const p = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1));
    if (!used.has(p) && isPortFreeOnHost(p)) return p;
  }
  throw new Error('无法分配可用端口');
}

function isPortFreeOnHost(port) {
  const host=require('./host-control');
  if(host.enabled())return host.requestSync('port-free',{port:Number(port)}).free;
  try {
    if (process.env.MANAGER_CONTAINERIZED === '1') {
      // The manager's loopback is a different network namespace from the host.
      const published = execFileSync('docker', ['ps', '--format', '{{.Ports}}'], {encoding:'utf8', windowsHide:true, timeout:5000});
      return !new RegExp(`:${Number(port)}->`).test(published);
    }
    execFileSync(process.execPath, ['-e', `const s=require('net').createServer();s.on('error',()=>process.exit(1));s.listen(${Number(port)},'127.0.0.1',()=>s.close());`], { stdio: 'ignore', windowsHide:true, timeout: 3000, env:{...process.env,ELECTRON_RUN_AS_NODE:'1'} });
    return true;
  } catch {
    return false;
  }
}

// Write initial openclaw.json + .env for a fresh instance so the gateway can
// boot without running interactive onboarding.
function initInstanceFiles(instance) {
  const cfg = configDir(instance.id);
  const ws = workspaceDir(instance.id);
  const auth = authDir(instance.id);
  for (const dir of [cfg, ws, auth]) fs.mkdirSync(dir, { recursive: true });

  const openclawJson = {
    gateway: {
      bind: 'lan',
      port: 18789,
      auth: { token: instance.gatewayToken },
      // Control UI is served via the host-mapped port; the gateway rejects
      // browser origins it doesn't allow, so whitelist ours up front.
      controlUi: {
        allowedOrigins: [
          `http://127.0.0.1:${instance.port}`,
          `http://localhost:${instance.port}`,
        ],
      },
    },
  };
  require('./container-policy').agentConfig(openclawJson);
  atomicWrite(path.join(cfg, 'openclaw.json'), JSON.stringify(openclawJson, null, 2) + '\n');

  const envLines = [
    `# instance ${instance.id} - managed by openclaw-docker-manager`,
    `OPENCLAW_GATEWAY_TOKEN=${instance.gatewayToken}`,
    'OPENCLAW_SKIP_ONBOARDING=1',
    'OPENCLAW_DISABLE_BONJOUR=1',
    `OPENCLAW_TZ=${process.env.OPENCLAW_TZ || 'Asia/Shanghai'}`,
    '',
  ].join('\n');
  atomicWrite(path.join(cfg, '.env'), envLines);

  // The official image runs as node (uid 1000); make our bind mounts writable.
  chownToNode(cfg);
  chownToNode(ws);
  chownToNode(auth);
}

function chownToNode(dir) {
  if (process.platform === 'win32') return; // Docker Desktop maps Windows mount ownership.
  if (process.platform === 'linux' && process.env.MANAGER_CONTAINERIZED !== '1' && process.getuid?.() > 0) return;
  try {
    execFileSync('chown', ['-R', '1000:1000', dir]);
  } catch (err) {
    // Non-root cannot chown on macOS bind mounts; Docker Desktop handles uid mapping.
    console.warn(`chown failed for ${dir}: ${err.message}`);
  }
}

function readOpenclawConfig(id) {
  const file = path.join(configDir(id), 'openclaw.json');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function writeOpenclawConfig(id, content) {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须是 JSON 对象');
  if (content.includes('__OPENCLAW_REDACTED__')) throw new Error('不能保存脱敏占位符');
  fs.mkdirSync(configDir(id), { recursive: true });
  require('./container-policy').assertAgentConfig(parsed);
  const record = fs.existsSync(instanceFile(id)) ? loadInstance(id) : null;
  if(record?.security?.profile==='ssh-sandbox-v1')require('../security/profile.cjs').assert(parsed,record.security.targets);
  require('../security/plugin-provision.cjs').assertConfig(parsed,record?.pluginIsolation);
  require('../security/feishu-policy.cjs').assertConfig(parsed,record?.channelIsolation);
  atomicWrite(path.join(configDir(id), 'openclaw.json'), content, true);
}

// Shallow-merge a parsed config object into an instance's openclaw.json
// (used when cloning configuration from another instance at create time).
function mergeOpenclawConfig(id, patch) {
  const file = path.join(configDir(id), 'openclaw.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const merged = { ...current, ...patch };
  require('./container-policy').assertAgentConfig(merged);
  const record = loadInstance(id);
  if(record.security?.profile==='ssh-sandbox-v1')require('../security/profile.cjs').assert(merged,record.security.targets);
  require('../security/plugin-provision.cjs').assertConfig(merged,record.pluginIsolation);
  require('../security/feishu-policy.cjs').assertConfig(merged,record.channelIsolation);
  fs.mkdirSync(configDir(id), { recursive: true });
  atomicWrite(file, JSON.stringify(merged, null, 2) + '\n', true);
}

function readEnvFile(id) {
  const file = path.join(configDir(id), '.env');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function writeEnvFile(id, content) {
  const record=fs.existsSync(instanceFile(id))?loadInstance(id):null;
  if(record?.channelIsolation&&Object.keys(parseEnv(content)).some(key=>/^(FEISHU|LARK)_/i.test(key)||(record.channelIsolation.secretEnvNames||[]).includes(key)))throw Error('独立飞书凭据不能写回网关环境');
  fs.mkdirSync(configDir(id), { recursive: true });
  atomicWrite(path.join(configDir(id), '.env'), content, true);
}

// Parse KEY=VALUE lines (ignores comments/blank lines).
function parseEnv(content) {
  const out = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

module.exports = {
  DATA_ROOT,
  atomicWrite,
  revision,
  instancesRoot,
  instanceDir,
  configDir,
  workspaceDir,
  authDir,
  listInstanceIds,
  listKeptInstanceIds,
  restoreKeptInstance,
  loadInstance,
  saveInstance,
  deleteInstanceRecord,
  archiveInstanceData,
  allocatePort,
  initInstanceFiles,
  readOpenclawConfig,
  writeOpenclawConfig,
  mergeOpenclawConfig,
  readEnvFile,
  writeEnvFile,
  parseEnv,
  randomId,
  PORT_MIN,
  PORT_MAX,
};
