'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\r\n/g, '\n');
function extract(from, to) { return source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from))); }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('terminal assets load only on demand, once, and late loads do not connect a hidden terminal', async () => {
  const assets = [], appended = [];
  const context = {state:{selectedId:'one'},activeDetailTab:'overview',connections:0,
    termHint(){},ensureTerminalReady(){context.connections++;},
    document:{hidden:false,createElement:tag=>({tag,remove(){}}),head:{appendChild(element){assets.push(element);appended.push(element.src || element.href);}}}};
  vm.createContext(context);
  vm.runInContext(extract('let terminalAssetsPromise', 'function ensureTerminalReady()'), context);
  await context.ensureTerminal(); assert.equal(assets.length,0);
  context.activeDetailTab='terminal';
  const one=context.ensureTerminal(),two=context.ensureTerminal();
  assert.equal(assets.length,2);
  assets.find(e=>e.tag==='link').onload();assets.find(e=>e.src==='/vendor/xterm.js').onload();
  await flush();assert.equal(assets.length,3);
  context.document.hidden=true;assets.find(e=>e.src==='/vendor/addon-fit.js').onload();
  await Promise.all([one,two]);assert.equal(context.connections,0);
  context.document.hidden=false;await context.ensureTerminal();
  assert.equal(context.connections,1);assert.equal(appended.length,3);
});

test('unchanged markup does not replace DOM; hidden charts do not draw', () => {
  let writes=0;const element={set innerHTML(v){writes++;}};
  const context={document:{hidden:true},activeDetailTab:'overview',$:()=>({getContext(){throw Error('hidden canvas drew');}})};
  vm.createContext(context);vm.runInContext(extract('function setHTML(', 'function logEvent('),context);
  context.setHTML(element,'one');context.setHTML(element,'one');assert.equal(writes,1);
  context.setHTML(element,'two');assert.equal(writes,2);
  vm.runInContext(extract('function drawSparkline()', '// Update just the perf numbers'),context);
  context.drawSparkline();context.document.hidden=false;context.activeDetailTab='config';context.drawSparkline();
});

test('log requests coalesce, a newer tail wins, and an older response cannot overwrite it', async () => {
  const replies=[],ta={dataset:{},scrollHeight:100};const tail={value:'200'};
  const context={viewEpoch:1,state:{selectedId:'one'},logsRaw:'',filters:0,
    $:q=>q==='#logView'?ta:tail,
    api:()=>new Promise(resolve=>replies.push(resolve)),applyLogFilter(){context.filters++;}};
  vm.createContext(context);vm.runInContext(extract('let logsRequest =', "let logsRaw ="),context);
  const first=context.loadLogs();assert.equal(first,context.loadLogs());assert.equal(replies.length,1);
  tail.value='500';const second=context.loadLogs();assert.equal(replies.length,2);
  replies[1]({logs:'new'});await second;replies[0]({logs:'old'});await first;
  assert.equal(context.logsRaw,'new');assert.equal(context.filters,1);
});

test('large transcripts initially mount 100 messages and older messages remain accessible', () => {
  let html='';const transcript={scrollTop:5,get scrollHeight(){return html.length;},get innerHTML(){return html;},set innerHTML(value){html=value;}};
  const messages=Array.from({length:1000},(_,i)=>({role:'user',text:'message-'+i}));
  const context={sessState:{messages,visibleMessages:100},$:()=>transcript,esc:String};
  vm.createContext(context);vm.runInContext(extract('function renderTranscript(', "document.addEventListener('click', event => {\n  if (event.target.closest('[data-sess-earlier]'))"),context);
  context.renderTranscript();assert.equal((html.match(/chat-row/g)||[]).length,100);
  assert.ok(html.includes('message-999'));assert.ok(!html.includes('message-0<'));assert.ok(html.includes('还有 900 条'));
  context.sessState.visibleMessages=200;context.renderTranscript(true);
  assert.equal((html.match(/chat-row/g)||[]).length,200);assert.equal(messages.length,1000);
  context.sessState.visibleMessages=1000;context.renderTranscript(true);
  assert.ok(html.includes('message-0<'));assert.ok(!html.includes('data-sess-earlier'));
});

test('typing a filter repeatedly schedules only the latest operation and skips hidden or detached views', () => {
  const timers=new Map();let seq=0,calls=0;const input={id:'logFilter',dataset:{},isConnected:true};
  const context={document:{hidden:false},setTimeout:fn=>{timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id)};
  vm.createContext(context);vm.runInContext(extract('const filterTimers =', "document.addEventListener('input'"),context);
  for(let i=0;i<100;i++)context.scheduleFilter(input,()=>calls++);
  assert.equal(timers.size,1);timers.get(seq)();assert.equal(calls,1);
  context.scheduleFilter(input,()=>calls++);context.document.hidden=true;timers.get(seq)();assert.equal(calls,1);
  context.document.hidden=false;input.isConnected=false;context.scheduleFilter(input,()=>calls++);timers.get(seq)();assert.equal(calls,1);
});
