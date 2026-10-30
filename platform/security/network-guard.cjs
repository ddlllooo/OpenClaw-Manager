 'use strict';
const dns=require('dns'),dgram=require('dgram'),net=require('net'),http=require('http'),{execFileSync}=require('child_process');
function publicIPv4(ip){
 if(net.isIP(ip)!==4)return false;const [a,b,c]=ip.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)||a===192&&b===0||ip==='168.63.129.16'||a===198&&b===51&&c===100||a===203&&b===0&&c===113||a===192&&b===88&&c===99);
}
function origins(values){
 if(!Array.isArray(values)||values.length>100)throw Error('Expected at most 100 exact origins');
 return values.map(entry=>{
  const value=typeof entry==='string'?{origin:entry}:entry,url=new URL(value.origin);
  if(!['http:','https:','wss:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Exact HTTP(S)/WSS origins required');
  if(url.hostname.includes('*')||net.isIP(url.hostname)===6)throw Error('Wildcards and IPv6 origins are not supported');
  const port=Number(url.port||(url.protocol==='http:'?80:443));if(port<1||port>65535)throw Error('Invalid destination port');
  return {host:url.hostname.toLowerCase().replace(/\.$/,''),port,allowPrivate:value.allowPrivate===true};
 });
}
function question(packet){
 if(packet.length<17||packet.readUInt16BE(4)!==1)throw Error('Bad DNS query');
 let i=12,parts=[];
 while(packet[i]){const n=packet[i++];if(n>63||i+n>=packet.length)throw Error('Bad DNS label');parts.push(packet.subarray(i,i+n).toString('ascii'));i+=n;}
 i++;if(i+4>packet.length)throw Error('Truncated DNS');
 const name=parts.join('.').toLowerCase();if(!/^[a-z0-9._-]{1,253}$/.test(name))throw Error('Bad DNS name');
 return {name,type:packet.readUInt16BE(i),end:i+4};
}
function createDNS(policy,{resolve,permit}){
 const entries=origins(policy.origins||[]),cache=new Map();
 async function lookup(host){
  const rules=entries.filter(e=>e.host===host);if(!rules.length)throw Error('Denied');
  if(cache.get(host)?.expires>Date.now())return cache.get(host).addresses;
  const addresses=net.isIP(host)?[host]:await resolve(host);
  if(!addresses.length||addresses.some(ip=>net.isIP(ip)!==4||(!publicIPv4(ip)&&!rules.every(r=>r.allowPrivate))))throw Error('Non-public destination denied');
  for(const rule of rules)for(const ip of addresses)await permit(ip,rule.port);
  cache.set(host,{addresses,expires:Date.now()+30000});return addresses;
 }
 async function reply(packet){
  const q=question(packet);let addresses=[],rcode=0;
  try{if(!entries.some(r=>r.host===q.name))throw Error('Denied');if(q.type===1)addresses=await lookup(q.name);else if(q.type!==28)throw Error('Unsupported query');}catch{rcode=3;}
  const header=Buffer.alloc(12);packet.copy(header,0,0,2);header.writeUInt16BE(0x8180|rcode,2);header.writeUInt16BE(1,4);header.writeUInt16BE(addresses.length,6);
  const records=addresses.map(ip=>{const row=Buffer.alloc(16);row.writeUInt16BE(0xc00c,0);row.writeUInt16BE(1,2);row.writeUInt16BE(1,4);row.writeUInt32BE(30,6);row.writeUInt16BE(4,10);ip.split('.').forEach((n,i)=>row[12+i]=Number(n));return row;});
  return Buffer.concat([header,packet.subarray(12,q.end),...records]);
 }
 return {reply,lookup,entries};
}
function start(policy){
 const run=(tool,args)=>execFileSync(tool,['-w','5',...args],{stdio:'ignore'});
 const chain='OPENCLAW_EGRESS';
 // No application starts until the readiness listener opens after all rules succeed.
 try{run('iptables',['-N',chain]);}catch{throw Error('Guard chain already exists; recreate the guard and target together');}
 run('iptables',['-I','OUTPUT','1','-j',chain]);
 const add=(...args)=>run('iptables',['-A',chain,...args]);
 add('-d','127.0.0.11','-j','DROP');
 add('-m','conntrack','--ctstate','ESTABLISHED,RELATED','-j','ACCEPT');
 add('-d','127.0.0.53','-p','udp','--dport','53','-j','ACCEPT');
 add('-d','127.0.0.0/8','-p','udp','--dport','53','-j','DROP');
 add('-d','127.0.0.0/8','-p','tcp','--dport','53','-j','DROP');
 add('-o','lo','-j','ACCEPT');
 const resolver=policy.resolver||'1.1.1.1';if(net.isIP(resolver)!==4||resolver.startsWith('127.')||resolver==='0.0.0.0')throw Error('A non-loopback IPv4 DNS resolver is required');
 if((policy.origins||[]).length)for(const protocol of ['udp','tcp'])add('-m','owner','--uid-owner','0','-d',resolver,'-p',protocol,'--dport','53','-j','ACCEPT');
 for(const endpoint of policy.internalTCP||[]){if(net.isIP(endpoint.ip)!==4||!Number.isInteger(endpoint.port)||endpoint.port<1||endpoint.port>65535)throw Error('Invalid internal endpoint');add('-d',endpoint.ip,'-p','tcp','--dport',String(endpoint.port),'-j','ACCEPT');}
 add('-j','REJECT');
 run('ip6tables',['-P','OUTPUT','DROP']);run('ip6tables',['-A','OUTPUT','-o','lo','-j','ACCEPT']);
 const permits=new Map();
 const api=createDNS(policy,{resolve:async host=>{const r=new dns.promises.Resolver();r.setServers([resolver]);return r.resolve4(host);},permit:async(ip,port)=>{
  const key=ip+':'+port;
  if(!permits.has(key))run('iptables',['-I',chain,'2','-d',ip,'-p','tcp','--dport',String(port),'-j','ACCEPT']);
  permits.set(key,{ip,port,expires:api.entries.some(e=>e.host===ip)?Infinity:Date.now()+60000});
 }});
 const udp=dgram.createSocket('udp4');udp.on('error',()=>process.exit(1));udp.on('message',async(packet,peer)=>{try{if(packet.length>512)return;const response=await api.reply(packet);udp.send(response,peer.port,peer.address);}catch{}});
 udp.bind(53,'127.0.0.53',async()=>{
  try{for(const entry of api.entries)if(net.isIP(entry.host))await api.lookup(entry.host);}catch{process.exit(1);return;}
  http.createServer((req,res)=>{res.writeHead(req.url==='/ready'?204:404);res.end();}).listen(5354,'127.0.0.1');
 });
 setInterval(()=>{for(const [key,item]of permits)if(item.expires<Date.now()){run('iptables',['-D',chain,'-d',item.ip,'-p','tcp','--dport',String(item.port),'-j','ACCEPT']);permits.delete(key);}},10000);
}
module.exports={publicIPv4,origins,question,createDNS,start};
if(require.main===module){try{start(JSON.parse(process.env.OPENCLAW_GUARD_POLICY||require('fs').readFileSync(process.argv[2],'utf8')));}catch{console.error('Network guard failed closed');process.exit(1);}}
