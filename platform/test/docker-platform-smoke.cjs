'use strict';
// Opt-in smoke test against the current local Docker engine. Only its unique QA
// containers, temporary host directory and named volume are created/removed.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-docker-qa-'));
process.env.OPENCLAW_DATA_DIR=path.join(root,'instances');
const dm=require('../src/docker'),runtime=require('../src/runtime-platform');
const suffix=crypto.randomBytes(8).toString('hex'),containers=[];
let volume;
async function run(binds,script,user){
  const container=await dm.docker.createContainer({Image:'node:20-alpine',User:user||'root',Cmd:['node','-e',script],
    Labels:{'openclaw.qa':suffix},HostConfig:{Binds:binds,NetworkMode:'none',ReadonlyRootfs:true}});
  containers.push(container);await container.start();const result=await container.wait();
  if(result.StatusCode!==0)throw new Error('Docker QA container failed: '+(await container.logs({stdout:true,stderr:true})).toString());
}
(async()=>{
  try{
    const info=await dm.dockerInfo();console.log(JSON.stringify({platform:process.platform,serverVersion:info.serverVersion,ncpu:info.ncpu,socket:dm.docker.modem.socketPath}));
    await run([runtime.bindPath(root)+':/probe'],"require('fs').writeFileSync('/probe/native-probe.txt','native-mount-ok')",'1000:1000');
    if(fs.readFileSync(path.join(root,'native-probe.txt'),'utf8')!=='native-mount-ok')throw new Error('本机挂载未写回');
    console.log('native host bind mount and instance UID: OK');
    volume=await dm.docker.createVolume({Name:'openclaw-qa-'+suffix,Labels:{'openclaw.qa':suffix}});
    const data=await volume.inspect(),mount=data.Mountpoint;
    await run([data.Name+':'+mount],`const fs=require('fs');fs.chownSync(${JSON.stringify(mount)},1000,1000);`);
    await run([data.Name+':'+mount],`require('fs').writeFileSync(${JSON.stringify(mount+'/remote-probe.txt')},'remote-volume-ok')`,'1000:1000');
    await run([mount+':/probe'],"if(require('fs').readFileSync('/probe/remote-probe.txt','utf8')!=='remote-volume-ok')process.exit(1)",'1000:1000');
    console.log('remote named-volume path shared with sibling instance mounts: OK');
  }finally{
    for(const container of containers)await container.remove({force:true}).catch(()=>{});
    if(volume)await volume.remove();
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
