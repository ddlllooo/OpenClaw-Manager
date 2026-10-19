'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRetention } = require('../src/retention');
const guard = require('../src/maintenance-guard');
const sha = n => 'sha256:' + n.toString(16).padStart(64,'0');
const cid = n => n.toString(16).padStart(64,'0');
const scratch = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-retention-'));scratch.push(home);
  const images = new Map();
  function image(n, manager=false) {
    const data={Id:sha(n),RepoTags:[`${manager?'openclaw-manager':'openclaw/openclaw'}:v${n}`],
      Created:new Date(1700000000000+n*1000).toISOString(),Config:{Labels:manager?{'openclaw.manager':'true'}:{'org.opencontainers.image.source':'https://github.com/openclaw/openclaw'}}};
    images.set(data.Id,data);return data;
  }
  for (const n of [1,2,3])image(n);
  const record={id:'a',containerId:cid(103),containerName:'openclaw-a',rollbackContainerId:cid(102),image:'openclaw/openclaw:v3',port:19123};
  function container(n, version, rollbackAt=null) {
    return {Id:cid(n),Image:sha(version),Name:'/openclaw-a'+(rollbackAt?'-rollback-'+rollbackAt:''),
      Config:{Labels:{'openclaw.managed':'true','openclaw.instance':'a'}},
      State:{Status:rollbackAt?'exited':'running',Running:!rollbackAt,Health:{Status:'healthy'},StartedAt:'2026-10-15T00:00:00Z'},Created:'2026-01-01T00:00:00Z'};
  }
  const containers=[container(103,3),container(102,2,1700000000200),container(101,1,1700000000100)];
  const active=[record],archived=[],removed=[],opts=[];
  let clock=1700001000000,busy=false,inspectFailure=false,removeFailure=false,onInspect=null;
  const missing=()=>Object.assign(Error('missing'),{statusCode:404});
  const dm={
    inspectContainer:async id=>{
      if(inspectFailure)throw Error('Docker offline');
      if(onInspect)onInspect(id);
      const row=containers.find(c=>c.Id===id);if(!row)throw missing();return structuredClone(row);
    },
    docker:{
      listContainers:async()=>containers.map(c=>({Id:c.Id,Labels:c.Config.Labels})),
      listImages:async()=>[...images.values()].map(i=>({...structuredClone(i),Created:Date.parse(i.Created)/1000})),
      getContainer:id=>({remove:async options=>{
        opts.push(options);assert.deepEqual(options,{force:false,v:false});
        if(removeFailure)throw Object.assign(Error('in use'),{statusCode:409});
        const c=containers.find(c=>c.Id===id);assert.equal(c.State.Running,false);
        containers.splice(containers.indexOf(c),1);removed.push(id);
      }}),
      getImage:ref=>({inspect:async()=>{
        const i=images.get(ref)||[...images.values()].find(i=>i.RepoTags.includes(ref));if(!i)throw missing();return structuredClone(i);
      },remove:async options=>{
        opts.push(options);assert.deepEqual(options,{force:false,noprune:true});
        const i=images.get(ref)||[...images.values()].find(i=>i.RepoTags.includes(ref));if(!i)throw missing();
        if(containers.some(c=>c.Image===i.Id))throw Object.assign(Error('in use'),{statusCode:409});
        if(ref===i.Id)i.RepoTags=[];else i.RepoTags=i.RepoTags.filter(t=>t!==ref);
        if(!i.RepoTags.length){images.delete(i.Id);removed.push(i.Id);}
      }}),
    },
  };
  const store={atomicWrite:(p,content)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,content);}};
  const env={};
  const create=()=>createRetention({home,dm,store,guard,env,now:()=>clock,isBusy:()=>busy,checkReady:async()=>true,
    readRecords:()=>({active:structuredClone(active),all:structuredClone([...active,...archived])})});
  const retention=create();
  return {home,dm,store,env,create,retention,images,image,record,container,containers,active,archived,removed,opts,
    advance:ms=>{clock+=ms;},setBusy:v=>{busy=v;},failInspect:v=>{inspectFailure=v;},failRemove:v=>{removeFailure=v;},onInspect:fn=>{onInspect=fn;}};
}
test.after(()=>{for(const home of scratch)fs.rmSync(home,{recursive:true,force:true});});

test('successful upgrade keeps newest rollback, removes an older stopped copy and its unreferenced image',async()=>{
  const f=fixture();f.retention.recordSuccess(f.record);
  const result=await f.retention.tick();
  assert.deepEqual(result.removedContainers,[cid(101)]);assert.deepEqual(result.removedImages,[sha(1)]);
  assert.ok(f.containers.some(c=>c.Id===f.record.rollbackContainerId));
  assert.ok(f.images.has(sha(2)));assert.ok(f.images.has(sha(3)));
  assert.equal(f.retention.status().pending,false);
  const again=await f.retention.tick();assert.equal(again.idle,true);assert.equal(f.removed.length,2);
});
test('rollback recency uses rename timestamp rather than original container creation time',async()=>{
  const f=fixture();f.containers.find(c=>c.Id===cid(102)).Created='2020-01-01T00:00:00Z';
  f.containers.find(c=>c.Id===cid(101)).Created='2026-01-01T00:00:00Z';
  f.retention.recordSuccess(f.record);await f.retention.tick();
  assert.deepEqual(f.removed,[cid(101),sha(1)]);
});
test('referenced, running, foreign and shared-data rollback containers are protected without volume deletion',async()=>{
  const f=fixture();
  f.archived.push({id:'kept',containerId:cid(101),image:'openclaw/openclaw:v1'});
  const foreign=f.container(104,1,1700000000000);foreign.Config.Labels['openclaw.instance']='other';f.containers.push(foreign);
  f.retention.recordSuccess(f.record);await f.retention.tick();assert.deepEqual(f.removed,[]);
  f.archived.length=0;f.containers.find(c=>c.Id===cid(101)).State={Running:true,Status:'running'};
  f.retention.recordSuccess(f.record);await f.retention.tick();assert.deepEqual(f.removed,[]);
});
test('an image used by an unmanaged or stopped container is retained after obsolete rollback removal',async()=>{
  const f=fixture();const external=f.container(199,1,1700000000000);external.Config.Labels={};f.containers.push(external);
  f.retention.recordSuccess(f.record);const result=await f.retention.tick();
  assert.deepEqual(result.removedContainers,[cid(101)]);assert.deepEqual(result.removedImages,[]);assert.ok(f.images.has(sha(1)));
});
test('desired image reference in an archived record and unknown image aliases prevent image deletion',async()=>{
  for(const mode of ['archived','alias']) {
    const f=fixture();if(mode==='archived')f.archived.push({id:'old',image:'openclaw/openclaw:v1'});
    else f.images.get(sha(1)).RepoTags.push('another-app:important');
    f.retention.recordSuccess(f.record);const report=await f.retention.tick();
    assert.deepEqual(report.removedContainers,[cid(101)]);assert.deepEqual(report.removedImages,[]);
    assert.ok(f.images.has(sha(1)));
  }
});
test('changed instance reference during the final inspection prevents container deletion',async()=>{
  const f=fixture();let calls=0;
  f.onInspect(()=>{if(++calls===4)f.record.rollbackContainerId=cid(101);});
  f.retention.recordSuccess(f.record);await f.retention.tick();assert.deepEqual(f.removed,[]);
});
test('unhealthy current instance and unapplied configuration never trigger rollback deletion',async()=>{
  for(const mode of ['unhealthy','pending']) {
    const f=fixture();if(mode==='unhealthy')f.containers[0].State.Health.Status='unhealthy';else f.record.envPending=true;
    f.retention.recordSuccess(f.record);await f.retention.tick();assert.deepEqual(f.removed,[]);
  }
});
test('a ready gateway with Docker health still starting is retried after health becomes healthy',async()=>{
  const f=fixture();f.containers[0].State.Health.Status='starting';f.retention.recordSuccess(f.record);
  const waiting=await f.retention.tick();assert.equal(waiting.state,'waiting');assert.equal(f.retention.status().pending,true);
  assert.deepEqual(f.removed,[]);f.containers[0].State.Health.Status='healthy';f.advance(15001);
  await f.retention.tick();assert.deepEqual(f.removed,[cid(101),sha(1)]);assert.equal(f.retention.status().pending,false);
});
test('concurrent application work or image pull defers cleanup; image work cannot enter during deletion',async()=>{
  const f=fixture();f.retention.recordSuccess(f.record);f.setBusy(true);
  assert.equal((await f.retention.tick()).deferred,true);f.setBusy(false);
  let unblock;const work=guard.use(()=>new Promise(r=>{unblock=r;}));
  assert.equal((await f.retention.tick()).deferred,true);unblock();await work;
  await guard.clean(()=>false,async()=>{
    await assert.rejects(guard.use(async()=>{}),e=>e.statusCode===409);
    assert.equal((await f.retention.tick()).deferred,true);
    let continued=false;
    require('../src/operations').middleware({method:'POST',path:'/a/chat/abort'}, {}, ()=>{continued=true;});
    assert.equal(continued,true);
    let code=0;
    const res={status:n=>{code=n;return res;},json:()=>{}};
    require('../src/operations').middleware({method:'POST',path:'/a/restart'},res,()=>{throw Error('mutation entered cleanup');});
    assert.equal(code,409);
  });
  await f.retention.tick();assert.ok(f.removed.length);
});
test('Docker inspection failures fail closed and cleanup conflicts are recorded for later retry',async()=>{
  const f=fixture();f.retention.recordSuccess(f.record);f.failInspect(true);
  const failed=await f.retention.tick();assert.match(failed.error,/停止/);assert.deepEqual(f.removed,[]);
  f.failInspect(false);f.failRemove(true);f.advance(60001);const conflict=await f.retention.tick();
  assert.equal(conflict.state,'partial');assert.equal(f.retention.status().pending,true);assert.deepEqual(f.removed,[]);
  f.failRemove(false);f.advance(60001);await f.retention.tick();assert.ok(f.removed.includes(cid(101)));
});
test('corrupt retention journal never authorizes deletion',async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.home,'retention-state.json'),'{bad');
  assert.match(f.retention.status().error,/JSON|position|property/i);
  await assert.rejects(f.retention.tick());assert.deepEqual(f.removed,[]);
  await assert.rejects(f.retention.preview('owner'));assert.deepEqual(f.removed,[]);
});

test('preview is read-only and lists projected image deletion with container dependencies and retention reasons',async()=>{
  const f=fixture();const p=await f.retention.preview('owner');
  assert.deepEqual(f.removed,[]);assert.equal(fs.existsSync(path.join(f.home,'retention-state.json')),false);
  assert.deepEqual(p.summary,{deleteImages:1,keepImages:2,deleteContainers:1,keepContainers:1});
  assert.deepEqual(p.images.find(i=>i.id===sha(1)).dependsOn,[cid(101)]);
  assert.match(p.containers.find(c=>c.id===cid(102)).reasons.join('；'),/最近一个/);
  assert.match(p.images.find(i=>i.id===sha(3)).reasons.join('；'),/引用/);
  assert.equal(typeof p.previewId,'string');assert.equal(p.previewId.length,48);
});
test('manual cleanup and automatic cleanup use the same plan and final reference protection',async()=>{
  const f=fixture(),automatic=fixture();const p=await f.retention.preview('owner');
  const manual=await f.retention.execute(p.previewId,'owner');
  automatic.retention.recordSuccess(automatic.record);const auto=await automatic.retention.tick();
  assert.deepEqual(manual.removedImages,auto.removedImages);assert.deepEqual(manual.removedContainers,auto.removedContainers);
  assert.deepEqual(manual.removedImages,p.images.filter(i=>i.decision==='delete').map(i=>i.id));
  assert.equal(f.retention.status().lastRun.trigger.kind,'manual-cleanup');
});
test('expired, other-session and already-consumed previews cannot authorize manual deletion',async()=>{
  const f=fixture();const p=await f.retention.preview('owner');
  await assert.rejects(f.retention.execute(p.previewId,'other'),e=>e.statusCode===409);assert.deepEqual(f.removed,[]);
  f.advance(300001);await assert.rejects(f.retention.execute(p.previewId,'owner'),e=>e.statusCode===409);
  const next=await f.retention.preview('owner');await f.retention.execute(next.previewId,'owner');
  await assert.rejects(f.retention.execute(next.previewId,'owner'),e=>e.statusCode===409);
});
test('changed references, health, tags and newly appearing objects invalidate a preview before any removal',async()=>{
  for(const mode of ['archive','container','health','tag','new-image','rollback-reference']) {
    const f=fixture(),p=await f.retention.preview('owner');
    if(mode==='archive')f.archived.push({id:'archived',image:'openclaw/openclaw:v1'});
    if(mode==='container'){const c=f.container(888,1,1700000000000);c.Config.Labels={};f.containers.push(c);}
    if(mode==='health')f.containers[0].State.Health.Status='unhealthy';
    if(mode==='tag')f.images.get(sha(1)).RepoTags.push('other-app:keep');
    if(mode==='new-image')f.image(99);
    if(mode==='rollback-reference')f.record.rollbackContainerId=cid(101);
    await assert.rejects(f.retention.execute(p.previewId,'owner'),e=>e.statusCode===409);
    assert.deepEqual(f.removed,[],mode);
  }
});
test('a failed container deletion cannot allow image untagging based only on projected reference removal',async()=>{
  const f=fixture();f.failRemove(true);const p=await f.retention.preview('owner');
  const result=await f.retention.execute(p.previewId,'owner');
  assert.equal(result.state,'partial');assert.deepEqual(f.removed,[]);
  assert.deepEqual(f.images.get(sha(1)).RepoTags,['openclaw/openclaw:v1']);
});

test('cleanup history retains deleted names, protection reasons and source after process restart',async()=>{
  const f=fixture();assert.deepEqual(f.retention.history().entries,[]);
  const p=await f.retention.preview('owner');assert.deepEqual(f.retention.history().entries,[]);
  await f.retention.execute(p.previewId,'owner');
  const entry=f.create().history().entries[0];
  assert.equal(entry.source,'manual');assert.equal(entry.deletedImages[0].name,'openclaw/openclaw:v1');
  assert.match(entry.deletedContainers[0].name,/rollback/);assert.match(entry.skipped.map(i=>i.reason).join('；'),/保留最近一个/);
  assert.equal(f.retention.history().entries.length,1);
});

test('Docker rejection is recorded with object name and reason and its retry is identified as automatic',async()=>{
  const f=fixture();f.failRemove(true);const p=await f.retention.preview('owner');await f.retention.execute(p.previewId,'owner');
  const failed=f.retention.history().entries[0];assert.equal(failed.state,'partial');assert.equal(failed.errors[0].type,'rollback');assert.match(failed.errors[0].reason,/占用/);
  f.failRemove(false);f.advance(60001);await f.retention.tick();
  const retried=f.retention.history().entries[0];assert.equal(retried.source,'automatic');assert.equal(retried.trigger,'manual-cleanup');assert.equal(retried.deletedContainers.length,1);
});

test('manual cleanup rejected by changed references or platform work records why without deleting anything',async()=>{
  const f=fixture(),p=await f.retention.preview('owner');f.archived.push({id:'kept',image:'openclaw/openclaw:v1'});
  await assert.rejects(f.retention.execute(p.previewId,'owner'),e=>e.statusCode===409);
  assert.match(f.retention.history().entries[0].skipped[0].reason,/状态已变化/);
  f.advance(1);f.setBusy(true);await assert.rejects(f.retention.execute(p.previewId,'owner'));
  assert.match(f.retention.history().entries[0].skipped[0].reason,/操作进行中/);assert.deepEqual(f.removed,[]);
});

test('Docker check failure during a manual attempt is visible in history without leaking raw errors',async()=>{
  const f=fixture(),p=await f.retention.preview('owner');f.failInspect(true);
  await assert.rejects(f.retention.execute(p.previewId,'owner'));
  const entry=f.retention.history().entries[0];assert.equal(entry.state,'failed');assert.match(entry.error,/检查|操作/);assert.deepEqual(f.removed,[]);
});
test('a new archive reference between container and image removal protects the image during execution',async()=>{
  const f=fixture(),get=f.dm.docker.getContainer;
  f.dm.docker.getContainer=id=>({remove:async options=>{await get(id).remove(options);f.archived.push({id:'new-ref',image:'openclaw/openclaw:v1'});}});
  const p=await f.retention.preview('owner'),result=await f.retention.execute(p.previewId,'owner');
  assert.deepEqual(result.removedContainers,[cid(101)]);assert.deepEqual(result.removedImages,[]);assert.ok(f.images.has(sha(1)));
});
test('preview uses the image-list size consistently when inspect reports compressed storage',async()=>{
  const f=fixture();f.images.get(sha(3)).Size=1024;
  const list=f.dm.docker.listImages;
  f.dm.docker.listImages=async()=> (await list()).map(i=>({...i,Size:4096}));
  const p=await f.retention.preview('owner');
  assert.equal(p.images.find(i=>i.id===sha(3)).sizeBytes,4096);
});

test('manual cleanup defers to in-flight work without consuming a valid preview',async()=>{
  const f=fixture(),p=await f.retention.preview('owner');f.setBusy(true);
  await assert.rejects(f.retention.execute(p.previewId,'owner'),e=>e.statusCode===409);assert.deepEqual(f.removed,[]);
  f.setBusy(false);await f.retention.execute(p.previewId,'owner');assert.ok(f.removed.includes(cid(101)));
});

function managerFixture(f,n) {
  const img=f.image(n,true);
  const c=f.container(500+n,n);c.Config.Labels={'openclaw.manager':'true','openclaw.deployment':'production'};
  c.Name='/openclaw-manager';c.State.StartedAt='2026-10-16T00:00:00Z';
  for(let i=f.containers.length-1;i>=0;i--)if(f.containers[i].Config.Labels['openclaw.manager']==='true')f.containers.splice(i,1);
  f.containers.push(c);f.env.MANAGER_CONTAINERIZED='1';f.env.HOSTNAME=c.Id.slice(0,12);
  // Synthetic IDs need a unique prefix, as Docker's actual hostnames do.
  f.env.HOSTNAME=c.Id;
  return {img,c};
}
test('manual preview preserves current and previous Manager versions and does not promote an unverified upgrade',async()=>{
  const f=fixture();f.image(10,true);f.image(11,true);const m=managerFixture(f,12);
  const before=await f.retention.preview('owner');assert.match(before.blockedReason,/健康/);
  assert.equal(fs.existsSync(path.join(f.home,'retention-state.json')),false);
  await assert.rejects(f.retention.execute(before.previewId,'owner'),e=>e.statusCode===409);assert.deepEqual(f.removed,[]);
  fs.writeFileSync(path.join(f.home,'retention-state.json'),JSON.stringify({version:1,pending:false,retired:[{id:sha(10),kind:'manager'}],managers:{production:{current:m.img.Id,previous:sha(11),families:['openclaw-manager'],containerId:m.c.Id}}}));
  const p=await f.retention.preview('owner');
  assert.equal(p.images.find(i=>i.id===sha(10)).decision,'delete');
  assert.match(p.images.find(i=>i.id===sha(11)).reasons.join('；'),/上一版/);
  assert.match(p.images.find(i=>i.id===sha(12)).reasons.join('；'),/当前/);
  await f.retention.execute(p.previewId,'owner');assert.ok(!f.images.has(sha(10)));assert.ok(f.images.has(sha(11)));
});
test('Manager retains declared previous successful version after 30s healthy and cleans older images',async()=>{
  const f=fixture();f.image(10,true);f.image(11,true);const m=managerFixture(f,12);
  f.env.OPENCLAW_PREVIOUS_MANAGER_IMAGE='openclaw-manager:v11';
  assert.equal((await f.retention.tick()).waitingForManagerHealth,true);assert.deepEqual(f.removed,[]);
  f.advance(29999);await f.retention.tick();assert.deepEqual(f.removed,[]);
  f.advance(2);await f.retention.tick();
  assert.ok(f.removed.includes(sha(10)));assert.ok(f.images.has(sha(11)));assert.ok(f.images.has(m.img.Id));
  assert.equal(f.retention.status().managers.production.previous,sha(11));
  assert.equal((await f.retention.tick()).idle,true);
});
test('next Manager upgrade rotates history by success order and survives process restart',async()=>{
  const f=fixture();f.image(10,true);f.image(11,true);managerFixture(f,12);f.env.OPENCLAW_PREVIOUS_MANAGER_IMAGE='openclaw-manager:v11';
  await f.retention.tick();f.advance(30001);await f.retention.tick();
  managerFixture(f,13);const restarted=f.create();
  await restarted.tick();f.advance(30001);await restarted.tick();
  assert.equal(restarted.status().managers.production.previous,sha(12));
  assert.ok(f.images.has(sha(12)));assert.ok(f.images.has(sha(13)));assert.ok(!f.images.has(sha(11)));
});
test('failed Manager health, absent predecessor and newly built unused images never authorize old-version cleanup',async()=>{
  for(const mode of ['unhealthy','missing-predecessor']) {
    const f=fixture();f.image(10,true);f.image(11,true);const m=managerFixture(f,12);
    if(mode==='unhealthy'){m.c.State.Health.Status='unhealthy';f.env.OPENCLAW_PREVIOUS_MANAGER_IMAGE='openclaw-manager:v11';}
    await f.retention.tick();f.advance(60000);await f.retention.tick();assert.deepEqual(f.removed,[]);
  }
  const f=fixture();f.image(10,true);f.image(11,true);f.image(99,true);managerFixture(f,12);
  f.env.OPENCLAW_PREVIOUS_MANAGER_IMAGE='openclaw-manager:v11';await f.retention.tick();f.advance(30001);await f.retention.tick();
  assert.ok(f.images.has(sha(99)));
});

test('lifecycle registers cleanup only after readiness and durable commit; cleanup error cannot roll back success',async()=>{
  const code=fs.readFileSync(path.join(__dirname,'../src/lifecycle.js'),'utf8');
  for(const mode of ['success','cleanup-error','start-error','no-start']) {
    const events=[];const module={exports:{}};const inst={id:'a',containerId:'old',containerName:'openclaw-a',port:19001,resources:{}};
    const http={get:(url,opts,callback)=>{const request=new EventEmitter();queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data','{"ready":true}');res.emit('end');});return request;}};
    const dm={inspectContainer:async()=>({Id:'old',Image:'img',State:{Running:true}}),getContainer:()=>({rename:async()=>events.push('rename')}),
      stopContainer:async()=>events.push('stop'),createInstanceContainer:async()=> 'new',startContainer:async()=>{if(mode==='start-error')throw Error('start failed');},removeContainer:async()=>events.push('remove')};
    const store={parseEnv:()=>({}),readEnvFile:()=>'',configDir:()=>'/tmp',workspaceDir:()=>'/tmp',authDir:()=>'/tmp',saveInstance:r=>events.push('save:'+r.containerId+':'+(r.rollbackContainerId||''))};
    const retention={instanceSucceeded:r=>{events.push('cleanup:'+r.containerId+':'+r.rollbackContainerId);if(mode==='cleanup-error')throw Error('disk full');}};
    vm.runInNewContext(code,{module,require:n=>n==='./docker'?dm:n==='./instances'?store:n==='./retention'?retention:n==='./gateway-address'?{base:async()=> 'http://fixture'}:n==='http'?http:require(n),console:{warn(){}},setTimeout});
    if(mode==='start-error'){await assert.rejects(module.exports.replace(inst));assert.ok(!events.some(e=>e.startsWith('cleanup:')));}
    else {
      await module.exports.replace(inst,mode!=='no-start');
      assert.equal(inst.containerId,'new');
      assert.equal(events.includes('cleanup:new:old'),mode!=='no-start');
      if(mode!=='no-start')assert.ok(events.indexOf('cleanup:new:old')>events.indexOf('save:new:old'));
      assert.ok(!events.includes('remove'));
    }
  }
});
