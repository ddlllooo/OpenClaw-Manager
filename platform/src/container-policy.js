 'use strict';
const fs = require('fs'), path = require('path');
function fail(message) { throw Object.assign(new Error(message), {statusCode:403}); }
function user(value) {
  const name=String(value || 'node');
  if (!/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/.test(name) || /^(?:0+|root)(?::|$)/i.test(name)) fail('实例禁止使用 root 用户');
  return name;
}
function mounts(opts, store, bindPath) {
  const definitions=[['configDir',store.configDir(opts.instanceId),'/home/node/.openclaw'],['workspaceDir',store.workspaceDir(opts.instanceId),'/home/node/.openclaw/workspace'],['authDir',store.authDir(opts.instanceId),'/home/node/.config/openclaw']];
  const base=path.resolve(store.instancesRoot());
  const instanceRoot=store.instanceDir?.(opts.instanceId);
  const root=instanceRoot&&new RegExp('^/Volumes/oc-'+opts.instanceId+'-[a-f0-9]{8}$').test(instanceRoot)?instanceRoot:base;
  return definitions.map(([key,expected,target])=>{
    if(path.resolve(opts[key])!==path.resolve(expected))fail('禁止挂载实例目录之外的路径');
    const relative=path.relative(root,path.resolve(expected));
    if(relative.startsWith('..')||path.isAbsolute(relative))fail('实例挂载路径越界');
    let current=root;
    for(const part of ['',...relative.split(path.sep)]) {
      current=path.join(current,part);
      let stat;
      try { stat=fs.lstatSync(current); } catch(error) { if(error.code!=='ENOENT')throw error; }
      if(stat?.isSymbolicLink())fail('实例挂载路径不能包含符号链接');
    }
    return `${bindPath(expected)}:${target}`;
  });
}
function hostConfig(template={}) {
  if(template.Privileged || (template.CapAdd||[]).length || (template.Devices||[]).length || (template.DeviceRequests||[]).length || (template.Mounts||[]).length || (template.VolumesFrom||[]).length || template.PidMode==='host' || template.IpcMode==='host' || template.UTSMode==='host' || template.UsernsMode==='host' || /^(host|container:)/.test(template.NetworkMode||'')) {
    fail('旧容器包含危险权限或挂载，请先移除后再升级；原容器未改动');
  }
  // Do not inherit arbitrary HostConfig, Binds, security profiles or namespaces.
  return {Privileged:false,CapDrop:['ALL'],CapAdd:[],SecurityOpt:['no-new-privileges:true'],
    PidMode:'',IpcMode:'private',NetworkMode:'bridge',Init:true,
    ...(template.ShmSize ? {ShmSize:template.ShmSize}:{}),
  };
}
function owned(inspected) {
  const labels=inspected.Config?.Labels || {};
  if(labels['openclaw.managed']!=='true' || !/^[a-z0-9_-]{1,80}$/i.test(labels['openclaw.instance']||''))fail('拒绝操作不属于平台实例的容器');
  return inspected;
}
function agentConfig(config, mode=process.env.OPENCLAW_AGENT_POLICY||'compatible') {
  if(!['compatible','restricted'].includes(mode))throw new Error('OPENCLAW_AGENT_POLICY 必须为 compatible 或 restricted');
  if(mode==='compatible')return config;
  config.tools||={};config.tools.fs={...config.tools.fs,workspaceOnly:true};
  config.tools.elevated={enabled:false};
  config.tools.deny=[...new Set([...(config.tools.deny||[]),'group:runtime','group:web','browser','canvas','nodes','gateway','cron','plugins','openclaw','message'])];
  return config;
}
function assertAgentConfig(config) {
  if((process.env.OPENCLAW_AGENT_POLICY||'compatible')!=='restricted')return;
  const hardened=agentConfig(JSON.parse(JSON.stringify(config)));
  if(JSON.stringify(hardened)!==JSON.stringify(config))fail('受限 Agent 策略缺失：请先应用 tools.fs.workspaceOnly、禁用 elevated 和危险工具 deny 策略');
}
module.exports={user,mounts,hostConfig,owned,agentConfig,assertAgentConfig};
