'use strict';
const crypto = require('crypto');
const PREFIX = 'openclaw-mgr-';
function pidFor(id) { return PREFIX + crypto.createHash('sha1').update(id).digest('hex').slice(0, 8); }
function find(config, id) {
  for (const [pid, provider] of Object.entries(config.models?.providers || {})) {
    if (!pid.startsWith(PREFIX)) continue;
    const index = (provider.models || []).findIndex(m => (typeof m === 'string' ? m : m.id) === id);
    if (index >= 0) {
      const raw = provider.models[index];
      return { pid, provider, index, entry: typeof raw === 'string' ? { id: raw, name: raw } : raw };
    }
  }
  return null;
}
function credentials(config, body, stored) {
  const source = body.copyKeyFrom ? find(config, body.copyKeyFrom)?.provider : null;
  if (body.copyKeyFrom && !source) throw new Error('凭据来源模型不存在');
  const typedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (typedKey.includes('__OPENCLAW_REDACTED__') || /\*{4}/.test(typedKey)) throw new Error('不能保存脱敏后的 api_key，请留空保留原值');
  const apiKey = typedKey || source?.apiKey || stored?.apiKey;
  const baseUrl = String(body.baseUrl || source?.baseUrl || stored?.baseUrl || '').trim().replace(/\/$/, '');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('base_url 必须为有效的 http(s) 接口地址');
  if (!apiKey) throw new Error('请填写 api_key，或复用现有模型的凭据');
  return { baseUrl, apiKey };
}
function patchEntry(previous, id, body, detected = {}) {
  const next = { ...previous, id, name: previous.name || id };
  if (previous.id !== id && (!previous.name || previous.name === previous.id)) next.name = id;
  for (const key of ['input', 'contextWindow']) {
    const specified = Object.hasOwn(body, key) && body[key] !== '' && body[key] !== null;
    const automatic = body[key] === 'auto' || (!specified && !previous.id);
    if (automatic) {
      if (!detected[key]) throw new Error(`无法自动识别${key === 'input' ? '输入模态' : '上下文长度'}，请手动填写后保存`);
      next[key] = detected[key];
    } else if (specified) next[key] = body[key];
    // Blank/omitted edits preserve the stored value, including an unset field.
  }
  if (next.contextWindow !== undefined) {
    const value = Number(next.contextWindow);
    if (!Number.isInteger(value) || value < 1024 || value > 10000000) throw new Error('上下文长度需为 1024-10000000 的整数（tokens）');
    next.contextWindow = value;
  }
  if (next.input !== undefined && (!Array.isArray(next.input) || !next.input.includes('text') || next.input.some(v => !['text', 'image'].includes(v)))) throw new Error('输入模态需为文本，或文本＋图像');
  return next;
}
function replaceReferences(config, oldRef, newRef) {
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (key === oldRef) { node[newRef] = node[key]; delete node[key]; }
      const actual = key === oldRef ? newRef : key;
      if (node[actual] === oldRef) node[actual] = newRef;
      else visit(node[actual]);
    }
  }
  visit(config.agents); // primary, fallbacks, per-agent overrides, aliases
}
function update(config, oldId, body, detected) {
  const id = String(body.model || oldId || '').trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('model 名称不合法');
  const stored = find(config, oldId || id);
  if (oldId && !stored) throw new Error('模型不存在');
  if (oldId && oldId !== id && stored && find(config, id)) throw new Error('模型名称已存在');
  const creds = credentials(config, body, stored?.provider);
  const previous = stored?.entry || {};
  const entry = patchEntry(previous, id, body, detected);
  config.models ||= {}; config.models.providers ||= {};
  let pid = stored?.pid || pidFor(id);
  const sharedCredentialChange = stored && stored.provider.models.length > 1 &&
    (JSON.stringify(creds.apiKey) !== JSON.stringify(stored.provider.apiKey) || creds.baseUrl !== stored.provider.baseUrl);
  if (!stored) {
    if (config.models.providers[pid]) throw new Error('模型供应商标识冲突');
    config.models.providers[pid] = { ...creds, api: 'openai-completions', models: [entry] };
  } else if (sharedCredentialChange) {
    pid = pidFor(id);
    if (pid === stored.pid || config.models.providers[pid]) pid += '-' + crypto.randomBytes(3).toString('hex');
    config.models.providers[pid] = { ...stored.provider, ...creds, models: [entry] };
    stored.provider.models.splice(stored.index, 1);
  } else {
    Object.assign(stored.provider, creds);
    stored.provider.models[stored.index] = entry;
  }
  const oldRef = stored && `${stored.pid}/${oldId || id}`;
  const ref = `${pid}/${id}`;
  if (oldRef && oldRef !== ref) replaceReferences(config, oldRef, ref);
  if (!oldId && body.setDefault !== false) setDefault(config, ref);
  return { entry, ref, renamed: Boolean(oldId && oldId !== id) };
}
function setDefault(config, ref) {
  config.agents ||= {}; config.agents.defaults ||= {};
  const old = config.agents.defaults.model;
  config.agents.defaults.model = old && typeof old === 'object' ? { ...old, primary: ref } : ref;
}
function remove(config, id) {
  const stored = find(config, id);
  if (!stored) throw new Error('模型不存在');
  const ref = `${stored.pid}/${id}`;
  if (JSON.stringify(config.agents || {}).includes(JSON.stringify(ref))) throw new Error('模型仍被默认模型、备用模型或代理配置引用，请先切换后删除');
  stored.provider.models.splice(stored.index, 1);
  if (!stored.provider.models.length) delete config.models.providers[stored.pid];
}
module.exports = { find, credentials, patchEntry, update, remove, setDefault, pidFor };
