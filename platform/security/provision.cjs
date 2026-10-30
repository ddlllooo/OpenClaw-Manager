 'use strict';
// Host-admin installer. Never called by an Agent or exposed as an arbitrary Docker API.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),profile=require('./profile.cjs');
const defaults={workerImage:'openclaw-security-worker:latest',runtimeImage:'openclaw-security-runtime:latest'};
const bind=value=>value.replace(/\\/g,'/');
async function output(container){const result=await container.wait();if(result.StatusCode!==0){const error=Error('Security helper failed (exit '+result.StatusCode+')');error.detail=(await container.logs({stdout:true,stderr:true})).toString();throw error;}}
async function guard(docker,target,policy,image,name){
 const state=await target.inspect();
 const container=await docker.createContainer({name,Image:image,User:'0:0',Entrypoint:['node','/opt/openclaw-security/network-guard.cjs'],Cmd:[],Env:['OPENCLAW_GUARD_POLICY='+JSON.stringify(policy)],Labels:{'openclaw.security.helper':'guard','openclaw.security.instance':state.Config.Labels['openclaw.instance']||state.Config.Labels['openclaw.security.instance'],'openclaw.security.scope':state.Config.Labels['openclaw.security.scope'],'openclaw.security.target':target.id,'openclaw.security.targetStartedAt':state.State.StartedAt},HostConfig:{RestartPolicy:{Name:'unless-stopped'},NetworkMode:'container:'+target.id,PidMode:'',ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:['NET_ADMIN','NET_BIND_SERVICE'],SecurityOpt:['no-new-privileges:true'],Tmpfs:{'/run':'rw,nosuid,nodev,size=4m'},PidsLimit:64,Memory:128*1024**2,NanoCpus:1e8,LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'2'}}}});
 try{await container.start();return container;}catch(error){await container.remove({force:true}).catch(()=>{});throw error;}
}
async function waitReady(docker,target,timeout=20000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  const execution=await target.exec({User:'node',AttachStdout:true,AttachStderr:true,Cmd:['node','-e',"const h=require('http');h.get('http://127.0.0.1:5354/ready',r=>process.exit(r.statusCode===204?0:1)).on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),800);"]});
  const stream=await execution.start({});for await(const chunk of stream){}
  if((await execution.inspect()).ExitCode===0)return;
  await new Promise(r=>setTimeout(r,200));
 }
 throw Error('Network guard did not become ready; application has not been released');
}
async function inheritResolver(docker,container){
 const exec=await container.exec({Cmd:['node','-e','process.stdout.write(JSON.stringify(require("dns").getServers()))'],AttachStdout:true});
 const stream=await exec.start({}),output=new(require('stream').PassThrough)();let text='';output.on('data',b=>text+=b);docker.modem.demuxStream(stream,output,new(require('stream').PassThrough)());
 await new Promise((resolve,reject)=>{stream.on('end',resolve);stream.on('error',reject);});
 try{return JSON.parse(text).find(ip=>require('net').isIP(ip)===4&&!ip.startsWith('127.'))||'1.1.1.1';}catch{return '1.1.1.1';}
}
async function createWorker({docker,id,agent,root,auth,image=defaults.workerImage,suffix,resources=[],clientUID=1000,toolOrigins=[],resolver}){
 if(!/^[a-z0-9_-]{1,80}$/i.test(agent))throw Error('Invalid Agent ID');
 const managerOwner=fs.statSync(root);if(managerOwner.uid===65532)throw Error('Manager and sandbox identities must differ');
 const keys=path.join(root,'manager','security','keys',agent),client=path.join(auth,'sandbox',agent);
 fs.mkdirSync(keys,{recursive:true,mode:0o700});
 if(process.getuid?.()===0)for(const folder of [path.join(root,'manager'),path.join(root,'manager','security'),path.join(root,'manager','security','keys'),keys])fs.chownSync(folder,managerOwner.uid,managerOwner.gid);fs.mkdirSync(client,{recursive:true,mode:0o700});
 if(process.getuid?.()===0){fs.chownSync(path.join(auth,'sandbox'),clientUID,clientUID);fs.chownSync(client,clientUID,clientUID);}
 const volume='openclaw-agent-'+crypto.createHash('sha256').update(root+':'+agent).digest('hex').slice(0,24);
 await docker.createVolume({Name:volume,Labels:{'openclaw.security.instance':id,'openclaw.security.agent':agent}});
 const owner=managerOwner.uid;
 const init=await docker.createContainer({Image:image,User:'0:0',Entrypoint:['sh','-c'],Cmd:['set -eu; test -f /keys/client || ssh-keygen -q -t ed25519 -N "" -f /keys/client; test -f /keys/server || ssh-keygen -q -t ed25519 -N "" -f /keys/server; chown "$KEY_OWNER" /keys/client /keys/server; chown 65532:65532 /workspaces; chmod 700 /workspaces'],Env:['KEY_OWNER='+owner],HostConfig:{NetworkMode:'none',Binds:[bind(keys)+':/keys',volume+':/workspaces:nocopy'],CapDrop:['ALL'],CapAdd:['CHOWN','DAC_OVERRIDE','FOWNER'],SecurityOpt:['no-new-privileges:true'],PidsLimit:64}});
 try{await init.start();await output(init);}finally{await init.remove({force:true});}
 fs.copyFileSync(path.join(keys,'client'),path.join(client,'client'));fs.chmodSync(path.join(client,'client'),0o600);if(process.getuid?.()===0)fs.chownSync(path.join(client,'client'),clientUID,clientUID);
 const worker=await docker.createContainer({name:'openclaw-agent-'+id+'-'+agent+'-'+suffix,Image:image,User:'0:0',Cmd:['sh','-c','mkdir -p /run/sshd; exec /usr/sbin/sshd -D -e'],Env:['HOME=/home/node'],Labels:{'openclaw.security.instance':id,'openclaw.security.agent':agent,'openclaw.security.scope':profile.stamp(path.resolve(root).replace(/\\/g,'/')),'openclaw.security.helper':'worker'},HostConfig:{RestartPolicy:{Name:'unless-stopped'},NetworkMode:'bridge',ReadonlyRootfs:true,Dns:['127.0.0.53'],Binds:[bind(path.join(keys,'server'))+':/keys/server:ro',bind(path.join(keys,'client.pub'))+':/keys/client.pub:ro',volume+':/workspaces:nocopy'],Tmpfs:{'/tmp':'rw,nosuid,nodev,size=64m','/run':'rw,nosuid,nodev,size=4m'},CapDrop:['ALL'],CapAdd:['SETUID','SETGID','SYS_CHROOT','DAC_READ_SEARCH'],SecurityOpt:['no-new-privileges:true'],PidsLimit:256,Memory:512*1024**2,NanoCpus:1e9,LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'2'}}}});
 resources.push(worker);await worker.start();
 const firewall=await guard(docker,worker,{origins:toolOrigins,resolver},image,'openclaw-guard-'+id+'-'+agent+'-'+suffix);resources.push(firewall);
 await waitReady(docker,worker);
 const inspect=await worker.inspect(),ip=inspect.NetworkSettings.Networks.bridge.IPAddress;
 const publicKey=fs.readFileSync(path.join(keys,'server.pub'),'utf8').trim().split(/\s+/).slice(0,2).join(' ');
 const hostFile=path.join(client,'known_hosts'),line='['+ip+']:2222 '+publicKey;
 const lines=fs.existsSync(hostFile)?fs.readFileSync(hostFile,'utf8').trim().split('\n'):[];
 if(!lines.includes(line))lines.push(line);fs.writeFileSync(hostFile,lines.join('\n')+'\n',{mode:0o600});if(process.getuid?.()===0)fs.chownSync(hostFile,clientUID,clientUID);
 return {ip,workerId:worker.id,guardId:firewall.id,guardName:'openclaw-guard-'+id+'-'+agent+'-'+suffix,origins:toolOrigins,volume};
}
async function applyInstance({docker,store,instance,image=defaults.runtimeImage,workerImage=defaults.workerImage,extraOrigins=[],privateOrigins=[],toolOrigins=[],resolver,addAgent,skipHealth=false}){
 const original=store.readOpenclawConfig(instance.id),config=JSON.parse(original),record=structuredClone(instance),old=instance.containerId?await docker.getContainer(instance.containerId).inspect():null;
 if(!old||!old.State.Running)throw Error('请先启动目标实例再迁移；原有停止状态未改动');
 if((old.Config.Env||[]).some(value=>/^(?:https?_proxy|all_proxy)=.+/i.test(value)))throw Error('检测到显式 HTTP/HTTPS/ALL_PROXY；当前安全模式需要直接访问批准来源，旧网关未改动');
 resolver=resolver||record.security?.resolver||old.HostConfig.Dns?.find(ip=>require('net').isIP(ip)===4&&!ip.startsWith('127.'))||await inheritResolver(docker,docker.getContainer(old.Id));
 if(require('net').isIP(resolver)!==4||resolver.startsWith('127.')||resolver==='0.0.0.0')throw Error('请选择可达的非回环 IPv4 DNS 解析器');
 const policy=require('../src/container-policy');policy.hostConfig(old.HostConfig);policy.user(old.Config.User||'node');
 const expected=policy.mounts({instanceId:instance.id,configDir:store.configDir(instance.id),workspaceDir:store.workspaceDir(instance.id),authDir:store.authDir(instance.id)},store,bind);
 if(JSON.stringify((old.HostConfig.Binds||[]).map(v=>v.replace(/:rw$/,'')).sort())!==JSON.stringify(expected.sort()))throw Error('Unexpected legacy mounts; review them before migration');
 const runtime=await docker.getImage(image).inspect();if(runtime.Config.Labels?.['openclaw.security.runtime']!=='ssh-sandbox-v1')throw Error('Build the secure runtime image first');
 const clientUID=/^[0-9]+/.test(old.Config.User||'')?Number(old.Config.User.split(':')[0]):1000;
 const root=store.instanceDir(instance.id),auth=store.authDir(instance.id),suffix=String(Date.now()),resources=[],targets={};let gateway,renamed=false,committed=false;
 const owner=fs.statSync(root);if(owner.uid!==0&&owner.uid!==clientUID)throw Error('Manager 数据目录与网关 UID 不一致，请先统一实例用户与数据权限，旧网关未改动');
 const entries=require('../src/management').agents(config);
 if(addAgent){if(entries.some(a=>a.id===addAgent))throw Error('Agent already exists');entries.push({id:addAgent,workspace:'/home/node/.openclaw/workspaces/'+addAgent});}
 config.agents||={};if(config.agents.entries)config.agents.entries=Object.fromEntries(entries.map(({id,...row})=>[id,row]));else config.agents.list=entries;
 profile.apply(config,Object.fromEntries(entries.map(agent=>[agent.id,{ip:'127.0.0.1'}])));
 const rules=profile.origins(config,extraOrigins).map(origin=>({origin,allowPrivate:privateOrigins.includes(origin)}));
 require('./network-guard.cjs').origins(rules);
 try{
  const probe=await docker.createContainer({Image:runtime.Id,User:String(clientUID)+':'+clientUID,Entrypoint:['node'],Cmd:['-e',"const fs=require('fs'),p='/probe/.sandbox-fs-check-'+process.pid;let fd;try{fd=fs.openSync(p,'wx');fs.unlinkSync(p);fs.fstatSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(p);}catch{}}"],HostConfig:{NetworkMode:'none',Binds:[bind(store.configDir(instance.id))+':/probe'],CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true']}});
  try{await probe.start();try{await output(probe);}catch{throw Error('实例文件系统不支持沙箱所需的 POSIX 文件身份检查；请先迁移到 Linux/WSL 数据目录。旧网关未停止。');}}finally{await probe.remove({force:true});}
  for(const agent of entries)targets[agent.id]=await createWorker({docker,id:instance.id,agent:agent.id,root,auth,image:workerImage,suffix,resources,clientUID,toolOrigins,resolver});
  const candidate=JSON.stringify(profile.apply(config,targets),null,2)+'\n';
  // Validate the SSH backend against the installed runtime before touching a running gateway.
  const candidateFile=path.join(root,'manager','security','candidate.json');store.atomicWrite(candidateFile,candidate);if(process.getuid?.()===0)fs.chownSync(candidateFile,clientUID,clientUID);
  const validation=await docker.createContainer({Image:runtime.Id,User:String(clientUID)+':'+clientUID,Entrypoint:['openclaw'],Cmd:['config','validate','--json'],Env:['OPENCLAW_CONFIG_PATH=/candidate.json'],HostConfig:{NetworkMode:'none',Binds:[bind(candidateFile)+':/candidate.json:ro'],CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true']}});
  try{await validation.start();await output(validation);}finally{await validation.remove({force:true});fs.unlinkSync(candidateFile);}
  if(store.readOpenclawConfig(instance.id)!==original)throw Error('Configuration changed during preparation; retry');
  store.atomicWrite(path.join(root,'manager','security','before.json'),original);
  await docker.getContainer(old.Id).stop().catch(e=>{if(e.statusCode!==304)throw e;});
  if(record.security?.profile==='ssh-sandbox-v1')for(const oldTarget of Object.values(record.security.targets))await docker.getContainer(oldTarget.workerId).stop({t:5}).catch(e=>{if(e.statusCode!==304&&e.statusCode!==404)throw e;});
  await docker.getContainer(old.Id).rename({name:instance.containerName+'-rollback-'+suffix});renamed=true;
  // Write directly: the old managed profile is replaced transactionally with new worker targets.
  store.atomicWrite(path.join(store.configDir(instance.id),'openclaw.json'),candidate);
  const h=old.HostConfig;
  require('../src/container-policy').hostConfig(h);
  gateway=await docker.createContainer({name:instance.containerName,Image:runtime.Id,User:String(clientUID)+':'+clientUID,Env:[...(old.Config.Env||[]).filter(v=>!/^XDG_CACHE_HOME=|^NPM_CONFIG_CACHE=/.test(v)),'XDG_CACHE_HOME=/home/node/.openclaw/.cache','NPM_CONFIG_CACHE=/home/node/.openclaw/.npm'],Labels:{...old.Config.Labels,'openclaw.security.profile':'ssh-sandbox-v1','openclaw.security.scope':profile.stamp(path.resolve(root).replace(/\\/g,'/'))},Cmd:['openclaw','gateway','--allow-unconfigured'],ExposedPorts:old.Config.ExposedPorts,HostConfig:{Binds:h.Binds,NetworkMode:'bridge',PortBindings:h.PortBindings,RestartPolicy:h.RestartPolicy,Memory:h.Memory,MemorySwap:h.MemorySwap,NanoCpus:h.NanoCpus,PidsLimit:h.PidsLimit||512,Dns:['127.0.0.53'],ReadonlyRootfs:true,Tmpfs:{'/tmp':'rw,nosuid,nodev,size=64m'},CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],LogConfig:h.LogConfig}});
  resources.push(gateway);await gateway.start();
  const firewall=await guard(docker,gateway,{origins:rules,resolver,internalTCP:[...Object.values(targets).map(t=>({ip:t.ip,port:2222})),...require('./plugin-provision.cjs').internalTCP(record)]},workerImage,'openclaw-guard-'+instance.id+'-gateway-'+suffix);resources.push(firewall);
  await waitReady(docker,gateway);
  if(!skipHealth){
   const ready=await require('../src/lifecycle').ready(instance.port);if(!ready)throw Error('Secure gateway failed its readiness check');
  }
  instance.containerId=gateway.id;instance.image=image;instance.rollbackContainerId=old.Id;const previous=structuredClone(record);if(previous.security)delete previous.security.previous;
  instance.security={previous,resolver,profile:'ssh-sandbox-v1',targets,gatewayGuardId:firewall.id,gatewayGuardName:'openclaw-guard-'+instance.id+'-gateway-'+suffix,workerImageId:(await docker.getImage(workerImage).inspect()).Id,runtimeId:runtime.Id,origins:rules};
  store.saveInstance(instance);committed=true;
  // Retain one stopped generation for rollback; stop old commands before reusing workspace volumes.
  if(record.security?.profile==='ssh-sandbox-v1'){
   for(const oldTarget of Object.values(record.security.targets)){
    await docker.getContainer(oldTarget.workerId).stop({t:5}).catch(()=>{});
    await docker.getContainer(oldTarget.guardName).stop({t:5}).catch(()=>{});
   }
   await docker.getContainer(record.security.gatewayGuardName).stop({t:5}).catch(()=>{});
  }
  return instance.security;
 }catch(error){
  if(gateway){try{error.detail=(error.detail||'')+(await gateway.logs({stdout:true,stderr:true,tail:30})).toString();}catch{}}
  for(const resource of resources.reverse())await resource.remove({force:true}).catch(()=>{});
  if(renamed){store.atomicWrite(path.join(store.configDir(instance.id),'openclaw.json'),original);await docker.getContainer(old.Id).rename({name:record.containerName});if(old.State.Running)await docker.getContainer(old.Id).start();}
  store.saveInstance(record);if(record.security?.profile==='ssh-sandbox-v1'&&renamed)await require('./lifecycle.cjs').create({docker,root:store.DATA_ROOT}).reconcile(record);throw error;
 }finally{if(committed){/* Old gateway is retained stopped for data/configuration rollback. */}}
}
async function rollback({docker,store,instance}){
 if(instance.channelIsolation)throw Error('独立渠道不能自动回滚到含原生插件/凭据的旧网关；请先显式处理渠道隔离');
 if(Object.keys(instance.pluginIsolation?.targets||{}).length)throw Error('请先使用 isolate-plugin.cjs 移除独立插件，再回滚 Agent 安全配置');
 const current=structuredClone(instance),previous=instance.security?.previous;if(!previous)throw Error('No managed rollback generation');
 const root=store.instanceDir(instance.id),before=fs.readFileSync(path.join(root,'manager','security','before.json'),'utf8'),live=store.readOpenclawConfig(instance.id);
 const gateway=docker.getContainer(instance.containerId),old=docker.getContainer(previous.containerId),oldName=(await old.inspect()).Name.replace(/^\//,'');
 const scope=profile.stamp(path.resolve(root).replace(/\\/g,'/'));
 if((await gateway.inspect()).Config.Labels?.['openclaw.security.scope']!==scope)throw Error('Gateway ownership mismatch');
 const archiveDir=path.join(root,'manager','security','rollback-workspaces-'+Date.now());fs.mkdirSync(archiveDir,{recursive:true,mode:0o700});
 for(const agent of Object.keys(instance.security.targets)){
  const source=await require('./workspace-backup.cjs').archive(docker,instance,agent,store.DATA_ROOT);
  await require('stream/promises').pipeline(source,fs.createWriteStream(path.join(archiveDir,agent+'.tar'),{flags:'wx',mode:0o600}));
 }
 let renamed=false;
 try{
  await gateway.stop({t:20}).catch(e=>{if(e.statusCode!==304)throw e;});
  await gateway.rename({name:instance.containerName+'-rollback-'+Date.now()});renamed=true;
  await old.rename({name:instance.containerName});
  store.atomicWrite(path.join(store.configDir(instance.id),'openclaw.json'),before);store.saveInstance(previous);
  if(previous.security?.profile==='ssh-sandbox-v1')await require('./lifecycle.cjs').create({docker,root:store.DATA_ROOT}).reconcile(previous);else await old.start();
  for(const target of Object.values(current.security.targets)){
   await docker.getContainer(target.workerId).stop({t:5}).catch(()=>{});await docker.getContainer(target.guardName).stop({t:5}).catch(()=>{});
  }
  await docker.getContainer(current.security.gatewayGuardName).stop({t:5}).catch(()=>{});
  return previous;
 }catch(error){
  if(renamed){await old.stop({t:5}).catch(()=>{});await old.rename({name:oldName});await gateway.rename({name:current.containerName});}
  store.atomicWrite(path.join(store.configDir(instance.id),'openclaw.json'),live);store.saveInstance(current);
  await require('./lifecycle.cjs').create({docker,root:store.DATA_ROOT}).reconcile(current);throw error;
 }
}
async function withLock(args,operation){
 const root=args.store.instanceDir(args.instance.id),owner=fs.statSync(root);
 let folder=root;for(const name of ['manager','security']){folder=path.join(folder,name);fs.mkdirSync(folder,{recursive:true,mode:0o700});if(process.getuid?.()===0)fs.chownSync(folder,owner.uid,owner.gid);}
 const file=path.join(folder,'migration.lock');let fd;
 try{fd=fs.openSync(file,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('已有安全迁移/回滚锁，请确认前一操作已结束后再处理');throw error;}
 try{if(process.getuid?.()===0)fs.fchownSync(fd,owner.uid,owner.gid);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));fs.closeSync(fd);fd=undefined;return await operation(args);}
 finally{if(fd!==undefined)fs.closeSync(fd);fs.unlinkSync(file);}
}
module.exports={defaults,guard,waitReady,createWorker,withLock,applyInstance:args=>withLock(args,applyInstance),rollback:args=>withLock(args,rollback)};
