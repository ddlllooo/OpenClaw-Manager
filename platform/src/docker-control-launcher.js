 'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process');
let child,folder;
function start(){
 if(process.env.OPENCLAW_CONTROL_SOCKET)return Promise.resolve();
 if(process.env.MANAGER_CONTAINERIZED==='1')throw new Error('Container Manager requires OPENCLAW_CONTROL_SOCKET; raw Docker access is disabled');
 const runtime=require('./runtime-platform'),raw=runtime.dockerSocket();
 const socket=process.platform==='win32'?'//./pipe/openclaw-control-'+crypto.randomBytes(16).toString('hex'):(folder=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-control-')),fs.chmodSync(folder,0o700),path.join(folder,'control.sock'));
 process.env.OPENCLAW_CONTROL_SOCKET=socket;
 const env={};for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','HOME','USERPROFILE','WINDIR','TMP','TEMP'])if(process.env[key])env[key]=process.env[key];
 Object.assign(env,{OPENCLAW_CONTROL_SOCKET:socket,OPENCLAW_DOCKER_SOCKET:raw,OPENCLAW_DATA_DIR:require('./instances').DATA_ROOT,ELECTRON_RUN_AS_NODE:'1'});
 return new Promise((resolve,reject)=>{
  child=spawn(process.execPath,[runtime.scriptPath('docker-control.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','ignore','ipc']});
  const timer=setTimeout(()=>{stop();reject(new Error('Docker controller startup timeout'));},10000);
  child.once('error',()=>{clearTimeout(timer);reject(new Error('Docker controller failed to start'));});
  child.once('exit',()=>{if(folder){try{fs.rmdirSync(folder);}catch{}}clearTimeout(timer);reject(new Error('Docker controller stopped'));});
  child.stdout.once('data',()=>{clearTimeout(timer);child.stdout.resume();resolve();});
 });
}
function stop(){child?.kill();if(folder){try{fs.rmdirSync(folder);}catch{}}}
module.exports={start,stop};
