 'use strict';
// OCBK1 | 12-byte nonce | AES-256-GCM ciphertext | 16-byte authentication tag.
const fs=require('fs'),crypto=require('crypto'),{pipeline}=require('stream/promises');
const magic=Buffer.from('OCBK1');
async function transform(mode,input,output,keyFile){
 const key=fs.readFileSync(keyFile);if(key.length!==32)throw Error('Invalid backup key');
 if(fs.existsSync(output))throw Error('Output already exists');
 try {
  if(mode==='encrypt'){
   const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(magic);
   fs.writeFileSync(output,Buffer.concat([magic,nonce]),{flag:'wx',mode:0o600});
   await pipeline(fs.createReadStream(input),cipher,fs.createWriteStream(output,{flags:'a'}));
   fs.appendFileSync(output,cipher.getAuthTag());
  }else if(mode==='decrypt'){
   const size=fs.statSync(input).size;if(size<33)throw Error('Invalid backup');
   const fd=fs.openSync(input,'r'),header=Buffer.alloc(17),tag=Buffer.alloc(16);
   try{fs.readSync(fd,header,0,17,0);fs.readSync(fd,tag,0,16,size-16);}finally{fs.closeSync(fd);}
   if(!header.subarray(0,5).equals(magic))throw Error('Invalid backup format');
   const decipher=crypto.createDecipheriv('aes-256-gcm',key,header.subarray(5));decipher.setAAD(magic);decipher.setAuthTag(tag);
   await pipeline(fs.createReadStream(input,{start:17,end:size-17}),decipher,fs.createWriteStream(output,{flags:'wx',mode:0o600}));
  }else throw Error('Usage: node backup_crypto.cjs encrypt|decrypt INPUT OUTPUT KEY_FILE');
 }catch(error){try{fs.unlinkSync(output);}catch{}throw error;}
}
module.exports={transform};
if(require.main===module)transform(...process.argv.slice(2)).catch(()=>{console.error('Backup encryption/decryption failed; check key, file integrity and permissions.');process.exitCode=1;});
