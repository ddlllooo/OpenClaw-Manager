 'use strict';
const http=require('http'),{spawn}=require('child_process');
function ready(){return new Promise(resolve=>{const req=http.get('http://127.0.0.1:5354/ready',{timeout:1000},res=>{res.resume();resolve(res.statusCode===204);});req.on('error',()=>resolve(false));req.on('timeout',()=>req.destroy());});}
(async()=>{
 while(!await ready())await new Promise(r=>setTimeout(r,500));
 const args=process.argv.slice(2);if(!args.length)throw Error('Missing application command');
 const child=spawn(args[0],args.slice(1),{stdio:'inherit',env:process.env});
 child.on('error',()=>process.exit(1));child.on('exit',code=>process.exit(code??1));
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
})();
