 'use strict';
// Run against the intended Manager data directory. Never prints configuration secrets.
const store=require('../src/instances'),policy=require('../src/container-policy'),path=require('path');
(async()=>{
 const id=process.argv[2];if(!id)throw new Error('Usage: node scripts/restrict-agent.cjs INSTANCE_ID [--apply]');
 const instance=store.loadInstance(id),before=store.readOpenclawConfig(id);
 const candidate=JSON.stringify(policy.agentConfig(JSON.parse(before),'restricted'),null,2)+'\n';
 if(!process.argv.includes('--apply')){console.log('Preview: restrict filesystem tools to workspace; disable elevated, commands, web/browser, remote nodes and agent administration tools. Re-run with --apply to validate and save.');return;}
 await require('../src/validation').validate(instance,candidate);
 if(store.readOpenclawConfig(id)!==before)throw new Error('Configuration changed during validation; retry after refreshing');
 store.atomicWrite(path.join(store.configDir(id),'openclaw.json.last-good'),before);
 store.writeOpenclawConfig(id,candidate);instance.configPending=true;store.saveInstance(instance);
 console.log('Restricted policy saved; restart the instance to apply. Set OPENCLAW_AGENT_POLICY=restricted on Manager to enforce future configuration writes.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
