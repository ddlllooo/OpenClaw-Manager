'use strict';
// Trusted Manager service. The isolated transport receives a per-account token,
// never the management credential, Gateway token, model config or transcript.
const http=require('http'),crypto=require('crypto'),fs=require('fs'),path=require('path');
const policy=require('../security/feishu-policy.cjs');
function create({store=require('./instances'),gateway=require('./gateway-rpc'),scrub=(text,instance)=>require('./confidential').scrub(text,instance),now=Date.now,apiFetch=fetch,isRunning=async instance=>(await require('./docker').inspectContainer(instance.containerId)).State.Running}={}){
 const active=new Set(),scheduled=new Map(),rates=new Map(),tokens=new Map(),bots=new Map();let closing=false;
 const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
 function account(req){
  const token=/^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization||''))?.[1];if(!token)throw Error('Unauthorized');
  for(const id of store.listInstanceIds()){
   const instance=store.loadInstance(id);
   for(const [name,target]of Object.entries(instance.channelIsolation?.accounts||{}))if(crypto.timingSafeEqual(Buffer.from(hash(token)),Buffer.from(hash(target.token)))){
    if(!policy.ACCOUNT.test(name))throw Error('Invalid account');
    const identityOnly=req.method==='GET'&&req.url==='/v1/identity',endpointOnly=req.method==='POST'&&req.url==='/v1/ws-endpoint';
    if(!identityOnly&&(target.state!=='active'||(!endpointOnly&&fs.existsSync(path.join(store.instanceDir(id),'manager','security','migration.lock')))))throw Error('Migration in progress or channel inactive');
    return {instance,name,target,access:JSON.parse(fs.readFileSync(target.accessFile,'utf8'))};
   }
  }throw Error('Unauthorized');
 }
 function folder(a){const dir=path.join(store.instanceDir(a.instance.id),'manager','channel-jobs',a.name);fs.mkdirSync(dir,{recursive:true,mode:0o700});return dir;}
 function load(a,id){if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid job');return JSON.parse(fs.readFileSync(path.join(folder(a),id+'.json'),'utf8'));}
 function save(a,job){store.atomicWrite(path.join(folder(a),job.id+'.json'),JSON.stringify(job));}
 async function body(req){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)throw Error('Too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
 async function api(a,endpoint,data,{authenticate=true}={}){
  const credentials=JSON.parse(fs.readFileSync(a.target.credentialsFile,'utf8')),origin=credentials.domain==='lark'?'https://open.larksuite.com':'https://open.feishu.cn';
  async function request(url,options){const response=await apiFetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Feishu request failed');const result=await response.json();if(Buffer.byteLength(JSON.stringify(result))>131072||result.code!==0)throw Error('Feishu operation failed');return result;}
  const key=hash(JSON.stringify([a.instance.id,a.name,credentials]));let token=tokens.get(key);
  if(authenticate&&(!token||token.expires<=now())){
   const result=await request(origin+'/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:credentials.appId,app_secret:credentials.appSecret})});
   if(typeof result.tenant_access_token!=='string')throw Error('Invalid Feishu token');token={value:result.tenant_access_token,expires:now()+Math.max(30,Number(result.expire||60)-60)*1000};tokens.set(key,token);
  }
  return request(origin+endpoint,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(authenticate?{Authorization:'Bearer '+token.value}:{})},...(data?{body:JSON.stringify(data)}:{})});
 }
 async function identity(a){const key=a.instance.id+':'+a.name+':'+a.target.token;if(!bots.has(key)){
  const result=await api(a,'/open-apis/bot/v3/info'),botId=result.bot?.open_id||result.data?.bot?.open_id;if(!policy.USER.test(botId))throw Error('Bot identity unavailable');bots.set(key,botId);
 }return bots.get(key);}
 async function canonical(a,messageId){
  const result=await api(a,'/open-apis/im/v1/messages/'+encodeURIComponent(messageId)+'?user_id_type=open_id'),items=result.data?.items;
  if(!Array.isArray(items)||items.length!==1||items[0].message_id!==messageId||items[0].deleted||items[0].sender?.id_type!=='open_id'||items[0].sender?.sender_type!=='user')throw Error('Message not accessible');
  const item=items[0];if(!policy.CHAT.test(item.chat_id))throw Error('Invalid provider chat');
  const chat=await api(a,'/open-apis/im/v1/chats/'+encodeURIComponent(item.chat_id)+'?user_id_type=open_id'),mode=chat.data?.chat_mode;
  if(!['p2p','group'].includes(mode))throw Error('Unsupported provider chat mode');
  const event={sender:{sender_type:'user',sender_id:{open_id:item.sender.id}},message:{message_id:item.message_id,chat_id:item.chat_id,chat_type:mode,create_time:item.create_time,message_type:item.msg_type,content:item.body?.content,mentions:(item.mentions||[]).map(m=>({key:m.key,id:{open_id:m.id_type==='open_id'?m.id:''},name:m.name}))}};
  const input=require('../security/feishu-worker.cjs').normalize(event,await identity(a));
  if(input.createdAt<(a.target.notBefore||0)-5000)throw Error('Message predates isolated channel activation');return input;
 }
 async function execute(a,id){
  const lane=a.instance.id+':'+a.name;if(closing||active.has(lane)||active.size>=8)return;
  const job=load(a,id);if(job.status!=='pending')return;active.add(lane);
  try{
   // Reauthorize using current host policy immediately before dispatch.
   const current=store.loadInstance(a.instance.id),target=current.channelIsolation?.accounts?.[a.name];
   if(!target||target.token!==a.target.token||fs.existsSync(path.join(store.instanceDir(current.id),'manager','security','migration.lock')))return;
   if(require('./maintenance-guard').active)return;
   try{await require('./storage').assertAdmission(current.id);}catch{return;}
   if(!await isRunning(current))return;
   if(!job.input)job.input=await canonical({...a,target},job.messageId);
   if(store.loadInstance(current.id).channelIsolation?.accounts?.[a.name]?.token!==target.token||fs.existsSync(path.join(store.instanceDir(current.id),'manager','security','migration.lock')))return;
   const access=JSON.parse(fs.readFileSync(target.accessFile,'utf8')),route=policy.authorize(job.input,access,now());
   const config=JSON.parse(store.readOpenclawConfig(current.id));policy.assertAgents(config,current.channelIsolation);
   if(!current.channelIsolation.agentPolicies?.[route.agentId]||!require('./management').agents(config).some(r=>r.id===route.agentId))throw Error('Agent no longer available or not constrained');
   job.status='running';job.agentId=route.agentId;save(a,job);
   let reply='',terminal=false;
   // This RPC uses a trusted Manager identity. Explicitly suppress command
   // interpretation so channel text never inherits operator control authority.
   // Older runtimes must reject this field rather than silently retry without it.
   await gateway.rpc(current,'chat.send',{sessionKey:policy.sessionKey(a.name,job.input,route.agentId),message:job.input.text,suppressCommandInterpretation:true,deliver:false,idempotencyKey:job.runId,timeoutMs:240000},{timeout:270000,stream:true,onEvent:event=>{
    if(event.kind!=='chat')return;const data=event.data;
    if(data.state==='error'||data.state==='aborted')throw Error('Channel run failed');
    if(data.state==='final'){
     const content=data.message?.content;
     reply=typeof content==='string'?content:Array.isArray(content)?content.filter(c=>c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n'):'';
     if(Buffer.byteLength(reply)>64000)throw Error('Reply too large');terminal=true;
    }
   }});
   if(!terminal)throw Error('Unconfirmed channel run');
   job.status='completed';job.reply=scrub(reply,current);const {text,...facts}=job.input;job.destination=facts;delete job.input;save(a,job);
  }catch{job.status=job.status==='running'?'unknown':'failed';delete job.input;save(a,job);}
  finally{active.delete(lane);}
 }
 function schedule(a,id){
  const lane=a.instance.id+':'+a.name;
  const next=(scheduled.get(lane)||Promise.resolve()).catch(()=>{}).then(()=>execute(a,id));scheduled.set(lane,next);
  next.finally(()=>{if(scheduled.get(lane)===next)scheduled.delete(lane);}).catch(()=>{});
 }
 async function handler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
  if(req.method==='GET'&&req.url==='/health'){res.writeHead(204);res.end();return;}
  try{
   const a=account(req);
   if(req.method==='GET'&&req.url==='/v1/pending'){
    const jobs=[];
    for(const name of fs.readdirSync(folder(a)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const job=load(a,name.slice(0,-5));
     if(job.status==='running'&&!active.has(a.instance.id+':'+a.name)){job.status='unknown';delete job.input;save(a,job);}
     const deliveries=Object.values(job.delivery||{});
     if(job.status==='pending'||(job.status==='completed'&&!deliveries.some(v=>['sending','unknown'].includes(v))&&deliveries.length<require('../security/feishu-worker.cjs').chunks(job.reply).length))jobs.push({id:job.id,status:job.status});
     if(jobs.length===32)break;
    }res.end(JSON.stringify({jobs}));return;
   }
   if(req.method==='GET'&&req.url==='/v1/identity'){
    const botId=await identity(a);
    const credentials=JSON.parse(fs.readFileSync(a.target.credentialsFile,'utf8'));
    res.end(JSON.stringify({botId,appId:credentials.appId,domain:credentials.domain}));return;
   }
   if(req.method==='POST'&&req.url==='/v1/ws-endpoint'){
    const input=await body(req);if(Object.keys(input).length)throw Error('Endpoint fields denied');
    const credentials=JSON.parse(fs.readFileSync(a.target.credentialsFile,'utf8'));
    const result=await api(a,'/callback/ws/endpoint',{AppID:credentials.appId,AppSecret:credentials.appSecret},{authenticate:false});
    const url=new URL(result.data?.URL);if(url.protocol!=='wss:'||url.username||url.password||!(a.target.wsOrigins||[]).includes(url.origin))throw Error('Unapproved WebSocket endpoint');
    const config=Object.fromEntries(Object.entries(result.data?.ClientConfig||{}).filter(([key,value])=>['ReconnectCount','ReconnectInterval','ReconnectNonce','PingInterval'].includes(key)&&Number.isFinite(value)&&value>=0&&value<=3600));
    res.end(JSON.stringify({code:0,data:{URL:url.href,ClientConfig:config}}));return;
   }
   if(req.method==='POST'&&req.url==='/v1/reply'){
    const input=await body(req);if(Object.keys(input).some(k=>!['id','part'].includes(k))||!Number.isInteger(input.part)||input.part<0)throw Error('Reply fields denied');
    const job=load(a,input.id),parts=require('../security/feishu-worker.cjs').chunks(job.reply||'');
    if(job.status!=='completed'||!job.destination||input.part>=parts.length)throw Error('Reply not authorized');
    const currentAccess=JSON.parse(fs.readFileSync(a.target.accessFile,'utf8'));
    if(policy.authorize({...job.destination,text:'reply'},currentAccess,now()).agentId!==job.agentId)throw Error('Reply permission revoked');
    job.delivery||={};const previous=job.delivery[input.part];
    if(previous){res.end(JSON.stringify({status:previous==='sending'?'unknown':previous}));return;}
    if(Object.values(job.delivery).some(v=>['sending','unknown'].includes(v))){res.end('{"status":"unknown"}');return;}
    job.delivery[input.part]='sending';save(a,job);
    try{await api(a,'/open-apis/im/v1/messages/'+encodeURIComponent(job.destination.messageId)+'/reply',{msg_type:'text',content:JSON.stringify({text:parts[input.part]}),uuid:hash(job.id+':'+input.part).slice(0,32)});job.delivery[input.part]='sent';}
    catch{job.delivery[input.part]='unknown';}
    save(a,job);res.end(JSON.stringify({status:job.delivery[input.part]}));return;
   }
   if(req.method==='POST'&&req.url==='/v1/events'){
    try{await require('./storage').assertAdmission(a.instance.id);}catch{res.writeHead(507);res.end('{"error":"Instance storage protected; no new job accepted","retryable":false}');return;}
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Error('JSON required');
    const claim=await body(req);if(Object.keys(claim).length!==1||!/^om_[A-Za-z0-9_-]{1,150}$/.test(claim.messageId))throw Error('Only a provider message ID is accepted');
    const id=hash(claim.messageId);let job;
    try{job=load(a,id);}
    catch(error){if(error.code!=='ENOENT')throw error;
     const lane=a.instance.id+':'+a.name,rate=rates.get(lane);if(!rate||rate.expires<=now())rates.set(lane,{count:0,expires:now()+60000});
     if(++rates.get(lane).count>20){res.writeHead(429);res.end('{"error":"Channel rate limited"}');return;}
     let files=fs.readdirSync(folder(a)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));
     for(const file of files){const old=load(a,file.slice(0,-5));if(!['pending','running'].includes(old.status)&&now()-old.createdAt>86400000)fs.unlinkSync(path.join(folder(a),file));}
     files=fs.readdirSync(folder(a)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));if(files.length>=2048){res.writeHead(429);res.end('{"error":"Channel queue full"}');return;}
     if(files.filter(name=>{try{return load(a,name.slice(0,-5)).status==='pending';}catch{return false;}}).length>=32){res.writeHead(429);res.end('{"error":"Channel queue busy"}');return;}
     job={id,messageId:claim.messageId,status:'pending',runId:crypto.randomUUID(),createdAt:now()};save(a,job);
    }
    if(job.status==='pending')schedule(a,id);
    res.writeHead(202);res.end(JSON.stringify({id,status:job.status}));return;
   }
   if(req.method==='GET'&&/^\/v1\/results\/[a-f0-9]{64}$/.test(req.url)){
    const id=req.url.split('/').pop(),job=load(a,id);
    // A restarted broker cannot attest whether a running job was dispatched.
    if(job.status==='running'&&!active.has(a.instance.id+':'+a.name)){job.status='unknown';delete job.input;save(a,job);}
    if(job.status==='pending')schedule(a,id);
    res.end(JSON.stringify({id,status:job.status,...job.status==='completed'?{parts:require('../security/feishu-worker.cjs').chunks(job.reply).length}:{}}));return;
   }
   res.writeHead(404);res.end('{}');
  }catch{if(!res.headersSent)res.writeHead(403);res.end('{"error":"Channel request denied or unavailable"}');}
 }
 const server=http.createServer(handler);server.requestTimeout=10000;server.headersTimeout=5000;server.maxConnections=64;
 return {server,handler,close(){closing=true;server.closeAllConnections();if(server.listening)server.close();},active};
}
function start(){
 const address=process.env.OPENCLAW_CHANNEL_BRIDGE_LISTEN;if(!address)return null;
 const match=/^(127\.0\.0\.1|0\.0\.0\.0|[0-9.]+):([0-9]{2,5})$/.exec(address);if(!match||Number(match[2])<1024||Number(match[2])>65535)throw Error('Invalid channel bridge listen address');
 const bridge=create();bridge.server.listen(Number(match[2]),match[1]);bridge.server.on('error',()=>{console.error('Channel bridge unavailable');bridge.close();});return bridge;
}
module.exports={create,start};
