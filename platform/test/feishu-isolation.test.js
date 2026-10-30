'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),crypto=require('crypto');
const rules=require('../security/feishu-policy.cjs'),worker=require('../security/feishu-worker.cjs');
const access={agentId:'main',dmPolicy:'allowlist',allowFrom:['ou_approved'],groupPolicy:'allowlist',groupAllowFrom:['oc_group'],groupSenderAllowFrom:['ou_approved'],requireMention:true,groups:{},routes:[]};
const input=()=>({messageId:'om_fixture',chatId:'oc_group',senderId:'ou_approved',chatType:'group',text:'Hello',mentionedBot:true,createdAt:Date.now()});
test('channel authority is bound to approved accounts, peers, mentions and Agent routes',()=>{
 rules.access(access,['main']);assert.equal(rules.authorize(input(),access).agentId,'main');
 for(const patch of [{senderId:'ou_stranger'},{chatId:'oc_other'},{mentionedBot:false},{text:'/config set x y'},{text:'!cat /etc/passwd'},{text:'hello /elevated full'},{text:'hello / config set x y'},{agentId:'admin'},{sessionKey:'agent:admin:main'},{attachments:[]},{createdAt:1}])assert.throws(()=>rules.authorize({...input(),...patch},access));
 assert.equal(rules.authorize({...input(),text:'Please edit /workspaces/note.md'},access).agentId,'main');
 assert.throws(()=>rules.access({...access,dmPolicy:'open'},['main']));assert.throws(()=>rules.access({...access,agentId:'unknown'},['main']));
 assert.notEqual(rules.sessionKey('a',input(),'main'),rules.sessionKey('b',input(),'main'));
 assert.notEqual(rules.sessionKey('a',input(),'main'),rules.sessionKey('a',{...input(),chatId:'oc_other'},'main'));
});
test('native configuration and credential environment cannot be re-enabled after migration',()=>{
 const original={channels:{feishu:{appSecret:'channel'},other:{enabled:true}},models:{providers:{fixture:{apiKey:'MODEL'}}},env:{vars:{FEISHU_APP_SECRET:'channel',MODEL_KEY:'MODEL'}}};
 const safe=rules.stripConfig(original);rules.assertConfig(safe,{accounts:{}});assert.equal(safe.models.providers.fixture.apiKey,'MODEL');assert.ok(!safe.channels.feishu);assert.equal(safe.env.vars.MODEL_KEY,'MODEL');
 assert.throws(()=>rules.assertConfig(original,{accounts:{}}));assert.throws(()=>rules.assertConfig({...safe,plugins:{entries:{feishu:{enabled:true}}}},{accounts:{}}));
});
test('channel Agent privileges are confined without changing the daily Agent',()=>{
 const config=rules.stripConfig({agents:{entries:{main:{tools:{allow:['cron']}},feishu:{workspace:'/home/node/.openclaw/workspaces/feishu'}}}});
 assert.throws(()=>rules.constrainAgents(config,{default:{access}}),/专用/);
 const constrained=rules.constrainAgents(config,{default:{access:{...access,agentId:'feishu'}}});
 assert.deepEqual(constrained.config.agents.entries.main.tools,{allow:['cron']});assert.deepEqual(constrained.config.agents.entries.feishu.tools.allow,['read','write','edit']);
 rules.assertAgents(constrained.config,{agentPolicies:constrained.policies});constrained.config.agents.entries.feishu.tools.allow.push('sessions_history');assert.throws(()=>rules.assertAgents(constrained.config,{agentPolicies:constrained.policies}));
});
test('webhook verifies the raw signed body, freshness, encryption and token before dispatch',()=>{
 const settings={encryptKey:'fixture-encrypt-key',verificationToken:'fixture-verification-token'},now=Date.now(),timestamp=String(Math.floor(now/1000)),nonce='fixture-nonce';
 const body={schema:'2.0',header:{event_type:'im.message.receive_v1',token:settings.verificationToken},event:{message:{message_id:'om_fixture'}}};
 const iv=Buffer.alloc(16,2),cipher=crypto.createCipheriv('aes-256-cbc',crypto.createHash('sha256').update(settings.encryptKey).digest(),iv);
 const raw=Buffer.from(JSON.stringify({encrypt:Buffer.concat([iv,cipher.update(JSON.stringify(body)),cipher.final()]).toString('base64')}));
 const headers={'x-lark-request-timestamp':timestamp,'x-lark-request-nonce':nonce,'x-lark-signature':crypto.createHash('sha256').update(timestamp+nonce+settings.encryptKey).update(raw).digest('hex')};
 assert.deepEqual(worker.webhook(raw,headers,settings,now),body);
 assert.throws(()=>worker.webhook(raw,{...headers,'x-lark-signature':'0'.repeat(64)},settings,now));
 assert.throws(()=>worker.webhook(raw,headers,settings,now+601000));
 assert.throws(()=>worker.webhook(raw,headers,{...settings,verificationToken:'wrong'},now));
});
test('Feishu text and rich posts normalize without media downloads or implicit context',()=>{
 const event={sender:{sender_type:'user',sender_id:{open_id:'ou_approved'}},message:{message_id:'om_fixture',chat_id:'oc_group',chat_type:'group',create_time:String(Date.now()),message_type:'text',content:'{"text":"@_bot Hello"}',mentions:[{key:'@_bot',id:{open_id:'ou_bot'}}]}};
 assert.equal(worker.normalize(event,'ou_bot').text,'Hello');assert.equal(worker.normalize(event,'ou_bot').mentionedBot,true);
 const post={...event,message:{...event.message,message_type:'post',content:JSON.stringify({zh_cn:{title:'Title',content:[[{tag:'text',text:'Body'}]]}})}};assert.match(worker.normalize(post,'ou_bot').text,/Title\nBody/);
 assert.throws(()=>worker.normalize({...event,message:{...event.message,message_type:'image'}},'ou_bot'));
 assert.ok(worker.chunks('中'.repeat(3000)).every(part=>Buffer.byteLength(part)<=3800));
});
async function fixture(options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-broker-')),token='a'.repeat(64),other='b'.repeat(64);
 const credentialsFile=path.join(root,'credentials.json'),accessFile=path.join(root,'access.json');fs.writeFileSync(credentialsFile,JSON.stringify({appId:'cli_0123456789abcdef',appSecret:'REAL_CHANNEL_SECRET',domain:'feishu'}));fs.writeFileSync(accessFile,JSON.stringify(access));
 const instance={id:'fixture',containerId:'gateway',channelIsolation:{accounts:{default:{token,state:'active',credentialsFile,accessFile,wsOrigins:['wss://msg-frontier.feishu.cn']},other:{token:other,state:'active',credentialsFile,accessFile,wsOrigins:[]}}}};
 const toolPolicy={allow:['read','write','edit'],deny:['exec','cron','sessions_history'],elevated:{enabled:false}};instance.channelIsolation.agentPolicies={main:{workspace:'/home/node/.openclaw/workspaces/main',tools:toolPolicy}};
 const cfg={agents:{entries:{main:{workspace:'/home/node/.openclaw/workspaces/main',tools:toolPolicy}}},models:{providers:{fixture:{apiKey:'MODEL_SECRET'}}}};
 const store={listInstanceIds:()=>['fixture'],loadInstance:()=>instance,instanceDir:()=>root,readOpenclawConfig:()=>JSON.stringify(cfg),atomicWrite:(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}};
 const calls=[],apiCalls=[];let vendorInput=input(),vendorEndpoint='wss://msg-frontier.feishu.cn/ws?device_id=fixture&service_id=1',vendorFailure=false;
 const gateway={rpc:async(i,method,params,opts)=>{calls.push({i,method,params});opts.onEvent({kind:'chat',data:{state:'final',message:{content:[{type:'text',text:'Reply MODEL_SECRET'}]}}});}};
 const apiFetch=async(url,opts)=>{apiCalls.push({url,opts});
  if(url.endsWith('/internal'))return new Response(JSON.stringify({code:0,tenant_access_token:'REAL_TENANT_TOKEN',expire:7200}));
  if(url.endsWith('/info'))return new Response(JSON.stringify({code:0,bot:{open_id:'ou_bot'}}));
  if(url.endsWith('/endpoint'))return new Response(JSON.stringify({code:0,data:{URL:vendorEndpoint,ClientConfig:{PingInterval:30,unexpected:'secret'}}}));
  if(url.includes('/open-apis/im/v1/messages/')&&!url.endsWith('/reply'))return new Response(JSON.stringify({code:0,data:{items:[{message_id:vendorInput.messageId,chat_id:vendorInput.chatId,msg_type:'text',create_time:String(vendorInput.createdAt),sender:{id:vendorInput.senderId,id_type:'open_id',sender_type:'user'},body:{content:JSON.stringify({text:vendorInput.text})},mentions:vendorInput.mentionedBot?[{key:'@bot',id:'ou_bot',id_type:'open_id',name:'bot'}]:[]}]}}));
  if(url.includes('/open-apis/im/v1/chats/'))return new Response(JSON.stringify({code:0,data:{chat_mode:vendorInput.chatType}}));
  if(vendorFailure)throw Error('ambiguous send');return new Response(JSON.stringify({code:0,data:{}}));
 };
 const bridge=require('../src/channel-bridge').create({store,gateway,apiFetch,isRunning:async()=>true,scrub:text=>text.replace('MODEL_SECRET','[redacted]'),...options});
 bridge.server.listen(0,'127.0.0.1');await new Promise(r=>bridge.server.once('listening',r));const port=bridge.server.address().port;
 async function request(route,body,auth=token){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:route,method:body?'POST':'GET',headers:{Authorization:'Bearer '+auth,'Content-Type':'application/json'}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw||'{}')}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});}
 async function complete(id){let result;for(let i=0;i<30;i++){result=await request('/v1/results/'+id);if(result.body.status==='completed')return result;await new Promise(r=>setTimeout(r,5));}assert.fail(JSON.stringify(result));}
 return {root,token,other,instance,cfg,calls,apiCalls,request,complete,bridge,accessFile,store,setMessage:value=>vendorInput=value,setEndpoint:value=>vendorEndpoint=value,setVendorFailure:()=>vendorFailure=true,close:async()=>{bridge.close();await new Promise(r=>setTimeout(r,5));fs.rmSync(root,{recursive:true,force:true});}};
}
test('broker strips control authority, binds sessions, deduplicates ingress and never returns transcripts or keys',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request('/v1/events',{...input(),agentId:'admin'})).status,403);
  const value={messageId:'om_fixture'},accepted=await f.request('/v1/events',value);assert.equal(accepted.status,202);const done=await f.complete(accepted.body.id);
  assert.deepEqual(done.body,{id:accepted.body.id,status:'completed',parts:1});assert.equal(f.calls.length,1);assert.equal(f.calls[0].params.deliver,false);assert.equal(f.calls[0].params.suppressCommandInterpretation,true);assert.equal(f.calls[0].params.message,'Hello');assert.match(f.calls[0].params.sessionKey,/^agent:main:feishu-isolated:/);
  await f.request('/v1/events',value);assert.equal(f.calls.length,1);assert.equal((await f.request('/v1/events',{...value,text:'changed'})).status,403);
  assert.equal((await f.request('/v1/results/'+accepted.body.id,null,f.other)).status,403);
  assert.equal((await f.request('/v1/results/'+accepted.body.id,null,'wrong')).status,403);
 }finally{await f.close();}
});
test('credential proxy permits only own identity, approved WS origins and exact generated reply parts',async()=>{
 const f=await fixture();try{
  const identity=await f.request('/v1/identity');assert.deepEqual(identity.body,{botId:'ou_bot',appId:'cli_0123456789abcdef',domain:'feishu'});assert.ok(!JSON.stringify(identity).includes('REAL_'));
  const endpoint=await f.request('/v1/ws-endpoint',{});assert.equal(endpoint.status,200);assert.equal(endpoint.body.data.ClientConfig.unexpected,undefined);
  assert.equal((await f.request('/v1/ws-endpoint',{url:'https://evil.invalid'})).status,403);f.setEndpoint('wss://evil.invalid/ws');assert.equal((await f.request('/v1/ws-endpoint',{})).status,403);
  const accepted=await f.request('/v1/events',{messageId:'om_fixture'});await f.complete(accepted.body.id);
  assert.equal((await f.request('/v1/reply',{id:accepted.body.id,part:0,recipient:'oc_other',text:'steal'})).status,403);
  assert.equal((await f.request('/v1/reply',{id:accepted.body.id,part:0})).body.status,'sent');const count=f.apiCalls.length;
  assert.equal((await f.request('/v1/reply',{id:accepted.body.id,part:0})).body.status,'sent');assert.equal(f.apiCalls.length,count);
  const sent=f.apiCalls.at(-1);assert.ok(sent.url.endsWith('/om_fixture/reply'));assert.equal(sent.opts.headers.Authorization,'Bearer REAL_TENANT_TOKEN');assert.equal(JSON.parse(JSON.parse(sent.opts.body).content).text,'Reply [redacted]');
 }finally{await f.close();}
});
test('forged transport claims cannot override provider identity, chat, mention or message body',async()=>{
 const f=await fixture();try{
  let index=0;
  for(const patch of [{senderId:'ou_other'},{chatId:'oc_other'},{mentionedBot:false},{text:'/plugins install evil'}]){
   const messageId='om_denied_'+index++;f.setMessage({...input(),messageId,...patch});const accepted=await f.request('/v1/events',{messageId});
   assert.equal(accepted.status,202);let result;for(let i=0;i<30;i++){result=await f.request('/v1/results/'+accepted.body.id);if(result.body.status==='failed')break;await new Promise(r=>setTimeout(r,5));}
   assert.equal(result.body.status,'failed');assert.equal(f.calls.length,0);
  }
 }finally{await f.close();}
});
test('staged transports cannot submit messages or obtain WebSocket capabilities before cutover',async()=>{
 const f=await fixture();try{f.instance.channelIsolation.accounts.default.state='staged';assert.equal((await f.request('/v1/identity')).status,200);assert.equal((await f.request('/v1/events',{messageId:'om_fixture'})).status,403);assert.equal((await f.request('/v1/ws-endpoint',{})).status,403);assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('revoked peers cannot receive queued model replies and ambiguous sends never auto-retry',async()=>{
 const f=await fixture();try{
  const accepted=await f.request('/v1/events',{messageId:'om_fixture'});await f.complete(accepted.body.id);fs.writeFileSync(f.accessFile,JSON.stringify({...access,groupAllowFrom:[]}));
  assert.equal((await f.request('/v1/reply',{id:accepted.body.id,part:0})).status,403);
  fs.writeFileSync(f.accessFile,JSON.stringify(access));f.setVendorFailure();assert.equal((await f.request('/v1/reply',{id:accepted.body.id,part:0})).body.status,'unknown');const count=f.apiCalls.length;
  await f.request('/v1/reply',{id:accepted.body.id,part:0});assert.equal(f.apiCalls.length,count);assert.deepEqual((await f.request('/v1/pending')).body.jobs,[]);
 }finally{await f.close();}
});
test('broker restart marks an unconfirmed Agent dispatch unknown instead of replaying it',async()=>{
 const f=await fixture();try{
  const id='c'.repeat(64),folder=path.join(f.root,'manager','channel-jobs','default');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,id+'.json'),JSON.stringify({id,status:'running',input:input(),createdAt:Date.now()}));
  assert.equal((await f.request('/v1/results/'+id)).body.status,'unknown');assert.equal(f.calls.length,0);
 }finally{await f.close();}
});
test('transport sends no credentials, model output or arbitrary API requests and recovers broker-owned pending jobs',async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-transport-')),requests=[];const jobId='c'.repeat(64);let accepted;
 const fetch=async(url,opts)=>{requests.push({url,opts});const route=new URL(url).pathname;
  if(route==='/v1/identity')return new Response(JSON.stringify({botId:'ou_bot',appId:'cli_0123456789abcdef',domain:'feishu'}));
  if(route==='/v1/events'){accepted=JSON.parse(opts.body);return new Response(JSON.stringify({id:jobId}));}
  if(route==='/v1/pending')return new Response(JSON.stringify({jobs:[{id:jobId,status:'completed'}]}));
  if(route.startsWith('/v1/results/'))return new Response(JSON.stringify({status:'completed',parts:1}));
  if(route==='/v1/reply')return new Response(JSON.stringify({status:'sent'}));throw Error('Unexpected request');
 };
 try{const transport=worker.create({brokerOrigin:'http://broker.test:18081',token:'a'.repeat(64)},{fetch,stateDir:state});await transport.connect();
  const event={sender:{sender_type:'user',sender_id:{open_id:'ou_approved'}},message:{message_id:'om_fixture',chat_id:'oc_group',chat_type:'group',message_type:'text',content:'{"text":"Hello"}',create_time:String(Date.now()),mentions:[]}};
  await transport.receive(event);await transport.poll();assert.deepEqual(accepted,{messageId:'om_fixture'});assert.ok(requests.every(r=>r.url.startsWith('http://broker.test:18081/')));assert.deepEqual(JSON.parse(requests.find(r=>r.url.endsWith('/v1/reply')).opts.body),{id:jobId,part:0});
  assert.ok(!JSON.stringify(requests).includes('AppSecret'));assert.ok(!JSON.stringify(requests).includes('tenant_access_token'));
 }finally{fs.rmSync(state,{recursive:true,force:true});}
});
