'use strict';
const crypto = require('crypto');
const store = require('./instances');
function error(message, statusCode = 400) { const e = new Error(message); e.statusCode = statusCode; throw e; }
function schedule(value) {
  if (!value || typeof value !== 'object') error('请设置任务执行时间');
  if (value.kind === 'cron') {
    if (typeof value.expr !== 'string' || value.expr.length > 120 || ![5, 6].includes(value.expr.trim().split(/\s+/).length)) error('请输入 5 段或 6 段 Cron 表达式');
    try { new Intl.DateTimeFormat('en', { timeZone: value.tz || 'Asia/Shanghai' }); } catch { error('时区不合法'); }
    return { kind: 'cron', expr: value.expr.trim(), tz: value.tz || 'Asia/Shanghai' };
  }
  if (value.kind === 'every' && Number.isSafeInteger(value.everyMs) && value.everyMs >= 60000 && value.everyMs <= 365 * 86400000) return { kind: 'every', everyMs: value.everyMs };
  if (value.kind === 'at' && typeof value.at === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value.at) && Number.isFinite(Date.parse(value.at)) && Date.parse(value.at) > Date.now()) return { kind: 'at', at: new Date(value.at).toISOString() };
  error('执行时间不合法：间隔至少 1 分钟，单次时间需带时区且晚于当前时间');
}
function cronPatch(body, current = null) {
  const patch = {};
  if (Object.hasOwn(body, 'agentId')) patch.agentId = require('./management').agentId(body.agentId);
  if (Object.hasOwn(body, 'name') || !current) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) error('任务名称需为 1-120 个字符');
    patch.name = body.name.trim();
  }
  if (Object.hasOwn(body, 'message') || !current) {
    if (typeof body.message !== 'string' || !body.message.trim() || Buffer.byteLength(body.message) > 32000) error('任务内容不能为空且不能超过 32KB');
    patch.payload = { ...(current?.payload || {}), kind: 'agentTurn', message: body.message.trim() };
  }
  if (Object.hasOwn(body, 'model')) {
    if (typeof body.model !== 'string' || body.model.length > 256) error('模型标识不合法');
    patch.payload ||= { ...(current?.payload || {}), kind: 'agentTurn' };
    patch.payload.model = body.model.trim() || null;
    if (!current && patch.payload.model === null) delete patch.payload.model;
  }
  if (Object.hasOwn(body, 'schedule') || !current) patch.schedule = schedule(body.schedule);
  if (Object.hasOwn(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') error('启用状态不合法');
    patch.enabled = body.enabled;
  } else if (!current) patch.enabled = false;
  if (Object.hasOwn(body, 'delivery') || !current) {
    const value = body.delivery || { mode: 'none' };
    if (value.mode === 'none') patch.delivery = { mode: 'none' };
    else if (value.mode === 'announce' && typeof value.channel === 'string' && /^[a-z0-9_-]{1,40}$/.test(value.channel) && typeof value.to === 'string' && value.to.trim() && value.to.length <= 256) {
      patch.delivery = { mode: 'announce', channel: value.channel, to: value.to.trim(), ...(value.accountId ? { accountId: String(value.accountId).slice(0, 120) } : {}) };
    } else error('请选择不推送，或填写消息渠道与接收目标');
  }
  if (!current) Object.assign(patch, { sessionTarget: 'isolated', wakeMode: 'now', deleteAfterRun: false });
  return patch;
}
function cronRevision(job) {
  return store.revision(JSON.stringify(Object.fromEntries(['name', 'displayName', 'description', 'agentId', 'schedule', 'payload', 'delivery', 'sessionTarget', 'wakeMode', 'enabled', 'deleteAfterRun', 'trigger', 'pacing', 'failureAlert', 'sessionKey'].map(k => [k, job[k]]))));
}
function editableJob(job) { return job?.payload?.kind === 'agentTurn' && !job.declarationKey; }
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
function attachments(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 4) error('每次最多发送 4 个附件');
  let total = 0;
  return values.map(value => {
    const name = typeof value.fileName === 'string' ? value.fileName : '';
    if (!name || name.length > 180 || /[/\\\x00-\x1f]/.test(name)) error('附件文件名不合法');
    const mimeType = MIME[name.split('.').pop().toLowerCase()];
    if (!mimeType) error('支持 PNG/JPG/GIF/WebP、PDF、TXT/MD/CSV/JSON、DOCX/XLSX');
    if (typeof value.content !== 'string') error('附件编码不合法');
    if (value.content.length > 4 * Math.ceil(10 * 1024 * 1024 / 3)) error('单个附件最多 10MB');
    if (value.content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.content)) error('附件编码不合法');
    const buffer = Buffer.from(value.content, 'base64'); total += buffer.length;
    if (!buffer.length || buffer.length > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) error('单个附件最多 10MB，总计最多 20MB，不能为空');
    const signatures = { 'image/png': b => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
      'image/jpeg': b => b[0] === 255 && b[1] === 216 && b[2] === 255,
      'image/gif': b => /^GIF8[79]a/.test(b.subarray(0, 6).toString()),
      'image/webp': b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
      'application/pdf': b => b.subarray(0, 5).toString() === '%PDF-' };
    if (signatures[mimeType] && !signatures[mimeType](buffer)) error('附件实际格式与扩展名不一致：' + name);
    return { type: mimeType.startsWith('image/') ? 'image' : 'file', fileName: name, mimeType, content: value.content, sizeBytes: buffer.length };
  });
}
function redact(value, config, instance) {
  const secrets = new Set([instance.gatewayToken]);
  function collect(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, v] of Object.entries(node)) {
      if (/secret|password|api.?key|token|authorization/i.test(key) && typeof v === 'string' && v.length >= 4) secrets.add(v);
      else if (v && typeof v === 'object') collect(v);
    }
  }
  collect(config);
  const env = store.parseEnv(store.readEnvFile(instance.id) || '');
  for (const [key, value] of Object.entries(env)) if (/secret|password|key|token/i.test(key) && value.length >= 4) secrets.add(value);
  function clean(node) {
    if (typeof node === 'string') { for (const secret of secrets) if (secret) node = node.split(secret).join('[已脱敏]'); return node; }
    if (Array.isArray(node)) return node.map(clean);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, /^(api.?key|token|password|secret|appSecret|authorization|privateKey|headers|env)$/i.test(k) ? '[已脱敏]' : clean(v)]));
    return node;
  }
  return clean(value);
}
module.exports = { error, schedule, cronPatch, cronRevision, editableJob, attachments, redact };
