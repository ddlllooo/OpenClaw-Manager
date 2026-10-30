 'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-security-'));
process.env.OPENCLAW_DATA_DIR = path.join(scratch, 'instances');
delete process.env.MANAGER_AUTH_TOKEN;
const security = require('../src/security');
const express = require('express');
const app = express(); app.use(security.middleware); app.use(express.json());
app.get('/api/private', (req,res) => res.json({ok:true}));
app.post('/api/private', (req,res) => res.json({ok:true}));
let server, port;
function request(route, headers={}, method='GET') {
  return new Promise((resolve,reject) => {
    const req = http.request({hostname:'127.0.0.1',port,path:route,method,headers:{Host:'127.0.0.1:18080',...headers}}, res => {
      let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(raw)}));
    }); req.on('error',reject); if(method==='POST')req.write('{}');req.end();
  });
}
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));port=server.address().port;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(scratch,{recursive:true,force:true});});
test('anonymous and forged credentials cannot mint a session or access APIs',async()=>{
  for(const headers of [{},{Authorization:'Bearer wrong'},{Cookie:'openclaw_manager_session='+'a'.repeat(64)}]) {
    const result=await request('/api/session',headers);assert.equal(result.status,401);assert.equal(result.headers['set-cookie'],undefined);assert.equal(result.body.csrf,undefined);
  }
  assert.equal((await request('/api/private')).status,401);
});
test('credential is persisted outside instance data and survives module reload',()=>{
  const token=security.managementToken();assert.match(token,/^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(security.credentialFile(),'utf8'),token);
  delete require.cache[require.resolve('../src/security')];
  assert.equal(require('../src/security').managementToken(),token);
});
test('authenticated bootstrap retains session refresh, Host, Origin and CSRF protection',async()=>{
  const Authorization='Bearer '+security.managementToken();
  assert.equal((await request('/api/session',{Authorization,Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await request('/api/session',{Authorization,Host:'attacker.invalid'})).status,403);
  const login=await request('/api/session',{Authorization});assert.equal(login.status,200);
  const Cookie=login.headers['set-cookie'][0].split(';')[0];assert.match(login.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/private',{Cookie})).status,200);
  assert.equal((await request('/api/session',{Cookie})).body.csrf,login.body.csrf);
  assert.equal((await request('/api/private',{Cookie,'Content-Type':'application/json'},'POST')).status,403);
  assert.equal((await request('/api/private',{Cookie,'Content-Type':'application/json','X-CSRF-Token':login.body.csrf},'POST')).status,200);
});
const config=require('../src/model-config'),metadata=require('../src/model-metadata');
const stored={baseUrl:'https://provider.invalid/v1',apiKey:'synthetic-key'};
test('inherited key is bound to protocol, hostname and port, including copyKeyFrom',()=>{
  for(const baseUrl of ['https://attacker.invalid/v1','https://provider.invalid:8443/v1','http://provider.invalid/v1']) {
    assert.throws(()=>config.credentials({}, {baseUrl}, stored),/来源/);
    const cfg={models:{providers:{'openclaw-mgr-test':{...stored,models:[{id:'demo'}]}}}};
    assert.throws(()=>config.credentials(cfg,{baseUrl,copyKeyFrom:'demo'}),/来源/);
  }
  assert.equal(config.credentials({}, {baseUrl:'https://provider.invalid/v2'},stored).apiKey,'synthetic-key');
  assert.equal(config.credentials({}, {baseUrl:'https://new.invalid',apiKey:'new-key'},stored).apiKey,'new-key');
});
test('HTTP is limited to loopback and explicitly allowed origins; metadata never sends blocked keys',async()=>{
  config.credentials({}, {baseUrl:'http://127.0.0.1:11434/v1',apiKey:'local'});
  assert.throws(()=>config.credentials({}, {baseUrl:'http://192.168.1.2/v1',apiKey:'key'}),/HTTPS/);
  let calls=0;
  await metadata.detect({model:'unknown',baseUrl:'http://public.invalid',apiKey:'key',fetcher:async()=>{calls++;throw Error('must not send');}});
  assert.equal(calls,0);
  process.env.MANAGER_MODEL_HTTP_ORIGINS='http://192.168.1.2:8080';
  try {
    config.credentials({}, {baseUrl:'http://192.168.1.2:8080/v1',apiKey:'key'});
    assert.throws(()=>config.credentials({}, {baseUrl:'http://192.168.1.2:8081/v1',apiKey:'key'}),/HTTPS/);
  } finally {delete process.env.MANAGER_MODEL_HTTP_ORIGINS;}
});
test('gateway forwarding strips management bearer credentials',()=>{
  const headers=require('../src/ssh-proxy').headersFor({headers:{authorization:'Bearer secret',cookie:'secret'}},18789);
  assert.equal(headers.authorization,undefined);assert.equal(headers.cookie,undefined);
});
