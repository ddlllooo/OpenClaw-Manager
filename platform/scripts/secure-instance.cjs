 'use strict';
// Execute as the Docker host administrator, not from the Manager web container.
const Docker=require('dockerode'),store=require('../src/instances'),profile=require('../security/profile.cjs');
(async()=>{
 const args=process.argv.slice(2),id=args[0];if(!id)throw Error('Usage: node scripts/secure-instance.cjs ID [--apply] [--runtime IMAGE] [--worker IMAGE] [--allow ORIGIN] [--allow-private ORIGIN] [--add-agent ID]');
 const value=flag=>args[args.indexOf(flag)+1],many=flag=>args.flatMap((v,i)=>v===flag?[args[i+1]]:[]);
 const instance=store.loadInstance(id),config=JSON.parse(store.readOpenclawConfig(id));
 const normalize=flag=>many(flag).map(value=>{require('../security/network-guard.cjs').origins([value]);return new URL(value).origin;});
 const extra=normalize('--allow'),privateOrigins=normalize('--allow-private');
 console.log('Proposed exact egress origins:',profile.origins(config,[...extra,...privateOrigins]).join(', '));
 if(args.includes('--rollback')){
  if(process.env.OPENCLAW_CONTROL_SOCKET)throw Error('Rollback requires the host administrator environment');
  const docker=new Docker({socketPath:process.env.OPENCLAW_DOCKER_SOCKET||require('../src/runtime-platform').dockerSocket()});
  await require('../security/provision.cjs').rollback({docker,store,instance});console.log('Rollback completed; sandbox artifacts retained in manager/security/rollback-workspaces-* for encrypted backup');return;
 }
 if(!args.includes('--apply')){console.log('Preview only. --apply migrates the gateway and creates isolated SSH workers; existing gateway is retained for rollback.');return;}
 if(process.env.OPENCLAW_CONTROL_SOCKET)throw Error('Use the host administrator environment without OPENCLAW_CONTROL_SOCKET; this installer needs resource provisioning rights');
 const docker=new Docker({socketPath:process.env.OPENCLAW_DOCKER_SOCKET||require('../src/runtime-platform').dockerSocket()});
 const result=await require('../security/provision.cjs').applyInstance({docker,store,instance,image:args.includes('--runtime')?value('--runtime'):undefined,workerImage:args.includes('--worker')?value('--worker'):undefined,extraOrigins:[...extra,...privateOrigins],privateOrigins,resolver:args.includes('--resolver')?value('--resolver'):undefined,toolOrigins:normalize('--tool-allow').map(origin=>({origin})),addAgent:args.includes('--add-agent')?value('--add-agent'):undefined});
 console.log('Secure migration completed. Agents:',Object.keys(result.targets).join(', '));
})().catch(error=>{console.error('Security migration failed:',error.message);process.exitCode=1;});
