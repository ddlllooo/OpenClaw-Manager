'use strict';

const express = require('express');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('../instances');
const monitor = require('../monitor');

const router = express.Router();

// ── Session management (store transcripts + live agent turns) ────────────────
// Backed by the in-container CLI: `openclaw sessions` reads the session store,
// `sessions export-trajectory` materializes the full event stream (the only
// supported way to read a transcript back), and `openclaw agent --session-key`
// appends a turn to an existing session.

function execInInstance(instance, args, { timeout = 60_000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', [
      'exec',
      '-e', `OPENCLAW_GATEWAY_TOKEN=${instance.gatewayToken}`,
      instance.containerName,
      'openclaw',
      ...args,
    ], { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        err.message = String(stderr || err.message).split('\n').filter(Boolean)[0] || err.message;
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Arbitrary command in the container (rm/cat for trajectory export cleanup).
function execRaw(instance, args, { timeout = 30_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['exec', instance.containerName, ...args],
      { timeout, maxBuffer }, (err, stdout, stderr) => {
        if (err) {
          err.message = String(stderr || err.message).split('\n').filter(Boolean)[0] || err.message;
          return reject(err);
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
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

function friendlyCliError(err) {
  const msg = String(err.message || err);
  if (/No such container|is not running/i.test(msg)) return '实例容器未运行，请先启动实例';
  if (/Unknown model/i.test(msg)) return '模型不存在：请确认 provider/model 拼写，且 provider 已保存';
  if (/network connection error|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg)) {
    return '模型请求失败：无法连接 base_url（网络不可达或地址错误）';
  }
  if (/401|Unauthorized|invalid.*key|Incorrect API key/i.test(msg)) return '鉴权失败：api_key 无效或缺失';
  if (/429|rate limit/i.test(msg)) return '请求被限流：稍后重试';
  if (/timed out|timeout/i.test(msg)) return '执行超时：会话可能过大或网关繁忙，请稍后重试';
  return msg.slice(0, 300);
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

// ── List sessions ────────────────────────────────────────────────────────────
function normalizeSessionRow(s) {
  const key = String(s.key || '');
  return {
    key,
    sessionId: s.sessionId || null,
    label: s.label || null,
    kind: s.kind || null,
    status: s.status || null,
    spawnDepth: s.spawnDepth || 0,
    subagent: String(key).includes(':subagent:') || (s.spawnDepth || 0) > 0,
    parentSessionKey: s.parentSessionKey || null,
    updatedAtMs: Number.isFinite(s.updatedAt) ? s.updatedAt : null,
    createdMs: Number.isFinite(s.sessionStartedAt) ? s.sessionStartedAt : null,
    totalTokens: Number.isFinite(s.totalTokens) ? s.totalTokens : null,
    inputTokens: Number.isFinite(s.inputTokens) ? s.inputTokens : null,
    outputTokens: Number.isFinite(s.outputTokens) ? s.outputTokens : null,
    contextTokens: Number.isFinite(s.contextTokens) ? s.contextTokens : null,
    model: s.model || null,
    modelProvider: s.modelProvider || null,
    agentId: s.agentId || null,
    abortedLastRun: Boolean(s.abortedLastRun),
    visibility: s.visibility || null,
  };
}

router.get('/:id/sessions', requireRunning, async (req, res, next) => {
  try {
    const limit = String(req.query.limit || '100').trim();
    const lim = limit === 'all' ? 'all' : String(Math.min(1000, Math.max(1, Number(limit) || 100)));
    const args = ['sessions', '--json', '--all-agents', '--limit', lim];
    const activeMin = Number(req.query.activeMinutes);
    if (Number.isFinite(activeMin) && activeMin > 0) args.push('--active', String(Math.floor(activeMin)));
    const r = await execInInstance(req.instance, args, { timeout: 60_000 });
    const data = extractJson(r.stdout);
    const sessions = Array.isArray(data.sessions) ? data.sessions.map(normalizeSessionRow) : [];
    sessions.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    res.json({
      sessions,
      count: sessions.length,
      totalCount: data.totalCount ?? sessions.length,
      hasMore: Boolean(data.hasMore),
      storePath: data.path || null,
    });
  } catch (err) {
    res.status(502).json({ error: friendlyCliError(err) });
  }
});

// ── Transcript (via trajectory export) ───────────────────────────────────────
const EXPORT_ROOT = '/home/node/.openclaw/trajectory-exports';
const TOOL_RESULT_SNIPPET = 4000;

function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((b) => {
    if (!b || typeof b !== 'object') return '';
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
    if (b.type === 'toolCall') return '';
    if (b.text) return String(b.text);
    return '';
  }).filter(Boolean).join('');
}

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（截断，共 ${s.length} 字符）`;
}

// Reduce the trajectory event stream to a chat-shaped transcript: user /
// assistant messages, tool calls (attached to their assistant turn), tool
// results and compaction markers. Ordered by seq as written by the export.
function reduceTrajectory(text) {
  const msgs = [];
  const toolNameByCallId = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const ts = ev.ts || null;
    if (ev.type === 'user.message') {
      const m = (ev.data && ev.data.message) || {};
      const textOut = blocksToText(m.content);
      if (!textOut.trim()) continue;
      msgs.push({ role: 'user', ts, text: textOut });
    } else if (ev.type === 'assistant.message') {
      const m = (ev.data && ev.data.message) || {};
      const blocks = Array.isArray(m.content) ? m.content : [];
      const textOut = blocks.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('');
      const toolCalls = blocks
        .filter((b) => b && b.type === 'toolCall')
        .map((b) => ({ id: b.id || null, name: b.name || 'tool', args: b.arguments ?? null }));
      for (const tc of toolCalls) if (tc.id) toolNameByCallId.set(tc.id, tc.name);
      if (!textOut.trim() && !toolCalls.length) continue; // whitespace-only glue turns
      msgs.push({
        role: 'assistant',
        ts,
        text: textOut,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        model: m.model || null,
        stopReason: m.stopReason || null,
        totalTokens: m.usage && Number.isFinite(m.usage.totalTokens) ? m.usage.totalTokens : null,
      });
    } else if (ev.type === 'tool.result') {
      const m = (ev.data && ev.data.message) || {};
      const body = truncate(blocksToText(m.content), TOOL_RESULT_SNIPPET);
      msgs.push({
        role: 'tool',
        ts,
        name: m.toolName || toolNameByCallId.get(m.toolCallId) || m.toolCallId || 'tool',
        text: body,
      });
    } else if (ev.type === 'session.compaction') {
      msgs.push({ role: 'note', ts, text: '会话执行了上下文压缩（compaction）' });
    }
  }
  return msgs;
}

// Exports land in a per-request directory inside the container and are removed
// afterwards; a failure to clean up must not fail the request.
async function exportTrajectoryEvents(instance, sessionKey) {
  const dir = `mgr-${crypto.randomBytes(4).toString('hex')}`;
  const out = await execInInstance(instance, [
    'sessions', 'export-trajectory',
    '--session-key', sessionKey,
    '--output', dir,
    '--json',
  ], { timeout: 120_000 });
  const meta = extractJson(out.stdout);
  const outputPath = `${meta.outputDir || `${EXPORT_ROOT}/${dir}`}/events.jsonl`;
  try {
    const file = await execRaw(instance, ['cat', outputPath], { timeout: 60_000 });
    return { events: file.stdout, count: meta.transcriptEventCount || meta.eventCount || null };
  } finally {
    execRaw(instance, ['rm', '-rf', meta.outputDir || `${EXPORT_ROOT}/${dir}`]).catch(() => {});
  }
}

router.get('/:id/sessions/:key/messages', requireRunning, async (req, res, next) => {
  try {
    const key = String(req.params.key || '').trim();
    if (!key || /\s/.test(key) || key.length > 300) return res.status(400).json({ error: 'session key 不合法' });
    const { events, count } = await exportTrajectoryEvents(req.instance, key);
    const msgs = reduceTrajectory(events);
    res.json({ key, eventCount: count, messages: msgs });
  } catch (err) {
    res.status(502).json({ error: friendlyCliError(err) });
  }
});

// ── Continue a session (one agent turn appended to the stored session) ───────
router.post('/:id/sessions/:key/messages', requireRunning, express.json({ limit: '256kb' }), async (req, res, next) => {
  try {
    const key = String(req.params.key || '').trim();
    if (!key || /\s/.test(key) || key.length > 300) return res.status(400).json({ error: 'session key 不合法' });
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ error: '消息不能为空' });

    const r = await execInInstance(req.instance, [
      'agent',
      '--session-key', key,
      '-m', message,
      '--json', '--timeout', '240',
    ], { timeout: 300_000 });
    const env = extractJson(r.stdout);
    if (env.ok === false) {
      return res.status(502).json({ error: friendlyCliError(new Error(env.error && env.error.message || 'agent 调用失败')) });
    }
    const payloads = (env.result && env.result.payloads) || [];
    const text = payloads.map((p) => p && p.text).filter(Boolean).join('\n');
    const meta = (env.result && env.result.meta && env.result.meta.agentMeta) || {};
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'session-message', sessionKey: key });
    res.json({
      ok: true,
      reply: text,
      sessionId: meta.sessionId || null,
      model: meta.model ? `${meta.provider ? `${meta.provider}/` : ''}${meta.model}` : null,
      usage: meta.usage || null,
    });
  } catch (err) {
    res.status(502).json({ error: friendlyCliError(err) });
  }
});

// ── Session lifecycle ops (delete / archive / compact) ───────────────────────
const VALID_KEY = /^[A-Za-z0-9._:@-]+$/;

function parseKeys(body) {
  const keys = Array.isArray(body && body.keys) ? body.keys : [];
  const clean = [...new Set(keys.map((k) => String(k || '').trim()).filter(Boolean))];
  if (!clean.length || clean.some((k) => !VALID_KEY.test(k) || k.length > 300)) {
    return null;
  }
  return clean;
}

router.post('/:id/sessions/delete', requireRunning, express.json(), async (req, res, next) => {
  try {
    const keys = parseKeys(req.body);
    if (!keys) return res.status(400).json({ error: '请提供要删除的会话 key' });
    const r = await execInInstance(req.instance, ['sessions', 'delete', ...keys, '--yes', '--json'], { timeout: 120_000 });
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'sessions-deleted', count: keys.length });
    let detail;
    try { detail = extractJson(r.stdout); } catch { detail = null; }
    res.json({ ok: true, hint: `已删除 ${keys.length} 个会话（含运行时产物与归档）。`, detail });
  } catch (err) {
    res.status(502).json({ error: friendlyCliError(err) });
  }
});

router.post('/:id/sessions/archive', requireRunning, express.json(), async (req, res, next) => {
  try {
    const keys = parseKeys(req.body);
    if (!keys) return res.status(400).json({ error: '请提供要归档的会话 key' });
    const r = await execInInstance(req.instance, ['sessions', 'archive', ...keys, '--json'], { timeout: 120_000 });
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'sessions-archived', count: keys.length });
    let detail;
    try { detail = extractJson(r.stdout); } catch { detail = null; }
    res.json({ ok: true, hint: `已归档 ${keys.length} 个会话（transcript 保留为归档文件）。`, detail });
  } catch (err) {
    res.status(502).json({ error: friendlyCliError(err) });
  }
});

// Compact rewrites the stored transcript (LLM summary by default, or a hard
// tail-line truncate via maxLines) to reclaim context budget.
router.post('/:id/sessions/compact', requireRunning, express.json(), async (req, res, next) => {
  try {
    const key = String((req.body && req.body.key) || '').trim();
    if (!key || !VALID_KEY.test(key) || key.length > 300) return res.status(400).json({ error: 'session key 不合法' });
    const args = ['sessions', 'compact', key, '--json'];
    const maxLines = Number((req.body || {}).maxLines);
    if (Number.isFinite(maxLines) && maxLines > 0) args.push('--max-lines', String(Math.floor(maxLines)));
    const r = await execInInstance(req.instance, args, { timeout: 300_000 });
    let detail;
    try { detail = extractJson(r.stdout); } catch { detail = null; }
    monitor.broadcast('lifecycle', { id: req.instance.id, action: 'session-compacted', sessionKey: key });
    res.json({ ok: true, hint: `会话已压缩（${Number.isFinite(maxLines) && maxLines > 0 ? `保留末尾 ${Math.floor(maxLines)} 行` : 'LLM 摘要'}）。`, detail });
  } catch (err) {
    res.status(502).json({ error: friendlyCliError(err) });
  }
});

module.exports = router;
