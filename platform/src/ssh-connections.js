'use strict';
const {Client} = require('ssh2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar-stream');
const {createProxy,requestJSON} = require('./ssh-proxy');
const connections = new Map();
let profileStore=null,shuttingDown=false,retryDelays=[3000,10000,30000,60000];
const active=record=>['connecting','connected','ssh-ready'].includes(record.status);
const sameTarget=(a,b)=>['host','port','username','remotePort'].every(key=>a[key]===b[key]);

function fingerprint(key) {return 'SHA256:'+crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/,'');}
function error(message, statusCode=400) {return Object.assign(new Error(message),{statusCode});}
function deviceDetails(body,fallback={}){
  const result={};
  for(const [key,max]of [['name',80],['notes',1000]]){
    const value=body[key]===undefined?fallback[key]||'':body[key];
    if(typeof value!=='string'||value.length>max||(key==='name'?/[\x00-\x1f\x7f]/:/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/).test(value))throw error(key==='name'?'设备名称需为 80 字以内的单行文字':'备注需为 1000 字以内的文字');
    result[key]=value.trim();
  }
  return result;
}
function normalize(body, authentication=true) {
  const host=String(body.host||'').trim(),username=String(body.username||'').trim();
  const port=Number(body.port??22),remotePort=Number(body.remotePort??18080);
  if(!host||host.length>253||/[\s\x00-\x1f/\\]/.test(host))throw error('SSH 主机地址不合法');
  if(!Number.isInteger(port)||port<1||port>65535)throw error('SSH 端口不合法');
  if(!Number.isInteger(remotePort)||remotePort<1024||remotePort>65535)throw error('远程管理端口需为 1024–65535');
  if(authentication && (!username||username.length>128||/[\x00-\x1f]/.test(username)))throw error('请填写 SSH 用户名');
  if(authentication && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(body.fingerprint||''))throw error('请先获取并核对 SSH 主机指纹');
  const auth=body.auth||'password';
  if(authentication && !['password','key','agent'].includes(auth))throw error('不支持的 SSH 认证方式');
  if(authentication && auth==='password' && (typeof body.password!=='string'||!body.password))throw error('请填写 SSH 密码');
  if(authentication && auth==='key' && (typeof body.privateKey!=='string'||!body.privateKey||body.privateKey.length>65536))throw error('请提供有效的私钥内容');
  if(authentication && auth==='agent' && !process.env.SSH_AUTH_SOCK)throw error('未检测到 SSH_AUTH_SOCK，请使用密码或私钥');
  return {host,port,username,remotePort,auth};
}
async function probe(body) {
  const target=normalize(body,false),client=new Client();
  return new Promise((resolve,reject)=>{
    let seen=false;
    client.on('error',e=>{if(!seen)reject(error('SSH 握手失败：'+e.message,502));});
    client.once('close',()=>{if(!seen)reject(error('SSH 握手已关闭',502));});
    client.connect({...target,username:'fingerprint-probe',readyTimeout:10000,hostVerifier:key=>{
      seen=true;resolve({fingerprint:fingerprint(key),host:target.host,port:target.port});
      setImmediate(()=>client.end());return false;
    }});
  });
}
function login(target, body, record) {
  const client = record.client = new Client();
  let hostMismatch=false;
  const auth=target.auth==='key'?{privateKey:body.privateKey,passphrase:body.passphrase||undefined}:
    target.auth==='agent'?{agent:process.env.SSH_AUTH_SOCK}:{password:body.password};
  return new Promise((resolve,reject)=>{
    client.once('ready',()=>resolve(client));
    client.once('error',e=>reject(Object.assign(error(hostMismatch?'SSH 主机指纹已变化，请通过可信渠道重新核对':e.level==='client-authentication'?'SSH 认证失败，请更新设备认证信息':'SSH 连接失败：'+e.message,502),{retryBlocked:hostMismatch||e.level==='client-authentication'})));
    client.once('close',()=>reject(error('SSH 连接已关闭',502)));
    client.on('error',()=>{});
    client.connect({host:target.host,port:target.port,username:target.username,...auth,readyTimeout:15000,
      keepaliveInterval:10000,keepaliveCountMax:3,
      hostVerifier:key=>{hostMismatch=fingerprint(key)!==body.fingerprint;return !hostMismatch;}});
  });
}
// Double quoting works in POSIX shells, PowerShell and cmd.exe. Only generated,
// restricted Docker arguments enter a remote command; credentials never do.
function dockerCommand(args) {
  return 'docker '+args.map(value=>{
    const text=String(value);
    if(!/^[a-zA-Z0-9_./:@={},+ -]+$/.test(text))throw error('远程 Docker 参数不合法');
    return '"'+text+'"';
  }).join(' ');
}
function execute(client,args,input,timeout=30000,options={}) {
  return new Promise((resolve,reject)=>{
    let channel,timer,settled=false;
    const finish=(err,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
      input?.destroy();
      if(err){channel?.close?.();channel?.destroy();reject(err);}else resolve(value);
    };
    const abort=()=>finish(Object.assign(new Error('镜像传输已取消'),{code:'ABORT_ERR'}));
    input?.once('error',e=>finish(e));
    if(options.signal?.aborted){abort();return;}
    options.signal?.addEventListener('abort',abort,{once:true});
    let command;try{command=dockerCommand(args);}catch(e){finish(e);return;}
    client.exec(command,(err,stream)=>{
      if(err){finish(err);return;}
      channel=stream;if(settled){stream.close?.();stream.destroy();return;}
      let stdout='',stderr='',overflow=false;
      timer=setTimeout(()=>finish(error('远程 Docker 操作超时',504)),timeout);
      stream.on('data',b=>{stdout+=b;if(stdout.length>2*1024*1024){overflow=true;finish(error('远程输出过大',502));}});
      stream.stderr.on('data',b=>{stderr=(stderr+b).slice(-3000);});
      stream.on('error',e=>finish(e));
      stream.on('close',code=>{
        if(overflow)return;
        if(code!==0)return finish(error('远程 Docker 执行失败：'+stderr.slice(-700),502));
        finish(null,stdout.trim());
      });
      if(input){input.once('end',()=>options.onInputEnd?.());input.pipe(stream);}else stream.end();
    });
  });
}
function sourceArchive(root=path.join(__dirname,'..')) {
  const pack=tar.pack();
  // Explicit allowlist: never upload local data, credentials, ops or node_modules.
  const add=relative=>{
    let file=path.join(root,relative);
    // electron-builder excludes package-lock.json even when explicitly listed.
    // The desktop build ships an explicitly renamed copy for Docker builds.
    if(relative==='package-lock.json'&&!fs.existsSync(file))file=path.join(root,'deployment-lock.json');
    const stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())throw error('部署源码不能包含符号链接');
    if(stat.isDirectory()){for(const child of fs.readdirSync(file))if(child!=='__pycache__')add(relative+'/'+child);return;}
    if(!stat.isFile())throw error('部署源码包含不支持的文件');
    pack.entry({name:relative.replace(/\\/g,'/'),mode:0o644,size:stat.size},fs.readFileSync(file));
  };
  setImmediate(()=>{try{for(const name of ['Dockerfile','package.json','package-lock.json','server.js','src','public','scripts','control-ui-patches'])add(name);pack.finalize();}catch(e){pack.destroy(e);}});
  return pack;
}
async function provision(client,target,record,options={}) {
  record.stage='正在检查远程 Docker';
  const info=JSON.parse(await execute(client,['info','--format','{{json .}}']));
  if(info.OSType!=='linux')throw error('目标 Docker 需要切换到 Linux 容器模式');
  const name='openclaw-manager-ssh-'+target.remotePort;
  // Never replace an existing container. Reuse only our explicitly owned manager.
  const listed=await execute(client,['container','ls','-a','--filter','name='+name,'--format','{{json .}}']);
  const found=listed.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).find(row=>row.Names===name);
  if(found){
    const row=JSON.parse(await execute(client,['inspect',name]))[0];
    if(row.Config?.Labels?.['openclaw.ssh-manager']!=='true')throw error('同名容器已存在且不属于 SSH 部署，请更换远程管理端口');
    if(!row.State?.Running)await execute(client,['start',name]);
    record.stage='已复用远程管理服务';return;
  }
  const image=options.managerImage||'openclaw-manager:ssh-20261016';
  const buildArgs=[];
  for(const key of ['NODE_IMAGE','DOCKER_CLI_IMAGE'])if(process.env['OPENCLAW_SSH_'+key])buildArgs.push('--build-arg',key+'='+process.env['OPENCLAW_SSH_'+key]);
  if(options.offline){
    const cached=JSON.parse(await execute(client,['image','inspect',image]))[0];
    if(cached?.Config?.Labels?.['openclaw.manager']!=='true')throw error('请先传输带有 openclaw.manager=true 标记的 Manager 镜像');
  }else{
    record.stage='正在远程构建管理服务镜像（首次可能需要数分钟）';
    await execute(client,['build',...buildArgs,'-t',image,'-'],sourceArchive(),600000);
  }
  record.stage='正在准备远程持久化存储';
  const volume=name+'-data';
  await execute(client,['volume','create',volume]);
  const data=JSON.parse(await execute(client,['volume','inspect',volume]))[0];
  const root=data.Mountpoint;
  if(typeof root!=='string'||!/^\/[a-zA-Z0-9_./-]+$/.test(root))throw error('远程 Docker 数据卷路径不受支持');
  let socket='/var/run/docker.sock';
  if(info.SecurityOptions?.some(option=>option.includes('rootless'))){
    const endpoint=JSON.parse(await execute(client,['context','inspect','--format','{{json .Endpoints.docker.Host}}']));
    if(typeof endpoint!=='string'||!/^unix:\/\/\/[a-zA-Z0-9_./-]+$/.test(endpoint))throw error('无法确定目标设备的 rootless Docker socket');
    socket=endpoint.slice(7);
  }
  const setup=`const fs=require('fs');fs.chownSync(${JSON.stringify(root)},1000,1000);process.stdout.write(String(fs.statSync('/var/run/docker.sock').gid));`;
  const group=await execute(client,['run','--pull=never','--rm','-i','--entrypoint','node','-v',`${volume}:${root}`,
    '-v',`${socket}:/var/run/docker.sock`,image],require('stream').Readable.from([setup]));
  if(!/^\d+$/.test(group))throw error('无法确定远程 Docker socket 权限');
  record.stage='正在启动远程管理服务';
  await execute(client,['run','--pull=never','-d','--init','--user','1000:1000','--group-add',group,'--name',name,'--label','openclaw.ssh-manager=true','--label','openclaw.manager=true',
    '--restart','unless-stopped','-p',`127.0.0.1:${target.remotePort}:${target.remotePort}`,
    '-v',`${volume}:${root}`,'-v',`${socket}:/var/run/docker.sock`,
    '-e',`MANAGER_PORT=${target.remotePort}`,'-e',`OPENCLAW_DATA_DIR=${root}/instances`,
    '-e',`OPENCLAW_BACKUP_DIR=${root}/backups`,'-e',`OPENCLAW_DEPLOYMENT_TARGET=${target.host}`,
    '--log-driver','json-file','--log-opt','max-size=10m','--log-opt','max-file=3',image]);
}
function view(record) {
  return {id:record.id,host:record.host,port:record.port,username:record.username,remotePort:record.remotePort,
    name:record.name||'',notes:record.notes||'',
    status:record.status,stage:record.stage,url:record.proxy?.url||null,error:record.error||null,
    transfer:record.transfer?require('./image-transfer').view(record.transfer):null,
    saved:!!record.saved,auth:record.auth,fingerprint:record.fingerprint,sshOnly:!!record.sshOnly,
    autoReconnect:!!record.autoReconnect,paused:!!record.paused,nextRetryAt:record.nextRetryAt||null,retryBlocked:!!record.retryBlocked};
}
function dispose(record) {
  clearTimeout(record.retryTimer);record.retryTimer=null;record.nextRetryAt=null;
  record.generation=(record.generation||0)+1;
  if(record.transfer?.status==='running')record.transfer.controller.abort();
  record.proxy?.close();record.proxy=null;const client=record.client;record.client=null;client?.end();
}
function savedProfile(record){return profileStore?.load().find(row=>row.id===record.id);}
function updateProfile(record,changes){const profile=savedProfile(record);if(!profile)throw error('设备认证信息未保存，请重新填写连接信息',409);profileStore.put({...profile,...changes});Object.assign(record,changes);}
function close(record) {
  if(record.saved)updateProfile(record,{paused:true});
  record.status='disconnected';record.stage='SSH 隧道已断开，远程实例继续运行；自动重连已暂停';
  dispose(record);
}
function scheduleRetry(record){
  if(shuttingDown||!record.saved||!record.autoReconnect||record.paused||record.retryBlocked)return;
  clearTimeout(record.retryTimer);
  const delay=retryDelays[Math.min(record.retryAttempts||0,retryDelays.length-1)];record.retryAttempts=(record.retryAttempts||0)+1;
  record.nextRetryAt=new Date(Date.now()+delay).toISOString();record.stage='等待自动重连';
  record.retryTimer=setTimeout(()=>{
    record.retryTimer=null;record.nextRetryAt=null;
    if(shuttingDown||record.paused||!record.autoReconnect)return;
    if([...connections.values()].filter(active).length>=8){scheduleRetry(record);return;}
    try{reconnect(record);}catch{record.error='自动重连无法读取已保存的认证信息，请检查设备存储';record.retryBlocked=true;record.stage='需要处理';}
  },delay);record.retryTimer.unref?.();
}
function failed(record,e,generation){
  if(record.generation!==generation||shuttingDown)return;
  record.status='error';record.error=e.message;record.retryBlocked=!!e.retryBlocked;record.stage=record.retryBlocked?'请更新设备认证信息':'连接失败';
  dispose(record);scheduleRetry(record);
}
async function run(record,target,body) {
  const generation=record.generation;
  try {
    const client=await login(target,body,record);
    // Release the request's credential references immediately after authentication.
    delete body.password;delete body.privateKey;delete body.passphrase;
    if(record.generation!==generation){client.end();return;}
    client.once('close',()=>failed(record,error('SSH 连接已断开'),generation));
    if(body.sshOnly===true){record.status='ssh-ready';record.stage='SSH 已连接，可离线传输镜像；远程 Manager 尚未连接';record.retryAttempts=0;return;}
    if(body.deploy===true)await provision(client,target,record);
    if(record.generation===generation)await attachManager(record,target,generation);
  }catch(e){
    failed(record,e,generation);
  }finally{delete body.password;delete body.privateKey;delete body.passphrase;}
}
async function attachManager(record,target,generation=record.generation){
    const client=record.client;
    record.stage='正在等待远程管理服务';
    let ready=false;
    for(let i=0;i<30;i++){
      if(record.status!=='connecting'||record.generation!==generation)return;
      try{await requestJSON(client,target.remotePort,'/api/session',{host:`127.0.0.1:${target.remotePort}`});ready=true;break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    if(record.status!=='connecting'||record.generation!==generation)return;
    if(!ready)throw error('远程管理服务未就绪，请检查 Docker 日志和管理端口',502);
    const proxy=await createProxy(client,target.remotePort,()=>require('./device-context').context(connections,record));
    if(record.status!=='connecting'||record.generation!==generation){proxy.close();return;}
    record.proxy=proxy;record.status='connected';record.retryAttempts=0;record.stage='已通过 SSH 连接，当前使用远程设备资源';
}
function deployOffline(record){
  if(record.status!=='ssh-ready')throw error('请先建立仅 SSH 连接',409);
  if(record.transfer?.status==='running')throw error('请等待当前镜像传输完成',409);
  record.status='connecting';delete record.error;
  void (async()=>{
    const generation=record.generation;
    try{await provision(record.client,record,record,{offline:true,managerImage:record.managerImage});if(record.generation!==generation)return;await attachManager(record,record,generation);if(record.status==='connected'){if(record.saved)updateProfile(record,{sshOnly:false});else record.sshOnly=false;}}
    catch(e){if(record.status==='connecting'){record.status='ssh-ready';record.stage='离线启动 Manager 失败';record.error=e.message;}}
  })();
  return view(record);
}
function connect(body) {
  const target=normalize(body);
  if(body.save===true&&!profileStore)start();
  const previous=[...connections.values()].find(r=>sameTarget(r,target));
  if(previous&&active(previous)&&(previous.saved||body.save===true||previous.status==='connecting'))throw error('该设备已连接或正在连接，请先断开再更新认证信息',409);
  if([...connections.values()].filter(active).length>=8)throw error('最多同时连接 8 台设备',409);
  for(const [id,r]of connections)if(!r.saved&&!active(r)){dispose(r);connections.delete(id);}
  const record={id:previous?.saved?previous.id:crypto.randomBytes(12).toString('hex'),...target,
    ...deviceDetails(body,previous),
    fingerprint:body.fingerprint,sshOnly:body.sshOnly===true,saved:body.save===true,autoReconnect:body.save===true&&body.autoReconnect!==false,paused:false};
  if(record.saved){
    const credentials=target.auth==='key'?{privateKey:body.privateKey,passphrase:body.passphrase||''}:target.auth==='password'?{password:body.password}:{};
    profileStore.put({...record,credentials});
  }else if(previous?.saved)profileStore.remove(previous.id);
  if(previous&&!active(previous))dispose(previous);
  connections.set(record.id,record);begin(record,{...body});return view(record);
}
function begin(record,body){
  dispose(record);record.status='connecting';record.stage='正在建立 SSH 连接';record.error=null;record.retryBlocked=false;
  void run(record,record,body);
}
function reconnect(record){
  if(active(record))throw error('该设备已连接或正在连接',409);
  if([...connections.values()].filter(active).length>=8)throw error('最多同时连接 8 台设备',409);
  const profile=savedProfile(record);if(!profile)throw error('设备认证信息未保存，请重新填写连接信息',409);
  if(record.paused)updateProfile(record,{paused:false});shuttingDown=false;
  begin(record,{...profile,...profile.credentials,deploy:false});return view(record);
}
function preferences(record,body){
  if(typeof body.autoReconnect!=='boolean')throw error('请指定是否自动重连');
  return edit(record,{autoReconnect:body.autoReconnect});
}
function edit(record,body){
  const allowed=['name','notes','host','port','username','remotePort','auth','fingerprint','sshOnly','password','privateKey','passphrase','autoReconnect'];
  if(!Object.keys(body).length||Object.keys(body).some(key=>!allowed.includes(key)))throw error('包含不支持的设备设置');
  for(const key of ['sshOnly','autoReconnect'])if(body[key]!==undefined&&typeof body[key]!=='boolean')throw error('设备连接选项需为布尔值');
  const profile=savedProfile(record);if(!profile)throw error('请先保存设备后再编辑',409);
  const next={...profile,...deviceDetails(body,profile)};
  for(const key of ['host','port','username','remotePort','auth','fingerprint','sshOnly','autoReconnect'])if(body[key]!==undefined)next[key]=body[key];
  const target=normalize(next,false),newHost=target.host!==profile.host||target.port!==profile.port,authChanged=target.auth!==profile.auth;
  if(newHost&&!/^SHA256:[A-Za-z0-9+/]{43}$/.test(body.fingerprint||''))throw error('主机或 SSH 端口已变化，请重新获取并核对目标设备指纹');
  let credentials=newHost||authChanged?{}:{...profile.credentials};
  if(target.auth==='password'){
    if(body.password!==undefined&&body.password!=='')credentials.password=body.password;
    credentials={password:credentials.password};
  }else if(target.auth==='key'){
    if(body.privateKey!==undefined&&body.privateKey!==''){
      credentials.privateKey=body.privateKey;credentials.passphrase=body.passphrase||'';
    }else if(body.passphrase!==undefined)credentials.passphrase=body.passphrase;
    credentials={privateKey:credentials.privateKey,passphrase:credentials.passphrase||''};
  }else credentials={};
  if(!target.username||target.username.length>128||/[\x00-\x1f]/.test(target.username))throw error('请填写 SSH 用户名');
  if([...connections.values()].some(other=>other.id!==record.id&&sameTarget(other,target)))throw error('相同地址、用户名和管理端口的设备已存在',409);
  const changed=['host','port','username','remotePort','auth'].some(key=>target[key]!==profile[key])||next.fingerprint!==profile.fingerprint||next.sshOnly!==profile.sshOnly||JSON.stringify(credentials)!==JSON.stringify(profile.credentials);
  if(changed)normalize({...target,fingerprint:next.fingerprint,...credentials});
  if(changed&&(record.status==='connecting'||record.transfer?.status==='running'))throw error('设备正在连接或传输镜像，请完成后再修改连接信息；名称和备注可直接保存',409);
  const wasActive=active(record),autoChanged=body.autoReconnect!==undefined;
  if(autoChanged)next.paused=false;
  Object.assign(next,target,{credentials});profileStore.put(next);
  const {credentials:secret,...metadata}=next;
  if(changed)dispose(record);
  Object.assign(record,metadata,{saved:true});
  if(changed){
    record.status='disconnected';record.error=null;record.retryBlocked=false;record.stage='设备连接信息已更新';
    if(wasActive)begin(record,{...next,...secret,deploy:false});
    else if(record.autoReconnect&&!record.paused)scheduleRetry(record);
  }else if(autoChanged){
    clearTimeout(record.retryTimer);record.retryTimer=null;record.nextRetryAt=null;
    if(record.autoReconnect&&!active(record)&&!record.retryBlocked)scheduleRetry(record);
  }
  return view(record);
}
function forget(record){
  if(record.transfer?.status==='running')throw error('请先取消镜像传输再移除设备',409);
  if(record.saved)profileStore.remove(record.id);
  dispose(record);connections.delete(record.id);
}
function start(options={}){
  if(profileStore&&!shuttingDown)return;
  const store=options.store||profileStore||require('./ssh-device-store').createStore(),rows=store.load();
  // Validate the entire catalog before altering the live connection map.
  for(const row of rows){normalize({...row,...row.credentials},false);deviceDetails(row);if(!row.username||!/^SHA256:[A-Za-z0-9+/]{43}$/.test(row.fingerprint)||!['key','password','agent'].includes(row.auth))throw error('SSH 设备存储内容无效，原文件已保留',503);}
  profileStore=store;shuttingDown=false;if(options.retryDelays)retryDelays=options.retryDelays;
  for(const profile of rows){
    const {credentials,...metadata}=profile,record={...metadata,...deviceDetails(profile),saved:true,status:'disconnected',stage:profile.paused?'已保存，自动重连已暂停':'已保存，可重新连接'};
    connections.set(record.id,record);
    if(record.autoReconnect&&!record.paused)scheduleRetry(record);
  }
}
function closeAll(){shuttingDown=true;for(const r of connections.values()){r.status='disconnected';dispose(r);}}
module.exports={connections,start,reconnect,preferences,edit,forget,probe,connect,close,closeAll,view,normalize,fingerprint,dockerCommand,execute,sourceArchive,provision,deployOffline};
