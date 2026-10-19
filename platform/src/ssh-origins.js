'use strict';
// Container ports cannot expose ephemeral proxy listeners. Route independent
// loopback origins through the Manager's already published port instead.
const http=require('http'),net=require('net'),crypto=require('crypto');
const origins=new Map();
function allowed(req,host){
  if(req.headers.host!==host)return false;
  if(req.headers.origin&&req.headers.origin!=='http://'+host)return false;
  const navigation=req.method==='GET'&&!req.headers.origin&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
  return navigation||!['cross-site','same-site'].includes(req.headers['sec-fetch-site']);
}
function register(server){
  const host='openclaw-'+crypto.randomBytes(16).toString('hex')+'.localhost:'+Number(process.env.MANAGER_PORT||18080);
  origins.set(host,server);
  return {url:'http://'+host+'/',close(){origins.delete(host);}};
}
function headers(req,port){
  const result={...req.headers,host:'127.0.0.1:'+port};
  if(result.origin)result.origin='http://127.0.0.1:'+port;
  return result;
}
function middleware(req,res,next){
  const host=req.headers.host,server=origins.get(host);
  if(!server)return next();
  if(!allowed(req,host)){res.writeHead(403);res.end('拒绝不可信的来源');return;}
  const port=server.address()?.port;
  if(!port){res.writeHead(502);res.end('SSH 隧道已关闭');return;}
  const upstream=http.request({host:'127.0.0.1',port,path:req.url,method:req.method,headers:headers(req,port)},response=>{
    res.writeHead(response.statusCode,response.headers);response.on('error',()=>res.destroy());response.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('SSH 隧道不可用');});
  req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
}
function upgrade(req,socket,head){
  const host=req.headers.host,server=origins.get(host);
  if(!server)return false;
  const port=server.address()?.port;
  if(!allowed(req,host)||!port){socket.destroy();return true;}
  const upstream=net.connect(port,'127.0.0.1',()=>{
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`+Object.entries(headers(req,port)).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');
    if(head.length)upstream.write(head);upstream.pipe(socket).pipe(upstream);
  });
  upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());
  upstream.on('close',()=>socket.destroy());socket.on('close',()=>upstream.destroy());return true;
}
module.exports={register,middleware,upgrade,allowed};
