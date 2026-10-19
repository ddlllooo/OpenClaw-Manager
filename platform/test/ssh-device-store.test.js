'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const {createStore}=require('../src/ssh-device-store');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-ssh-store-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return {directory,store:createStore(directory)};}
const row={id:'a'.repeat(24),host:'192.0.2.1',credentials:{password:'unique-password',privateKey:'unique-key',passphrase:'unique-passphrase'}};
test('saved SSH credentials are encrypted, authenticated and restricted to their owner',t=>{
  const {directory,store}=fixture(t);assert.deepEqual(store.load(),[]);store.put(row);assert.deepEqual(store.load(),[row]);
  const file=path.join(directory,'devices.enc.json'),key=path.join(directory,'encryption.key'),raw=fs.readFileSync(file,'utf8');
  for(const secret of Object.values(row.credentials))assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes(row.host));assert.equal(fs.readFileSync(key).length,32);
  if(process.platform!=='win32'){assert.equal(fs.statSync(directory).mode&0o777,0o700);for(const name of [file,key])assert.equal(fs.statSync(name).mode&0o777,0o600);}
  const before=raw;store.put({...row,paused:true});assert.notEqual(fs.readFileSync(file,'utf8'),before);assert.equal(store.load()[0].paused,true);
});
test('a changed ciphertext is rejected and never overwritten',t=>{
  const {directory,store}=fixture(t);store.put(row);const file=path.join(directory,'devices.enc.json'),envelope=JSON.parse(fs.readFileSync(file));
  const bytes=Buffer.from(envelope.data,'base64');bytes[0]^=1;envelope.data=bytes.toString('base64');fs.writeFileSync(file,JSON.stringify(envelope));const bad=fs.readFileSync(file,'utf8');
  assert.throws(()=>store.load(),/原文件已保留/);assert.throws(()=>store.put({...row,paused:true}),/原文件已保留/);assert.equal(fs.readFileSync(file,'utf8'),bad);
});
test('a missing encryption key does not replace or reset saved devices',t=>{
  const {directory,store}=fixture(t);store.put(row);const file=path.join(directory,'devices.enc.json'),before=fs.readFileSync(file,'utf8');fs.unlinkSync(path.join(directory,'encryption.key'));
  assert.throws(()=>store.put(row),/原文件已保留/);assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(!fs.existsSync(path.join(directory,'encryption.key')));
});
test('removing a device removes its credentials without changing other devices',t=>{
  const {store}=fixture(t),other={...row,id:'b'.repeat(24),credentials:{password:'another-secret'}};store.put(row);store.put(other);store.remove(row.id);assert.deepEqual(store.load(),[other]);
});
