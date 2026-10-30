'use strict';
const Docker=require('dockerode'),path=require('path'),assert=require('assert/strict');
const docker=new Docker({socketPath:require('../src/runtime-platform').dockerSocket()}),name='plugin-isolation-runner-'+Date.now();let runner;
(async()=>{try{
 await docker.createVolume({Name:name});const root=(await docker.getVolume(name).inspect()).Mountpoint;
 runner=await docker.createContainer({name,Image:'node:24.22.1-alpine',WorkingDir:'/app',Cmd:['node','test/plugin-isolation-smoke.cjs'],Env:['SECURITY_TEST_ROOT='+root,'MANAGER_CONTAINERIZED=1'],HostConfig:{Binds:[path.resolve(__dirname,'..').replace(/\\/g,'/')+':/app:ro',name+':'+root,'/var/run/docker.sock:/var/run/docker.sock']}});
 await runner.start();const log=await runner.logs({stdout:true,stderr:true,follow:true});docker.modem.demuxStream(log,process.stdout,process.stderr);
 const result=await runner.wait();assert.equal(result.StatusCode,0,'Plugin isolation integration failed');
 }finally{if(runner)await runner.remove({force:true});await docker.getVolume(name).remove();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
