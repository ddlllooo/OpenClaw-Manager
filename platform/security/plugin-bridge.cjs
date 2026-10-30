'use strict';
// TRUSTED gateway adapter. Never imports the remote plugin or shares api,
// runtime, config, tool context, conversation IDs, credentials or workspace.
const http=require('http'),net=require('net');
const {validateValue}=require('./plugin-policy.cjs');
function invoke(target,name,args,{timeout=15000}={}){
 const tool=target.tools.find(t=>t.name===name);if(!tool)throw Error('Isolated tool denied');validateValue(args,tool.parameters);
 if(net.isIP(target.ip)!==4||!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(target.ip)||target.port!==18790)throw Error('Invalid isolated plugin target');
 const body=JSON.stringify({name,arguments:args});if(Buffer.byteLength(body)>65536)throw Error('Plugin arguments too large');
 return new Promise((resolve,reject)=>{
  const request=http.request({host:target.ip,port:target.port,path:'/invoke',method:'POST',headers:{Authorization:'Bearer '+target.token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout},res=>{
   const chunks=[];let bytes=0;
   res.on('error',()=>reject(Error('Isolated plugin response failed')));
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){res.destroy();reject(Error('Isolated plugin result too large'));}else chunks.push(chunk);});
   res.on('end',()=>{try{
    if(res.statusCode!==200)throw Error('Plugin rejected request');
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // Only plain textual tool results cross back. No attachment URLs, host paths,
    // config mutations, command requests, structured authority or runtime hooks.
    if(!value||!Array.isArray(value.content)||!value.content.length||value.content.length>32||value.content.some(c=>!c||c.type!=='text'||typeof c.text!=='string'||Object.keys(c).some(k=>!['type','text'].includes(k))))throw Error('Unsupported isolated tool response');
    resolve({content:value.content.map(c=>({type:'text',text:c.text})),...(value.isError===true?{isError:true}:{})});
   }catch{reject(Error('Invalid or failed isolated plugin response'));}});
  });
  const timer=setTimeout(()=>request.destroy(Error('Isolated plugin deadline exceeded')),timeout);
  request.on('timeout',()=>request.destroy());request.on('error',()=>reject(Error('Isolated plugin unavailable')));request.on('close',()=>clearTimeout(timer));request.end(body);
 });
}
function register(api){
 const targets=require('./targets.json');
 for(const target of targets)for(const tool of target.tools){
  api.registerTool({name:tool.name,description:tool.description,parameters:tool.parameters,
   async execute(_id,args){validateValue(args,tool.parameters);return invoke(target,tool.name,args);}
  });
 }
}
module.exports={id:'manager-isolated-tools',name:'Isolated plugin tools',register,invoke};
