'use strict';
const net=require('net');
function address(port,rows){
  const found=rows.filter(r=>r.State==='running'&&r.Labels?.['openclaw.managed']==='true'&&!r.Names?.some(n=>n.includes('-rollback-'))&&r.Ports?.some(p=>p.PrivatePort===18789&&p.PublicPort===Number(port)));
  if(found.length!==1)throw new Error('无法唯一定位实例网关地址');
  const ip=found[0].NetworkSettings?.Networks?.bridge?.IPAddress;
  if(net.isIP(ip)!==4)throw new Error('实例未连接默认 Docker bridge 网络');
  return `http://${ip}:18789`;
}
async function base(port){
  if(process.env.MANAGER_CONTAINERIZED!=='1')return `http://127.0.0.1:${Number(port)}`;
  const rows=await require('./docker').docker.listContainers({all:false,filters:{label:['openclaw.managed=true']}});
  return address(port,rows);
}
module.exports={base,address};
