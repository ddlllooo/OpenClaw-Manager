'use strict';
// Opt-in: real Docker save -> encrypted SSH channel -> real Docker load, using
// only a unique QA image committed from the already-cached node:20-alpine image.
const crypto=require('crypto'),{spawn}=require('child_process'),{once}=require('events');
const {Server}=require('ssh2');
const ssh=require('../src/ssh-connections'),transfer=require('../src/image-transfer');
const docker=require('../src/docker').docker;
const tag='openclaw-qa-'+crypto.randomBytes(8).toString('hex')+'/openclaw:offline';
const hostKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const clients=new Set(),processes=new Set();
let container,sourceId,server;
async function wait(predicate){const end=Date.now()+10000;while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw new Error('SSH smoke timeout');}
(async()=>{
  try{
    container=await docker.createContainer({Image:'node:20-alpine',Labels:{'openclaw.qa':tag}});
    const [repo,imageTag]=tag.split(':');const committed=await container.commit({repo,tag:imageTag});sourceId=committed.Id;
    const source=await docker.getImage(tag).inspect();
    server=new Server({hostKeys:[hostKey]},client=>{
      clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
      client.on('authentication',auth=>auth.method==='password'&&auth.password==='fixture'?auth.accept():auth.reject());
      client.on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,_,info)=>{
        const stream=accept(),args=[...info.command.matchAll(/"([^"]*)"/g)].map(m=>m[1]);
        // Treat this isolated source tag as absent on a second daemon. The load
        // itself is real; it imports only the same QA content into this engine.
        if(args[0]==='image'&&args[1]==='ls'){stream.exit(0);stream.end();return;}
        const child=spawn('docker',args,{windowsHide:true});processes.add(child);
        stream.pipe(child.stdin);child.stdin.on('error',()=>{});child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream.stderr,{end:false});
        child.once('error',error=>{stream.stderr.write(error.message);stream.exit(1);stream.end();});
        child.once('close',code=>{processes.delete(child);stream.exit(code||0);stream.end();});
        stream.on('close',()=>{if(child.exitCode===null)child.kill();});
      })));
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
    const {fingerprint}=await ssh.probe({host:'127.0.0.1',port});
    const created=ssh.connect({host:'127.0.0.1',port,username:'fixture',password:'fixture',fingerprint,sshOnly:true});
    await wait(()=>ssh.connections.get(created.id).status!=='connecting');const record=ssh.connections.get(created.id);
    if(record.status!=='ssh-ready')throw new Error(record.error);
    transfer.start(record,{image:tag,imageId:source.Id});await record.transfer.finished;const job=transfer.view(record.transfer);
    if(job.status!=='done'||!job.bytesSent)throw new Error(job.error||'transfer did not complete');
    const imported=await docker.getImage(tag).inspect();if(imported.Id!==job.targetImageId)throw new Error('import verification mismatch');
    console.log(JSON.stringify({status:job.status,bytesSent:job.bytesSent,architecture:job.architecture,imageId:job.imageId,targetImageId:job.targetImageId}));
    console.log('Real Docker archive streamed through SSH and imported/verified successfully.');
  }finally{
    ssh.closeAll();for(const client of clients)client.end();for(const child of processes)child.kill();
    if(server)await new Promise(r=>server.close(r));
    if(container)await container.remove({force:true});
    if(sourceId)await docker.getImage(tag).remove({force:false,noprune:true});
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
