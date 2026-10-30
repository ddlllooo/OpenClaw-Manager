 'use strict';
const fs=require('fs'),http=require('http'),path=require('path'),{pipeline}=require('stream/promises'),{Transform}=require('stream');
(async()=>{
 const [id,agent,output]=process.argv.slice(2);if(!/^[a-z0-9_-]{1,80}$/i.test(id||'')||!/^[a-z0-9_-]{1,80}$/i.test(agent||''))throw Error('Invalid workspace identity');
 const store=require('../src/instances'),file=fs.existsSync(store.instanceFile(id))?store.instanceFile(id):path.join(store.DATA_ROOT,id+'.kept','instance.json');
 const record=JSON.parse(fs.readFileSync(file,'utf8'));if(record.id!==id)throw Error('Instance mismatch');
 let source;
 if(process.env.OPENCLAW_CONTROL_SOCKET){
  source=await new Promise((resolve,reject)=>{const req=http.get({socketPath:process.env.OPENCLAW_CONTROL_SOCKET,path:'/openclaw/secure/'+id+'/workspaces/'+agent},res=>{if(res.statusCode!==200){res.resume();reject(Error('Workspace backup denied'));}else resolve(res);});req.on('error',reject);});
 }else{
  const docker=new (require('dockerode'))({socketPath:process.env.OPENCLAW_DOCKER_SOCKET||require('../src/runtime-platform').dockerSocket()});
  source=await require('../security/workspace-backup.cjs').archive(docker,record,agent,store.DATA_ROOT);
 }
 let bytes=0;const max=Number(process.env.OPENCLAW_SANDBOX_BACKUP_MAX_BYTES||1073741824);
 const meter=new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>max?Error('Sandbox backup size limit exceeded'):null,chunk);}});
 try{await pipeline(source,meter,fs.createWriteStream(output,{flags:'wx',mode:0o600}));}
 catch(error){source.destroy();try{fs.unlinkSync(output);}catch{}throw error;}
})().catch(()=>{console.error('Sandbox workspace backup failed; previous encrypted backups retained');process.exitCode=1;});
