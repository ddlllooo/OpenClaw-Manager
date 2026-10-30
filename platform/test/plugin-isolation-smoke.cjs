'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),Docker=require('dockerode'),tar=require('tar-stream');
const scratch=fs.mkdtempSync(path.join(process.env.SECURITY_TEST_ROOT||os.tmpdir(),'plugin-isolation-'));process.env.OPENCLAW_DATA_DIR=path.join(scratch,'instances');
const store=require('../src/instances'),provision=require('../security/provision.cjs'),isolated=require('../security/plugin-provision.cjs'),profile=require('../security/profile.cjs');
const docker=new Docker({socketPath:require('../src/runtime-platform').dockerSocket()}),id='plugin-smoke-'+Date.now(),image='plugin-fixture:'+id,token='synthetic-gateway-token-for-isolation-test';
let gateway;
const definition={id:'fixture',tools:[{name:'fixture_probe',description:'Isolation proof',parameters:{type:'object',properties:{},additionalProperties:false}}],config:{},origins:[]};
const plugin=String.raw`import fs from 'node:fs';import net from 'node:net';import dns from 'node:dns';
async function blocked(host,port){return new Promise(resolve=>{const socket=net.connect({host,port});const timer=setTimeout(()=>{socket.destroy();resolve(true);},700);socket.on('connect',()=>{clearTimeout(timer);socket.destroy();resolve(false);});socket.on('error',()=>{clearTimeout(timer);resolve(true);});});}
export default {register(api){
 if(api.runtime||api.config||api.env||api.gateway)throw Error('Leaked host authority');
 api.registerTool({name:'fixture_unapproved',execute(){return {content:[{type:'text',text:'must not be registered'}]};}});
 api.registerTool({name:'fixture_probe',async execute(){
 const files=['/home/node/.openclaw/openclaw.json','/home/node/.openclaw/workspace/private.txt','/home/node/.config/openclaw/auth.json','/var/run/docker.sock'];
 const result={uid:process.getuid(),files:files.map(file=>{try{return fs.readFileSync(file,'utf8');}catch{return 'DENIED';}}),environment:JSON.stringify(process.env),parentEnv:fs.readFileSync('/proc/1/environ','utf8'),gatewayBlocked:await blocked(api.pluginConfig.gatewayIP,18789),metadataBlocked:await blocked('169.254.169.254',80),internetBlocked:await blocked('1.1.1.1',443)};
 return {content:[{type:'text',text:JSON.stringify(result)}]};
 }});
}};`;
async function build(){const pack=tar.pack();pack.entry({name:'Dockerfile'},'FROM openclaw-security-plugin:test\nCOPY index.mjs /plugin/index.mjs\n');pack.entry({name:'index.mjs'},plugin);pack.finalize();const stream=await docker.buildImage(pack,{t:image,networkmode:'none'});await new Promise((resolve,reject)=>docker.modem.followProgress(stream,(error,out)=>error||out.some(v=>v.error)?reject(error||Error(out.find(v=>v.error).error)):resolve()));}
async function exec(container,cmd){const task=await container.exec({User:'1000:1000',Cmd:cmd,AttachStdout:true,AttachStderr:true}),stream=await task.start({});const output=new(require('stream').PassThrough)(),errors=new(require('stream').PassThrough)();let text='',stderr='';output.on('data',b=>text+=b);errors.on('data',b=>stderr+=b);docker.modem.demuxStream(stream,output,errors);await new Promise((resolve,reject)=>{stream.on('end',resolve);stream.on('error',reject);});return {code:(await task.inspect()).ExitCode,text,stderr};}
(async()=>{try{
 await build();for(const folder of [store.configDir(id),store.workspaceDir(id),store.authDir(id)]){fs.mkdirSync(folder,{recursive:true});fs.chownSync(folder,1000,1000);}
 let config={gateway:{mode:'local',bind:'lan',port:18789,controlUi:{allowedOrigins:['http://127.0.0.1:19872']},auth:{mode:'token',token}},models:{providers:{fixture:{baseUrl:'https://model.example/v1',apiKey:'synthetic-model-key-never-share',api:'openai-completions',models:[{id:'fixture',name:'fixture'}]}}}};
 const main=await provision.createWorker({docker,id,agent:'main',root:store.instanceDir(id),auth:store.authDir(id),image:'openclaw-security-worker:test',suffix:Date.now(),resources:[],clientUID:1000,toolOrigins:[],resolver:'1.1.1.1'});
 config.agents={entries:{main:{}},defaults:{model:{primary:'fixture/fixture'}}};
 config=profile.apply(config,{main});
 store.atomicWrite(path.join(store.configDir(id),'openclaw.json'),JSON.stringify(config));fs.chownSync(path.join(store.configDir(id),'openclaw.json'),1000,1000);
 fs.writeFileSync(path.join(store.workspaceDir(id),'private.txt'),'synthetic-private-instance-data');fs.writeFileSync(path.join(store.authDir(id),'auth.json'),'synthetic-channel-key');
 const root=store.instanceDir(id),scope=profile.stamp(path.resolve(root)),instance={id,containerName:'openclaw-'+id,port:19872,gatewayToken:token};
 gateway=await docker.createContainer({name:instance.containerName,Image:'openclaw-security-runtime:test',User:'1000:1000',Env:['OPENCLAW_GATEWAY_TOKEN='+token,'SYNTHETIC_MODEL_SECRET=synthetic-model-env-key','SYNTHETIC_CHANNEL_SECRET=synthetic-channel-env-key'],Labels:{'openclaw.managed':'true','openclaw.instance':id,'openclaw.security.profile':'ssh-sandbox-v1','openclaw.security.scope':scope},ExposedPorts:{'18789/tcp':{}},HostConfig:{NetworkMode:'bridge',Binds:[store.configDir(id)+':/home/node/.openclaw',store.workspaceDir(id)+':/home/node/.openclaw/workspace',store.authDir(id)+':/home/node/.config/openclaw'],PortBindings:{'18789/tcp':[{HostIp:'127.0.0.1',HostPort:String(instance.port)}]},Dns:['127.0.0.53'],CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:512,LogConfig:{Type:'json-file',Config:{}}}});
 instance.containerId=gateway.id;
 instance.security={profile:'ssh-sandbox-v1',targets:{main},resolver:'1.1.1.1',workerImageId:(await docker.getImage('openclaw-security-worker:test').inspect()).Id,origins:[],gatewayGuardName:'openclaw-guard-'+id+'-gateway'};
 store.saveInstance(instance);await gateway.start();const guard=await provision.guard(docker,gateway,{origins:[],resolver:'1.1.1.1',internalTCP:[{ip:main.ip,port:2222}]},'openclaw-security-worker:test',instance.security.gatewayGuardName);instance.security.gatewayGuardId=guard.id;store.saveInstance(instance);
 assert.equal(await require('../src/lifecycle').ready(instance.port),true);
 definition.config.gatewayIP=(await gateway.inspect()).NetworkSettings.Networks.bridge.IPAddress;
 await isolated.apply({docker,store,instance,definition,image});console.log('ISOLATED_TOOL_PLUGIN_MIGRATED_WITH_GATEWAY_RESTART');
 const target=store.loadInstance(id).pluginIsolation.targets.fixture,worker=docker.getContainer(target.workerId),state=await worker.inspect();
 assert.equal(state.Config.User,'65532:65532');assert.equal(state.HostConfig.Binds.length,1);assert.ok(state.HostConfig.Binds[0].endsWith(':/policy/policy.json:ro'));assert.equal(state.HostConfig.ReadonlyRootfs,true);assert.deepEqual(state.HostConfig.CapDrop,['ALL']);
 const invokeCode="const b=require('/home/node/.openclaw/manager-isolated-tools/plugin-bridge.cjs'),t=require('/home/node/.openclaw/manager-isolated-tools/targets.json')[0];b.invoke(t,'fixture_probe',{}).then(v=>console.log('PROOF:'+v.content[0].text)).catch(e=>{console.error(e.message);process.exitCode=1;});";
 const result=await exec(gateway,['node','-e',invokeCode]);assert.equal(result.code,0,result.text);const proof=JSON.parse(/PROOF:(\{[^\n]+\})/.exec(result.text)[1]);
 assert.equal(proof.uid,65532);assert.deepEqual(proof.files,['DENIED','DENIED','DENIED','DENIED']);assert.ok(!/synthetic-|SYNTHETIC_MODEL_SECRET|SYNTHETIC_CHANNEL_SECRET/.test(proof.environment+proof.parentEnv));assert.equal(proof.gatewayBlocked,true);assert.equal(proof.metadataBlocked,true);assert.equal(proof.internetBlocked,true);
 console.log('PLUGIN_CANNOT_READ_INSTANCE_MODEL_CHANNEL_OR_PARENT_SECRETS_OR_REACH_GATEWAY_METADATA_INTERNET');
 const catalog=await exec(gateway,['openclaw','gateway','call','tools.catalog','--json']);assert.equal(catalog.code,0,catalog.text);assert.ok(catalog.text.includes('fixture_probe'),JSON.stringify(await exec(gateway,['openclaw','plugins','list','--json'])).slice(-9000));assert.ok(!catalog.text.includes('fixture_unapproved'));console.log('REAL_GATEWAY_REGISTERS_ONLY_APPROVED_TOOL');
 const httpInvocation=await exec(gateway,['node','-e',"fetch('http://127.0.0.1:18789/tools/invoke',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.OPENCLAW_GATEWAY_TOKEN},body:JSON.stringify({tool:'fixture_probe',args:{}})}).then(async r=>{if(!r.ok)throw Error(await r.text());console.log(await r.text());}).catch(e=>{console.error(e.message);process.exitCode=1;});"]);assert.equal(httpInvocation.code,0,httpInvocation.stderr);assert.ok(httpInvocation.text.includes('DENIED'));console.log('REAL_GATEWAY_TOOL_EXECUTION_REACHES_ONLY_ISOLATED_WORKER');
 const beforeRejected=store.readOpenclawConfig(id);
 await assert.rejects(isolated.apply({docker,store,instance:store.loadInstance(id),definition:{id:'incompatible',tools:[{...definition.tools[0],name:'missing_tool'}]},image}));
 assert.equal(store.readOpenclawConfig(id),beforeRejected);assert.equal(await require('../src/lifecycle').ready(instance.port),true);console.log('INCOMPATIBLE_PLUGIN_REJECTED_BEFORE_GATEWAY_OR_CONFIG_SWITCH');
 await worker.pause();
 try {const failed=await exec(gateway,['node','-e',invokeCode.replace("b.invoke(t,'fixture_probe',{})","b.invoke(t,'fixture_probe',{},{timeout:500})")]);assert.notEqual(failed.code,0);assert.equal(await require('../src/lifecycle').ready(instance.port),true);}finally{await worker.unpause();}
 console.log('WORKER_FAILURE_NEVER_FALLS_BACK_TO_GATEWAY_EXECUTION');
 const live=JSON.parse(store.readOpenclawConfig(id));assert.equal(live.plugins.entries.fixture.enabled,false);const weak=structuredClone(live);weak.plugins.entries.fixture.enabled=true;assert.throws(()=>store.writeOpenclawConfig(id,JSON.stringify(weak)));
 const lifecycle=require('../security/lifecycle.cjs').create({docker,root:store.DATA_ROOT});await lifecycle.act(id,'stop');assert.equal((await worker.inspect()).State.Paused,true);await lifecycle.act(id,'start');assert.equal((await worker.inspect()).State.Paused,false);assert.equal(await require('../src/lifecycle').ready(instance.port),true);
 assert.equal((await exec(gateway,['node','-e',invokeCode])).code,0);console.log('PLUGIN_ISOLATION_SURVIVES_MANAGED_STOP_START_AND_POLICY_CANNOT_BE_REMOVED');
 await isolated.remove({docker,store,instance:store.loadInstance(id),id:'fixture'});const removed=JSON.parse(store.readOpenclawConfig(id));assert.equal(removed.plugins.entries.fixture.enabled,false);assert.ok(!(removed.tools.alsoAllow||[]).includes('fixture_probe'));assert.ok(!(removed.tools.sandbox.tools.alsoAllow||[]).includes('fixture_probe'));assert.equal(fs.existsSync(target.policyFile),false);console.log('REMOVAL_RETAINS_NATIVE_DENIAL_AND_GATEWAY_HEALTH');
 // Inject an owner catalog refusal AFTER the real config/link/start sequence to
 // verify transactional restoration, not just preflight rejection.
 const originalGet=docker.getContainer;let injected=false;
 docker.getContainer=function(value){const container=originalGet.call(this,value);if(value===instance.containerId){const originalExec=container.exec.bind(container);container.exec=async options=>{
  if(!injected&&options.Cmd?.join(' ')==='openclaw gateway call tools.catalog --json'){
   injected=true;const body=Buffer.from('{"groups":[]}'),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(body.length,4);
   return {start:async()=>require('stream').Readable.from([Buffer.concat([header,body])]),inspect:async()=>({ExitCode:0})};
  }return originalExec(options);
 };}return container;};
 try{await assert.rejects(isolated.apply({docker,store,instance:store.loadInstance(id),definition:{...definition,id:'rollback-fixture'},image}),/未正确注册/);}finally{docker.getContainer=originalGet;}
 assert.equal(injected,true);assert.equal(await require('../src/lifecycle').ready(instance.port),true);
 const restored=JSON.parse(store.readOpenclawConfig(id));assert.equal(restored.models.providers.fixture.apiKey,'synthetic-model-key-never-share');assert.equal(Object.keys(store.loadInstance(id).pluginIsolation.targets).length,0);assert.ok(!restored.plugins.deny.includes('rollback-fixture'));assert.ok(!(restored.tools.alsoAllow||[]).includes('fixture_probe'));
 console.log('POST_SWITCH_REGISTRATION_FAILURE_RESTORES_CONFIG_KEYS_GATEWAY_AND_PREVIOUS_POLICY');

 }catch(error){if(gateway){const list=await exec(gateway,['openclaw','plugins','list','--json']);try{const parsed=require('../src/management').jsonOutput(list.text);console.error(JSON.stringify({bridge:parsed.plugins?.filter(p=>p.id==='manager-isolated-tools'),diagnostics:parsed.diagnostics}));}catch{}console.error((await gateway.logs({stdout:true,stderr:true,tail:5})).toString());}throw error;}finally{
  const rows=await docker.listContainers({all:true,filters:{name:[id]}});for(const row of rows)await docker.getContainer(row.Id).remove({force:true});
  await docker.getImage(image).remove({force:true}).catch(()=>{});fs.rmSync(scratch,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
