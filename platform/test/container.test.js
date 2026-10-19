'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {address}=require('../src/gateway-address');
const row={State:'running',Labels:{'openclaw.managed':'true'},Names:['/openclaw-fixture'],Ports:[{PrivatePort:18789,PublicPort:19123}],NetworkSettings:{Networks:{bridge:{IPAddress:'172.17.0.7'}}}};
test('container Manager selects owned gateway by published port and refuses ambiguous matches',()=>{
  assert.equal(address(19123,[row]),'http://172.17.0.7:18789');assert.throws(()=>address(19124,[row]),/唯一/);assert.throws(()=>address(19123,[row,{...row}]),/唯一/);
});
test('stopped, unrelated and rollback containers cannot become a gateway probe target',()=>{
  for(const patch of [{State:'exited'},{Labels:{}},{Names:['/openclaw-fixture-rollback-123']},{NetworkSettings:{Networks:{bridge:{IPAddress:'malformed'}}}}])assert.throws(()=>address(19123,[{...row,...patch}]));
});
