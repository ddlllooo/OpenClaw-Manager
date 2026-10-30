'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'apfs-intent-'));
process.env.OPENCLAW_DATA_DIR=path.join(root,'instances');
process.env.OPENCLAW_STARTUP_HOME=root;
const store=require('../src/instances'),host=require('../src/host-control'),quota=require('../src/storage-quota'),dm=require('../src/docker');
const intent=require('../src/run-intent'),original={enabled:host.enabled,request:host.request,status:quota.status,inspect:dm.inspectContainer,start:dm.startContainer,stop:dm.stopContainer,resources:dm.updateResources,get:dm.getContainer};
let running,calls,fail,commits;
test.beforeEach(()=>{
 fs.rmSync(root,{recursive:true,force:true});fs.mkdirSync(root);calls=[];running=false;fail=false;commits=[];
 store.saveInstance({id:'fixture',containerId:'container',resources:{}});
 for(const folder of ['','openclaw','workspace','auth']){const dir=path.join(store.instanceDir('fixture'),folder);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'.openclaw-volume-id'),'fixture-uuid');}
 fs.writeFileSync(path.join(store.configDir('fixture'),'openclaw.json'),'{}');
 fs.mkdirSync(path.join(root,'storage'));fs.writeFileSync(path.join(root,'storage','fixture.json'),JSON.stringify({policy:{mode:'hard',limitGiB:1,minFreeGiB:0},hard:{phase:'verified',backend:'apfs-volume',volumeUUID:'fixture-uuid',hardBytes:1024**3}}));
 host.enabled=()=>true;
 host.request=async(action,body)=>{calls.push(body.action);assert.equal(action,'instance-intent');if(fail)throw Error('host offline');if(body.action==='prepare')return {token:'operation-token'};if(body.action==='commit')commits.push(body);return {ok:true};};
 quota.status=async()=>({verified:true,backend:'apfs-volume',volumeUUID:'fixture-uuid',hardBytes:1024**3,usedBytes:1024,inodeQuota:false});
 dm.inspectContainer=async()=>({Id:'container',State:{Running:running}});
 dm.updateResources=async()=>{};dm.getContainer=()=>({update:async()=>{}});
 dm.startContainer=async()=>{calls.push('docker-start');running=true;};
 dm.stopContainer=async()=>{calls.push('docker-stop');running=false;};
});
test.after(()=>{host.enabled=original.enabled;host.request=original.request;quota.status=original.status;dm.inspectContainer=original.inspect;dm.startContainer=original.start;dm.stopContainer=original.stop;dm.updateResources=original.resources;dm.getContainer=original.get;fs.rmSync(root,{recursive:true,force:true});});

test('real lifecycle start persists prepare and commits only after Docker confirms running',async()=>{
 await require('../src/lifecycle').start(store.loadInstance('fixture'));
 assert.deepEqual(calls,['prepare','docker-start','commit']);assert.equal(commits[0].containerId,'container');
});
test('failed host prepare never dispatches Docker start',async()=>{
 fail=true;await assert.rejects(require('../src/lifecycle').start(store.loadInstance('fixture')),/offline/);
 assert.equal(running,false);assert.equal(calls.includes('docker-start'),false);
});
test('manual stop writes an external durable tombstone before host acknowledgement',async()=>{
 host.request=async(_,body)=>{assert.equal(body.action,'stop');assert.equal(JSON.parse(fs.readFileSync(path.join(root,'apfs-run-inhibit','fixture.json'))).reason,'manual');return {ok:true};};
 await intent.stop('fixture');assert.ok(fs.existsSync(path.join(root,'apfs-run-inhibit','fixture.json')));
});
test('host failure preserves manual inhibit and never reports successful stop authorization',async()=>{
 fail=true;await assert.rejects(intent.stop('fixture'),/offline/);assert.ok(fs.existsSync(path.join(root,'apfs-run-inhibit','fixture.json')));
});
test('emergency storage stop keeps its inhibit even when the mailbox is unavailable',async()=>{
 fail=true;await intent.stop('fixture',{reason:'storage',emergency:true});
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'apfs-run-inhibit','fixture.json'))).reason,'storage');
});
test('actual stop route obtains persistent inhibit before invoking Docker',async()=>{
 running=true;const express=require('express'),app=express();app.use('/api/instances',require('../src/routes/instances'));
 app.use((e,req,res,next)=>res.status(500).json({error:e.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/instances/fixture/stop',{method:'POST'});assert.equal(res.status,200);assert.deepEqual(calls,['stop','docker-stop']);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
