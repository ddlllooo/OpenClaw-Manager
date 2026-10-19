'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./instances');
const ROOT_FILES = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'HEARTBEAT.md', 'TOOLS.md', 'BOOT.md'];
const MAX_BYTES = 256 * 1024;
function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; throw error; }
function root(id) {
  const config = JSON.parse(store.readOpenclawConfig(id) || '{}');
  const configured = config.agents?.defaults?.workspace;
  if (configured && !['/home/node/.openclaw/workspace', '~/.openclaw/workspace'].includes(configured)) fail('当前实例使用自定义工作区路径，请先通过终端管理该路径', 409);
  const value = store.workspaceDir(id);
  if (fs.existsSync(value) && fs.lstatSync(value).isSymbolicLink()) fail('工作区不能是符号链接');
  return value;
}
function safe(id, relative) {
  if (typeof relative !== 'string' || (!ROOT_FILES.includes(relative) && !/^memory\/[^/\\\x00-\x1f]{1,120}\.md$/u.test(relative))) fail('只允许管理角色规则文件和 memory 目录中的 Markdown 文件');
  if (relative.includes('..') || relative.startsWith('memory/.')) fail('文件路径不合法');
  const base = root(id), target = path.join(base, relative);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('不允许访问符号链接');
  }
  if (!path.resolve(target).startsWith(path.resolve(base) + path.sep)) fail('文件路径越界');
  return target;
}
function read(id, relative) {
  const target = safe(id, relative), exists = fs.existsSync(target);
  if (exists && (!fs.statSync(target).isFile() || fs.statSync(target).size > MAX_BYTES)) fail('文件过大或不是普通文件');
  const content = exists ? fs.readFileSync(target, 'utf8') : '';
  return { path: relative, exists, content, revision: store.revision((exists ? '1' : '0') + '\0' + content) };
}
function list(id) {
  const base = root(id), memory = path.join(base, 'memory');
  const names = [...ROOT_FILES];
  if (fs.existsSync(memory) && !fs.lstatSync(memory).isSymbolicLink()) {
    for (const entry of fs.readdirSync(memory, { withFileTypes: true }).slice(0, 2000)) {
      if (entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.md') && !entry.name.startsWith('.')) names.push('memory/' + entry.name);
    }
  }
  return names.map(relative => {
    try { const p = safe(id, relative); const stat = fs.existsSync(p) ? fs.statSync(p) : null;
      return { path: relative, exists: Boolean(stat), bytes: stat?.size || 0, updatedAt: stat?.mtime.toISOString() || null };
    } catch { return { path: relative, exists: false, unavailable: true }; }
  });
}
function historyDir(id, relative) {
  safe(id, relative);
  const folder = path.join(store.instanceDir(id), 'manager', 'workspace-history', crypto.createHash('sha256').update(relative).digest('hex'));
  // History never lives in the model-readable workspace.
  let current = store.instanceDir(id);
  for (const part of path.relative(current, folder).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('历史目录不能是符号链接');
  }
  return folder;
}
function history(id, relative) {
  const folder = historyDir(id, relative);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(n => /^[\d-]+-[a-f0-9]{12}\.json$/.test(n)).sort().reverse().slice(0, 20).flatMap(name => {
    try {
      const file = path.join(folder, name);
      if (fs.lstatSync(file).isSymbolicLink()) return [];
      const row = JSON.parse(fs.readFileSync(file, 'utf8'));
      return [{ version: name.slice(0, -5), savedAt: row.savedAt, bytes: Buffer.byteLength(row.content) }];
    } catch { return []; }
  });
}
function version(id, relative, value) {
  if (!/^[\d-]+-[a-f0-9]{12}$/.test(value || '')) fail('历史版本标识不合法');
  const file = path.join(historyDir(id, relative), value + '.json');
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) fail('历史版本不存在', 404);
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (row.path !== relative || typeof row.content !== 'string') fail('历史版本损坏');
  return row;
}
function write(id, relative, content, revision) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES || content.includes('\0')) fail('内容需为不超过 256KB 的文本');
  const before = read(id, relative);
  if (!revision) fail('请先加载文件再保存', 428);
  if (before.revision !== revision) fail('文件已被其他操作修改，请重新加载后合并', 409);
  if (before.exists && before.content === content) return before;
  const file = safe(id, relative);
  if (before.exists) {
    const folder = historyDir(id, relative);
    const value = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    store.atomicWrite(path.join(folder, value + '.json'), JSON.stringify({ path: relative, savedAt: new Date().toISOString(), content: before.content }));
    for (const old of fs.readdirSync(folder).filter(n => /^[\d-]+-[a-f0-9]{12}\.json$/.test(n)).sort().reverse().slice(20)) fs.unlinkSync(path.join(folder, old));
  }
  // No await between the final revision/path check and atomic publish.
  if (read(id, relative).revision !== revision) fail('文件已更新，请重新加载', 409);
  store.atomicWrite(file, content);
  return read(id, relative);
}
module.exports = { ROOT_FILES, MAX_BYTES, list, read, write, history, version, safe };
