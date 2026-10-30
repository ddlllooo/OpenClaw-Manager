'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'isolated-channel-access-'));process.env.OPENCLAW_DATA_DIR=path.join(root,'instances');
const store=require('../src/instances'),access=require('../src/channel-access'),plan=require('../security/feishu-provision.cjs').plan;
const rules={agentId:'main',dmPolicy:'allowlist',allowFrom:['ou_user'],groupPolicy:'allowlist',groupAllowFrom:['oc_group'],groupSenderAllowFrom:[],requireMention:true,groups:{},routes:[]};
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('existing account credentials and routes are split from model config without resolving arbitrary secret providers',()=>{
 const config={models:{providers:{fixture:{apiKey:'MODEL_KEY_VALUE'}}},agents:{entries:{main:{},research:{workspace:'/home/node/.openclaw/workspaces/research'},feishu:{workspace:'/home/node/.openclaw/workspaces/feishu'}}},channels:{feishu:{appId:'cli_0123456789abcdef',appSecret:'${FEISHU_APP_SECRET}'}},bindings:[{agentId:'research',match:{channel:'feishu',peer:{kind:'group',id:'oc_group'}}}]};
 const input={store:{readOpenclawConfig:()=>JSON.stringify(config),parseEnv:store.parseEnv,readEnvFile:()=>''},instance:{},state:{Config:{Env:['FEISHU_APP_SECRET=CHANNEL_KEY_VALUE']}},definition:{mode:'text-only',accounts:{default:{...rules,agentId:'feishu',routes:undefined}}},broker:'http://172.17.0.1:18081'};
 const result=plan(input);assert.equal(result.config.channels.feishu,undefined);assert.equal(result.config.models.providers.fixture.apiKey,'MODEL_KEY_VALUE');assert.equal(result.accounts.default.credentials.appSecret,'CHANNEL_KEY_VALUE');assert.deepEqual(result.accounts.default.access.routes,[{kind:'group',peerId:'oc_group',agentId:'research'}]);
 config.channels.feishu.appSecret={source:'exec',id:'secret'};assert.throws(()=>plan(input),/不执行/);
 config.channels.feishu.appSecret='${OPENAI_API_KEY}';assert.throws(()=>plan(input),/模型\/API/);
});
test('management access updates are private, revision-checked and cannot re-enable native Feishu',()=>{
 const id='fixture',file=path.join(root,'access.json');fs.writeFileSync(file,JSON.stringify(rules));
 const instance={id,gatewayToken:'fixture',channelIsolation:{accounts:{default:{accessFile:file}}}};store.saveInstance(instance);fs.mkdirSync(store.configDir(id),{recursive:true});
 const config={models:{providers:{fixture:{apiKey:'MODEL_KEY_VALUE'}}},plugins:{entries:{feishu:{enabled:false}},deny:['feishu']}};fs.writeFileSync(path.join(store.configDir(id),'openclaw.json'),JSON.stringify(config));
 const view=access.view(instance,'');assert.equal(view.account,'default');assert.equal(view.isolated,true);assert.ok(!JSON.stringify(view).includes('MODEL_KEY_VALUE'));
 access.patch(instance,{revision:view.revision,account:'default',patch:{allowFrom:['ou_new']}});assert.deepEqual(JSON.parse(fs.readFileSync(file)).allowFrom,['ou_new']);assert.equal(JSON.parse(store.readOpenclawConfig(id)).models.providers.fixture.apiKey,'MODEL_KEY_VALUE');
 assert.throws(()=>access.patch(instance,{revision:view.revision,account:'default',patch:{dmPolicy:'disabled'}}),/刷新/);
 assert.throws(()=>access.patch(instance,{revision:access.view(instance).revision,account:'default',patch:{dmPolicy:'open',allowFrom:['*']}}));
 assert.throws(()=>store.writeEnvFile(id,'FEISHU_APP_SECRET=forbidden'));assert.throws(()=>store.writeOpenclawConfig(id,JSON.stringify({...config,channels:{feishu:{enabled:true}}})));
});
