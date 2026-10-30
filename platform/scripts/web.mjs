#!/usr/bin/env node
// Portable foreground/daemon launcher; stopping uses authenticated HTTP plus a
// per-launch nonce, so an obsolete PID file can never kill another process.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import environment from '../src/env.js';
environment.load();
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tag=crypto.createHash('sha256').update(root).digest('hex').slice(0,12);
const stateFile=path.join(process.env.OPENCLAW_WEB_STATE_DIR||os.tmpdir(),`openclaw-web-${tag}.json`);
const port=Number(process.env.MANAGER_PORT||process.env.PORT||18080);
const flag=process.argv[2]||'-f';
if(flag==='-s'||flag==='--stop'){
  if(!fs.existsSync(stateFile)){console.log('没有此目录启动的后台实例');process.exit(0);}
  const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  const url=`http://127.0.0.1:${state.port}`;
  try{
    const session=await fetch(url+'/api/session',{headers:{Authorization:'Bearer '+state.authToken},signal:AbortSignal.timeout(5000)});
    const cookie=session.headers.get('set-cookie')?.split(';')[0],{csrf}=await session.json();
    const result=await fetch(url+'/api/launcher/stop',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify({token:state.token}),signal:AbortSignal.timeout(5000)});
    if(!result.ok)throw new Error('后台身份校验失败');
    fs.unlinkSync(stateFile);console.log('后台服务已停止');
  }catch(e){console.error('无法停止后台服务：'+e.message);process.exitCode=1;}
}else if(['-f','--foreground','-d','--daemon'].includes(flag)){
  const daemon=['-d','--daemon'].includes(flag),token=crypto.randomBytes(32).toString('hex');
  const log=process.env.WEB_LOG||path.join(os.tmpdir(),`openclaw-web-${tag}.log`);
  const fd=daemon?fs.openSync(log,'a'):null;
  const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,windowsHide:true,detached:daemon,
    stdio:daemon?['ignore',fd,fd]:'inherit',env:{...process.env,MANAGER_PORT:String(port),...(daemon?{OPENCLAW_WEB_LAUNCH_TOKEN:token}:{})}});
  child.on('error',e=>{console.error(e.message);process.exitCode=1;});
  if(daemon){
    fs.closeSync(fd);child.unref();let ready=false;
    for(let i=0;i<60;i++){
      try{const response=await fetch(`http://127.0.0.1:${port}/_launcher/identity`,{signal:AbortSignal.timeout(1000)});if(response.ok&&(await response.json()).identity===crypto.createHash('sha256').update(token).digest('hex')){ready=true;break;}}catch{}
      if(child.exitCode!==null)break;
      await new Promise(r=>setTimeout(r,500));
    }
    if(ready){fs.writeFileSync(stateFile,JSON.stringify({port,token,authToken:process.env.MANAGER_AUTH_TOKEN||fs.readFileSync(path.join(path.dirname(process.env.OPENCLAW_DATA_DIR||path.join(root,'data','instances')),'manager-auth','token'),'utf8').trim()}),{mode:0o600});console.log(`后台服务 http://127.0.0.1:${port}/ · 日志 ${log}`);}
    else{console.error('启动尚未就绪或端口已被占用，请检查日志：'+log);process.exitCode=1;}
  }else{
    child.on('exit',code=>{process.exitCode=code??1;});
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
  }
}else{console.error('用法：npm run web -- [-f|-d|-s]');process.exitCode=1;}
