import contextlib, importlib.util, json, os, plistlib, tempfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('startup_recovery',Path(__file__).resolve().parent.parent/'scripts/startup_recovery.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class FakeHost:
    def __init__(self,path):
        self.home=Path(path);self.data=self.home/'instances';self.data.mkdir();self.agent_dir=self.home/'agents'
        self.worker_label='fake.worker';self.test_mode=True;self.online=True;self.opened=0;self.gui=True;self.desktop=False;self.actions=[];self.containers={};self.fail_update=None;self.host_settings=None
    def environment(self):return dict(nodeInstalled=True,dockerCLIInstalled=True,dockerDesktopInstalled=True,dataDirectoryWritable=True)
    def available(self):return self.online
    def inspect(self,id):return self.containers.get(id)
    def set_policy(self,id,name):
        self.actions.append(('policy',id,name))
        if id==self.fail_update:raise m.RecoveryError('synthetic update failure')
        self.containers[id]['HostConfig']['RestartPolicy']['Name']=name
    def apply_host(self,previous,current,install=False):self.host_settings=current.copy()
    def ensure_manager(self):self.actions.append(('ensure-manager',))
    def gui_available(self):return self.gui
    def desktop_running(self):return self.desktop
    def open_docker(self):self.opened+=1
    def health(self,port):return port==19001
    def record(self,id='fixture',state='running',label=None):
        folder=self.data/id;(folder/'workspace').mkdir(parents=True);(folder/'openclaw').mkdir();(folder/'openclaw/openclaw.json').write_text('{}')
        cid=('a' if id=='fixture' else 'b')*64
        row={'id':id,'name':id,'containerId':cid,'containerName':'openclaw-'+id,'port':19001}
        (folder/'instance.json').write_text(json.dumps(row))
        self.containers[cid]={'Id':cid,'Name':'/openclaw-'+id,'Config':{'Labels':{'openclaw.managed':'true','openclaw.instance':label or id}},'HostConfig':{'RestartPolicy':{'Name':'unless-stopped'}},'State':{'Status':state,'Running':state=='running'}}
        return row
class Supervisor(m.Supervisor):
    @contextlib.contextmanager
    def lock(self):yield
class Tests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.host=FakeHost(self.temp.name);self.s=Supervisor(self.host)
    def save(self,**patch):return self.s.update({'revision':m.revision(self.s.settings()),**patch})
    def test_settings_revision_and_boolean_validation(self):
        self.host.record();self.save(managerAutoStart=False)
        with self.assertRaises(m.RecoveryError):self.s.update({'revision':'stale','dockerAutoLaunch':False})
        with self.assertRaises(m.RecoveryError):self.save(instancesAutoStart='false')
        self.assertFalse(self.s.settings()['managerAutoStart'])
    def test_unknown_instance_override_is_rejected(self):
        with self.assertRaises(m.RecoveryError):self.save(instanceOverrides={'business-not-in-this-data-root':False})
    def test_global_and_per_instance_policies_never_start_containers(self):
        a=self.host.record(state='exited');self.save(instancesAutoStart=False)
        self.assertEqual(self.host.containers[a['containerId']]['State']['Status'],'exited')
        self.save(instancesAutoStart=True,instanceOverrides={'fixture':False});self.assertEqual(m.policy(self.s.settings(),'fixture'),'no')
        self.save(instanceOverrides={'fixture':None});self.s.tick();self.assertEqual(self.host.containers[a['containerId']]['State']['Status'],'exited')
        self.assertTrue(all(action[0] in ['policy','ensure-manager'] for action in self.host.actions))
    def test_unavailable_engine_launch_is_throttled_then_probed_before_policy(self):
        row=self.host.record();self.host.online=False
        state=self.s.tick()['status'];self.assertEqual(state['phase'],'waiting-engine');self.assertEqual(self.host.opened,1)
        self.s.tick();self.assertEqual(self.host.opened,1);self.assertFalse(any(a[0]=='policy' for a in self.host.actions))
        self.host.online=True;self.assertEqual(self.s.tick()['status']['phase'],'ready')
    def test_docker_off_or_missing_gui_never_launches_desktop(self):
        self.host.online=False;self.save(dockerAutoLaunch=False);self.assertEqual(self.s.tick()['status']['phase'],'docker-offline');self.assertEqual(self.host.opened,0)
        self.save(dockerAutoLaunch=True);self.host.gui=False;self.assertEqual(self.s.tick()['status']['phase'],'waiting-login');self.assertEqual(self.host.opened,0)
    def test_running_backend_waits_without_repeated_open_or_kill(self):
        self.host.online=False;self.host.desktop=True;self.assertEqual(self.s.tick()['status']['phase'],'waiting-engine');self.assertEqual(self.host.opened,0)
    def test_manual_stopped_and_created_instances_remain_stopped(self):
        self.host.record(state='exited');self.host.record('created',state='created');state=self.s.tick()['status'];self.assertEqual([r['state'] for r in state['instances']],['created','exited']);self.assertTrue(all('保持停止' in r['detail'] for r in state['instances']))
    def test_wrong_ownership_is_never_modified(self):
        self.host.record(label='another-business');state=self.s.tick()['status'];self.assertEqual(state['phase'],'attention');self.assertFalse(any(a[0]=='policy' for a in self.host.actions))
    def test_missing_container_is_not_recreated_and_invalid_config_is_reported(self):
        row=self.host.record();self.host.containers.clear();self.assertEqual(self.s.tick()['status']['instances'][0]['state'],'missing')
        self.assertFalse(any(a[0]=='policy' for a in self.host.actions))
    def test_failed_policy_save_rolls_back_without_committing_settings(self):
        a=self.host.record();b=self.host.record('other');self.host.fail_update=b['containerId']
        with self.assertRaises(m.RecoveryError):self.save(instancesAutoStart=False)
        self.assertTrue(self.s.settings()['instancesAutoStart']);self.assertEqual(self.host.containers[a['containerId']]['HostConfig']['RestartPolicy']['Name'],'unless-stopped')
    def test_all_disabled_has_no_recovery_actions(self):
        self.save(managerAutoStart=False,dockerAutoLaunch=False,instancesAutoStart=False);self.host.actions=[];self.assertEqual(self.s.tick()['status']['phase'],'disabled');self.assertEqual(self.host.actions,[])
    def test_policy_change_while_docker_offline_is_rejected_before_any_change(self):
        row=self.host.record(state='exited');self.host.online=False
        with self.assertRaises(m.RecoveryError):self.save(managerAutoStart=False,dockerAutoLaunch=False,instancesAutoStart=False)
        self.assertTrue(self.s.settings()['instancesAutoStart']);self.assertIsNone(self.host.host_settings)
        self.save(managerAutoStart=False,dockerAutoLaunch=False)
        self.assertFalse(self.s.settings()['dockerAutoLaunch'])
        self.assertEqual(self.host.opened,0)
    def test_launchagent_manifest_and_test_namespace(self):
        host=m.Host(Path(self.temp.name)/'app',self.host.data,self.host.home,True)
        file,raw=host.worker_plist(True);d=plistlib.loads(raw);self.assertIn('.test.',d['Label']);self.assertTrue(d['RunAtLoad']);self.assertEqual(d['StartInterval'],20);self.assertEqual(d['EnvironmentVariables']['OPENCLAW_STARTUP_TEST_MODE'],'1')
        self.assertIn('test-launchagents',str(file))
        self.assertFalse(plistlib.loads(host.manager_plist(True)[1])['KeepAlive'])
    def test_secret_bearing_instance_records_are_not_exposed(self):
        row=self.host.record();file=self.host.data/'fixture/instance.json';row['gatewayToken']='private-gateway-value';file.write_text(json.dumps(row));self.assertNotIn('private-gateway-value',json.dumps(self.s.tick()))
if __name__=='__main__':unittest.main(verbosity=2)
