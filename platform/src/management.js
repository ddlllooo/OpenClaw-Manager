'use strict';
const store = require('./instances');
const fail = (message, statusCode = 400) => { const e = new Error(message); e.statusCode = statusCode; throw e; };
function text(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail(`${label}不合法`);
  return value.trim();
}
function agentId(value) { if (!/^[a-z][a-z0-9-]{0,47}$/.test(value || '')) fail('Agent ID 需为小写字母开头，包含字母、数字或连字符，最长 48 位'); return value; }
function agents(config) {
  if (config.agents?.entries) return Object.entries(config.agents.entries).map(([id, row]) => ({ ...row, id }));
  if (config.agents?.list?.length) return config.agents.list;
  return [{ id: 'main' }];
}
function choices(config) {
  const map = new Map();
  for (const [pid, provider] of Object.entries(config.models?.providers || {})) for (const m of provider.models || []) {
    const id = typeof m === 'string' ? m : m.id; if (id) map.set(`${pid}/${id}`, { ref: `${pid}/${id}`, name: typeof m === 'string' ? m : m.name || id, input: m.input });
  }
  const add = ref => { if (typeof ref === 'string' && ref.includes('/') && !map.has(ref)) map.set(ref, { ref, name: ref }); };
  const visit = model => { if (typeof model === 'string') add(model); else { add(model?.primary); (model?.fallbacks || []).forEach(add); } };
  visit(config.agents?.defaults?.model); visit(config.agents?.defaults?.imageModel);
  for (const row of agents(config)) visit(row.model);
  Object.keys(config.agents?.defaults?.models || {}).forEach(add);
  return [...map.values()];
}
function modelRef(config, value) {
  if (typeof value !== 'string' || !choices(config).some(c => c.ref === value)) fail('请选择当前配置中的模型');
  return value;
}
function failover(config, body) {
  config.agents ||= {}; config.agents.defaults ||= {};
  for (const key of ['model', 'imageModel']) {
    if (!Object.hasOwn(body, key)) continue;
    const patch = body[key];
    if (key === 'imageModel' && patch === null) { delete config.agents.defaults.imageModel; continue; }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('模型策略不合法');
    const current = config.agents.defaults[key];
    const next = typeof current === 'string' ? { primary: current } : { ...current };
    if (Object.hasOwn(patch, 'primary')) next.primary = modelRef(config, patch.primary);
    if (Object.hasOwn(patch, 'fallbacks')) {
      if (!Array.isArray(patch.fallbacks) || patch.fallbacks.length > 20) fail('备用模型最多 20 个');
      next.fallbacks = patch.fallbacks.map(ref => modelRef(config, ref));
      if (new Set(next.fallbacks).size !== next.fallbacks.length) fail('备用模型不能重复');
    }
    if (!next.primary) fail('请先设置主模型');
    if (next.fallbacks?.includes(next.primary)) fail('主模型不能重复出现在备用列表');
    if (key === 'imageModel') for (const ref of [next.primary, ...(next.fallbacks || [])]) {
      const input = choices(config).find(c => c.ref === ref)?.input;
      if (Array.isArray(input) && !input.includes('image')) fail('图像模型策略只能选择支持视觉的模型');
    }
    config.agents.defaults[key] = next;
  }
  return config;
}
const ACCESS_KEYS = ['dmPolicy', 'allowFrom', 'groupPolicy', 'groupAllowFrom', 'groupSenderAllowFrom', 'requireMention'];
function accessView(config, account = '') {
  const root = config.channels?.feishu || {};
  if (account && !Object.hasOwn(root.accounts || {}, account)) fail('飞书账号不存在', 404);
  const row = account ? root.accounts[account] : root;
  const effective = { dmPolicy: 'pairing', groupPolicy: 'allowlist', requireMention: true, allowFrom: [], groupAllowFrom: [], groupSenderAllowFrom: [] };
  for (const key of ACCESS_KEYS) {
    if (root[key] !== undefined) effective[key] = root[key];
    if (row[key] !== undefined) effective[key] = row[key];
  }
  if (row.requireMention === undefined && root.requireMention === undefined) effective.requireMention = !['open','allowall'].includes(effective.groupPolicy);
  return { account, accounts: Object.entries(root.accounts || {}).map(([id, r]) => ({ id, name: r.name || id })),
    configured: Boolean(root.appId || Object.keys(root.accounts || {}).length), effective,
    explicit: Object.fromEntries(ACCESS_KEYS.filter(k => Object.hasOwn(row, k)).map(k => [k, row[k]])),
    groups: Object.entries(row.groups || {}).map(([id, g]) => ({ id, enabled: g?.enabled, requireMention: g?.requireMention })), revision: store.revision(JSON.stringify(config)) };
}
function accessPatch(config, body) {
  const account = body.account || '', view = accessView(config, account);
  config.channels ||= {}; config.channels.feishu ||= {};
  const row = account ? config.channels.feishu.accounts[account] : config.channels.feishu;
  const patch = body.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !ACCESS_KEYS.includes(k))) fail('访问规则字段不合法');
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) { delete row[key]; continue; }
    if (key === 'dmPolicy' && !['pairing','allowlist','open','disabled'].includes(value)) fail('私聊策略不合法');
    if (key === 'groupPolicy' && !['allowlist','open','disabled'].includes(value)) fail('群聊策略不合法');
    if (key === 'requireMention' && typeof value !== 'boolean') fail('提及规则需为布尔值');
    if (['allowFrom','groupAllowFrom','groupSenderAllowFrom'].includes(key)) {
      if (!Array.isArray(value) || value.length > 500 || value.some(v => !['string','number'].includes(typeof v) || !String(v).trim() || /[\s\x00-\x1f]/.test(String(v)) || String(v).length > 200)) fail('白名单需为有效 ID 列表，每项不超过 200 字符');
      row[key] = [...new Set(value.map(String))];
    } else row[key] = value;
  }
  const next = accessView(config, account).effective;
  if (next.dmPolicy === 'open' && !next.allowFrom.includes('*')) fail('开放私聊需在用户白名单中填写 *');
  return { previous: view.effective, effective: next };
}
function bindingPatch(config, body) {
  const id = agentId(body.agentId);
  if (!agents(config).some(a => a.id === id)) fail('目标 Agent 不存在');
  const accountId = body.accountId ? text(body.accountId, '账号 ID') : '*';
  if (accountId !== '*' && !Object.hasOwn(config.channels?.feishu?.accounts || {}, accountId) && accountId !== 'default') fail('飞书账号不存在');
  const match = { channel: 'feishu', accountId };
  if (body.peerKind) {
    if (!['direct','group'].includes(body.peerKind)) fail('消息类型不合法');
    const peer = text(body.peerId, '用户或群 ID', 200);
    if (!/^[A-Za-z0-9_:-]+$/.test(peer)) fail('用户或群 ID 不合法');
    match.peer = { kind: body.peerKind, id: peer };
  }
  config.bindings ||= [];
  if (config.bindings.some(b => JSON.stringify(b.match) === JSON.stringify(match) || (b.match?.channel === 'feishu' && (b.match.accountId || '*') === accountId && JSON.stringify(b.match.peer) === JSON.stringify(match.peer)))) fail('相同来源已有路由，请先删除旧路由');
  config.bindings.unshift({ agentId: id, match });
}
function npmSpec(value) {
  if (typeof value !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/.test(value) || value.length > 180) fail('请填写固定版本的 npm 包，例如 @openclaw/feishu@2026.9.3');
  const prerelease = value.slice(value.lastIndexOf('@') + 1).split('-').slice(1).join('-');
  if (prerelease.split('.').some(s => /^0[0-9]+$/.test(s))) fail('npm 预发布版本必须符合 SemVer');
  return value;
}
function removeAgent(config, id) {
  agentId(id);
  const roster = agents(config);
  if (!roster.some(a => a.id === id)) fail('Agent 不存在', 404);
  if (id === 'main' || roster.length <= 1) fail('不能移除主 Agent 或唯一 Agent');
  // Keep native databases intact: 2026.9.3's destructive delete tombstone can
  // prevent gateway startup when another registry still mentions that database.
  // Removing the roster entry revokes routing/selection while retaining state.
  const references = [];
  function visit(node, at) {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const current = at + '.' + key;
      if (current === 'config.bindings' || current === 'config.agents.entries' || current === 'config.agents.list') continue;
      if ((['agentId','defaultAgent','agent'].includes(key) && value === id) || (['allowAgents','agentIds','allow'].includes(key) && Array.isArray(value) && value.includes(id))) references.push(current);
      else visit(value, current);
    }
  }
  visit(config, 'config');
  if (references.length) fail('Agent 仍被其他配置引用，请先调整：' + references.join('、'));
  if (config.agents.entries) delete config.agents.entries[id];
  else config.agents.list = config.agents.list.filter(a => a.id !== id);
  config.bindings = (config.bindings || []).filter(b => b.agentId !== id);
  return config;
}
function publicSkills(rows) {
  return rows.map(s => ({ name:s.name, description:s.description, skillKey:s.skillKey, source:s.source,
    eligible:s.eligible, disabled:s.disabled, missing:Object.fromEntries(Object.entries(s.missing||{}).map(([key,value])=>[key==='env'?'environment':key,value])) }));
}
function jsonOutput(raw) {
  for (let i = 0; i < raw.length; i++) if (raw[i] === '{' || raw[i] === '[') {
    let depth = 0, quoted = false, escaped = false;
    for (let j=i;j<raw.length;j++) { const c=raw[j]; if (quoted) { if(escaped) escaped=false; else if(c==='\\') escaped=true; else if(c==='"') quoted=false; } else if(c==='"') quoted=true; else if(c==='{'||c==='[') depth++; else if(c==='}'||c===']') { if(--depth===0) { try{return JSON.parse(raw.slice(i,j+1));}catch{break;} } } }
  }
  fail('OpenClaw 未返回有效 JSON');
}
module.exports = { fail, text, agentId, agents, choices, modelRef, failover, ACCESS_KEYS, accessView, accessPatch, bindingPatch, npmSpec, jsonOutput, removeAgent, publicSkills };
