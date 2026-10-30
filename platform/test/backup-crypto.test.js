 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {transform}=require('../scripts/backup_crypto.cjs');
test('backup authenticated encryption restores bytes and rejects tampering/wrong keys without leaving plaintext',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'backup-crypto-'));
 try {
  const source=path.join(root,'source'),encrypted=path.join(root,'encrypted'),output=path.join(root,'restored'),key=path.join(root,'key');
  fs.writeFileSync(source,'SYNTHETIC_CREDENTIAL');fs.writeFileSync(key,crypto.randomBytes(32));
  await transform('encrypt',source,encrypted,key);assert.ok(!fs.readFileSync(encrypted).includes(Buffer.from('SYNTHETIC_CREDENTIAL')));
  await transform('decrypt',encrypted,output,key);assert.equal(fs.readFileSync(output,'utf8'),'SYNTHETIC_CREDENTIAL');fs.unlinkSync(output);
  const other=path.join(root,'other-key');fs.writeFileSync(other,crypto.randomBytes(32));
  await assert.rejects(transform('decrypt',encrypted,output,other));assert.equal(fs.existsSync(output),false);
  const bytes=fs.readFileSync(encrypted);bytes[18]^=1;fs.writeFileSync(encrypted,bytes);
  await assert.rejects(transform('decrypt',encrypted,output,key));assert.equal(fs.existsSync(output),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
