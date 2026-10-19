'use strict';
const crypto=require('crypto');
const {Transform}=require('stream');
const tar=require('tar-stream');
const guard=require('./maintenance-guard');
const {imagePurpose}=require('./image-purpose');
const active=new Set();
const failure=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const architecture=value=>({x86_64:'amd64',aarch64:'arm64',armv7l:'arm',armhf:'arm'}[value]||value);
const validTag=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,255}$/.test(value)&&value.lastIndexOf(':')>value.lastIndexOf('/');
function abortable(promise,signal,dispose=()=>{}){
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(Object.assign(new Error('镜像传输已取消'),{code:'ABORT_ERR'}));
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{
      signal.removeEventListener('abort',abort);if(signal.aborted)dispose(value);else resolve(value);
    },e=>{signal.removeEventListener('abort',abort);reject(e);});
  });
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
function imageConfig(config){
  const defaults={User:'',Env:[],Entrypoint:[],Cmd:[],WorkingDir:'',Labels:{},Volumes:{},ExposedPorts:{},StopSignal:'SIGTERM',Healthcheck:null,Shell:[]};
  return Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,config?.[key]??fallback]));
}
function equivalent(a,b){return Array.isArray(a?.RootFS?.Layers)&&Array.isArray(b?.RootFS?.Layers)&&a?.Config&&b?.Config&&a?.Os===b?.Os&&a?.Architecture===b?.Architecture&&
  JSON.stringify(a?.RootFS?.Layers)===JSON.stringify(b?.RootFS?.Layers)&&
  JSON.stringify(canonical(imageConfig(a.Config)))===JSON.stringify(canonical(imageConfig(b.Config)));}
function exportMeter(job,configIds){
  const parser=tar.extract();
  let meter;
  parser.on('entry',(header,entry,next)=>{
    let raw='';
    if(header.name==='manifest.json'){
      if(header.size>4*1024*1024){entry.destroy(failure('导出镜像清单过大'));return;}
      entry.on('data',chunk=>{raw+=chunk;});
    }
    entry.on('error',e=>meter.destroy(e));
    entry.on('end',()=>{
      try{if(raw)for(const row of JSON.parse(raw)){
        const digest=String(row.Config||'').split('/').pop().replace(/\.json$/,'');
        if(/^[a-f0-9]{64}$/.test(digest))configIds.add('sha256:'+digest);
      }next();}catch{meter.destroy(failure('导出镜像清单格式错误'));}
    });entry.resume();
  });
  meter=new Transform({
    transform(chunk,encoding,callback){job.bytesSent+=chunk.length;if(parser.write(chunk))callback(null,chunk);else parser.once('drain',()=>callback(null,chunk));},
    final(callback){parser.once('finish',callback);parser.end();},
    destroy(error,callback){parser.destroy();callback(error);},
  });
  parser.on('error',e=>meter.destroy(e));return meter;
}
const view=job=>({id:job.id,image:job.image,imageId:job.imageId||null,status:job.status,stage:job.stage,bytesSent:job.bytesSent,
  targetImageId:job.targetImageId||null,sizeHint:job.sizeHint||null,architecture:job.architecture||null,startedAt:job.startedAt,finishedAt:job.finishedAt||null,error:job.error||null,cached:Boolean(job.cached)});
async function localImages(docker=require('./docker').docker){
  const rows=await docker.listImages();
  return rows.flatMap(row=>{
    const purpose=imagePurpose(row.RepoTags||[],row.Labels||{});
    if(!['runtime','manager'].includes(purpose.kind))return [];
    return (row.RepoTags||[]).filter(validTag).map(image=>({image,imageId:row.Id,size:row.Size,kind:purpose.kind,purpose:purpose.purpose}));
  }).sort((a,b)=>a.image.localeCompare(b.image));
}
function createTransferService({docker=()=>require('./docker').docker,execute=(...args)=>require('./ssh-connections').execute(...args)}={}){
  async function targetImage(record,image,signal){
    const listed=await execute(record.client,['image','ls','--no-trunc','--filter','reference='+image,'--format','{{json .}}'],null,30000,{signal});
    const rows=listed.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
    if(!rows.length)return null;
    return JSON.parse(await execute(record.client,['image','inspect',image],null,30000,{signal}))[0];
  }
  async function transfer(record,job){
    const {signal}=job.controller;
    let source,meter;
    const check=()=>{if(signal.aborted||!['connected','ssh-ready'].includes(record.status))throw Object.assign(failure('镜像传输已取消'),{code:'ABORT_ERR'});};
    const abort=()=>{source?.destroy();meter?.destroy(Object.assign(new Error('镜像传输已取消'),{code:'ABORT_ERR'}));};
    try{
      await guard.use(async()=>{
        check();
        const engine=docker();
        const local=await abortable(engine.getImage(job.imageId||job.image).inspect(),signal);check();
        if(!local.RepoTags?.includes(job.image)||(job.imageId&&local.Id!==job.imageId))throw failure('本机镜像标签已变化，请刷新镜像列表后重试',409);
        const purpose=imagePurpose(local.RepoTags,local.Config?.Labels||{});
        if(!['runtime','manager'].includes(purpose.kind))throw failure('仅支持传输 OpenClaw 或 Manager 镜像');
        job.imageId=local.Id;job.sizeHint=local.Size;job.architecture=`${local.Os}/${local.Architecture}`;
        const info=JSON.parse(await execute(record.client,['info','--format','{{json .}}'],null,30000,{signal}));check();
        if(local.Os!=='linux'||info.OSType!=='linux'||architecture(local.Architecture)!==architecture(info.Architecture))throw failure(`镜像 ${job.architecture} 与目标 ${info.OSType}/${architecture(info.Architecture)} 不兼容，请先在本机准备对应架构镜像`);
        const existing=await targetImage(record,job.image,signal);check();
        if(existing&&existing.Id!==local.Id&&!equivalent(local,existing))throw failure('目标已有同名但不同内容的镜像，请先在本机使用新的标签再传输',409);
        if(existing){job.cached=true;job.targetImageId=existing.Id;job.stage='目标已有相同镜像，已校验，无需传输';if(purpose.kind==='manager')record.managerImage=job.image;return;}
        job.stage='正在导出并通过 SSH 传输';
        // Export the immutable ID without tags. No existing target tag can be
        // overwritten by docker load; restore just the selected tag after verify.
        source=await abortable(engine.getImage(local.Id).get(),signal,stream=>{stream.on('error',()=>{});stream.destroy();});
        source.on('error',e=>meter?.destroy(e));
        check();
        const configIds=new Set();meter=exportMeter(job,configIds);
        meter.on('error',()=>source.destroy());
        signal.addEventListener('abort',abort,{once:true});
        source.pipe(meter);
        let inputEnded=false;
        await execute(record.client,['image','load','--quiet'],meter,2*60*60*1000,{signal,onInputEnd:()=>{inputEnded=true;job.stage='传输结束，等待目标 Docker 完成导入';}});check();
        if(!inputEnded)throw failure('目标提前结束导入，镜像传输未完成',502);
        job.stage='正在核对镜像 ID 与标签';
        let imported;
        for(const id of new Set([local.Id,...configIds])){
          check();
          try{const candidate=JSON.parse(await execute(record.client,['image','inspect',id],null,30000,{signal}))[0];if(candidate?.Id===id&&equivalent(local,candidate)){imported=candidate;break;}}
          catch(e){if(!/No such image|No such object/i.test(e.message))throw e;}
        }
        check();
        if(!imported)throw failure('目标镜像配置、架构或文件层校验失败，未写入目标标签',502);
        job.targetImageId=imported.Id;
        const current=await targetImage(record,job.image,signal);check();
        if(current&&current.Id!==imported.Id)throw failure('传输期间目标标签已被其他操作使用，已保留原标签；导入的镜像未打标签',409);
        if(!current)await execute(record.client,['image','tag',imported.Id,job.image],null,30000,{signal});check();
        const tagged=JSON.parse(await execute(record.client,['image','inspect',job.image],null,30000,{signal}))[0];check();
        if(tagged?.Id!==imported.Id||!equivalent(local,tagged))throw failure('目标镜像标签校验失败',502);
        if(purpose.kind==='manager')record.managerImage=job.image;
        job.stage='镜像已导入并通过 ID 校验，可在目标设备离线开通实例';
      });
      check();job.status='done';
    }catch(e){job.status=signal.aborted||e.code==='ABORT_ERR'?'cancelled':'error';job.error=e.message;job.stage=job.status==='cancelled'?'传输已取消；已经导入的镜像层会保留':'镜像传输失败';}
    finally{signal.removeEventListener('abort',abort);source?.destroy();meter?.destroy();job.finishedAt=Date.now();active.delete(job);}
  }
  function start(record,body={}){
    if(!['connected','ssh-ready'].includes(record.status))throw failure('请先连接目标设备的 SSH',409);
    if(record.transfer?.status==='running')throw failure('该设备已有镜像正在传输',409);
    if(active.size>=2)throw failure('最多同时传输两个镜像，请稍后重试',409);
    if(guard.active)throw guard.conflict();
    if(!body||typeof body!=='object'||Array.isArray(body))throw failure('镜像传输参数不合法');
    if(!validTag(body.image))throw failure('请从本机镜像列表选择带标签的镜像');
    if(body.imageId!==undefined&&!/^sha256:[a-f0-9]{64}$/.test(body.imageId))throw failure('镜像 ID 不合法，请刷新镜像列表');
    const job={id:crypto.randomBytes(12).toString('hex'),image:body.image,imageId:body.imageId,status:'running',stage:'正在检查本机镜像与目标 Docker',bytesSent:0,startedAt:Date.now(),controller:new AbortController()};
    record.transfer=job;active.add(job);job.finished=transfer(record,job);return view(job);
  }
  return {start};
}
const service=createTransferService();
module.exports={localImages,view,validTag,createTransferService,equivalent,start:service.start};
