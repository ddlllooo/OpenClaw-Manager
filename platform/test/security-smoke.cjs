 'use strict';
// Explicit integration check: creates only a uniquely named disposable instance/network.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-isolation-smoke-'));
process.env.OPENCLAW_DATA_DIR=path.join(scratch,'instances');process.env.OPENCLAW_INSTANCE_EGRESS='offline';
const dm=require('../src/docker'),store=require('../src/instances'),policy=require('../src/container-policy');
const id='security-smoke-'+Date.now(),name='openclaw-'+id,image=process.env.SECURITY_SMOKE_IMAGE||'ghcr.io/openclaw/openclaw:2026.9.3-amd64-offline';
(async()=>{
 let containerId;
 const raw=dm.docker.modem.socketPath;
 const socket=process.platform==='win32'?'//./pipe/openclaw-control-smoke-'+Date.now():path.join(scratch,'control.sock');
 const Docker=require('dockerode'),controlled=new Docker({socketPath:socket});
 // Route every Manager call to the controller, whose upstream retains raw access.
 const originalMethods={};
 for(const name of ['getContainer','createContainer','getImage','getNetwork','createNetwork']) { originalMethods[name]=dm.docker[name]; }
 // Controller uses a separate raw Docker client.
 const server=require('../src/docker-control').createController({docker:new Docker({socketPath:raw}),root:store.DATA_ROOT});
 await new Promise(resolve=>server.listen(socket,resolve));
 for(const name of Object.keys(originalMethods))dm.docker[name]=controlled[name].bind(controlled);

 try {
  for(const folder of [store.configDir(id),store.workspaceDir(id),store.authDir(id)])fs.mkdirSync(folder,{recursive:true});
  store.saveInstance({id,containerName:name,port:19876});
  const config=policy.agentConfig({gateway:{mode:'local'}},'restricted');
  store.writeOpenclawConfig(id,JSON.stringify(config));
  const script=String.raw`const fs=require('fs'),net=require('net'); console.log('UID='+process.getuid()); console.log(fs.readFileSync('/proc/self/status','utf8').split('\n').filter(l=>/^(CapEff|NoNewPrivs):/.test(l)).join('\n')); const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(2000);s.on('connect',()=>{console.log('EGRESS_UNEXPECTED');s.destroy();process.exitCode=1});s.on('error',()=>console.log('EGRESS_BLOCKED'));s.on('timeout',()=>{console.log('EGRESS_BLOCKED');s.destroy()});`;
  containerId=await dm.createInstanceContainer({instanceId:id,name,image,hostPort:19876,configDir:store.configDir(id),workspaceDir:store.workspaceDir(id),authDir:store.authDir(id),template:{Config:{Entrypoint:['node'],Cmd:['-e',script+';setInterval(()=>{},1000)']}}});
  await dm.startContainer(containerId);await new Promise(r=>setTimeout(r,3000));
  const logs=await dm.getContainerLogs(containerId);assert.match(logs,/UID=1000/);assert.match(logs,/CapEff:\s+0+/);assert.match(logs,/NoNewPrivs:\s+1/);assert.match(logs,/EGRESS_BLOCKED/);assert.doesNotMatch(logs,/EGRESS_UNEXPECTED/);
  const inspected=await dm.inspectContainer(containerId);assert.equal(inspected.HostConfig.NetworkMode,'openclaw-isolated-'+id);assert.deepEqual(inspected.HostConfig.Dns,['127.0.0.1']);
  console.log(logs.trim());
  // Exercise Docker's upgraded bidirectional exec stream while the container runs.
  const keep=await controlled.getContainer(containerId).inspect();
  assert.equal(keep.Config.User,'1000:1000');
  await assert.rejects(controlled.createContainer({Image:image,HostConfig:{Privileged:true}}));
  console.log('BROKER_DANGEROUS_CREATE_DENIED');
  const execution=await controlled.getContainer(containerId).exec({AttachStdin:true,AttachStdout:true,AttachStderr:true,Tty:true,User:'node',Cmd:['sh','-c','read line; printf "EXEC_OK:%s" "$line"']});
  const stream=await execution.start({hijack:true,stdin:true});
  await execution.resize({w:100,h:30});
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>{stream.destroy();reject(Error('exec stream timeout: '+output));},5000);stream.on('data',b=>{output+=b;if(output.includes('EXEC_OK:hello')){clearTimeout(timer);stream.destroy();resolve();}});stream.on('error',reject);stream.write('hello\n');});
  console.log('BROKER_TERMINAL_DUPLEX_AND_RESIZE_OK');
  const cli=await require('util').promisify(require('child_process').execFile)('docker',['exec',name,'node','-e','console.log("CLI_THROUGH_CONTROL_OK")'],{env:{...process.env,DOCKER_HOST:(process.platform==='win32'?'npipe://':'unix://')+socket},timeout:60000,windowsHide:true});
  assert.match(cli.stdout,/CLI_THROUGH_CONTROL_OK/);console.log('CLI_THROUGH_CONTROL_OK');
  await controlled.getContainer(containerId).rename({name:name+'-rollback-123'});
  await controlled.getContainer(containerId).rename({name});
  console.log('BROKER_ROLLBACK_RENAME_OK');
  // Validate against the installed OpenClaw schema, without mounting live credentials.
  const result=execFileSync('docker',['run','--rm','--network','none','--entrypoint','openclaw','-e','OPENCLAW_CONFIG_PATH=/test/openclaw.json','-v',store.configDir(id).replace(/\\/g,'/')+':/test:ro',image,'config','validate','--json'],{encoding:'utf8',timeout:60000,windowsHide:true});
  assert.equal(JSON.parse(result).valid,true);console.log('OPENCLAW_SCHEMA_VALID');
 }finally{
  if(containerId)await dm.removeContainer(containerId,true);
  try{await dm.docker.getNetwork('openclaw-isolated-'+id).remove();}catch(e){if(e.statusCode!==404)throw e;}
  for(const name of Object.keys(originalMethods))dm.docker[name]=originalMethods[name];
  server.destroyClients();
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(scratch,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
