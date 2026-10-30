'use strict';
const fs=require('fs'),Docker=require('dockerode'),store=require('../src/instances'),{policy}=require('../security/plugin-policy.cjs');
(async()=>{
 const args=process.argv.slice(2),id=args[0],at=flag=>args[args.indexOf(flag)+1];
 if(id&&args.includes('--remove')){
  const instance=store.loadInstance(id),plugin=at('--remove');if(!instance.pluginIsolation?.targets?.[plugin])throw Error('独立插件不存在');
  if(!args.includes('--apply')){console.log('Preview: remove isolated plugin '+plugin+'; native plugin remains disabled. --apply to continue.');return;}
  if(process.env.OPENCLAW_CONTROL_SOCKET)throw Error('Use the Docker host administrator environment');
  const docker=new Docker({socketPath:process.env.OPENCLAW_DOCKER_SOCKET||require('../src/runtime-platform').dockerSocket()});
  await require('../security/plugin-provision.cjs').remove({docker,store,instance,id:plugin});console.log('Isolated plugin removed; native plugin remains disabled');return;
 }
 if(!id||!args.includes('--policy')||!args.includes('--image'))throw Error('Usage: node scripts/isolate-plugin.cjs INSTANCE --policy FILE --image IMAGE [--apply]');
 const definition=policy(JSON.parse(fs.readFileSync(at('--policy'),'utf8'))),instance=store.loadInstance(id);
 console.log(JSON.stringify({instance:id,plugin:definition.id,tools:definition.tools.map(t=>t.name),origins:definition.origins||[],image:at('--image'),dataAccess:'none; plugin-specific config only'},null,2));
 if(!args.includes('--apply')){console.log('Preview only; --apply creates isolated tools and disables the matching native plugin.');return;}
 if(process.env.OPENCLAW_CONTROL_SOCKET)throw Error('Use the Docker host administrator environment; the Manager cannot provision arbitrary plugin containers');
 const docker=new Docker({socketPath:process.env.OPENCLAW_DOCKER_SOCKET||require('../src/runtime-platform').dockerSocket()});
 await require('../security/plugin-provision.cjs').apply({docker,store,instance,definition,image:at('--image')});console.log('Isolated plugin activated; native plugin disabled, gateway restarted');
})().catch(error=>{console.error('Plugin isolation failed:',error.message);process.exitCode=1;});
