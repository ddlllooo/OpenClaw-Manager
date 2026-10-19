import base64,hashlib,hmac,importlib.util,json,sys,tempfile,time,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
import manager_host_service as m
class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);root=Path(self.temp.name);(root/'instances').mkdir()
        self.s=m.Service({'root':str(root),'instances':str(root/'instances'),'startupHome':str(root),'testMode':True,'dockerSocket':'/isolated.sock','managerPort':18081,'managerContainer':'openclaw-manager-test-protocol','deployment':'isolated','serviceLabel':'com.openclaw.manager.test.protocol','controlDirectory':str(root/'control'),'backupDirectory':str(root/'backups')})
        self.addCleanup(self.s.pool.shutdown)
    def request(self,id='a'*32,action='port-free',body=None,age=0,key=None):
        raw=base64.b64encode(json.dumps({'id':id,'issuedAt':time.time()-age,'deadline':time.time()+30-age,'action':action,'body':body or {'port':19001}}).encode()).decode()
        file=self.s.control/'requests'/(id+'.json');file.write_text(json.dumps({'payload':raw,'signature':hmac.new((key or self.s.key).encode(),raw.encode(),hashlib.sha256).hexdigest()}));self.s.handle(file)
        envelope=json.loads((self.s.control/'responses'/(id+'.json')).read_text());self.assertTrue(hmac.compare_digest(envelope['signature'],hmac.new(self.s.key.encode(),envelope['payload'].encode(),hashlib.sha256).hexdigest()))
        return json.loads(base64.b64decode(envelope['payload']))
    def test_signed_request_uses_fixed_action_and_signed_response(self):self.assertIn('free',self.request()['result'])
    def test_forged_request_never_dispatches(self):
        self.s.dispatch=lambda *_:self.fail('forged request dispatched');self.assertEqual(self.request(key='b'*64)['status'],403)
    def test_expired_and_replayed_requests_never_execute(self):
        self.assertEqual(self.request(age=200)['status'],409);calls=[];self.s.dispatch=lambda *_:calls.append(1) or {'ok':True}
        self.request(id='b'*32);self.assertEqual(self.request(id='b'*32)['status'],409);self.assertEqual(calls,[1])
    def test_arbitrary_host_commands_are_rejected(self):self.assertIn('error',self.request(action='exec'))
    def test_manager_ownership_mismatch_is_not_repaired_or_started(self):
        self.s.host.inspect=lambda _: {'Config':{'Labels':{'openclaw.manager':'true','openclaw.deployment':'another-project'}}}
        with self.assertRaises(m.RecoveryError):self.s.host.manager_info()
    def test_desktop_login_switch_is_namespaced_in_test_mode(self):
        self.assertIn('.test.',self.s.host.docker_label);self.assertNotEqual(self.s.host.docker_label,'com.docker.helper')
    def test_migration_plan_keeps_archives_and_missing_instances_stopped(self):
        import prepare_backend_migration as migration
        from startup_recovery import DEFAULTS
        root=Path(self.temp.name);(root/'startup-settings.json').write_text(json.dumps(DEFAULTS))
        for name in ['fixture','old.kept']:
            p=root/'instances'/name;p.mkdir();(p/'instance.json').write_text(json.dumps({'id':name.replace('.kept',''),'containerId':None,'containerName':'openclaw-fixture'}))
        result=migration.prepare(root/'instances','/not-accessed.sock',root/'plan');plan=json.loads((root/'plan/migration-plan.json').read_text())
        self.assertEqual(result['keepStoppedCount'],1);self.assertEqual(plan['startOnlyTheseIds'],[]);self.assertEqual(plan['keepStoppedIds'],['fixture']);self.assertTrue((root/'instances/old.kept/instance.json').exists())
if __name__=='__main__':unittest.main(verbosity=2)
