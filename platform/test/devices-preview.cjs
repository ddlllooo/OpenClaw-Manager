'use strict';
// Disposable, real-SSH UI fixture with colliding instance IDs on two devices.
const express=require('express'),http=require('http'),net=require('net'),crypto=require('crypto'),path=require('path'),fs=require('fs');
const {once}=require('events'),{Server}=require('ssh2'),ssh=require('../src/ssh-connections');
const PORT=18180;process.env.MANAGER_PORT=String(PORT);process.env.OPENCLAW_DEVICE_NAME='Mac 192.0.2.10';
const calls=[],clients=new Set(),privateKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const instances={local:{id:'shared-instance',name:'本机验收助手',port:19110,state:'running',resources:{cpus:1,memoryBytes:1024**3,pidsLimit:192},image:'openclaw/openclaw:offline'},remote:{id:'shared-instance',name:'远程验收助手',port:19120,state:'running',resources:{cpus:0.5,memoryBytes:1024**3,pidsLimit:192},image:'openclaw/openclaw:offline'}};
function routes(app,device){
  const system={serverVersion:'界面验收',ncpu:device==='local'?8:2,memTotalGiB:device==='local'?16:4,disk:{available:18*1024**3,total:68*1024**3}};
  app.get('/api/instances',(req,res)=>res.json({instances:[{...instances[device],health:{live:true,ready:true,checkedAt:Date.now()},uiUrl:'/'}],system}));
  app.get('/api/system',(req,res)=>res.json(system));
  app.get('/api/instances/kept',(req,res)=>res.json({kept:[]}));
  app.get('/api/backups/status',(req,res)=>res.json({state:'never',schedule:{enabled:false},retentionDays:7}));
  app.get('/api/events',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.write('retry: 3000\n\n');});
  app.patch('/api/instances/shared-instance',(req,res)=>{calls.push({device,method:req.method,name:req.body.name});instances[device].name=req.body.name;res.json({instance:instances[device]});});
  app.post('/api/instances/shared-instance/:action',(req,res)=>{calls.push({device,method:req.method,action:req.params.action});res.json({ok:true,instance:instances[device]});});
  app.get('/api/instances/shared-instance/token',(req,res)=>res.json({token:'fixture-not-a-credential'}));
  app.get('/api/images',(req,res)=>res.json({images:[]}));
  app.use('/api',(req,res)=>res.json({}));
}
(async()=>{
  const remoteApp=express();remoteApp.use(express.json());remoteApp.use((req,res,next)=>{
    if(req.path==='/api/session'){res.setHeader('Set-Cookie','openclaw_manager_session=remote-fixture; HttpOnly; SameSite=Strict; Path=/');return res.json({csrf:'remote-fixture-csrf'});}
    if(req.path.startsWith('/api/')&&(!(req.headers.cookie||'').includes('openclaw_manager_session=remote-fixture')||(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!=='remote-fixture-csrf')))return res.sendStatus(403);
    next();
  });
  remoteApp.get('/',(req,res)=>res.type('html').send(fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8').replace(/.*(?:href="\/devices.css|src="\/devices.js).*\r?\n/g,'')));
  remoteApp.use(express.static(path.join(__dirname,'../public')));routes(remoteApp,'remote');
  const remote=http.createServer(remoteApp);remote.listen(0,'127.0.0.1');await once(remote,'listening');
  const sshServer=new Server({hostKeys:[privateKey]},client=>{clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));client.on('authentication',ctx=>ctx.method==='password'&&ctx.password==='fixture-password'?ctx.accept():ctx.reject());client.on('ready',()=>client.on('tcpip',(accept,reject,info)=>{
    if(info.destPort!==remote.address().port)return reject();const upstream=net.connect(info.destPort,'127.0.0.1',()=>{const stream=accept();stream.pipe(upstream).pipe(stream);stream.on('close',()=>upstream.destroy());stream.on('error',()=>upstream.destroy());});upstream.on('error',reject);
  }));});sshServer.listen(0,'127.0.0.1');await once(sshServer,'listening');
  const app=express();app.use(require('../src/security').middleware);app.use(express.json());
  app.use('/api/connections',require('../src/routes/connections'));
  app.get('/__fixture/report',(req,res)=>res.json({calls,instances}));app.post('/__fixture/disconnect',(req,res)=>{for(const c of clients)c.end();res.json({ok:true});});
  app.use(express.static(path.join(__dirname,'../public')));routes(app,'local');app.listen(PORT,'127.0.0.1');
  const fp=await ssh.probe({host:'127.0.0.1',port:sshServer.address().port});
  const row=ssh.connect({host:'127.0.0.1',port:sshServer.address().port,username:'ubuntu',password:'fixture-password',fingerprint:fp.fingerprint,remotePort:remote.address().port});
  const end=Date.now()+15000;while(Date.now()<end&&ssh.connections.get(row.id).status==='connecting')await new Promise(r=>setTimeout(r,30));
  console.log(JSON.stringify({preview:'http://127.0.0.1:'+PORT,remote:ssh.view(ssh.connections.get(row.id))}));
})().catch(e=>{console.error(e);process.exit(1);});
