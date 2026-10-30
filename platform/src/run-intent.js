'use strict';
// The native supervisor serializes intent with boot recovery. Stop tombstones
// are outside the quota, and remain until an explicit successful manual start.
const fs=require('fs'),path=require('path');
const store=require('./instances'),host=require('./host-control');
const guarded=id=>require('./storage').requiresMountGuard(id);
const home=()=>process.env.OPENCLAW_STARTUP_HOME||path.dirname(store.instancesRoot());
function tombstone(id,reason){
  store.instanceDir(id);
  const directory=path.join(home(),'apfs-run-inhibit');
  require('./storage').safe(directory);
  store.atomicWrite(path.join(directory,id+'.json'),JSON.stringify({id,reason,at:Date.now()/1000}));
  if(process.platform!=='win32'){
    const fd=fs.openSync(directory,'r');
    try{try{fs.fsyncSync(fd);}catch(e){if(!['EINVAL','ENOTSUP'].includes(e.code))throw e;}}finally{fs.closeSync(fd);}
  }
}
async function request(body,timeout=15000){
  if(!host.enabled())throw Object.assign(new Error('APFS 恢复意图需要宿主控制服务确认'),{statusCode:503});
  return host.request('instance-intent',body,timeout);
}
async function stop(id,{reason='manual',emergency=false}={}){
  if(!guarded(id))return;
  let error;
  try{tombstone(id,reason);}catch(e){error=e;}
  try{await request({id,action:'stop',reason},emergency?3000:15000);error=null;}catch(e){error||=e;}
  if(error&&!emergency)throw error;
}
async function track(instance,shouldRun,operation){
  if(!guarded(instance.id))return operation();
  if(!shouldRun){await stop(instance.id,{reason:'maintenance'});return operation();}
  await require('./storage').assertCanStart(instance.id);
  const prepared=await request({id:instance.id,action:'prepare'});
  try{
    const result=await operation();
    const latest=store.loadInstance(instance.id);
    await request({id:instance.id,action:'commit',token:prepared.token,containerId:latest.containerId});
    return result;
  }catch(error){
    // A failed replacement may have restored the original running container.
    // Commit only an actually running, still-unprotected primary; otherwise
    // keep it ineligible for automatic recovery.
    try{
      const latest=store.loadInstance(instance.id),dm=require('./docker');
      const c=latest.containerId?await dm.inspectContainer(latest.containerId):null;
      if(c?.State?.Running&&!require('./storage').isBlocked(instance.id))await request({id:instance.id,action:'commit',token:prepared.token,containerId:latest.containerId});
      else await request({id:instance.id,action:'fail',token:prepared.token});
    }catch{}
    throw error;
  }
}
module.exports={stop,track,tombstone};
