'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const instances=require('./instances');
const unavailable=()=>Object.assign(new Error('无法读取 SSH 设备存储，请检查数据目录和加密密钥；原文件已保留'),{statusCode:503});
// Keep credentials outside instance workspaces and their ordinary backups.
function createStore(directory=process.env.OPENCLAW_SSH_STATE_DIR||path.join(path.dirname(instances.DATA_ROOT),'ssh-devices')){
  const file=path.join(directory,'devices.enc.json'),keyFile=path.join(directory,'encryption.key');
  function load(){
    if(!fs.existsSync(file))return [];
    try{
      const key=fs.readFileSync(keyFile);if(key.length!==32)throw unavailable();
      const envelope=JSON.parse(fs.readFileSync(file,'utf8'));if(envelope.version!==1)throw unavailable();
      const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
      decipher.setAAD(Buffer.from('openclaw-ssh-devices-v1'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
      const rows=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64')),decipher.final()]).toString('utf8'));
      if(!Array.isArray(rows)||rows.length>64||rows.some(r=>!r||!/^[a-f0-9]{24}$/.test(r.id))||new Set(rows.map(r=>r.id)).size!==rows.length)throw unavailable();
      return rows;
    }catch{throw unavailable();}
  }
  function write(rows){
    // Validate/decrypt existing data first. Never overwrite an unreadable store.
    load();if(rows.length>64)throw Object.assign(new Error('最多保存 64 台 SSH 设备'),{statusCode:409});
    fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
    if(!fs.existsSync(keyFile)){
      const fd=fs.openSync(keyFile,'wx',0o600);
      try{fs.writeFileSync(fd,crypto.randomBytes(32));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    const key=fs.readFileSync(keyFile);if(key.length!==32)throw unavailable();
    fs.chmodSync(keyFile,0o600);
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from('openclaw-ssh-devices-v1'));
    const data=Buffer.concat([cipher.update(JSON.stringify(rows),'utf8'),cipher.final()]);
    instances.atomicWrite(file,JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));
    fs.chmodSync(file,0o600);
  }
  return {load,put(row){const rows=load(),index=rows.findIndex(r=>r.id===row.id);if(index<0)rows.push(row);else rows[index]=row;write(rows);},remove(id){write(load().filter(r=>r.id!==id));}};
}
module.exports={createStore};
