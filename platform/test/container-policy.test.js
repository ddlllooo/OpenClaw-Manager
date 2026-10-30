 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'container-policy-'));
process.env.OPENCLAW_DATA_DIR=path.join(scratch,'instances');
const store=require('../src/instances'),policy=require('../src/container-policy'),dm=require('../src/docker');
const opts={instanceId:'fixture',name:'openclaw-fixture',image:'openclaw:test',hostPort:19001,configDir:store.configDir('fixture'),workspaceDir:store.workspaceDir('fixture'),authDir:store.authDir('fixture')};
for(const key of ['configDir','workspaceDir','authDir'])fs.mkdirSync(opts[key],{recursive:true});
test.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
test('root, dangerous inherited privileges, host namespaces and devices are denied',()=>{
 for(const value of ['root','0','0:1000','00:0'])assert.throws(()=>policy.user(value),/root/);
 assert.equal(policy.user('1000:1000'),'1000:1000');
 for(const host of [{Privileged:true},{CapAdd:['SYS_ADMIN']},{Devices:[{}]},{DeviceRequests:[{}]},{Mounts:[{}]},{VolumesFrom:['host']},{PidMode:'host'},{IpcMode:'host'},{NetworkMode:'host'},{NetworkMode:'container:other'}])assert.throws(()=>policy.hostConfig(host),/危险/);
 const host=policy.hostConfig({SecurityOpt:['seccomp=unconfined'],Binds:['/:/host'],ExtraHosts:['host:host-gateway']});
 assert.deepEqual(host.CapDrop,['ALL']);assert.deepEqual(host.SecurityOpt,['no-new-privileges:true']);assert.equal(host.ExtraHosts,undefined);assert.equal(host.Binds,undefined);
});
test('creation accepts only the exact three instance mounts and rejects inherited extra binds',()=>{
 const result=dm.validateInstanceOptions(opts);assert.equal(result.binds.length,3);
 assert.throws(()=>dm.validateInstanceOptions({...opts,configDir:os.homedir()}),/禁止挂载/);
 assert.throws(()=>dm.validateInstanceOptions({...opts,template:{HostConfig:{Binds:['/var/run/docker.sock:/var/run/docker.sock']}}}),/挂载/);
 assert.throws(()=>dm.validateInstanceOptions({...opts,template:{Config:{User:'root'}}}),/root/);
});
test('unmanaged Docker containers cannot be controlled through the managed API',async()=>{
 const original=dm.docker.getContainer;let started=false;
 dm.docker.getContainer=()=>({inspect:async()=>({Config:{Labels:{}}}),start:async()=>{started=true;}});
 try {await assert.rejects(dm.startContainer('foreign'),/不属于/);assert.equal(started,false);}finally{dm.docker.getContainer=original;}
});
test('new container receives forced isolation and ignores hostile template security profiles',async()=>{
 const image=dm.docker.getImage,create=dm.docker.createContainer;let submitted;
 dm.docker.getImage=()=>({inspect:async()=>({Id:'sha256:fixture',Config:{},RepoTags:['openclaw:test']})});
 dm.docker.createContainer=async config=>{submitted=config;return {id:'synthetic'};};
 try {
  assert.equal(await dm.createInstanceContainer({...opts,template:{HostConfig:{SecurityOpt:['seccomp=unconfined']}}}),'synthetic');
  assert.deepEqual(submitted.HostConfig.CapDrop,['ALL']);assert.deepEqual(submitted.HostConfig.SecurityOpt,['no-new-privileges:true']);
  assert.equal(submitted.HostConfig.PidsLimit,512);assert.equal(submitted.User,'node');assert.equal(submitted.HostConfig.PortBindings['18789/tcp'][0].HostIp,'127.0.0.1');
 }finally{dm.docker.getImage=image;dm.docker.createContainer=create;}
});
test('offline network validates ownership and internal routing without fail-open fallback',async()=>{
 const get=dm.docker.getNetwork,create=dm.docker.createNetwork;process.env.OPENCLAW_INSTANCE_EGRESS='offline';let network,created;
 dm.docker.getNetwork=()=>({inspect:async()=>{if(!network)throw {statusCode:404};return network;}});
 dm.docker.createNetwork=async spec=>{created=spec;network=spec;};
 try {
  assert.equal(await dm.instanceNetwork('fixture'),'openclaw-isolated-fixture');assert.equal(created.Internal,true);
  assert.equal(created.Options['com.docker.network.bridge.enable_icc'],'false');
  network={...network,Internal:false};await assert.rejects(dm.instanceNetwork('fixture'),/隔离网络/);
 }finally{delete process.env.OPENCLAW_INSTANCE_EGRESS;dm.docker.getNetwork=get;dm.docker.createNetwork=create;}
});
test('restricted Agent policy blocks commands, privilege escape and off-workspace file access while compatible preserves settings',()=>{
 const config={tools:{deny:['custom'],fs:{custom:'keep'}},agents:{defaults:{model:'keep'}}};
 assert.deepEqual(policy.agentConfig(structuredClone(config),'compatible'),config);
 const restricted=policy.agentConfig(structuredClone(config),'restricted');
 assert.equal(restricted.tools.fs.workspaceOnly,true);assert.equal(restricted.tools.elevated.enabled,false);assert.ok(restricted.tools.deny.includes('group:runtime'));assert.ok(restricted.tools.deny.includes('custom'));
 process.env.OPENCLAW_AGENT_POLICY='restricted';
 try {
  policy.assertAgentConfig(restricted);assert.throws(()=>policy.assertAgentConfig(config),/受限/);
  store.writeOpenclawConfig('fixture',JSON.stringify(restricted));
  assert.throws(()=>store.writeOpenclawConfig('fixture',JSON.stringify(config)),/受限/);
  assert.throws(()=>store.mergeOpenclawConfig('fixture',{tools:{}}),/受限/);
 }finally{delete process.env.OPENCLAW_AGENT_POLICY;}
});

test('unsafe replacement fails before stopping or renaming the working container',async()=>{
 const vm=require('vm'),events=[];
 const fake={inspectContainer:async()=>({Id:'old',Image:'image',State:{Running:true},Config:{User:'node'},HostConfig:{Privileged:true}}),
  getContainer:()=>({rename:async()=>events.push('rename')}),stopContainer:async()=>events.push('stop'),validateInstanceOptions:dm.validateInstanceOptions};
 const module={exports:{}};
 const source=fs.readFileSync(path.join(__dirname,'../src/lifecycle.js'),'utf8');
 vm.runInNewContext(source,{module,exports:module.exports,require:name=>name==='./run-intent'?{track:(_i,_r,fn)=>fn()}:name==='./storage'?{assertCanStart:async()=>{}}:name==='./docker'?fake:name==='./instances'?store:require(name),setTimeout,Date,console});
 await assert.rejects(module.exports.replace({id:'fixture',containerId:'old',containerName:'openclaw-fixture',port:19001}),/危险/);
 assert.deepEqual(events,[]);
});
