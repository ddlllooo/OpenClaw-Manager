'use strict';
const fs = require('node:fs');
const path = require('node:path');

// electron-builder excludes package-lock.json by name. SSH provisioning needs
// the lock inside the packaged app, so include a copy under its fallback name.
module.exports = async () => {
  const root = path.resolve(__dirname, '..');
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(root, 'deployment-lock.json'));
};
