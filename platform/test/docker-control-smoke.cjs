 'use strict';
// Real two-container boundary: only the controller receives the raw daemon socket.
const Docker=require('dockerode'),path=require('path'),assert=require('assert/strict');
const engine=new Docker({socketPath:require('../src/runtime-platform').dockerSocket()}),tag='control-smoke-'+Date.now();
const data=tag+'-data',sockets=tag+'-sockets';let worker,client;
const source=path.resolve(__dirname,'..').replace(/\\/g,'/');
(async()=>{
 try{
  await engine.createVolume({Name:data});await engine.createVolume({Name:sockets});
  const root=(await engine.getVolume(data).inspect()).Mountpoint,instances=root+'/instances';
  worker=await engine.createContainer({Image:'node:24.22.1-alpine',name:tag+'-worker',WorkingDir:'/app',Cmd:['node','scripts/docker-control.cjs'],Env:['OPENCLAW_DATA_DIR='+instances,'OPENCLAW_CONTROL_SOCKET_MODE=666'],HostConfig:{NetworkMode:'none',Binds:[source+':/app:ro','/var/run/docker.sock:/var/run/docker.sock',data+':'+root+':ro',sockets+':/run/openclaw-docker'],ReadonlyRootfs:true,CapDrop:['ALL'],CapAdd:['DAC_OVERRIDE'],SecurityOpt:['no-new-privileges:true']}});
  await worker.start();
  const script=String.raw`
const Docker=require('dockerode'),fs=require('fs'),assert=require('assert/strict');
(async()=>{
 assert.equal(fs.existsSync('/var/run/docker.sock'),false);console.log('MANAGER_HAS_NO_RAW_SOCKET');
 const docker=new Docker({socketPath:'/run/openclaw-docker/control.sock'});
 for(let i=0;;i++){try{await docker.ping();break;}catch(e){if(i>30)throw e;await new Promise(r=>setTimeout(r,100));}}
 const root=process.env.OPENCLAW_DATA_DIR,id=process.env.FIXTURE_ID,name='openclaw-'+id;
 const base=root+'/'+id;for(const part of ['openclaw','workspace','auth'])fs.mkdirSync(base+'/'+part,{recursive:true});fs.writeFileSync(base+'/instance.json',JSON.stringify({id,containerName:name,port:19875}));
 await assert.rejects(docker.createContainer({Image:'node:24.22.1-alpine',HostConfig:{Privileged:true}}));
 let container;
 try {
  container=await docker.createContainer({name,Image:'node:24.22.1-alpine',User:'node',Labels:{'openclaw.managed':'true','openclaw.instance':id},Cmd:['node','-e','setInterval(()=>{},1000)'],HostConfig:{Binds:[base+'/openclaw:/home/node/.openclaw',base+'/workspace:/home/node/.openclaw/workspace',base+'/auth:/home/node/.config/openclaw'],Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],NetworkMode:'bridge',PidsLimit:64,LogConfig:{Type:'json-file',Config:{}},PortBindings:{'18789/tcp':[{HostIp:'127.0.0.1',HostPort:'19875'}]}}});
  await container.start();const exec=await container.exec({Cmd:['node','-e','console.log("EXEC_THROUGH_CONTROL_OK")'],AttachStdout:true,User:'node'});const stream=await exec.start({});let output='';for await(const b of stream)output+=b;assert.ok(output.includes('EXEC_THROUGH_CONTROL_OK'));console.log('EXEC_THROUGH_CONTROL_OK');
  await container.rename({name:name+'-rollback-123'});await container.rename({name});await container.stop();console.log('ROLLBACK_AND_STOP_OK');
 }finally{if(container)await container.remove({force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});`;
  client=await engine.createContainer({Image:'node:24.22.1-alpine',name:tag+'-client',WorkingDir:'/app',Cmd:['node','-e',script],Env:['OPENCLAW_DATA_DIR='+instances,'FIXTURE_ID='+tag],HostConfig:{NetworkMode:'none',Binds:[source+':/app:ro',data+':'+root,sockets+':/run/openclaw-docker:ro'],ReadonlyRootfs:true,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true']}});
  await client.start();const result=await client.wait();const logs=(await client.logs({stdout:true,stderr:true})).toString();console.log(logs.replace(/[\x00-\x08]/g,''));assert.equal(result.StatusCode,0);
 }finally{
  if(client)await client.remove({force:true});if(worker)await worker.remove({force:true});
  for(const container of await engine.listContainers({all:true,filters:{name:['openclaw-'+tag]}}))await engine.getContainer(container.Id).remove({force:true});
  await engine.getVolume(sockets).remove();await engine.getVolume(data).remove();
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
