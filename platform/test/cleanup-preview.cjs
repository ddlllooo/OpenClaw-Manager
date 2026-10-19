'use strict';
// Disposable cleanup UI fixture: no Docker client, real records or filesystem mutation.
const express = require('express');
const path = require('path');
const {WebSocketServer} = require('ws');
const app = express();
app.use(express.json());
const instance = {id:'fixture',name:'隔离页面验证',port:19088,state:'running',resources:{cpus:1,memoryBytes:1073741824},health:{live:true,ready:true,liveCode:200,readyCode:200,checkedAt:Date.now()}};
app.get('/api/session',(_,res)=>res.json({csrf:'fixture'}));
app.get('/api/instances',(_,res)=>res.json({instances:[instance],system:{serverVersion:'fixture',ncpu:4,memTotalGiB:8}}));
app.get('/api/instances/kept',(_,res)=>res.json({instances:[]}));
const images=[
 {id:'runtime-current',tags:['openclaw/openclaw:latest'],purpose:'OpenClaw 实例运行镜像',kind:'runtime',selectable:true,size:4453066093},
 {id:'manager-current',tags:['openclaw-manager:2026.10.16-cleanup-ui1'],purpose:'管理平台',kind:'manager',selectable:false,size:634115756},
 {id:'manager-previous',tags:['openclaw-manager:2026.10.16-retention1'],purpose:'管理平台',kind:'manager',selectable:false,size:634115756}];
app.get('/api/images',(_,res)=>res.json({images,defaultImage:'openclaw/openclaw:latest',retention:{policy:{enabled:true},pending:false,lastRun:null}}));
let cleaned=false;
const plan=()=>({previewId:'a'.repeat(48),expiresAt:new Date(Date.now()+300000).toISOString(),blockedReason:null,
 summary:{deleteImages:cleaned?0:1,deleteContainers:cleaned?0:1,keepImages:3,keepContainers:1},
 images:[...images.map(i=>({type:'image',id:i.id,name:i.tags.join(' / '),sizeBytes:i.size,decision:'keep',reasons:[i.id==='manager-previous'?'保留上一版 Manager 用于回滚':'被现有运行容器引用']})),
 ...(!cleaned?[{type:'image',id:'sha256:'+'1'.repeat(64),name:'openclaw/openclaw:2026.9.1',sizeBytes:4400000000,decision:'delete',reasons:['已淘汰的旧镜像，清理旧回滚容器后无剩余引用'],dependsOn:['old-copy']}]:[])],
 containers:[{type:'rollback',id:'2'.repeat(64),name:'openclaw-fixture-rollback-1792119000000',instanceName:'隔离页面验证',state:'exited',decision:'keep',reasons:['每个实例保留最近一个回滚版本','被活动实例或归档记录引用']},
 ...(!cleaned?[{type:'rollback',id:'3'.repeat(64),name:'openclaw-fixture-rollback-1792000000000',instanceName:'隔离页面验证',state:'exited',decision:'delete',reasons:['已被较新的回滚版本替代，且没有记录引用']}]:[])]});
app.get('/api/images/cleanup/preview',(_,res)=>res.json(plan()));
app.get('/api/images/cleanup/history',(req,res)=>res.json({entries:[
 {id:'mock-manual',at:new Date().toISOString(),completedAt:new Date().toISOString(),source:'manual',trigger:'manual-cleanup',state:'partial',legacy:false,
 deletedImages:[{type:'image',id:'sha256:'+'a'.repeat(64),name:'openclaw/openclaw:2026.9.1'}],deletedContainers:[{type:'rollback',id:'b'.repeat(64),name:'openclaw-fixture-rollback-1792000000000'}],removedTags:[],
 skipped:[{type:'image',id:'c'.repeat(64),name:'openclaw-manager:previous',reason:'保留上一版 Manager 用于回滚'}],
 errors:[{type:'rollback',id:'d'.repeat(64),name:'openclaw-fixture-rollback-busy',reason:'对象仍被引用或占用，Docker 拒绝删除'}]},
 {id:'mock-auto',at:new Date(Date.now()-60000).toISOString(),source:'automatic',trigger:'manager-upgrade',state:'completed',legacy:false,
 deletedImages:[{type:'image',id:'sha256:'+'e'.repeat(64),name:'openclaw-manager:old'}],deletedContainers:[],removedTags:[],skipped:[],errors:[]}
],nextCursor:null,warnings:[],retention:'隔离 UI 测试数据；未连接 Docker。'}));
app.post('/api/images/cleanup',(_,res)=>{cleaned=true;res.json({removedImages:['old-image'],removedContainers:['old-copy'],errors:[],skipped:[]});});

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
const server=app.listen(18083,'127.0.0.1',()=>console.log('Isolated UI preview on 18083'));
const wss=new WebSocketServer({server});
wss.on('connection',ws=>{ws.send(Buffer.from('Isolated terminal fixture\r\n$ '));});
