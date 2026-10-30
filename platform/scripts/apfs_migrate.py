#!/usr/bin/env python3
"""Offline APFS provisioning/migration. Root CLI only; no web command interface.

prepare -> switch -> commit. Rollback preserves the new volume, including new
writes, and refuses a lossy rollback unless the operator explicitly archives it.
All recovery journals live outside the quota. No existing volume is erased.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
from apfs_quota import Backend, BASE, MARKER, command, containers, find_volume, filesystem_info, info, registry_path
from storage_quota import QuotaError, safe
VOLUME_METADATA={'.Spotlight-V100','.fseventsd','.Trashes','.TemporaryItems','.metadata_never_index'}


def write(file, value, mode=0o600):
    file = safe(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temp = file.with_name(file.name + '.new-' + secrets.token_hex(8))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.flush(); os.fsync(output.fileno())
        os.chmod(temp, mode); os.replace(temp, file)
    finally:
        if temp.exists(): temp.unlink()


def manifest(root):
    """No link traversal. Exact content/links/modes/ownership/xattrs/hardlinks."""
    result = {}; links = {}; device = root.stat().st_dev
    def visit(file):
        s = file.lstat(); name = file.relative_to(root).as_posix()
        if s.st_dev != device: raise QuotaError('迁移数据包含跨卷路径')
        row = {'mode': stat.S_IMODE(s.st_mode), 'uid': s.st_uid, 'gid': s.st_gid}
        if stat.S_ISLNK(s.st_mode): row.update(kind='link', target=os.readlink(file))
        elif stat.S_ISDIR(s.st_mode):
            row['kind'] = 'directory'
            for child in sorted(file.iterdir()): visit(child)
        elif stat.S_ISREG(s.st_mode):
            h = hashlib.sha256()
            with file.open('rb') as source:
                for chunk in iter(lambda: source.read(1024*1024), b''): h.update(chunk)
            row.update(kind='file', size=s.st_size, sha256=h.hexdigest())
            if s.st_nlink > 1:
                key=(s.st_dev,s.st_ino); row['hardlink']=links.setdefault(key,name)
        else: raise QuotaError('迁移数据包含特殊文件，需先停机处理')
        if hasattr(os,'listxattr'):
            row['xattrs']={n:hashlib.sha256(os.getxattr(file,n,follow_symlinks=False)).hexdigest()
                           for n in os.listxattr(file,follow_symlinks=False)}
        result[name]=row
    for file in sorted(root.iterdir()):
        if file.name not in VOLUME_METADATA:visit(file)
    return result


class Migration:
    def __init__(self, root, id, registry=None):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', id): raise QuotaError('实例 ID 无效')
        self.root=safe(root); self.id=id; self.target=safe(self.root/id)
        self.backend=Backend(root,registry); self.registry=self.backend.registry
        stamp=hashlib.sha256(str(self.root).encode()).hexdigest()[:24]
        self.home=BASE/'journals'/stamp/id
        self.file=self.home/'journal.json'
        self.state=self.root.parent/'storage'/(id+'.json')

    @contextlib.contextmanager
    def lock(self):
        import fcntl
        BASE.mkdir(parents=True,exist_ok=True); os.chmod(BASE,0o755)
        lock=safe(BASE/'migration.lock')
        with lock.open('a') as f:
            fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            yield

    def journal(self): return json.loads(self.file.read_text())
    def save(self,j,phase): j['phase']=phase;write(self.file,j)
    def storage_state(self,value):
        self.state.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        os.chown(self.state.parent,501,20)
        write(self.state,value);os.chown(self.state,501,20)
    def registry_entry(self, entry):
        entries=self.backend.entries()
        if entry is None: entries.pop(self.id,None)
        else: entries[self.id]=entry
        write(self.registry,entries,0o644)

    def docker(self,args):
        return command(['/usr/local/bin/docker','--host','unix:///Users/livzon/.docker/run/docker.sock',*args],180)

    def stopped(self):
        ids=self.docker(['ps','-aq','--filter','label=openclaw.instance='+self.id]).decode().split()
        for id in ids:
            row=json.loads(self.docker(['inspect',id]))[0]
            if row['State'].get('Running') or row['State'].get('Paused') or row['State'].get('Restarting'):
                raise QuotaError('必须先停止实例及关联容器')

    def prepare(self,hard_bytes):
        if self.file.exists() and self.journal().get('phase')=='rolled-back':
            os.rename(self.home,self.home.with_name(self.id+'.attempt-'+str(time.time_ns())))
        if self.file.exists() or self.id in self.backend.entries(): raise QuotaError('已有迁移记录，禁止覆盖；请检查或回滚')
        if type(hard_bytes) is not int or hard_bytes<256*1024**2: raise QuotaError('APFS 卷额度至少 256 MiB')
        record=json.loads((self.target/'instance.json').read_text())
        old=json.loads(self.state.read_text()) if self.state.exists() else None
        if old and (old.get('blocked') or old.get('recovery') or old.get('migration') or old.get('policy',{}).get('mode')=='hard'):raise QuotaError('实例存在存储保护或硬配额，请先人工核对')
        if record.get('id')!=self.id or any(record.get(n) for n in ['security','pluginIsolation','channelIsolation']): raise QuotaError('实例身份不符或含独立执行卷')
        if os.path.ismount(self.target): raise QuotaError('实例目录已是挂载点，拒绝覆盖')
        if any((self.target/n).exists() or (self.target/n).is_symlink() for n in VOLUME_METADATA):raise QuotaError('实例包含 APFS 卷保留目录名，请先离线整理')
        for folder in ['openclaw','workspace','auth']:
            directory=safe(self.target/folder)
            if not directory.is_dir() or directory.stat().st_dev!=self.target.stat().st_dev:raise QuotaError('实例数据挂载源必须是同卷的真实目录')
        if any((self.target/n/MARKER).exists() or (self.target/n/MARKER).is_symlink() for n in ['', 'openclaw','workspace','auth']): raise QuotaError('实例存在未登记卷标记')
        parent=filesystem_info(self.root)
        container=next(c for c in containers() if c['ContainerReference']==parent['APFSContainerReference'])
        if container['CapacityFree'] < hard_bytes+10*1024**3: raise QuotaError('宿主余量不足以保留额度及系统预留')
        self.home.mkdir(parents=True,mode=0o700);os.chmod(self.home,0o700)
        staging=Path('/Volumes')/('oc-'+self.id+'-'+secrets.token_hex(4))
        if staging.exists(): raise QuotaError('暂存挂载点已存在')
        staging.mkdir(mode=0o700)
        j={'id':self.id,'path':str(self.target),'hardBytes':hard_bytes,'staging':str(staging),'volumePath':str(staging),
           'backup':str(self.home/'original'),'containerUUID':container['APFSContainerUUID'],
           'oldStorage':json.loads(self.state.read_text()) if self.state.exists() else None,
           'originalContainerId':record.get('containerId'),'createdAt':time.time()}
        self.save(j,'creating')
        known={v['APFSVolumeUUID'] for v in container['Volumes']}
        # addVolume on this macOS has no -plist option. Discover the new UUID
        # from the structured APFS inventory, never parse localized text.
        command(['/usr/sbin/diskutil','apfs','addVolume',container['ContainerReference'],'APFSX',
                 'oc-'+self.id,'-quota',str(hard_bytes),'-nomount'])
        fresh=[v for c in containers() if c['APFSContainerUUID']==container['APFSContainerUUID']
               for v in c['Volumes'] if v['APFSVolumeUUID'] not in known and v['Name']=='oc-'+self.id]
        if len(fresh)!=1: raise QuotaError('创建卷身份无法唯一识别，保留日志等待人工核对')
        j['volumeUUID']=fresh[0]['APFSVolumeUUID'];self.save(j,'created')
        if fresh[0].get('CapacityQuota')!=hard_bytes:raise QuotaError('创建卷的实际额度不符')
        command(['/usr/sbin/diskutil','mount','-mountPoint',str(staging),j['volumeUUID']])
        (staging/'.metadata_never_index').touch()
        command(['/usr/bin/mdutil','-i','off',str(staging)])
        os.chown(staging,501,20);os.chmod(staging,0o700)
        challenge=safe(staging/'.openclaw-share-probe')
        challenge.write_text(j['volumeUUID']);os.chmod(challenge,0o444)
        probe_image=json.loads(self.docker(['inspect','openclaw-manager']))[0]['Image']
        try:
            code="const f=require('fs');if(f.readFileSync('/probe/.openclaw-share-probe','utf8')!==process.argv[1])process.exit(2);"
            self.docker(['run','--rm','--network','none','--read-only','--user','501:20','--cap-drop','ALL',
                         '--label','openclaw.storage.probe=true','--mount','type=bind,source='+str(staging)+',target=/probe,readonly,consistency=consistent',
                         '--entrypoint','node',probe_image,'-e',code,j['volumeUUID']])
        finally:challenge.unlink()
        j['dockerShareVerified']=True
        self.save(j,'prepared')
        return {k:j[k] for k in ['id','phase','volumeUUID','hardBytes','volumePath']}

    def switch(self):
        j=self.journal()
        if j['phase']!='prepared': raise QuotaError('迁移阶段不允许切换')
        self.stopped()
        current=json.loads(self.state.read_text()) if self.state.exists() else {'policy':{'limitGiB':0,'mode':'soft'}}
        current['migration']={'phase':'copying','volumeUUID':j['volumeUUID']}
        current['blocked']={'reason':'APFS 数据迁移中','at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
        self.storage_state(current)
        self.save(j,'copying')
        staging=Path(j['staging']);before=manifest(self.target)
        if sum(r.get('size',0) for r in before.values()) > j['hardBytes']*.7: raise QuotaError('目标配额缺少迁移和运行余量')
        command(['/usr/bin/ditto','--noclone','--rsrc','--extattr','--acl',str(self.target),str(staging)],600)
        after=manifest(staging)
        if before!=after or manifest(self.target)!=before:
            changes=[{'path':n,'fields':[k for k in set(before.get(n,{}))|set(after.get(n,{})) if before.get(n,{}).get(k)!=after.get(n,{}).get(k)]} for n in sorted(set(before)|set(after)) if before.get(n)!=after.get(n)]
            write(self.home/'copy-differences.json',changes)
            raise QuotaError('迁移副本校验失败，原目录保留；差异：'+json.dumps(changes[:5],ensure_ascii=False))
        write(self.home/'manifest.json',before)
        self.save(j,'copied')
        # Journal intent BEFORE the rename; rollback detects both locations.
        self.save(j,'switching')
        os.rename(self.target,j['backup'])
        self.target.mkdir(mode=0o000)
        os.chown(staging,501,20);os.chmod(staging,0o700)
        for folder in ['', 'openclaw','workspace','auth']:
            marker=safe(staging/folder/MARKER)
            marker.write_text(j['volumeUUID']+'\n');os.chmod(marker,0o444)
        self.registry_entry({'path':str(self.target),'volumeUUID':j['volumeUUID'],'containerUUID':j['containerUUID'],
                             'hardBytes':j['hardBytes'],'phase':'active','volumePath':str(staging)})
        verified=self.backend.status(self.id,True)
        current.update(policy={'mode':'hard','limitGiB':j['hardBytes']/1024**3,'warnPercent':80,'admissionPercent':90,
                               'stopPercent':95,'minFreeGiB':1,'drainSeconds':30,'hardInodes':100000},
                       hard={'phase':'verified','backend':'apfs-volume','hardBytes':j['hardBytes'],
                             'hardInodes':None,'volumeUUID':j['volumeUUID'],'mountpoint':str(staging)})
        current.pop('drain',None);current['migration']['phase']='switched'
        self.storage_state(current)
        self.save(j,'switched')
        return {'id':self.id,'phase':'switched','quota':verified,'backup':j['backup']}

    def commit(self):
        j=self.journal()
        if j['phase']!='switched': raise QuotaError('迁移阶段不允许提交')
        self.stopped();self.backend.status(self.id,True)
        current=json.loads(self.state.read_text());current.pop('migration',None);current.pop('drain',None);current['blocked']=None
        self.storage_state(current)
        self.save(j,'committed')
        return {'id':self.id,'phase':'committed','backup':j['backup']}

    def rollback(self,archive_new=False,force_unmount=False):
        j=self.journal();self.stopped();backup=Path(j['backup'])
        # Restoring after accepted business writes requires explicit archival.
        if j['phase']=='committed' and not archive_new: raise QuotaError('已提交迁移可能含新写入；回滚必须显式 --archive-new，保留新卷供增量恢复')
        if j['phase']=='rolled-back': return {'id':self.id,'phase':'rolled-back'}
        _,v=find_volume(j['volumeUUID']);mounted=info(v['DeviceIdentifier']).get('MountPoint')
        if mounted:
            if mounted not in [str(self.target),j['staging']]: raise QuotaError('卷挂载到未知路径，拒绝卸载')
            if force_unmount:
                manager=json.loads(self.docker(['inspect','openclaw-manager']))[0]
                if manager['State'].get('Running'):raise QuotaError('强制卸载前必须先停止 Manager；该实例关联容器也必须全部停止')
            command(['/usr/sbin/diskutil','unmount',*(['force'] if force_unmount else []),j['volumeUUID']])
        self.registry_entry(None)
        if backup.exists():
            if self.target.exists():
                if any(self.target.iterdir()): raise QuotaError('底层实例目录非空，保留两份数据等待人工核对')
                self.target.rmdir()
            os.rename(backup,self.target)
        if not (self.target/'instance.json').is_file(): raise QuotaError('原始数据未找到；保持锁定')
        if j['oldStorage'] is None:
            if self.state.exists():self.state.unlink()
        else:self.storage_state(j['oldStorage'])
        self.save(j,'rolled-back')
        return {'id':self.id,'phase':'rolled-back','newVolumeRetained':j['volumeUUID'],'requiresManualStart':True}


def reconcile(root,registry=None):
    b=Backend(root,registry);result=[]
    for id,entry in b.entries().items():
        if entry.get('phase')!='active':continue
        control=safe(Path(root)/id)
        if entry.get('path')!=str(control):raise QuotaError('挂载登记路径不符')
        target=safe(entry.get('volumePath',str(control)))
        if target!=control and not re.fullmatch('/Volumes/oc-'+re.escape(id)+r'-[a-f0-9]{8}',str(target)):raise QuotaError('挂载登记路径不属于实例')
        _,volume=find_volume(entry['volumeUUID']);actual=info(volume['DeviceIdentifier'])
        if actual.get('MountPoint') and actual['MountPoint']!=str(target):
            if actual['MountPoint']!='/Volumes/'+volume['Name'] or volume['Name']!='oc-'+id:raise QuotaError('卷挂载在非预期位置，拒绝自动移动')
            command(['/usr/sbin/diskutil','unmount',entry['volumeUUID']])
            actual=info(volume['DeviceIdentifier'])
        if not actual.get('MountPoint'):
            if target.exists() and (target.is_symlink() or any(target.iterdir())):raise QuotaError('挂载点非空，禁止覆盖')
            target.mkdir(exist_ok=True,mode=0o000)
            command(['/usr/sbin/diskutil','mount','-mountPoint',str(target),entry['volumeUUID']])
        b.status(id)
        result.append({'id':id,'mounted':True,'volumeUUID':entry['volumeUUID']})
    return result


def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','switch','commit','rollback','status','mount'])
    p.add_argument('--root',required=True);p.add_argument('--id');p.add_argument('--bytes',type=int);p.add_argument('--registry');p.add_argument('--archive-new',action='store_true');p.add_argument('--force-unmount',action='store_true');a=p.parse_args()
    if sys.platform!='darwin' or os.geteuid()!=0:raise QuotaError('APFS 迁移工具仅允许 macOS 管理员离线执行')
    if a.action=='mount':
        with Migration(a.root,'mount-lock',a.registry).lock(): result=reconcile(a.root,a.registry)
    else:
        m=Migration(a.root,a.id or '',a.registry)
        with m.lock():
            if a.action=='prepare':result=m.prepare(a.bytes)
            elif a.action=='rollback':result=m.rollback(a.archive_new,a.force_unmount)
            elif a.action=='status':result={k:v for k,v in m.journal().items() if k not in ['oldStorage']}
            else:result=getattr(m,a.action)()
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    try:main()
    except Exception as e:print(json.dumps({'error':str(e)},ensure_ascii=False));sys.exit(1)
