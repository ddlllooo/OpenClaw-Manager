'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-storage-'));
process.env.OPENCLAW_DATA_DIR=path.join(scratch,'instances');
process.env.OPENCLAW_INSTANCE_BACKUP_DIR=path.join(scratch,'backups');
process.env.OPENCLAW_BACKUP_KEY_FILE=path.join(scratch,'keys','key');
const store=require('../src/instances'),storage=require('../src/storage'),dm=require('../src/docker');
let running=false,stopFails=false;const events=[];
dm.listContainersByLabel=async()=>[{instanceId:'fixture',containerId:'c',state:running?'running':'exited'}];
dm.inspectContainer=async()=>({Id:'c',State:{Running:running},HostConfig:{RestartPolicy:{Name:'unless-stopped'}}});
dm.getContainer=()=>({update:async body=>events.push(['update',body])});
dm.stopContainer=async()=>{events.push(['stop']);if(stopFails)throw Error('docker unavailable');running=false;};
function write(name,content){const file=path.join(store.instanceDir('fixture'),name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);return file;}
function fixture(){
  fs.rmSync(scratch,{recursive:true,force:true});fs.mkdirSync(scratch);
  running=false;stopFails=false;events.length=0;
  store.saveInstance({id:'fixture',name:'test',gatewayToken:'token',containerId:'c',resources:{}});
  for(const folder of ['openclaw','workspace','auth'])fs.mkdirSync(path.join(store.instanceDir('fixture'),folder),{recursive:true});
  write('openclaw/openclaw.json',JSON.stringify({gateway:{auth:{token:'token'}}}));write('openclaw/.env','OPENCLAW_GATEWAY_TOKEN=token\n');
  write('workspace/MEMORY.md','remember this');write('auth/credentials.json','{"secret":"private"}');
}
test.beforeEach(fixture);
test.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));

test('usage covers all instance data and reports portable guard honestly',async()=>{
  write('manager/history','history');const u=await storage.usage('fixture');
  assert.ok(u.bytes>=u.logicalBytes);assert.equal(u.mounts.length,3);assert.equal(u.hardQuota,false);assert.equal(u.percent,null);assert.ok(u.disk.available>0);
  assert.throws(()=>storage.normalize({limitGiB:-1}),/容量/);assert.throws(()=>storage.normalize({warnPercent:95,stopPercent:90}),/阈值/);assert.throws(()=>storage.normalize({minFreeGiB:true}),/数字/);
});
test('usage counts link inodes without following external or dangling targets; maintenance stays strict',async t=>{
  const before=await storage.usage('fixture'),external=path.join(scratch,'outside');
  fs.mkdirSync(external);fs.writeFileSync(path.join(external,'large'),Buffer.alloc(4*1024*1024));
  try{fs.symlinkSync(external,path.join(store.workspaceDir('fixture'),'external'),'dir');}
  catch(e){if(['EPERM','EACCES'].includes(e.code))return t.skip('symlink creation unavailable');throw e;}
  fs.symlinkSync(path.join(scratch,'missing'),path.join(store.workspaceDir('fixture'),'dangling'),'file');
  const result=await storage.usage('fixture');
  assert.equal(result.linkCount,2);assert.equal(result.fileCount,before.fileCount);
  assert.ok(result.bytes>=before.bytes&&result.bytes<before.bytes+1024*1024);
  assert.match(result.maintenanceWarning,/不跟随目标/);
  await assert.rejects(storage.snapshot('fixture'),/符号链接/);
});

test('exhaustion latches before stopping, disables restart, denies start until manual release',async()=>{
  write('workspace/large.bin',Buffer.alloc(1024*1024));
  storage.setPolicy('fixture',{limitGiB:0.000001,minFreeGiB:0});running=true;
  await storage.enforce('fixture');assert.equal(running,false);assert.equal(storage.isBlocked('fixture'),true);
  assert.equal(events[0][1].RestartPolicy.Name,'no');assert.equal(require('../src/startup-settings').restartPolicy('fixture').Name,'no');
  await assert.rejects(storage.assertCanStart('fixture'));await assert.rejects(storage.release('fixture'));
  await assert.rejects(require('../src/lifecycle').start(store.loadInstance('fixture')));
  await assert.rejects(require('../src/lifecycle').restart(store.loadInstance('fixture')));
  storage.setPolicy('fixture',{limitGiB:10,minFreeGiB:0});await assert.rejects(storage.assertCanStart('fixture'),/锁定/);
  await storage.release('fixture');await storage.assertCanStart('fixture');
});
test('failed Docker stop keeps protection durable and can be retried',async()=>{
  write('workspace/large.bin',Buffer.alloc(1024*1024));
  storage.setPolicy('fixture',{limitGiB:0.000001,minFreeGiB:0});running=true;stopFails=true;
  await assert.rejects(storage.enforce('fixture'),/unavailable/);assert.ok(storage.isBlocked('fixture'));stopFails=false;
  await storage.enforce('fixture');assert.equal(running,false);
});
test('cleanup previews only old rotated logs and stale previews cannot delete changed files',async()=>{
  const old=write('openclaw/logs/gateway.log.1','old'),now=Date.now()/1000;
  fs.utimesSync(old,now-8*86400,now-8*86400);
  write('openclaw/logs/gateway.log','active');write('openclaw/logs/fresh.log.1','fresh');write('workspace/chat.log.1','user content');
  const p=await storage.cleanupPreview('fixture');assert.equal(p.candidates.length,1);
  running=true;await assert.rejects(storage.cleanup('fixture',p.revision),/停止/);running=false;
  fs.appendFileSync(old,'new');await assert.rejects(storage.cleanup('fixture',p.revision),/变化/);
  const fresh=await storage.cleanupPreview('fixture');await storage.cleanup('fixture',fresh.revision);
  assert.ok(fs.existsSync(path.join(store.configDir('fixture'),'logs/gateway.log')));assert.ok(fs.existsSync(path.join(store.workspaceDir('fixture'),'chat.log.1')));
});
test('encrypted stopped snapshot verifies and restores data with a pre-restore escape backup',async()=>{
  const b=await storage.snapshot('fixture');assert.equal(storage.listBackups('fixture').length,1);
  const file=path.join(process.env.OPENCLAW_INSTANCE_BACKUP_DIR,'fixture',b.name);
  assert.equal(fs.readFileSync(file).subarray(0,5).toString(),'OCBK1');assert.ok(!fs.readFileSync(file).includes(Buffer.from('private')));
  assert.equal((await storage.verify('fixture',b.name)).ok,true);
  write('workspace/MEMORY.md','new memory');write('workspace/extra.txt','extra');
  const result=await storage.restore('fixture',b.name);
  assert.equal(fs.readFileSync(path.join(store.workspaceDir('fixture'),'MEMORY.md'),'utf8'),'remember this');assert.equal(fs.existsSync(path.join(store.workspaceDir('fixture'),'extra.txt')),false);
  assert.ok(storage.listBackups('fixture').some(row=>row.name===result.previous));assert.equal(store.loadInstance('fixture').envPending,true);assert.equal(storage.isBlocked('fixture'),false);
});
test('tampered archive is rejected without replacing live files or retaining plaintext',async()=>{
  const b=await storage.snapshot('fixture'),file=path.join(process.env.OPENCLAW_INSTANCE_BACKUP_DIR,'fixture',b.name);
  const data=fs.readFileSync(file);data[25]^=1;fs.writeFileSync(file,data);write('workspace/MEMORY.md','keep current');
  await assert.rejects(storage.verify('fixture',b.name));await assert.rejects(storage.restore('fixture',b.name));
  assert.equal(fs.readFileSync(path.join(store.workspaceDir('fixture'),'MEMORY.md'),'utf8'),'keep current');
  assert.equal(fs.readdirSync(path.dirname(file)).some(n=>n.startsWith('.verify-')),false);assert.equal(storage.isBlocked('fixture'),false);
});
test('backup fails while running or with independent volumes; missing key is not regenerated',async()=>{
  running=true;await assert.rejects(storage.snapshot('fixture'),/停止/);running=false;
  const r=store.loadInstance('fixture');r.security={profile:'ssh-sandbox-v1'};store.saveInstance(r);await assert.rejects(storage.snapshot('fixture'),/全量备份/);
  delete r.security;store.saveInstance(r);const b=await storage.snapshot('fixture');fs.unlinkSync(process.env.OPENCLAW_BACKUP_KEY_FILE);
  await assert.rejects(storage.verify('fixture',b.name),/密钥缺失/);assert.equal(fs.existsSync(process.env.OPENCLAW_BACKUP_KEY_FILE),false);
});
test('missing bind directory cannot be published as a complete backup',async()=>{
  fs.rmSync(store.authDir('fixture'),{recursive:true});
  await assert.rejects(storage.snapshot('fixture'),/挂载目录缺失/);assert.equal(storage.listBackups('fixture').length,0);
});
test('history config repair saves corrupt data first and leaves instance stopped',async()=>{
  write('openclaw/openclaw.json.bak.1','{"gateway":{"auth":{"token":"token"}},"repaired":true}');write('openclaw/openclaw.json','{bad json');
  const d=await storage.diagnostics('fixture');assert.equal(d.checks.find(c=>c.name==='openclaw.json').ok,false);
  const result=await storage.repairConfig('fixture','openclaw.json.bak.1');assert.ok(result.previous);assert.equal(JSON.parse(store.readOpenclawConfig('fixture')).repaired,true);assert.equal(running,false);
});
test('interrupted directory replacement remains start-blocked and rolls back original data',async()=>{
  const token=crypto.randomBytes(12).toString('hex'),root=store.instanceDir('fixture'),old=path.join(root,'.previous-'+token),stage=path.join(root,'.restore-'+token);
  fs.mkdirSync(old);fs.mkdirSync(stage);fs.renameSync(path.join(root,'workspace'),path.join(old,'workspace'));write('workspace/MEMORY.md','half restored');
  fs.mkdirSync(path.join(scratch,'storage'),{recursive:true});fs.writeFileSync(path.join(scratch,'storage','fixture.json'),JSON.stringify({policy:{limitGiB:0,warnPercent:80,stopPercent:100,minFreeGiB:1},recovery:token,blocked:null}));
  await assert.rejects(storage.assertCanStart('fixture'),/回滚/);await storage.rollback('fixture');
  assert.equal(fs.readFileSync(path.join(root,'workspace/MEMORY.md'),'utf8'),'remember this');assert.equal(fs.existsSync(old),false);assert.equal(storage.isBlocked('fixture'),false);
});
test('archive traversal, forged manifests and paths outside backup roots are rejected',async()=>{
  await assert.rejects(storage.verify('fixture','../../escape'),/标识/);
  const tar=require('tar-stream'),zlib=require('zlib'),{pipeline}=require('stream/promises');
  const pack=tar.pack(),raw=path.join(scratch,'malicious.tar.gz'),enc=path.join(scratch,'malicious.enc');
  const writing=pipeline(pack,zlib.createGzip(),fs.createWriteStream(raw));pack.entry({name:'../escape'},'danger');pack.finalize();await writing;
  const b=await storage.snapshot('fixture');await require('../scripts/backup_crypto.cjs').transform('encrypt',raw,enc,process.env.OPENCLAW_BACKUP_KEY_FILE);
  fs.copyFileSync(enc,path.join(process.env.OPENCLAW_INSTANCE_BACKUP_DIR,'fixture',b.name));
  await assert.rejects(storage.verify('fixture',b.name),/非法路径/);assert.equal(fs.existsSync(path.join(scratch,'escape')),false);
});
test('backup deletion preserves the last verified recovery copy',async()=>{
  const a=await storage.snapshot('fixture');await assert.rejects(storage.deleteBackup('fixture',a.name),/最后一份/);
  const b=await storage.snapshot('fixture');await storage.deleteBackup('fixture',a.name);
  assert.deepEqual(storage.listBackups('fixture').map(row=>row.name),[b.name]);
});
test('host free-space reserve also stops a configured instance below its own quota',async()=>{
  storage.setPolicy('fixture',{limitGiB:10,minFreeGiB:1});const runtime=require('../src/runtime-platform'),original=runtime.diskInfo;
  running=true;runtime.diskInfo=()=>({total:100*1024**3,available:128*1024**2});
  try {await storage.enforce('fixture');assert.equal(running,false);assert.match((await storage.usage('fixture')).blocked.reason,/剩余空间/);}
  finally{runtime.diskInfo=original;}
});
test('mid-restore I/O failure rolls back every replaced mount',async()=>{
  const b=await storage.snapshot('fixture');write('workspace/MEMORY.md','current before restore');
  const original=fs.promises.rename;let failed=false;
  fs.promises.rename=async(from,to)=>{if(!failed&&String(from).includes('.restore-')&&String(from).endsWith(path.sep+'auth')){failed=true;throw Error('synthetic I/O failure');}return original(from,to);};
  try{await assert.rejects(storage.restore('fixture',b.name),/I\/O failure/);}finally{fs.promises.rename=original;}
  assert.equal(fs.readFileSync(path.join(store.workspaceDir('fixture'),'MEMORY.md'),'utf8'),'current before restore');assert.equal(storage.isBlocked('fixture'),false);
});
test('full disk releases emergency reserve; persistent metadata failure still attempts stop',async()=>{
  write('workspace/large.bin',Buffer.alloc(1024*1024));storage.setPolicy('fixture',{limitGiB:0.000001,minFreeGiB:0});running=true;
  const original=store.atomicWrite;let failures=1;
  store.atomicWrite=(...args)=>{if(failures-->0)throw Object.assign(Error('full'),{code:'ENOSPC'});return original(...args);};
  try {await storage.enforce('fixture');}finally{store.atomicWrite=original;}
  assert.equal(running,false);assert.equal(fs.existsSync(path.join(scratch,'storage','.emergency-reserve')),false);
  storage.setPolicy('fixture',{limitGiB:0.000001,minFreeGiB:0});running=true;
  store.atomicWrite=()=>{throw Object.assign(Error('disk remains full'),{code:'ENOSPC'});};
  try {await assert.rejects(storage.enforce('fixture'),/disk remains full/);}finally{store.atomicWrite=original;}
  assert.equal(running,false);assert.equal(storage.isBlocked('fixture'),true);
  storage.setPolicy('fixture',{limitGiB:10,minFreeGiB:0});await storage.release('fixture');
});
test('unsupported host rejects hard mode without changing the existing soft policy',async()=>{
  const backend=require('../src/storage-quota'),probe=backend.probe;
  backend.probe=async()=>({supported:false,reason:'XFS enforcement unavailable'});
  try{await assert.rejects(storage.configurePolicy('fixture',{mode:'hard',limitGiB:1}),e=>e.statusCode===422&&/XFS/.test(e.message));}
  finally{backend.probe=probe;}
  assert.equal((await storage.usage('fixture')).policy.mode,'soft');assert.equal(storage.isBlocked('fixture'),false);
});

test('APFS volume quotas require matching Manager markers and always fence Docker autorestart',async()=>{
  const backend=require('../src/storage-quota'),original={probe:backend.probe,apply:backend.apply,status:backend.status};
  const quota={verified:true,backend:'apfs-volume',volumeUUID:'test-volume',hardBytes:1024**3,hardInodes:null,usedInodes:null,inodeQuota:false,usedBytes:4096,filesystemAvailable:20*1024**3};
  backend.probe=async()=>({supported:true});backend.apply=backend.status=async()=>({...quota});
  for(const folder of ['', 'openclaw','workspace','auth'])write((folder?folder+'/':'')+'.openclaw-volume-id','test-volume\n');
  try{
    await storage.configurePolicy('fixture',{mode:'hard',limitGiB:1});
    const u=await storage.usage('fixture');assert.equal(u.hardQuota,true);assert.ok(Number.isFinite(u.percent));assert.equal(u.enforcement,'apfs-volume');
    assert.equal(require('../src/startup-settings').restartPolicy('fixture').Name,'no');await storage.assertCanStart('fixture');
    write('workspace/.openclaw-volume-id','stale');await assert.rejects(storage.assertCanStart('fixture'),/挂载|配额|保护|不符/);
    backend.status=async()=>{throw Error('APFS volume not mounted');};await assert.rejects(storage.assertCanStart('fixture'),/not mounted/);
  }finally{Object.assign(backend,original);}
});

test('migration lock fences starts and admission independently of available bytes',async()=>{
  const file=path.join(scratch,'storage','fixture.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({policy:{limitGiB:0},migration:{phase:'copying'}}));
  assert.equal(storage.isMigrating('fixture'),true);await assert.rejects(storage.assertAdmission('fixture'),e=>e.statusCode===507);
  await assert.rejects(storage.assertCanStart('fixture'),/迁移/);await assert.rejects(storage.release('fixture'),/迁移/);
});
test('hard mode requires stopped containers and exact host readback; inode usage participates in protection',async()=>{
  const backend=require('../src/storage-quota'),original={probe:backend.probe,apply:backend.apply,status:backend.status},calls=[];
  const cap={projectId:123,hardBytes:1024**3,hardInodes:1000,usedBytes:4096,usedInodes:100,verified:true};
  backend.probe=async()=>({supported:true});backend.apply=async(id,bytes,inodes)=>{calls.push(['apply',bytes,inodes]);return {...cap};};
  backend.status=async(id,full)=>{calls.push(['status',full]);return {...cap};};
  try{
    running=true;await assert.rejects(storage.configurePolicy('fixture',{mode:'hard',limitGiB:1,hardInodes:1000}),/停止/);assert.equal(calls.length,0);running=false;
    await storage.configurePolicy('fixture',{mode:'hard',limitGiB:1,hardInodes:1000,minFreeGiB:0});assert.equal((await storage.usage('fixture')).hardQuota,true);
    await storage.assertCanStart('fixture');assert.ok(calls.some(c=>c[0]==='status'&&c[1]===true));
    cap.usedInodes=910;await assert.rejects(storage.assertAdmission('fixture'),e=>e.statusCode===507);assert.equal((await storage.usage('fixture')).percent,91);
    cap.hardBytes+=4096;const mismatch=await storage.usage('fixture');assert.equal(mismatch.hardQuota,false);assert.match(mismatch.quotaError,/不符/);await assert.rejects(storage.assertCanStart('fixture'));
    await assert.rejects(storage.configurePolicy('fixture',{mode:'soft',limitGiB:1}),/硬配额/);
  }finally{Object.assign(backend,original);}
});
test('partial quota apply or inconsistent acknowledgement remains locked across process restart',async()=>{
  const backend=require('../src/storage-quota'),original={probe:backend.probe,apply:backend.apply};
  backend.probe=async()=>({supported:true});backend.apply=async()=>({verified:true,hardBytes:123,hardInodes:100000});
  try{await assert.rejects(storage.configurePolicy('fixture',{mode:'hard',limitGiB:1}),/不符/);}
  finally{Object.assign(backend,original);}
  assert.equal(storage.isBlocked('fixture'),true);await assert.rejects(storage.assertAdmission('fixture'));
  const persisted=JSON.parse(fs.readFileSync(path.join(scratch,'storage','fixture.json')));assert.equal(persisted.policy.mode,'hard');assert.equal(persisted.hard.phase,'failed');
  assert.equal((await storage.usage('fixture')).hardQuota,false);
});
test('capacity guard still runs when a streaming request owns the instance operation lock',async()=>{
  write('workspace/large.bin',Buffer.alloc(1024*1024));storage.setPolicy('fixture',{limitGiB:0.000001,minFreeGiB:0});running=true;
  const operations=require('../src/operations'),operation={description:'POST /fixture/chat/stream'};operations.busy.set('fixture',operation);
  try{await storage.tick();assert.equal(running,false);assert.equal(operations.busy.get('fixture'),operation);}finally{operations.busy.delete('fixture');}
});
test('release requires a stopped instance, recovered headroom and valid configuration',async()=>{
  storage.setPolicy('fixture',{limitGiB:1,minFreeGiB:0});running=true;await assert.rejects(storage.release('fixture'),/停止/);running=false;
  fs.unlinkSync(path.join(store.configDir('fixture'),'openclaw.json'));await assert.rejects(storage.release('fixture'),/配置缺失/);
  write('openclaw/openclaw.json','{}');await storage.release('fixture');
});
