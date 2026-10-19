'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {execFile}=require('child_process'),{promisify}=require('util');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const exec=promisify(execFile);
test('portable daemon launcher verifies identity and stops only its own server',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-launch-'));
  const server=net.createServer();server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const env={...process.env,MANAGER_PORT:String(port),OPENCLAW_DATA_DIR:path.join(root,'instances'),OPENCLAW_BACKUP_DIR:path.join(root,'backups'),OPENCLAW_WEB_STATE_DIR:root,
    DOCKER_SOCKET:path.join(root,'missing-docker.sock'),WEB_LOG:path.join(root,'manager.log')};
  const launch=flag=>exec(process.execPath,[path.join(__dirname,'../scripts/web.mjs'),flag],{env,windowsHide:true,timeout:60000});
  try{
    await launch('-d');
    const url=`http://127.0.0.1:${port}`;
    const identity=await fetch(url+'/_launcher/identity');assert.equal(identity.status,200);
    const session=await fetch(url+'/api/session'),{csrf}=await session.json();
    const denied=await fetch(url+'/api/launcher/stop',{method:'POST',headers:{'Content-Type':'application/json',Cookie:session.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':csrf},body:'{"token":"wrong"}'});assert.equal(denied.status,403);
    assert.equal((await fetch(url+'/_launcher/identity')).status,200);
    await launch('-s');
    const deadline=Date.now()+5000;
    let stopped=false;
    while(Date.now()<deadline){try{await fetch(url+'/_launcher/identity',{signal:AbortSignal.timeout(500)});}catch{stopped=true;break;}await new Promise(r=>setTimeout(r,50));}
    assert.ok(stopped,'server should exit after authenticated stop');
    assert.ok(!fs.readdirSync(root).some(n=>n.startsWith('openclaw-web-')));
  }finally{
    await launch('-s').catch(()=>{});
    fs.rmSync(root,{recursive:true,force:true});
  }
});
