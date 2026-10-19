'use strict';
const crypto = require('crypto');
const sessions = new Map();
const TTL = 8 * 60 * 60 * 1000;
const COOKIE = 'openclaw_manager_session';
function trusted(req) {
  const port = String(process.env.MANAGER_PORT || 18080);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && !hosts.has((() => { try { const u = new URL(origin); return u.protocol === 'http:' ? u.host : ''; } catch { return ''; } })())) return false;
  if(req.method==='GET'&&!origin&&/^\/(?:\?|$)/.test(req.url||'')&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document')return true;
  return !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
}
function tokenFrom(req) {
  const match = /(?:^|;\s*)openclaw_manager_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return match ? match[1] : '';
}
function authenticated(req) {
  if (!trusted(req)) return false;
  const session = sessions.get(tokenFrom(req));
  return Boolean(session && session.expires > Date.now());
}
function middleware(req, res, next) {
  if (!trusted(req)) return res.status(403).json({ error: '拒绝不可信的 Host 或 Origin' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  if (!req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-store');
  if (req.path === '/api/session' && req.method === 'GET') {
    for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
    let token = tokenFrom(req), session = sessions.get(token);
    if (!session || session.expires <= Date.now()) {
      if (sessions.size >= 128) return res.status(429).json({ error: '管理会话过多，请稍后重试' });
      token = crypto.randomBytes(32).toString('hex');
      session = { csrf: crypto.randomBytes(32).toString('hex'), expires: Date.now() + TTL };
      sessions.set(token, session);
    }
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}`);
    return res.json({ csrf: session.csrf });
  }
  if (!authenticated(req)) return res.status(401).json({ error: '管理会话已过期，请刷新页面' });
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (req.headers['x-csrf-token'] !== sessions.get(tokenFrom(req)).csrf) return res.status(403).json({ error: '请求校验失败，请刷新页面' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return res.status(415).json({ error: '请使用 JSON 请求' });
  }
  next();
}
module.exports = { middleware, authenticated, trusted };
