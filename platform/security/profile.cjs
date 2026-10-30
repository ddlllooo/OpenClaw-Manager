 'use strict';
const crypto=require('crypto');
function workspace(value){
 if(value===undefined)return;
 if(typeof value!=='string'||value.includes('\\'))throw Error('独立沙箱需要标准工作区路径');
 const p=require('path').posix.normalize(value.replace(/^~(?=\/)/,'/home/node'));
 if(!(p==='/home/node/.openclaw/workspace'||p.startsWith('/home/node/.openclaw/workspace/')||p.startsWith('/home/node/.openclaw/workspaces/')))throw Error('禁止从配置、认证或其他非工作区目录播种沙箱');
}
function apply(config,agents){
 workspace(config.agents?.defaults?.workspace);
 const result=structuredClone(config);
 if(config.acp?.enabled||config.agents?.defaults?.runtime||config.agents?.defaults?.harness)throw Error('当前独立执行模式不支持外部运行时/ACP；请先使用标准 OpenClaw Agent');
 result.agents||={};result.agents.defaults||={};result.tools||={};
 result.tools.elevated={enabled:false};result.tools.exec={...result.tools.exec,host:'sandbox'};
 result.tools.deny=[...new Set([...(result.tools.deny||[]).filter(v=>!['group:runtime','exec','process','code_execution'].includes(v)),'nodes','browser','canvas','gateway','plugins','openclaw','code_execution'])];
 const keyed=Boolean(result.agents.entries);
 const rows=keyed?Object.entries(result.agents.entries).map(([id,row])=>({...row,id})):(result.agents.list||[{id:'main'}]);
 if(rows.length>1&&!result.agents.ownership){if(keyed)result.agents.ownership='explicit';else if(!rows.some(row=>row.default))rows[0].default=true;}
 for(const agent of rows){
  workspace(agent.workspace);
  if(agent.runtime||agent.harness)throw Error('外部 Agent 运行时需要单独审核执行边界');
  const target=agents[agent.id];if(!target)throw Error('Missing isolated worker for Agent '+agent.id);
  agent.sandbox={mode:'all',backend:'ssh',scope:'session',workspaceAccess:'rw',ssh:{target:'sandbox@'+target.ip+':2222',command:'/usr/bin/ssh',workspaceRoot:'/workspaces',strictHostKeyChecking:true,updateHostKeys:false,identityFile:'/home/node/.config/openclaw/sandbox/'+agent.id+'/client',knownHostsFile:'/home/node/.config/openclaw/sandbox/'+agent.id+'/known_hosts'}};
  if(agent.tools?.elevated)agent.tools.elevated={enabled:false};
  if(agent.tools?.exec)agent.tools.exec={...agent.tools.exec,host:'sandbox'};
 }
 if(keyed)result.agents.entries=Object.fromEntries(rows.map(({id,...row})=>[id,row]));else result.agents.list=rows;
 result.agents.defaults.sandbox=structuredClone(rows[0].sandbox);
 return result;
}
function origins(config,extra=[]){
 const values=[];
 for(const provider of Object.values(config.models?.providers||{}))if(provider.baseUrl){const url=new URL(provider.baseUrl);values.push(url.origin);}
 if(config.channels?.feishu?.enabled!==false&&config.channels?.feishu){
  const channel=config.channels.feishu,domains=[channel.domain||'feishu',...Object.values(channel.accounts||{}).map(row=>row.domain||channel.domain||'feishu')];
  if(domains.includes('feishu'))values.push('https://open.feishu.cn','wss://msg-frontier.feishu.cn');
  if(domains.includes('lark'))values.push('https://open.larksuite.com','wss://msg-frontier.larksuite.com');
 }
 return [...new Set([...values,...extra])];
}
function stamp(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function assert(config,targets){if(JSON.stringify(apply(config,targets))!==JSON.stringify(config))throw Error('独立沙箱策略不能被移除或修改；请使用安全实例迁移工具更新 Agent/出口配置');}
module.exports={apply,origins,stamp,assert};
