'use strict';
const fs=require('fs'),http=require('http'),crypto=require('crypto');
function normalize(event,botId){
 const message=event.message||event.event?.message,sender=event.sender||event.event?.sender;
 if(!message||sender?.sender_type!=='user')throw Error('Unsupported event sender');
 const content=JSON.parse(message.content||'{}');let text;
 if(message.message_type==='text')text=content.text;
 else if(message.message_type==='post'){
  const post=Array.isArray(content.content)?content:content.zh_cn||content.en_us||Object.values(content)[0];
  if(!post||!Array.isArray(post.content))throw Error('Unsupported post');
  text=[post.title||'',...post.content.map(row=>row.map(item=>item.tag==='text'?item.text:item.tag==='a'?String(item.text||'')+' '+String(item.href||''):item.tag==='at'?'@'+String(item.user_name||item.user_id||''):'[不支持的内容]').join(''))].join('\n');
 }else throw Error('Only text and rich-text posts are supported');
 if(typeof text!=='string')throw Error('Invalid text');
 const mentions=message.mentions||[];
 for(const mention of mentions)if(typeof mention.key==='string')text=text.split(mention.key).join(mention.id?.open_id===botId?'':'@'+String(mention.name||mention.id?.open_id||''));
 return {messageId:message.message_id,chatId:message.chat_id,senderId:sender.sender_id?.open_id,chatType:message.chat_type,text:text.trim(),mentionedBot:mentions.some(m=>m.id?.open_id===botId),createdAt:Number(message.create_time)};
}
function webhook(raw,headers,settings,now=Date.now()){
 if(!settings.encryptKey||!settings.verificationToken)throw Error('Signed encrypted webhook configuration required');
 const timestamp=String(headers['x-lark-request-timestamp']||''),nonce=String(headers['x-lark-request-nonce']||''),signature=String(headers['x-lark-signature']||'');
 if(!/^\d{10}$/.test(timestamp)||Math.abs(now-Number(timestamp)*1000)>600000||!/^.{8,128}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(signature))throw Error('Invalid webhook signature');
 const expected=crypto.createHash('sha256').update(timestamp+nonce+settings.encryptKey).update(raw).digest();
 if(!crypto.timingSafeEqual(expected,Buffer.from(signature,'hex')))throw Error('Invalid webhook signature');
 let body=JSON.parse(raw.toString('utf8'));
 if(body.encrypt){
  const buffer=Buffer.from(body.encrypt,'base64');if(buffer.length<32||buffer.length>65536)throw Error('Invalid encrypted callback');
  const decipher=crypto.createDecipheriv('aes-256-cbc',crypto.createHash('sha256').update(settings.encryptKey).digest(),buffer.subarray(0,16));
  body=JSON.parse(Buffer.concat([decipher.update(buffer.subarray(16)),decipher.final()]).toString('utf8'));
 }
 const token=body.token||body.header?.token;
 if(typeof token!=='string'||!crypto.timingSafeEqual(crypto.createHash('sha256').update(token).digest(),crypto.createHash('sha256').update(settings.verificationToken).digest()))throw Error('Callback token denied');
 return body;
}
function chunks(text,max=3800){const result=[];let part='',size=0;for(const c of text){const bytes=Buffer.byteLength(c);if(size+bytes>max){result.push(part);part='';size=0;}part+=c;size+=bytes;}if(part)result.push(part);return result;}
function create(settings,{fetch:request=fetch,now=Date.now,stateDir='/state'}={}){
 let botId='',identity=null,polling=false,lastSync=0;
 fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
 const save=job=>{const file=stateDir+'/'+job.id+'.json',temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(job),{mode:0o600});fs.renameSync(temp,file);};
 async function json(url,options={}){const response=await request(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok)throw Object.assign(Error('Transport request rejected'),{status:response.status});const data=await response.json();if(Buffer.byteLength(JSON.stringify(data))>131072)throw Error('Response too large');return data;}
 async function broker(endpoint,data){return json(settings.brokerOrigin+endpoint,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+settings.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});}
 async function connect(){identity=await broker('/v1/identity');botId=identity.botId;if(!/^ou_[A-Za-z0-9_-]+$/.test(botId))throw Error('Bot identity unavailable');return botId;}
 async function receive(event){
  let input;try{input=normalize(event,botId);require('./feishu-policy.cjs').authorize(input,{dmPolicy:'allowlist',allowFrom:[input.senderId],groupPolicy:'allowlist',groupAllowFrom:[input.chatId],requireMention:false},now());}catch{return;}
  const id=crypto.createHash('sha256').update(input.messageId).digest('hex'),file=stateDir+'/'+id+'.json';
  if(fs.existsSync(file))return;
  for(const name of fs.readdirSync(stateDir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){const old=JSON.parse(fs.readFileSync(stateDir+'/'+name));if(!['pending','queued','sending'].includes(old.phase)&&now()-(old.createdAt||now())>86400000)fs.unlinkSync(stateDir+'/'+name);}
  if(fs.readdirSync(stateDir).filter(n=>n.endsWith('.json')).length>=2048)throw Error('Channel outbox full');
  const job={id,input,phase:'pending',createdAt:now()};save(job);
  try{const result=await broker('/v1/events',{messageId:input.messageId});job.phase='queued';job.jobId=result.id;save(job);}
  catch(error){if([403,409].includes(error.status)){job.phase='denied';delete job.input;save(job);}else throw error;}
 }
 async function poll(){
  if(polling)return;polling=true;
  try{
   if(now()-lastSync>30000){const remote=await broker('/v1/pending');if(!Array.isArray(remote.jobs)||remote.jobs.length>32)throw Error('Invalid recovery response');for(const job of remote.jobs)if(/^[a-f0-9]{64}$/.test(job.id)&&!fs.existsSync(stateDir+'/'+job.id+'.json'))save({id:job.id,jobId:job.id,phase:'queued',createdAt:now()});lastSync=now();}
   for(const name of fs.readdirSync(stateDir).filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
   const job=JSON.parse(fs.readFileSync(stateDir+'/'+name,'utf8'));
   // Never replay an uncertain send following a crash. Feishu receives stable
   // UUIDs as an additional dedupe defense, not an exactly-once claim.
   if(job.phase==='sending'){job.phase='unknown';delete job.input;save(job);continue;}
   if(!['pending','queued'].includes(job.phase))continue;
   try{
    if(job.phase==='pending'){const result=await broker('/v1/events',{messageId:job.input.messageId});job.phase='queued';job.jobId=result.id;save(job);}
    const result=await broker('/v1/results/'+job.jobId);
    if(['failed','unknown'].includes(result.status)){job.phase=result.status;delete job.input;save(job);continue;}
    if(result.status!=='completed')continue;
    if(!Number.isInteger(result.parts)||result.parts<0||result.parts>64)throw Error('Invalid reply');
    job.phase='sending';save(job);
    for(let index=0;index<result.parts;index++){
     const sent=await broker('/v1/reply',{id:job.jobId,part:index});if(sent.status!=='sent')throw Error('Unconfirmed reply');
    }
    job.phase='sent';delete job.input;save(job);
   }catch{if(job.phase==='sending'){job.phase='unknown';delete job.input;save(job);}}
  }}finally{polling=false;}
 }
 return {connect,receive,poll,get botId(){return botId;},get identity(){return identity;},endpoint:()=>broker('/v1/ws-endpoint',{})};
}
async function start(){
 const settings=JSON.parse(fs.readFileSync('/policy/transport.json','utf8')),transport=create(settings);await transport.connect();
 const logger={trace(){},debug(){},info(){},warn(){},error(){}};let ws,activated=false;
 let activation;
 async function activate(){
  if(activated)return;if(activation)return activation;
  activation=(async()=>{
   if(settings.connectionMode==='websocket'){
    const lark=require('@larksuiteoapi/node-sdk');let resolveReady,rejectReady;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const timer=setTimeout(()=>rejectReady(Error('WebSocket readiness timeout')),15000);
    ws=new lark.WSClient({appId:transport.identity.appId,appSecret:'isolated-proxy-sentinel',httpInstance:{request:async config=>{
     const url=new URL(config.url),origin=settings.domain==='lark'?'https://open.larksuite.com':'https://open.feishu.cn';
     if(String(config.method).toLowerCase()!=='post'||url.origin!==origin||url.pathname!=='/callback/ws/endpoint'||url.search||url.hash)throw Error('SDK HTTP operation denied');
     return transport.endpoint();
    }},domain:settings.domain==='lark'?lark.Domain.Lark:lark.Domain.Feishu,logger,handshakeTimeoutMs:10000,onReady:resolveReady,onError:()=>{activated=false;rejectReady(Error('WebSocket failed'));ws?.close?.();}});
    try{await ws.start({eventDispatcher:new lark.EventDispatcher({logger}).register({'im.message.receive_v1':event=>transport.receive(event)})});await ready;}catch(error){ws.close();throw error;}finally{clearTimeout(timer);}
   }
   activated=true;
  })();
  try{await activation;}finally{activation=null;}
 }
 const server=http.createServer(async(req,res)=>{
  if(req.url==='/health'&&req.method==='GET'){
   if(req.headers.authorization!=='Bearer '+settings.token){res.writeHead(403);res.end();return;}
   res.end(JSON.stringify({ok:true,activated,botId:transport.botId}));return;
  }
  if(req.url==='/activate'&&req.method==='POST'&&req.headers.authorization==='Bearer '+settings.token){try{await activate();res.end('{}');}catch{res.writeHead(503);res.end('{}');}return;}
  if(settings.connectionMode!=='webhook'||req.method!=='POST'||req.url!=='/feishu/events'){res.writeHead(404);res.end();return;}
  try{
   const input=[];let bytes=0;for await(const b of req){bytes+=b.length;if(bytes>65536)throw Error('Too large');input.push(b);}
   const body=webhook(Buffer.concat(input),req.headers,settings);
   if(body.type==='url_verification'&&typeof body.challenge==='string'&&body.challenge.length<1024){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({challenge:body.challenge}));return;}
   if(!activated){res.writeHead(503);res.end('{}');return;}
   if(body.header?.event_type!=='im.message.receive_v1')throw Error('Unsupported callback');
   await transport.receive(body.event);res.end('{}');
  }catch{res.writeHead(403);res.end('{}');}
 });server.requestTimeout=5000;server.headersTimeout=3000;server.maxConnections=32;server.listen(18791,'0.0.0.0');
 setInterval(()=>{if(activated)transport.poll().catch(()=>{});},1000);
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{ws?.close?.();server.close();process.exit(0);});
}
module.exports={normalize,webhook,chunks,create};
if(require.main===module)start().catch(()=>{console.error('Isolated Feishu transport failed closed');process.exit(1);});
