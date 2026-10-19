'use strict';
// Image work and cleanup cannot overlap. HTTP mutations also consult active.
let active = false;
const users = new Set();
function conflict() { return Object.assign(new Error('平台正在清理升级历史，请稍后重试'), { statusCode: 409 }); }
async function use(fn) {
  if (active) throw conflict();
  const token = {}; users.add(token);
  try { return await fn(); } finally { users.delete(token); }
}
async function clean(isBusy, fn) {
  if (active || users.size || isBusy()) return { deferred: true };
  active = true;
  try { return await fn(); } finally { active = false; }
}
module.exports = { use, clean, conflict, get active() { return active; } };
