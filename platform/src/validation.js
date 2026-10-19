'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('./instances');
module.exports.validate = async function validate(instance, content) {
  const parsed = JSON.parse(content);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('配置必须为对象');
  if (content.includes('__OPENCLAW_REDACTED__')) throw new Error('配置含脱敏占位符，拒绝保存');
  // CLI validates a separate candidate, so an invalid edit never reaches the live file.
  const name = `.manager-candidate-${crypto.randomBytes(8).toString('hex')}.json`;
  const file = path.join(store.configDir(instance.id), name);
  store.atomicWrite(file, content);
  try {
    if (!instance.containerId) throw new Error('请先启动实例以执行配置校验');
    await new Promise((resolve, reject) => {
      execFile('docker', ['exec', '-e', `OPENCLAW_CONFIG_PATH=/home/node/.openclaw/${name}`, instance.containerName,
        'openclaw', 'config', 'validate', '--json'], { timeout: 30000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error('配置校验失败：' + String(stderr || stdout || 'CLI 执行失败').slice(0, 400)));
        try { const result = JSON.parse(stdout); if (result.valid === false) throw new Error('配置未通过 schema 校验'); } catch (e) { if (e.message === '配置未通过 schema 校验') return reject(e); }
        resolve();
      });
    });
  } finally { fs.unlinkSync(file); }
};
