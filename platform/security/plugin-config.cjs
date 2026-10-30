// Trusted one-shot config writer, embedded in a no-network helper container.
// Use the installed runtime's writer to preserve its config guard metadata,
// revision checks and last-good snapshot. Never print config or credentials.
const fs=require('fs'),{pathToFileURL}=require('url'),crypto=require('crypto');
async function exported(prefix,name){
 for(const file of fs.readdirSync('/app/dist').filter(n=>n.startsWith(prefix+'-')&&n.endsWith('.mjs'))){
  const source=fs.readFileSync('/app/dist/'+file,'utf8'),end=source.slice(source.lastIndexOf('export {'));
  if(!end.includes(name))continue;
  const module=await import(pathToFileURL('/app/dist/'+file).href),alias=new RegExp('\\b'+name+' as ([\\w$]+)').exec(end)?.[1];
  if(typeof module[name]==='function')return module[name];if(alias&&typeof module[alias]==='function')return module[alias];
 }
 throw Error('Required transactional config writer is unavailable');
}
(async()=>{
 const {config,expectedHash}=JSON.parse(fs.readFileSync('/mutation.json','utf8'));
 const current=fs.readFileSync('/home/node/.openclaw/openclaw.json');
 if(crypto.createHash('sha256').update(current).digest('hex')!==expectedHash)throw Error('Config conflict');
 const snapshot=await(await exported('management-config','readPluginMutationSnapshot'))(process.env);
 await(await exported('mutate','replaceConfigFile'))({sourceConfig:config,baseHash:snapshot.baseHash,writeOptions:snapshot.writeOptions});
})().catch(()=>{console.error('Transactional isolated-plugin config write rejected');process.exitCode=1;});
