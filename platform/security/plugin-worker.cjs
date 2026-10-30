'use strict';
// This process is untrusted once the plugin is imported. The container boundary
// protects the gateway; the trusted bridge separately validates every request.
const fs=require('fs'),http=require('http'),crypto=require('crypto'),{pathToFileURL}=require('url');
const {validateValue}=require('./plugin-policy.cjs');
const MAX=65536;
async function start(){
 const settings=JSON.parse(fs.readFileSync('/policy/policy.json','utf8'));
 const tools=new Map(),allowed=new Set(settings.tools.map(t=>t.name));
 const api=Object.freeze(Object.assign(Object.create(null),{
  id:settings.id,pluginConfig:Object.freeze(settings.config||{}),
  logger:Object.freeze({info(){},warn(){},error(){},debug(){}}),
  registerTool(tool){
   if(!tool||typeof tool!=='object'||typeof tool.execute!=='function')throw Error('Only static tools support isolated execution');
   if(!allowed.has(tool.name))return;
   if(tools.has(tool.name))throw Error('Duplicate plugin tool');tools.set(tool.name,tool);
  }
 }));
 const imported=await import(pathToFileURL('/plugin/index.mjs').href),plugin=imported.default||imported;
 const register=typeof plugin==='function'?plugin:plugin.register;
 if(typeof register!=='function')throw Error('Plugin must export a register function');
 await register.call(plugin,api);
 if(settings.tools.some(t=>!tools.has(t.name)))throw Error('Approved tool is missing; no compatibility fallback');
 let active=false;
 const server=http.createServer(async(req,res)=>{
  const supplied=Buffer.from(String(req.headers.authorization||'')),expected=Buffer.from('Bearer '+settings.token);
  if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected)){res.writeHead(403);res.end();return;}
  if(req.method==='GET'&&req.url==='/health'){res.end(JSON.stringify({ok:true,tools:[...tools.keys()]}));return;}
  if(req.method!=='POST'||req.url!=='/invoke'||active){res.writeHead(active?429:404);res.end();return;}
  active=true;let bytes=0;const chunks=[];
  try{
   for await(const chunk of req){bytes+=chunk.length;if(bytes>MAX)throw Error('request too large');chunks.push(chunk);}
   const input=JSON.parse(Buffer.concat(chunks).toString('utf8')),spec=settings.tools.find(t=>t.name===input.name);
   if(!spec||Object.keys(input).some(k=>!['name','arguments'].includes(k)))throw Error('Tool denied');
   validateValue(input.arguments,spec.parameters);
   const result=await tools.get(spec.name).execute(crypto.randomUUID(),input.arguments);
   const output=JSON.stringify(result);if(!output||Buffer.byteLength(output)>MAX)throw Error('result too large');
   res.setHeader('Content-Type','application/json');res.end(output);
  }catch{res.writeHead(400);res.end('{"error":"Isolated plugin invocation failed"}');}
  finally{active=false;}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=8;server.listen(18790,'0.0.0.0');
}
if(require.main===module)start().catch(()=>{console.error('Isolated plugin could not start; unsupported plugins require an adapter');process.exit(1);});
module.exports={start};
