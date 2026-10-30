'use strict';
// Host administrator only. A plugin image is code, never an authority to mount
// instance files, inherit gateway environment, or contact the Docker daemon.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{policy}=require('./plugin-policy.cjs');
const BRIDGE='/home/node/.openclaw/manager-isolated-tools';
function applyConfig(config,targets){
 const result=structuredClone(config);result.plugins||={};result.plugins.entries||={};result.plugins.load||={};
 result.plugins.load.paths=[...new Set([...(result.plugins.load.paths||[]),BRIDGE])];
 result.plugins.entries['manager-isolated-tools']={enabled:true};
 if(Array.isArray(result.plugins.allow)&&!result.plugins.allow.includes('manager-isolated-tools'))result.plugins.allow.push('manager-isolated-tools');
 result.plugins.deny=[...new Set([...(result.plugins.deny||[]),...Object.keys(targets)])];
 for(const id of Object.keys(targets))result.plugins.entries[id]={...result.plugins.entries[id],enabled:false};
 const names=Object.values(targets).flatMap(t=>(t.tools||[]).map(tool=>tool.name));
 if(names.length){
  result.tools||={};result.tools.sandbox||={};result.tools.sandbox.tools||={};
  for(const scope of [result.tools,result.tools.sandbox.tools]){
   const key=scope.allow?.length?'allow':'alsoAllow';scope[key]=[...new Set([...(scope[key]||[]),...names])];
  }
 }
 return result;
}
function assertConfig(config,record){
 if(!record?.targets||!Object.keys(record.targets).length)return;
 if(JSON.stringify(applyConfig(config,record.targets))!==JSON.stringify(config))throw Error('独立插件策略不能被移除或修改；请使用 isolate-plugin.cjs 管理');
}
function internalTCP(record){return Object.values(record.pluginIsolation?.targets||{}).map(t=>({ip:t.ip,port:18790}));}
function noSymlink(file){try{if(fs.lstatSync(file).isSymbolicLink())throw Error('工具桥目录和文件不能是符号链接');}catch(error){if(error.code!=='ENOENT')throw error;}}
function clearPolicy(file,root,id){
 const base=path.resolve(root,'manager','security','plugins',id)+path.sep,resolved=path.resolve(file);
 if(!resolved.startsWith(base)||path.basename(resolved)!=='policy.json')throw Error('Plugin policy cleanup scope mismatch');
 try{fs.unlinkSync(resolved);}catch(error){if(error.code!=='ENOENT')throw error;}
 try{fs.rmdirSync(path.dirname(resolved));}catch(error){if(!['ENOENT','ENOTEMPTY'].includes(error.code))throw error;}
}
function withdrawConfig(config,target){
 const result=structuredClone(config),names=new Set(target.tools.map(t=>t.name));
 for(const [at,scope]of [['global',result.tools],['sandbox',result.tools?.sandbox?.tools]])if(scope)for(const key of ['allow','alsoAllow'])if(Array.isArray(scope[key])){
  scope[key]=scope[key].filter(name=>!names.has(name)||(target.preexistingGrants?.[at]?.[key]||[]).includes(name));if(!scope[key].length)delete scope[key];
 }
 return result;
}
function writeBridge(store,id,targets){
 const folder=path.join(store.configDir(id),'manager-isolated-tools'),owner=fs.statSync(store.configDir(id));
 const files=['plugin-policy.cjs','plugin-bridge.cjs','network-guard.cjs','index.cjs','openclaw.plugin.json','package.json','targets.json'];
 noSymlink(folder);
 fs.mkdirSync(folder,{recursive:true,mode:0o700});
 for(const file of files)noSymlink(path.join(folder,file));
 for(const file of ['plugin-policy.cjs','plugin-bridge.cjs','network-guard.cjs'])store.atomicWrite(path.join(folder,file),fs.readFileSync(path.join(__dirname,file),'utf8'));
 store.atomicWrite(path.join(folder,'index.cjs'),"module.exports=require('./plugin-bridge.cjs');\n");
 store.atomicWrite(path.join(folder,'openclaw.plugin.json'),JSON.stringify({id:'manager-isolated-tools',name:'Isolated plugin tools',activation:{onStartup:true},contracts:{tools:Object.values(targets).flatMap(t=>t.tools.map(tool=>tool.name))},configSchema:{type:'object',additionalProperties:false,properties:{}}}));
 store.atomicWrite(path.join(folder,'package.json'),JSON.stringify({name:'manager-isolated-tools',version:'1.0.0',type:'commonjs',openclaw:{extensions:['./index.cjs']}}));
 store.atomicWrite(path.join(folder,'targets.json'),JSON.stringify(Object.values(targets).map(({ip,token,tools})=>({ip,port:18790,token,tools}))));
 if(process.getuid?.()===0){fs.chownSync(folder,owner.uid,owner.gid);for(const name of files)fs.chownSync(path.join(folder,name),owner.uid,owner.gid);}
}
async function checkBridge(gateway,targets){
 const task=await gateway.exec({Cmd:['openclaw','gateway','call','tools.catalog','--json'],AttachStdout:true,AttachStderr:true});
 const stream=await task.start({}),output=new(require('stream').PassThrough)(),errors=new(require('stream').PassThrough)(),chunks=[];let bytes=0;
 output.on('data',b=>{bytes+=b.length;if(bytes>1024*1024)stream.destroy(Error('Isolated tool catalog too large'));else chunks.push(b);});errors.resume();
 gateway.modem.demuxStream(stream,output,errors);
 const timer=setTimeout(()=>stream.destroy(Error('Isolated tool registration check timed out')),20000);
 try{await new Promise((resolve,reject)=>{stream.on('end',resolve);stream.on('error',reject);stream.on('close',()=>reject(Error('Tool catalog connection closed')));});}finally{clearTimeout(timer);}
 if((await task.inspect()).ExitCode!==0||bytes>1024*1024)throw Error('无法检查网关中的隔离工具注册');
 const catalog=require('../src/management').jsonOutput(Buffer.concat(chunks).toString('utf8')),actual=new Set((catalog.groups||[]).filter(g=>g.pluginId==='manager-isolated-tools').flatMap(g=>g.tools.map(t=>t.id)));
 const expected=Object.values(targets).flatMap(t=>t.tools.map(tool=>tool.name));
 if(expected.some(name=>!actual.has(name))||actual.size!==expected.length)throw Error('网关未正确注册隔离工具，需要适配当前运行时；切换已回滚');
}
async function installBridge(docker,state){
 // Only the platform-authored adapter is linked into the trusted Gateway.
 // --accept-capabilities is scoped to this fixed generated directory, never
 // to the third-party plugin image. Policy warnings are NOT acknowledged.
 const helper=await docker.createContainer({Image:state.Image,User:state.Config.User,Entrypoint:['openclaw'],Cmd:['plugins','install',BRIDGE,'--link','--force','--accept-capabilities'],HostConfig:{NetworkMode:'none',Binds:state.HostConfig.Binds,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:128,Memory:512*1024**2,LogConfig:{Type:'none'}}});
 let timer;
 try{await helper.start();timer=setTimeout(()=>helper.stop({t:1}).catch(()=>{}),30000);if((await helper.wait()).StatusCode!==0)throw Error('运行时拒绝链接平台工具桥，请检查本地安装策略及运行时兼容性');}
 finally{clearTimeout(timer);await helper.remove({force:true});}
}
async function writeRuntimeConfig(docker,store,id,state,config){
 const owner=fs.statSync(store.configDir(id)),file=path.join(store.instanceDir(id),'manager','security','plugin-mutation-'+crypto.randomBytes(6).toString('hex')+'.json');
 store.atomicWrite(file,JSON.stringify({config,expectedHash:store.revision(store.readOpenclawConfig(id))}));if(process.getuid?.()===0)fs.chownSync(file,owner.uid,owner.gid);
 let helper,timer;
 try{
  helper=await docker.createContainer({Image:state.Image,User:state.Config.User,Entrypoint:['node','-e',fs.readFileSync(path.join(__dirname,'plugin-config.cjs'),'utf8')],HostConfig:{NetworkMode:'none',Binds:[...state.HostConfig.Binds,file.replace(/\\/g,'/')+':/mutation.json:ro'],CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:128,Memory:512*1024**2,LogConfig:{Type:'none'}}});
  await helper.start();timer=setTimeout(()=>helper.stop({t:1}).catch(()=>{}),30000);
  if((await helper.wait()).StatusCode!==0)throw Error('运行时拒绝事务配置写入，请检查配置和运行时兼容性');
 }finally{clearTimeout(timer);try{if(helper)await helper.remove({force:true});}finally{fs.unlinkSync(file);}}
}
async function apply({docker,store,instance,definition,image}){
 const p=policy(definition),before=store.readOpenclawConfig(instance.id),record=structuredClone(instance);
 if(record.security?.profile!=='ssh-sandbox-v1')throw Error('请先使用 secure-instance.cjs 迁移到带网络守卫的安全实例');
 if(record.pluginIsolation?.targets?.[p.id])throw Error('插件已隔离；请先移除旧执行容器再替换');
 const other=Object.values(record.pluginIsolation?.targets||{}).flatMap(t=>t.tools.map(tool=>tool.name));
 if(p.tools.some(t=>other.includes(t.name)))throw Error('隔离工具名冲突');
 const runtime=await docker.getImage(image).inspect();if(runtime.Config.Labels?.['openclaw.security.plugin']!=='tool-worker-v1')throw Error('请使用 Dockerfile.plugin 构建专用插件镜像');
 const gateway=docker.getContainer(record.containerId),originalState=await gateway.inspect();if(!originalState.State.Running)throw Error('请先启动目标实例');
 const suffix=Date.now(),root=store.instanceDir(instance.id),scope=require('./profile.cjs').stamp(path.resolve(root).replace(/\\/g,'/'));
 const folder=path.join(root,'manager','security','plugins',p.id,String(suffix));fs.mkdirSync(folder,{recursive:true,mode:0o700});
 const token=crypto.randomBytes(32).toString('hex'),file=path.join(folder,'policy.json');
 store.atomicWrite(file,JSON.stringify({...p,token}));if(process.getuid?.()===0)fs.chownSync(file,65532,65532);fs.chmodSync(file,0o444);
 let worker,firewall,stopped=false,committed=false;
 try{
  // Explicit empty overrides prevent image-supplied NODE_OPTIONS/proxy/secret
  // variables from being inherited, and no gateway environment is copied.
  const env=(runtime.Config.Env||[]).map(v=>v.split('=')[0]+'=');env.push('PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','TMPDIR=/tmp');
  worker=await docker.createContainer({name:'openclaw-plugin-'+instance.id+'-'+p.id+'-'+suffix,Image:runtime.Id,User:'65532:65532',Entrypoint:['/usr/local/bin/node','/opt/openclaw-security/launch.cjs'],Cmd:['/usr/local/bin/node','/opt/openclaw-security/plugin-worker.cjs'],Env:env,Labels:{'openclaw.security.helper':'plugin','openclaw.security.instance':instance.id,'openclaw.security.plugin':p.id,'openclaw.security.scope':scope},HostConfig:{RestartPolicy:{Name:'unless-stopped'},NetworkMode:'bridge',Dns:['127.0.0.53'],Binds:[file.replace(/\\/g,'/')+':/policy/policy.json:ro'],ReadonlyRootfs:true,Tmpfs:{'/tmp':'rw,nosuid,nodev,noexec,size=64m,mode=1777'},CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:64,Memory:256*1024**2,NanoCpus:5e8,LogConfig:{Type:'none'}}});
  await worker.start();
  const guardName='openclaw-guard-'+instance.id+'-plugin-'+p.id+'-'+suffix;
  firewall=await require('./provision.cjs').guard(docker,worker,{origins:p.origins||[],resolver:record.security.resolver},record.security.workerImageId,guardName);
  await require('./provision.cjs').waitReady(docker,worker);
  // Health runs inside the isolated namespace and confirms registration, not
  // merely that the TCP listener exists. Never execute plugin code on the host.
  let healthy=false;
  for(let i=0;i<40;i++){
   const task=await worker.exec({User:'65532:65532',Cmd:['/usr/local/bin/node','-e',"const h=require('http');h.get({host:'127.0.0.1',port:18790,path:'/health',headers:{authorization:'Bearer '+JSON.parse(require('fs').readFileSync('/policy/policy.json')).token}},r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:1));}).on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000);"],AttachStdout:true,AttachStderr:true});
   const stream=await task.start({});for await(const _ of stream){}if((await task.inspect()).ExitCode===0){healthy=true;break;}
   if(!(await worker.inspect()).State.Running)break;await new Promise(r=>setTimeout(r,250));
  }
  if(!healthy)throw Error('插件不能在最小 API 下注册工具，需要专用适配；原有插件未变动');
  const ip=(await worker.inspect()).NetworkSettings.Networks.bridge.IPAddress;
  const originalConfig=JSON.parse(before),preexistingGrants={global:{allow:originalConfig.tools?.allow||[],alsoAllow:originalConfig.tools?.alsoAllow||[]},sandbox:{allow:originalConfig.tools?.sandbox?.tools?.allow||[],alsoAllow:originalConfig.tools?.sandbox?.tools?.alsoAllow||[]}};
  const target={workerId:worker.id,guardName,guardId:firewall.id,ip,token,tools:p.tools,origins:p.origins||[],imageId:runtime.Id,policyFile:file,preexistingGrants};
  const targets={...record.pluginIsolation?.targets,[p.id]:target};
  if(store.readOpenclawConfig(instance.id)!==before)throw Error('准备期间配置发生变化，请重试');
  await gateway.stop({t:20});stopped=true;
  if(store.readOpenclawConfig(instance.id)!==before)throw Error('停止期间配置发生变化，请重新审查');
  const candidate=applyConfig(JSON.parse(before),targets);writeBridge(store,instance.id,targets);
  instance.pluginIsolation={version:1,targets};store.saveInstance(instance);
  assertConfig(candidate,instance.pluginIsolation);require('./profile.cjs').assert(candidate,instance.security.targets);
  await writeRuntimeConfig(docker,store,instance.id,originalState,candidate);
  await installBridge(docker,originalState);
  await require('./lifecycle.cjs').create({docker,root:store.DATA_ROOT}).reconcile(instance,{resumeWorkers:true});
  if(!await require('../src/lifecycle').ready(instance.port))throw Error('隔离插件切换后网关未就绪');
  await checkBridge(gateway,targets);
  committed=true;return {id:p.id,tools:p.tools.map(t=>t.name),image:runtime.Id};
 }catch(error){
  if(stopped){await gateway.stop({t:5}).catch(()=>{});writeBridge(store,instance.id,record.pluginIsolation?.targets||{});const restored=JSON.parse(before);if(!Object.keys(record.pluginIsolation?.targets||{}).length){restored.plugins||={};restored.plugins.entries||={};restored.plugins.entries['manager-isolated-tools']={enabled:false};}await writeRuntimeConfig(docker,store,instance.id,originalState,restored);if(Object.keys(record.pluginIsolation?.targets||{}).length)await installBridge(docker,originalState);store.saveInstance(record);await require('./lifecycle.cjs').create({docker,root:store.DATA_ROOT}).reconcile(record,{resumeWorkers:true});}
  throw error;
 }finally{if(!committed){try{if(firewall)await firewall.remove({force:true});if(worker)await worker.remove({force:true});}finally{clearPolicy(file,root,p.id);}}}
}
async function remove({docker,store,instance,id}){
 const record=structuredClone(instance),target=record.pluginIsolation?.targets?.[id];if(!target)throw Error('独立插件不存在');
 const before=store.readOpenclawConfig(instance.id),gateway=docker.getContainer(record.containerId),gatewayState=await gateway.inspect(),worker=docker.getContainer(target.workerId);
 const state=await worker.inspect();if(state.Config.Labels?.['openclaw.security.instance']!==instance.id||state.Config.Labels?.['openclaw.security.plugin']!==id)throw Error('Plugin ownership mismatch');
 if(!(await gateway.inspect()).State.Running)throw Error('请先启动实例再移除独立插件');
 const targets={...record.pluginIsolation.targets};delete targets[id];let stopped=false;
 try{
  if(state.State.Running&&!state.State.Paused)await worker.pause();
  await gateway.stop({t:20});stopped=true;
  if(store.readOpenclawConfig(instance.id)!==before)throw Error('配置已变化，请重试');
  instance.pluginIsolation={version:1,targets};writeBridge(store,instance.id,targets);store.saveInstance(instance);
  await writeRuntimeConfig(docker,store,instance.id,gatewayState,withdrawConfig(JSON.parse(before),target));
  await installBridge(docker,gatewayState);
  // Keep the former native plugin disabled. Restoring native execution is a
  // separate administrator trust decision, never an automatic rollback option.
  await require('./lifecycle.cjs').create({docker,root:store.DATA_ROOT}).reconcile(instance,{resumeWorkers:true});
  if(!await require('../src/lifecycle').ready(instance.port))throw Error('移除后网关未就绪');
  await checkBridge(gateway,targets);
 }catch(error){
  if(stopped){await gateway.stop({t:5}).catch(()=>{});writeBridge(store,instance.id,record.pluginIsolation.targets);await writeRuntimeConfig(docker,store,instance.id,gatewayState,JSON.parse(before));await installBridge(docker,gatewayState);store.saveInstance(record);await require('./lifecycle.cjs').create({docker,root:store.DATA_ROOT}).reconcile(record,{resumeWorkers:true});}
  else if(state.State.Running&&!state.State.Paused)await worker.unpause().catch(()=>{});
  throw error;
 }
 await worker.remove({force:true});await docker.getContainer(target.guardName).remove({force:true});
 clearPolicy(target.policyFile,store.instanceDir(instance.id),id);
 return {removed:id,nativeEnabled:false};
}
module.exports={apply:args=>require('./provision.cjs').withLock(args,apply),remove:args=>require('./provision.cjs').withLock(args,remove),applyConfig,withdrawConfig,assertConfig,internalTCP,writeBridge,writeRuntimeConfig};
