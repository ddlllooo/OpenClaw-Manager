'use strict';
// Disposable UI fixture. No Docker connection, real hosts or credentials.
const express=require('express'),path=require('path');
const app=express();app.use(express.json());
app.get('/api/session',(_,res)=>res.json({csrf:'fixture'}));
app.get('/api/instances',(_,res)=>res.json({instances:[],system:{serverVersion:'测试环境',ncpu:8,memTotalGiB:16,disk:{available:180*1024**3,total:512*1024**3}}}));
app.get('/api/instances/kept',(_,res)=>res.json({kept:[]}));
app.get('/api/backups/status',(_,res)=>res.json({state:'never',schedule:{enabled:false},retentionDays:7}));
app.get('/api/connections/context',(_,res)=>res.json({mode:'local',platform:process.platform}));
const fixtureImage={image:'openclaw/openclaw:offline',imageId:'sha256:'+'a'.repeat(64),size:1024**3,kind:'runtime',purpose:'OpenClaw 实例运行镜像'};
const fixtureConnection={id:'preview-device',host:'192.0.2.20',port:22,username:'测试用户',status:'ssh-ready',stage:'SSH 已连接（界面测试数据）'};
app.get('/api/connections',(_,res)=>res.json({connections:[fixtureConnection]}));
app.get('/api/connections/local-images',(_,res)=>res.json({images:[fixtureImage]}));
app.post('/api/connections/preview-device/images/transfer',(req,res)=>{
  fixtureConnection.transfer={id:'preview-job',image:fixtureImage.image,imageId:fixtureImage.imageId,bytesSent:0,status:'running',stage:'正在导出并通过 SSH 传输（界面测试）',startedAt:Date.now(),architecture:'linux/amd64'};
  res.status(202).json({transfer:fixtureConnection.transfer});
  setTimeout(()=>Object.assign(fixtureConnection.transfer,{bytesSent:1024**3,status:'done',stage:'镜像已导入并通过校验（界面测试）',finishedAt:Date.now()}),1500);
});
app.get('/api/events',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.flushHeaders();});
app.use(express.static(path.join(__dirname,'../public')));
app.listen(18123,'127.0.0.1',()=>console.log('Isolated SSH UI fixture: http://127.0.0.1:18123'));
