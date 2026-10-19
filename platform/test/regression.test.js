'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { EventEmitter } = require('events');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-regression-'));
process.env.OPENCLAW_DATA_DIR = scratch;
process.env.MANAGER_PORT = '18080';
// Host port checks are mocked; these tests never start Docker or use live data.
const cp = require('child_process');
const originalExec = cp.execFileSync;
cp.execFileSync = () => Buffer.alloc(0);
const store = require('../src/instances');
const calls = [];
let failUpdate = false, cliFail = false, stateRunning = true;
const docker = {
  dockerInfo: async () => ({ ncpu: 10, memTotal: 8 * 1024**3 }),
  listResourceContainers: async () => store.listInstanceIds().map(id => store.loadInstance(id)).filter(r => r.containerId).map(r => ({
    id:r.containerId, name:r.containerName, instanceId:r.id, managed:true,
    state:stateRunning ? 'running' : 'exited', resources:r.resources,
  })),
  inspectContainer: async () => ({ State: { Running: stateRunning }, Config: {} }),
  resourceOptions: r => ({ nanoCpus: r.nanoCpus, memory: r.memoryBytes }),
  updateResources: async (id, opts) => { calls.push(['update', opts]); if (failUpdate) throw new Error('update rejected'); },
  startContainer: async () => {}, restartContainer: async () => {},
  stopContainer: async () => {}, removeContainer: async () => {},
  shortDockerError: err => err.message,
};
require.cache[require.resolve('../src/docker')] = { id: require.resolve('../src/docker'), filename: require.resolve('../src/docker'), loaded: true, exports: docker };
require.cache[require.resolve('../src/validation')] = { id: 'validation', loaded: true, exports: { validate: async () => {} } };
require.cache[require.resolve('../src/lifecycle')] = { id: 'lifecycle', loaded: true, exports: { ready: async () => true, start: async () => {}, restart: async () => {} } };
cp.execFile = (cmd,args,opts,cb) => {
  calls.push(['cli', args]);
  if (cliFail) cb(new Error('nonzero exit'), 'warning', 'fatal failure');
  else cb(null, '{}', '');
  return { stdin: { end() {} } };
};
const express = require('express');
const app = express();
const security = require('../src/security');
const operations = require('../src/operations');
app.use(security.middleware);
app.use(express.json());
app.use('/api/instances', operations.middleware);
const instances = require('../src/routes/instances');
instances.bind(() => ({ state: stateRunning ? 'running' : 'exited' }), async () => {});
app.use('/api/instances', instances);
app.use('/api/instances', require('../src/routes/config'));
app.use('/api/instances', require('../src/routes/openclaw'));
app.use('/api/instances', require('../src/routes/sessions'));
app.use((err,req,res,next) => res.status(err.statusCode || 500).json({error:err.message}));
let server, port, cookie, csrf;
function request(url, method='GET', body, headers={}, auth=true) {
  return new Promise((resolve,reject) => {
    const req = http.request({ hostname:'127.0.0.1', port, path:url, method,
      headers:{Host:'127.0.0.1:18080','Content-Type':'application/json', ...(auth ? {Cookie:cookie,'X-CSRF-Token':csrf} : {}),...headers} }, res => {
      let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(raw||'{}')}));
    });req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();
  });
}
function fixture(id='fixture') {
  const inst={id,name:'fixture',port:19001,gatewayToken:'dummy-token',containerId:'old-container',containerName:'openclaw-'+id,
    image:'fixture:local',resources:{cpus:1,nanoCpus:1e9,memoryBytes:1024**3},createdAt:new Date().toISOString()};
  store.saveInstance(inst);
  store.writeOpenclawConfig(id,JSON.stringify({gateway:{auth:{token:inst.gatewayToken},controlUi:{allowedOrigins:['http://127.0.0.1:19001']}},channels:{feishu:{appId:'dummy-app',appSecret:'dummy-real-secret'}},plugins:{entries:{feishu:{enabled:true}}}}));
  store.writeEnvFile(id,'OPENCLAW_GATEWAY_TOKEN=dummy-token\nAPI_KEY=abcde\nLONG_KEY=abcdefg');
  return inst;
}
test.before(async () => {
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));port=server.address().port;
  const result=await request('/api/session','GET',undefined,{},false);
  cookie=result.headers['set-cookie'][0].split(';')[0];csrf=result.body.csrf;
});
test.after(async () => { cp.execFileSync=originalExec; server.closeAllConnections();await new Promise(r=>server.close(r)); });
test('API requires local session, trusted Host/Origin and CSRF',async()=>{
  assert.equal((await request('/api/instances','GET',undefined,{},false)).status,401);
  assert.equal((await request('/api/instances','GET',undefined,{Host:'attacker.invalid'})).status,403);
  assert.equal((await request('/api/instances','GET',undefined,{Origin:'http://attacker.invalid'})).status,403);
  assert.equal((await request('/api/instances','POST',{}, {'X-CSRF-Token':'wrong'})).status,403);
});
test('restore keeps free port, clears old container, synchronizes origins',async()=>{
  fixture('restorecase');store.archiveInstanceData('restorecase');
  const restored=store.restoreKeptInstance('restorecase');
  assert.equal(restored.containerId,null);assert.equal(restored.port,19001);
  assert.deepEqual(JSON.parse(store.readOpenclawConfig(restored.id)).gateway.controlUi.allowedOrigins,['http://127.0.0.1:19001','http://localhost:19001']);
  assert.throws(()=>store.instanceDir('../escape'));
});
test('masked short secrets survive PUT and stale revisions are rejected',async()=>{
  fixture();const get=await request('/api/instances/fixture/env');
  const put=await request('/api/instances/fixture/env','PUT',get.body);
  assert.equal(put.status,200);assert.match(store.readEnvFile('fixture'),/API_KEY=abcde/);assert.match(store.readEnvFile('fixture'),/LONG_KEY=abcdefg/);
  const changed=await request('/api/instances/fixture/env','PUT',{content:get.body.content+'\nX=new',revision:get.body.revision});
  assert.equal(changed.status,200);
  assert.equal((await request('/api/instances/fixture/env','PUT',get.body)).status,409);
  assert.equal(store.loadInstance('fixture').envPending,true);
});
test('resource failure leaves record unchanged; stopped container is updated',async()=>{
  fixture();failUpdate=true;
  assert.equal((await request('/api/instances/fixture/resources','PATCH',{cpus:2})).status,500);
  assert.equal(store.loadInstance('fixture').resources.cpus,1);
  failUpdate=false;stateRunning=false;calls.length=0;
  assert.equal((await request('/api/instances/fixture/resources','PATCH',{cpus:2})).status,200);
  assert.ok(calls.some(c=>c[0]==='update'));assert.equal(store.loadInstance('fixture').resources.cpus,2);
  assert.equal((await request('/api/instances/fixture/resources','PATCH',{memory:-1})).status,500);
  stateRunning=true;
});
test('Feishu blank secret preserves the real credential and skips reinstall',async()=>{
  fixture();calls.length=0;
  const result=await request('/api/instances/fixture/feishu','PUT',{appId:'dummy-app',appSecret:''});
  assert.equal(result.status,200);
  const cli=calls.filter(c=>c[0]==='cli').map(c=>c[1]);
  assert.ok(!cli.some(args=>args.includes('install')));
  const channelWrite=cli.find(args=>args.includes('channels.feishu'));
  assert.ok(channelWrite.some(arg=>arg.includes('dummy-real-secret')));
  const invalid=await request('/api/instances/fixture/feishu','PUT',{appId:'dummy-app',appSecret:'__OPENCLAW_REDACTED__'});
  assert.equal(invalid.status,400);
});
test('CLI warning stdout cannot mask a failed deletion',async()=>{
  fixture();cliFail=true;
  const result=await request('/api/instances/fixture/sessions/delete','POST',{keys:['dummy']});
  assert.equal(result.status,502);assert.notEqual(result.body.ok,true);cliFail=false;
});
test('stopped sessions return 409 while stored model config remains readable',async()=>{
  fixture();stateRunning=false;
  assert.equal((await request('/api/instances/fixture/sessions')).status,409);
  assert.equal((await request('/api/instances/fixture/model')).status,200);
  stateRunning=true;
});
test('list never exposes Gateway credentials',async()=>{
  fixture();const result=await request('/api/instances');assert.equal(result.status,200);
  assert.ok(result.body.instances.every(i=>!('gatewayToken' in i)));
});
test('HTTP 404 and HTML cannot pass JSON health check',async()=>{
  const probeServer=http.createServer((req,res)=>{res.statusCode=req.url==='/404'?404:200;res.end(req.url==='/good'?' {"ready":true}':'<html>fallback</html>');});
  await new Promise(r=>probeServer.listen(0,'127.0.0.1',r));
  const probe=require('../src/monitor').probe;const base='http://127.0.0.1:'+probeServer.address().port;
  assert.equal((await probe(base+'/404')).ok,false);assert.equal((await probe(base+'/html')).ok,false);assert.equal((await probe(base+'/good')).ok,true);
  await new Promise(r=>probeServer.close(r));
});
test('mirror and digest reference parsing use consistent pull/create names',()=>{
  const module={exports:{}};class Docker {constructor(){this.modem={};}}
  const source=fs.readFileSync(path.join(__dirname,'../src/docker.js'),'utf8');
  const sourceRequire=require('module').createRequire(path.join(__dirname,'../src/docker.js'));
  vm.runInNewContext(source,{require:n=>n==='dockerode'?Docker:sourceRequire(n),module,__dirname:path.join(__dirname,'../src'),Buffer,process:{env:{DOCKER_MIRROR_PREFIX:'mirror.example'}},console});
  const dm=module.exports;
  assert.equal(dm.resolveImage('docker.io/openclaw/openclaw:latest'),'mirror.example/openclaw/openclaw:latest');
  assert.equal(dm.resolveImage('ghcr.io/org/image:tag'),'ghcr.io/org/image:tag');
  assert.deepEqual(Array.from(dm.splitImageTag('repo/image@sha256:abc')),['repo/image@sha256:abc',null]);
});
test('a delayed response cannot populate a different instance view',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const apiCode=source.slice(source.indexOf('let csrfToken'),source.indexOf('function logEvent'));
  let complete;
  const state={selectedId:'first'};
  const context={state,DOMException,fetch:async url=>url==='/api/session'?{ok:true,json:async()=>({csrf:'dummy'})}:await new Promise(resolve=>{complete=resolve;})};
  vm.createContext(context);vm.runInContext(apiCode+'\nthis.runApi=api;',context);
  const response=context.runApi('/api/instances/first/model');
  await new Promise(resolve=>setImmediate(resolve));
  state.selectedId='second';complete({ok:true,status:200,json:async()=>({models:['wrong-instance']})});
  await assert.rejects(response,error=>error.name==='AbortError');
});
test('failed container replacement restores the original container and record',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/lifecycle.js'),'utf8');
  const module={exports:{}};const events=[];let saved;
  const inst={id:'rollbackcase',containerId:'original',containerName:'openclaw-rollbackcase',port:19099,resources:{},gatewayToken:'dummy'};
  const dm={inspectContainer:async()=>({Id:'original',Image:'fixed-image',State:{Running:true}}),
    getContainer:()=>({rename:async value=>events.push(['rename',value.name])}),
    stopContainer:async id=>events.push(['stop',id]),createInstanceContainer:async()=> 'replacement',
    startContainer:async id=>{events.push(['start',id]);if(id==='replacement')throw new Error('startup failed');},
    removeContainer:async id=>events.push(['remove',id])};
  const fakeStore={parseEnv:()=>({}),readEnvFile:()=>'',configDir:()=>'/dummy',workspaceDir:()=>'/dummy/workspace',authDir:()=>'/dummy/auth',saveInstance:value=>{saved=JSON.parse(JSON.stringify(value));}};
  vm.runInNewContext(source,{require:name=>name==='./instances'?fakeStore:name==='./docker'?dm:require(name),module,console,setTimeout});
  await assert.rejects(module.exports.replace(inst),/startup failed/);
  assert.equal(saved.containerId,'original');
  assert.ok(events.some(event=>event[0]==='rename'&&event[1]==='openclaw-rollbackcase'));
  assert.ok(events.some(event=>event[0]==='start'&&event[1]==='original'));
  assert.ok(events.some(event=>event[0]==='remove'&&event[1]==='replacement'));
});
