'use strict';
const fs=require('fs'),Docker=require('dockerode'),store=require('../src/instances');
(async()=>{
 const args=process.argv.slice(2),id=args[0],get=flag=>args[args.indexOf(flag)+1];
 if(id&&args.includes('--remove')){
  const instance=store.loadInstance(id);if(!args.includes('--apply')){console.log('Preview: retire isolated Feishu accounts; native plugin stays disabled. --apply to continue.');return;}
  if(process.env.OPENCLAW_CONTROL_SOCKET)throw Error('Use the host administrator environment');
  const docker=new Docker({socketPath:process.env.OPENCLAW_DOCKER_SOCKET||require('../src/runtime-platform').dockerSocket()});
  await require('../security/feishu-provision.cjs').remove({docker,store,instance});console.log('Channels removed; native entry remains disabled');return;
 }
 if(id&&args.includes('--update-access')&&args.includes('--policy')){
  const instance=store.loadInstance(id),definition=JSON.parse(fs.readFileSync(get('--policy'),'utf8'));
  if(!args.includes('--apply')){console.log('Preview: update access and routes for '+Object.keys(definition.accounts||{}).join(', '));return;}
  await require('../security/feishu-provision.cjs').update({store,instance,definition});console.log('Isolated channel access and routes updated');return;
 }
 if(!id||!args.includes('--policy')||!args.includes('--broker'))throw Error('Usage: node scripts/isolate-feishu.cjs INSTANCE --policy FILE --broker http://PRIVATE_IP:18081 [--image IMAGE] [--webhook ACCOUNT=PORT] [--apply]');
 const instance=store.loadInstance(id),definition=JSON.parse(fs.readFileSync(get('--policy'),'utf8'));
 const channelConfig=args.includes('--credentials')?JSON.parse(fs.readFileSync(get('--credentials'),'utf8')):undefined;
 const docker=new Docker({socketPath:process.env.OPENCLAW_DOCKER_SOCKET||require('../src/runtime-platform').dockerSocket()}),state=await docker.getContainer(instance.containerId).inspect();
 const prepared=require('../security/feishu-provision.cjs').plan({store,instance,state,definition,broker:get('--broker'),channelConfig});
 console.log(JSON.stringify({instance:id,mode:'text-only',accounts:Object.entries(prepared.accounts).map(([id,a])=>({id,connectionMode:a.connectionMode,domain:a.credentials.domain,agentId:a.access.agentId,routes:a.access.routes,dmPolicy:a.access.dmPolicy,groupPolicy:a.access.groupPolicy})),unsupported:prepared.unsupported,sessionHistory:'new per-account/peer sessions; no automatic sharing of old native history'},null,2));
 if(!args.includes('--apply')){console.log('Preview only. --apply removes native Feishu from the gateway and creates credential-free transport containers.');return;}
 if(process.env.OPENCLAW_CONTROL_SOCKET)throw Error('Use the Docker host administrator environment');
 const webhookPorts={};for(let i=0;i<args.length;i++)if(args[i]==='--webhook'){const m=/^([a-z0-9_-]+)=(\d+)$/.exec(args[i+1]||'');if(!m)throw Error('Use --webhook ACCOUNT=PORT');webhookPorts[m[1]]=Number(m[2]);}
 await require('../security/feishu-provision.cjs').apply({docker,store,instance,definition,broker:get('--broker'),image:args.includes('--image')?get('--image'):'openclaw-security-feishu:latest',webhookPorts,channelConfig});
 console.log('Feishu isolated; native entry disabled; gateway restarted; no model or Feishu AppSecret exposed to transport');
})().catch(error=>{console.error('Feishu isolation failed:',error.message);process.exitCode=1;});
