'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function fixture() {
  const nodes=new Map(),timers=[],calls=[];
  const get=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',disabled:false,classList:{remove(){},add(){},toggle(){}}});return nodes.get(id);};
  let handler=async()=>{};
  const context={$:get,esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),fmtBytes:n=>String(n),STATE_LABEL:{exited:'已停止'},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){},
    api:async(...args)=>{if(args[0].startsWith('/api/images/cleanup/history'))return {entries:[],nextCursor:null};calls.push(args);return handler(...args);},refreshLocalImages:async()=>{},logEvent(){}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('let cleanupPreviewData'),source.indexOf('function bindImageModal')),context);
  const data={previewId:'a'.repeat(48),expiresAt:new Date(Date.now()+300000).toISOString(),blockedReason:null,
    summary:{deleteImages:1,keepImages:1,deleteContainers:1,keepContainers:0},
    images:[{type:'image',id:'sha256:'+ '1'.repeat(64),name:'<img onerror=alert(1)>',sizeBytes:100,decision:'delete',reasons:['<script>bad</script>'],dependsOn:['old']},
      {type:'image',id:'sha256:'+'2'.repeat(64),name:'openclaw-manager:v1',sizeBytes:200,decision:'keep',reasons:['保留上一版 Manager']}],
    containers:[{type:'rollback',id:'3'.repeat(64),name:'old-rollback',state:'exited',decision:'delete',reasons:['已被较新版本替代']}]};
  return {context,get,timers,calls,data,handle:fn=>{handler=fn;}};
}
test('preview renders deletion/retention reasons as escaped text and disables empty, blocked or expired cleanup',async()=>{
  const f=fixture();f.context.renderCleanupPreview(f.data);
  const html=f.get('#cleanupPreview').innerHTML;
  assert.match(html,/将删除（2 项）/);assert.match(html,/将保留（1 项）/);assert.match(html,/保留上一版 Manager/);
  assert.match(html,/&lt;img/);assert.ok(!html.includes('<script>'));assert.match(html,/需先删除对应/);
  assert.equal(f.get('#btnCleanupRun').disabled,false);
  f.context.renderCleanupPreview({...f.data,blockedReason:'平台正在变更'});assert.equal(f.get('#btnCleanupRun').disabled,true);
  f.context.renderCleanupPreview({...f.data,summary:{deleteImages:0,deleteContainers:0}});assert.equal(f.get('#btnCleanupRun').disabled,true);
  f.context.renderCleanupPreview({...f.data,expiresAt:new Date(Date.now()-100).toISOString()});await f.context.runManualCleanup();
  assert.equal(f.calls.length,0);assert.match(f.get('#cleanupNotice').textContent,/过期/);
});
test('manual action submits only the reviewed token, prevents duplicate clicks and invalidates a consumed preview',async()=>{
  const f=fixture();let resolve;f.handle(()=>new Promise(r=>{resolve=r;}));f.context.renderCleanupPreview(f.data);
  const first=f.context.runManualCleanup();await f.context.runManualCleanup();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'/api/images/cleanup');
  assert.deepEqual(JSON.parse(f.calls[0][1].body),{previewId:f.data.previewId});assert.equal(f.get('#btnCleanupRun').disabled,true);
  resolve({removedImages:['one'],removedContainers:['old'],errors:[],skipped:[]});await first;
  assert.match(f.get('#cleanupResult').textContent,/已删除 1 个镜像、1 个回滚容器/);assert.equal(f.get('#btnCleanupRun').disabled,true);
});
test('newer preview wins against delayed responses; stale execution errors require a fresh preview',async()=>{
  const f=fixture(),resolves=[];f.handle(()=>new Promise(r=>resolves.push(r)));
  const first=f.context.loadCleanupPreview(),second=f.context.loadCleanupPreview();
  resolves[1]({...f.data,previewId:'b'.repeat(48),images:[{...f.data.images[0],name:'new-preview'}]});await second;
  resolves[0]({...f.data,images:[{...f.data.images[0],name:'stale-preview'}]});await first;
  assert.match(f.get('#cleanupPreview').innerHTML,/new-preview/);assert.ok(!f.get('#cleanupPreview').innerHTML.includes('stale-preview'));
  f.handle(async()=>{throw Error('引用已变化，请刷新预览');});await f.context.runManualCleanup();
  assert.equal(f.get('#btnCleanupRun').disabled,true);assert.match(f.get('#cleanupResult').textContent,/引用已变化/);
});
