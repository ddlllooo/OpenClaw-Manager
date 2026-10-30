 'use strict';
// A Docker-compatible, deny-by-default boundary. Run in a separate service.
const http=require('http'),fs=require('fs'),path=require('path');
const policy=require('./container-policy');
function deny(message='Docker operation denied'){throw Object.assign(new Error(message),{statusCode:403});}
function keys(value,allowed){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))deny();}
function numericUser(value){
 policy.user(value);if(value==='node')return '1000:1000';
 if(!/^[1-9][0-9]*(?::[0-9]+)?$/.test(value||''))deny('Controller requires a non-root numeric UID');return value;
}
function createController({docker,root,deployment='',managerName=''}){
 if(!path.isAbsolute(root))throw Error('Controller requires an absolute instance root');
 const isolation=require('../security/lifecycle.cjs').create({docker,root});
 const execs=new Map();
 async function owned(id){
  const row=await docker.getContainer(id).inspect();policy.owned(row);
  const instance=row.Config.Labels['openclaw.instance'];
  if(!fs.existsSync(path.join(root,instance,'instance.json')))deny('Instance is outside controller data root');
  const expected=['openclaw-'+instance];
  const record=JSON.parse(fs.readFileSync(path.join(root,instance,'instance.json'),'utf8'));
  if(record.containerName)expected.push(record.containerName);
  const name=(row.Name||'').replace(/^\//,'');
  if(!expected.some(n=>name===n||name.startsWith(n+'-rollback-')))deny();
  policy.hostConfig(row.HostConfig || {});policy.user(row.Config.User);
  const expectedBinds=['openclaw','workspace','auth'].map((folder,i)=>path.join(root,instance,folder).replace(/\\/g,'/')+':'+['/home/node/.openclaw','/home/node/.openclaw/workspace','/home/node/.config/openclaw'][i]);
  if(JSON.stringify((row.HostConfig?.Binds||[]).map(v=>v.replace(/:rw$/,'')).sort())!==JSON.stringify(expectedBinds.sort()))deny('Existing mounts are outside controller scope');
  return row;
 }
 async function authorize(method,url,body){
  const u=new URL(url,'http://docker'),route=u.pathname.replace(/^\/v[0-9.]+(?=\/)/,'');
  const workspace=/^\/openclaw\/secure\/([a-z0-9_-]{1,80})\/workspaces\/([a-z0-9_-]{1,80})$/i.exec(route);
  if(method==='GET'&&workspace)return {workspace:{id:workspace[1],agent:workspace[2]}};
  const match=/^\/containers\/([^/]+)(?:\/(.*))?$/.exec(route);
  if(method==='GET'&&['/_ping','/version','/info','/containers/json','/images/json'].includes(route))return {};
  if(method==='HEAD'&&route==='/_ping')return {};
  if(method==='POST'&&route==='/containers/create'){
   keys(body,['name','Image','Labels','Env','ExposedPorts','HostConfig','Healthcheck','WorkingDir','User','Entrypoint','Tty','OpenStdin','Cmd','Hostname','Domainname','AttachStdin','AttachStdout','AttachStderr','StdinOnce','Volumes','StopSignal','StopTimeout','NetworkDisabled','ArgsEscaped','OnBuild','Shell']);
   const id=body.Labels?.['openclaw.instance'];if(!/^[a-z0-9_-]{1,80}$/i.test(id||'')||body.Labels?.['openclaw.managed']!=='true')deny();
   const record=JSON.parse(fs.readFileSync(path.join(root,id,'instance.json'),'utf8'));
   if(u.searchParams.get('name')!==(record.containerName||'openclaw-'+id))deny();
   const h=body.HostConfig;keys(h,['Privileged','CapDrop','CapAdd','SecurityOpt','PidMode','IpcMode','NetworkMode','Init','ShmSize','Dns','PortBindings','Binds','RestartPolicy','Memory','MemorySwap','NanoCpus','CpuShares','PidsLimit','LogConfig']);
   policy.hostConfig(h);body.User=numericUser(body.User);
   if(JSON.stringify(h.CapDrop)!=='["ALL"]'||JSON.stringify(h.SecurityOpt)!=='["no-new-privileges:true"]'||h.PidsLimit<=0)deny();
   if(!['bridge','openclaw-isolated-'+id].includes(h.NetworkMode))deny();
   const destinations=['/home/node/.openclaw','/home/node/.openclaw/workspace','/home/node/.config/openclaw'];
   const sources=['openclaw','workspace','auth'].map(n=>path.join(root,id,n));
   if(!Array.isArray(h.Binds)||h.Binds.length!==3)deny();
   if(h.LogConfig?.Type!=='json-file'||Object.keys(h.LogConfig.Config||{}).some(k=>!['max-size','max-file'].includes(k)))deny();
   sources.forEach((source,i)=>{
    let current=path.resolve(root);for(const part of [id,path.basename(source)]){current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())deny();}
    if(h.Binds[i]!==source.replace(/\\/g,'/')+':'+destinations[i])deny('Mount denied');
   });
   const ports=h.PortBindings;keys(ports,['18789/tcp']);
   if(!Array.isArray(ports['18789/tcp'])||ports['18789/tcp'].length!==1||ports['18789/tcp'][0].HostIp!=='127.0.0.1'||String(ports['18789/tcp'][0].HostPort)!==String(record.port))deny();
   return {};
  }
  if(match){
   const id=decodeURIComponent(match[1]),action=match[2]||'';
   if(method==='GET'&&action==='json'){
    const row=await docker.getContainer(id).inspect();
    try{await owned(id);return {json:row};}catch{
     // Capacity planning needs metadata, never another container's Env or mounts.
     return {json:{Id:row.Id,Name:row.Name,State:row.State,Config:{Labels:row.Config?.Labels||{},Image:row.Config?.Image},Image:row.Image,HostConfig:{RestartPolicy:row.HostConfig?.RestartPolicy,Memory:row.HostConfig?.Memory,NanoCpus:row.HostConfig?.NanoCpus,CpuQuota:row.HostConfig?.CpuQuota,CpuPeriod:row.HostConfig?.CpuPeriod}}};
    }
   }
   let row;
   try { row=await owned(id); } catch(error) {
    row=await docker.getContainer(id).inspect();
    if(!deployment||row.Config?.Labels?.['openclaw.manager']!=='true'||row.Config.Labels['openclaw.deployment']!==deployment)throw error;
    if(method==='POST'&&action==='update'){keys(body,['RestartPolicy']);return {};}
    if(method==='DELETE'&&!action&&!row.State.Running&&(row.Name||'').replace(/^\//,'')!==managerName&&!['1','true'].includes(u.searchParams.get('v')))return {};
    deny();
   }
   if(method==='GET'&&['stats','logs'].includes(action))return {};
   if(method==='POST'&&['start','stop','restart'].includes(action)&&row.Config.Labels?.['openclaw.security.profile']==='ssh-sandbox-v1')return {secureAction:{id:row.Config.Labels['openclaw.instance'],action}};
   if(method==='POST'&&['start','stop','restart','wait','resize'].includes(action))return {};
   if(method==='DELETE'&&!action){if(u.searchParams.get('v')==='1'||u.searchParams.get('v')==='true')deny();return {};}
   if(method==='POST'&&action==='rename'){
    const base=JSON.parse(fs.readFileSync(path.join(root,row.Config.Labels['openclaw.instance'],'instance.json'),'utf8')).containerName;
    const name=u.searchParams.get('name');if(name!==base&&!(name?.startsWith(base+'-rollback-')&&/^[0-9]+$/.test(name.slice((base+'-rollback-').length))))deny();return {};
   }
   if(method==='POST'&&action==='update'){keys(body,['CpuShares','NanoCpus','Memory','MemorySwap','PidsLimit','RestartPolicy']);return {};}
   if(method==='POST'&&action==='exec'){
    keys(body,['AttachStdin','AttachStdout','AttachStderr','Tty','Cmd','Env','WorkingDir','User','DetachKeys','Privileged','ConsoleSize']);
    if(body.Privileged)deny();body.User=numericUser(body.User||row.Config.User);
    return {body,rememberExec:true};
   }
   if(method==='PUT'&&action==='archive'&&u.searchParams.get('path')==='/app/dist/control-ui')return {};
   deny();
  }
  const exec=/^\/exec\/([^/]+)\/(start|resize|json)$/.exec(route);
  if(exec){
   const container=execs.get(exec[1]);if(!container)deny();await owned(container);
   if(method==='GET'&&exec[2]==='json'||method==='POST'&&exec[2]==='resize')return {};
   if(method==='POST'&&exec[2]==='start'){keys(body,['Detach','Tty','ConsoleSize','hijack','stdin']);delete body.hijack;delete body.stdin;return {body};}
  }
  // Image operations remain available, but daemon force deletion/build/load/prune are forbidden.
  if(method==='GET'&&/^\/images\/.+\/(json|get)$/.test(route))return {};
  if(method==='POST'&&route==='/images/create'&&u.searchParams.has('fromImage')&&!u.searchParams.has('fromSrc'))return {};
  if(method==='POST'&&/^\/images\/.+\/tag$/.test(route))return {};
  if(method==='DELETE'&&/^\/images\/.+/.test(route)&&!['1','true'].includes(u.searchParams.get('force')))return {};
  const network=/^\/networks\/([^/]+)$/.exec(route);
  if(method==='POST'&&route==='/networks/create'){
   keys(body,['Name','Driver','Internal','EnableIPv6','Options','Labels']);
   if(!/^openclaw-isolated-[a-z0-9_-]+$/i.test(body.Name)||body.Name!=='openclaw-isolated-'+body.Labels?.['openclaw.instance']||!body.Internal||body.Driver!=='bridge'||body.EnableIPv6||JSON.stringify(body.Options)!=='{"com.docker.network.bridge.enable_icc":"false"}'||body.Labels?.['openclaw.network']!=='isolated')deny();return {};
  }
  if(network){const row=await docker.getNetwork(decodeURIComponent(network[1])).inspect();if(!row.Internal||row.Labels?.['openclaw.network']!=='isolated'||row.Name!=='openclaw-isolated-'+row.Labels?.['openclaw.instance'])deny();if(method==='GET'||method==='DELETE')return {};}
  deny();
 }
 async function handle(req,res,socket,head){
  try{
   const isJSON=req.headers['content-type']?.includes('application/json');let body;
   if(isJSON){
    let chunks=[],size=0;
    if(socket){
     const length=Number(req.headers['content-length']);if(!Number.isSafeInteger(length)||length>1048576||length<0)deny();
     let data=head;while(data.length<length){const chunk=await new Promise((resolve,reject)=>{socket.once('data',resolve);socket.once('error',reject);});data=Buffer.concat([data,chunk]);}
     if(data.length!==length)deny();body=JSON.parse(data.toString());
    }else{for await(const chunk of req){size+=chunk.length;if(size>1048576)deny();chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks).toString());}
   }
   const decision=await authorize(req.method,req.url,body);
   if(decision.workspace){
    const {id,agent}=decision.workspace;const live=path.join(root,id,'instance.json'),file=fs.existsSync(live)?live:path.join(root,id+'.kept','instance.json');
    const record=JSON.parse(fs.readFileSync(file,'utf8'));if(record.id!==id)deny();
    const stream=await require('../security/workspace-backup.cjs').archive(docker,record,agent,root);
    res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());res.writeHead(200,{'Content-Type':'application/x-tar'});stream.pipe(res);return;
   }
   if(decision.secureAction){await isolation.act(decision.secureAction.id,decision.secureAction.action);res.writeHead(204);return res.end();}
   if(decision.json){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(decision.json));}
   const data=isJSON?Buffer.from(JSON.stringify(decision.body||body)):null;
   const headers={};for(const key of ['content-type','content-length','x-registry-auth','connection','upgrade'])if(req.headers[key])headers[key]=req.headers[key];
   if(data)headers['content-length']=data.length;
   const upstream=http.request({socketPath:docker.modem.socketPath,path:req.url,method:req.method,headers},response=>{
    if(socket){socket.destroy();response.destroy();return;}
    if(decision.rememberExec){let raw='';response.on('data',b=>raw+=b);response.on('end',()=>{try{const result=JSON.parse(raw);if(result.Id){if(execs.size>=1024)execs.delete(execs.keys().next().value);execs.set(result.Id,decodeURIComponent(req.url.replace(/^\/v[0-9.]+/,'').split('/')[2]));}}catch{}res.writeHead(response.statusCode,response.headers);res.end(raw);});}
    else{res.writeHead(response.statusCode,response.headers);response.pipe(res);}
   });
   upstream.on('upgrade',(response,stream,extra)=>{
    if(!socket){stream.destroy();return;}
    socket.allowHalfOpen=true;stream.allowHalfOpen=true;
    socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');if(extra.length)socket.write(extra);stream.pipe(socket).pipe(stream);socket.on('close',()=>stream.destroy());stream.on('error',()=>socket.destroy());
   });
   upstream.on('error',()=>{if(socket)socket.destroy();else if(!res.headersSent){res.writeHead(502);res.end('{"message":"Docker control unavailable"}');}else res.destroy();});
   if(!socket){req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());}
   if(data)upstream.end(data);else req.pipe(upstream);
  }catch(error){if(socket){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}else{res.writeHead(error.statusCode===404?404:403,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'Docker control denied this operation'}));}}
 }
 const server=http.createServer((req,res)=>handle(req,res));
 const clients=new Set();server.on('connection',socket=>{socket.on('error',()=>socket.destroy());clients.add(socket);socket.on('close',()=>clients.delete(socket));});
 server.destroyClients=()=>{for(const socket of clients)socket.destroy();};server.maxConnections=128;server.requestTimeout=30000;server.headersTimeout=10000;server.on('upgrade',(req,socket,head)=>{socket.allowHalfOpen=true;handle(req,null,socket,head);});
 server.security=isolation;server.authorize=authorize;return server;
}
module.exports={createController};
