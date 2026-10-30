#!/usr/bin/env python3
"""Real macOS APFS + Docker Desktop test. Only a uniquely named test volume.

No production instance paths are mounted. The isolated Manager sees its fixture
data only; its Docker socket is needed to verify an actual protected stop.
"""
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
from apfs_migrate import Migration, write, manifest, reconcile
from apfs_quota import Backend, command, find_volume, info, MARKER

IMAGE=sys.argv[1];TAG='apfs-test-'+secrets.token_hex(4)
HOME=Path('/Users/livzon/openclaw-apfs-tests')/TAG;ROOT=HOME/'data/instances';TARGET=ROOT/TAG
MANAGER='openclaw-'+TAG+'-manager';WRITER='openclaw-'+TAG;PORT=18198;SOCKET='/Users/livzon/.docker/run/docker.sock'
docker=lambda args:command(['/usr/local/bin/docker','--host','unix://'+SOCKET,*args],180)
report={'test':TAG,'image':IMAGE};service=None;m=None


def auth():
    token=secrets.token_hex(32)
    return token


try:
    TARGET.mkdir(parents=True)
    for folder in ['openclaw','workspace','auth']:(TARGET/folder).mkdir()
    (TARGET/'openclaw/openclaw.json').write_text('{}')
    (TARGET/'auth/fixture').write_text('private fixture')
    (TARGET/'workspace/link').symlink_to('../auth/fixture')
    (TARGET/'workspace/remember').write_text('preserve me')
    record={'id':TAG,'name':'isolated APFS fixture','containerName':WRITER,'gatewayToken':'test-fixture','port':19998,'containerId':None}
    write(TARGET/'instance.json',record)
    for folder,dirs,files in os.walk(HOME):
        os.chown(folder,501,20)
        for n in files:os.lchown(Path(folder)/n,501,20)
    m=Migration(ROOT,TAG)
    m.prepare(256*1024**2);m.switch();m.commit();report['migrationAndLinkCopyVerified']=True
    VOLUME=Path(m.journal()['volumePath']);TARGET=VOLUME
    for attempt in range(30):
        try:
            writer=docker(['run','-d','--name',WRITER,'--network','none','--read-only','--user','501:20','--cap-drop','ALL',
                '--label','openclaw.managed=true','--label','openclaw.instance='+TAG,'--label','openclaw.storage.test=true',
                '--mount','type=bind,source='+str(TARGET/'workspace')+',target=/data,consistency=consistent',
                '--entrypoint','node',IMAGE,'-e','setInterval(()=>{},1000)']).decode().strip()
            break
        except Exception as e:
            if 'not a directory' not in str(e) or attempt==29:raise
            try:docker(['rm','-f',WRITER])
            except Exception:pass
            time.sleep(1)
    record['containerId']=writer;write(TARGET/'instance.json',record);os.chown(TARGET/'instance.json',501,20)
    # Fill beyond the volume cap while no Manager is running. fsync detects
    # delayed allocation errors; zeros are real writes, not truncate/sparse data.
    fill="const f=require('fs');let fd=f.openSync('/data/fill','w'),bytes=0;try{for(let i=0;i<600;i++){f.writeSync(fd,Buffer.alloc(1024*1024,91));f.fsyncSync(fd);bytes+=1024*1024;}console.log(JSON.stringify({bytes,error:null}));}catch(e){console.log(JSON.stringify({bytes,error:e.code}));}finally{try{f.closeSync(fd);}catch{}}"
    filled=json.loads(docker(['exec',WRITER,'node','-e',fill]));assert filled['error'] in ['ENOSPC','EDQUOT'],filled
    assert filled['bytes']<300*1024**2,filled
    report['kernelHardLimitWithoutManager']=filled
    print(json.dumps({'kernelHardLimitWithoutManager':filled}),flush=True)
    docker(['exec',WRITER,'node','-e',"require('fs').unlinkSync('/data/fill')"])
    quota=Backend(ROOT).status(TAG);assert quota['verified']
    token=auth();control=HOME/'control'
    from quota_host_service import QuotaService
    # Initialize permissions before the separate service takes its lock.
    init=QuotaService(ROOT,control,20);init.pool.shutdown()
    service=subprocess.Popen([sys.executable,'-B',str(Path(__file__).resolve().parent.parent/'scripts/quota_host_service.py'),
                              '--root',str(ROOT),'--control',str(control),'--gid','20'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    docker(['run','-d','--name',MANAGER,'--read-only','--tmpfs','/tmp:mode=1777','--user','501:20','--group-add','0','--cap-drop','ALL',
        '--label','openclaw.storage.test=true','-p',f'127.0.0.1:{PORT}:{PORT}',
        '-e',f'MANAGER_PORT={PORT}','-e','MANAGER_AUTH_TOKEN='+token,'-e','OPENCLAW_DATA_DIR='+str(ROOT),
        '-e','OPENCLAW_STARTUP_HOME='+str(HOME/'data'),'-e','OPENCLAW_QUOTA_CONTROL_DIR=/run/quota-test',
        '-e','OPENCLAW_BACKUP_DIR='+str(HOME/'backups'),
        '--mount','type=bind,source='+str(HOME)+',target='+str(HOME)+',consistency=consistent',
        '--mount','type=bind,source='+str(VOLUME)+',target='+str(VOLUME)+',consistency=consistent',
        '--mount','type=bind,source='+str(control)+',target=/run/quota-test,consistency=consistent',
        '-v',SOCKET+':/var/run/docker.sock',IMAGE])
    http=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    base=f'http://127.0.0.1:{PORT}'
    for _ in range(60):
        try:
            with http.open(urllib.request.Request(base+'/api/session',headers={'Authorization':'Bearer '+token}),timeout=3) as r:csrf=json.load(r)['csrf']
            break
        except OSError:time.sleep(.5)
    else:raise RuntimeError('test Manager unavailable')
    def get(path):
        with http.open(base+path,timeout=20) as r:return json.load(r)
    status=get('/api/instances/'+TAG+'/storage');assert status['hardQuota'] and status['enforcement']=='apfs-volume',status
    report['signedHostRPCAndManagerViewVerified']=True
    check="const s=require('./src/instances'),d=require('./src/docker');const r=s.loadInstance("+json.dumps(TAG)+");d.inspectContainer(r.containerId).then(c=>console.log(JSON.stringify({containerId:r.containerId,running:c.State.Running,socket:d.docker.modem.socketPath}))).catch(e=>{console.log(JSON.stringify({containerId:r.containerId,error:e.message,socket:d.docker.modem.socketPath}));});"
    print(docker(['exec',MANAGER,'node','-e',check]).decode(),flush=True)
    # A real write above admission/stop thresholds, then test new-job rejection
    # and wait for the real Docker stop and durable lock.
    try:docker(['exec',WRITER,'node','-e',"const f=require('fs'),fd=f.openSync('/data/nearfull','w');for(let i=0;i<245;i++)f.writeSync(fd,Buffer.alloc(1024*1024,88));f.fsyncSync(fd);f.closeSync(fd);"])
    except Exception as e:
        if 'ENOSPC' not in str(e) and 'EDQUOT' not in str(e):raise
    request=urllib.request.Request(base+'/api/instances/'+TAG+'/chat/stream',method='POST',data=b'{"message":"must not dispatch"}',headers={'Content-Type':'application/json','X-CSRF-Token':csrf})
    try:http.open(request,timeout=15);raise AssertionError('admitted over quota')
    except urllib.error.HTTPError as e:
        assert e.code==507,e.code;assert json.load(e)['retryable'] is False
    for _ in range(70):
        stopped=not json.loads(docker(['inspect',WRITER]))[0]['State']['Running']
        if stopped:break
        time.sleep(.5)
    if not stopped:
        print(json.dumps({'guardDiagnostic':get('/api/instances/'+TAG+'/storage')}),flush=True)
        print(docker(['exec',MANAGER,'node','-e',"console.log(JSON.stringify(require('./src/instances').listInstanceIds()))"]).decode(),flush=True)
    assert stopped,'guard did not stop fixture'
    status=get('/api/instances/'+TAG+'/storage');assert status['blocked'] and status['drain']['phase']=='stopped',status
    assert json.loads(docker(['inspect',WRITER]))[0]['HostConfig']['RestartPolicy']['Name']=='no'
    report['nonretryable507AndActualProtectedStop']=True
    docker(['rm','-f',MANAGER]);docker(['rm','-f',WRITER])
    service.terminate();service.wait(timeout=10);service=None
    # Test no-mount rejection and UUID-based remount before rollback.
    uuid=m.journal()['volumeUUID'];command(['/usr/sbin/diskutil','unmount','force',uuid])
    try:Backend(ROOT).status(TAG);raise AssertionError('unmounted path accepted')
    except Exception as e:
        if isinstance(e,AssertionError):raise
    report['unmountedStartVerificationRejected']=True
    reconcile(ROOT);assert Backend(ROOT).status(TAG)['verified']
    report['registeredUUIDRemountVerified']=True
    # Rollback retains the new volume (and nearfull data); original stays exact.
    expected=json.loads((m.home/'manifest.json').read_text())
    command(['/usr/sbin/diskutil','unmount','force',uuid]);m.rollback(True)
    assert manifest(ROOT/TAG)==expected
    report['rollbackOriginalContentLinksAndPermissionsVerified']=True
    print(json.dumps(report),flush=True)
finally:
    for name in [MANAGER,WRITER]:
        try:docker(['rm','-f',name])
        except Exception:pass
    if service:
        service.terminate()
        try:service.wait(timeout=10)
        except subprocess.TimeoutExpired:service.kill()
    if m and m.file.exists():
        j=m.journal()
        if j.get('volumeUUID'):
            # Only the unique test volume created by this run may be removed.
            _,v=find_volume(j['volumeUUID'])
            assert v['Name']=='oc-'+TAG and TAG.startswith('apfs-test-')
            if info(v['DeviceIdentifier']).get('MountPoint'):
                command(['/usr/sbin/diskutil','unmount','force',j['volumeUUID']])
            command(['/usr/sbin/diskutil','apfs','deleteVolume',j['volumeUUID']])
        if m.registry.exists():m.registry.unlink()
        staging=Path(j['staging'])
        if staging.exists() and not any(staging.iterdir()):staging.rmdir()
        shutil.rmtree(m.home)
    if HOME.exists():shutil.rmtree(HOME)
