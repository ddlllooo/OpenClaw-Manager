'use strict';
// Explicit integration test: disposable, offline container; no production data,
// credentials, Docker socket or host mounts are made available to plugin code.
const Docker = require('dockerode'), assert = require('node:assert/strict');
const docker = new Docker({socketPath:require('../src/runtime-platform').dockerSocket()});
const gateway = require('../src/gateway-rpc');
const {createInstaller} = require('../src/plugin-install');
const token = 'synthetic-plugin-test-token-1234567890123456';
const name = 'plugin-consent-smoke-' + Date.now();
const bootstrap = String.raw`
const fs=require('fs'),{spawn,execFileSync}=require('child_process'),crypto=require('crypto');
const root='/tmp/plugin-smoke';fs.mkdirSync(root,{recursive:true});fs.mkdirSync(root+'/fixture');
fs.writeFileSync(root+'/openclaw.json',JSON.stringify({gateway:{mode:'local',auth:{mode:'token',token:process.env.OPENCLAW_GATEWAY_TOKEN}}}));
fs.writeFileSync(root+'/fixture/package.json',JSON.stringify({name:'manager-consent-fixture',version:'1.2.3',type:'module',scripts:{postinstall:"touch /tmp/PLUGIN_INSTALL_SCRIPT_EXECUTED"},openclaw:{extensions:['./index.js']}}));
fs.writeFileSync(root+'/fixture/openclaw.plugin.json',JSON.stringify({id:'manager-consent-fixture',name:'Consent fixture',version:'1.2.3',configSchema:{type:'object',additionalProperties:false,properties:{}}}));
fs.writeFileSync(root+'/fixture/index.js',"import fs from 'node:fs';fs.writeFileSync('/tmp/PLUGIN_CODE_EXECUTED','yes');export default {id:'manager-consent-fixture',register(){}};");
execFileSync('tar',['-czf',root+'/fixture.tgz','-C',root,'fixture']);
const artifact=fs.readFileSync(root+'/fixture.tgz');const integrity='sha512-'+crypto.createHash('sha512').update(artifact).digest('base64');fs.writeFileSync(root+'/integrity',integrity);
require('http').createServer((req,res)=>{if(req.url==='/fixture.tgz'){res.end(artifact);return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({name:'manager-consent-fixture','dist-tags':{latest:'1.2.3'},versions:{'1.2.3':{name:'manager-consent-fixture',version:'1.2.3',dist:{tarball:'http://127.0.0.1:18788/fixture.tgz',integrity}}}}));}).listen(18788,'127.0.0.1');
const child=spawn('openclaw',['gateway','--allow-unconfigured','--bind','loopback'],{stdio:'inherit'});child.on('exit',code=>process.exit(code||0));
`;
async function exec(container, args) {
  const task = await container.exec({Cmd:args,AttachStdout:true,AttachStderr:true});
  const stream = await task.start({}); let text=''; for await(const chunk of stream)text+=chunk;
  return {code:(await task.inspect()).ExitCode,text};
}
(async()=>{
  let container;
  try {
    container = await docker.createContainer({name,Image:process.env.OPENCLAW_PLUGIN_TEST_IMAGE||'ghcr.io/openclaw/openclaw:2026.9.3-amd64-offline',User:'1000:1000',Entrypoint:['node'],Cmd:['-e',bootstrap],Env:['HOME=/tmp/plugin-smoke','OPENCLAW_STATE_DIR=/tmp/plugin-smoke','OPENCLAW_CONFIG_PATH=/tmp/plugin-smoke/openclaw.json','OPENCLAW_GATEWAY_TOKEN='+token,'npm_config_registry=http://127.0.0.1:18788','npm_config_fetch_retries=0'],HostConfig:{NetworkMode:'none',CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:256}});
    await container.start(); const instance={containerName:name,gatewayToken:token};
    let ready=false;
    for(let i=0;i<40;i++) {try {await gateway.rpc(instance,'health',{}, {timeout:2000});ready=true;break;}catch {await new Promise(r=>setTimeout(r,500));} }
    assert.equal(ready,true,'fixture gateway must start');
    const integrityResult=await exec(container,['node','-e',"process.stdout.write(require('fs').readFileSync('/tmp/plugin-smoke/integrity','utf8'))"]);
    const integrity=/sha512-[A-Za-z0-9+/]{86}==/.exec(integrityResult.text)?.[0];assert.ok(integrity);
    const spec='manager-consent-fixture@1.2.3';
    const api=createInstaller({rpc:gateway.rpc,allowlist:()=>'',nativeAllowlist:()=> 'manager-consent-fixture',fetchMetadata:async()=>({name:'manager-consent-fixture',version:'1.2.3',dist:{integrity,tarball:'https://registry.npmjs.org/manager-consent-fixture/-/fixture-1.2.3.tgz'}})});
    const source=await api.prepare('session',spec);
    const body=review=>({spec,confirmSpec:spec,reviewToken:review.reviewToken});
    const review=await api.install('session',instance,body(source));
    assert.equal(review.phase,'capabilities');assert.ok(review.declared);
    for(const file of ['PLUGIN_CODE_EXECUTED','PLUGIN_INSTALL_SCRIPT_EXECUTED']) assert.equal((await exec(container,['node','-e',"process.exit(require('fs').existsSync('/tmp/"+file+"')?1:0)"])).code,0,'unapproved code must not execute');
    const stale=await gateway.rpc(instance,'manager.plugins.install',{spec,expectedIntegrity:integrity,acknowledgeCapabilities:{reviewToken:'stale-token'}},{timeout:60000}).then(()=>null,error=>error);
    assert.equal(stale?.details?.capabilityConsentCode,'PLUGIN_CAPABILITY_CONSENT_REQUIRED');
    const result=await api.install('session',instance,body(review));assert.equal(result.ok,true);
    console.log('REAL_NPM_ARTIFACT_CHECKED_AND_PERMISSION_REVIEW_REQUIRED_BEFORE_INSTALL');
    assert.equal((await exec(container,['node','-e',"process.exit(require('fs').existsSync('/tmp/PLUGIN_INSTALL_SCRIPT_EXECUTED')?1:0)"])).code,0,'npm lifecycle scripts must not execute');
    const tampered=await gateway.rpc(instance,'manager.plugins.install',{spec,expectedIntegrity:'sha512-'+Buffer.alloc(64).toString('base64')},{timeout:60000}).then(()=>null,error=>error);
    assert.ok(tampered);assert.match(tampered.message,/integrity|checksum|sha512/i);
    console.log('REAL_NPM_INTEGRITY_MISMATCH_AND_STALE_CONSENT_REJECTED_INSTALL_SCRIPTS_DISABLED');
  } finally {if(container)await container.remove({force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
