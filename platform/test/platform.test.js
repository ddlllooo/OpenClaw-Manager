'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('path'),fs=require('fs'),os=require('os'),net=require('net');
const runtime=require('../src/runtime-platform');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-platform-'));process.env.OPENCLAW_DATA_DIR=path.join(scratch,'instances');process.env.OPENCLAW_STARTUP_HOME=scratch;
test.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
test('Docker socket selection supports Windows named pipes, macOS and Linux Engine/Desktop',()=>{
  assert.equal(runtime.socketPath('win32','C:/Users/test',()=>false),'//./pipe/docker_engine');
  assert.equal(runtime.socketPath('darwin','/Users/test',()=>false),path.join('/Users/test','.docker/run/docker.sock'));
  assert.equal(runtime.socketPath('linux','/home/test',()=>false),'/var/run/docker.sock');
  assert.equal(runtime.socketPath('linux','/home/test',p=>p===path.join('/home/test','.docker/run/docker.sock')),path.join('/home/test','.docker/run/docker.sock'));
});
test('local Docker endpoint overrides stay consistent with CLI operations',()=>{
  const socket=process.env.DOCKER_SOCKET,host=process.env.DOCKER_HOST;
  try{
    delete process.env.DOCKER_SOCKET;process.env.DOCKER_HOST='unix:///tmp/rootless.sock';assert.equal(runtime.dockerSocket(),'/tmp/rootless.sock');
    process.env.DOCKER_HOST='npipe:////./pipe/docker_engine';assert.equal(runtime.dockerSocket(),'//./pipe/docker_engine');
    process.env.DOCKER_HOST='tcp://remote:2375';assert.throws(()=>runtime.dockerSocket(),/SSH/);
  }finally{if(socket===undefined)delete process.env.DOCKER_SOCKET;else process.env.DOCKER_SOCKET=socket;if(host===undefined)delete process.env.DOCKER_HOST;else process.env.DOCKER_HOST=host;}
});
test('portable host port detection recognizes an occupied port without Bash or nc',async()=>{
  const server=net.createServer();server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const port=server.address().port,store=require('../src/instances');
  try{assert.throws(()=>store.allocatePort(port),/占用/);}finally{await new Promise(r=>server.close(r));}
  assert.equal(store.allocatePort(port),port);
});
test('disk telemetry measures the data filesystem',()=>{const disk=runtime.diskInfo(scratch);assert.ok(disk.total>0);assert.ok(disk.available>=0&&disk.available<=disk.total);});
test('packaged desktop deployment restores the renamed lockfile to the Docker build context',async()=>{
  const root=path.join(scratch,'packaged');fs.mkdirSync(root);
  for(const dir of ['src','public','scripts','control-ui-patches','security'])fs.mkdirSync(path.join(root,dir));
  for(const name of ['Dockerfile','package.json','server.js'])fs.writeFileSync(path.join(root,name),'fixture');
  fs.writeFileSync(path.join(root,'deployment-lock.json'),'fixture-lock');
  const extract=require('tar-stream').extract(),entries={};
  extract.on('entry',(header,stream,next)=>{let content='';stream.on('data',b=>content+=b);stream.on('end',()=>{entries[header.name]=content;next();});stream.resume();});
  const archive=require('../src/ssh-connections').sourceArchive(root);
  await new Promise((resolve,reject)=>{archive.on('error',reject);extract.on('error',reject);extract.on('finish',resolve);archive.pipe(extract);});
  assert.equal(entries['package-lock.json'],'fixture-lock');assert.equal(entries['deployment-lock.json'],undefined);
});
test('native startup settings expose supported controls and update Docker policies without starting containers',async()=>{
  const calls=[],store=require('../src/instances');store.saveInstance({id:'fixture',name:'fixture',containerId:'container'});
  const container={inspect:async()=>({HostConfig:{RestartPolicy:{Name:'unless-stopped'}}}),update:async body=>calls.push(body)};
  const fake={getContainer:()=>container,inspectContainer:async()=>({State:{Status:'exited'},HostConfig:{RestartPolicy:{Name:'unless-stopped'}}}),dockerInfo:async()=>({})};
  require.cache[require.resolve('../src/docker')]={id:'docker',loaded:true,exports:fake};
  const startup=require('../src/portable-startup');const before=await startup.invoke('status');assert.equal(before.capabilities.dockerAutoLaunch,false);
  await assert.rejects(startup.invoke('settings',{revision:before.revision,dockerAutoLaunch:true}),/系统服务/);
  const after=await startup.invoke('settings',{revision:before.revision,instancesAutoStart:false});assert.equal(after.settings.instancesAutoStart,false);assert.equal(calls[0].RestartPolicy.Name,'no');
  await assert.rejects(startup.invoke('settings',{revision:before.revision,instancesAutoStart:true}),e=>e.statusCode===409);
});
