'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const createPageActivity = require('../public/activity');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(onPoll) {
  const listeners = new Map(), windowListeners = new Map(), timers = new Map();
  let id=0;
  const counts={activate:0,deactivate:0,poll:0,render:0,visibility:[]};
  const document={hidden:false,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const window={addEventListener:(name,fn)=>windowListeners.set(name,fn),removeEventListener:name=>windowListeners.delete(name)};
  const controller=createPageActivity({document,window,setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key),
    onActivate:()=>counts.activate++,onDeactivate:()=>counts.deactivate++,onVisibility:visible=>counts.visibility.push(visible),
    onPoll:()=>{counts.poll++;return onPoll?.();},onRender:()=>counts.render++});
  function fire(key) { const fn=timers.get(key);timers.delete(key);fn(); }
  return {controller,document,listeners,windowListeners,timers,counts,fire};
}
test('background page closes live monitoring and has no recurring poll/render timers',async()=>{
  const h=harness();h.controller.start();await flush();
  assert.equal(h.counts.activate,1);assert.equal(h.timers.size,2);
  h.document.hidden=true;h.listeners.get('visibilitychange')();
  assert.equal(h.counts.deactivate,1);assert.equal(h.timers.size,0);assert.equal(h.controller.isActive(),false);
  h.controller.queueRender();await flush();assert.equal(h.timers.size,0);
  h.document.hidden=false;h.listeners.get('visibilitychange')();await flush();
  assert.equal(h.counts.activate,2);assert.equal(h.counts.poll,2);assert.equal(h.timers.size,2);
  h.controller.dispose();assert.equal(h.timers.size,0);
});
test('many SSE updates are coalesced to one render and polling cannot overlap',async()=>{
  let complete;const h=harness(()=>new Promise(resolve=>{complete=resolve;}));
  h.controller.start();
  for(let n=0;n<100;n++)h.controller.queueRender();
  assert.equal(h.timers.size,1);h.fire([...h.timers.keys()][0]);assert.equal(h.counts.render,1);
  assert.equal(h.counts.poll,1);assert.equal(h.timers.size,0);
  complete();await flush();assert.equal(h.timers.size,1);h.controller.dispose();
});
test('pending work cannot rearm polling while hidden; Safari page cache resumes once',async()=>{
  let complete;const h=harness(()=>new Promise(resolve=>{complete=resolve;}));
  h.controller.start();h.windowListeners.get('pagehide')();complete();await flush();
  assert.equal(h.timers.size,0);assert.deepEqual(h.counts.visibility,[true,false]);
  h.windowListeners.get('pageshow')();h.listeners.get('visibilitychange')();
  assert.equal(h.counts.activate,2);complete();await flush();assert.equal(h.timers.size,2);h.controller.dispose();
});
test('terminal resize sends only changed dimensions and hidden cursor animation stops',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
  const resize=source.slice(source.indexOf('function sendTerminalResize()'),source.indexOf('function resizeTerminal()'));
  const animation=source.slice(source.indexOf('function syncTerminalAnimation('),source.indexOf('function renderRealtime()'));
  const sent=[];const term={cols:80,rows:24,options:{cursorBlink:true}};
  const context={termState:{ws:{readyState:1,send:value=>sent.push(value)},term,fit:{fit(){}}},document:{hidden:false},activeDetailTab:'terminal',clearTimeout(){},ensureTerminal(){}};
  vm.createContext(context);vm.runInContext(resize+animation,context);
  context.sendTerminalResize();context.sendTerminalResize();assert.equal(sent.length,1);
  term.cols=100;context.sendTerminalResize();assert.equal(sent.length,2);
  context.syncTerminalAnimation(false);assert.equal(term.options.cursorBlink,false);
  context.syncTerminalAnimation(true);assert.equal(term.options.cursorBlink,true);
});
