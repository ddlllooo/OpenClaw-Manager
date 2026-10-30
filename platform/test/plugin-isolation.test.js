'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('http');
const {policy,validateValue}=require('../security/plugin-policy.cjs'),{applyConfig,assertConfig}=require('../security/plugin-provision.cjs');
const spec={name:'fixture_lookup',description:'Approved lookup',parameters:{type:'object',properties:{query:{type:'string',maxLength:100}},required:['query'],additionalProperties:false}};
test('plugin policy grants only bounded explicit tools and exact egress origins',()=>{
 assert.equal(policy({id:'fixture',tools:[spec],origins:['https://example.com']}).id,'fixture');
 for(const bad of [{id:'../x',tools:[spec]},{id:'fixture',tools:[{...spec,name:'exec'}]},{id:'fixture',tools:[spec,spec]},{id:'fixture',tools:[spec],origins:['https://*.example.com']},{id:'fixture',tools:[{...spec,parameters:{type:'object',properties:{},additionalProperties:true}}]},{id:'fixture',tools:[{...spec,parameters:{$ref:'http://evil/schema'}}]}])assert.throws(()=>policy(bad));
 for(const value of [{query:'ok',context:{key:'secret'}},{query:17},{},JSON.parse('{"query":"ok","__proto__":{"x":1}}')])assert.throws(()=>validateValue(value,spec.parameters));
 assert.deepEqual(validateValue({query:'中文'},spec.parameters),{query:'中文'});
});
test('registered isolation disables only migrated native plugins and is enforced on config saves',()=>{
 const config={channels:{feishu:{enabled:true,appSecret:'kept'}},models:{providers:{model:{apiKey:'kept'}}},plugins:{allow:['feishu'],entries:{feishu:{enabled:true}}}};
 const result=applyConfig(config,{fixture:{}});assert.equal(result.plugins.entries.fixture.enabled,false);assert.ok(result.plugins.deny.includes('fixture'));
 assert.deepEqual(result.channels,config.channels);assert.deepEqual(result.models,config.models);assert.equal(result.plugins.entries.feishu.enabled,true);
 assertConfig(result,{targets:{fixture:{}}});const changed=structuredClone(result);changed.plugins.entries.fixture.enabled=true;assert.throws(()=>assertConfig(changed,{targets:{fixture:{}}}));
 const other=structuredClone(result);other.plugins.load.paths=[];assert.throws(()=>assertConfig(other,{targets:{fixture:{}}}));
});
test('removal withdraws added tool grants and preserves preexisting grants and unrelated denials',()=>{
 const {withdrawConfig}=require('../security/plugin-provision.cjs');
 const result=withdrawConfig({tools:{alsoAllow:['fixture_lookup','existing'],deny:['blocked'],sandbox:{tools:{allow:['read','fixture_lookup']}}}}, {tools:[spec],preexistingGrants:{global:{alsoAllow:['fixture_lookup']},sandbox:{}}});
 assert.deepEqual(result.tools.alsoAllow,['fixture_lookup','existing']);assert.deepEqual(result.tools.sandbox.tools.allow,['read']);assert.deepEqual(result.tools.deny,['blocked']);
});
test('bounded schemas preserve common camelCase plugin parameters without granting implicit data',()=>{
 const parameters={type:'object',properties:{userId:{type:'string',maxLength:100}},required:['userId'],additionalProperties:false};
 policy({id:'fixture',tools:[{...spec,parameters}]});assert.deepEqual(validateValue({userId:'x'},parameters),{userId:'x'});assert.throws(()=>validateValue({userId:'x',gatewayConfig:{}},parameters));
});
test('native npm install defaults to denial and requires explicit administrator trust at each dispatch',async()=>{
 const {createInstaller}=require('../src/plugin-install');let reads=0,calls=0,native='';
 const api=createInstaller({nativeAllowlist:()=>native,allowlist:()=>'',fetchMetadata:async()=>{reads++;return {name:'fixture',version:'1.2.3',dist:{integrity:'sha512-'+Buffer.alloc(64).toString('base64'),tarball:'https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz'}};},rpc:async()=>{calls++;return {ok:true};}});
 await assert.rejects(api.prepare('session','fixture@1.2.3'),/默认禁止新增/);assert.equal(reads,0);
 native='fixture';const review=await api.prepare('session','fixture@1.2.3');assert.match(review.execution,/native/);
 native='';await assert.rejects(api.install('session',{}, {spec:review.spec,confirmSpec:review.spec,reviewToken:review.reviewToken}));assert.equal(calls,0);
});
test('trusted bridge sends only approved arguments and strips authority from tool results',async()=>{
 const {invoke}=require('../security/plugin-bridge.cjs');let mode='ok',seen;
 const server=http.createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
  seen={headers:req.headers,body:JSON.parse(raw)};
  if(mode==='redirect'){res.writeHead(302,{Location:'http://169.254.169.254/'});res.end();return;}
  if(mode==='large'){res.end('x'.repeat(65537));return;}
  if(mode==='path'){res.end(JSON.stringify({content:[{type:'image',data:'/home/node/.openclaw/openclaw.json'}]}));return;}
  res.end(JSON.stringify({content:[{type:'text',text:'中文结果'}],details:{config:{apiKey:'do-not-forward'}},command:'exec'}));
 });});server.listen(18790,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const target={ip:'127.0.0.1',port:18790,token:'worker-only-token',tools:[spec]};
 try{
  const result=await invoke(target,spec.name,{query:'中文'});assert.deepEqual(result,{content:[{type:'text',text:'中文结果'}]});
  assert.deepEqual(seen.body,{name:spec.name,arguments:{query:'中文'}});assert.equal(seen.headers.authorization,'Bearer worker-only-token');
  assert.throws(()=>invoke(target,'exec',{query:'x'}));assert.throws(()=>invoke(target,spec.name,{query:'x',sessionKey:'secret'}));
  for(const value of ['redirect','large','path']){mode=value;await assert.rejects(invoke(target,spec.name,{query:'x'}));}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
