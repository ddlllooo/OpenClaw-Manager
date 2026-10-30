'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),net=require('net'),policy=require('./feishu-policy.cjs');
const privateIP=ip=>net.isIP(ip)===4&&(/^(10\.|192\.168\.)/.test(ip)||/^172\.(1[6-9]|2\d|3[01])\./.test(ip));
const modelEnv=key=>!/^(FEISHU|LARK)_/i.test(key)&&/(?:API_?KEY|ACCESS_?TOKEN|BEARER|MODEL|OPENAI|ANTHROPIC|GEMINI|OPENROUTER|DEEPSEEK|DASHSCOPE|MISTRAL|COHERE)/i.test(key);
function privateFolder(root,parts){const owner=fs.statSync(root);let current=root;for(const part of parts){current=path.join(current,part);try{if(fs.lstatSync(current).isSymbolicLink())throw Error('Channel state path cannot be a symlink');}catch(error){if(error.code!=='ENOENT')throw error;}fs.mkdirSync(current,{recursive:true,mode:0o700});if(process.getuid?.()===0)fs.chownSync(current,owner.uid,owner.gid);}return current;}
function brokerOrigin(value){const u=new URL(value);if(u.protocol!=='http:'||!privateIP(u.hostname)||!u.port||Number(u.port)<1024||[18080,18789].includes(Number(u.port))||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Broker must be an exact private Docker-host IPv4 HTTP origin on its dedicated port');return u.origin;}
function plan({store,instance,state,definition,broker,channelConfig}){
 if(definition?.mode!=='text-only'||!definition.accounts||Object.keys(definition).some(k=>!['mode','accounts'].includes(k)))throw Error('需要显式 text-only 适配策略；不会静默关闭原生高级功能');
 if(Object.keys(instance.channelIsolation?.accounts||{}).length)throw Error('实例已配置独立飞书，请先移除再重建；访问规则可单独更新');
 const config=JSON.parse(store.readOpenclawConfig(instance.id)),root=channelConfig||config.channels?.feishu;
 if(!root||root.enabled===false)throw Error('实例没有启用的飞书渠道');
 const env={...store.parseEnv(store.readEnvFile(instance.id)),...Object.fromEntries((state.Config.Env||[]).map(v=>[v.slice(0,v.indexOf('=')),v.slice(v.indexOf('=')+1)])),...(config.env?.vars||{})},secretEnvNames=new Set();
 function credential(value){
  let key;if(typeof value==='string')key=/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
  else if(value?.source==='env')key=value.id;else if(value!==undefined)throw Error('只支持字面量或环境变量形式的渠道凭据，不执行 file/exec/store 解析');
  if(key){if(modelEnv(key))throw Error('渠道凭据不能引用模型/API 令牌环境变量');secretEnvNames.add(key);value=env[key];}
  if(typeof value!=='string'||!value||value.length>4096)throw Error('渠道凭据缺失');return value;
 }
 const agents=require('../src/management').agents(config).map(a=>a.id),rows=Object.keys(root.accounts||{}).length?Object.entries(root.accounts):[['default',{}]],accounts={};
 for(const [id,row]of rows){if(row.enabled===false)continue;if(!policy.ACCOUNT.test(id))throw Error('Invalid channel account ID');
  const source={...root,...row},appId=credential(source.appId),appSecret=credential(source.appSecret),domain=source.domain||'feishu',connectionMode=source.connectionMode||'websocket';
  if(!['feishu','lark'].includes(domain)||!['websocket','webhook'].includes(connectionMode))throw Error('自定义域名/传输需要专门审查的适配，不自动放宽');
  const selected=definition.accounts[id];if(!selected)throw Error('每个启用账号都必须有明确的访问和 Agent 策略');
  const selectedAccess=structuredClone(selected);
  if(selectedAccess.routes===undefined){selectedAccess.routes=[];for(const binding of config.bindings||[]){const match=binding.match||{};if(match.channel!=='feishu'||(match.accountId&&match.accountId!=='*'&&match.accountId!==id))continue;if(Object.keys(match).some(k=>!['channel','accountId','peer'].includes(k)))throw Error('高级飞书路由需要在隔离策略 routes 中显式适配');if(match.peer)selectedAccess.routes.push({kind:match.peer.kind==='direct'?'p2p':match.peer.kind,peerId:match.peer.id,agentId:binding.agentId});}}
  const access=policy.access(selectedAccess,agents),wsOrigins=domain==='lark'?['wss://msg-frontier.larksuite.com']:['wss://msg-frontier.feishu.cn'];
  let encryptKey,verificationToken;if(connectionMode==='webhook'){encryptKey=credential(source.encryptKey);verificationToken=credential(source.verificationToken);}
  accounts[id]={access,credentials:{appId,appSecret,domain},connectionMode,wsOrigins,...encryptKey?{encryptKey,verificationToken}:{}};
 }
 if(!Object.keys(accounts).length||Object.keys(definition.accounts).some(id=>!accounts[id]))throw Error('策略账号与启用的飞书账号不匹配');
 if(new Set(Object.values(accounts).map(a=>a.credentials.appId)).size!==Object.keys(accounts).length)throw Error('启用账号不能共享同一飞书应用，避免重复连接和越权路由');
 const modelRefs=new Set(),modelValues=new Set();function models(node){if(typeof node==='string'){const ref=/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(node)?.[1];if(ref)modelRefs.add(ref);else modelValues.add(node);}else if(node&&typeof node==='object'){if(node.source==='env'&&typeof node.id==='string')modelRefs.add(node.id);else for(const value of Object.values(node))models(value);}}models(config.models||{});
 for(const key of modelRefs)if(env[key])modelValues.add(env[key]);
 for(const [key,value]of Object.entries(env))if(modelEnv(key)&&typeof value==='string'&&value.length>=8)modelValues.add(value);
 if([...modelRefs].some(key=>/^(FEISHU|LARK)_/i.test(key)||secretEnvNames.has(key))||Object.values(accounts).some(a=>modelValues.has(a.credentials.appSecret)))throw Error('模型与飞书不能共用凭据或渠道环境变量');
 const constrained=policy.constrainAgents(policy.stripConfig(config,[...secretEnvNames]),accounts);
 return {accounts,broker:brokerOrigin(broker),secretEnvNames:[...secretEnvNames],agentPolicies:constrained.policies,unsupported:['媒体/文档/云盘/Bitable 工具','流式卡片、交互回调和动态建 Agent','原生控制命令和旧会话自动共享','管理/跨会话/命令执行工具（专用 Agent 仅允许沙箱文件读写）'],config:constrained.config};
}
async function command(container,cmd){const task=await container.exec({User:'65532:65532',Cmd:cmd,AttachStdout:true,AttachStderr:true}),stream=await task.start({});for await(const _ of stream){}return (await task.inspect()).ExitCode;}
async function health(worker,activate=false){return command(worker,['node','-e',"const s=JSON.parse(require('fs').readFileSync('/policy/transport.json'));const r=require('http').request({host:'127.0.0.1',port:18791,path:'"+(activate?'/activate':'/health')+"',method:'"+(activate?'POST':'GET')+"',headers:{authorization:'Bearer '+s.token}},r=>{r.resume();r.on('end',()=>process.exit(r.statusCode===200?0:1));});r.on('error',()=>process.exit(1));r.end();setTimeout(()=>process.exit(1),20000);"]);}
async function commandSuppression(container){
 // Inspect the installed runtime's validator without sending a chat, creating a
 // session or making a model call. Unsupported runtimes keep their old channel.
 const source=`(async()=>{const fs=require('fs');for(const name of fs.readdirSync('/app/dist').filter(n=>n.startsWith('src-')&&n.endsWith('.mjs'))){const s=fs.readFileSync('/app/dist/'+name,'utf8'),end=s.slice(s.lastIndexOf('export {'));if(!end.includes('validateChatSendParams'))continue;const alias=/\\bvalidateChatSendParams as ([\\w$]+)/.exec(end)?.[1],m=await import('file:///app/dist/'+name),validate=m.validateChatSendParams||m[alias];if(typeof validate!=='function')continue;const base={sessionKey:'agent:feishu:preflight',message:'preflight',idempotencyKey:'feishu-command-suppression-preflight'};if(!validate({...base,suppressCommandInterpretation:true})||validate({...base,suppressCommandInterpretation:'invalid'}))process.exit(1);return;}process.exit(1);})().catch(()=>process.exit(1));`;
 const task=await container.exec({Cmd:['node','-e',source],AttachStdout:true,AttachStderr:true}),stream=await task.start({});for await(const _ of stream){}
 if((await task.inspect()).ExitCode!==0)throw Error('当前运行时不支持禁止渠道指令解释，保留旧渠道，请先升级兼容运行时');
}
async function apply({docker,store,instance,definition,broker,image,webhookPorts={},channelConfig}){
 if(instance.security?.profile!=='ssh-sandbox-v1')throw Error('请先迁移至带网络守卫的安全实例');
 const record=structuredClone(instance),old=docker.getContainer(record.containerId),state=await old.inspect();if(!state.State.Running)throw Error('请先启动实例');
 await commandSuppression(old);
 const prepared=plan({store,instance,state,definition,broker,channelConfig}),runtime=await docker.getImage(image).inspect();if(runtime.Config.Labels?.['openclaw.security.channel']!=='feishu-text-v1')throw Error('请使用 Dockerfile.feishu 构建专用镜像');
 const before=store.readOpenclawConfig(instance.id),beforeEnv=store.readEnvFile(instance.id),root=store.instanceDir(instance.id),scope=require('./profile.cjs').stamp(path.resolve(root).replace(/\\/g,'/')),suffix=Date.now();
 const resources=[],volumes=[],files=[],accounts={};let gateway,renamed=false,stopped=false,committed=false;
 try{
  for(const [id,a]of Object.entries(prepared.accounts)){
   const folder=privateFolder(root,['manager','security','feishu',String(suffix),id]);
   const accessFile=path.join(folder,'access.json'),credentialsFile=path.join(folder,'credentials.json'),transportFile=path.join(folder,'transport.json'),token=crypto.randomBytes(32).toString('hex');
   store.atomicWrite(accessFile,JSON.stringify(a.access));store.atomicWrite(credentialsFile,JSON.stringify(a.credentials));
   store.atomicWrite(transportFile,JSON.stringify({token,brokerOrigin:prepared.broker,domain:a.credentials.domain,connectionMode:a.connectionMode,...a.encryptKey?{encryptKey:a.encryptKey,verificationToken:a.verificationToken}:{}}));
   files.push(accessFile,credentialsFile,transportFile);fs.chmodSync(transportFile,0o444);
   const port=webhookPorts[id];if(a.connectionMode==='webhook'&&(!Number.isInteger(port)||port<1024||port>65535))throw Error('Webhook 模式必须显式指定独立回调端口并更新反向代理');
   const env=(runtime.Config.Env||[]).map(v=>v.split('=')[0]+'=');env.push('PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp','TMPDIR=/tmp');
   const worker=await docker.createContainer({name:'openclaw-feishu-'+instance.id+'-'+id+'-'+suffix,Image:runtime.Id,User:'65532:65532',Entrypoint:['/usr/local/bin/node','/opt/openclaw-channel/launch.cjs'],Cmd:['/usr/local/bin/node','/opt/openclaw-channel/feishu-worker.cjs'],Env:env,Labels:{'openclaw.security.helper':'channel','openclaw.security.instance':instance.id,'openclaw.security.account':id,'openclaw.security.scope':scope},ExposedPorts:port?{'18791/tcp':{}}:undefined,HostConfig:{NetworkMode:'bridge',Dns:['127.0.0.53'],ReadonlyRootfs:true,Binds:[transportFile.replace(/\\/g,'/')+':/policy/transport.json:ro'],Tmpfs:{'/tmp':'rw,nosuid,nodev,noexec,size=32m','/state':'rw,nosuid,nodev,noexec,size=32m,uid=65532,gid=65532,mode=0700'},CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:64,Memory:256*1024**2,NanoCpus:5e8,RestartPolicy:{Name:'unless-stopped'},LogConfig:{Type:'none'},...(port?{PortBindings:{'18791/tcp':[{HostIp:'127.0.0.1',HostPort:String(port)}]}}:{})}});
   resources.push(worker);const guardName='openclaw-guard-'+instance.id+'-feishu-'+id+'-'+suffix,origins=[{origin:prepared.broker,allowPrivate:true},...a.wsOrigins];
   accounts[id]={token,accessFile,credentialsFile,transportFile,state:'staged',workerId:worker.id,guardName,origins,wsOrigins:a.wsOrigins,imageId:runtime.Id};
   instance.channelIsolation={profile:'feishu-text-v1',accounts,secretEnvNames:prepared.secretEnvNames,agentPolicies:prepared.agentPolicies};store.saveInstance(instance);
   await worker.start();const guard=await require('./provision.cjs').guard(docker,worker,{origins,resolver:record.security.resolver},record.security.workerImageId,guardName);resources.push(guard);await require('./provision.cjs').waitReady(docker,worker);
   let ok=false;for(let i=0;i<40;i++){if(!(await worker.inspect()).State.Running)break;if(await health(worker)===0){ok=true;break;}await new Promise(r=>setTimeout(r,250));}if(!ok)throw Error('飞书账号或独立收发层预检失败，旧渠道未切换');
   accounts[id].ip=(await worker.inspect()).NetworkSettings.Networks.bridge.IPAddress;
  }
  if(store.readOpenclawConfig(instance.id)!==before||store.readEnvFile(instance.id)!==beforeEnv)throw Error('准备期间配置已变化');
  for(const a of Object.values(accounts))a.notBefore=Date.now();
  await old.stop({t:20});stopped=true;await old.rename({name:instance.containerName+'-rollback-'+suffix});renamed=true;
  await require('./plugin-provision.cjs').writeRuntimeConfig(docker,store,instance.id,state,prepared.config);
  const excluded=name=>/^(FEISHU|LARK)_/i.test(name)||prepared.secretEnvNames.includes(name);
  store.atomicWrite(path.join(store.configDir(instance.id),'.env'),beforeEnv.split(/\r?\n/).filter(line=>!excluded(line.trim().split('=')[0])).join('\n'));
  const h=state.HostConfig;require('../src/container-policy').hostConfig(h);
  gateway=await docker.createContainer({name:instance.containerName,Image:state.Image,User:state.Config.User,Entrypoint:state.Config.Entrypoint,Cmd:state.Config.Cmd,Env:(state.Config.Env||[]).map(v=>excluded(v.split('=')[0])?v.split('=')[0]+'=':v),Labels:state.Config.Labels,ExposedPorts:state.Config.ExposedPorts,HostConfig:{Binds:h.Binds,NetworkMode:'bridge',Dns:h.Dns,PortBindings:h.PortBindings,RestartPolicy:h.RestartPolicy,ReadonlyRootfs:h.ReadonlyRootfs,Tmpfs:h.Tmpfs,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:h.PidsLimit,Memory:h.Memory,MemorySwap:h.MemorySwap,NanoCpus:h.NanoCpus,LogConfig:h.LogConfig}});resources.push(gateway);
  instance.containerId=gateway.id;instance.security.gatewayGuardName='openclaw-guard-'+instance.id+'-gateway-feishu-'+suffix;store.saveInstance(instance);
  await require('./lifecycle.cjs').create({docker,root:store.DATA_ROOT}).reconcile(instance,{resumeWorkers:true});
  if(!await require('../src/lifecycle').ready(instance.port))throw Error('独立飞书切换后网关未就绪');
  for(const a of Object.values(accounts))a.state='active';store.saveInstance(instance);
  for(const a of Object.values(accounts))if(await health(docker.getContainer(a.workerId),true)!==0)throw Error('飞书独立连接激活失败');
  committed=true;
  await old.remove({force:true}).catch(()=>{});await docker.getContainer(record.security.gatewayGuardName).remove({force:true}).catch(()=>{});
  return {accounts:Object.keys(accounts),mode:'text-only',credentials:'host broker only; transport has no AppSecret or model credentials'};
 }catch(error){
  if(stopped){if(gateway)await gateway.remove({force:true}).catch(()=>{});await require('./plugin-provision.cjs').writeRuntimeConfig(docker,store,instance.id,state,JSON.parse(before));store.atomicWrite(path.join(store.configDir(instance.id),'.env'),beforeEnv);if(renamed)await old.rename({name:record.containerName});}
  store.saveInstance(record);if(stopped)await require('./lifecycle.cjs').create({docker,root:store.DATA_ROOT}).reconcile(record,{resumeWorkers:true});throw error;
 }finally{if(!committed){for(const r of resources.reverse())await r.remove({force:true}).catch(()=>{});for(const v of volumes)await docker.getVolume(v).remove().catch(()=>{});for(const f of files)try{fs.unlinkSync(f);}catch{}}}
}
async function remove({docker,store,instance}){
 const accounts=instance.channelIsolation?.accounts;if(!accounts||!Object.keys(accounts).length)throw Error('没有独立飞书账号');
 const scope=require('./profile.cjs').stamp(path.resolve(store.instanceDir(instance.id)).replace(/\\/g,'/'));
 for(const [id,a]of Object.entries(accounts)){const state=await docker.getContainer(a.workerId).inspect();if(state.Config.Labels?.['openclaw.security.scope']!==scope||state.Config.Labels?.['openclaw.security.instance']!==instance.id||state.Config.Labels?.['openclaw.security.account']!==id)throw Error('Channel ownership mismatch');}
 instance.channelIsolation={...instance.channelIsolation,accounts:{}};store.saveInstance(instance);
 for(const a of Object.values(accounts)){
  await docker.getContainer(a.workerId).remove({force:true});await docker.getContainer(a.guardName).remove({force:true});
  const base=path.resolve(store.instanceDir(instance.id),'manager','security','feishu')+path.sep;
  for(const file of [a.accessFile,a.credentialsFile,a.transportFile]){if(!path.resolve(file).startsWith(base))throw Error('Channel cleanup scope mismatch');fs.unlinkSync(file);}
 }
 return {removed:Object.keys(accounts),nativeEnabled:false};
}
async function update({store,instance,definition}){
 const accounts=instance.channelIsolation?.accounts;if(definition.mode!=='text-only'||!accounts||Object.keys(accounts).sort().join()!==Object.keys(definition.accounts||{}).sort().join())throw Error('策略账号不匹配');
 const agents=require('../src/management').agents(JSON.parse(store.readOpenclawConfig(instance.id))).map(a=>a.id);
 const next=Object.fromEntries(Object.keys(accounts).map(id=>[id,policy.access(definition.accounts[id],agents)])),before={};
 for(const a of Object.values(next))for(const id of [a.agentId,...(a.routes||[]).map(r=>r.agentId)])if(!instance.channelIsolation.agentPolicies?.[id])throw Error('路由只能指向已经隔离并锁定工具的专用 Agent');
 for(const [id,a]of Object.entries(accounts))before[id]=fs.readFileSync(a.accessFile,'utf8');
 try{for(const [id,a]of Object.entries(accounts))store.atomicWrite(a.accessFile,JSON.stringify(next[id]));}
 catch(error){for(const [id,a]of Object.entries(accounts))store.atomicWrite(a.accessFile,before[id]);throw error;}
 return {updated:Object.keys(accounts)};
}
module.exports={plan,brokerOrigin,health,apply:args=>require('./provision.cjs').withLock(args,apply),remove:args=>require('./provision.cjs').withLock(args,remove),update:args=>require('./provision.cjs').withLock(args,update)};
