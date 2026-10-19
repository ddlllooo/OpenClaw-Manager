'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function socketPath(platform = process.platform, home = os.homedir(), exists = fs.existsSync) {
  if (platform === 'win32') return '//./pipe/docker_engine';
  const desktop = path.join(home, '.docker/run/docker.sock');
  if (platform === 'darwin' || exists(desktop)) return desktop;
  const rootless = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, 'docker.sock');
  return exists(rootless) ? rootless : '/var/run/docker.sock';
}
function dockerSocket() {
  if (process.env.DOCKER_SOCKET) return process.platform==='win32' ? process.env.DOCKER_SOCKET.replace(/\\/g,'/') : process.env.DOCKER_SOCKET;
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith('unix://')) return host.slice(7);
  if (host?.startsWith('npipe://')) return host.slice(8);
  if (host) throw new Error('本地模式支持 unix/npipe Docker 连接；远程设备请使用 SSH 连接功能');
  return socketPath();
}
function bindPath(value) { return process.platform === 'win32' ? value.replace(/\\/g, '/') : value; }
function scriptPath(name) {
  const file=path.join(__dirname,'..','scripts',name);
  // Python is an external process and cannot read Electron's virtual ASAR FS.
  return file.replace(/\.asar([/\\])/,'.asar.unpacked$1');
}
function instanceUser() {
  if(process.env.OPENCLAW_INSTANCE_USER)return process.env.OPENCLAW_INSTANCE_USER;
  // Native Linux bind mounts retain host ownership. Run with that identity so a
  // non-root desktop user can edit the same files as the instance container.
  if(process.platform==='linux'&&process.env.MANAGER_CONTAINERIZED!=='1'&&process.getuid?.()>0)return `${process.getuid()}:${process.getgid()}`;
  return null;
}
function diskInfo(root) {
  try {
    const stat = fs.statfsSync(root);
    return { total: stat.blocks * stat.bsize, available: stat.bavail * stat.bsize };
  } catch { return null; }
}
module.exports = { socketPath, dockerSocket, bindPath, diskInfo, instanceUser, scriptPath };
