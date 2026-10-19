'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const store = require('./instances');
const root = process.env.OPENCLAW_BACKUP_DIR || path.join(path.dirname(store.DATA_ROOT), 'backups');
const statusFile = path.join(root, 'status.json');
let pendingPid = null;
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function calendar(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'}).format(date);
}
function scheduledTime(date, schedule) { return new Date(`${date}T${String(schedule.hour).padStart(2,'0')}:${String(schedule.minute).padStart(2,'0')}:00+08:00`); }
function getStatus() {
  const schedule = read(path.join(root, 'schedule.json'), {enabled:false, hour:3, minute:30, timezone:'Asia/Shanghai'});
  const status = read(statusFile, {state:'never', lastSuccess:null});
  if (pendingPid && alive(pendingPid) && status.state !== 'running') { status.state = 'running'; status.pid = pendingPid; }
  const today = calendar();
  let next = scheduledTime(today, schedule);
  if (next <= new Date() || status.lastSuccess?.date === today) next = new Date(next.getTime() + 86400000);
  if (status.state === 'running' && !alive(status.pid)) {
    status.state = 'failed'; status.lastError = '上次备份进程已中断，最近一次成功备份仍保留，请重试';
  }
  const latestDue = scheduledTime(today, schedule) <= new Date() ? today : calendar(new Date(Date.now() - 86400000));
  if (schedule.enabled && !['running','failed'].includes(status.state) && (!status.lastSuccess || status.lastSuccess.date < latestDue)) {
    status.state = 'overdue'; status.lastError = '每日备份尚未成功完成，请检查计划或立即重试';
  }
  return {...status, schedule, nextRunAt:schedule.enabled ? next.toISOString() : null, retentionDays:7, directory:root};
}
function failure(message) {
  fs.mkdirSync(root, {recursive:true, mode:0o700});
  const current = read(statusFile, {});
  store.atomicWrite(statusFile, JSON.stringify({...current, state:'failed', pid:null, finishedAt:new Date().toISOString(), lastError:message}));
}
function startBackup() {
  if (getStatus().state === 'running') return false;
  fs.mkdirSync(root, {recursive:true, mode:0o700});
  const child = spawn(process.env.OPENCLAW_BACKUP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [
    require('./runtime-platform').scriptPath('backup_instances.py'), '--source', store.DATA_ROOT, '--destination', root,
  ], {detached:true, stdio:'ignore', windowsHide:true});
  pendingPid = child.pid || null;
  child.once('error', () => failure('无法启动备份程序，请检查 Python 和备份目录权限'));
  child.once('exit', code => {
    if (pendingPid === child.pid) pendingPid = null;
    const current = read(statusFile, {});
    if (code !== 0 && current.state !== 'failed' && (current.state !== 'running' || current.pid === child.pid)) failure('备份进程异常退出，请检查磁盘空间及文件访问权限');
  });
  child.unref();
  return true;
}
const router = express.Router();
router.get('/status', async (req,res,next) => {try {const host=require('./host-control');res.json(host.enabled()?await host.request('backup-status'):getStatus());} catch(error) {next(error);}});
router.post('/run', async (req,res,next) => {
  try {
    const host=require('./host-control');if(host.enabled())return res.status(202).json(await host.request('backup-run'));
    if (!startBackup()) return res.status(409).json({error:'备份正在执行，请等待完成'});
    res.status(202).json({ok:true, hint:'备份已开始，实例会继续运行'});
  } catch(error) {next(error);}
});
module.exports = { router, getStatus, startBackup, calendar, root };
