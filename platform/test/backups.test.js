'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-backup-status-'));
process.env.OPENCLAW_DATA_DIR = path.join(root,'instances');
process.env.OPENCLAW_BACKUP_DIR = path.join(root,'backups');
fs.mkdirSync(process.env.OPENCLAW_BACKUP_DIR);
const backups = require('../src/backups');
const file = path.join(backups.root,'status.json');
test('failed backup status preserves prior successful backup for UI',()=>{
  fs.writeFileSync(file,JSON.stringify({state:'failed',lastError:'disk full',lastSuccess:{date:'2026-10-14',archive:'fixture'}}));
  const result=backups.getStatus();
  assert.equal(result.state,'failed');assert.equal(result.lastSuccess.archive,'fixture');assert.equal(result.retentionDays,7);
});
test('crashed worker is shown as failed rather than running forever',()=>{
  fs.writeFileSync(file,JSON.stringify({state:'running',pid:999999999}));
  assert.equal(backups.getStatus().state,'failed');
});
test('schedule reports Shanghai time and missing daily success is actionable',()=>{
  fs.writeFileSync(path.join(backups.root,'schedule.json'),JSON.stringify({enabled:true,hour:3,minute:30,timezone:'Asia/Shanghai'}));
  fs.writeFileSync(file,JSON.stringify({state:'never'}));
  const result=backups.getStatus();
  assert.equal(result.state,'overdue');
  assert.equal(new Date(result.nextRunAt).getUTCHours(),19);assert.equal(new Date(result.nextRunAt).getUTCMinutes(),30);
});
