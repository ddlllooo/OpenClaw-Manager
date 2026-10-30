'use strict';
// Signed mailbox RPC crosses macOS bind mounts without exposing a command port.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function directory(){return process.env.OPENCLAW_HOST_CONTROL_DIR;}
function enabled(){return Boolean(directory());}
function error(message,statusCode=503){return Object.assign(new Error(message),{statusCode});}
function signature(key,payload){return crypto.createHmac('sha256',key).update(payload).digest('hex');}
function begin(action,body,timeout,overrideDirectory){
  const root=overrideDirectory||directory();if(!root)throw error('未配置宿主控制服务');
  const key=fs.readFileSync(path.join(root,'key'),'utf8').trim();if(!/^[a-f0-9]{64}$/.test(key))throw error('宿主控制密钥不合法');
  const id=crypto.randomBytes(16).toString('hex'),deadline=Date.now()+timeout;
  const payload=Buffer.from(JSON.stringify({id,issuedAt:Date.now()/1000,deadline:deadline/1000,action,body:body||{}})).toString('base64');
  if(payload.length>90000)throw error('宿主控制请求过大',413);
  const file=path.join(root,'requests',id+'.json'),reply=path.join(root,'responses',id+'.json'),temp=file+'.tmp';
  fs.writeFileSync(temp,JSON.stringify({payload,signature:signature(key,payload)}),{mode:0o644,flag:'wx'});fs.renameSync(temp,file);
  return {id,key,file,reply,deadline};
}
function finish(r){
  if(!fs.existsSync(r.reply))return undefined;
  if(fs.lstatSync(r.reply).isSymbolicLink()||fs.statSync(r.reply).size>3*1024*1024)throw error('宿主响应不合法');
  const envelope=JSON.parse(fs.readFileSync(r.reply,'utf8'));const expected=signature(r.key,envelope.payload);
  if(typeof envelope.signature!=='string'||envelope.signature.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(envelope.signature)))throw error('宿主响应签名无效');
  const result=JSON.parse(Buffer.from(envelope.payload,'base64').toString('utf8'));
  if(result.id!==r.id)throw error('宿主响应标识不匹配');
  if(result.error)throw error(result.error,result.status||503);
  return {value:result.result};
}
function clean(r){for(const p of [r.file,r.reply])try{fs.unlinkSync(p);}catch(e){if(e.code!=='ENOENT')console.warn('宿主请求清理失败');}}
async function request(action,body={},timeout=90000,overrideDirectory){
  const r=begin(action,body,timeout,overrideDirectory);
  try{while(Date.now()<r.deadline){const response=finish(r);if(response)return response.value;await new Promise(resolve=>setTimeout(resolve,100));}throw error('宿主控制服务未响应，请检查系统启动任务');}
  finally{clean(r);}
}
function requestSync(action,body={},timeout=5000){
  const r=begin(action,body,timeout),waiter=new Int32Array(new SharedArrayBuffer(4));
  try{while(Date.now()<r.deadline){const response=finish(r);if(response)return response.value;Atomics.wait(waiter,0,0,100);}throw error('宿主端口检查超时');}
  finally{clean(r);}
}
module.exports={enabled,request,requestSync};
