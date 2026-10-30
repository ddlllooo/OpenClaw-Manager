'use strict';
const express = require('express');
const path = require('path');
const store = require('../instances');
const docker = require('../docker');
const gateway = require('../gateway-rpc');
const util = require('../management');
const { redact } = require('../instance-features');
const pluginInstall = require('../plugin-install');
const installer = pluginInstall.createInstaller({ rpc: (...args) => gateway.rpc(...args) });
function pluginResult(result, config, instance) {
  if (!result.reviewRequired) return redact(result, config, instance);
  // Permission groups may legitimately be named env, headers, or tokens. Do
  // not replace whole groups with redaction placeholders and then grant them.
  // Refuse a report containing sensitive values rather than hide its content.
  function check(node) {
    if (typeof node === 'string' && redact(node, config, instance) !== node) util.fail('审查报告包含需脱敏的内容，无法完整展示，拒绝安装；请在受信任终端检查',403);
    if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) { check(key); check(value); }
  }
  check(result);
  return result;
}
const router = express.Router();
router.use('/:id', (req, res, next) => {
  try { req.instance = store.loadInstance(req.params.id); next(); } catch { res.status(404).json({error:'实例不存在'}); }
});
const run = fn => async (req, res) => { try { await fn(req,res); } catch(error) {
  let config={};try{config=JSON.parse(store.readOpenclawConfig(req.instance.id)||'{}');}catch{}
  res.status(error.statusCode || 400).json({error:redact(String(error.message).slice(0,1600),config,req.instance)});
}};
async function running(instance) {
  if (!instance.containerId || !(await docker.inspectContainer(instance.containerId)).State.Running) util.fail('请先启动实例',409);
}
function read(req, check = false) {
  const raw=store.readOpenclawConfig(req.instance.id)||'{}', config=JSON.parse(raw), revision=store.revision(JSON.stringify(config));
  if(check && req.body.revision!==revision) util.fail('配置已修改，请刷新后合并；未覆盖现有配置',409);
  return {raw,config,revision};
}
async function commit(req, before) {
  const content=JSON.stringify(before.config,null,2)+'\n';
  if(JSON.stringify(JSON.parse(before.raw))===JSON.stringify(before.config)) return before.revision;
  await running(req.instance);
  await require('../validation').validate(req.instance,content);
  if(store.readOpenclawConfig(req.instance.id)!==before.raw) util.fail('配置在校验期间已修改，请刷新后合并',409);
  store.atomicWrite(path.join(store.configDir(req.instance.id),'openclaw.json.management-last-good'),before.raw);
  store.writeOpenclawConfig(req.instance.id,content);
  return store.revision(JSON.stringify(before.config));
}
router.get('/:id/failover',run(async(req,res)=>{
  const {config,revision}=read(req);const defaults=config.agents?.defaults||{};
  const normalize=m=>typeof m==='string'?{primary:m,fallbacks:[]}: {primary:m?.primary||'',fallbacks:m?.fallbacks||[]};
  res.json({revision,models:util.choices(config),model:normalize(defaults.model),imageModel:normalize(defaults.imageModel)});
}));
router.put('/:id/failover',run(async(req,res)=>{
  const before=read(req,true);util.failover(before.config,req.body);res.json({ok:true,revision:await commit(req,before),hint:'策略已保存，由 OpenClaw 按备用顺序自动切换。现有会话可能保留当前模型；可新建会话验证。'});
}));
router.get('/:id/feishu-access',run(async(req,res)=>res.json(req.instance.channelIsolation?require('../channel-access').view(req.instance,String(req.query.account||'')):util.accessView(read(req).config,String(req.query.account||'')))));
router.put('/:id/feishu-access',run(async(req,res)=>{
  if(req.instance.channelIsolation){res.json(require('../channel-access').patch(req.instance,req.body));return;}
  const before=read(req,true);util.accessPatch(before.config,req.body);
  res.json({ok:true,revision:await commit(req,before),hint:'访问规则已保存，OpenClaw 将重新加载渠道；部分版本会短暂重启网关。单独群聊的覆盖规则仍优先生效。'});
}));
router.put('/:id/feishu-access/group',run(async(req,res)=>{
  if(req.instance.channelIsolation){res.json(require('../channel-access').patch(req.instance,req.body,true));return;}
  const before=read(req,true),account=req.body.account||'';util.accessView(before.config,account);
  const group=util.text(req.body.groupId,'群 ID',200);if(group!=='*'&&!/^oc_[A-Za-z0-9_-]+$/.test(group))util.fail('请填写 oc_ 开头的群 ID，或 * 表示默认群规则');
  const patch=req.body.patch;if(!patch||Object.keys(patch).some(k=>!['enabled','requireMention'].includes(k))||Object.values(patch).some(v=>v!==null&&typeof v!=='boolean'))util.fail('群聊规则不合法');
  before.config.channels||={};before.config.channels.feishu||={};const row=account?before.config.channels.feishu.accounts[account]:before.config.channels.feishu;
  row.groups||={};const entry={...row.groups[group]};for(const [k,v]of Object.entries(patch)){if(v===null)delete entry[k];else entry[k]=v;}
  if(Object.keys(entry).length)row.groups[group]=entry;else delete row.groups[group];
  res.json({ok:true,revision:await commit(req,before),hint:'群聊覆盖规则已保存。'});
}));
router.get('/:id/feishu-access/pairing',run(async(req,res)=>{
  if(req.instance.channelIsolation)util.fail('独立飞书使用显式用户白名单，不读取原生配对库',409);
  await running(req.instance);
  const args=['pairing','list','feishu','--json'];if(req.query.account) args.push('--account',util.text(req.query.account,'账号'));
  res.json(util.jsonOutput(await gateway.cli(req.instance,args)));
}));
router.post('/:id/feishu-access/pairing/approve',run(async(req,res)=>{
  if(req.instance.channelIsolation)util.fail('请在独立飞书访问设置中批准明确的用户 ID',409);
  await running(req.instance);const code=util.text(req.body.code,'配对码',20);if(!/^[A-Za-z0-9-]+$/.test(code))util.fail('配对码不合法');
  const args=['pairing','approve','feishu',code];if(req.body.account)args.push('--account',util.text(req.body.account,'账号'));
  // No --notify: approving access does not send an outbound message.
  const result=await gateway.cli(req.instance,args);res.json({ok:true,hint:redact(result,read(req).config,req.instance)});
}));
router.get('/:id/extensions',run(async(req,res)=>{
  await running(req.instance);const {config,revision}=read(req);
  const agent=req.query.agentId?util.agentId(req.query.agentId):util.agents(config)[0].id;
  const [skills,plugins]=await Promise.all([gateway.rpc(req.instance,'skills.status',{agentId:agent}),gateway.cli(req.instance,['plugins','list','--json']).then(util.jsonOutput)]);
  const isolatedPlugins=Object.entries(req.instance.pluginIsolation?.targets||{}).map(([id,t])=>({id,tools:t.tools.map(tool=>tool.name),origins:t.origins||[],execution:'isolated-container',dataAccess:'none'}));
  const isolatedChannels=Object.entries(req.instance.channelIsolation?.accounts||{}).map(([id,t])=>({id,state:t.state,mode:'text-only'}));
  res.json(redact({revision,isolatedPlugins,isolatedChannels,agentId:agent,agents:util.agents(config).map(a=>({id:a.id,name:a.name||a.id})),skills:util.publicSkills(skills.skills||[]),plugins:plugins.plugins||[],diagnostics:plugins.diagnostics||plugins.registry?.diagnostics||[]},config,req.instance));
}));
router.put('/:id/extensions/skill',run(async(req,res)=>{
  const before=read(req,true);await running(req.instance);
  const key=util.text(req.body.skillKey,'技能标识',160);
  const data=await gateway.rpc(req.instance,'skills.status',{agentId:util.agentId(req.body.agentId)});
  if(!data.skills?.some(s=>(s.skillKey||s.name)===key))util.fail('技能不存在');
  if(typeof req.body.enabled!=='boolean')util.fail('启用状态不合法');
  before.config.skills||={};before.config.skills.entries||={};
  before.config.skills.entries[key]={...before.config.skills.entries[key],enabled:req.body.enabled};
  res.json({ok:true,revision:await commit(req,before),hint:'技能启用状态已保存；缺少的依赖仍需安装后才能使用。'});
}));
router.get('/:id/extensions/skill/search',run(async(req,res)=>{
  await running(req.instance);const query=util.text(req.query.q,'搜索词',100);
  res.json(await gateway.rpc(req.instance,'skills.search',{query,limit:15},{timeout:60000}));
}));
router.get('/:id/extensions/skill/detail',run(async(req,res)=>{
  await running(req.instance);res.json(await gateway.rpc(req.instance,'skills.detail',{slug:util.text(req.query.slug,'技能来源',200)},{timeout:60000}));
}));
router.post('/:id/extensions/skill/install',run(async(req,res)=>{
  read(req,true);await running(req.instance);
  const slug=util.text(req.body.slug,'技能来源',200);if(!/^(?:(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+|skills-sh:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/.test(slug))util.fail('请选择 ClawHub 技能来源');
  const params={agentId:util.agentId(req.body.agentId),source:'clawhub',slug,timeoutMs:120000};
  if(req.body.version)params.version=util.text(req.body.version,'版本',80);
  const result=await gateway.rpc(req.instance,'skills.install',params,{timeout:150000});
  if(result?.ok===false||result?.success===false)util.fail(result.message||result.error||result.stderr||'技能安装未成功，请检查来源、依赖和安全策略');
  res.json({ok:true,result,hint:'安装请求已完成，请刷新查看技能依赖和可用状态。'});
}));
router.put('/:id/extensions/plugin',run(async(req,res)=>{
  const before=read(req,true);await running(req.instance);const id=util.text(req.body.pluginId,'插件标识');
  if(id==='feishu'&&req.instance.channelIsolation)util.fail('独立飞书不能恢复原生插件执行',409);
  if(id==='manager-isolated-tools'||req.instance.pluginIsolation?.targets?.[id])util.fail('独立插件请使用 isolate-plugin.cjs 管理，不能切换回原生执行',409);
  const data=util.jsonOutput(await gateway.cli(req.instance,['plugins','list','--json']));
  if(!data.plugins?.some(p=>p.id===id))util.fail('插件不存在');
  if(typeof req.body.enabled!=='boolean')util.fail('启用状态不合法');
  // Delegate enablement to the owner so stored consent and widened surfaces
  // cannot be bypassed by directly writing entries.enabled.
  if(req.body.enabled && before.config.plugins?.deny?.includes(id))util.fail('插件位于 deny 列表，请先在配置文件中调整');
  const result=await gateway.rpc(req.instance,'plugins.setEnabled',{pluginId:id,enabled:req.body.enabled});
  if(result?.ok===false)util.fail('插件状态未更新，请检查权限和运行时状态');
  res.json({ok:true,hint:'插件状态已更新。若运行时提示需要重启，请使用顶部“重启”。'});
}));
router.post('/:id/extensions/plugin/review',run(async(req,res)=>{
  if(req.instance.channelIsolation&&/^@openclaw\/feishu@/.test(req.body.spec||''))util.fail('独立飞书不能恢复原生插件',409);
  const before=read(req,true);await running(req.instance);
  const review=await installer.prepare(pluginInstall.context(req,before.revision),req.body.spec);
  // Registry lookups must not silently approve an intervening config change.
  read(req,true);
  res.json(pluginResult(review,before.config,req.instance));
}));
router.post('/:id/extensions/plugin/install',run(async(req,res)=>{
  const before=read(req,true);await running(req.instance);
  const result=await installer.install(pluginInstall.context(req,before.revision),req.instance,req.body);
  res.json(pluginResult(result,read(req).config,req.instance));
}));
router.post('/:id/extensions/plugin/uninstall',run(async(req,res)=>{
  read(req,true);await running(req.instance);const id=util.text(req.body.pluginId,'插件标识');
  if(id==='feishu'&&req.instance.channelIsolation)util.fail('独立飞书不能通过原生卸载入口修改',409);
  if(id==='manager-isolated-tools'||req.instance.pluginIsolation?.targets?.[id])util.fail('请先使用 isolate-plugin.cjs 移除独立执行策略',409);
  if(!/^[A-Za-z0-9._-]+$/.test(id))util.fail('插件标识不合法');
  const data=util.jsonOutput(await gateway.cli(req.instance,['plugins','list','--json']));
  const plugin=data.plugins?.find(p=>p.id===id);if(!plugin)util.fail('插件不存在');
  if(plugin.origin==='bundled')util.fail('内置插件仅支持停用');
  const result=await gateway.cli(req.instance,['plugins','uninstall',id,'--force'],120000);
  res.json({ok:true,hint:redact(result,read(req).config,req.instance)+'\n请重启实例。'});
}));
router.get('/:id/agents',run(async(req,res)=>{
  await running(req.instance);const {config,revision}=read(req);
  const data=await gateway.rpc(req.instance,'agents.list');
  const configured=util.agents(config);
  const defaultModel=config.agents?.defaults?.model;
  res.json({...data,revision,defaultModel:typeof defaultModel==='string'?defaultModel:defaultModel?.primary||'',models:util.choices(config),agents:data.agents.map(a=>{
    const row=configured.find(r=>r.id===a.id)||{};
    return {...a,name:row.name||a.name||a.id,workspace:row.workspace||a.workspace||'',modelOverride:row.model??null};
  }),bindings:(config.bindings||[]).map(row=>({...row,managerId:store.revision(JSON.stringify(row))}))});
}));
router.post('/:id/agents',run(async(req,res)=>{
  if(req.instance.security?.profile==='ssh-sandbox-v1')util.fail('请使用 secure-instance.cjs --add-agent 配置独立执行容器',409);
  const {config}=read(req,true);await running(req.instance);
  const id=util.agentId(req.body.agentId);if(id==='main'||util.agents(config).some(a=>a.id===id))util.fail('Agent ID 已存在或保留');
  const name=util.text(req.body.name||id,'名称');
  const params={name:id,workspace:`/home/node/.openclaw/workspaces/${id}`};
  if(req.body.model)params.model=util.modelRef(config,req.body.model);
  const result=await gateway.rpc(req.instance,'agents.create',params,{timeout:90000});
  if(name!==id)await gateway.rpc(req.instance,'agents.update',{agentId:result.agentId,name});
  res.json({ok:true,...result,hint:'Agent 已创建，使用独立工作区。可添加飞书路由或直接开始对话。'});
}));
router.put('/:id/agents/:agentId',run(async(req,res)=>{
  const {config}=read(req,true);await running(req.instance);const id=util.agentId(req.params.agentId);
  if(!util.agents(config).some(a=>a.id===id))util.fail('Agent 不存在',404);
  const params={agentId:id};
  if(Object.hasOwn(req.body,'name'))params.name=util.text(req.body.name,'名称');
  if(Object.hasOwn(req.body,'model'))params.model=req.body.model===null?null:util.modelRef(config,req.body.model);
  res.json(await gateway.rpc(req.instance,'agents.update',params));
}));
router.delete('/:id/agents/:agentId',run(async(req,res)=>{
  const before=read(req,true);await running(req.instance);const id=util.agentId(req.params.agentId);
  const jobs=await gateway.rpc(req.instance,'cron.list',{includeDisabled:true,limit:100,offset:0});
  if(jobs.jobs?.some(j=>j.agentId===id&&require('../instance-features').editableJob(j)))util.fail('此 Agent 仍有定时任务，请先删除或改派任务');
  // If more jobs exist, do not assume an unchecked page contains no references.
  for(let offset=100; jobs.hasMore || Number(jobs.total)>offset; offset+=100) {
    const page=await gateway.rpc(req.instance,'cron.list',{includeDisabled:true,limit:100,offset});
    if(page.jobs?.some(j=>j.agentId===id&&require('../instance-features').editableJob(j)))util.fail('此 Agent 仍有定时任务，请先删除或改派任务');
    if(!page.hasMore&&!(Number(page.total)>offset+100))break;
    if(offset>=10000)util.fail('任务过多，无法完整校验引用，请先在控制台检查');
  }
  util.removeAgent(before.config,id);
  res.json({ok:true,revision:await commit(req,before),hint:'已移除 Agent 配置及其消息路由，工作区与会话数据保留。'});
}));
router.post('/:id/agent-bindings',run(async(req,res)=>{
  if(req.instance.channelIsolation)util.fail('独立飞书路由由受限渠道策略管理；请使用其 routes 配置',409);
  const before=read(req,true);util.bindingPatch(before.config,req.body);res.json({ok:true,revision:await commit(req,before)});
}));
router.delete('/:id/agent-bindings/:bindingId',run(async(req,res)=>{
  if(req.instance.channelIsolation)util.fail('独立飞书路由由受限渠道策略管理',409);
  const before=read(req,true);const rows=before.config.bindings||[];const index=rows.findIndex(r=>store.revision(JSON.stringify(r))===req.params.bindingId);
  if(index<0)util.fail('路由已变化，请刷新',409);rows.splice(index,1);res.json({ok:true,revision:await commit(req,before)});
}));
router.get('/:id/agents/:agentId/file',run(async(req,res)=>{
  await running(req.instance);const name=util.text(req.query.name,'文件名');
  if(!require('../workspace-files').ROOT_FILES.includes(name))util.fail('只支持角色规则文件');
  const result=await gateway.rpc(req.instance,'agents.files.get',{agentId:util.agentId(req.params.agentId),name});
  res.json({...result,revision:store.revision(JSON.stringify(result.file))});
}));
router.put('/:id/agents/:agentId/file',run(async(req,res)=>{
  await running(req.instance);const name=util.text(req.body.name,'文件名');
  if(!require('../workspace-files').ROOT_FILES.includes(name))util.fail('只支持角色规则文件');
  const agentId=util.agentId(req.params.agentId),params={agentId,name};
  const before=await gateway.rpc(req.instance,'agents.files.get',params);
  if(req.body.revision!==store.revision(JSON.stringify(before.file)))util.fail('文件已更新，请重新加载后合并',409);
  if(typeof req.body.content!=='string'||Buffer.byteLength(req.body.content)>256*1024)util.fail('内容不能超过 256KB');
  res.json(await gateway.rpc(req.instance,'agents.files.set',{...params,content:req.body.content}));
}));
module.exports=router;
