'use strict';

const fs = require('node:fs');
const path = require('node:path');

const defaultFile = path.join(__dirname, '..', '.env');

// Use Node's dotenv parser, without changing an explicitly supplied environment.
// The file is resolved relative to the app, not the caller's working directory.
function load(file = process.env.OPENCLAW_ENV_FILE || defaultFile) {
  const explicit = Boolean(process.env.OPENCLAW_ENV_FILE);
  const resolved = path.resolve(file);
  // Compose's historical empty default means "use the generated credential";
  // allow a non-empty value in the private config file to replace that default.
  if (process.env.MANAGER_AUTH_TOKEN === '') delete process.env.MANAGER_AUTH_TOKEN;
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
    process.loadEnvFile(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT' || explicit) {
      throw new Error(`无法读取 Manager 配置文件：${resolved}`);
    }
  }
  const token = process.env.MANAGER_AUTH_TOKEN;
  if (token && token.length < 32) {
    throw new Error('MANAGER_AUTH_TOKEN 至少需要 32 个字符，请修改 .env 或进程环境变量');
  }
  return resolved;
}

module.exports = { load, defaultFile };
