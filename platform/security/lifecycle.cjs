 'use strict';
const fs=require('fs'),path=require('path'),{guard,waitReady}=require('./provision.cjs');
function create({docker,root}){
 const locks=new Map();let timer;
 async function locked(id,fn){const prior=locks.get(id)||Promise.resolve();const next=prior.catch(()=>{}).then(fn);locks.set(id,next);try{return await next;}finally{if(locks.get(id)===next)locks.delete(id);}}
 async function ensureGuard(target,name,policy,image,id,expectedIP){
  let existing=null;try{existing=await docker.getContainer(name).inspect();}catch(error){if(error.statusCode!==404)throw error;}
  let state=await target.inspect();
  if(existing){if(existing.Config.Labels?.['openclaw.security.target']!==target.id||existing.Config.Labels?.['openclaw.security.instance']!==id)throw Error('Guard ownership mismatch');
   if(state.State.Running&&existing.State.Running&&!existing.State.Restarting&&existing.Config.Labels['openclaw.security.targetStartedAt']===state.State.StartedAt)return;
  }
  // Drop references to the old network namespace before releasing a new application.
  if(state.State.Running)await target.stop({t:5});
  if(existing)await docker.getContainer(existing.Id).remove({force:true});
  await target.start();state=await target.inspect();
  if(expectedIP&&state.NetworkSettings.Networks.bridge.IPAddress!==expectedIP)throw Error('Worker address changed; rerun secure-instance migration before serving tools');
  await guard(docker,target,policy,image,name);await waitReady(docker,target);
 }
 async function reconcile(record,{resumeWorkers=false}={}){
  const scope=require('./profile.cjs').stamp(path.resolve(root,record.id).replace(/\\/g,'/'));
  const sec=record.security;if(sec?.profile!=='ssh-sandbox-v1')return;
  for(const [agent,target]of Object.entries(sec.targets)){
   const worker=docker.getContainer(target.workerId),row=await worker.inspect();
   if(row.Config.Labels?.['openclaw.security.scope']!==scope||row.Config.Labels?.['openclaw.security.instance']!==record.id||row.Config.Labels?.['openclaw.security.agent']!==agent)throw Error('Worker ownership mismatch');
   if(row.State.Paused){if(resumeWorkers)await worker.unpause();else continue;}
   await ensureGuard(worker,target.guardName,{origins:target.origins||[],resolver:sec.resolver},sec.workerImageId,record.id,target.ip);
  }
  for(const [id,target]of Object.entries(record.pluginIsolation?.targets||{})){
   const worker=docker.getContainer(target.workerId),state=await worker.inspect();
   if(state.Config.Labels?.['openclaw.security.scope']!==scope||state.Config.Labels?.['openclaw.security.instance']!==record.id||state.Config.Labels?.['openclaw.security.plugin']!==id||state.Config.Labels?.['openclaw.security.helper']!=='plugin'||state.Image!==target.imageId)throw Error('Plugin worker ownership mismatch');
   if(state.State.Paused){if(resumeWorkers)await worker.unpause();else continue;}
   await ensureGuard(worker,target.guardName,{origins:target.origins||[],resolver:sec.resolver},sec.workerImageId,record.id,target.ip);
  }
  for(const [id,target]of Object.entries(record.channelIsolation?.accounts||{})){
   const worker=docker.getContainer(target.workerId),state=await worker.inspect();
   if(state.Config.Labels?.['openclaw.security.scope']!==scope||state.Config.Labels?.['openclaw.security.instance']!==record.id||state.Config.Labels?.['openclaw.security.account']!==id||state.Config.Labels?.['openclaw.security.helper']!=='channel'||state.Image!==target.imageId)throw Error('Channel worker ownership mismatch');
   if(state.State.Paused){if(resumeWorkers)await worker.unpause();else continue;}
   await ensureGuard(worker,target.guardName,{origins:target.origins,resolver:sec.resolver},sec.workerImageId,record.id,target.ip);
   if(target.state==='active'&&await require('./feishu-provision.cjs').health(worker,true)!==0)throw Error('Channel adapter not ready');
  }
  const gateway=docker.getContainer(record.containerId),row=await gateway.inspect();
  if(row.Config.Labels?.['openclaw.security.scope']!==scope||row.Config.Labels?.['openclaw.instance']!==record.id||row.Config.Labels?.['openclaw.security.profile']!=='ssh-sandbox-v1')throw Error('Gateway ownership mismatch');
  await ensureGuard(gateway,sec.gatewayGuardName,{origins:sec.origins,resolver:sec.resolver,internalTCP:[...Object.values(sec.targets).map(v=>({ip:v.ip,port:2222})),...require('./plugin-provision.cjs').internalTCP(record)]},sec.workerImageId,record.id);
 }
 function read(id){const row=JSON.parse(fs.readFileSync(path.join(root,id,'instance.json'),'utf8'));if(row.id!==id)throw Error('Instance mismatch');return row;}
 async function act(id,action){return locked(id,async()=>{
  const record=read(id),target=docker.getContainer(record.containerId);
  if(action==='stop'){await target.stop({t:20}).catch(e=>{if(e.statusCode!==304)throw e;});
   const scope=require('./profile.cjs').stamp(path.resolve(root,record.id).replace(/\\/g,'/'));
   for(const worker of [...Object.values(record.security.targets),...Object.values(record.pluginIsolation?.targets||{}),...Object.values(record.channelIsolation?.accounts||{})]){const c=docker.getContainer(worker.workerId),state=await c.inspect();if(state.Config.Labels?.['openclaw.security.scope']!==scope)throw Error('Worker ownership mismatch');if(state.State.Running&&!state.State.Paused)await c.pause();}
   return;}
  if(action==='restart')await target.stop({t:20}).catch(e=>{if(e.statusCode!==304)throw e;});
  await reconcile(record,{resumeWorkers:true});
 });}
 function startMonitor(){if(timer)return;timer=setInterval(async()=>{
  let names;try{names=fs.readdirSync(root);}catch{return;}
  for(const id of names){if(!/^[a-z0-9_-]{1,80}$/i.test(id)||locks.has(id)||fs.existsSync(path.join(root,id,'manager','security','migration.lock')))continue;
   try{const record=read(id);if(record.security?.profile!=='ssh-sandbox-v1'||!(await docker.getContainer(record.containerId).inspect()).State.Running)continue;
    await locked(id,()=>reconcile(record));
   }catch{ /* Remain blocked; never remove the egress policy or fall back to local exec. */ }
  }
 },15000);timer.unref();}
 return {act,reconcile,startMonitor,stopMonitor(){clearInterval(timer);timer=null;}};
}
module.exports={create};
