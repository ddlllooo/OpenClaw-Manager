#!/usr/bin/env python3
"""Unprivileged system LaunchDaemon: fixed Compose target and signed mailbox.

No business container start/stop/recreate operations exist here. Credentials and
arbitrary command execution are never accepted from the container control API.
"""
import base64,concurrent.futures,datetime as dt,hashlib,hmac,json,os,re,secrets,signal,socket,subprocess,sys,threading,time
from pathlib import Path
from zoneinfo import ZoneInfo
from startup_recovery import Host,Supervisor,RecoveryError,atomic,json_file,revision

class ComposeHost(Host):
    def __init__(self,config):
        self.config=config
        super().__init__(config['root'],config['instances'],config['startupHome'],config.get('testMode',False))
        self.socket=config['dockerSocket'];self.port=config['managerPort']
        self.manager=config['managerContainer'];self.deployment=config['deployment']
        if not re.fullmatch(r'openclaw-manager(?:-[a-z0-9-]+)?',self.manager):raise RecoveryError('Manager 容器名称不合法')
        if config.get('backend','desktop') not in ['desktop','colima']:raise RecoveryError('不支持的容器后端')
        if self.test_mode and self.data==Path('/Users/livzon/openclaw-docker/data/instances'):raise RecoveryError('测试控制器禁止访问生产实例目录')
        self.backend=config.get('backend','desktop')
        self.worker_label=config['serviceLabel'];self.agent_dir=Path('/Library/LaunchDaemons')
        self.colima=config.get('colimaBin','/opt/homebrew/bin/colima');self.profile=config.get('colimaProfile','openclaw-headless')
        if not re.fullmatch(r'openclaw-[a-z0-9-]+',self.profile):raise RecoveryError('隔离 Colima 配置名不合法')
    def manager_info(self):
        row=self.inspect(self.manager)
        if row and (row.get('Config',{}).get('Labels',{}).get('openclaw.manager')!='true' or row['Config']['Labels'].get('openclaw.deployment')!=self.deployment):raise RecoveryError('Manager 容器归属校验失败')
        return row
    def compose(self,args):
        env={**os.environ,'DOCKER_HOST':'unix://'+self.socket}
        p=subprocess.run([self.docker,'compose','--env-file',self.config['composeEnv'],'-f',self.config['composeFile'],'-p',self.deployment,*args],env=env,text=True,capture_output=True,timeout=90)
        if p.returncode:raise RecoveryError((p.stderr or p.stdout)[-800:],503)
    def environment(self):
        result=super().environment();result.update({'nodeInstalled':True,'managerRuntime':'docker-compose','dockerBackend':self.backend,'loginRequired':self.backend=='desktop','dockerDesktopInstalled':Path(self.colima).is_file() if self.backend=='colima' else self.desktop.exists()})
        return result
    def gui_available(self):return True if self.backend=='colima' else super().gui_available()
    def desktop_running(self):
        if self.backend=='desktop':return super().desktop_running()
        p=self.run([self.colima,'--profile',self.profile,'status','--json'],timeout=10,check=False)
        return p.returncode==0
    def open_docker(self):
        if self.backend=='desktop':return super().open_docker()
        # Existing dedicated profile only. Never provision or stop a VM here.
        profile=Path.home()/'.colima'/self.profile/'colima.yaml'
        if not profile.is_file():raise RecoveryError('独立 Colima 配置未准备完成；未自动创建虚拟机')
        self.run([self.colima,'--profile',self.profile,'start','--activate=false'],timeout=90)
    def apply_host(self,previous,settings,install=False):
        # The system task always stays loaded; flags govern its actions, avoiding
        # sudo and launchctl mutations from the web application.
        if self.available():
            row=self.manager_info()
            if row:
                wanted='unless-stopped' if settings['managerAutoStart'] else 'no'
                if row['HostConfig']['RestartPolicy']['Name']!=wanted:self.set_policy(row['Id'],wanted)
        if self.backend=='desktop' and (install or previous['dockerAutoLaunch']!=settings['dockerAutoLaunch']):
            if super().gui_available():self.toggle_service(self.docker_label,settings['dockerAutoLaunch'])
    def ensure_manager(self):
        if not self.available():return
        row=self.manager_info()
        if row is None:
            self.compose(['up','-d','--no-build','--pull','never','--no-deps','manager']);return
        wanted='unless-stopped'
        if row['HostConfig']['RestartPolicy']['Name']!=wanted:self.set_policy(row['Id'],wanted)
        if not row['State']['Running']:self.docker_cmd(['start',row['Id']],30)

class ContainerSupervisor(Supervisor):
    def view(self):
        view=super().view();view.update({'loginRequired':self.host.backend=='desktop','managerRuntime':'docker-compose','dockerBackend':self.host.backend,'systemService':self.host.worker_label})
        return view

class Service:
    def __init__(self,config):
        self.config=config;self.host=ComposeHost(config);self.supervisor=ContainerSupervisor(self.host)
        self.control=Path(config['controlDirectory']);self.control.mkdir(parents=True,exist_ok=True,mode=0o700)
        for name in ['requests','responses']:(self.control/name).mkdir(exist_ok=True,mode=0o700)
        keyfile=self.control/'key'
        if not keyfile.exists():atomic(keyfile,secrets.token_hex(32))
        if keyfile.is_symlink():raise RecoveryError('控制密钥不能是符号链接')
        self.key=keyfile.read_text().strip()
        if not re.fullmatch('[a-f0-9]{64}',self.key):raise RecoveryError('控制密钥不合法')
        self.stop=threading.Event();self.running=set();self.pool=concurrent.futures.ThreadPoolExecutor(max_workers=4);self.pending_backup=None
    def backup_status(self):
        root=Path(self.config['backupDirectory']);schedule=json_file(root/'schedule.json',{'enabled':False,'hour':3,'minute':30,'timezone':'Asia/Shanghai'});state=json_file(root/'status.json',{'state':'never','lastSuccess':None})
        if state.get('state')=='running':
            try:
                pid=state.get('pid')
                if not isinstance(pid,int) or pid<=0:raise ValueError('invalid pid')
                os.kill(pid,0)
            except (OSError,ValueError):state.update(state='failed',lastError='上次备份进程已中断，最近一次成功备份仍保留，请重试')
        now=dt.datetime.now(ZoneInfo('Asia/Shanghai'));due=now.replace(hour=schedule['hour'],minute=schedule['minute'],second=0,microsecond=0);today=now.date().isoformat()
        next_run=due+dt.timedelta(days=1) if due<=now or (state.get('lastSuccess') or {}).get('date')==today else due
        latest=(due if due<=now else due-dt.timedelta(days=1)).date().isoformat()
        if schedule['enabled'] and state.get('state') not in ['running','failed'] and ((state.get('lastSuccess') or {}).get('date') or '')<latest:state.update(state='overdue',lastError='每日备份尚未成功完成，请检查计划或立即重试')
        return {**state,'schedule':schedule,'nextRunAt':next_run.isoformat() if schedule['enabled'] else None,'retentionDays':7,'directory':str(root)}
    def dispatch(self,action,body):
        if action=='status':return self.supervisor.view()
        if action=='settings':return self.supervisor.update(body)
        if action in ['check','tick']:return self.supervisor.tick()
        if action=='port-free':
            port=body.get('port')
            if not isinstance(port,int) or isinstance(port,bool) or not 1024<=port<=65535:raise RecoveryError('端口不合法')
            with socket.socket() as sock:sock.settimeout(.3);free=sock.connect_ex(('127.0.0.1',port))!=0
            return {'free':free}
        if action=='backup-status':return self.backup_status()
        if action=='backup-run':
            if self.backup_status()['state']=='running' or (self.pending_backup and self.pending_backup.poll() is None):raise RecoveryError('备份正在执行，请等待完成',409)
            log=Path(self.config['backupDirectory']);log.mkdir(parents=True,exist_ok=True,mode=0o700)
            with (log/'backup-run.log').open('ab') as output:
                self.pending_backup=subprocess.Popen(['/usr/bin/python3',str(self.host.root/'scripts/backup_instances.py'),'--source',str(self.host.data),'--destination',str(log)],stdin=subprocess.DEVNULL,stdout=output,stderr=output,start_new_session=True)
            return {'ok':True,'hint':'备份已开始，实例会继续运行'}
        raise RecoveryError('不支持的宿主控制操作')
    def handle(self,file):
        id=file.stem
        try:
            if file.is_symlink() or file.stat().st_size>128*1024:raise RecoveryError('宿主请求不合法')
            envelope=json.loads(file.read_text());payload=envelope['payload']
            if not hmac.compare_digest(hmac.new(self.key.encode(),payload.encode(),hashlib.sha256).hexdigest(),envelope.get('signature','')):raise RecoveryError('宿主请求签名无效',403)
            request=json.loads(base64.b64decode(payload,validate=True));now=time.time()
            if request.get('id')!=id or not now-120<=request.get('issuedAt',0)<=now+10 or not now<request.get('deadline',0)<=now+120:raise RecoveryError('宿主请求已过期',409)
            claim=file.with_suffix('.claim')
            try:
                with claim.open('x'):pass
            except FileExistsError:raise RecoveryError('重复的宿主请求',409)
            # Remove before execution. A request is dispatched at most once.
            file.unlink()
            value=self.dispatch(request.get('action'),request.get('body',{}));result={'id':id,'result':value}
        except Exception as error:
            result={'id':id,'error':str(error)[:800],'status':getattr(error,'status',500)}
            try:file.unlink(missing_ok=True)
            except OSError:pass
        raw=base64.b64encode(json.dumps(result,ensure_ascii=False).encode()).decode();signature=hmac.new(self.key.encode(),raw.encode(),hashlib.sha256).hexdigest()
        atomic(self.control/'responses'/(id+'.json'),json.dumps({'payload':raw,'signature':signature}))
        # Bind mounts may map guest root to another host uid. Only the private
        # control directory is shared with Manager; signed envelopes are readable.
        os.chmod(self.control/'responses'/(id+'.json'),0o644)
    def recover(self):
        while not self.stop.is_set():
            try:self.supervisor.tick()
            except RecoveryError as e:
                if e.status!=409:print('recovery: '+str(e)[:700],flush=True)
            except Exception as e:print('recovery: '+str(e)[:700],flush=True)
            self.stop.wait(20)
    def serve(self):
        import fcntl
        lock=(self.control/'service.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        threading.Thread(target=self.recover,daemon=True).start()
        while not self.stop.is_set():
            for file in list((self.control/'requests').glob('*.json'))[:128]:
                if not re.fullmatch('[a-f0-9]{32}',file.stem) or file.name in self.running:continue
                self.running.add(file.name)
                future=self.pool.submit(self.handle,file)
                future.add_done_callback(lambda _f,name=file.name:self.running.discard(name))
            for file in (self.control/'responses').glob('*.json'):
                try:
                    if time.time()-file.stat().st_mtime>180:file.unlink()
                except OSError:pass
            for file in (self.control/'requests').glob('*.claim'):
                try:
                    if time.time()-file.stat().st_mtime>180:file.unlink()
                except OSError:pass
            self.stop.wait(.1)
        self.pool.shutdown(wait=True);lock.close()

def main():
    import argparse,plistlib,pwd
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['serve','plist','status','check','init']);parser.add_argument('--config',required=True);args=parser.parse_args()
    config=json_file(Path(args.config),None)
    if not isinstance(config,dict):raise RecoveryError('缺少宿主服务配置')
    service=Service(config)
    if args.action=='serve':
        for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,lambda *_:service.stop.set())
        service.serve()
    elif args.action=='init':print(json.dumps(service.supervisor.view(),ensure_ascii=False))
    elif args.action=='status':print(json.dumps(service.supervisor.view(),ensure_ascii=False))
    elif args.action=='check':print(json.dumps(service.supervisor.tick(),ensure_ascii=False))
    else:
        user=pwd.getpwuid(os.getuid()).pw_name
        value={'Label':config['serviceLabel'],'UserName':user,'GroupName':pwd.getpwuid(os.getuid()).pw_gid,'ProgramArguments':['/usr/bin/python3',str(service.host.root/'scripts/manager_host_service.py'),'serve','--config',str(Path(args.config).resolve())],'EnvironmentVariables':{'HOME':str(Path.home()),'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','STARTUP_LOCK_WAIT_SECONDS':'10'},'WorkingDirectory':str(service.host.root),'RunAtLoad':True,'KeepAlive':True,'StandardOutPath':str(service.host.home/'manager-host-service.log'),'StandardErrorPath':str(service.host.home/'manager-host-service.log'),'ThrottleInterval':10}
        # launchd expects a group name, not a numeric gid.
        import grp
        value['GroupName']=grp.getgrgid(value['GroupName']).gr_name
        sys.stdout.buffer.write(plistlib.dumps(value))
if __name__=='__main__':main()
