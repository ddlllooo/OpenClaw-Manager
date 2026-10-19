'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAX_FILE = 4 * 1024 * 1024;
const text = value => typeof value === 'string' ? value : '';

function reason(error = {}) {
  const status = Number(error.statusCode || error.status);
  if (status === 409) return '对象仍被引用或占用，Docker 拒绝删除';
  if (status === 401 || status === 403 || error.code === 'EACCES') return '权限不足，无法执行 Docker 清理';
  if (status === 404) return '对象已不存在';
  if (['ECONNREFUSED', 'ENOENT', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code)) return '无法连接 Docker 服务或请求超时，已停止清理';
  if (status === 500) return 'Docker 服务处理失败，已保留未删除项目';
  return '清理检查或 Docker 操作失败，已停止本次清理';
}

function append(home, report) {
  report.version = 2;
  report.id ||= crypto.randomUUID();
  report.completedAt ||= new Date().toISOString();
  const target = path.join(home, 'retention-audit.jsonl');
  if (fs.existsSync(target) && fs.statSync(target).size > 1024 * 1024) fs.renameSync(target, target + '.1');
  fs.appendFileSync(target, JSON.stringify(report) + '\n', { mode: 0o600 });
}

function object(value, type) {
  if (typeof value === 'string') return { type, id:value, name:value };
  if (!value || typeof value !== 'object') return null;
  return { type:text(value.type) || type, id:text(value.id), name:text(value.name) || text(value.id),
    ...(Array.isArray(value.tags) ? { tags:value.tags.filter(t => typeof t === 'string') } : {}),
    ...(text(value.instanceName) ? { instanceName:value.instanceName } : {}),
    ...(text(value.reason) ? { reason:value.reason } : {}),
    ...(Number.isFinite(value.status) ? { status:value.status } : {}) };
}
const objects = (values, type) => Array.isArray(values) ? values.map(v=>object(v,type)).filter(Boolean) : [];

function normalize(row, key) {
  const source = row.source === 'automatic' || row.source === 'manual' ? row.source : row.trigger?.kind === 'manual-cleanup' ? 'manual' : 'automatic';
  return { id:key, at:row.at, completedAt:text(row.completedAt), source,
    trigger:text(row.trigger?.kind), state:text(row.state) || 'unknown', legacy:row.version !== 2,
    deletedImages:objects(row.deletedImages || row.removedImages,'image'),
    deletedContainers:objects(row.deletedContainers || row.removedContainers,'rollback'),
    removedTags:objects(row.removedTags,'image').filter(v=>!(row.removedImages || []).includes(v.id)),
    skipped:objects(row.skipped,'unknown').map(v=>({...v,reason:v.reason || '旧记录未保存具体跳过原因'})),
    errors:objects(row.errors,'unknown').map(v=>({...v,reason:v.reason || reason(v)})),
    error:text(row.error) };
}

function read(home, {limit = 10, cursor = ''} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || typeof cursor !== 'string' || (cursor && !/^[a-f0-9]{64}:\d{1,6}$/.test(cursor))) {
    throw Object.assign(new Error('历史分页参数无效'), {statusCode:400});
  }
  const rows = [], warnings = [], counts = new Map();
  for (const suffix of ['', '.1']) {
    let bytes;
    try {
      const file = path.join(home,'retention-audit.jsonl' + suffix);
      if (fs.statSync(file).size > MAX_FILE) { warnings.push('部分历史文件过大，未读取该文件'); continue; }
      bytes = fs.readFileSync(file,'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw Object.assign(new Error('清理历史暂时无法读取，请稍后重试'), {statusCode:503});
    }
    const lines = bytes.split('\n');
    for (let n = lines.length - 1; n >= 0; n--) {
      if (!lines[n].trim()) continue;
      try {
        const row = JSON.parse(lines[n]);
        if (!row || typeof row !== 'object' || !Number.isFinite(Date.parse(row.at))) throw Error('invalid record');
        const hash = crypto.createHash('sha256').update(lines[n]).digest('hex');
        const occurrence = (counts.get(hash) || 0) + 1; counts.set(hash,occurrence);
        rows.push(normalize(row,hash + ':' + occurrence));
      } catch { if (!warnings.includes('部分历史记录损坏或不完整，已跳过')) warnings.push('部分历史记录损坏或不完整，已跳过'); }
    }
  }
  rows.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const index = cursor ? rows.findIndex(row=>row.id===cursor) : -1;
  if (cursor && index === -1) throw Object.assign(new Error('历史记录已轮转，请刷新历史后重试'), {statusCode:409});
  const entries = rows.slice(index+1,index+1+limit);
  return {entries, nextCursor:index+1+entries.length < rows.length ? entries.at(-1)?.id || null : null,
    warnings, retention:'保留当前及上一份轮转日志，每份约 1 MiB；更早记录可能已轮转移除。'};
}

module.exports = { append, read, reason };
