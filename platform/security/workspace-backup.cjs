 'use strict';
async function archive(docker,record,agent,root){
 const scope=require('./profile.cjs').stamp(require('path').resolve(root,record.id).replace(/\\/g,'/'));
 const target=record.security?.targets?.[agent];if(!target)throw Error('Unknown sandbox workspace');
 const container=docker.getContainer(target.workerId),row=await container.inspect();
 if(row.Config.Labels?.['openclaw.security.scope']!==scope||row.Config.Labels?.['openclaw.security.instance']!==record.id||row.Config.Labels?.['openclaw.security.agent']!==agent)throw Error('Sandbox ownership mismatch');
 const pause=row.State.Running&&!row.State.Paused;if(pause)await container.pause();
 let resumed=false;const resume=async()=>{if(resumed)return;resumed=true;if(pause)await container.unpause().catch(()=>{});};
 try{
  const stream=await container.getArchive({path:'/workspaces'});
  const timer=setTimeout(()=>{stream.destroy();void resume();},120000);timer.unref();
  for(const event of ['end','close','error'])stream.once(event,()=>{clearTimeout(timer);void resume();});
  return stream;
 }catch(error){await resume();throw error;}
}
module.exports={archive};
