'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
function fixture(){
  const nodes=new Map(),calls=[];
  const get=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',innerHTML:'',disabled:false,classList:{toggle(){}}});return nodes.get(id);};
  let handler=async()=>({entries:[],nextCursor:null});
  const ctx={$:get,esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),api:async url=>{calls.push(url);return handler(url);}};
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('let cleanupHistoryRows'),source.indexOf('function bindImageModal')),ctx);
  const row={id:'event',at:new Date().toISOString(),source:'manual',state:'partial',trigger:'manual-cleanup',legacy:true,
    deletedImages:[{id:'image',type:'image',name:'<img onerror=alert(1)>'}],deletedContainers:[{id:'c',type:'rollback',name:'old-rollback'}],
    skipped:[{id:'current',reason:'保留上一版',name:'current'}],errors:[{id:'fail',reason:'<script>failure</script>',name:'busy'}]};
  return {ctx,get,calls,row,handle:fn=>{handler=fn;}};
}
test('history displays time, source, deleted names and failure/protection reasons as escaped text',async()=>{
  const f=fixture();f.handle(async()=>({entries:[f.row],nextCursor:null}));await f.ctx.loadCleanupHistory();
  const html=f.get('#cleanupHistory').innerHTML;
  for(const value of ['手动清理','部分失败','已删除镜像','已删除回滚容器','old-rollback','保留上一版','旧记录'])assert.ok(html.includes(value));
  assert.ok(html.includes('&lt;img'));assert.ok(html.includes('&lt;script>'));assert.ok(!html.includes('<script>'));
  assert.equal(f.get('#btnCleanupHistory').disabled,false);
});
test('history paginates without duplicates and keeps existing records on failure; a newer refresh wins',async()=>{
  const f=fixture();f.handle(async()=>({entries:[f.row],nextCursor:'page-2'}));await f.ctx.loadCleanupHistory();
  f.handle(async()=>({entries:[f.row,{...f.row,id:'older',source:'automatic',trigger:'manual-cleanup'}],nextCursor:null}));await f.ctx.loadCleanupHistory(true);
  assert.match(f.calls[1],/cursor=page-2/);assert.match(f.get('#cleanupHistory').innerHTML,/自动重试手动清理任务/);
  const before=f.get('#cleanupHistory').innerHTML;f.handle(async()=>{throw Error('读取失败');});await f.ctx.loadCleanupHistory();
  assert.equal(f.get('#cleanupHistory').innerHTML,before);assert.match(f.get('#cleanupHistoryNotice').textContent,/读取失败/);
  const resolves=[];f.handle(()=>new Promise(resolve=>resolves.push(resolve)));
  const first=f.ctx.loadCleanupHistory(),second=f.ctx.loadCleanupHistory();
  resolves[1]({entries:[{...f.row,deletedContainers:[{name:'newest'}]}],nextCursor:null});await second;
  resolves[0]({entries:[{...f.row,deletedContainers:[{name:'stale'}]}],nextCursor:null});await first;
  assert.match(f.get('#cleanupHistory').innerHTML,/newest/);assert.ok(!f.get('#cleanupHistory').innerHTML.includes('stale'));
});
