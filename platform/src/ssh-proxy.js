'use strict';
// Each connection has its own loopback origin and cookie namespace. All traffic,
// including SSE, Docker exec terminals and Gateway WebSockets, stays inside SSH.
const http = require('http');
const crypto = require('crypto');
const fs=require('fs'),path=require('path');
const workspaceAssets=new Map(['devices.js','devices.css'].map(name=>['/'+name,path.join(__dirname,'../public',name)]));

function forward(client, port, callback) {
  client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, callback);
}
function agent(client, port) {
  const result = new http.Agent({keepAlive:false});
  result.createConnection = (_, callback) => forward(client, port, callback);
  return result;
}
function trusted(req, port) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(req.headers.host)) return false;
  if (req.headers.origin && !allowed.some(h => req.headers.origin === `http://${h}`)) return false;
  if(req.method==='GET'&&!req.headers.origin&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document')return true;
  return !['cross-site','same-site'].includes(req.headers['sec-fetch-site']);
}
function headersFor(req, remotePort, cookieName) {
  const headers = {...req.headers, host:`127.0.0.1:${remotePort}`};
  if (headers.origin) headers.origin = `http://127.0.0.1:${remotePort}`;
  if (cookieName) {
    const match = (headers.cookie || '').split(/;\s*/).find(c => c.startsWith(cookieName + '='));
    headers.cookie = match ? 'openclaw_manager_session=' + match.slice(cookieName.length + 1) : '';
  } else {
    // Manager session cookies must never reach an instance Gateway.
    delete headers.cookie;
    delete headers.authorization;
  }
  return headers;
}
function requestJSON(client, port, route, headers, { allowAuthenticationRequired = false } = {}) {
  return new Promise((resolve, reject) => {
    const pool = agent(client, port);
    const req = http.get({host:'127.0.0.1',port,path:route,headers,agent:pool}, res => {
      let raw = '';
      res.on('data', b => {raw += b; if (raw.length > 2*1024*1024) req.destroy(new Error('远程响应过大'));});
      res.on('error', reject);
      res.on('end', () => {
        pool.destroy();
        if (res.statusCode === 401 && allowAuthenticationRequired) {
          try { if (JSON.parse(raw).authenticationRequired === true) return resolve({ authenticationRequired: true }); } catch {}
        }
        if (res.statusCode !== 200) return reject(Object.assign(new Error('远程会话已过期或实例不存在'),{statusCode:res.statusCode}));
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('远程管理服务响应格式错误')); }
      });
    });
    // SSH channels are Duplex streams, not net.Sockets; use a request deadline.
    const timer=setTimeout(() => req.destroy(new Error('远程服务未响应')),15000);
    req.once('close',()=>clearTimeout(timer));
    req.on('error', e => {pool.destroy();reject(e);});
  });
}
function rewriteInstances(value) {
  if (!value || typeof value !== 'object') return;
  if (value.id && value.uiUrl && Number.isInteger(value.port)) value.uiUrl = `/ssh-gateway/${encodeURIComponent(value.id)}/`;
  for (const v of Object.values(value)) if (v && typeof v === 'object') rewriteInstances(v);
}
function proxyServer(client, remotePort, {cookieName, context, gateway} = {}) {
  const pool = agent(client, remotePort);
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    if (!trusted(req, server.address().port)) {res.writeHead(403);return res.end('拒绝不可信的来源');}
    try {
      if (context && req.url === '/api/connections/context') {
        res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
        return res.end(JSON.stringify(typeof context==='function'?context():context));
      }
      // The current device switcher also works with older remote frontends.
      const workspaceAsset=context&&workspaceAssets.get(req.url.split('?')[0]);
      if(workspaceAsset&&req.method==='GET'){
        res.setHeader('Content-Type',workspaceAsset.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');
        res.setHeader('Cache-Control','no-store');return fs.createReadStream(workspaceAsset).on('error',()=>res.destroy()).pipe(res);
      }
      if (context && req.url.startsWith('/api/connections')) {res.writeHead(403);return res.end('请在本机管理页管理 SSH 连接');}
      const match = /^\/ssh-gateway\/([a-z0-9_-]+)\/$/i.exec(req.url);
      if (gateway && match && req.method === 'GET') {
        const data = await requestJSON(client, remotePort, '/api/instances', headersFor(req,remotePort,cookieName));
        const inst = data.instances?.find(row=>row.id===match[1]);
        if (!inst || !Number.isInteger(inst.port) || inst.port < 1024 || inst.port > 65535) throw new Error('实例端口不合法');
        const url = await gateway(inst.id, inst.port);
        res.writeHead(302, {Location:url, 'Cache-Control':'no-store'});return res.end();
      }
      const requestHeaders=headersFor(req,remotePort,cookieName);if(context)delete requestHeaders['accept-encoding'];
      // The outer origin already validated this document navigation. Older
      // Managers reject its original cross-site metadata even over trusted SSH.
      if(context&&req.method==='GET'&&/^\/(?:\?|$)/.test(req.url)&&!req.headers.origin&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document')requestHeaders['sec-fetch-site']='same-origin';
      if(context&&/^\/(?:\?|$)/.test(req.url)){delete requestHeaders['if-none-match'];delete requestHeaders['if-modified-since'];}
      const upstream = http.request({host:'127.0.0.1',port:remotePort,path:req.url,method:req.method,
        headers:requestHeaders,agent:pool}, response => {
        const headers = {...response.headers};
        if (cookieName && headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map(c => c.replace(/^openclaw_manager_session=/,cookieName+'='));
        const rewrite = gateway && req.url.startsWith('/api/instances') && /application\/json/.test(headers['content-type'] || '');
        const workspaceHTML=context&&req.method==='GET'&&/^\/(?:\?|$)/.test(req.url)&&/text\/html/.test(headers['content-type']||'');
        response.on('error', () => res.destroy());
        if (!rewrite&&!workspaceHTML) {res.writeHead(response.statusCode,headers);response.pipe(res);return;}
        let body = '';
        response.on('data', b => {body += b; if(body.length > 32*1024*1024) upstream.destroy(new Error('远程响应过大'));});
        response.on('end', () => {
          if(workspaceHTML){
            if(!body.includes('data-manager-ui="react"')){
              if(!body.includes('src="/devices.js'))body=body.replace('</body>','<script src="/devices.js?v=unified-devices-20261016"></script></body>');
              if(!body.includes('href="/devices.css'))body=body.replace('</head>','<link rel="stylesheet" href="/devices.css?v=unified-devices-20261016"></head>');
            }
          }else try {const data=JSON.parse(body);rewriteInstances(data);body=JSON.stringify(data);} catch { /* retain remote error */ }
          delete headers['content-length'];delete headers['transfer-encoding'];
          if(workspaceHTML){delete headers.etag;delete headers['last-modified'];headers['cache-control']='no-store';}
          res.writeHead(response.statusCode,headers);res.end(body);
        });
      });
      upstream.on('error', () => {if(!res.headersSent)res.writeHead(502);res.end('SSH 隧道或远程服务不可用');});
      req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());
      req.pipe(upstream);
    } catch (error) {res.writeHead(error.statusCode || 502, {'Content-Type':'text/plain; charset=utf-8'});res.end(error.message);}
  });
  server.on('connection', socket => {sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade', (req, socket, head) => {
    if (!trusted(req,server.address().port)) return socket.destroy();
    forward(client,remotePort,(error, stream) => {
      if (error) return socket.destroy();
      stream.on('error',()=>socket.destroy());socket.on('error',()=>stream.destroy());
      const headers=headersFor(req,remotePort,cookieName);
      stream.write(`${req.method} ${req.url} HTTP/1.1\r\n`+Object.entries(headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');
      if(head.length)stream.write(head);
      stream.pipe(socket).pipe(stream);
      socket.on('close',()=>stream.destroy());stream.on('close',()=>socket.destroy());
    });
  });
  server.dispose = () => {server.publicOrigin?.close();pool.destroy();for(const socket of sockets)socket.destroy();server.close();};
  return server;
}
async function listen(server) {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  if(process.env.MANAGER_CONTAINERIZED==='1'){server.publicOrigin=require('./ssh-origins').register(server);return server.publicOrigin.url;}
  return `http://127.0.0.1:${server.address().port}/`;
}
async function createProxy(client, remotePort, context) {
  const gateways=new Map();
  const gateway=async(id,port)=>{
    if(gateways.get(id)?.port===port)return gateways.get(id).url;
    gateways.get(id)?.server.dispose();
    const server=proxyServer(client,port);
    const url=await listen(server);gateways.set(id,{server,url,port});return url;
  };
  const server=proxyServer(client,remotePort,{cookieName:'openclaw_ssh_'+crypto.randomBytes(12).toString('hex'),context,gateway});
  const url=await listen(server);
  return {url, close(){server.dispose();for(const row of gateways.values())row.server.dispose();gateways.clear();}};
}
module.exports={createProxy,requestJSON,trusted,headersFor,rewriteInstances};
