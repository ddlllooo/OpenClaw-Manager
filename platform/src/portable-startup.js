'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const store=require('./instances');
const docker=require('./docker');
const settingsHome=require('./startup-settings').home;
const defaults={managerAutoStart:process.env.MANAGER_CONTAINERIZED==='1',dockerAutoLaunch:false,instancesAutoStart:true,instanceOverrides:{}};
const revision=settings=>crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex');
function load(){const file=path.join(settingsHome(),'startup-settings.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):structuredClone(defaults);}
function failure(message,statusCode=400){return Object.assign(new Error(message),{statusCode});}
async function invoke(action,body={}) {
  let settings=load();
  const ids=store.listInstanceIds();
  if(action==='settings'){
    if(body.revision!==revision(settings))throw failure('启动设置已变化，请刷新后保存',409);
    if(Object.keys(body).some(k=>!['revision',...Object.keys(defaults)].includes(k)))throw failure('包含不支持的启动设置');
    if(body.dockerAutoLaunch!==undefined&&body.dockerAutoLaunch!==settings.dockerAutoLaunch)throw failure('请通过目标设备的系统服务配置 Docker 自启');
    if(process.env.MANAGER_CONTAINERIZED!=='1'&&body.managerAutoStart!==undefined&&body.managerAutoStart!==settings.managerAutoStart)throw failure('请通过系统服务配置 Manager 自启');
    const next=structuredClone(settings);
    for(const key of ['managerAutoStart','dockerAutoLaunch','instancesAutoStart'])if(body[key]!==undefined){if(typeof body[key]!=='boolean')throw failure('启动开关必须为布尔值');next[key]=body[key];}
    if(body.instanceOverrides!==undefined){
      if(!body.instanceOverrides||typeof body.instanceOverrides!=='object'||Array.isArray(body.instanceOverrides))throw failure('实例开关不合法');
      for(const [id,value]of Object.entries(body.instanceOverrides)){
        if(!ids.includes(id))throw failure('实例不存在或已移除',409);
        if(value===null)delete next.instanceOverrides[id];else if(typeof value==='boolean')next.instanceOverrides[id]=value;else throw failure('实例开关必须为布尔值');
      }
    }
    const changed=[];
    try{
      for(const id of ids){const inst=store.loadInstance(id);if(!inst.containerId)continue;
        const c=docker.getContainer(inst.containerId),old=await c.inspect();
        const name=next.instancesAutoStart&&next.instanceOverrides[id]!==false?'unless-stopped':'no';
        await c.update({RestartPolicy:{Name:name}});changed.push([c,old.HostConfig.RestartPolicy]);
      }
      if(process.env.MANAGER_CONTAINERIZED==='1'&&next.managerAutoStart!==settings.managerAutoStart){
        const c=docker.getContainer(require('os').hostname()),old=await c.inspect();
        await c.update({RestartPolicy:{Name:next.managerAutoStart?'unless-stopped':'no'}});changed.push([c,old.HostConfig.RestartPolicy]);
      }
      store.atomicWrite(path.join(settingsHome(),'startup-settings.json'),JSON.stringify(next,null,2));settings=next;
    }catch(e){for(const [c,policy]of changed.reverse())await c.update({RestartPolicy:policy}).catch(()=>{});throw e;}
  }
  const rows=[],errors=[];
  for(const id of ids){const inst=store.loadInstance(id);let data;
    try{data=inst.containerId?await docker.inspectContainer(inst.containerId):null;}catch(e){if(e.statusCode!==404)errors.push(e.message);}
    rows.push({id,name:inst.name,enabled:settings.instanceOverrides[id]!==false,effective:settings.instancesAutoStart&&settings.instanceOverrides[id]!==false,
      state:data?.State?.Status||'missing',restartPolicy:data?.HostConfig?.RestartPolicy?.Name||'no',detail:data?'由 Docker 重启策略恢复':'容器尚未创建或已移除'});
  }
  try{await docker.dockerInfo();}catch{errors.push('Docker 引擎不可达，请在目标设备启动 Docker');}
  return {settings,revision:revision(settings),instances:rows,managerRuntime:process.env.MANAGER_CONTAINERIZED==='1'?'docker-portable':'native-portable',
    capabilities:{managerAutoStart:process.env.MANAGER_CONTAINERIZED==='1',dockerAutoLaunch:false},loginRequired:false,supervisorInstalled:false,
    status:{phase:errors.length?'attention':'ready',checkedAt:Date.now()/1000,errors,instances:rows}};
}
module.exports={invoke};
