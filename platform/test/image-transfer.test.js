'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('stream'),tar=require('tar-stream');
const transfer=require('../src/image-transfer');
const localId='sha256:'+'a'.repeat(64),configId='sha256:'+'b'.repeat(64),otherId='sha256:'+'c'.repeat(64);
const image='openclaw/openclaw:offline';
const metadata={Id:localId,RepoTags:[image],Os:'linux',Architecture:'amd64',Size:4096,Config:{Env:['FIXTURE=true'],Labels:{}},RootFS:{Layers:['sha256:fixture-layer']}};
const archive=()=>{
  const pack=tar.pack();pack.entry({name:'manifest.json'},JSON.stringify([{Config:'blobs/sha256/'+configId.slice(7),RepoTags:null,Layers:['layer.tar']}])) ;
  pack.entry({name:'layer.tar'},Buffer.alloc(256*1024,7));pack.finalize();return pack;
};
function fixture(options={}){
  const record={status:'ssh-ready',client:{}},calls=[],exported=[];
  let loaded=false,tag=options.existing?structuredClone(options.existing):null;
  const local={...structuredClone(metadata),...(options.local||{})};
  const imported={...structuredClone(local),Id:options.classic?configId:localId,...(options.imported||{})};
  const docker={getImage:reference=>({inspect:async()=>local,get:async()=>{exported.push(reference);return options.source?.()||archive();}})};
  const execute=async(client,args,input,timeout,settings={})=>{
    calls.push(args);
    if(settings.signal?.aborted)throw Object.assign(new Error('cancelled'),{code:'ABORT_ERR'});
    if(args[0]==='info')return JSON.stringify({OSType:'linux',Architecture:options.architecture||'x86_64'});
    if(args[0]==='image'&&args[1]==='ls'){
      if(options.race&&loaded)tag={...local,Id:otherId};
      return tag?JSON.stringify({ID:tag.Id,Repository:'openclaw/openclaw',Tag:'offline'}):'';
    }
    if(args[1]==='inspect'){
      if(args[2]===image&&tag)return JSON.stringify([tag]);
      if(loaded&&args[2]===imported.Id)return JSON.stringify([imported]);
      throw new Error('No such image');
    }
    if(args[1]==='load'){
      if(options.earlyExit)return '';
      if(options.failLoad)throw new Error('no space left on device');
      for await(const chunk of input){if(options.slow)await new Promise(r=>setTimeout(r,10));}
      loaded=true;settings.onInputEnd?.();return 'Loaded image ID: '+imported.Id;
    }
    if(args[1]==='tag'){tag=structuredClone(imported);return '';}
    throw new Error('unexpected '+args);
  };
  const service=transfer.createTransferService({docker:()=>docker,execute});
  const start=()=>service.start(record,{image,imageId:localId});
  const finish=async()=>{await record.transfer.finished;return transfer.view(record.transfer);};
  return {record,calls,exported,start,finish};
}
test('source picker includes only tagged OpenClaw and Manager images',async()=>{
  const images=await transfer.localImages({listImages:async()=>[
    {Id:localId,RepoTags:[image],Size:4096},{Id:otherId,RepoTags:['node:24','unrelated:latest']},
    {Id:configId,RepoTags:['custom-manager:v1'],Labels:{'openclaw.manager':'true'}},
    {Id:otherId,RepoTags:['<none>:<none>']},
  ]});assert.equal(images.length,2);assert.ok(images.some(row=>row.kind==='manager'));assert.ok(images.some(row=>row.image===image));
});
test('stream transfer exports immutable ID, verifies import and restores only the selected tag',async()=>{
  const f=fixture();assert.equal(f.start().status,'running');const job=await f.finish();
  assert.equal(job.status,'done',job.error);assert.ok(job.bytesSent>256*1024);assert.equal(job.targetImageId,localId);
  assert.deepEqual(f.exported,[localId]);assert.deepEqual(f.calls.find(a=>a[1]==='tag'),['image','tag',localId,image]);
  assert.ok(!f.calls.some(a=>['pull','build','stop','rm'].includes(a[0])));
});
test('classic Docker config IDs are checked against the exported manifest and content',async()=>{
  const f=fixture({classic:true});f.start();const job=await f.finish();assert.equal(job.status,'done',job.error);assert.equal(job.targetImageId,configId);
  assert.deepEqual(f.calls.find(a=>a[1]==='tag'),['image','tag',configId,image]);
});
test('identical cached content skips export even when Docker storage IDs differ',async()=>{
  const f=fixture({existing:{...metadata,Id:configId}});f.start();const job=await f.finish();assert.equal(job.status,'done');assert.equal(job.cached,true);assert.equal(f.exported.length,0);
});
test('architecture and existing-tag conflicts fail before export or load',async()=>{
  for(const options of [{architecture:'aarch64'},{existing:{...metadata,Id:otherId,RootFS:{Layers:['different']}}}]){
    const f=fixture(options);f.start();const job=await f.finish();assert.equal(job.status,'error');assert.equal(f.exported.length,0);assert.ok(!f.calls.some(a=>a[1]==='load'));
  }
});
test('import errors, incomplete streams and altered layers never publish a success or tag',async()=>{
  for(const options of [{failLoad:true},{earlyExit:true},{imported:{RootFS:{Layers:['tampered']}}}]){
    const f=fixture(options);f.start();const job=await f.finish();assert.equal(job.status,'error');assert.ok(!f.calls.some(a=>a[1]==='tag'));
  }
});
test('target tag changed during transfer is preserved',async()=>{
  const f=fixture({race:true});f.start();const job=await f.finish();assert.equal(job.status,'error');assert.match(job.error,/标签已被其他操作使用/);assert.ok(!f.calls.some(a=>a[1]==='tag'));
});
test('cancellation tears down the export and releases transfer slots',async()=>{
  const f=fixture({slow:true});f.start();assert.throws(()=>f.start(),e=>e.statusCode===409);
  while(!f.record.transfer.bytesSent)await new Promise(r=>setTimeout(r,2));f.record.transfer.controller.abort();
  const job=await f.finish();assert.equal(job.status,'cancelled');assert.ok(!f.calls.some(a=>a[1]==='tag'));
  const retry=fixture();retry.start();assert.equal((await retry.finish()).status,'done');
});
test('invalid image references, stale local tags and unrelated images are rejected',async()=>{
  const f=fixture();const service=transfer.createTransferService();
  for(const bad of ['--help','repo:tag;whoami','repo:$(id)','repo:tag\n'])assert.throws(()=>service.start(f.record,{image:bad}));
  for(const local of [{RepoTags:['other:tag']},{Config:{Labels:{}},RepoTags:[image],Id:otherId}]){
    const g=fixture({local});g.start();assert.equal((await g.finish()).status,'error');assert.equal(g.exported.length,0);
  }
});
test('transfers defer cleanup and enforce the global concurrency limit',async()=>{
  const a=fixture({slow:true}),b=fixture({slow:true}),c=fixture();a.start();b.start();
  assert.throws(()=>c.start(),e=>e.statusCode===409);
  const guard=require('../src/maintenance-guard');assert.equal((await guard.clean(()=>false,()=>({deleted:true}))).deferred,true);
  a.record.transfer.controller.abort();b.record.transfer.controller.abort();await Promise.all([a.finish(),b.finish()]);
  assert.deepEqual(await guard.clean(()=>false,()=>({released:true})),{released:true});
});
