'use strict';
// Disposable UI fixture: no Docker client, instance directories or real credentials.
const express = require('express');
const path = require('path');
const {WebSocketServer} = require('ws');
const app = express();
app.use(express.json());
const instance = {id:'fixture',name:'隔离页面验证',port:19088,state:'running',resources:{cpus:1,memoryBytes:1073741824},health:{live:true,ready:true,liveCode:200,readyCode:200,checkedAt:Date.now()}};
app.get('/api/session',(_,res)=>res.json({csrf:'fixture'}));
app.get('/api/instances',(_,res)=>res.json({instances:[instance],system:{serverVersion:'fixture',ncpu:4,memTotalGiB:8}}));
app.get('/api/instances/kept',(_,res)=>res.json({instances:[]}));
app.get('/api/images',(_,res)=>res.json({images:[],defaultImage:'fixture'}));
app.get('/api/backups/status',(_,res)=>res.json({state:'success',lastSuccess:{completedAt:new Date().toISOString(),bytes:1024,instanceCount:1},schedule:{enabled:true,hour:3,minute:30},retentionDays:7}));
app.get('/api/instances/fixture/history',(_,res)=>res.json({samples:[]}));
app.get('/api/instances/fixture/model',(_,res)=>res.json({configured:false,providers:[],defaultModel:null}));
app.get('/api/instances/fixture/feishu',(_,res)=>res.json({configured:false}));
app.get('/api/instances/fixture/config',(_,res)=>res.json({content:'{\n  "fixture": true\n}\n',revision:'fixture'}));
app.get('/api/instances/fixture/env',(_,res)=>res.json({content:'FIXTURE=true\n',revision:'fixture'}));
app.get('/api/instances/fixture/logs',(_,res)=>res.json({logs:Array.from({length:5000},(_,i)=>`log-${i} ${i%2?'odd':'even'}`).join('\n')}));
app.get('/api/instances/fixture/sessions',(_,res)=>res.json({sessions:[{key:'agent:main:fixture',label:'千条消息测试',kind:'direct',updatedAtMs:Date.now()}],totalCount:1}));
app.get('/api/instances/fixture/sessions/:key/messages',(_,res)=>res.json({messages:Array.from({length:1000},(_,i)=>({role:i%2?'assistant':'user',text:`隔离消息 ${i}`}))}));
app.get('/api/events',(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');res.flushHeaders();
  res.write(`event: stats\ndata: ${JSON.stringify({id:'fixture',cpuPercent:1,memUsed:1024,memPercent:1,ts:Date.now(),net:{}})}\n\n`);
});
app.use(express.static(path.join(__dirname,'../public')));
const server=app.listen(18082,'127.0.0.1',()=>console.log('Isolated UI preview on 18082'));
const wss=new WebSocketServer({server});
wss.on('connection',ws=>{ws.send(Buffer.from('Isolated terminal fixture\r\n$ '));});
