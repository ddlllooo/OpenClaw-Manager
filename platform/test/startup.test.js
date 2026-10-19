'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-startup-'));
process.env.OPENCLAW_STARTUP_HOME=scratch;
const settings=require('../src/startup-settings');
test.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
test('creation and replacement inherit the configured startup policy without overriding manual stop semantics',()=>{
  const template={Name:'no'};assert.equal(settings.restartPolicy('fixture',template),template);
  fs.writeFileSync(path.join(scratch,'startup-settings.json'),JSON.stringify({instancesAutoStart:false,instanceOverrides:{}}));assert.deepEqual(settings.restartPolicy('fixture'),{Name:'no'});
  fs.writeFileSync(path.join(scratch,'startup-settings.json'),JSON.stringify({instancesAutoStart:true,instanceOverrides:{fixture:false}}));assert.deepEqual(settings.restartPolicy('fixture'),{Name:'no'});assert.deepEqual(settings.restartPolicy('other'),{Name:'unless-stopped'});
});
test('invalid startup settings cannot silently create an always-restarting container',()=>{
  fs.writeFileSync(path.join(scratch,'startup-settings.json'),'{}');assert.throws(()=>settings.restartPolicy('fixture'),/损坏/);
});
test('macOS Manager keeps the Desktop socket address even before Docker creates it',()=>{
  const docker=require('../src/docker');assert.equal(docker.resolveSocketPath('darwin','/Users/test',()=>false),path.join('/Users/test','.docker/run/docker.sock'));assert.equal(docker.resolveSocketPath('linux','/home/test',()=>false),'/var/run/docker.sock');
});
