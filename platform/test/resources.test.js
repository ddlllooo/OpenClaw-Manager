'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const planner = require('../src/resource-planner');
const { imagePurpose } = require('../src/image-purpose');
const GiB = 1024 ** 3, MiB = 1024 ** 2;
const info = { ncpu: 10, memTotal: 8319504384 };
const manager = { id:'manager', name:'openclaw-manager', state:'running', resources:{cpus:0.75,memoryBytes:512*MiB} };
function pair(id, cpu, memory, state = 'running') {
  const record = {id, name:id, containerId:id, containerName:'openclaw-'+id, resources:{cpus:cpu,memoryBytes:memory}};
  const container = {id, name:record.containerName, instanceId:id, managed:true, state, resources:record.resources};
  return {record, container};
}

test('server-sized budget includes system, Manager and stopped primary; missing/rollback do not double count', () => {
  const pairs = [pair('a',1.5,2.1*GiB),pair('b',1.5,1.5*GiB),pair('c',1.5,1.4*GiB,'created')];
  const missing = {id:'missing',containerId:null,resources:{cpus:1.5,memoryBytes:2.3*GiB}};
  const rollback = {...pairs[0].container,id:'rollback',name:'openclaw-a-rollback-1',state:'exited'};
  const plan = planner.planResources(info,[...pairs.map(p=>p.record),missing],[manager,...pairs.map(p=>p.container),rollback]);
  assert.equal(plan.systemReservedCores,1);
  assert.equal(plan.systemReservedMemBytes,896*MiB);
  assert.equal(plan.reservedCores,4.5);
  assert.equal(plan.reservedMemBytes,5*GiB);
  assert.equal(plan.otherReservedMemBytes,512*MiB);
  assert.equal(plan.recommended.cpus,1);
  assert.equal(plan.recommended.memory,'1280m');
  assert.equal(plan.recommended.pidsLimit,192);
  assert.equal(plan.missingInstanceCount,1);
  assert.ok(plan.recommended.memoryBytes <= plan.remainMemBytes);
});

test('actual Docker drift and running rollback remain charged; quota-derived nanoCpus count', () => {
  const {record,container} = pair('a',1,GiB);
  container.resources = {nanoCpus:2e9,memoryBytes:2*GiB};
  const rollback = {...container,id:'old',name:'openclaw-a-rollback-1'};
  const plan = planner.planResources(info,[record],[container,rollback]);
  assert.equal(plan.reservedCores,2);
  assert.equal(plan.reservedMemBytes,2*GiB);
  assert.equal(plan.otherReservedCores,2);
});

test('low, exhausted, unknown and unlimited capacity never recommend zero/unlimited limits', () => {
  for (const memTotal of [256*MiB,GiB]) {
    const plan = planner.planResources({ncpu:1,memTotal},[],[]);
    assert.equal(plan.recommended,null);assert.equal(plan.canRecommend,false);
  }
  const plan = planner.planResources(info,[],[{...manager,resources:{}}]);
  assert.equal(plan.unbounded,true);assert.equal(plan.recommended,null);
  assert.ok(plan.warnings.some(w=>w.includes('上限')));
  assert.throws(()=>planner.planResources({ncpu:0,memTotal:0},[],[]),/不可用/);
});

test('large host recommendation is capped and rounds down to exact Docker/form units', () => {
  const plan = planner.planResources({ncpu:64,memTotal:128*GiB},[],[]);
  assert.equal(plan.recommended.cpus,2);assert.equal(plan.recommended.memory,'2048m');
  assert.equal(plan.recommended.pidsLimit,256);
  for (let i=0;i<50;i++) {
    const p = planner.planResources({ncpu:1+i/10,memTotal:(1+i/10)*GiB},[],[]);
    if (p.recommended) {
      assert.ok(p.recommended.cpus<=p.remainCores);
      assert.ok(p.recommended.memoryBytes<=p.remainMemBytes);
      assert.equal(Number(p.recommended.memory.slice(0,-1))*MiB,p.recommended.memoryBytes);
    }
  }
});

test('aggregate admission rejects increases but allows gradual repair when already overcommitted', () => {
  const plan = {...planner.planResources(info,[],[]),remainCores:0,remainMemBytes:0};
  assert.throws(()=>planner.assertCapacity({cpus:1,memoryBytes:GiB},plan),e=>e.statusCode===409);
  assert.doesNotThrow(()=>planner.assertCapacity({cpus:1,memoryBytes:GiB},plan,{cpus:2,memoryBytes:2*GiB}));
  assert.throws(()=>planner.assertCapacity({cpus:3,memoryBytes:GiB},plan,{cpus:2,memoryBytes:2*GiB}));
  assert.throws(()=>planner.assertCapacity({cpus:0,memoryBytes:0},plan));
});

test('in-flight reservations are charged once and serialized lock releases after failure', async () => {
  const {record,container} = pair('a',1,GiB);
  const pending = new Map([['a',record.resources],['new',{cpus:1,memoryBytes:GiB}]]);
  assert.equal(planner.planResources(info,[record],[container],null,pending).reservedMemBytes,2*GiB);
  const order=[];
  const a=planner.withAllocationLock(async()=>{order.push('a');await new Promise(r=>setImmediate(r));throw Error('fixture');});
  const b=planner.withAllocationLock(async()=>order.push('b'));
  await assert.rejects(a);await b;assert.deepEqual(order,['a','b']);
});

test('image purposes distinguish runtime, Manager, bases, mirrors and custom runtime metadata', () => {
  assert.equal(imagePurpose(['openclaw-manager:v1']).kind,'manager');
  assert.equal(imagePurpose(['node:24','openclaw-base-node:abc']).selectable,false);
  assert.equal(imagePurpose(['docker:29-cli','openclaw-base-docker:abc']).kind,'build-base');
  for(const tag of ['openclaw/openclaw:latest','docker.io/openclaw/openclaw:latest','mirror.example/openclaw/openclaw:v1'])
    assert.equal(imagePurpose([tag]).selectable,true);
  assert.equal(imagePurpose(['custom/runtime:v1'],{'org.opencontainers.image.source':'https://github.com/openclaw/openclaw'}).selectable,true);
  assert.equal(imagePurpose(['some-openclaw-tool:latest']).selectable,false);
});

test('creation UI shows only runtime images, groups aliases and clears exhausted recommendations', async () => {
  const source = fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const nodes = new Map();
  const get = id => {if(!nodes.has(id))nodes.set(id,{value:'stale',innerHTML:'',textContent:''});return nodes.get(id);};
  let response={recommended:null,totalCores:4,totalMemBytes:4*GiB,systemReservedCores:.5,systemReservedMemBytes:512*MiB,
    otherReservedCores:.75,otherReservedMemBytes:512*MiB,reservedCores:2,reservedMemBytes:3*GiB,remainCores:.7,remainMemBytes:0,reason:'预算不足',warnings:[]};
  const context={$:get,esc:s=>String(s).replaceAll('<','&lt;'),fmtBytes:n=>String(n),api:async()=>response};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function renderImageList('),source.indexOf('function bindImageModal('))+
    source.slice(source.indexOf('let resourceRecommendationRequest'),source.indexOf('function bindCreateModal(')),context);
  const data={defaultImage:'openclaw/openclaw:latest',images:[
    {tags:['openclaw-manager:v1'],kind:'manager',purpose:'管理平台',selectable:false,size:600},
    {tags:['node:24','openclaw-base-node:a'],kind:'build-base',purpose:'构建基础镜像',selectable:false,size:500},
    {tags:['openclaw/openclaw:latest','mirror/openclaw:v1'],kind:'runtime',purpose:'运行镜像',selectable:true,size:4000},
  ]};
  context.renderImageChips(data);const chips=get('#localImageChips').innerHTML;
  assert.equal((chips.match(/data-pick-image=/g)||[]).length,1);assert.ok(!chips.includes('data-pick-image="openclaw-manager'));
  context.renderImageList(data);assert.equal((get('#imageList').innerHTML.match(/class="size"/g)||[]).length,3);
  assert.match(get('#imageList').innerHTML,/共享存储/);
  await context.fillRecommendedResources();assert.equal(get('#resCpusInput').value,'');assert.equal(get('#resMemInput').value,'');
  assert.match(get('#recoNote').textContent,/预算不足/);
  response={...response,recommended:{cpus:1,memory:'1280m',pidsLimit:192}};
  await context.fillRecommendedResources();assert.equal(get('#resMemInput').value,'1280m');
});

// HTTP integration: real instance store on scratch data, deterministic Docker.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-resource-api-'));
process.env.OPENCLAW_DATA_DIR=scratch;
const childProcess = require('child_process');
const originalExec = childProcess.execFileSync;
childProcess.execFileSync=()=>Buffer.alloc(0);
const store = require('../src/instances');
let rows=[],pullFailure=false,holdPull=null,lifecycleCalls=0,updateFailure=false;
const dm={
  DEFAULT_IMAGE:'openclaw/openclaw:latest',
  dockerInfo:async()=>({ncpu:4,memTotal:4*GiB}),
  listResourceContainers:async()=>rows,
  imageExists:async()=>!pullFailure&&!holdPull,
  pullImage:async()=>{if(holdPull)await holdPull;if(pullFailure)throw Error('pull failed');},
  randomToken:()=> 'fixture-token',shortDockerError:e=>e.message,
  createInstanceContainer:async o=>{
    rows.push({id:o.instanceId,name:o.name,instanceId:o.instanceId,managed:true,state:'created',resources:{nanoCpus:o.nanoCpus,memoryBytes:o.memory}});
    return o.instanceId;
  },
  startContainer:async id=>{rows.find(r=>r.id===id).state='running';},
  inspectContainer:async id=>{const row=rows.find(r=>r.id===id);if(!row)throw Object.assign(Error('missing'),{statusCode:404});return {State:{Running:row.state==='running'}};},
  updateResources:async()=>{if(updateFailure)throw Error('update failed');},
  resourceOptions:r=>r,
};
require.cache[require.resolve('../src/docker')]={id:'docker',loaded:true,exports:dm};
require.cache[require.resolve('../src/lifecycle')]={id:'lifecycle',loaded:true,exports:{start:async()=>{lifecycleCalls++;},restart:async()=>{lifecycleCalls++;}}};
const express=require('express'),app=express();
app.use(express.json());
const route=require('../src/routes/instances');route.bind(()=>({state:'running'}),async()=>{});
app.use('/api/instances',route);
app.use((err,req,res,next)=>res.status(err.statusCode||500).json({error:err.message}));
let server,port;
function api(url,method='GET',body) {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:'/api/instances'+url,method,headers:{'Content-Type':'application/json'}},res=>{
      let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data||'{}')}));
    });req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
  });
}
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));port=server.address().port;});
test.beforeEach(()=>{for(const id of store.listInstanceIds())store.deleteInstanceRecord(id);rows=[];planner.pending.clear();pullFailure=false;holdPull=null;lifecycleCalls=0;updateFailure=false;});
test.after(async()=>{childProcess.execFileSync=originalExec;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(scratch,{recursive:true,force:true});});

test('HTTP create supplies bounded defaults and rejects infrastructure images before writing a record', async()=>{
  for(const image of ['openclaw-manager:v1','openclaw-base-node:v1'])assert.equal((await api('/','POST',{image})).status,400);
  assert.equal(store.listInstanceIds().length,0);
  const created=await api('/','POST',{name:'fixture'});
  assert.equal(created.status,201);assert.ok(created.body.instance.resources.memoryBytes>=GiB);
  assert.ok(created.body.instance.resources.cpus>0);assert.equal(planner.pending.size,0);
});

test('HTTP create rejects aggregate over-allocation before files or containers are created', async()=>{
  const first=await api('/','POST',{resources:{cpus:2,memory:'3g'}});assert.equal(first.status,201);
  const second=await api('/','POST',{resources:{cpus:2,memory:'2g'}});
  assert.equal(second.status,409);assert.equal(store.listInstanceIds().length,1);assert.equal(rows.length,1);
});

test('HTTP pending pull reserves capacity against a second create and is released on failure', async()=>{
  let release;holdPull=new Promise(r=>{release=r;});
  const first=api('/','POST',{resources:{cpus:2,memory:'3g'}});
  for(let i=0;i<100&&!planner.pending.size;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(planner.pending.size,1);
  const pendingId=[...planner.pending.keys()][0];
  assert.equal((await api('/'+pendingId+'/resources','PATCH',{cpus:1})).status,409);
  const second=await api('/','POST',{resources:{cpus:2,memory:'2g'}});
  assert.equal(second.status,409);
  pullFailure=true;release();assert.equal((await first).status,502);assert.equal(planner.pending.size,0);
  assert.equal((await api('/recommendations')).body.reservedMemBytes,0);
});

test('HTTP concurrent creates cannot both pass the same remaining budget', async()=>{
  const responses=await Promise.all([api('/','POST',{resources:{cpus:2,memory:'3g'}}),api('/','POST',{resources:{cpus:2,memory:'3g'}})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
});

test('HTTP edits exclude their own allocation, preserve records on Docker failure and reject increases', async()=>{
  const created=await api('/','POST',{resources:{cpus:2,memory:'3g'}});const id=created.body.instance.id;
  updateFailure=true;assert.equal((await api('/'+id+'/resources','PATCH',{cpus:1})).status,500);
  assert.equal(store.loadInstance(id).resources.cpus,2);
  updateFailure=false;assert.equal((await api('/'+id+'/resources','PATCH',{cpus:1,memory:'2g'})).status,200);
  const result=await api('/'+id+'/resources','PATCH',{memory:'4g'});assert.equal(result.status,409);
  assert.equal(store.loadInstance(id).resources.memoryBytes,2*GiB);
});

test('HTTP start and restart revalidate missing records against current budget', async()=>{
  const first=await api('/','POST',{resources:{cpus:2,memory:'3g'}});assert.equal(first.status,201);
  store.saveInstance({id:'missing',name:'missing',containerId:null,resources:{cpus:2,memoryBytes:2*GiB}});
  for(const action of ['start','restart'])assert.equal((await api('/missing/'+action,'POST',{})).status,409);
  assert.equal(lifecycleCalls,0);
});
