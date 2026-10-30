'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('../src/storage-quota');
const offline={enabled:()=>false};
test('Windows, macOS and unprivileged container paths never claim directory hard-quota support',async()=>{
 for(const [platform,env] of [['win32',{}],['darwin',{}],['linux',{MANAGER_CONTAINERIZED:'1'}]]){
  const client=createClient({platform,env,host:offline,execute:()=>assert.fail('must not execute guest quota commands')});
  const cap=await client.probe('fixture');assert.equal(cap.supported,false);assert.ok(cap.reason);await assert.rejects(client.apply('fixture',1024**3,1000));
 }
});
test('quota RPC uses the configured signed host mailbox and forwards only scoped fields',async()=>{
 const calls=[],client=createClient({platform:'win32',env:{OPENCLAW_QUOTA_CONTROL_DIR:'/private/quota'},host:{enabled:()=>false,request:async(...args)=>{calls.push(args);return {supported:true};}}});
 await client.probe('fixture');await client.status('fixture',true);await client.apply('fixture',1024**3,1000);
 assert.deepEqual(calls.map(c=>[c[0],c[1]]),[['quota-probe',{id:'fixture'}],['quota-status',{id:'fixture',full:true}],['quota-apply',{id:'fixture',hardBytes:1024**3,hardInodes:1000}]]);
 assert.ok(calls.every(c=>c[3]==='/private/quota'));
});
test('failed host discovery is explicit and never falls back to a different filesystem',async()=>{
 let executions=0;const client=createClient({platform:'linux',env:{},host:{enabled:()=>true,request:async()=>{throw Error('unsupported host service');}},execute:()=>executions++});
 assert.match((await client.probe('fixture')).reason,/unsupported host service/);assert.equal(executions,0);
});
