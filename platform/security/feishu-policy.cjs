'use strict';
const crypto=require('crypto');
const ACCOUNT=/^[a-z0-9][a-z0-9_-]{0,63}$/i,USER=/^ou_[A-Za-z0-9_-]{1,150}$/,CHAT=/^oc_[A-Za-z0-9_-]{1,150}$/;
function fail(message='Invalid isolated Feishu policy'){throw Error(message);}
function access(value,agents){
 if(!value||Object.keys(value).some(k=>!['agentId','dmPolicy','allowFrom','groupPolicy','groupAllowFrom','groupSenderAllowFrom','requireMention','groups','routes'].includes(k))||!agents.includes(value.agentId))fail();
 if(!['allowlist','disabled'].includes(value.dmPolicy)||!['allowlist','disabled'].includes(value.groupPolicy)||typeof value.requireMention!=='boolean')fail('独立飞书只接受明确的私聊/群白名单或 disabled，不自动放宽 pairing/open');
 for(const [key,pattern]of [['allowFrom',USER],['groupAllowFrom',CHAT],['groupSenderAllowFrom',USER]])if(!Array.isArray(value[key]||[])||(value[key]||[]).length>500||(value[key]||[]).some(v=>typeof v!=='string'||!pattern.test(v)))fail();
 if(value.groups){if(typeof value.groups!=='object'||Array.isArray(value.groups)||Object.keys(value.groups).length>500)fail();for(const [id,g]of Object.entries(value.groups))if(!CHAT.test(id)||!g||Object.keys(g).some(k=>!['enabled','requireMention'].includes(k))||Object.values(g).some(v=>typeof v!=='boolean'))fail();}
 for(const r of value.routes||[])if(!r||Object.keys(r).some(k=>!['kind','peerId','agentId'].includes(k))||!agents.includes(r.agentId)||!['p2p','group'].includes(r.kind)||!(r.kind==='group'?CHAT:USER).test(r.peerId))fail();
 return JSON.parse(JSON.stringify(value));
}
function authorize(input,policy,now=Date.now()){
 if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['messageId','chatId','senderId','chatType','text','mentionedBot','createdAt'].includes(k)))fail('Inbound fields denied');
 if(!/^om_[A-Za-z0-9_-]{1,150}$/.test(input.messageId)||!CHAT.test(input.chatId)||!USER.test(input.senderId)||!['p2p','group'].includes(input.chatType)||typeof input.text!=='string'||!input.text.trim()||input.text.length>16000||typeof input.mentionedBot!=='boolean'||!Number.isFinite(input.createdAt)||Math.abs(now-input.createdAt)>86400000)fail('Inbound message invalid or stale');
 if(/^\s*[/!]/.test(input.text)||/(?:^|\s)[/!]\s*[a-z][a-z0-9_-]*(?=\s|:|$)/i.test(input.text))fail('隔离收发层不执行渠道控制命令');
 if(input.chatType==='p2p'){
  if(policy.dmPolicy!=='allowlist'||!policy.allowFrom?.includes(input.senderId))fail('Sender denied');
 }else{
  const group=policy.groups?.[input.chatId];
  if(policy.groupPolicy!=='allowlist'||!policy.groupAllowFrom?.includes(input.chatId)||group?.enabled===false)fail('Chat denied');
  if(policy.groupSenderAllowFrom?.length&&!policy.groupSenderAllowFrom.includes(input.senderId))fail('Group sender denied');
  if((group?.requireMention??policy.requireMention)&&!input.mentionedBot)fail('Bot mention required');
 }
 const peer=input.chatType==='group'?input.chatId:input.senderId;
 const agentId=policy.routes?.find(r=>r.kind===input.chatType&&r.peerId===peer)?.agentId||policy.agentId;
 // Separate channel/account/peer histories; never let the transport supply an
 // arbitrary Agent, session key, instruction, file, attachment or tool request.
 return {agentId,peer};
}
function sessionKey(account,input,agentId){return 'agent:'+agentId+':feishu-isolated:'+crypto.createHash('sha256').update(JSON.stringify([account,input.chatType,input.chatId,input.senderId])).digest('hex').slice(0,40);}
function stripConfig(config,extraNames=[]){
 const result=structuredClone(config);if(result.channels)delete result.channels.feishu;
 result.plugins||={};result.plugins.entries||={};result.plugins.entries.feishu={enabled:false};result.plugins.deny=[...new Set([...(result.plugins.deny||[]),'feishu'])];
 if(result.env){for(const key of Object.keys(result.env))if(/^(FEISHU|LARK)_/i.test(key)||extraNames.includes(key))delete result.env[key];if(result.env.vars)for(const key of Object.keys(result.env.vars))if(/^(FEISHU|LARK)_/i.test(key)||extraNames.includes(key))delete result.env.vars[key];}
 return result;
}
function assertConfig(config,record){
 if(!record)return;
 if(JSON.stringify(stripConfig(config,record.secretEnvNames||[]))!==JSON.stringify(config))fail('独立飞书不能恢复原生渠道或凭据；请使用 isolate-feishu.cjs 管理');
 assertAgents(config,record);
}
function constrainAgents(config,accounts){
 const result=structuredClone(config),rows=require('../src/management').agents(result),defaultId=rows.find(r=>r.default)?.id||rows[0]?.id,assigned=new Set(),policies={};
 for(const a of Object.values(accounts))for(const id of new Set([a.access.agentId,...(a.access.routes||[]).map(r=>r.agentId)])){
  const row=rows.find(r=>r.id===id);if(!row||id==='main'||id===defaultId||row.workspace!=='/home/node/.openclaw/workspaces/'+id||rows.some(other=>other.id!==id&&other.workspace===row.workspace))fail('请先使用 secure-instance.cjs --add-agent 创建非默认的飞书专用 Agent 和独立工作区');
  if(assigned.has(id))fail('不同飞书账号必须使用不同的专用 Agent');assigned.add(id);
  const tools={allow:['read','write','edit'],deny:['exec','process','apply_patch','cron','gateway','message','nodes','browser','canvas','sessions_list','sessions_history','sessions_send','sessions_spawn','subagents','agents_list','memory_search','memory_get','intent','plugins','openclaw','code_execution'],elevated:{enabled:false},exec:{host:'sandbox'}};
  const target=result.agents.entries?result.agents.entries[id]:result.agents.list.find(r=>r.id===id);target.tools=tools;policies[id]={workspace:row.workspace,tools:structuredClone(tools)};
 }
 return {config:result,policies};
}
function assertAgents(config,record){
 const rows=require('../src/management').agents(config);
 for(const [id,expected]of Object.entries(record.agentPolicies||{})){
  const row=rows.find(r=>r.id===id);if(!row||row.workspace!==expected.workspace||JSON.stringify(row.tools)!==JSON.stringify(expected.tools))fail('飞书专用 Agent 的工具和工作区边界不能放宽');
 }
}
module.exports={ACCOUNT,USER,CHAT,access,authorize,sessionKey,stripConfig,assertConfig,constrainAgents,assertAgents};
