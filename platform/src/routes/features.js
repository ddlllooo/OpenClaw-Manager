'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const store = require('../instances');
const docker = require('../docker');
const gateway = require('../gateway-rpc');
const workspace = require('../workspace-files');
const feature = require('../instance-features');
const router = express.Router();
const activeChats = new Map();
function instance(req, res, next) {
  try { req.instance = store.loadInstance(req.params.id); next(); }
  catch { res.status(404).json({ error: '实例不存在' }); }
}
async function running(req, res, next) {
  try {
    if (!req.instance.containerId || !(await docker.inspectContainer(req.instance.containerId)).State.Running) return res.status(409).json({ error: '实例未运行，请先启动' });
    next();
  } catch { res.status(503).json({ error: 'Docker 容器不可用' }); }
}
const route = fn => async (req, res) => {
  try { await fn(req, res); } catch (error) {
    let config = {};
    try { config = JSON.parse(store.readOpenclawConfig(req.instance.id) || '{}'); } catch { /* invalid config diagnostic */ }
    const message = feature.redact(String(error.message).slice(0, 1500), config, req.instance);
    if (!res.headersSent) res.status(error.statusCode || 400).json({ error: message });
    else { res.write(JSON.stringify({ kind: 'error', error: message }) + '\n'); res.end(); }
  }
};
router.get('/:id/workspace', instance, route(async (req, res) => res.json({ files: workspace.list(req.instance.id) })));
router.get('/:id/workspace/file', instance, route(async (req, res) => res.json(workspace.read(req.instance.id, req.query.path))));
router.put('/:id/workspace/file', instance, route(async (req, res) => res.json({ ok: true, ...workspace.write(req.instance.id, req.body.path, req.body.content, req.body.revision) })));
router.get('/:id/workspace/history', instance, route(async (req, res) => res.json({ versions: workspace.history(req.instance.id, req.query.path) })));
router.get('/:id/workspace/version', instance, route(async (req, res) => res.json(workspace.version(req.instance.id, req.query.path, req.query.version))));
router.post('/:id/workspace/restore', instance, route(async (req, res) => {
  const row = workspace.version(req.instance.id, req.body.path, req.body.version);
  res.json({ ok: true, ...workspace.write(req.instance.id, req.body.path, row.content, req.body.revision) });
}));
async function job(req) {
  if (!/^[A-Za-z0-9:_-]{1,150}$/.test(req.params.jobId)) feature.error('任务标识不合法');
  const response = await gateway.rpc(req.instance, 'cron.get', { id: req.params.jobId });
  return response.job || response;
}
router.get('/:id/automations', instance, running, route(async (req, res) => {
  const offset = Number(req.query.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) feature.error('页码不合法');
  const data = await gateway.rpc(req.instance, 'cron.list', { includeDisabled: true, limit: 100, offset });
  res.json({ ...data, jobs: (data.jobs || []).map(row => ({ ...row, managerRevision: feature.cronRevision(row), editable: feature.editableJob(row) })) });
}));
router.post('/:id/automations', instance, running, route(async (req, res) => {
  res.json({ ok: true, job: await gateway.rpc(req.instance, 'cron.add', feature.cronPatch(req.body)) });
}));
router.put('/:id/automations/:jobId', instance, running, route(async (req, res) => {
  const current = await job(req);
  if (!feature.editableJob(current)) feature.error('此任务由 OpenClaw 管理，请在控制台或所属功能中调整');
  if (!req.body.revision || req.body.revision !== feature.cronRevision(current)) feature.error('任务已更新，请刷新后再保存', 409);
  const patch = feature.cronPatch(req.body, current);
  const result = await gateway.rpc(req.instance, 'cron.update', { id: req.params.jobId, patch,
    ...(typeof current.configRevision === 'string' ? { expectedConfigRevision: current.configRevision } : {}) });
  res.json({ ok: true, job: result });
}));
router.delete('/:id/automations/:jobId', instance, running, route(async (req, res) => {
  const current = await job(req);
  if (!feature.editableJob(current)) feature.error('此任务由 OpenClaw 管理，请在控制台或所属功能中调整');
  res.json({ ok: true, result: await gateway.rpc(req.instance, 'cron.remove', { id: req.params.jobId }) });
}));
router.post('/:id/automations/:jobId/run', instance, running, route(async (req, res) => {
  const current = await job(req);
  if (!feature.editableJob(current)) feature.error('仅支持手动运行普通助手任务');
  res.json({ ok: true, result: await gateway.rpc(req.instance, 'cron.run', { id: req.params.jobId, mode: 'force' }, { timeout: 60000 }) });
}));
router.get('/:id/automations/:jobId/runs', instance, running, route(async (req, res) => {
  await job(req);
  res.json(await gateway.rpc(req.instance, 'cron.runs', { id: req.params.jobId, limit: 30, offset: 0 }));
}));
async function probe(port, name) {
  const base=await require('../gateway-address').base(port);
  return new Promise(resolve => {
    const req = http.get(`${base}/${name}`, { timeout: 3000 }, res => {
      let body = ''; res.on('data', b => { if (body.length < 4096) body += b; });
      res.on('end', () => { try { const value = JSON.parse(body); resolve(res.statusCode === 200 && (name === 'readyz' ? value.ready === true : value.ok === true)); } catch { resolve(false); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
  });
}
router.post('/:id/diagnostics', instance, route(async (req, res) => {
  const checks = [], add = (label, status, detail) => checks.push({ label, status, detail });
  let config = {};
  try { config = JSON.parse(store.readOpenclawConfig(req.instance.id) || '{}'); add('配置文件', 'ok', 'JSON 读取正常'); }
  catch { add('配置文件', 'error', '配置 JSON 无法解析，请检查配置文件'); }
  let inspected;
  try {
    inspected = await docker.inspectContainer(req.instance.containerId);
    add('Docker 容器', inspected.State.Running ? 'ok' : 'warning', inspected.State.Running ? '运行中' : '实例未运行；启动后可继续检查网关、渠道和模型');
  } catch { add('Docker 容器', 'error', '容器不存在或 Docker 不可达'); }
  if (inspected?.State.Running) {
    const [health, ready] = await Promise.all([probe(req.instance.port, 'healthz'), probe(req.instance.port, 'readyz')]);
    add('网关存活', health ? 'ok' : 'error', health ? 'healthz 正常' : '网关未响应，请查看日志');
    add('网关就绪', ready ? 'ok' : 'warning', ready ? 'readyz 正常' : '网关尚未就绪，请检查配置与启动日志');
    try {
      const raw = await gateway.cli(req.instance, ['doctor', '--lint', '--json'], 120000, { allowFindings: true });
      const start = raw.indexOf('{');
      const data = start >= 0 ? JSON.parse(raw.slice(start)) : { output: raw.slice(0, 50000) };
      const findings = data.findings || [];
      add('OpenClaw 诊断', findings.some(f => f.severity === 'error') ? 'error' : findings.length ? 'warning' : 'ok', `已完成 ${data.checksRun ?? '全部'} 项检查，发现 ${findings.length} 项提示。`);
      const labels = { security: '安全设置', 'gateway-config': '网关配置', 'plugins': '插件', 'skills': '技能', 'models': '模型', 'channels': '渠道' };
      for (const finding of findings.slice(0, 80)) {
        const key = finding.checkId?.split('/').pop();
        const detail = { message: finding.message, suggestion: finding.fixHint, path: finding.path };
        if (key === 'security') detail.containerNetwork = { bind: config.gateway?.bind, hostPorts: inspected.HostConfig?.PortBindings };
        if (key === 'gateway-config' && inspected.Config?.Cmd?.includes('--allow-unconfigured')) detail.containerNote = '当前容器使用 --allow-unconfigured 运行，当前可用状态请结合网关就绪检查。';
        add(labels[key] || finding.checkId || '诊断提示', finding.severity === 'error' ? 'error' : finding.severity === 'warning' ? 'warning' : 'info', detail);
      }
    } catch (error) { add('OpenClaw 诊断', 'warning', String(error.message).slice(0, 3000)); }
  }
  const models = Object.values(config.models?.providers || {}).flatMap(p => p.models || []);
  add('已配置模型', models.length ? 'ok' : 'warning', models.length ? models.map(m => ({ model: m.id, input: m.input || ['text'], contextWindow: m.contextWindow || null })) : '尚未添加模型');
  const channels = Object.entries(config.channels || {}).filter(([, v]) => v?.enabled !== false).map(([key]) => key);
  add('消息渠道', channels.length ? 'info' : 'warning', channels.length ? `已配置：${channels.join('、')}；渠道连通情况见 OpenClaw 诊断详情` : '未配置消息渠道；平台内对话仍可使用');
  res.json(feature.redact({ checkedAt: new Date().toISOString(), readOnly: true, checks }, config, req.instance));
}));
router.post('/:id/chat/stream', instance, running, route(async (req, res) => {
  if (activeChats.has(req.instance.id)) feature.error('该实例已有平台对话进行中，请等待或停止', 409);
  const files = feature.attachments(req.body.attachments);
  const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if ((!message && !files.length) || message.length > 64000) feature.error('请输入消息或选择附件；消息不能超过 64000 字符');
  const config = JSON.parse(store.readOpenclawConfig(req.instance.id) || '{}');
  const agents = require('../management').agents(config);
  const targetAgent = req.body.agentId || (agents.some(a => a.id === 'main') ? 'main' : agents.length === 1 ? agents[0].id : null);
  if (!targetAgent || !agents.some(a => a.id === targetAgent)) feature.error('请选择有效的 Agent');
  if (files.some(f => f.type === 'image')) {
    const ref = agents.find(a => a.id === targetAgent)?.model || config.agents?.defaults?.model;
    const selected = typeof ref === 'string' ? ref : ref?.primary;
    const pid = selected?.split('/')[0], mid = selected?.split('/').slice(1).join('/');
    const model = config.models?.providers?.[pid]?.models?.find(m => m.id === mid);
    if (Array.isArray(model?.input) && !model.input.includes('image')) feature.error('当前默认模型为纯文本，请先切换到支持图像的模型');
  }
  const run = { sessionKey: `agent:${targetAgent}:manager-chat`, runId: crypto.randomUUID() };
  activeChats.set(req.instance.id, run);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.write(JSON.stringify({ kind: 'preparing', data: { runId: run.runId } }) + '\n');
  try {
    await gateway.rpc(req.instance, 'chat.send', { sessionKey: run.sessionKey, message: message || '请分析所附文件。',
      attachments: files, deliver: false, idempotencyKey: run.runId, timeoutMs: 240000 },
    { timeout: 270000, stream: true, onEvent: event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); } });
  } finally { activeChats.delete(req.instance.id); res.locals.releaseManagerOperation?.(); }
  res.end();
}));
router.post('/:id/chat/abort', instance, running, route(async (req, res) => {
  const run = activeChats.get(req.instance.id);
  if (!run) return res.json({ ok: true, hint: '没有正在运行的平台对话' });
  res.json({ ok: true, result: await gateway.rpc(req.instance, 'chat.abort', run) });
}));
module.exports = router;
