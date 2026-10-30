'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-storage-api-'));
process.env.OPENCLAW_DATA_DIR=path.join(scratch,'instances');process.env.MANAGER_AUTH_TOKEN='storage-api-test-credential-0123456789abcdef';
const express=require('express'),security=require('../src/security'),store=require('../src/instances'),operations=require('../src/operations');
const docker=require('../src/docker'),originalListContainers=docker.listContainersByLabel;
docker.listContainersByLabel=async()=>[];
const app=express();app.use(security.middleware);app.use(express.json());app.use('/api/instances',operations.middleware,require('../src/routes/storage'));
app.post('/api/instances/:id/chat/stream',(req,res)=>res.json({dispatched:true}));
app.post('/api/instances/:id/chat/abort',(req,res)=>res.json({cancelled:true}));
app.post('/api/instances/:id/stop',(req,res)=>res.json({stopped:true}));
app.use((e,req,res,next)=>res.status(e.statusCode||500).json({error:e.message}));
let server,url,cookie,csrf;
async function request(suffix,method='GET',body,headers={}){
 return new Promise((resolve,reject)=>{
  const req=require('http').request(url+suffix,{method,agent:false,headers:{Host:'127.0.0.1:18080','Content-Type':'application/json',Cookie:cookie||'','X-CSRF-Token':csrf||'',...headers}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),headers:res.headers}));});
  req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
 });
}
test.before(async()=>{
 store.saveInstance({id:'fixture'});for(const dir of ['openclaw','workspace','auth'])fs.mkdirSync(path.join(store.instanceDir('fixture'),dir));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url='http://127.0.0.1:'+server.address().port;
 const session=await request('/api/session','GET',null,{Authorization:'Bearer '+process.env.MANAGER_AUTH_TOKEN});assert.equal(session.status,200);cookie=session.headers['set-cookie'][0].split(';')[0];csrf=session.body.csrf;
});
test.after(async()=>{docker.listContainersByLabel=originalListContainers;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(scratch,{recursive:true,force:true});});
test('storage APIs require a local authenticated session and mutation CSRF',async()=>{
 assert.equal((await request('/api/instances/fixture/storage','GET',null,{Cookie:''})).status,401);
 assert.equal((await request('/api/instances/fixture/storage/policy','PATCH',{limitGiB:10},{'X-CSRF-Token':'invalid'})).status,403);
 assert.equal((await request('/api/instances/fixture/storage')).body.hardQuota,false);
 assert.equal((await request('/api/instances/fixture/storage/policy','PATCH',{limitGiB:10,minFreeGiB:0})).status,200);
 assert.equal((await request('/api/instances/missing/storage')).status,404);
});
test('maintenance operations cannot bypass per-instance serialization or preview revisions',async()=>{
 operations.busy.set('fixture',{description:'another operation'});
 try{assert.equal((await request('/api/instances/fixture/storage/backups','POST',{})).status,409);}finally{operations.busy.delete('fixture');}
 assert.equal((await request('/api/instances/fixture/storage/cleanup','POST',{revision:'stale'})).status,409);
 assert.equal((await request('/api/instances/fixture/storage/policy','PATCH',{limitGiB:-10})).status,400);
});
test('capability probe is authenticated and unsupported hard mode returns a clear error',async()=>{
 const backend=require('../src/storage-quota'),original=backend.probe;backend.probe=async()=>({supported:false,reason:'测试宿主未启用项目配额'});
 try{
  assert.equal((await request('/api/instances/fixture/storage/capabilities','GET',null,{Cookie:''})).status,401);
  assert.equal((await request('/api/instances/fixture/storage/capabilities')).body.supported,false);
  const result=await request('/api/instances/fixture/storage/policy','PATCH',{mode:'hard',limitGiB:10});assert.equal(result.status,422);assert.match(result.body.error,/未启用项目配额/);
 }finally{backend.probe=original;}
});
test('protected instances reject new jobs with nonretryable 507 while cancel and maintenance remain available',async()=>{
 const storage=require('../src/storage');storage.setPolicy('fixture',{limitGiB:0.000001,minFreeGiB:0});fs.writeFileSync(path.join(store.workspaceDir('fixture'),'large'),Buffer.alloc(1024*1024));
 const blocked=await request('/api/instances/fixture/chat/stream','POST',{message:'new work'});assert.equal(blocked.status,507);assert.equal(blocked.body.retryable,false);assert.equal(blocked.body.dispatched,undefined);
 assert.equal((await request('/api/instances/fixture/chat/abort','POST',{})).status,200);
 assert.equal((await request('/api/instances/fixture/stop','POST',{})).status,200);
 assert.equal((await request('/api/instances/fixture/storage/cleanup')).status,200);
 assert.equal((await request('/api/instances/fixture/storage')).status,200);
});
