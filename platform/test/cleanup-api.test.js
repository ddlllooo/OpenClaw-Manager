'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('http');
const express=require('express');
const security=require('../src/security');
const calls=[];
const retention=require('../src/retention');
const originalPreview=retention.preview,originalExecute=retention.execute,originalHistory=retention.history;
retention.history=query=>{calls.push(['history',query]);return {entries:[],nextCursor:null};};
retention.preview=async owner=>{calls.push(['preview',owner]);return {previewId:'a'.repeat(48),images:[],containers:[],summary:{deleteImages:0,deleteContainers:0}};};
retention.execute=async(id,owner)=>{calls.push(['execute',id,owner]);return {removedImages:[],removedContainers:[],skipped:[],errors:[]};};
const app=express();app.use(security.middleware);app.use(express.json());app.use('/api/images',require('../src/routes/images'));
app.use((err,req,res,next)=>res.status(err.statusCode||500).json({error:err.message}));
let server,port,cookie,csrf;
function request(url,method='GET',body,headers={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:url,method,agent:false,headers:{Host:'127.0.0.1:18080','Content-Type':'application/json',Cookie:cookie||'','X-CSRF-Token':csrf||'',...headers}},res=>{
      let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(data||'{}')}));
    });req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();
  });
}
test.before(async()=>{
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));port=server.address().port;
  const session=await request('/api/session');cookie=session.headers['set-cookie'][0].split(';')[0];csrf=session.body.csrf;
});
test.after(async()=>{retention.preview=originalPreview;retention.execute=originalExecute;retention.history=originalHistory;server.closeAllConnections();await new Promise(r=>server.close(r));});
test('preview and cleanup require an authenticated local session; mutation requires CSRF and a reviewed ID',async()=>{
  calls.length=0;
  assert.equal((await request('/api/images/cleanup/preview','GET',null,{Cookie:''})).status,401);
  assert.equal((await request('/api/images/cleanup/preview','GET',null,{Host:'attacker.invalid'})).status,403);
  assert.equal((await request('/api/images/cleanup','POST',{previewId:'a'.repeat(48)},{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await request('/api/images/cleanup','POST',{})).status,400);assert.deepEqual(calls,[]);
  assert.equal((await request('/api/images/cleanup/preview')).status,200);
  assert.equal(calls[0][1],cookie.split('=')[1]);
  assert.equal((await request('/api/images/cleanup','POST',{previewId:'a'.repeat(48)})).status,200);
  assert.deepEqual(calls[1],['execute','a'.repeat(48),cookie.split('=')[1]]);
});
test('legacy direct deletion cannot bypass the preview and rollback protection',async()=>{
  calls.length=0;
  const result=await request('/api/images/openclaw-manager%3Av1','DELETE',{});
  assert.equal(result.status,409);assert.match(result.body.error,/预览/);assert.deepEqual(calls,[]);
});

test('history requires a local session and validates query structure before reading files',async()=>{
  calls.length=0;
  assert.equal((await request('/api/images/cleanup/history','GET',null,{Cookie:''})).status,401);
  assert.equal((await request('/api/images/cleanup/history?limit=10&limit=20')).status,400);
  assert.equal((await request('/api/images/cleanup/history?cursor=a&cursor=b')).status,400);
  assert.deepEqual(calls,[]);
  assert.equal((await request('/api/images/cleanup/history?limit=5&cursor=example')).status,200);
  assert.deepEqual(calls,[['history',{limit:5,cursor:'example'}]]);
});
