#!/usr/bin/env python3
"""User-session startup supervisor. Never starts/stops/recreates an instance.

Docker's unless-stopped policy owns container recovery and its persisted manual
stop flag. This process only reconciles restart policy and observes readiness.
"""
import concurrent.futures
import contextlib
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

DEFAULTS = {'managerAutoStart': True, 'dockerAutoLaunch': True, 'instancesAutoStart': True, 'instanceOverrides': {}}
ID_RE = re.compile(r'^[a-z0-9_-]{1,80}$', re.I)

class RecoveryError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

def atomic(file, data):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if file.is_symlink():
        raise RecoveryError('启动配置文件不能是符号链接')
    fd, name = tempfile.mkstemp(prefix='.'+file.name+'-', dir=str(file.parent))
    try:
        with os.fdopen(fd, 'wb') as target:
            if hasattr(os, 'fchmod'): os.fchmod(target.fileno(), 0o600)
            else: os.chmod(name, 0o600)
            target.write(data if isinstance(data, bytes) else data.encode('utf8'))
            target.flush()
            os.fsync(target.fileno())
        os.replace(name, file)
    finally:
        if os.path.exists(name): os.unlink(name)

def json_file(file, default):
    if not file.exists(): return default
    if file.is_symlink() or file.stat().st_size > 2*1024*1024:
        raise RecoveryError('启动配置文件不合法')
    return json.loads(file.read_text(encoding='utf8'))

def revision(settings):
    return hashlib.sha256(json.dumps(settings, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def policy(settings, id):
    return 'unless-stopped' if settings['instancesAutoStart'] and settings['instanceOverrides'].get(id, True) else 'no'

def patch_settings(current, body, ids):
    if not isinstance(body, dict): raise RecoveryError('设置必须是对象')
    if body.get('revision') != revision(current): raise RecoveryError('启动设置已变化，请刷新后保存', 409)
    if set(body) - set(DEFAULTS) - {'revision'}: raise RecoveryError('包含不支持的启动设置')
    result = json.loads(json.dumps(current))
    for key in ['managerAutoStart', 'dockerAutoLaunch', 'instancesAutoStart']:
        if key in body:
            if not isinstance(body[key], bool): raise RecoveryError('启动开关必须为布尔值')
            result[key] = body[key]
    if 'instanceOverrides' in body:
        if not isinstance(body['instanceOverrides'], dict): raise RecoveryError('实例开关不合法')
        for id, value in body['instanceOverrides'].items():
            if id not in ids: raise RecoveryError('实例不存在或已移除', 409)
            if value is None: result['instanceOverrides'].pop(id, None)
            elif isinstance(value, bool): result['instanceOverrides'][id] = value
            else: raise RecoveryError('实例开关必须为布尔值')
    return result

class Host:
    def __init__(self, root, data, home, test_mode=False):
        self.root, self.data, self.home = Path(root).resolve(), Path(data).resolve(), Path(home).resolve()
        self.test_mode = test_mode
        if test_mode and self.data == self.root/'data/instances': raise RecoveryError('测试模式禁止使用生产数据目录')
        tag = hashlib.sha256(str(self.data).encode()).hexdigest()[:10]
        prefix = 'com.openclaw.manager.test.'+tag if test_mode else 'com.openclaw.manager'
        self.manager_label, self.worker_label = prefix+'.web', prefix+'.recovery'
        self.docker_label = prefix+'.docker-login' if test_mode else 'com.docker.helper'
        self.agent_dir = self.home/'test-launchagents' if test_mode else Path.home()/'Library/LaunchAgents'
        self.docker = os.environ.get('STARTUP_DOCKER_BIN', '/usr/local/bin/docker')
        self.node = os.environ.get('STARTUP_NODE_BIN', '/usr/local/bin/node')
        self.socket = os.environ.get('DOCKER_SOCKET', str(Path.home()/'.docker/run/docker.sock'))
        self.port = int(os.environ.get('MANAGER_PORT', '18080'))
        self.domain = 'gui/'+str(os.getuid()) if hasattr(os, 'getuid') else ''
        self.desktop = Path('/Applications/Docker.app')

    def run(self, args, timeout=10, check=True):
        try:
            p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise RecoveryError('执行检查失败：'+str(e)[:350], 503)
        if check and p.returncode:
            raise RecoveryError((p.stderr or p.stdout or '系统命令失败').strip()[:600], 503)
        return p

    def docker_cmd(self, args, timeout=12):
        return self.run([self.docker, '--host', 'unix://'+self.socket, *args], timeout).stdout

    def available(self):
        try: self.docker_cmd(['info', '--format', '{{.ServerVersion}}'], 6); return True
        except RecoveryError: return False

    def inspect(self, id):
        try: return json.loads(self.docker_cmd(['inspect', id]))[0]
        except RecoveryError as e:
            if 'No such' in str(e) or 'not found' in str(e): return None
            raise

    def set_policy(self, id, name):
        if not re.fullmatch(r'(?:no|unless-stopped|always|on-failure(?::\d{1,6})?)',name): raise RecoveryError('不合法的容器恢复策略')
        self.docker_cmd(['update', '--restart='+name, id])

    def environment(self):
        return {'platform': sys.platform, 'nodeInstalled': os.path.isfile(self.node) and os.access(self.node, os.X_OK),
                'dockerCLIInstalled': os.path.isfile(self.docker) and os.access(self.docker, os.X_OK),
                'dockerDesktopInstalled': self.desktop.exists(), 'dataDirectoryWritable': os.access(self.home, os.W_OK),
                'loginRequired': True, 'isolatedTest': self.test_mode}

    def gui_available(self):
        return sys.platform == 'darwin' and self.run(['/bin/launchctl','print',self.domain], check=False).returncode == 0

    def desktop_running(self):
        return self.run(['/usr/bin/pgrep','-f','^/Applications/Docker.app/Contents/MacOS/com.docker.backend'], check=False).returncode == 0

    def open_docker(self):
        if self.test_mode: raise RecoveryError('测试环境禁止拉起宿主 Docker Desktop')
        self.run(['/usr/bin/open','-gj','-a',str(self.desktop)])

    def service(self, label):
        p = self.run(['/bin/launchctl','print',self.domain+'/'+label], check=False)
        disabled = self.run(['/bin/launchctl','print-disabled',self.domain], check=False).stdout
        match = re.search('"'+re.escape(label)+'"\\s*=>\\s*(disabled|enabled)', disabled)
        return {'loaded': p.returncode == 0, 'running': bool(re.search(r'^\s*state = running\s*$',p.stdout,re.M)),
                'disabled': bool(match and match.group(1) == 'disabled')}

    def toggle_service(self, label, enabled):
        self.run(['/bin/launchctl','enable' if enabled else 'disable',self.domain+'/'+label])

    def manager_plist(self, enabled):
        file = self.agent_dir/(self.manager_label+'.plist')
        existing = plistlib.loads(file.read_bytes()) if file.exists() else {}
        base = {'Label':self.manager_label, 'ProgramArguments':[self.node,str(self.root/'server.js')],
                'WorkingDirectory':str(self.root), 'EnvironmentVariables':{'PATH':'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                'MANAGER_PORT':str(self.port),'OPENCLAW_DATA_DIR':str(self.data)},
                'StandardOutPath':str(self.home/'manager-web.log'),'StandardErrorPath':str(self.home/'manager-web.log')}
        base.update(existing)
        # The independent observer controls recovery. An unconditional KeepAlive
        # in an already loaded job would ignore a later switch-off until login.
        base.update({'RunAtLoad':enabled,'KeepAlive':False})
        if self.test_mode: base['ProgramArguments']=['/usr/bin/true'];base['KeepAlive']=False
        return file, plistlib.dumps(base)

    def worker_plist(self, enabled):
        file = self.agent_dir/(self.worker_label+'.plist')
        env = {'PATH':'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','MANAGER_PORT':str(self.port),
               'OPENCLAW_DATA_DIR':str(self.data),'OPENCLAW_STARTUP_HOME':str(self.home),'STARTUP_NODE_BIN':self.node,
               'DOCKER_SOCKET':self.socket}
        if self.test_mode: env['OPENCLAW_STARTUP_TEST_MODE']='1'
        payload = {'Label':self.worker_label,'ProgramArguments':['/usr/bin/python3',str(self.root/'scripts/startup_recovery.py'),'tick'],
                   'WorkingDirectory':str(self.root),'EnvironmentVariables':env,'RunAtLoad':enabled,'StartInterval':20,
                   'ProcessType':'Background','StandardOutPath':str(self.home/'startup-recovery.log'),
                   'StandardErrorPath':str(self.home/'startup-recovery.log')}
        return file, plistlib.dumps(payload)

    def apply_host(self, previous, settings, install=False):
        if not self.gui_available(): raise RecoveryError('需要在 macOS 用户登录会话中设置启动项', 409)
        if install or previous['managerAutoStart'] != settings['managerAutoStart']:
            file, content = self.manager_plist(settings['managerAutoStart']);atomic(file,content)
            self.toggle_service(self.manager_label,settings['managerAutoStart'])
        if install or previous['dockerAutoLaunch'] != settings['dockerAutoLaunch']:
            # SMAppService's unprivileged login item, not Docker's VM/network helpers.
            self.toggle_service(self.docker_label,settings['dockerAutoLaunch'])
        # Keep an observer even with all switches off: a policy change saved
        # while Docker is offline must be applied when it next becomes available.
        # It never launches Manager or Docker when their switches are off.
        enabled = True
        file, content = self.worker_plist(enabled);atomic(file,content)
        self.toggle_service(self.worker_label,enabled)
        loaded = self.service(self.worker_label)['loaded']
        if enabled and not loaded: self.run(['/bin/launchctl','bootstrap',self.domain,str(file)])
        if not enabled and loaded: self.run(['/bin/launchctl','bootout',self.domain+'/'+self.worker_label])

    def ensure_manager(self):
        if self.service(self.manager_label)['running']: return
        # A manually launched web process may already own this port. Do not
        # spawn a competing process or restart one which is serving requests.
        try:
            with contextlib.closing(urllib.request.urlopen('http://127.0.0.1:'+str(self.port)+'/',timeout=2)) as response:
                if response.status == 200: return
        except Exception: pass
        self.toggle_service(self.manager_label,True)
        file=self.agent_dir/(self.manager_label+'.plist')
        if not self.service(self.manager_label)['loaded']: self.run(['/bin/launchctl','bootstrap',self.domain,str(file)])
        self.run(['/bin/launchctl','kickstart',self.domain+'/'+self.manager_label])

    def health(self, port):
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for name, key in [('healthz','ok'),('readyz','ready')]:
            try:
                with opener.open('http://127.0.0.1:'+str(int(port))+'/'+name,timeout=2) as response:
                    if response.status != 200 or json.load(response).get(key) is not True: return False
            except Exception: return False
        return True

class Supervisor:
    def __init__(self, host):
        self.host=host;self.home=host.home;self.home.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.settings_file=self.home/'startup-settings.json';self.state_file=self.home/'startup-status.json'

    def recovery(self):
        if not hasattr(self,'_apfs_recovery'):
            from apfs_recovery import Recovery
            self._apfs_recovery=Recovery(self)
        return self._apfs_recovery

    def intent(self,body):
        with self.lock():return self.recovery().intent(body)

    def effective(self,settings,id):
        try:
            recovery=self.recovery()
            if recovery.storage(id).get('hard',{}).get('backend')!='apfs-volume':return self.storage_policy(settings,id)=='unless-stopped'
            e=recovery.load()['entries'].get(id,{})
            return bool(recovery.enabled(settings,id) and e.get('desired')=='running' and e.get('phase') in ['running','pending','restoring'] and not recovery.inhibited(id) and not recovery.protected(id))
        except Exception:return False

    @contextlib.contextmanager
    def lock(self):
        import fcntl
        file=self.home/'startup-control.lock'
        if file.is_symlink():raise RecoveryError('启动控制锁路径不合法')
        with file.open('a') as handle:
            os.chmod(file,0o600)
            deadline=time.monotonic()+min(15,max(0,float(os.environ.get('STARTUP_LOCK_WAIT_SECONDS','0'))))
            while True:
                try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB);break
                except BlockingIOError:
                    if time.monotonic()>=deadline:raise RecoveryError('启动检查或设置正在执行，请稍后重试',409)
                    time.sleep(.15)
            try:yield
            finally:fcntl.flock(handle,fcntl.LOCK_UN)

    def settings(self):
        data=json_file(self.settings_file,json.loads(json.dumps(DEFAULTS)))
        if not isinstance(data,dict) or set(data)!=set(DEFAULTS) or any(not isinstance(data[k],bool) for k in ['managerAutoStart','dockerAutoLaunch','instancesAutoStart']) or not isinstance(data['instanceOverrides'],dict):
            raise RecoveryError('启动设置损坏，请从备份恢复')
        if any(not ID_RE.fullmatch(k) or not isinstance(v,bool) for k,v in data['instanceOverrides'].items()):raise RecoveryError('实例启动设置损坏')
        return data

    def records(self):
        rows=[]
        if not self.host.data.exists():return rows
        for folder in sorted(self.host.data.iterdir()):
            if not ID_RE.fullmatch(folder.name) or folder.is_symlink() or not folder.is_dir():continue
            storage=json_file(self.host.data.parent/'storage'/(folder.name+'.json'),{})
            mount=storage.get('hard',{}).get('mountpoint') if storage.get('hard',{}).get('backend')=='apfs-volume' else None
            if mount and not re.fullmatch('/Volumes/oc-'+re.escape(folder.name)+r'-[a-f0-9]{8}',mount):raise RecoveryError('APFS 挂载路径不合法')
            file=(Path(mount) if mount else folder)/'instance.json'
            if not file.exists():continue
            row=json_file(file,{})
            if row.get('id')!=folder.name:raise RecoveryError('实例记录与目录不一致')
            rows.append(row)
        return rows

    def owned(self, row):
        id=row.get('containerId')
        if not id:return None
        if not isinstance(id,str) or not re.fullmatch('[a-f0-9]{12,64}',id):raise RecoveryError('容器标识不合法')
        container=self.host.inspect(id)
        if container is None:return None
        labels=container.get('Config',{}).get('Labels',{})
        if labels.get('openclaw.managed')!='true' or labels.get('openclaw.instance')!=row['id'] or container.get('Name','').lstrip('/')!=row.get('containerName','openclaw-'+row['id']):
            raise RecoveryError('容器归属校验失败，未修改容器')
        return container

    def storage_policy(self, settings, id):
        folder = self.host.data.parent / 'storage'
        try:
            if folder.is_symlink(): return 'no'
            ledger=self.home/'apfs-recovery.json'
            if ledger.is_symlink():return 'no'
            if ledger.exists() and id in json_file(ledger,{}).get('entries',{}):return 'no'
            if sys.platform=='darwin' and not self.host.test_mode:
                from apfs_quota import Backend
                if id in Backend(self.host.data).entries():return 'no'
            value = json_file(folder / (id + '.json'), {})
            if value.get('migration') or value.get('hard',{}).get('backend')=='apfs-volume': return 'no'
            if not isinstance(value, dict) or value.get('blocked') or value.get('recovery'): return 'no'
            if value.get('drain') or (value.get('policy',{}).get('mode')=='hard' and value.get('hard',{}).get('phase')!='verified'): return 'no'
        except Exception:
            return 'no'
        return policy(settings, id)

    def reconcile(self, settings, rollback=None):
        result=[]
        for row in self.records():
            container=self.owned(row)
            if container is None:continue
            current=container['HostConfig']['RestartPolicy']['Name']
            wanted=self.storage_policy(settings,row['id'])
            if current!=wanted:
                if rollback is not None:
                    count=container['HostConfig']['RestartPolicy'].get('MaximumRetryCount',0)
                    rollback.append((container['Id'],current+(':'+str(count) if current=='on-failure' and count else '')))
                self.host.set_policy(container['Id'],wanted)
                result.append(row['id'])
        return result

    def update(self, body, install=False):
        with self.lock():
            previous=self.settings();settings=patch_settings(previous,body,{r['id'] for r in self.records()})
            online=self.host.available()
            if not online and any(r.get('containerId') and self.storage_policy(previous,r['id'])!=self.storage_policy(settings,r['id']) for r in self.records()):
                raise RecoveryError('Docker 未就绪，无法安全同步实例恢复策略；请等待 Docker 可用后修改实例自启。Manager 与 Docker 开关可单独保存。',409)
            changed=[];host_applied=False
            try:
                # Host toggles are applied even when Docker is unavailable;
                # policies are reconciled on the next successful engine probe.
                host_applied=True;self.host.apply_host(previous,settings,install)
                if online:self.reconcile(settings,changed)
                if self.settings_file.exists():atomic(self.home/'startup-settings.last-good.json',self.settings_file.read_bytes())
                atomic(self.state_file,json.dumps({'checkedAt':time.time(),'phase':'pending' if any(settings[k] for k in ['managerAutoStart','dockerAutoLaunch','instancesAutoStart']) else 'disabled','instances':[],'errors':[]},ensure_ascii=False))
                atomic(self.settings_file,json.dumps(settings,ensure_ascii=False,indent=2))
            except Exception:
                errors=[]
                for id,name in reversed(changed):
                    try:self.host.set_policy(id,name)
                    except Exception:errors.append('容器策略')
                if host_applied:
                    try:self.host.apply_host(settings,previous,True)
                    except Exception:errors.append('系统启动项')
                if errors:raise RecoveryError('保存失败，部分设置回滚失败：'+','.join(errors)+'；请刷新检查',503)
                raise
            return self.view()

    def view(self):
        settings=self.settings();state=json_file(self.state_file,{})
        try:recovery=self.recovery().public()
        except Exception as e:recovery={'enabled':False,'error':str(e),'instances':[]}
        return {'settings':settings,'revision':revision(settings),'status':state,'apfsRecovery':recovery,
                'instances':[{'id':r['id'],'name':r.get('name',r['id']),'enabled':settings['instanceOverrides'].get(r['id'],True),'effective':self.effective(settings,r['id'])} for r in self.records()],
                'loginRequired':True,'testMode':self.host.test_mode,
                'supervisorInstalled':(self.host.agent_dir/(self.host.worker_label+'.plist')).exists()}

    def tick(self):
        with self.lock():
            settings=self.settings();old=json_file(self.state_file,{})
            state={'checkedAt':time.time(),'phase':'checking','environment':self.host.environment(),'instances':[],
                   'lastDockerLaunchAt':old.get('lastDockerLaunchAt',0),'errors':[]}
            environment=state['environment']
            if not any(settings[k] for k in ['managerAutoStart','dockerAutoLaunch','instancesAutoStart']):
                state['phase']='disabled'
                if environment['dockerCLIInstalled'] and self.host.available():
                    try:self.reconcile(settings)
                    except RecoveryError as e:state['errors'].append(str(e))
            elif not environment['nodeInstalled'] or not environment['dataDirectoryWritable']:
                state['phase']='environment-error';state['errors'].append('Node.js 缺失或配置目录不可写')
            else:
                if settings['managerAutoStart']:
                    try:self.host.ensure_manager()
                    except RecoveryError as e:state['errors'].append('Manager 启动项：'+str(e))
                if not environment['dockerCLIInstalled']:state['phase']='docker-missing'
                elif not self.host.available():
                    state['phase']='docker-offline'
                    if settings['dockerAutoLaunch']:
                        if not environment['dockerDesktopInstalled']:state['phase']='docker-missing'
                        elif not self.host.gui_available():state['phase']='waiting-login'
                        elif self.host.desktop_running():state['phase']='waiting-engine'
                        elif time.time()-state['lastDockerLaunchAt'] < 120:state['phase']='waiting-engine'
                        else:
                            state['lastDockerLaunchAt']=time.time()
                            try:self.host.open_docker();state['phase']='waiting-engine'
                            except RecoveryError as e:state['errors'].append(str(e))
                else:
                    state['phase']='ready'
                    # APFS recovery alone may start a previously running primary
                    # after a verified host boot change. Legacy policies retain
                    # Docker's original manual-stop semantics.
                    try:state['apfsRecovery']=self.recovery().run(settings)
                    except Exception as e:state['errors'].append('APFS 恢复保持停止：'+str(e))
                    records=self.records()
                    for row in records:
                        item={'id':row['id'],'name':row.get('name',row['id']),
                              'enabled':settings['instanceOverrides'].get(row['id'],True),
                              'effective':self.effective(settings,row['id'])}
                        try:
                            container=self.owned(row)
                            if container is None:
                                item.update({'state':'missing','detail':'容器不存在或尚未创建，请手动启动；未自动重建'})
                            else:
                                current=container['HostConfig']['RestartPolicy']['Name'];wanted=self.storage_policy(settings,row['id'])
                                if current!=wanted:self.host.set_policy(container['Id'],wanted)
                                item.update({'state':container['State']['Status'],'restartPolicy':wanted})
                                if not container['State'].get('Running'):
                                    item['detail']='保持停止状态，不强制启动'
                                else:
                                    storage=json_file(self.host.data.parent/'storage'/(row['id']+'.json'),{})
                                    folder=Path(storage.get('hard',{}).get('mountpoint',str(self.host.data/row['id'])))
                                    try:
                                        if not (folder/'workspace').is_dir():raise ValueError('工作区目录缺失')
                                        if not isinstance(json_file(folder/'openclaw/openclaw.json',None),dict):raise ValueError('配置文件缺失')
                                    except Exception: item['detail']='配置或工作区异常，请检查';item['ready']=False
                        except RecoveryError as e:item.update({'state':'error','detail':str(e)});state['errors'].append(row['id']+'：'+str(e))
                        state['instances'].append(item)
                    running=[(row,item) for row,item in zip(records,state['instances']) if item.get('state')=='running' and 'ready' not in item]
                    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                        futures=[(item,pool.submit(self.host.health,row.get('port'))) for row,item in running]
                        for item,future in futures:
                            item['ready']=future.result();item['detail']='网关健康且就绪' if item['ready'] else '网关尚未就绪；持续检查，不自动重启运行中的实例'
                    if any(i.get('state') in ['missing','error'] or i.get('ready') is False for i in state['instances']):state['phase']='attention'
            if state['errors'] and state['phase']=='ready':state['phase']='attention'
            atomic(self.state_file,json.dumps(state,ensure_ascii=False,indent=2))
            return self.view()

def main():
    root=Path(__file__).resolve().parent.parent
    data=Path(os.environ.get('OPENCLAW_DATA_DIR',str(root/'data/instances')))
    home=Path(os.environ.get('OPENCLAW_STARTUP_HOME',str(data.parent)))
    host=Host(root,data,home,os.environ.get('OPENCLAW_STARTUP_TEST_MODE')=='1')
    supervisor=Supervisor(host);action=sys.argv[1] if len(sys.argv)>1 else 'status'
    if action=='status':result=supervisor.view()
    elif action=='tick':result=supervisor.tick()
    elif action in ['settings','install']:
        raw=sys.stdin.read(65537)
        if len(raw)>65536:raise RecoveryError('设置内容过大')
        body=json.loads(raw) if raw else {'revision':revision(supervisor.settings())}
        result=supervisor.update(body,action=='install')
    elif action=='uninstall-test' and host.test_mode:
        for label in [host.worker_label,host.manager_label,host.docker_label]:
            host.run(['/bin/launchctl','bootout',host.domain+'/'+label],check=False)
            host.run(['/bin/launchctl','enable',host.domain+'/'+label],check=False)
        result={'ok':True}
    else:raise RecoveryError('不支持的启动管理操作')
    # launchd ticks persist state but do not append a full report every 20s.
    if action!='tick' or '--json' in sys.argv:print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except RecoveryError as e:
        if len(sys.argv)>1 and sys.argv[1]=='tick' and e.status==409 and '--json' not in sys.argv:sys.exit(0)
        print(json.dumps({'error':str(e),'status':e.status},ensure_ascii=False));sys.exit(1)
    except Exception as e:
        print(json.dumps({'error':'启动恢复检查失败：'+str(e)[:500],'status':500},ensure_ascii=False));sys.exit(1)
