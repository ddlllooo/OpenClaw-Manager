import contextlib,hashlib,json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
import startup_recovery as s
from apfs_recovery import Recovery,Waiting


class Crash(BaseException):pass


class FakeHost:
    def __init__(self,root):
        self.home=root;self.data=root/'instances';self.data.mkdir();self.test_mode=True
        self.config={'apfsAutoRecovery':True};self.containers={};self.rows=[];self.calls=[];self.online=True;self.fail=False;self.crash=None
    def available(self):return self.online
    def inspect(self,id):return self.containers.get(id)
    def docker_cmd(self,args,timeout=12):
        self.calls.append(args)
        if args[0]=='start':
            if self.crash=='before':raise Crash()
            if self.fail:raise s.RecoveryError('synthetic Docker start failure')
            self.containers[args[1]]['State'].update(Running=True,Status='running')
            if self.crash=='after':raise Crash()
        elif args[0]=='stop':self.containers[args[-1]]['State'].update(Running=False,Status='exited')
        else:raise AssertionError(args)


class Supervisor(s.Supervisor):
    def records(self):return self.host.rows
    @contextlib.contextmanager
    def lock(self):yield


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve()
        self.host=FakeHost(self.root);self.s=Supervisor(self.host);self.boot='boot-a';self.now=1000;self.wait=False;self.probes=[]
        self.r=Recovery(self.s,boot=lambda:self.boot,quota=self.quota,probe=self.probe,clock=lambda:self.now);self.s._apfs_recovery=self.r
        self.settings=json.loads(json.dumps(s.DEFAULTS));self.quotas={}
    def probe(self,row,q):self.probes.append(row['id'])
    def quota(self,id,full):
        if self.wait:raise Waiting('waiting for mount')
        return dict(self.quotas[id])
    def record(self,id='fixture',running=True):
        cid=hashlib.sha256(id.encode()).hexdigest();root=self.root/'volumes'/id
        for folder in ['openclaw','workspace','auth']:(root/folder).mkdir(parents=True)
        (root/'openclaw/openclaw.json').write_text('{}')
        row={'id':id,'name':id,'containerId':cid,'containerName':'openclaw-'+id,'port':19001};self.host.rows.append(row)
        self.host.containers[cid]={'Id':cid,'Name':'/openclaw-'+id,'Config':{'Labels':{'openclaw.managed':'true','openclaw.instance':id}},
            'HostConfig':{'RestartPolicy':{'Name':'no'}},'State':{'Running':running,'Status':'running' if running else 'exited'},
            'Mounts':[{'Type':'bind','RW':True,'Source':str(root/folder),'Destination':target} for folder,target in [('openclaw','/home/node/.openclaw'),('workspace','/home/node/.openclaw/workspace'),('auth','/home/node/.config/openclaw')]]}
        quota={'verified':True,'backend':'apfs-volume','volumeUUID':'uuid-'+id,'mountpoint':str(root),'hardBytes':1024**3,'usedBytes':1024,'filesystemAvailable':20*1024**3}
        self.quotas[id]=quota
        self.write_storage(id,{'policy':{'mode':'hard','limitGiB':1,'minFreeGiB':1,'admissionPercent':90},'hard':{'backend':'apfs-volume','phase':'verified','volumeUUID':quota['volumeUUID'],'hardBytes':quota['hardBytes']}})
        return row
    def write_storage(self,id,v):
        folder=self.root/'storage';folder.mkdir(exist_ok=True);(folder/(id+'.json')).write_text(json.dumps(v))
    def run_recovery(self):return self.r.run(self.settings)
    def reboot(self):
        for c in self.host.containers.values():c['State'].update(Running=False,Status='exited')
        self.boot='boot-b'
    def starts(self):return [a for a in self.host.calls if a[0]=='start']

    def test_only_confirmed_running_instances_restore_after_new_host_boot(self):
        running=self.record();self.record('manual-stopped',False);self.run_recovery();self.reboot();self.run_recovery()
        self.assertEqual(self.starts(),[['start',running['containerId']]])
        self.assertEqual(self.probes,['fixture']);self.assertEqual(self.r.load()['entries']['fixture']['observedBoot'],'boot-b')
    def test_same_boot_service_restart_and_docker_restart_never_start_stopped(self):
        self.record();self.run_recovery();self.reboot();self.boot='boot-a'
        self.r=Recovery(self.s,boot=lambda:self.boot,quota=self.quota,probe=self.probe);self.run_recovery();self.boot='boot-b';self.run_recovery()
        self.assertEqual(self.starts(),[])
    def test_stop_intent_survives_shutdown_before_docker_stop_ack(self):
        self.record();self.run_recovery();self.r.intent({'id':'fixture','action':'stop','reason':'manual'})
        self.reboot();self.run_recovery();self.assertEqual(self.starts(),[]);self.assertTrue(self.r.inhibited('fixture'))
    def test_storage_stop_and_release_do_not_make_instance_boot_eligible(self):
        self.record();self.run_recovery();v=self.r.storage('fixture');v['blocked']={'reason':'full'};self.write_storage('fixture',v)
        self.reboot();self.run_recovery();v.pop('blocked');self.write_storage('fixture',v);self.run_recovery()
        self.assertEqual(self.starts(),[]);self.assertEqual(self.r.load()['entries']['fixture']['desired'],'stopped')
    def test_all_storage_latches_and_unverified_quota_block_boot_restore(self):
        for key in ['blocked','drain','migration','recovery','phase']:
            with self.subTest(key=key):
                self.setUp();self.record();self.run_recovery();v=self.r.storage('fixture')
                if key=='phase':v['hard']['phase']='failed'
                else:v[key]={'reason':'locked'}
                self.write_storage('fixture',v);self.reboot();self.run_recovery();self.assertEqual(self.starts(),[])
    def test_unmounted_volume_waits_and_recovers_once_after_mount_ready(self):
        self.record();self.run_recovery();self.reboot();self.wait=True;self.assertEqual(self.run_recovery()[0]['phase'],'waiting')
        self.assertEqual(self.starts(),[]);self.wait=False;self.run_recovery();self.run_recovery();self.assertEqual(len(self.starts()),1)
    def test_docker_unavailable_does_not_consume_or_revoke_boot_checkpoint(self):
        self.record();self.run_recovery();self.reboot();self.host.online=False;self.run_recovery();self.assertEqual(self.starts(),[])
        self.host.online=True;self.run_recovery();self.assertEqual(len(self.starts()),1)
    def test_quota_usage_and_host_reserve_prevent_start(self):
        self.record();self.run_recovery();self.reboot();self.quotas['fixture']['usedBytes']=1024**3
        self.run_recovery();self.assertEqual(self.starts(),[])
    def test_paused_instances_are_not_adopted_as_recoverable_running(self):
        row=self.record();self.host.containers[row['containerId']]['State']['Paused']=True
        self.run_recovery();self.reboot();self.host.containers[row['containerId']]['State']['Paused']=False
        self.run_recovery();self.assertEqual(self.starts(),[])
    def test_host_free_space_reserve_blocks_restore(self):
        self.record();self.run_recovery();self.reboot();self.quotas['fixture']['filesystemAvailable']=0
        self.run_recovery();self.assertEqual(self.starts(),[])
    def test_global_disable_does_not_backfill_when_enabled_later(self):
        self.record();self.run_recovery();self.reboot();self.settings['instancesAutoStart']=False;self.run_recovery()
        self.settings['instancesAutoStart']=True;self.run_recovery();self.assertEqual(self.starts(),[])
    def test_wrong_uuid_quota_mount_and_container_identity_fail_closed(self):
        for kind in ['uuid','quota','mount','identity']:
            with self.subTest(kind=kind):
                self.setUp();row=self.record();self.run_recovery();self.reboot()
                if kind=='uuid':self.quotas['fixture']['volumeUUID']='wrong'
                elif kind=='quota':self.quotas['fixture']['hardBytes']*=2
                elif kind=='mount':self.host.containers[row['containerId']]['Mounts'][0]['Source']='/wrong'
                else:self.host.containers[row['containerId']]['Config']['Labels']['openclaw.instance']='other'
                self.run_recovery();self.assertEqual(self.starts(),[])
    def test_missing_primary_is_not_recreated_or_replaced_by_rollback_container(self):
        self.record();self.run_recovery();self.reboot();self.host.containers.clear();self.run_recovery();self.assertEqual(self.host.calls,[])
    def test_disabled_global_or_instance_switch_never_backfills_later(self):
        self.record();self.run_recovery();self.reboot();self.settings['instanceOverrides']['fixture']=False;self.run_recovery()
        self.settings['instanceOverrides']['fixture']=True;self.run_recovery();self.assertEqual(self.starts(),[])
    def test_start_failure_is_persisted_and_never_retried_same_boot(self):
        self.record();self.run_recovery();self.reboot();self.host.fail=True;self.run_recovery();self.host.fail=False;self.run_recovery();self.assertEqual(len(self.starts()),1)
    def test_crash_after_recording_attempt_does_not_issue_second_start(self):
        self.record();self.run_recovery();self.reboot();self.host.crash='before'
        with self.assertRaises(Crash):self.run_recovery()
        self.host.crash=None;self.run_recovery();self.assertEqual(len(self.starts()),1)
    def test_crash_after_actual_start_confirms_running_without_replay(self):
        self.record();self.run_recovery();self.reboot();self.host.crash='after'
        with self.assertRaises(Crash):self.run_recovery()
        self.host.crash=None;self.run_recovery();self.assertEqual(len(self.starts()),1)
        self.assertEqual(self.r.load()['entries']['fixture']['phase'],'running')
    def test_stop_during_readonly_probe_wins_over_pending_auto_start(self):
        self.record();self.run_recovery();self.reboot();self.r.probe=lambda *_:self.r.inhibit('fixture','manual')
        self.run_recovery();self.assertEqual(self.starts(),[])
    def test_explicit_start_commit_is_only_way_to_rearm_manual_stop(self):
        row=self.record(running=False)
        self.run_recovery();self.r.intent({'id':'fixture','action':'stop','reason':'manual'})
        token=self.r.intent({'id':'fixture','action':'prepare'})['token']
        self.host.containers[row['containerId']]['State'].update(Running=True,Status='running')
        self.r.intent({'id':'fixture','action':'commit','token':token,'containerId':row['containerId']})
        self.reboot();self.run_recovery();self.assertEqual(len(self.starts()),1)
    def test_stale_start_commit_cannot_erase_later_manual_stop(self):
        row=self.record();self.run_recovery();token=self.r.intent({'id':'fixture','action':'prepare'})['token']
        self.r.intent({'id':'fixture','action':'stop','reason':'manual'})
        with self.assertRaises(s.RecoveryError):self.r.intent({'id':'fixture','action':'commit','token':token,'containerId':row['containerId']})
        self.assertTrue(self.r.inhibited('fixture'))
    def test_corrupt_ledger_is_preserved_and_does_not_start(self):
        self.record();self.run_recovery();self.reboot();self.r.file.write_text('{broken')
        with self.assertRaises(Exception):self.run_recovery()
        self.assertEqual(self.starts(),[]);self.assertEqual(self.r.file.read_text(),'{broken')
    def test_missing_backend_field_never_falls_back_to_docker_autostart(self):
        self.record();self.run_recovery();state=self.r.storage('fixture');state['hard'].pop('backend');self.write_storage('fixture',state)
        self.assertEqual(self.s.storage_policy(self.settings,'fixture'),'no')
        self.reboot();self.run_recovery();self.assertEqual(self.starts(),[])
    def test_missing_policy_keeps_registered_checkpoint_ineligible(self):
        self.record();self.run_recovery();(self.root/'storage/fixture.json').unlink()
        self.assertEqual(self.s.storage_policy(self.settings,'fixture'),'no')
        self.reboot();self.run_recovery();self.assertEqual(self.starts(),[])
    def test_shutdown_freeze_preserves_prior_running_checkpoint(self):
        self.record();self.run_recovery();self.r.shutting_down=True
        self.reboot();self.boot='boot-a';self.run_recovery();self.r.shutting_down=False;self.boot='boot-b';self.run_recovery()
        self.assertEqual(len(self.starts()),1)


if __name__=='__main__':unittest.main(verbosity=2)
