'use strict';
const {spawn}=require('child_process');
const store=require('./instances');
const failure=message=>Object.assign(new Error(message),{statusCode:409});
function createClient({platform=process.platform,env=process.env,host=require('./host-control'),execute}={}) {
  async function invoke(action,body) {
    if(env.OPENCLAW_QUOTA_CONTROL_DIR || host.enabled())return host.request(action,body,90000,env.OPENCLAW_QUOTA_CONTROL_DIR);
    if(platform!=='linux')throw failure('当前宿主系统不支持 XFS 项目配额；Docker Desktop 的全局磁盘上限不是实例硬配额');
    if(env.MANAGER_CONTAINERIZED==='1')throw failure('容器内无法证明宿主项目配额能力，请配置专用宿主配额服务 OPENCLAW_QUOTA_CONTROL_DIR');
    if(execute)return execute(action,body);
    return new Promise((resolve,reject)=>{
      const args=[require('./runtime-platform').scriptPath('storage_quota.py'),'--root',store.DATA_ROOT];
      if(env.OPENCLAW_QUOTA_REGISTRY)args.push('--registry',env.OPENCLAW_QUOTA_REGISTRY);
      const child=spawn(env.OPENCLAW_QUOTA_PYTHON||'python3',args,{windowsHide:true,stdio:['pipe','pipe','ignore']});
      let output='',settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>{child.kill();finish(failure('宿主配额操作超时；请验证实际配额后重试'));},95000);
      child.on('error',()=>finish(failure('无法启动宿主配额工具，请检查 Python 和专用服务')));
      child.stdin.on('error',()=>{});
      child.stdout.on('data',data=>{output+=data;if(output.length>2*1024*1024){child.kill();finish(failure('宿主配额响应过大'));}});
      child.on('close',code=>{try{const value=JSON.parse(output);finish(code||value.error?failure(value.error||'宿主配额操作失败'):null,value);}catch{finish(failure('宿主配额响应无效'));}});
      child.stdin.end(JSON.stringify({action,body}));
    });
  }
  return {
    async probe(id){try{return await invoke('quota-probe',{id});}catch(error){return {supported:false,backend:'xfs-project',platform,reason:error.message};}},
    status:(id,full=false)=>invoke('quota-status',{id,full}),
    apply:(id,hardBytes,hardInodes)=>invoke('quota-apply',{id,hardBytes,hardInodes}),
  };
}
module.exports={createClient,...createClient()};
