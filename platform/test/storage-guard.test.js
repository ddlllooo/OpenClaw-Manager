'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-drain-'));process.env.OPENCLAW_DATA_DIR=path.join(root,'instances');
const store=require('../src/instances'),{createGuard}=require('../src/storage-guard');
store.saveInstance({id:'fixture',containerId:'container'});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function harness() {
 let time=1000,state={policy:{limitGiB:10,warnPercent:80,admissionPercent:90,stopPercent:95,drainSeconds:30},blocked:null},percent=91,running=true,reason=null;
 const calls=[],events=[];
 const api={
  inspectContainer:async()=>({Id:'container',State:{Running:running}}),
  getContainer:()=>({update:async body=>calls.push(['policy',body])}),
  stopContainer:async(id,seconds)=>{calls.push(['stop',id,seconds]);running=false;},
 };
 let reply=()=>({status:'draining',suspensionId:'lease',expiresAtMs:45000,activeCount:1});
 const opts={read:()=>structuredClone(state),write:(_id,value)=>{state=structuredClone(value);},usage:async()=>({policy:state.policy,percent,reason}),dm:api,
  rpc:async(_r,method,params)=>{calls.push([method,params]);return reply(method,params);},now:()=>time,emit:(...args)=>events.push(args)};
 return {opts,api,calls,events,guard:createGuard(opts),get state(){return state;},get running(){return running;},setReply:fn=>reply=fn,advance:ms=>time+=ms,setPercent:n=>percent=n,setReason:r=>reason=r};
}
test('drain fences Gateway scheduling and reaches a confirmed stopped state without restarting',async()=>{
 const h=harness();await h.guard.enforce('fixture');assert.equal(h.running,true);assert.equal(h.state.drain.phase,'draining');assert.ok(h.state.blocked);
 assert.deepEqual(h.calls[0],['gateway.suspend.prepare',{requestId:h.state.drain.requestId,drain:true,terminalPolicy:'terminate'}]);
 h.advance(5000);h.setReply(()=>({status:'ready',expiresAtMs:45000,activeCount:0}));await h.guard.enforce('fixture');
 assert.equal(h.running,false);assert.equal(h.state.drain.phase,'stopped');assert.equal(h.state.drain.interruptedPossible,false);
 assert.equal(h.calls.filter(c=>c[0]==='stop').length,1);assert.ok(h.calls.some(c=>c[0]==='gateway.suspend.status'&&c[1].suspensionId==='lease'));
});
test('busy requests cannot extend the drain deadline; process restart preserves the lock',async()=>{
 const h=harness();await h.guard.enforce('fixture');h.advance(31000);
 await createGuard(h.opts).enforce('fixture');assert.equal(h.running,false);assert.equal(h.state.drain.interruptedPossible,true);
 assert.match(h.state.drain.stopReason,/到时/);assert.equal(h.calls.filter(c=>c[0]==='gateway.suspend.prepare').length,1);
 const stoppedAt=h.state.drain.stoppedAt;h.advance(5000);await h.guard.enforce('fixture');assert.equal(h.state.drain.interruptedPossible,true);assert.equal(h.state.drain.stoppedAt,stoppedAt);assert.match(h.state.drain.stopReason,/到时/);
});
test('legacy, expired and inconsistent suspension responses immediately fall back to bounded stop',async()=>{
 for(const reply of [()=>{throw Error('unknown method');},()=>({status:'ready',expiresAtMs:45000,suspensionId:'lease',activeCount:2}),()=>({status:'draining',suspensionId:'lease',expiresAtMs:900}),()=>({status:'busy'})]){
  const h=harness();h.setReply(reply);await h.guard.enforce('fixture');assert.equal(h.running,false);assert.equal(h.state.drain.supported,false);assert.equal(h.state.drain.interruptedPossible,true);
 }
});
test('burst usage and quota verification failure bypass waiting and preserve data',async()=>{
 const h=harness();h.setPercent(100);h.setReason('hard quota reached');await h.guard.enforce('fixture');
 assert.equal(h.running,false);assert.equal(h.calls.some(c=>c[0].startsWith('gateway.')),false);
 const second=harness();second.opts.usage=async()=>{throw Error('quota readback failed');};await createGuard(second.opts).enforce('fixture');assert.equal(second.running,false);
});
test('concurrent guard checks coalesce and stop failures leave a durable retry state',async()=>{
 const h=harness();await Promise.all([h.guard.enforce('fixture'),h.guard.enforce('fixture')]);assert.equal(h.calls.length,1);
 h.advance(31000);const original=h.api.stopContainer;h.api.stopContainer=async()=>{throw Error('docker down');};
 await assert.rejects(h.guard.enforce('fixture'),/docker down/);assert.equal(h.state.drain.phase,'stopping');assert.ok(h.state.blocked);
 h.api.stopContainer=original;await h.guard.enforce('fixture');assert.equal(h.running,false);
});
test('restart-policy update failures still attempt stop and do not mislabel the Gateway protocol',async()=>{
 const h=harness();h.setReply(()=>({status:'ready',suspensionId:'lease',expiresAtMs:45000,activeCount:0}));
 h.api.getContainer=()=>({update:async()=>{throw Error('policy denied');}});
 await assert.rejects(h.guard.enforce('fixture'),/policy denied/);assert.equal(h.running,false);assert.equal(h.state.drain.supported,true);assert.ok(h.state.drain.warning);
});
test('a failed stop acknowledgement never reports successful protection',async()=>{
 const h=harness();h.setReason('capacity');h.api.stopContainer=async()=>{};
 await assert.rejects(h.guard.enforce('fixture'),/未确认/);assert.equal(h.state.drain.phase,'stopping');
});

test('an unmounted APFS record cannot hide a running container from emergency stop',async()=>{
 const h=harness();h.state.hard={backend:'apfs-volume'};h.setReason('APFS volume missing');
 h.api.listContainersByLabel=async()=>[{instanceId:'fixture',containerId:'container',state:'running'}];
 const file=path.join(store.instanceDir('fixture'),'instance.json'),original=fs.readFileSync(file);fs.unlinkSync(file);
 try{await h.guard.enforce('fixture');assert.equal(h.running,false);assert.equal(h.state.drain.phase,'stopped');}
 finally{fs.writeFileSync(file,original);}
});
