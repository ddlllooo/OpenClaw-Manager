"""Boot-scoped APFS recovery, serialized by Supervisor.lock.

Docker restart stays disabled. Intent is outside the quota and fsynced before
manual/protective stop. Only a confirmed running checkpoint from the preceding
host boot can issue one automatic start; a service/engine restart is not a boot.
"""
import json
import errno
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
from startup_recovery import RecoveryError, atomic, json_file


class Waiting(Exception): pass
class Blocked(Exception): pass


def durable(file,raw):
    atomic(file,raw)
    if sys.platform=='win32':return
    fd=os.open(str(Path(file).parent),os.O_RDONLY)
    try:
        try:os.fsync(fd)
        except OSError as e:
            if e.errno not in [errno.EINVAL,errno.ENOTSUP]:raise
    finally:os.close(fd)


def boot_identity():
    if sys.platform=='darwin':
        value=subprocess.check_output(['/usr/sbin/sysctl','-n','kern.bootsessionuuid'],timeout=5).decode().strip()
    elif sys.platform=='linux':value=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    else:raise RecoveryError('当前宿主没有经过验证的启动标识；禁止自动恢复',503)
    if not re.fullmatch(r'[a-fA-F0-9-]{32,40}',value):raise RecoveryError('宿主启动标识无效',503)
    return value


class Recovery:
    def __init__(self, supervisor, boot=None, quota=None, probe=None, clock=time.time):
        self.s=supervisor;self.host=supervisor.host;self.clock=clock
        # A real process cannot survive a host reboot. Cache native sysctl;
        # injectable boot identity is confined to the test harness.
        identity=('isolated-test' if self.host.test_mode else boot_identity()) if boot is None else None
        self.boot=boot or (lambda:identity)
        self.quota=quota or self.native_quota;self.probe=probe or self.native_probe
        self.file=self.host.home/'apfs-recovery.json';self.inhibits=self.host.home/'apfs-run-inhibit'
        self.shutting_down=False

    def storage(self,id):
        folder=self.host.data.parent/'storage'
        if folder.is_symlink():raise RecoveryError('存储保护目录不能是符号链接')
        value=json_file(folder/(id+'.json'),{})
        if not isinstance(value,dict):raise RecoveryError('存储保护记录损坏')
        return value

    def ids(self):
        folder=self.host.data.parent/'storage'
        if folder.is_symlink():raise RecoveryError('存储保护目录不能是符号链接')
        ids={p.stem for p in sorted(folder.glob('*.json')) if re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',p.stem) and self.storage(p.stem).get('hard',{}).get('backend')=='apfs-volume'}
        # Losing a policy field must not silently turn a previously guarded
        # instance into a legacy Docker-autostart instance.
        ids.update(self.load()['entries'])
        return sorted(ids)

    def load(self):
        if self.file.is_symlink():raise RecoveryError('APFS 恢复记录不能是符号链接')
        data=json_file(self.file,{'version':1,'boot':self.boot(),'entries':{}})
        if not isinstance(data,dict) or data.get('version')!=1 or not isinstance(data.get('entries'),dict) or not isinstance(data.get('boot'),str):raise RecoveryError('APFS 恢复记录损坏；保持停止，禁止重置记录后自动启动')
        for id,e in data['entries'].items():
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',id) or not isinstance(e,dict) or e.get('desired') not in ['running','stopped'] or not isinstance(e.get('phase'),str):raise RecoveryError('APFS 实例恢复记录损坏')
        return data

    def save(self,data):
        raw=json.dumps(data,ensure_ascii=False,indent=2)
        if self.file.is_symlink():raise RecoveryError('APFS 恢复记录不能是符号链接')
        if self.file.exists() and self.file.read_text()==raw:return
        durable(self.file,raw)

    def inhibited(self,id):
        if self.inhibits.is_symlink():raise RecoveryError('实例停止记录目录不合法')
        file=self.inhibits/(id+'.json')
        if file.is_symlink():return True
        if not file.exists():return False
        value=json_file(file,None)
        if not isinstance(value,dict) or value.get('id')!=id:raise RecoveryError('实例停止记录损坏')
        return True

    def inhibit(self,id,reason):
        if self.inhibits.is_symlink():raise RecoveryError('实例停止记录目录不合法')
        if self.inhibited(id):return
        durable(self.inhibits/(id+'.json'),json.dumps({'id':id,'reason':reason,'at':self.clock()}))

    def protected(self,id):
        value=self.storage(id)
        return bool(value.get('blocked') or value.get('drain') or value.get('migration') or value.get('recovery') or
                    value.get('policy',{}).get('mode')!='hard' or value.get('hard',{}).get('phase')!='verified' or value.get('hard',{}).get('backend')!='apfs-volume')

    def enabled(self,settings,id):
        return bool(getattr(self.host,'config',{}).get('apfsAutoRecovery') is True and settings['instancesAutoStart'] and settings['instanceOverrides'].get(id,True))

    def public(self):
        data=self.load()
        return {'boot':data['boot'],'enabled':getattr(self.host,'config',{}).get('apfsAutoRecovery') is True,
                'instances':[{'id':id,**{k:e.get(k) for k in ['desired','phase','detail','attemptedBoot','observedBoot']}} for id,e in data['entries'].items()]}

    def row_cache(self,row):return {k:row.get(k) for k in ['id','name','containerId','containerName','port']}

    def native_quota(self,id,full):
        from apfs_quota import Backend
        hard=self.storage(id).get('hard',{});mount=hard.get('mountpoint')
        if not isinstance(mount,str) or not re.fullmatch('/Volumes/oc-'+re.escape(id)+r'-[a-f0-9]{8}',mount):raise Blocked('APFS 卷路径不合法')
        if not os.path.ismount(mount):raise Waiting('等待宿主按 UUID 挂载 APFS 卷')
        try:return Backend(self.host.data).status(id,full)
        except Exception as e:raise Blocked('APFS 卷身份或实际配额未通过校验：'+str(e))

    def validate(self,row,container,probe=False):
        id=row['id'];storage=self.storage(id);hard=storage.get('hard',{});policy=storage.get('policy',{})
        if container.get('State',{}).get('Paused') or container.get('State',{}).get('Restarting'):raise Blocked('暂停或状态不明的容器需人工确认')
        if self.inhibited(id) or self.protected(id):raise Blocked('手动停止、迁移或存储保护锁定，禁止自动恢复')
        quota=self.quota(id,probe)
        if not quota.get('verified') or quota.get('backend')!='apfs-volume' or quota.get('volumeUUID')!=hard.get('volumeUUID') or quota.get('hardBytes')!=hard.get('hardBytes'):
            raise Blocked('平台策略与宿主 APFS 卷或额度不符')
        limit=policy.get('limitGiB',0)*1024**3
        if not limit or abs(limit-quota['hardBytes'])>=4096:raise Blocked('平台容量与 APFS 硬上限不符')
        if quota['usedBytes']/quota['hardBytes']*100>=policy.get('admissionPercent',90) or quota['filesystemAvailable']<policy.get('minFreeGiB',1)*1024**3:
            raise Blocked('用量达到停止接单阈值或宿主空间不足，需人工处理')
        root=Path(quota['mountpoint'])
        expected={str(root/'openclaw'):'/home/node/.openclaw',str(root/'workspace'):'/home/node/.openclaw/workspace',str(root/'auth'):'/home/node/.config/openclaw'}
        mounts=container.get('Mounts',[])
        if len(mounts)!=3 or {m.get('Source'):m.get('Destination') for m in mounts if m.get('Type')=='bind'}!=expected or any(not m.get('RW') for m in mounts):raise Blocked('实例容器挂载与已验证的数据卷不符；禁止自动重建或启动')
        if container.get('HostConfig',{}).get('RestartPolicy',{}).get('Name')!='no':raise Blocked('APFS 实例必须禁用 Docker 直接自动重启')
        try:
            config=json_file(root/'openclaw/openclaw.json',None)
            if not isinstance(config,dict):raise ValueError('missing config')
        except Exception:raise Blocked('实例配置缺失或损坏')
        if probe:self.probe(row,quota)
        return quota

    def native_probe(self,row,quota):
        manager=self.host.manager_info()
        if not manager:raise Waiting('等待可信 Manager 镜像就绪')
        code="const f=require('fs');for(const p of ['', '/openclaw','/workspace','/auth'])if(f.readFileSync('/probe'+p+'/.openclaw-volume-id','utf8').trim()!==process.argv[1])process.exit(2);"
        try:
            self.host.docker_cmd(['run','--rm','--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
                '--memory','128m','--pids-limit','32','--user',manager['Config'].get('User') or '501:20',
                '--label','openclaw.recovery.probe=true','--mount','type=bind,source='+quota['mountpoint']+',target=/probe,readonly,consistency=consistent',
                '--entrypoint','node',manager['Image'],'-e',code,quota['volumeUUID']],30)
        except Exception:raise Waiting('Docker 尚未看到正确 APFS 卷；保持停止并等待共享就绪')

    def intent(self,body):
        if not isinstance(body,dict) or set(body)-{'id','action','token','containerId','reason'}:raise RecoveryError('恢复意图字段不合法')
        id=body.get('id');action=body.get('action')
        if id not in self.ids() or action not in ['prepare','commit','stop','fail']:raise RecoveryError('不支持的 APFS 实例恢复意图')
        data=self.load();entry=data['entries'].get(id,{})
        if action=='stop':
            reason=body.get('reason','manual')
            if reason not in ['manual','storage','maintenance','delete']:raise RecoveryError('停止原因不合法')
            self.inhibit(id,reason)
            entry.update(desired='stopped',phase='stopped',detail=reason,token=None,pendingBoot=None)
        elif action=='prepare':
            if self.protected(id):raise RecoveryError('存储保护或迁移未解除，禁止记录启动意图',409)
            row=next((r for r in self.s.records() if r['id']==id),None)
            if not row:raise RecoveryError('实例卷或记录未就绪',409)
            # Explicit manual start is the only operation allowed to clear an
            # inhibit marker. Until commit, this is never a boot candidate.
            entry.update(desired='running',phase='starting',token=secrets.token_hex(16),leaseUntil=self.clock()+300,pendingBoot=None,row=self.row_cache(row))
            if self.inhibits.is_symlink():raise RecoveryError('实例停止记录目录不合法')
            file=self.inhibits/(id+'.json')
            if file.is_symlink():raise RecoveryError('实例停止记录不合法')
            if file.exists():file.unlink()
        else:
            token=body.get('token')
            if not isinstance(token,str) or not token or entry.get('token')!=token:raise RecoveryError('启动意图已被停止或其他操作取代',409)
            if action=='fail':entry.update(desired='stopped',phase='failed',detail='手动启动未确认成功',token=None,pendingBoot=None)
            else:
                row=next((r for r in self.s.records() if r['id']==id),None)
                if not row or row.get('containerId')!=body.get('containerId'):raise RecoveryError('已确认容器与实例记录不符',409)
                container=self.s.owned(row)
                if not container or not container['State'].get('Running'):raise RecoveryError('Docker 未确认实例运行',409)
                q=self.validate(row,container)
                entry.update(desired='running',phase='running',observedBoot=self.boot(),row=self.row_cache(row),volumeUUID=q['volumeUUID'],token=None,pendingBoot=None,detail='已确认运行')
        data['entries'][id]=entry;self.save(data)
        return {'ok':True,'token':entry.get('token'),'desired':entry['desired'],'phase':entry['phase']}

    def run(self,settings):
        if self.shutting_down:return []
        if not self.host.available():return [{'id':id,'phase':'waiting','detail':'等待 Docker 引擎就绪'} for id in self.ids()]
        data=self.load();boot=self.boot();changed=data['boot']!=boot
        if changed:
            for e in data['entries'].values():
                eligible=e.get('desired')=='running' and e.get('phase')=='running' and e.get('observedBoot')==data['boot']
                e.update(pendingBoot=boot if eligible else None,phase='pending' if eligible else e['phase'])
                if eligible:e['detail']='等待挂载与启动前校验'
            data['boot']=boot;self.save(data)
        rows={r['id']:r for r in self.s.records()};result=[]
        for id in self.ids():
            if self.shutting_down:break
            e=data['entries'].get(id);row=rows.get(id) or (e or {}).get('row')
            if not row:result.append({'id':id,'phase':'waiting','detail':'卷尚未挂载，缺少可信实例检查点'});continue
            try:
                c=self.s.owned(row)
                if not c:raise Blocked('原容器不存在；保持停止，不自动重建')
                if self.inhibited(id) or self.protected(id):raise Blocked('手动停止或存储保护锁定')
                if e is None:
                    if c['State'].get('Running'):
                        q=self.validate(row,c)
                        e={'desired':'running','phase':'running','row':self.row_cache(row),'volumeUUID':q['volumeUUID'],'observedBoot':boot,'detail':'已接管当前运行状态'}
                    else:e={'desired':'stopped','phase':'stopped','row':self.row_cache(row),'detail':'初始停止实例不自动启动'}
                    data['entries'][id]=e;self.save(data)
                elif e.get('phase')=='starting':
                    if self.clock()>e.get('leaseUntil',0):raise Blocked('未完成的手动启动需人工确认')
                elif e.get('pendingBoot')==boot:
                    if not self.enabled(settings,id):raise Blocked('实例自动恢复开关关闭，本次启动不补启')
                    if e.get('row',{}).get('containerId')!=row.get('containerId'):raise Blocked('实例容器身份已变化')
                    if c['State'].get('Running'):
                        q=self.validate(row,c)
                        e.update(phase='running',pendingBoot=None,observedBoot=boot,detail='已运行，无重复启动')
                    else:
                        if e.get('attemptedBoot')==boot:raise Blocked('本次宿主启动已经尝试恢复，禁止重复启动')
                        q=self.validate(row,c,True)
                        if q['volumeUUID']!=e.get('volumeUUID'):raise Blocked('卷 UUID 与重启前检查点不符')
                        if self.shutting_down:break
                        # Recheck stop markers immediately before persisting the
                        # attempt. RPC stop/prepare share this supervisor lock.
                        if self.inhibited(id) or self.protected(id):raise Blocked('启动前再次检查发现存储保护')
                        e.update(phase='restoring',attemptedBoot=boot,detail='已记录本次唯一恢复尝试');self.save(data)
                        self.host.docker_cmd(['start',c['Id']],30)
                        after=self.s.owned(row)
                        if not after or not after['State'].get('Running'):raise Blocked('Docker 未确认恢复成功；需人工检查')
                        if self.inhibited(id) or self.protected(id):
                            self.host.docker_cmd(['stop','-t','30',c['Id']],40)
                            raise Blocked('恢复中出现停止或保护请求，已停止实例')
                        e.update(phase='running',pendingBoot=None,observedBoot=boot,detail='宿主重启后已通过校验恢复')
                elif e.get('phase')=='restoring':
                    # Service crashed after the durable attempt checkpoint.
                    if c['State'].get('Running'):
                        self.validate(row,c);e.update(phase='running',pendingBoot=None,observedBoot=boot,detail='已确认中断前启动成功，不重复启动')
                    else:raise Blocked('恢复尝试中断且容器未运行；需人工检查')
                elif e.get('desired')=='running':
                    if e.get('row',{}).get('containerId')!=row.get('containerId'):raise Blocked('原容器身份变化，需人工启动确认')
                    if not c['State'].get('Running') and not self.shutting_down and self.host.available():raise Blocked('已观测到实例停止，不在当前启动周期重新拉起')
                    if c['State'].get('Running'):e.update(observedBoot=boot)
                self.save(data)
                result.append({'id':id,'phase':e['phase'],'detail':e.get('detail','')})
            except Waiting as error:
                if e is not None:e['detail']=str(error);self.save(data)
                result.append({'id':id,'phase':'waiting','detail':str(error)})
            except Exception as error:
                e=data['entries'].setdefault(id,{'desired':'stopped','phase':'blocked','row':self.row_cache(row)})
                e.update(desired='stopped',phase='blocked',pendingBoot=None,token=None,detail=str(error))
                self.inhibit(id,str(error));self.save(data)
                result.append({'id':id,'phase':'blocked','detail':str(error)})
        return result
