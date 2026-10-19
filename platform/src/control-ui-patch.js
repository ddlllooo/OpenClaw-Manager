'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Static UI patch for one exact image ID. No instance data/configuration mounts.
async function applyControlUiPatch(container, imageId, patchDir = path.join(__dirname, '../control-ui-patches')) {
  const manifestPath = path.join(patchDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.imageId !== imageId) return false;
  const archive = fs.readFileSync(path.join(patchDir, 'payload.tar'));
  if (archive.length > 20 * 1024 * 1024 || crypto.createHash('sha256').update(archive).digest('hex') !== manifest.archiveSHA256) {
    throw new Error('控制台静态补丁校验失败，已停止创建新容器');
  }
  await container.putArchive(archive, {path: '/app/dist/control-ui'});
  return true;
}
module.exports = {applyControlUiPatch};
