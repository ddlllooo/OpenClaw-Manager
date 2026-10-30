 'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const guard=require('../security/network-guard.cjs'),profile=require('../security/profile.cjs');
function query(host,type=1){const h=Buffer.alloc(12);h.writeUInt16BE(123);h.writeUInt16BE(1,4);return Buffer.concat([h,...host.split('.').map(label=>Buffer.concat([Buffer.from([label.length]),Buffer.from(label)])),Buffer.from([0,0,type,0,1])]);}
test('DNS only resolves exact approved hosts and installs pinned IP/port rules before replying',async()=>{
 const calls=[];const api=guard.createDNS({origins:['https://api.example.com','wss://msg-frontier.feishu.cn']},{resolve:async host=>{calls.push(host);return ['93.184.216.34'];},permit:async(ip,port)=>calls.push([ip,port])});
 let result=await api.reply(query('api.example.com'));assert.equal(result.readUInt16BE(6),1);assert.deepEqual(calls,['api.example.com',['93.184.216.34',443]]);
 for(const host of ['attacker.example','api.example.com.attacker.example','steal.api.example.com']){result=await api.reply(query(host));assert.equal(result.readUInt16BE(2)&15,3);}
 assert.equal(calls.length,2);
 result=await api.reply(query('api.example.com',28));assert.equal(result.readUInt16BE(6),0);
});
test('private, metadata and IPv6 DNS answers are rejected unless explicitly approved for that origin',async()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.17.0.1','192.168.1.1','100.100.100.200','168.63.129.16','::1']){
  let permitted=false;const api=guard.createDNS({origins:['https://model.example']},{resolve:async()=>[ip],permit:async()=>{permitted=true;}});
  assert.equal((await api.reply(query('model.example'))).readUInt16BE(2)&15,3);assert.equal(permitted,false);
 }
 const api=guard.createDNS({origins:[{origin:'http://local.example:8000',allowPrivate:true}]},{resolve:async()=>['192.168.1.2'],permit:async(ip,port)=>assert.equal(port,8000)});assert.equal((await api.reply(query('local.example'))).readUInt16BE(6),1);
});
test('sandbox profile keeps providers/channels, isolates each configured Agent and disables execution escape hatches',()=>{
 const config={models:{providers:{p:{baseUrl:'https://api.example/v1',apiKey:'keep'}}},channels:{feishu:{enabled:true,appSecret:'keep'}},agents:{list:[{id:'main'},{id:'research',sandbox:{mode:'off'}}]}};
 const result=profile.apply(config,{main:{ip:'172.17.0.2'},research:{ip:'172.17.0.3'}});
 assert.deepEqual(result.models,config.models);assert.deepEqual(result.channels,config.channels);
 assert.equal(result.tools.elevated.enabled,false);assert.equal(result.tools.exec.host,'sandbox');
 assert.notEqual(result.agents.list[0].sandbox.ssh.target,result.agents.list[1].sandbox.ssh.target);
 assert.equal(result.agents.list[1].sandbox.mode,'all');assert.ok(profile.origins(config).includes('https://open.feishu.cn'));
 assert.throws(()=>profile.apply(config,{main:{ip:'1.2.3.4'}}),/Missing isolated worker/);
});

test('runtime escape configuration and broad egress rules are rejected',()=>{
 assert.throws(()=>profile.apply({acp:{enabled:true}},{}),/ACP/);
 assert.throws(()=>profile.apply({agents:{defaults:{workspace:'/home/node/.openclaw'}}},{}),/非工作区/);
 for(const origin of ['https://*.example.com','https://api.example.com/path','http://127.0.0.1:0'])assert.throws(()=>guard.origins([origin]));
});
