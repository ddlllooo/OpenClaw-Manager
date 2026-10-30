 'use strict';
const fs=require('fs'),path=require('path'),Docker=require('dockerode');
const socket=process.env.OPENCLAW_CONTROL_SOCKET||'/run/openclaw-docker/control.sock';
const root=process.env.OPENCLAW_DATA_DIR;if(!root)throw Error('OPENCLAW_DATA_DIR required');
const raw=process.env.OPENCLAW_DOCKER_SOCKET||'/var/run/docker.sock';
if(socket===raw)throw Error('Control socket must differ from Docker socket');
const pipe=process.platform==='win32';
if(!pipe)fs.mkdirSync(path.dirname(socket),{recursive:true});
async function prepareSocket(){
 if(pipe||!fs.existsSync(socket))return;
 if(!fs.lstatSync(socket).isSocket())throw Error('Refusing to replace a non-socket path');
 await new Promise((resolve,reject)=>{
  const probe=require('net').connect(socket);probe.setTimeout(1000);
  probe.once('connect',()=>{probe.destroy();reject(Error('Controller already running'));});
  probe.once('timeout',()=>{probe.destroy();reject(Error('Socket state unknown'));});
  probe.once('error',error=>{if(error.code!=='ECONNREFUSED')return reject(error);fs.unlinkSync(socket);resolve();});
 });
}
const server=require('../src/docker-control').createController({docker:new Docker({socketPath:raw}),root,deployment:process.env.OPENCLAW_CONTROL_DEPLOYMENT,managerName:process.env.OPENCLAW_CONTROL_MANAGER});
prepareSocket().then(()=>server.listen(socket,()=>{if(!pipe)fs.chmodSync(socket,process.env.OPENCLAW_CONTROL_SOCKET_MODE==='666'?0o666:0o600);server.security.startMonitor();console.log('Restricted Docker controller ready');})).catch(()=>{console.error('Controller socket startup failed');process.exit(1);});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.security.stopMonitor();server.destroyClients();server.close(()=>process.exit(0));});

process.on('disconnect',()=>{server.security.stopMonitor();server.destroyClients();server.close(()=>process.exit(0));});
