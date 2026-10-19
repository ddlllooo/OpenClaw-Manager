'use strict';
const {execFile}=require('child_process');
const express=require('express');
const settings=require('../startup-settings');
const router=express.Router();
let busy=false;
function invoke(action,body) {
  const host=require('../host-control');
  if(host.enabled())return host.request(action,body);
  if(process.platform!=='darwin'||process.env.MANAGER_CONTAINERIZED==='1')return require('../portable-startup').invoke(action,body);
  return new Promise((resolve,reject)=>{
    const child=execFile(process.platform==='win32'?'python':'/usr/bin/python3',[require('../runtime-platform').scriptPath('startup_recovery.py'),action,'--json'],
      {timeout:90000,maxBuffer:2*1024*1024,windowsHide:true,env:{...process.env,OPENCLAW_STARTUP_HOME:settings.home(),STARTUP_NODE_BIN:process.execPath,STARTUP_LOCK_WAIT_SECONDS:'10'}},(err,stdout)=>{
        let result;try{result=JSON.parse(stdout);}catch{return reject(Object.assign(new Error('启动管理程序未返回有效结果，请查看服务日志'),{statusCode:503}));}
        if(err||result.error)return reject(Object.assign(new Error(result.error||'启动管理程序执行失败'),{statusCode:result.status||503}));
        resolve(result);
      });
    child.stdin?.on('error',()=>{});child.stdin?.end(body?JSON.stringify(body):'');
  });
}
router.get('/',async(req,res)=>{try{res.json(await invoke('status'));}catch(e){res.status(e.statusCode||500).json({error:e.message});}});
for(const [method,url,action] of [['put','/','settings'],['post','/check','tick']])router[method](url,async(req,res)=>{
  if(busy)return res.status(409).json({error:'启动与恢复操作正在执行，请稍后重试'});
  busy=true;try{res.json(await invoke(action,req.body));}catch(e){res.status(e.statusCode||500).json({error:e.message});}finally{busy=false;}
});
module.exports=router;
