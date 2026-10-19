'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const history=require('../src/cleanup-history');
const homes=[];
const home=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-history-'));homes.push(p);return p;};
const record=(n,extra={})=>({at:new Date(1700000000000+n*1000).toISOString(),source:'automatic',trigger:{kind:'manager-upgrade'},state:'completed',removedImages:[],removedContainers:[],...extra});
test.after(()=>homes.forEach(p=>fs.rmSync(p,{recursive:true,force:true})));

test('history reads current and rotated records newest first, with cursor stable across appends and rotation',()=>{
  const p=home(),file=path.join(p,'retention-audit.jsonl');
  fs.writeFileSync(file+'.1',[record(1),record(2)].map(JSON.stringify).join('\n')+'\n');
  history.append(p,record(3));history.append(p,record(4));
  const first=history.read(p,{limit:2});assert.deepEqual(first.entries.map(e=>e.at),[record(4).at,record(3).at]);
  history.append(p,record(5));
  const second=history.read(p,{limit:2,cursor:first.nextCursor});assert.deepEqual(second.entries.map(e=>e.at),[record(2).at,record(1).at]);assert.equal(second.nextCursor,null);
  fs.renameSync(file,file+'.1');history.append(p,record(6));
  assert.equal(history.read(p,{cursor:first.nextCursor}).entries.length,0);
  assert.throws(()=>history.read(p,{cursor:second.entries[0].id}),e=>e.statusCode===409);
});

test('legacy records keep known IDs and derive meaningful status reasons without inventing names',()=>{
  const p=home();fs.writeFileSync(path.join(p,'retention-audit.jsonl'),JSON.stringify(record(1,{source:undefined,trigger:{kind:'manual-cleanup'},removedImages:['sha256:old'],removedContainers:['old-container'],errors:[{id:'busy',status:409}]}))+'\n');
  const entry=history.read(p).entries[0];assert.equal(entry.legacy,true);assert.equal(entry.source,'manual');
  assert.equal(entry.deletedImages[0].name,'sha256:old');assert.equal(entry.deletedContainers[0].id,'old-container');assert.match(entry.errors[0].reason,/占用/);
});

test('new records preserve names, tags, failures and partial tag removal across reader restarts',()=>{
  const p=home(),report=record(2,{source:'manual',state:'partial',deletedImages:[{id:'gone',name:'openclaw:v1',tags:['openclaw:v1']}],removedImages:['gone'],
    deletedContainers:[{id:'c',type:'rollback',name:'openclaw-a-rollback-1',instanceName:'业务实例'}],
    removedTags:[{id:'gone',name:'openclaw:v1'},{id:'partial',name:'openclaw:alias',reason:'标签已移除'}],errors:[{id:'partial',name:'openclaw:keep',type:'image',status:409,reason:'有其他容器引用'}]});
  history.append(p,report);const entry=history.read(p).entries[0];
  assert.equal(entry.legacy,false);assert.ok(report.id);assert.ok(entry.completedAt);assert.equal(entry.deletedContainers[0].instanceName,'业务实例');
  assert.deepEqual(entry.deletedImages[0].tags,['openclaw:v1']);assert.equal(entry.errors[0].reason,'有其他容器引用');assert.equal(entry.removedTags.length,1);
});

test('history tolerates incomplete records without mutating logs and rejects invalid or expired pagination',()=>{
  const p=home(),file=path.join(p,'retention-audit.jsonl');history.append(p,record(1));fs.appendFileSync(file,'null\n{"at":\n');
  const before=fs.readFileSync(file);const result=history.read(p);assert.equal(result.entries.length,1);assert.equal(result.warnings.length,1);assert.deepEqual(fs.readFileSync(file),before);
  for(const query of [{limit:0},{limit:51},{limit:1.5},{cursor:'bad'},{cursor:'a'.repeat(64)+':1'}])assert.throws(()=>history.read(p,query),e=>[400,409].includes(e.statusCode));
  assert.deepEqual(history.read(home()).entries,[]);
});

test('unreadable and oversized history files do not masquerade as empty successful history',()=>{
  const p=home(),file=path.join(p,'retention-audit.jsonl');fs.mkdirSync(file);
  assert.throws(()=>history.read(p),e=>e.statusCode===503);fs.rmdirSync(file);
  const fd=fs.openSync(file,'w');fs.ftruncateSync(fd,4*1024*1024+1);fs.closeSync(fd);
  assert.match(history.read(p).warnings.join(''),/过大/);
});
