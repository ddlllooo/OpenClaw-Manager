'use strict';

const express = require('express');
const { execFile } = require('child_process');
const store = require('../instances');
const dockermod = require('../docker');
const monitor = require('../monitor');

const router = express.Router();

// openclaw.json is the container's live config; the gateway hot-reloads most
// model changes and requires a restart for channel changes.
function execInInstance(instance, args, { timeout = 60_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', [
      'exec',
      '-e', `OPENCLAW_GATEWAY_TOKEN=${instance.gatewayToken}`,
      instance.containerName,
      'openclaw',
      ...args,
    ], { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = String(stderr || err.message).split('\n').filter(Boolean)[0] || err.message;
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

// The CLI prints a JSON envelope but may append human-readable lines; keep the
// outermost balanced JSON object.
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`输出中未找到 JSON: ${text.slice(0, 120)}`);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('输出 JSON 不完整');
}

// config get of a scalar path prints a bare/quoted JSON value; try the object
// parser first, then fall back to a whole-string JSON parse.
function extractJsonValue(text) {
  try {
    return extractJson(text);
  } catch {
    return JSON.parse(String(text || '').trim());
  }
}

async function requireRunning(req, res, next) {
  try {
    req.instance = store.loadInstance(req.params.id);
  } catch {
    return res.status(404).json({ error: '实例不存在' });
  }
  if (!req.instance.containerId) {
    return res.status(409).json({ error: '实例容器尚未创建' });
  }
  try {
    const inspected = await require('../docker').inspectContainer(req.instance.containerId);
    if (!inspected.State.Running) return res.status(409).json({ error: '实例未运行，请先启动' });
    next();
  } catch (err) { res.status(err.statusCode === 404 ? 409 : 503).json({ error: '容器不可用，请检查 Docker 或启动实例' }); }
}

async function requireReadable(req, res, next) {
  try {
    req.instance = store.loadInstance(req.params.id);
    req.instance.isRunning = false;
    if (req.instance.containerId) req.instance.isRunning = Boolean((await dockermod.inspectContainer(req.instance.containerId)).State.Running);
    next();
  } catch (err) { res.status(404).json({ error: '实例不存在或容器不可用' }); }
}
function friendlyCliError(err) {
  const msg = String(err.message || err);
  if (/Unknown model/i.test(msg)) return '模型不存在：请确认 provider/model 拼写，且 provider 已保存';
  if (/network connection error|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg)) {
    return '模型请求失败：无法连接 base_url（网络不可达或地址错误）';
  }
  if (/401|Unauthorized|invalid.*key|Incorrect API key/i.test(msg)) return '鉴权失败：api_key 无效或缺失';
  if (/429|rate limit/i.test(msg)) return '请求被限流：稍后重试';
  return msg.slice(0, 300);
}

// ── Model config (models.providers.* + agents.defaults.model) ───────────────
// New models get their own provider; existing shared providers are supported.
// Switching default points at the actual provider/model reference.
const MGR_PREFIX = 'openclaw-mgr-';
// Value the gateway CLI substitutes for secrets on read paths. It must never
// be written back to disk as a real key.
const REDACTED_SENTINEL = '__OPENCLAW_REDACTED__';
// Guard against persisting the gateway's redaction placeholder: a config.get
// round-trip must never turn `__OPENCLAW_REDACTED__` into a real apiKey.
function isRedactedSentinel(v) {
  return typeof v === 'string' && v.includes(REDACTED_SENTINEL);
}

async function readProvidersRaw(instance) {
  const cfg = JSON.parse(store.readOpenclawConfig(instance.id) || '{}').models?.providers || {};
  const providers = cfg && typeof cfg === 'object' ? cfg : {};
  const managed = Object.entries(providers)
    .filter(([k]) => k.startsWith(MGR_PREFIX))
    .map(([pid, p]) => ({ pid, ...(p && typeof p === 'object' ? p : {}) }));
  return { providers, managed };
}

async function readModelConfig(instance) {
  const { managed } = await readProvidersRaw(instance);
  let defaultModel = null;
  try {
    const dm = JSON.parse(store.readOpenclawConfig(instance.id) || '{}').agents?.defaults?.model;
    if (typeof dm === 'string') defaultModel = dm;
    else if (dm && typeof dm === 'object' && dm.primary) defaultModel = dm.primary;
  } catch { /* unset */ }
  const models = managed.flatMap((p) => (Array.isArray(p.models) ? p.models : [])
    .map((mm) => (typeof mm === 'string' ? { id: mm, name: mm } : { id: mm.id, name: mm.name || mm.id }))
    .filter((mm) => mm.id)
    .map((mm) => {
      // The raw entry may carry extra fields (contextWindow, maxTokens…); keep
      // contextWindow when it is a usable positive integer.
      const raw = Array.isArray(p.models)
        ? p.models.find((x) => x && typeof x === 'object' && x.id === mm.id)
        : null;
      const cw = raw && Number.isInteger(raw.contextWindow) && raw.contextWindow > 0 ? raw.contextWindow : null;
      return {
        ...mm,
        pid: p.pid,
        baseUrl: p.baseUrl || '',
        apiKeyMasked: p.apiKey ? maskSecret(p.apiKey) : '',
        hasApiKey: Boolean(p.apiKey),
        // This response only exposes a masked key; edits read stored values.
        keyReadable: Boolean(p.apiKey) && !isRedactedSentinel(p.apiKey),
        contextWindow: cw,
        input: Array.isArray(raw?.input) ? raw.input : null,
      };
    }));
  const active = managed.find((p) => defaultModel && defaultModel.startsWith(`${p.pid}/`));
  return {
    configured: managed.length > 0,
    providerId: active ? active.pid : (managed[0] ? managed[0].pid : null),
    baseUrl: active ? active.baseUrl : '',
    apiKeyMasked: active && active.apiKey ? maskSecret(active.apiKey) : '',
    hasApiKey: Boolean(active && active.apiKey),
    models,
    model: defaultModel ? defaultModel.split('/').slice(1).join('/') : (models[0] ? models[0].id : ''),
    isDefault: Boolean(defaultModel),
    defaultModel,
  };
}

function maskSecret(v) {
  const s = String(v);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

router.get('/:id/model', requireReadable, async (req, res, next) => {
  try {
    res.json(await readModelConfig(req.instance));
  } catch (err) { next(err); }
});

// Model mutations validate a complete candidate, then publish once atomically.
// This preserves unedited provider/model fields and shared-provider siblings.
const modelConfig = require('../model-config');
const metadata = require('../model-metadata');
const modelCatalog = new Map();
async function detectModel(instance, body, config, existingProvider) {
  const stored = modelConfig.find(config, body.model);
  const creds = modelConfig.credentials(config, body, stored?.provider || existingProvider);
  return metadata.detect({ ...creds, model: body.model, catalog: async () => {
    const cached = modelCatalog.get(instance.id);
    if (cached && cached.expires > Date.now()) return cached.rows;
    const { stdout } = await execInInstance(instance, ['models', 'list', '--all', '--json'], { timeout: 30000 });
    const rows = extractJson(stdout).models || [];
    const normalized = rows.map(row => ({ ...row, id: row.key?.split('/').slice(1).join('/') || row.id,
      input: typeof row.input === 'string' ? row.input.split('+') : row.input }));
    modelCatalog.set(instance.id, { rows: normalized, expires: Date.now() + 300000 });
    return normalized;
  } });
}
async function commitModelConfig(instance, before, config) {
  const content = JSON.stringify(config, null, 2) + '\n';
  if (JSON.stringify(JSON.parse(before)) === JSON.stringify(config)) return;
  await require('../validation').validate(instance, content);
  if (store.readOpenclawConfig(instance.id) !== before) {
    const error = new Error('配置已被其他操作修改，请重新加载后重试'); error.statusCode = 409; throw error;
  }
  store.writeOpenclawConfig(instance.id, content);
  monitor.broadcast('lifecycle', { id: instance.id, action: 'model-updated' });
}
router.post('/:id/model/detect', requireRunning, express.json(), async (req, res) => {
  try {
    const config = JSON.parse(store.readOpenclawConfig(req.instance.id) || '{}');
    const body = req.body || {};
    if (!body.model) throw new Error('请先填写模型名称');
    res.json(await detectModel(req.instance, body, config));
  } catch (err) { res.status(400).json({ error: friendlyCliError(err) }); }
});
router.put('/:id/model', requireRunning, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const before = store.readOpenclawConfig(req.instance.id) || '{}';
    const config = JSON.parse(before);
    const existing = modelConfig.find(config, body.model);
    const needsDetection = ['input', 'contextWindow'].some(k => body[k] === 'auto' || (!existing && !body[k]));
    const detected = needsDetection ? await detectModel(req.instance, body, config) : {};
    const result = modelConfig.update(config, null, body, detected);
    await commitModelConfig(req.instance, before, config);
    res.json({ ok: true, hint: `模型 ${result.entry.id} 已保存，网关热加载生效。`, model: result.ref,
      contextWindow: result.entry.contextWindow, input: result.entry.input });
  } catch (err) { res.status(err.statusCode || 400).json({ error: friendlyCliError(err) }); }
});
// Register literal routes before :modelId.
router.put('/:id/model/default', requireRunning, express.json(), async (req, res) => {
  try {
    const before = store.readOpenclawConfig(req.instance.id) || '{}';
    const config = JSON.parse(before);
    const id = String(req.body?.model || '');
    const stored = modelConfig.find(config, id);
    if (!stored) return res.status(404).json({ error: '模型不存在，请先添加' });
    const ref = `${stored.pid}/${id}`;
    modelConfig.setDefault(config, ref);
    await commitModelConfig(req.instance, before, config);
    res.json({ ok: true, hint: `已切换到 ${id}，网关热加载生效。`, model: ref });
  } catch (err) { res.status(err.statusCode || 400).json({ error: friendlyCliError(err) }); }
});
router.put('/:id/model/:modelId', requireRunning, express.json(), async (req, res) => {
  try {
    const oldId = req.params.modelId;
    const body = req.body || {};
    const before = store.readOpenclawConfig(req.instance.id) || '{}';
    const config = JSON.parse(before);
    const stored = modelConfig.find(config, oldId);
    if (!stored) return res.status(404).json({ error: '模型不存在' });
    const needsDetection = ['input', 'contextWindow'].some(k => body[k] === 'auto');
    const detected = needsDetection ? await detectModel(req.instance,
      { baseUrl: stored.provider.baseUrl, ...body, model: body.model || oldId }, config, stored.provider) : {};
    const result = modelConfig.update(config, oldId, body, detected);
    await commitModelConfig(req.instance, before, config);
    res.json({ ok: true, hint: `模型 ${result.entry.id} 已保存，未修改的字段已保留，网关热加载生效。`,
      model: result.ref, renamed: result.renamed });
  } catch (err) { res.status(err.statusCode || 400).json({ error: friendlyCliError(err) }); }
});
router.delete('/:id/model/:modelId', requireRunning, async (req, res) => {
  try {
    const before = store.readOpenclawConfig(req.instance.id) || '{}';
    const config = JSON.parse(before);
    modelConfig.remove(config, req.params.modelId);
    await commitModelConfig(req.instance, before, config);
    res.json({ ok: true, hint: `已删除模型 ${req.params.modelId}。` });
  } catch (err) { res.status(err.statusCode || 400).json({ error: friendlyCliError(err) }); }
});

// Test any saved model (by id), falling back to the current default.
router.post('/:id/model/test', requireRunning, express.json(), async (req, res, next) => {
  try {
    const requested = String((req.body || {}).model || '').trim();
    const all = await readModelConfig(req.instance);
    const entry = requested
      ? all.models.find((mm) => mm.id === requested)
      : all.models.find((mm) => all.defaultModel === `${mm.pid}/${mm.id}`);
    if (!entry) {
      return res.status(404).json({ error: requested ? `模型 ${requested} 尚未保存，请先保存后测试` : '模型不存在，请先添加' });
    }
    const r = await execInInstance(req.instance, [
      'agent', '-m', '连接测试，请回复：OK',
      '--session-key', `mgmt-model-test-${Date.now()}`,
      '--model', `${entry.pid}/${entry.id}`,
      '--json', '--timeout', '90',
    ], { timeout: 120_000 });
    const env = extractJson(r.stdout);
    if (env.ok === false) {
      return res.status(502).json({ ok: false, error: friendlyCliError(new Error(env.error && env.error.message || '测试失败')) });
    }
    const text = env.result && env.result.payloads && env.result.payloads[0] ? env.result.payloads[0].text : '';
    res.json({ ok: true, reply: String(text || '').slice(0, 200) });
  } catch (err) {
    res.status(502).json({ ok: false, error: friendlyCliError(err) });
  }
});

// ── Feishu channel (channels.feishu + plugins.entries.feishu) ────────────────
async function readFeishuConfig(instance) {
  if(instance.channelIsolation){
    const accounts=Object.values(instance.channelIsolation.accounts);let running=accounts.length>0;
    for(const target of accounts){try{const response=await fetch('http://'+target.ip+':18791/health',{headers:{Authorization:'Bearer '+target.token},redirect:'error',signal:AbortSignal.timeout(1500)});const health=await response.json();running=running&&response.ok&&health.activated===true;}catch{running=false;}}
    return {isolated:true,configured:accounts.length>0,pluginEnabled:false,appId:'',hasAppSecret:false,appSecretMasked:'',running,lastError:running?null:'独立收发未就绪；凭据由代理管理，不能回填网关'};
  }
  const raw = JSON.parse(store.readOpenclawConfig(instance.id) || '{}');
  const cfg = raw.channels?.feishu || null;
  const pluginEnabled = Boolean(raw.plugins?.entries?.feishu?.enabled);
  const configured = Boolean(cfg && cfg.appId);
  let running = false, lastError = null;
  if (configured && pluginEnabled && reqIsRunning(instance)) {
    try {
      const st = extractJson((await execInInstance(instance, ['channels', 'status', '--channel', 'feishu', '--probe', '--json', '--timeout', '15000'], { timeout: 40_000 })).stdout);
      const acc = st.channelAccounts && st.channelAccounts.feishu && st.channelAccounts.feishu[0];
      running = Boolean(acc && acc.running);
      lastError = (acc && acc.probe && acc.probe.error) || acc && acc.lastError || null;
    } catch (err) {
      lastError = friendlyCliError(err);
    }
  }
  return {
    configured,
    pluginEnabled,
    appId: cfg && cfg.appId ? cfg.appId : '',
    appSecretMasked: cfg && cfg.appSecret ? maskSecret(cfg.appSecret) : '',
    hasAppSecret: Boolean(cfg && cfg.appSecret),
    running,
    lastError,
  };
}

function reqIsRunning(instance) {
  // cheap check: container object exists and docker says running
  return instance.isRunning === true;
}

router.get('/:id/feishu', requireReadable, async (req, res, next) => {
  try {
    res.json(await readFeishuConfig(req.instance));
  } catch (err) { next(err); }
});

router.put('/:id/feishu', requireRunning, express.json(), async (req, res, next) => {
  try {
    if(req.instance.channelIsolation)return res.status(409).json({error:'飞书已隔离，请使用访问设置或 isolate-feishu.cjs；不能恢复网关内凭据和原生插件'});
    const { appId, appSecret, enabled } = req.body || {};
    const aid = String(appId || '').trim();
    if (!aid) return res.status(400).json({ error: '请填写 App ID' });
    let secret = String(appSecret || '').trim();
    if (!secret) {
      const prev = await readFeishuConfig(req.instance);
      if (!prev.configured) return res.status(400).json({ error: '请填写 App Secret' });
      const raw = JSON.parse(store.readOpenclawConfig(req.instance.id) || '{}').channels?.feishu?.appSecret;
      secret = typeof raw === 'string' ? raw : '';
      if (!secret) return res.status(400).json({ error: '请填写 App Secret' });
    }
    if (isRedactedSentinel(secret)) throw new Error('不能将脱敏占位符保存为 Secret');
    const previous=JSON.parse(store.readOpenclawConfig(req.instance.id)||'{}');
    if(enabled!==false&&!(previous.channels?.feishu?.appId&&previous.plugins?.entries?.feishu?.enabled)&&!(process.env.MANAGER_NATIVE_PLUGIN_ALLOWLIST||'').split(',').map(v=>v.trim()).includes('@openclaw/feishu'))return res.status(403).json({error:'新增原生飞书需要管理员明确信任；建议使用 isolate-feishu.cjs 独立适配'});
    const inventory=extractJson((await execInInstance(req.instance,['plugins','list','--json'])).stdout);
    if(!inventory.plugins?.some(p=>p.id==='feishu'))throw Error('请先使用插件审查入口安装固定版本，或使用独立飞书适配；凭据表单不会自动安装并接受权限');
    await require('../gateway-rpc').rpc(req.instance,'plugins.setEnabled',{pluginId:'feishu',enabled:enabled!==false});
    const existing = JSON.parse(store.readOpenclawConfig(req.instance.id) || '{}');
    const enable = enabled === false ? false : true;
    existing.channels||={};existing.channels.feishu={...(existing.channels.feishu||{}),enabled:enable,appId:aid,appSecret:secret};
    const content=JSON.stringify(existing,null,2)+'\n';await require('../validation').validate(req.instance,content);store.writeOpenclawConfig(req.instance.id,content);
    // Channel config only applies on gateway restart.
    await require('../storage').assertCanStart(req.instance.id);
    await dockermod.restartContainer(req.instance.containerId);
    if (!await require('../lifecycle').ready(req.instance.port)) throw new Error('飞书保存后网关未就绪，请检查配置');
    monitor.track(req.instance);
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'feishu-updated' });
    res.json({ ok: true, hint: '飞书凭证已保存并重启实例，WebSocket 连接建立后即可在飞书中对话。' });
  } catch (err) {
    res.status(400).json({ error: friendlyCliError(err) });
  }
});

// Connection probe without saving (uses stored credentials).
router.post('/:id/feishu/test', requireRunning, async (req, res, next) => {
  try {
    if(req.instance.channelIsolation){const status=await readFeishuConfig(req.instance);return res.json({ok:status.running,running:status.running,error:status.lastError,isolated:true});}
    const st = extractJson((await execInInstance(req.instance, ['channels', 'status', '--channel', 'feishu', '--probe', '--json', '--timeout', '20000'], { timeout: 45_000 })).stdout);
    const acc = st.channelAccounts && st.channelAccounts.feishu && st.channelAccounts.feishu[0];
    if (!acc) return res.status(409).json({ ok: false, error: '飞书频道尚未配置' });
    const probeError = (acc.probe && acc.probe.error) || acc.lastError || null;
    res.json({
      ok: Boolean(acc.running) && !probeError,
      running: Boolean(acc.running),
      error: probeError,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: friendlyCliError(err) });
  }
});

// ── Chat: one agent turn via the gateway ─────────────────────────────────────
router.post('/:id/chat', requireRunning, express.json({ limit: '256kb' }), async (req, res, next) => {
  try {
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ error: '消息不能为空' });
    const sessionKey = String((req.body && req.body.sessionKey) || 'mgmt-chat').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 64) || 'mgmt-chat';
    const idem = `mgr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const r = await execInInstance(req.instance, [
      'agent', '-m', message,
      '--session-key', sessionKey,
      '--json', '--timeout', '240',
    ], { timeout: 300_000 });
    const env = extractJson(r.stdout);
    if (env.ok === false) {
      return res.status(502).json({ error: friendlyCliError(new Error(env.error && env.error.message || 'agent 调用失败')) });
    }
    const payloads = (env.result && env.result.payloads) || [];
    const text = payloads.map((p) => p && p.text).filter(Boolean).join('\n');
    const meta = (env.result && env.result.meta && env.result.meta.agentMeta) || {};
    res.json({
      ok: true,
      reply: text,
      model: meta.model ? `${meta.provider ? `${meta.provider}/` : ''}${meta.model}` : null,
      sessionId: meta.sessionId || null,
      durationMs: (env.result && env.result.meta && env.result.meta.durationMs) || null,
      usage: meta.usage || null,
      idem,
    });
  } catch (err) {
    res.status(502).json({ error: friendlyCliError(err) });
  }
});

module.exports = router;
