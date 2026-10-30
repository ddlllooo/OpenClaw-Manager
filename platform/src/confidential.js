 'use strict';
const crypto=require('crypto');
const key=crypto.randomBytes(32),prefix='__MANAGER_SECRET_';
const sensitive=k=>/secret|password|passphrase|api.?key|token|authorization|private.?key|credential|headers|^env$/i.test(k);
function marker(path,value){return prefix+crypto.createHmac('sha256',key).update(JSON.stringify([path,value])).digest('hex')+'__';}
function mask(value,path=[],hidden=false){
 if(value!==null&&typeof value!=='object')return hidden&&value!==''?marker(path,value):value;
 if(Array.isArray(value))return value.map((v,i)=>mask(v,[...path,i],hidden));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,mask(v,[...path,k],hidden||sensitive(k))]));
 return value;
}
function restore(value,old,path=[]){
 if(typeof value==='string'&&value.includes(prefix)){
  if(old===undefined||value!==marker(path,old))throw new Error('密钥占位符已移动或失效，请重新加载配置');
  return old;
 }
 if(Array.isArray(value))return value.map((v,i)=>restore(v,old?.[i],[...path,i]));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,restore(v,old?.[k],[...path,k])]));
 return value;
}
function scrub(value,instance){
 const store=require('./instances'),secrets=new Set([instance.gatewayToken]);
 function collect(node,hidden=false){
  if(typeof node==='string'&&hidden&&node.length>=4)secrets.add(node);
  else if(node&&typeof node==='object')for(const [k,v]of Object.entries(node))collect(v,hidden||sensitive(k));
 }
 collect(JSON.parse(store.readOpenclawConfig(instance.id)||'{}'));
 for(const value of Object.values(store.parseEnv(store.readEnvFile(instance.id))))if(value.length>=4)secrets.add(value);
 let text=String(value);
 for(const secret of [...secrets].filter(Boolean).sort((a,b)=>b.length-a.length)) {
  for(const encoded of [secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),JSON.stringify(secret).slice(1,-1)])text=text.split(encoded).join('[已脱敏]');
 }
 return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[已脱敏私钥]').replace(/Bearer\s+[^\s"'<>]+/gi,'Bearer [已脱敏]').replace(/((?:api[_-]?key|password|secret|token|authorization)["']?\s*[:=]\s*["']?)[^\s,"'&}]+/gi,'$1[已脱敏]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[已脱敏]@');
}
module.exports={mask,restore,scrub};
