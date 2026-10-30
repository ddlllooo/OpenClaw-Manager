'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./instances');
function home() { return process.env.OPENCLAW_STARTUP_HOME || path.dirname(store.instancesRoot()); }
function restartPolicy(id, fallback = {Name:'unless-stopped'}) {
  if (require('./storage').isBlocked(id)||require('./storage').requiresMountGuard(id)) return {Name:'no'};
  const file=path.join(home(),'startup-settings.json');
  if (!fs.existsSync(file)) return fallback;
  const settings=JSON.parse(fs.readFileSync(file,'utf8'));
  if(typeof settings.instancesAutoStart!=='boolean'||!settings.instanceOverrides||typeof settings.instanceOverrides!=='object') throw new Error('启动设置损坏，请检查启动与恢复设置');
  return {Name:settings.instancesAutoStart && settings.instanceOverrides[id]!==false ? 'unless-stopped':'no'};
}
module.exports={home,restartPolicy};
