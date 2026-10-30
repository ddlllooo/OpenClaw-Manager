'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'plugin-api-'));process.env.OPENCLAW_DATA_DIR=path.join(scratch,'instances');process.env.MANAGER_NATIVE_PLUGIN_ALLOWLIST='fixture-plugin';
const store=require('../src/instances'),gateway=require('../src/gateway-rpc'),docker=require('../src/docker');
store.saveInstance({id:'fixture',containerId:'fixture-container',containerName:'fixture',gatewayToken:'synthetic-secret'});
fs.mkdirSync(store.configDir('fixture'),{recursive:true});
const configFile=path.join(store.configDir('fixture'),'openclaw.json');fs.writeFileSync(configFile,'{}');
const calls=[];gateway.rpc=async(i,method,params)=>{calls.push({method,params});return {ok:true};};
gateway.cli=async()=>JSON.stringify({plugins:[{id:'fixture-plugin'}]});docker.inspectContainer=async()=>({State:{Running:true}});
const originalFetch=global.fetch,integrity='sha512-'+Buffer.alloc(64,3).toString('base64');
global.fetch=async()=>new Response(JSON.stringify({name:'fixture-plugin',version:'1.2.3',dist:{integrity,tarball:'https://registry.npmjs.org/fixture-plugin/-/fixture-plugin-1.2.3.tgz'}}));
const express=require('express'),app=express();app.use(express.json());app.use('/',require('../src/routes/management'));
let server,port;
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));port=server.address().port;});
test.after(async()=>{global.fetch=originalFetch;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(scratch,{recursive:true,force:true});});
function post(route,body,cookie='session-a',method='POST') {
  return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:'/fixture/extensions/plugin'+route,method,headers:{'Content-Type':'application/json',Cookie:cookie,'x-csrf-token':'csrf'}},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(JSON.stringify(body));});
}
function revision(){return store.revision(JSON.stringify(JSON.parse(fs.readFileSync(configFile,'utf8'))));}
test('legacy direct install and forged acknowledgment flags cannot bypass server review',async()=>{
  const before=calls.length;
  const result=await post('/install',{revision:revision(),spec:'fixture-plugin@1.2.3',acceptCapabilities:true,acknowledgeInstallPolicyWarning:true});
  assert.equal(result.status,409);assert.equal(calls.length,before);
});
test('HTTP source review survives redaction and permits a single bound install',async()=>{
  const rev=revision(),spec='fixture-plugin@1.2.3';
  const review=await post('/review',{revision:rev,spec});assert.equal(review.status,200);assert.match(review.body.reviewToken,/^[a-f0-9]{64}$/);
  const body={revision:rev,spec,confirmSpec:spec,reviewToken:review.body.reviewToken};
  assert.equal((await post('/install',body,'session-b')).status,409);
  assert.equal((await post('/install',body)).status,200);
  assert.equal(calls.at(-1).method,'manager.plugins.install');assert.equal(calls.at(-1).params.expectedIntegrity,integrity);
  assert.equal((await post('/install',body)).status,409);
});
test('intervening configuration changes invalidate HTTP plugin approvals',async()=>{
  const rev=revision(),spec='fixture-plugin@1.2.3',review=await post('/review',{revision:rev,spec});
  fs.writeFileSync(configFile,JSON.stringify({plugins:{deny:['fixture-plugin']}}));
  const before=calls.length;
  assert.equal((await post('/install',{revision:revision(),spec,confirmSpec:spec,reviewToken:review.body.reviewToken})).status,409);
  assert.equal(calls.length,before);fs.writeFileSync(configFile,'{}');
});
test('enablement uses runtime consent enforcement, while deny remains effective',async()=>{
  assert.equal((await post('',{revision:revision(),pluginId:'fixture-plugin',enabled:true},'session-a','PUT')).status,200);
  assert.deepEqual(calls.at(-1),{method:'plugins.setEnabled',params:{pluginId:'fixture-plugin',enabled:true}});
  fs.writeFileSync(configFile,JSON.stringify({plugins:{deny:['fixture-plugin']}}));
  const before=calls.length;
  assert.equal((await post('',{revision:revision(),pluginId:'fixture-plugin',enabled:true},'session-a','PUT')).status,400);assert.equal(calls.length,before);
});
test('permission groups stay fully visible; reports containing actual secrets cannot be approved',async()=>{
  fs.writeFileSync(configFile,'{}');const previous=gateway.rpc;
  try {
    for(const value of ['SERVICE_KEY','synthetic-secret']) {
      gateway.rpc=async()=>{throw Object.assign(new Error('permission review required'),{details:{capabilityConsentCode:'PLUGIN_CAPABILITY_CONSENT_REQUIRED',pluginId:'fixture-plugin',reviewToken:'report-token',report:{reviewToken:'report-token',declared:{env:[value],headers:['Authorization']}}}});};
      const spec='fixture-plugin@1.2.3',rev=revision(),source=await post('/review',{revision:rev,spec});
      const result=await post('/install',{revision:rev,spec,confirmSpec:spec,reviewToken:source.body.reviewToken});
      if(value==='SERVICE_KEY') {assert.equal(result.status,200);assert.deepEqual(result.body.declared.env,['SERVICE_KEY']);assert.deepEqual(result.body.declared.headers,['Authorization']);}
      else {assert.equal(result.status,403);assert.equal(result.body.reviewToken,undefined);assert.ok(!JSON.stringify(result.body).includes('synthetic-secret'));}
    }
  } finally {gateway.rpc=previous;}
});
test('plugin API cannot enable migrated native entry or disable/uninstall the trusted bridge',async()=>{
  const original=store.loadInstance('fixture'),count=calls.length;
  store.saveInstance({...original,pluginIsolation:{version:1,targets:{'fixture-plugin':{tools:[]}}}});
  try {
    for(const pluginId of ['fixture-plugin','manager-isolated-tools']) {
      assert.equal((await post('',{revision:revision(),pluginId,enabled:true},'session-a','PUT')).status,409);
      assert.equal((await post('/uninstall',{revision:revision(),pluginId})).status,409);
    }
    assert.equal(calls.length,count);
  } finally {store.saveInstance(original);}
});
