'use strict';
const os=require('os');
function homeUrl(){return `http://127.0.0.1:${Number(process.env.MANAGER_PORT||18080)}/`;}
function localDevice(){return {id:'local',name:process.env.OPENCLAW_DEVICE_NAME||process.env.OPENCLAW_DEPLOYMENT_TARGET||os.hostname(),kind:'local',status:'connected',url:homeUrl()};}
function context(records,current){
  const local=localDevice(),rows=[...(records?.values()||[])];
  const devices=[local,...rows.map(r=>({id:r.id,name:r.name||`${r.username}@${r.host}`,customName:r.name||'',notes:r.notes||'',host:r.host,port:r.port,username:r.username,remotePort:r.remotePort,kind:'ssh',status:r.status,url:r.status==='connected'?r.proxy?.url||null:null}))];
  const device=current?devices.find(d=>d.id===current.id)||{id:current.id,name:`${current.username}@${current.host}`,kind:'ssh',status:current.status,url:null}:local;
  return {mode:current?'ssh':'local',platform:process.platform,homeUrl:homeUrl(),host:current?.host,username:current?.username,device,devices,workspace:true};
}
module.exports={context,localDevice};
