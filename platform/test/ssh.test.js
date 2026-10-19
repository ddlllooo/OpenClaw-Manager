'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('http'),net=require('net'),crypto=require('crypto');
const express=require('express'),{Server}=require('ssh2'),{WebSocketServer,WebSocket}=require('ws');
const {once}=require('events');
const ssh=require('../src/ssh-connections');
const proxy=require('../src/ssh-proxy');
let sshServer,remote,gateway,remotePort,sshPort,hostFingerprint;
const clients=new Set(),commands=[],archiveNames=[],setupScripts=[];
const privateKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const userKeys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const userPrivateKey=userKeys.privateKey.export({type:'pkcs1',format:'pem'});
const userPublic=require('ssh2').utils.parseKey(userPrivateKey).getPublicSSH();
const waitFor=async(predicate,timeout=10000)=>{
  const end=Date.now()+timeout;
  while(Date.now()<end){const result=predicate();if(result)return result;await new Promise(r=>setTimeout(r,20));}
  throw new Error('等待测试状态超时');
};
const get=async(url,options={})=>{
  const response=await fetch(url,options);const text=await response.text();let body;try{body=JSON.parse(text);}catch{body=text;}
  return {status:response.status,headers:response.headers,body};
};
const authHeaders=session=>({'Content-Type':'application/json',Cookie:session.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.body.csrf});
const target=()=>({host:'127.0.0.1',port:sshPort,username:'fixture',password:'fixture-password',remotePort,fingerprint:hostFingerprint});
async function opened(body={}){
  const row=ssh.connect({...target(),...body});
  await waitFor(()=>ssh.connections.get(row.id).status!=='connecting');
  const current=ssh.view(ssh.connections.get(row.id));assert.equal(current.status,'connected',current.error);return current;
}
test.before(async()=>{
  const app=express(),security=require('../src/security');
  // Reproduce the stricter navigation check in already deployed old Managers.
  app.use((req,res,next)=>req.path==='/'&&['cross-site','same-site'].includes(req.headers['sec-fetch-site'])?res.sendStatus(403):next());
  app.use(security.middleware);app.use(express.json());
  app.use('/api/connections',require('../src/routes/connections'));
  app.get('/',(req,res)=>res.type('html').send('<!doctype html><html><head><title>Legacy Manager</title></head><body>Legacy frontend</body></html>'));
  app.get('/api/instances',(req,res)=>res.json({instances:[{id:'fixture',port:gateway.address().port,uiUrl:`http://127.0.0.1:${gateway.address().port}/`}]}));
  app.get('/api/system',(req,res)=>res.json({ncpu:32,memTotal:128*1024**3,disk:{total:1000,available:900}}));
  app.post('/api/echo',(req,res)=>res.json(req.body));
  app.get('/api/events',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.write('data: remote-stats\n\n');res.end();});
  remote=http.createServer(app);remote.listen(0,'127.0.0.1');await once(remote,'listening');remotePort=remote.address().port;process.env.MANAGER_PORT=String(remotePort);
  const ws=new WebSocketServer({noServer:true});
  remote.on('upgrade',(req,socket,head)=>{
    if(!security.authenticated(req))return socket.destroy();
    ws.handleUpgrade(req,socket,head,client=>client.on('message',data=>client.send(data)));
  });
  gateway=http.createServer((req,res)=>res.end(JSON.stringify({host:req.headers.host,origin:req.headers.origin,cookie:req.headers.cookie||null})));
  const gatewayWS=new WebSocketServer({server:gateway});gatewayWS.on('connection',(client,req)=>client.send(req.headers.origin||'no-origin'));
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  sshServer=new Server({hostKeys:[privateKey]},client=>{
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    client.on('authentication',ctx=>{
      if(ctx.method==='password'&&ctx.username==='fixture'&&ctx.password==='fixture-password')ctx.accept();
      else if(ctx.method==='publickey'&&ctx.key.data.equals(userPublic)){
        if(!ctx.signature||crypto.verify(ctx.hashAlgo,ctx.blob,userKeys.publicKey,ctx.signature))ctx.accept();else ctx.reject();
      }else ctx.reject();
    });
    client.on('ready',()=>{
      client.on('tcpip',(accept,reject,info)=>{
        if(![remotePort,gateway.address().port].includes(info.destPort))return reject();
        const upstream=net.connect(info.destPort,'127.0.0.1',()=>{const stream=accept();stream.pipe(upstream).pipe(stream);stream.on('error',()=>upstream.destroy());stream.on('close',()=>upstream.destroy());});upstream.on('error',reject);
      });
      client.on('session',accept=>accept().on('exec',(accept,_,info)=>{
        const stream=accept(),args=['docker',...[...info.command.matchAll(/"([^"]*)"/g)].map(m=>m[1])];commands.push(args);
        const done=(output='')=>{if(output)stream.write(output);stream.exit(0);stream.end();};
        if(args[1]==='info')done(JSON.stringify({OSType:'linux',NCPU:32,MemTotal:128*1024**3}));
        else if(args[1]==='image'&&args[2]==='inspect')done(JSON.stringify([{Id:'fixture-manager',Config:{Labels:{'openclaw.manager':'true'}}}]));
        else if(args[1]==='container')done('');
        else if(args[1]==='build'){
          const extract=require('tar-stream').extract();extract.on('entry',(header,entry,next)=>{archiveNames.push(header.name);entry.on('end',next);entry.resume();});
          extract.on('finish',()=>done('built'));stream.pipe(extract);
        }else if(args[1]==='volume'&&args[2]==='inspect')done(JSON.stringify([{Mountpoint:'/var/lib/docker/volumes/remote-only/_data'}]));
        else if(args[1]==='run'&&args.includes('--rm')){let raw='';stream.on('data',b=>raw+=b);stream.on('end',()=>{setupScripts.push(raw);done('998');});}
        else done('fixture-result');
      }));
    });
  });
  sshServer.listen(0,'127.0.0.1');await once(sshServer,'listening');sshPort=sshServer.address().port;
  hostFingerprint=(await ssh.probe({host:'127.0.0.1',port:sshPort})).fingerprint;
});
test.after(async()=>{
  ssh.closeAll();for(const client of clients)client.end();
  remote.closeAllConnections();gateway.closeAllConnections();
  await Promise.all([new Promise(r=>sshServer.close(r)),new Promise(r=>remote.close(r)),new Promise(r=>gateway.close(r))]);
});
test('SSH probe returns SHA256 identity and a mismatched fingerprint never authenticates',async()=>{
  assert.match(hostFingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);
  const row=ssh.connect({...target(),fingerprint:'SHA256:'+'A'.repeat(43)});
  await waitFor(()=>ssh.connections.get(row.id).status==='error');assert.equal(ssh.connections.get(row.id).proxy,null);
});
test('connection and fingerprint APIs require a local session and CSRF',async()=>{
  const base=`http://127.0.0.1:${remotePort}/`,payload=JSON.stringify({host:'127.0.0.1',port:sshPort});
  assert.equal((await get(base+'api/connections')).status,401);
  assert.equal((await get(base+'api/connections/probe',{method:'POST',headers:{'Content-Type':'application/json'},body:payload})).status,401);
  const session=await get(base+'api/session'),headers=authHeaders(session);
  assert.equal((await get(base+'api/connections/probe',{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},body:payload})).status,403);
  const result=await get(base+'api/connections/probe',{method:'POST',headers,body:payload});assert.equal(result.body.fingerprint,hostFingerprint);
  for(const route of ['images/transfer','images/cancel','deploy-offline']){
    assert.equal((await get(base+'api/connections/unknown/'+route,{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},body:'{}'})).status,403);
    assert.equal((await get(base+'api/connections/unknown/'+route,{method:'POST',headers,body:'{}'})).status,404);
  }
});
test('SSH authentication rejects incorrect passwords and supports private keys',async()=>{
  const bad=ssh.connect({...target(),password:'incorrect'});await waitFor(()=>ssh.connections.get(bad.id).status==='error');
  const row=await opened({auth:'key',privateKey:userPrivateKey,password:undefined});ssh.close(ssh.connections.get(row.id));
});
test('forwarded management reads remote resources, isolates cookies and preserves CSRF protection',async()=>{
  const row=await opened();
  assert.equal((await get(row.url+'api/system')).status,401);
  const session=await get(row.url+'api/session'),headers=authHeaders(session);
  assert.match(headers.Cookie,/^openclaw_ssh_/);assert.ok(!JSON.stringify(ssh.view(ssh.connections.get(row.id))).includes('fixture-password'));
  const system=await get(row.url+'api/system',{headers});assert.equal(system.body.ncpu,32);assert.equal(system.body.disk.available,900);
  const denied=await get(row.url+'api/echo',{method:'POST',headers:{...headers,'X-CSRF-Token':'wrong'},body:'{}'});assert.equal(denied.status,403);
  const echoed=await get(row.url+'api/echo',{method:'POST',headers,body:'{"message":"remote"}'});assert.equal(echoed.body.message,'remote');
  const cross=await get(row.url+'api/system',{headers:{...headers,Origin:'https://untrusted.example'}});assert.equal(cross.status,403);
  assert.equal((await get(row.url+'api/events',{headers})).body,'data: remote-stats\n\n');
  ssh.close(ssh.connections.get(row.id));
});
test('two SSH origins cannot reuse one another’s session cookies',async()=>{
  const a=await opened(),b=await opened();const session=await get(a.url+'api/session');
  assert.equal((await get(b.url+'api/system',{headers:authHeaders(session)})).status,401);
  ssh.close(ssh.connections.get(a.id));ssh.close(ssh.connections.get(b.id));
});
test('Gateway links use independent local ports, rewrite origins and never receive Manager credentials',async()=>{
  const row=await opened(),session=await get(row.url+'api/session'),headers=authHeaders(session);
  const listing=await get(row.url+'api/instances',{headers});assert.equal(listing.body.instances[0].uiUrl,'/ssh-gateway/fixture/');
  assert.equal((await get(row.url+'ssh-gateway/fixture/',{redirect:'manual'})).status,401);
  const redirect=await get(row.url+'ssh-gateway/fixture/',{headers,redirect:'manual'});assert.equal(redirect.status,302);
  const url=redirect.headers.get('location');assert.notEqual(new URL(url).port,String(gateway.address().port));
  const result=await get(url,{headers:{Cookie:headers.Cookie,Origin:new URL(url).origin}});
  assert.equal(result.body.host,`127.0.0.1:${gateway.address().port}`);assert.equal(result.body.origin,`http://127.0.0.1:${gateway.address().port}`);assert.equal(result.body.cookie,null);
  const client=new WebSocket(url.replace('http:','ws:'),{origin:new URL(url).origin});
  const [message]=await once(client,'message');assert.equal(message.toString(),`http://127.0.0.1:${gateway.address().port}`);client.close();await once(client,'close');
  ssh.close(ssh.connections.get(row.id));
});
test('terminal WebSockets pass authenticated binary frames through SSH',async()=>{
  const row=await opened(),session=await get(row.url+'api/session');
  const client=new WebSocket(row.url.replace('http:','ws:')+'api/instances/fixture/terminal',{origin:new URL(row.url).origin,headers:{Cookie:authHeaders(session).Cookie}});
  await once(client,'open');client.send(Buffer.from('terminal bytes'));const [message]=await once(client,'message');assert.equal(message.toString(),'terminal bytes');
  client.close();await once(client,'close');ssh.close(ssh.connections.get(row.id));
});
test('automatic provisioning builds only allowed source and uses remote persistent storage and socket permissions',async()=>{
  const row=await opened({deploy:true});
  assert.ok(archiveNames.includes('Dockerfile'));assert.ok(archiveNames.includes('scripts/backup_instances.py'));
  assert.match(require('fs').readFileSync(require('path').join(__dirname,'../Dockerfile'),'utf8'),/COPY package\.json package-lock\.json server\.js Dockerfile \.\//);
  assert.ok(!archiveNames.some(n=>/^(data|ops|node_modules)\//.test(n)||/\.env$/.test(n)));
  assert.match(setupScripts[0],/chownSync/);
  const run=commands.find(args=>args[1]==='run'&&args.includes('-d'));
  assert.ok(run.includes('1000:1000'));assert.ok(run.includes('998'));
  assert.ok(run.includes('OPENCLAW_DATA_DIR=/var/lib/docker/volumes/remote-only/_data/instances'));
  assert.ok(run.includes(`127.0.0.1:${remotePort}:${remotePort}`));assert.ok(!run.some(a=>a.includes('C:')));
  ssh.close(ssh.connections.get(row.id));
});
test('disconnect closes all local listeners without issuing stop or remove commands on the remote',async()=>{
  const row=await opened(),before=commands.length;
  ssh.close(ssh.connections.get(row.id));assert.equal(commands.length,before);
  await assert.rejects(fetch(row.url,{signal:AbortSignal.timeout(1000)}));assert.equal(ssh.connections.get(row.id).status,'disconnected');
});
test('SSH disconnect reports an error and closes the local management listener',async()=>{
  const row=await opened();ssh.connections.get(row.id).client.destroy();
  await waitFor(()=>ssh.connections.get(row.id).status==='error');await assert.rejects(fetch(row.url,{signal:AbortSignal.timeout(1000)}));
});
test('remote Docker command arguments cannot introduce shell syntax',()=>{
  for(const value of ['x; touch /tmp/bad','$(whoami)','a"b','a`whoami`','x\nwhoami'])assert.throws(()=>ssh.dockerCommand(['run',value]));
  assert.match(ssh.dockerCommand(['info','--format','{{json .}}']),/"\{\{json \.\}\}"/);
});
test('SSH-only mode does not need a running Manager and disconnect cancels a transfer',async()=>{
  const before=commands.length;
  const created=ssh.connect({...target(),sshOnly:true});await waitFor(()=>ssh.connections.get(created.id).status!=='connecting');
  const record=ssh.connections.get(created.id);assert.equal(record.status,'ssh-ready');assert.equal(record.proxy,null);assert.equal(commands.length,before);
  const controller=new AbortController();record.transfer={id:'fixture',image:'fixture:v1',status:'running',bytesSent:0,controller};
  ssh.close(record);assert.equal(controller.signal.aborted,true);assert.equal(record.status,'disconnected');
});
test('execute honours cancellation while an SSH command is consuming input',async()=>{
  const created=ssh.connect({...target(),sshOnly:true});await waitFor(()=>ssh.connections.get(created.id).status!=='connecting');
  const record=ssh.connections.get(created.id),input=new (require('stream').PassThrough)(),controller=new AbortController();
  const operation=ssh.execute(record.client,['build','-'],input,30000,{signal:controller.signal});
  controller.abort();await assert.rejects(operation,e=>e.code==='ABORT_ERR');assert.equal(input.destroyed,true);ssh.close(record);
});
test('offline Manager bootstrap reuses a transferred image and never builds or pulls',async()=>{
  const created=ssh.connect({...target(),sshOnly:true});await waitFor(()=>ssh.connections.get(created.id).status!=='connecting');
  const record=ssh.connections.get(created.id);record.managerImage='openclaw-manager:offline';const before=commands.length;
  ssh.deployOffline(record);await waitFor(()=>record.status!=='connecting');assert.equal(record.status,'connected',record.error);
  const issued=commands.slice(before);assert.ok(!issued.some(args=>args[1]==='build'||args[1]==='pull'));
  assert.ok(issued.some(args=>args[1]==='run'&&args.includes('--pull=never')&&args.includes(record.managerImage)));
  ssh.close(record);
});

test('container SSH origins use the published port for authenticated HTTP and WebSockets',async()=>{
  const origins=require('../src/ssh-origins'),app=express();app.use(origins.middleware);app.use((req,res)=>res.sendStatus(403));
  const entry=http.createServer(app);entry.on('upgrade',(req,socket,head)=>{if(!origins.upgrade(req,socket,head))socket.destroy();});
  entry.listen(0,'127.0.0.1');await once(entry,'listening');
  const previous=process.env.MANAGER_CONTAINERIZED,previousPort=process.env.MANAGER_PORT;
  process.env.MANAGER_CONTAINERIZED='1';
  let row;
  try{
    row=await opened();const host=new URL(row.url).host,base=`http://127.0.0.1:${entry.address().port}/`;
    assert.match(host,/^openclaw-[a-f0-9]+\.localhost:/);assert.equal(new URL(row.url).port,previousPort);
    const routed=(route,headers)=>new Promise((resolve,reject)=>{http.get(base+route,{headers},res=>{let raw='';res.on('data',b=>raw+=b);res.on('end',()=>{let body;try{body=JSON.parse(raw);}catch{body=raw;}resolve({status:res.statusCode,body,headers:new Headers(res.headers)});});}).on('error',reject);});
    const session=await routed('api/session',{Host:host});assert.equal(session.status,200,JSON.stringify(session.body));
    const headers={...authHeaders(session),Host:host,Origin:'http://'+host};
    assert.equal((await routed('api/system',headers)).body.ncpu,32);
    assert.equal((await routed('api/system',{...headers,Origin:'http://malicious.invalid'})).status,403);
    const ws=new WebSocket(base.replace('http:','ws:')+'api/instances/fixture/terminal',{origin:'http://'+host,headers:{Host:host,Cookie:headers.Cookie}});
    await once(ws,'open');ws.send('container-ssh');assert.equal(String((await once(ws,'message'))[0]),'container-ssh');ws.close();await once(ws,'close');
    ssh.close(ssh.connections.get(row.id));assert.equal((await routed('api/system',headers)).status,403);
  }finally{
    if(row)ssh.close(ssh.connections.get(row.id));
    if(previous===undefined)delete process.env.MANAGER_CONTAINERIZED;else process.env.MANAGER_CONTAINERIZED=previous;
    process.env.MANAGER_PORT=previousPort;entry.closeAllConnections();await new Promise(r=>entry.close(r));
  }
});

test('remote management links allow document navigation while rejecting cross-site API requests',()=>{
  const headers={host:'127.0.0.1:19001','sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
  assert.equal(proxy.trusted({method:'GET',headers},19001),true);
  assert.equal(proxy.trusted({method:'POST',headers},19001),false);
  assert.equal(proxy.trusted({method:'GET',headers:{...headers,'sec-fetch-mode':'cors'}},19001),false);
});

test('device catalog updates across isolated origins without exposing SSH credentials',async()=>{
  const local=await opened(),other=await opened();
  const remoteContext=(await get(local.url+'api/connections/context')).body;
  assert.equal(remoteContext.device.id,local.id);assert.equal(remoteContext.device.kind,'ssh');
  assert.equal(remoteContext.devices.find(d=>d.id==='local').kind,'local');
  assert.equal(remoteContext.devices.find(d=>d.id===other.id).url,other.url);
  assert.ok(!JSON.stringify(remoteContext).includes('fixture-password'));
  assert.ok(remoteContext.devices.every(d=>!('client'in d)&&!('privateKey'in d)&&!('password'in d)));
  ssh.close(ssh.connections.get(other.id));
  const changed=(await get(local.url+'api/connections/context')).body.devices.find(d=>d.id===other.id);
  assert.equal(changed.status,'disconnected');assert.equal(changed.url,null);ssh.close(ssh.connections.get(local.id));
});

test('older remote Managers receive the shared switcher while remote APIs retain their own session',async()=>{
  const row=await opened(),page=await get(row.url);
  assert.match(page.body,/Legacy frontend/);assert.match(page.body,/src="\/devices.js/);assert.match(page.body,/href="\/devices.css/);
  assert.equal(page.headers.get('cache-control'),'no-store');
  const navigated=await new Promise((resolve,reject)=>http.get(row.url,{headers:{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body}));}).on('error',reject));
  assert.equal(navigated.status,200);assert.match(navigated.body,/src="\/devices.js/);
  const script=await get(row.url+'devices.js?v=fixture');assert.equal(script.status,200);assert.match(script.body,/window.deviceWorkspace/);
  assert.equal((await get(row.url+'api/system')).status,401);
  const session=await get(row.url+'api/session');assert.equal((await get(row.url+'api/system',{headers:authHeaders(session)})).body.ncpu,32);
  ssh.close(ssh.connections.get(row.id));
});

test('returning to the local workspace permits document navigation without allowing cross-site APIs',()=>{
  const security=require('../src/security'),headers={host:'127.0.0.1:'+process.env.MANAGER_PORT,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
  assert.equal(security.trusted({method:'GET',url:'/?manageDevices=1',headers}),true);
  assert.equal(security.trusted({method:'GET',url:'/api/session',headers}),false);
  assert.equal(security.trusted({method:'POST',url:'/',headers}),false);
});

const savedDirectory=require('fs').mkdtempSync(require('path').join(require('os').tmpdir(),'openclaw-ssh-restart-'));
test.after(()=>require('fs').rmSync(savedDirectory,{recursive:true,force:true}));
const savedStore=require('../src/ssh-device-store').createStore(savedDirectory);
let savedId;
test('saved connections keep stable IDs and credentials stay out of list and context APIs',async()=>{
  ssh.closeAll();ssh.connections.clear();ssh.start({store:savedStore,retryDelays:[50,100]});
  const session=await get(`http://127.0.0.1:${remotePort}/api/session`),headers=authHeaders(session);
  const created=await get(`http://127.0.0.1:${remotePort}/api/connections`,{method:'POST',headers,body:JSON.stringify(target())});assert.equal(created.status,202);savedId=created.body.id;
  await waitFor(()=>ssh.connections.get(savedId).status==='connected');assert.equal(savedStore.load()[0].credentials.password,'fixture-password');
  for(const route of ['api/connections','api/connections/context']){
    const result=await get(`http://127.0.0.1:${remotePort}/${route}`,{headers});assert.equal(result.status,200);assert.ok(!JSON.stringify(result.body).includes('fixture-password'));assert.ok(!JSON.stringify(result.body).includes('credentials'));
  }
  const oldURL=ssh.view(ssh.connections.get(savedId)).url;ssh.closeAll();ssh.connections.clear();ssh.start({store:savedStore,retryDelays:[50,100]});
  await waitFor(()=>ssh.connections.get(savedId)?.status==='connected');assert.equal(ssh.connections.get(savedId).saved,true);assert.notEqual(ssh.view(ssh.connections.get(savedId)).url,oldURL);assert.equal(savedStore.load()[0].paused,false);
});
test('live device names and notes update every origin without interrupting SSH or changing ownership IDs',async()=>{
  const record=ssh.connections.get(savedId),client=record.client,url=record.proxy.url;
  const session=await get(`http://127.0.0.1:${remotePort}/api/session`),headers=authHeaders(session);
  const result=await get(`http://127.0.0.1:${remotePort}/api/connections/${savedId}`,{method:'PATCH',headers,body:JSON.stringify({name:'  测试服务器  ',notes:'办公室 Linux\n离线部署验证'})});
  assert.equal(result.status,200);assert.equal(result.body.name,'测试服务器');assert.equal(result.body.notes,'办公室 Linux\n离线部署验证');
  assert.equal(record.client,client);assert.equal(record.proxy.url,url);assert.equal(record.status,'connected');assert.equal(savedStore.load()[0].name,'测试服务器');
  const remoteContext=(await get(url+'api/connections/context')).body;
  assert.equal(remoteContext.device.name,'测试服务器');assert.equal(remoteContext.device.id,savedId);assert.equal(remoteContext.device.host,'127.0.0.1');assert.equal(remoteContext.device.notes,'办公室 Linux\n离线部署验证');
});
test('saved SSH login and custom device details survive a fresh Node process without rebuilding remote images',async()=>{
  ssh.closeAll();ssh.connections.clear();const before=commands.length;
  const code=`const s=require(${JSON.stringify(require.resolve('../src/ssh-connections'))});s.start({retryDelays:[20]});const end=Date.now()+8000;const timer=setInterval(()=>{const r=s.connections.get(${JSON.stringify(savedId)});if(r?.status==='connected'){console.log(JSON.stringify({id:r.id,saved:r.saved,status:r.status,name:r.name,notes:r.notes}));clearInterval(timer);s.closeAll();}else if(Date.now()>end){clearInterval(timer);s.closeAll();process.exitCode=1;}},30);`;
  const result=await new Promise((resolve,reject)=>require('child_process').execFile(process.execPath,['-e',code],{env:{...process.env,OPENCLAW_SSH_STATE_DIR:savedDirectory},timeout:12000,windowsHide:true},(e,out)=>e?reject(e):resolve(JSON.parse(out))));
  assert.deepEqual(result,{id:savedId,saved:true,status:'connected',name:'测试服务器',notes:'办公室 Linux\n离线部署验证'});assert.equal(commands.length,before);
  ssh.start({store:savedStore,retryDelays:[50,100]});await waitFor(()=>ssh.connections.get(savedId)?.status==='connected');
});
test('unexpected SSH loss retries automatically but explicit disconnect stays paused across restart',async()=>{
  let record=ssh.connections.get(savedId),client=record.client;client.destroy();await waitFor(()=>record.status==='error');assert.ok(record.nextRetryAt);
  await waitFor(()=>record.status==='connected'&&record.client!==client);assert.equal(record.nextRetryAt,null);
  ssh.close(record);assert.equal(savedStore.load()[0].paused,true);await new Promise(r=>setTimeout(r,160));assert.equal(record.status,'disconnected');
  ssh.closeAll();ssh.connections.clear();ssh.start({store:savedStore,retryDelays:[50,100]});record=ssh.connections.get(savedId);await new Promise(r=>setTimeout(r,160));assert.equal(record.status,'disconnected');assert.equal(record.nextRetryAt,undefined);
  ssh.reconnect(record);await waitFor(()=>record.status==='connected');assert.equal(savedStore.load()[0].paused,false);
});
test('automatic reconnect can be disabled and re-enabled without losing device authentication',async()=>{
  const record=ssh.connections.get(savedId);ssh.preferences(record,{autoReconnect:false});record.client.destroy();await waitFor(()=>record.status==='error');assert.equal(record.nextRetryAt,null);
  await new Promise(r=>setTimeout(r,160));assert.equal(record.status,'error');ssh.preferences(record,{autoReconnect:true});await waitFor(()=>record.status==='connected');
});
test('host identity or authentication failures stop retries until credentials are corrected',async()=>{
  ssh.close(ssh.connections.get(savedId));
  const bad=ssh.connect({...target(),save:true,fingerprint:'SHA256:'+'A'.repeat(43)});assert.equal(bad.id,savedId);
  let record=ssh.connections.get(savedId);await waitFor(()=>record.status==='error');assert.equal(record.retryBlocked,true);assert.equal(record.nextRetryAt,null);assert.match(record.error,/指纹/);
  ssh.connect({...target(),save:true,password:'wrong-password'});record=ssh.connections.get(savedId);await waitFor(()=>record.status==='error');assert.equal(record.retryBlocked,true);assert.equal(record.nextRetryAt,null);
  ssh.connect({...target(),auth:'key',privateKey:userPrivateKey,password:undefined,save:true});record=ssh.connections.get(savedId);await waitFor(()=>record.status==='connected');assert.equal(record.id,savedId);assert.ok(!JSON.stringify(ssh.view(record)).includes(userPrivateKey));
});
test('editing connection information preserves credentials and stable IDs, including paused devices',async()=>{
  const record=ssh.connections.get(savedId),before=savedStore.load()[0].credentials,client=record.client;
  ssh.edit(record,{sshOnly:true});await waitFor(()=>record.status==='ssh-ready');assert.notEqual(record.client,client);assert.deepEqual(savedStore.load()[0].credentials,before);assert.equal(record.id,savedId);
  ssh.edit(record,{sshOnly:false});await waitFor(()=>record.status==='connected');
  ssh.close(record);ssh.edit(record,{remotePort:'18081'});assert.equal(record.remotePort,18081);assert.equal(savedStore.load()[0].remotePort,18081);assert.equal(record.paused,true);assert.equal(record.status,'disconnected');
  ssh.edit(record,{remotePort});ssh.reconnect(record);await waitFor(()=>record.status==='connected');assert.equal(record.name,'测试服务器');
});
test('changing SSH destinations requires a newly supplied fingerprint and credentials without overwriting the working profile',()=>{
  const record=ssh.connections.get(savedId),before=savedStore.load()[0],client=record.client;
  assert.throws(()=>ssh.edit(record,{host:'192.0.2.99'}),/指纹/);
  assert.throws(()=>ssh.edit(record,{host:'192.0.2.99',fingerprint:hostFingerprint}),/私钥/);
  assert.deepEqual(savedStore.load()[0],before);assert.equal(record.client,client);assert.equal(record.status,'connected');
});
test('device edits validate text, reject duplicate destinations, and protect an active image transfer',async()=>{
  const record=ssh.connections.get(savedId),before=savedStore.load()[0];
  for(const body of [{name:'x'.repeat(81)},{notes:'x'.repeat(1001)},{name:'bad\nname'},{notes:'\u0000'},{remotePort:80},{port:0},{remotePort:0},{username:''},{saved:true},{autoReconnect:'yes'}])assert.throws(()=>ssh.edit(record,body));
  assert.deepEqual(savedStore.load()[0],before);
  const other=ssh.connect({...target(),sshOnly:true,remotePort:18081});await waitFor(()=>ssh.connections.get(other.id).status==='ssh-ready');
  assert.throws(()=>ssh.edit(record,{remotePort:18081}),/已存在/);ssh.close(ssh.connections.get(other.id));
  const controller=new AbortController();record.transfer={status:'running',controller};
  ssh.edit(record,{notes:'镜像传输期间也可编辑备注'});assert.equal(controller.signal.aborted,false);
  assert.throws(()=>ssh.edit(record,{sshOnly:true}),/传输镜像/);delete record.transfer;
  ssh.edit(record,{notes:'办公室 Linux\n离线部署验证'});
});
test('empty names fall back to the SSH endpoint and equal names keep distinct device IDs',()=>{
  const record=ssh.connections.get(savedId),url=record.proxy.url;ssh.edit(record,{name:'',notes:''});
  let data=(require('../src/device-context').context(ssh.connections,record));assert.equal(data.device.name,'fixture@127.0.0.1');assert.equal(data.device.notes,'');assert.equal(record.proxy.url,url);
  ssh.edit(record,{name:'测试服务器',notes:'办公室 Linux\n离线部署验证'});
  const rows=new Map([[record.id,record],['other',{id:'other',name:'测试服务器',host:'192.0.2.10',port:2222,username:'ubuntu',status:'disconnected'}]]);
  data=require('../src/device-context').context(rows);assert.equal(data.devices[1].name,data.devices[2].name);assert.notEqual(data.devices[1].id,data.devices[2].id);assert.notEqual(data.devices[1].host,data.devices[2].host);
});
test('reconnect, settings and forget APIs require CSRF and removing a device prevents restore',async()=>{
  const base=`http://127.0.0.1:${remotePort}/api/connections/${savedId}`,session=await get(`http://127.0.0.1:${remotePort}/api/session`),headers=authHeaders(session);
  for(const [route,method,body]of [['/reconnect','POST',{}],['','PATCH',{autoReconnect:false}],['/saved','DELETE',{}]])assert.equal((await get(base+route,{method,headers:{...headers,'X-CSRF-Token':'wrong'},body:JSON.stringify(body)})).status,403);
  assert.equal((await get(base,{method:'DELETE',headers,body:'{}'})).status,200);
  assert.equal((await get(base+'/reconnect',{method:'POST',headers,body:'{}'})).status,202);await waitFor(()=>ssh.connections.get(savedId).status==='connected');
  assert.equal((await get(base+'/saved',{method:'DELETE',headers,body:'{}'})).status,200);assert.equal(savedStore.load().length,0);assert.equal(ssh.connections.has(savedId),false);
  ssh.closeAll();ssh.connections.clear();ssh.start({store:savedStore});assert.equal(ssh.connections.size,0);
});
