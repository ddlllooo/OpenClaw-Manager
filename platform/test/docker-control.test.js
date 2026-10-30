 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'docker-controller-'));
fs.mkdirSync(path.join(root,'fixture'));fs.writeFileSync(path.join(root,'fixture','instance.json'),JSON.stringify({containerName:'openclaw-fixture',port:19001}));
const managed={Id:'id',Name:'/openclaw-fixture',Config:{User:'node',Labels:{'openclaw.managed':'true','openclaw.instance':'fixture'}},State:{Running:true},HostConfig:{Binds:['openclaw','workspace','auth'].map((folder,i)=>path.join(root,'fixture',folder).replace(/\\/g,'/')+':'+['/home/node/.openclaw','/home/node/.openclaw/workspace','/home/node/.config/openclaw'][i])}};
const foreign={Id:'foreign',Name:'/database',Config:{Env:['SECRET=never-return'],Labels:{}},State:{Running:true},HostConfig:{Memory:1}};
const server=require('../src/docker-control').createController({root,docker:{getContainer:id=>({inspect:async()=>id==='foreign'?foreign:managed})}});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('controller denies daemon administration, builds, volumes, prune and unknown exec IDs',async()=>{
 for(const [method,url,body]of [['POST','/build',{}],['POST','/volumes/create',{}],['POST','/containers/prune',{}],['POST','/exec/unknown/start',{}],['DELETE','/containers/foreign'],['POST','/containers/id/exec',{Privileged:true,Cmd:['sh']}],['POST','/containers/create',{Image:'image',HostConfig:{Privileged:true}}]])await assert.rejects(server.authorize(method,url,body));
});
test('owned terminal and rollback operations remain available; root exec and foreign reads are restricted',async()=>{
 assert.deepEqual(await server.authorize('POST','/containers/id/start'),{});
 assert.deepEqual(await server.authorize('POST','/containers/id/rename?name=openclaw-fixture-rollback-123'),{});
 await assert.rejects(server.authorize('POST','/containers/id/rename?name=other'));
 const exec=await server.authorize('POST','/containers/id/exec',{Cmd:['sh'],AttachStdin:true});assert.equal(exec.body.User,'1000:1000');assert.equal(exec.rememberExec,true);
 await assert.rejects(server.authorize('POST','/containers/id/exec',{Cmd:['sh'],User:'root'}));
 const read=await server.authorize('GET','/containers/foreign/json');assert.ok(!JSON.stringify(read).includes('never-return'));
});
test('manager Compose mounts only the controller socket and fails closed when controller is unavailable',()=>{
 const compose=fs.readFileSync(path.join(__dirname,'../compose.yaml'),'utf8').split('  docker-control:')[0];
 assert.ok(!compose.includes('target: /var/run/docker.sock'));assert.ok(!compose.includes('DOCKER_SOCKET_HOST'));assert.ok(compose.includes('OPENCLAW_CONTROL_SOCKET'));
});

test('fully formed creates cannot bypass host, root, bind and capability policy',async()=>{
 for(const folder of ['openclaw','workspace','auth'])fs.mkdirSync(path.join(root,'fixture',folder));
 const body={Image:'image',User:'node',Labels:managed.Config.Labels,HostConfig:{Binds:managed.HostConfig.Binds,NetworkMode:'bridge',CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:64,LogConfig:{Type:'json-file',Config:{}},PortBindings:{'18789/tcp':[{HostIp:'127.0.0.1',HostPort:'19001'}]}}};
 await server.authorize('POST','/containers/create?name=openclaw-fixture',structuredClone(body));
 for(const patch of [{Privileged:true},{CapAdd:['SYS_ADMIN']},{NetworkMode:'host'},{Mounts:[{Source:'/'}]},{Binds:['/:/host']},{SecurityOpt:['seccomp=unconfined']}]){
  const candidate=structuredClone(body);Object.assign(candidate.HostConfig,patch);await assert.rejects(server.authorize('POST','/containers/create?name=openclaw-fixture',candidate));
 }
 await assert.rejects(server.authorize('POST','/containers/create?name=openclaw-fixture',{...body,User:'root'}));
});
