'use strict';
// Isolated kernel fixture: no host binds, no Docker socket, no production data.
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process');
const suffix=crypto.randomBytes(8).toString('hex'),name='openclaw-quota-kernel-'+suffix,image=name+':test';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-quota-build-'));
function docker(args,options={}){const r=spawnSync('docker',args,{stdio:'inherit',windowsHide:true,...options});if(r.status!==0)throw Error('Docker quota test failed: '+args[0]);}
try{
 fs.mkdirSync(path.join(scratch,'scripts'));fs.mkdirSync(path.join(scratch,'test'));
 for(const file of ['storage_quota.py','quota_host_service.py','manager_host_service.py','startup_recovery.py'])fs.copyFileSync(path.join(__dirname,'../scripts',file),path.join(scratch,'scripts',file));
 for(const file of ['storage_quota_test.py','storage-quota-kernel.py'])fs.copyFileSync(path.join(__dirname,file),path.join(scratch,'test',file));
 fs.writeFileSync(path.join(scratch,'Dockerfile'),`FROM python:3.12-slim-bookworm
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get -o Acquire::Retries=3 update && apt-get install -y --no-install-recommends xfsprogs util-linux && rm -rf /var/lib/apt/lists/*
COPY scripts /fixture/scripts
COPY test /fixture/test
RUN printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/docker && chmod 755 /usr/local/bin/docker
CMD ["sh","-c","python /fixture/test/storage_quota_test.py && python /fixture/test/storage-quota-kernel.py"]
`);
 docker(['build','-t',image,scratch]);
 docker(['run','--name',name,'--label','openclaw.quota.test='+suffix,'--privileged','--network','none',image]);
}finally{
 spawnSync('docker',['rm','-f',name],{stdio:'ignore',windowsHide:true});
 spawnSync('docker',['image','rm',image],{stdio:'ignore',windowsHide:true});
 const resolved=path.resolve(scratch),parent=path.resolve(os.tmpdir());
 if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('openclaw-quota-build-'))throw Error('Refusing unexpected cleanup path');
 fs.rmSync(resolved,{recursive:true,force:true});
}
