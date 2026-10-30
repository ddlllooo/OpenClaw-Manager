'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const helper=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/plugin-helper.cjs'),'utf8')+'\ninstallVerifiedPlugin',{require,process});
const request={spec:'fixture@1.2.3',expectedIntegrity:'sha512-test'};
function runtime({omitReview=false,changed=false}={}) {
  let commits=0,forced=false;const report={pluginId:'fixture',reviewToken:'native-token',declared:{tools:['read'],env:['SERVICE_KEY']},grants:{}};
  const exported=async(prefix,name)=>{
    if(name==='requestDeferredPluginInstall')return options=>options;
    if(name==='resolvePluginInstallTransaction')return ()=>undefined;
    if(name==='readPluginMutationSnapshot')return async()=>({config:{}});
    if(name==='prepareManagedPluginArtifactConsentHandler')return async options=>{forced=options.reviewOfficialArtifacts;return {onBeforePluginArtifactCommit:async()=>{if(!omitReview)await options.onCapabilityConsent(report);}};};
    if(name==='installPluginFromNpmSpec')return async options=>{await options.onBeforePluginArtifactCommit({});commits++;return {ok:true};};
    if(name==='installManagedPluginSource')return async options=>{
      assert.equal(options.safetyOverrides,undefined);
      assert.equal(options.request.expectedIntegrity,request.expectedIntegrity);
      if(changed)await options.onCapabilityConsent({...report,declared:{tools:['exec']}});
      options.beforePersistentEffect();commits++;return {ok:true,config:{secret:'must-not-return'}};
    };
    throw Error('unexpected export '+name);
  };
  return {exported,commits:()=>commits,forced:()=>forced};
}
test('helper forces even official artifacts through staging review, without committing',async()=>{
  const rt=runtime();await assert.rejects(helper({params:request},rt.exported),error=>{
    assert.equal(error.details.capabilityConsentCode,'PLUGIN_CAPABILITY_CONSENT_REQUIRED');
    assert.deepEqual(Array.from(error.details.report.declared.env),['SERVICE_KEY']);return true;
  });assert.equal(rt.forced(),true);assert.equal(rt.commits(),0);
});
test('omitted native review callback fails closed instead of implicitly approving a source',async()=>{
  const rt=runtime({omitReview:true});await assert.rejects(helper({params:request},rt.exported),/未获得权限批准/);assert.equal(rt.commits(),0);
});
test('helper approval binds the full report and excludes runtime config from results',async()=>{
  const rt=runtime();const refusal=await helper({params:request},rt.exported).catch(e=>e);
  const approved={...request,acknowledgeCapabilities:{reviewToken:refusal.details.reviewToken}};
  const result=await helper({params:approved},rt.exported);assert.equal(result.ok,true);assert.equal(result.config,undefined);assert.equal(rt.commits(),1);
  const changed=runtime({changed:true});await assert.rejects(helper({params:approved},changed.exported),error=>error.details?.capabilityConsentCode==='PLUGIN_CAPABILITY_CONSENT_REQUIRED');assert.equal(changed.commits(),0);
});
