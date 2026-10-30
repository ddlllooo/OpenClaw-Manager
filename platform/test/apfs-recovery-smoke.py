#!/usr/bin/env python3
"""Real Docker boot-recovery flow in isolated fixture directories.

Boot IDs and quota readings are injected by this test only. No production data
is mounted, and no host/engine reboot is performed. Existing APFS kernel quota
tests separately validate the filesystem limit; this tests actual start/stop,
mount marker probes, durable intent and one-start-per-boot behavior.
"""
import contextlib,json,os,secrets,shutil,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
import startup_recovery as s
from apfs_recovery import Recovery,Waiting

image=sys.argv[1];tag='recovery-test-'+secrets.token_hex(4)
home=Path('/Users/livzon/openclaw-recovery-tests')/tag
home.mkdir(parents=True);data=home/'instances';data.mkdir()
class Host(s.Host):
    def __init__(self):
        super().__init__(home, data,home,True);self.config={'apfsAutoRecovery':True};self.commands=[]
    def manager_info(self):return self.inspect('openclaw-manager')
    def docker_cmd(self,args,timeout=12):
        if args[0] in ['start','stop']:self.commands.append(args)
        return super().docker_cmd(args,timeout)
class Supervisor(s.Supervisor):
    # Fixture directories are regular host folders, not production APFS paths.
    def records(self):return [json.loads(p.read_text()) for p in data.glob('*/instance.json')]

host=Host();supervisor=Supervisor(host);boot=['isolated-boot-a'];quota={};waiting=[False];names=[];report={}
def fake_quota(id,full):
    if waiting[0]:raise Waiting('fixture mount not ready')
    return dict(quota[id])
recovery=Recovery(supervisor,boot=lambda:boot[0],quota=fake_quota);supervisor._apfs_recovery=recovery
settings=json.loads(json.dumps(s.DEFAULTS))
try:
    for role in ['running','manual','protected']:
        id=tag+'-'+role;folder=data/id
        for n in ['openclaw','workspace','auth']:(folder/n).mkdir(parents=True)
        uuid='fixture-uuid-'+role
        for n in ['', 'openclaw','workspace','auth']:(folder/n/'.openclaw-volume-id').write_text(uuid)
        (folder/'openclaw/openclaw.json').write_text('{}')
        name='openclaw-'+id;names.append(name)
        args=['create','--name',name,'--pull','never','--network','none','--read-only','--restart','no','--user','501:20','--cap-drop','ALL',
              '--label','openclaw.managed=true','--label','openclaw.instance='+id,'--label','openclaw.recovery.test=true']
        for n,t in [('openclaw','/home/node/.openclaw'),('workspace','/home/node/.openclaw/workspace'),('auth','/home/node/.config/openclaw')]:
            args+=['--mount','type=bind,source='+str(folder/n)+',target='+t+',consistency=consistent']
        cid=host.docker_cmd([*args,'--entrypoint','node',image,'-e','setInterval(()=>{},1000)'],30).strip()
        row={'id':id,'containerId':cid,'name':role,'containerName':name,'port':19999}
        (folder/'instance.json').write_text(json.dumps(row))
        quota[id]={'verified':True,'backend':'apfs-volume','volumeUUID':uuid,'hardBytes':1024**3,'usedBytes':1024,'filesystemAvailable':20*1024**3,'mountpoint':str(folder)}
        (home/'storage').mkdir(exist_ok=True)
        (home/'storage'/(id+'.json')).write_text(json.dumps({'policy':{'mode':'hard','limitGiB':1,'minFreeGiB':0},'hard':{'phase':'verified','backend':'apfs-volume','hardBytes':1024**3,'volumeUUID':uuid}}))
        host.docker_cmd(['start',cid],30)
    with supervisor.lock():recovery.run(settings)
    manual=tag+'-manual';protected=tag+'-protected';running=tag+'-running'
    # Persist a manual stop before the engine acknowledges it.
    with supervisor.lock():recovery.intent({'id':manual,'action':'stop','reason':'manual'})
    for row in supervisor.records():host.docker_cmd(['stop','-t','2',row['containerId']],10)
    state=json.loads((home/'storage'/(protected+'.json')).read_text());state['blocked']={'reason':'fixture full'}
    (home/'storage'/(protected+'.json')).write_text(json.dumps(state))
    boot[0]='isolated-boot-b';waiting[0]=True;host.commands.clear()
    with supervisor.lock():recovery.run(settings)
    assert not [c for c in host.commands if c[0]=='start']
    waiting[0]=False
    # Recreate the observer to prove its state comes from disk, not memory.
    recovery=Recovery(supervisor,boot=lambda:boot[0],quota=fake_quota);supervisor._apfs_recovery=recovery
    with supervisor.lock():recovery.run(settings)
    with supervisor.lock():recovery.run(settings)
    rows={r['id']:r for r in supervisor.records()}
    starts=[c for c in host.commands if c[0]=='start'];assert starts==[['start',rows[running]['containerId']]],starts
    assert host.inspect(rows[running]['containerId'])['State']['Running']
    assert not host.inspect(rows[manual]['containerId'])['State']['Running']
    assert not host.inspect(rows[protected]['containerId'])['State']['Running']
    # A later stop within the same boot must remain stopped after observer restart.
    host.docker_cmd(['stop','-t','2',rows[running]['containerId']],10)
    with supervisor.lock():recovery.run(settings)
    boot[0]='isolated-boot-c'
    with supervisor.lock():recovery.run(settings)
    assert len([c for c in host.commands if c[0]=='start'])==1
    report={'realDockerRestoreOnce':True,'mountNotReadyWaits':True,'manualStopPreserved':True,'storageProtectedNeverStarted':True,
            'observerRestartResumesFromDisk':True,'externalStopObservedAndNotRevived':True,'readOnlyGuestMarkerProbe':True,
            'hostOrDockerRebootPerformed':False,'productionDataMounted':False}
    print(json.dumps(report),flush=True)
finally:
    for name in names:
        try:host.docker_cmd(['rm','-f',name],20)
        except Exception:pass
    assert home.parent==Path('/Users/livzon/openclaw-recovery-tests') and home.name==tag
    shutil.rmtree(home)
