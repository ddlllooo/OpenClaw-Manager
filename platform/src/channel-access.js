'use strict';
const fs=require('fs'),store=require('./instances'),util=require('./management'),policy=require('../security/feishu-policy.cjs');
function read(instance,account){
 const targets=instance.channelIsolation.accounts,ids=Object.keys(targets),id=account||ids[0];if(!id||!targets[id])util.fail('独立飞书账号不存在',404);
 const accounts=Object.fromEntries(ids.map(key=>[key,JSON.parse(fs.readFileSync(targets[key].accessFile,'utf8'))]));
 const config={channels:{feishu:{dmPolicy:'disabled',groupPolicy:'disabled',requireMention:true,accounts}}};
 return {id,targets,accounts,config,revision:store.revision(JSON.stringify(accounts))};
}
function view(instance,account){const current=read(instance,account);return {...util.accessView(current.config,current.id),revision:current.revision,isolated:true,configured:true};}
function patch(instance,body,group=false){
 const current=read(instance,body.account);if(body.revision!==current.revision)util.fail('访问规则已修改，请刷新后重试',409);
 if(group){
  const id=util.text(body.groupId,'群 ID',200),change=body.patch;
  if(!policy.CHAT.test(id)||!change||Object.keys(change).some(k=>!['enabled','requireMention'].includes(k))||Object.values(change).some(v=>v!==null&&typeof v!=='boolean'))util.fail('独立渠道只接受具体群 ID 和布尔规则');
  const row=current.accounts[current.id];row.groups||={};row.groups[id]||={};for(const [key,value]of Object.entries(change))if(value===null)delete row.groups[id][key];else row.groups[id][key]=value;
 }else util.accessPatch(current.config,{account:current.id,patch:body.patch});
 const row=current.accounts[current.id],effective=util.accessView(current.config,current.id).effective;
 const candidate={...row,...effective},agents=util.agents(JSON.parse(store.readOpenclawConfig(instance.id))).map(a=>a.id);policy.access(candidate,agents);
 store.atomicWrite(current.targets[current.id].accessFile,JSON.stringify(candidate));
 return {ok:true,revision:view(instance,current.id).revision,hint:'独立飞书访问规则已更新；入站、执行前与发送回复前都会重新检查。'};
}
module.exports={view,patch};
