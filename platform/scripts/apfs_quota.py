#!/usr/bin/env python3
"""Read-only APFS quota verification. Provisioning is an offline admin tool.

The unprivileged mailbox cannot mount, format, resize or delete any volume.
The root-owned registry binds a fixed instance root to APFS volume UUIDs.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import sys
from storage_quota import Backend as XFSBackend, QuotaError, safe

BASE = Path('/Library/Application Support/OpenClaw/APFS')
MARKER = '.openclaw-volume-id'
VOLUME_METADATA={'.Spotlight-V100','.fseventsd','.Trashes','.TemporaryItems','.metadata_never_index'}


def registry_path(root):
    return BASE / (hashlib.sha256(str(Path(root).absolute()).encode()).hexdigest()[:24] + '.json')


def command(args, timeout=60):
    p = subprocess.run(args, capture_output=True, timeout=timeout)
    if p.returncode:
        raise QuotaError('APFS 宿主命令失败：' + p.stderr.decode(errors='replace')[-400:])
    return p.stdout


def info(target):
    return plistlib.loads(command(['/usr/sbin/diskutil', 'info', '-plist', str(target)]))


def containers():
    return plistlib.loads(command(['/usr/sbin/diskutil', 'apfs', 'list', '-plist']))['Containers']


def find_volume(uuid):
    for container in containers():
        for volume in container['Volumes']:
            if volume.get('APFSVolumeUUID') == uuid:
                return container, volume
    raise QuotaError('已登记的 APFS 卷不存在；禁止回退到普通目录')


def read_registry(file):
    file = safe(file)
    if not file.exists():
        return {}
    for p in [file, *file.parents]:
        s = p.stat()
        if s.st_uid != 0 or s.st_mode & 0o022:
            raise QuotaError('APFS 登记文件或父目录必须由 root 持有且不可被普通用户改写')
    result = json.loads(file.read_text())
    if not isinstance(result, dict):
        raise QuotaError('APFS 卷登记损坏')
    return result


class Backend(XFSBackend):
    def __init__(self, root, registry=None):
        self.root = safe(root)
        self.registry = safe(registry or registry_path(root))
        if self.registry.is_relative_to(self.root.parent):
            raise QuotaError('APFS 卷登记必须位于 Manager 数据目录之外')

    def entries(self):
        return read_registry(self.registry)

    def identity(self, id):
        if not isinstance(id, str) or not __import__('re').fullmatch(r'[a-zA-Z0-9_-]{1,80}', id):
            raise QuotaError('实例 ID 无效')
        control = safe(self.root / id)
        entry = self.entries().get(id)
        if not entry or entry.get('path') != str(control) or entry.get('phase') != 'active':
            raise QuotaError('实例未完成 APFS 独立卷迁移；请使用离线迁移工具')
        target=safe(entry.get('volumePath',str(control)))
        if target!=control and not __import__('re').fullmatch('/Volumes/oc-'+__import__('re').escape(id)+r'-[a-f0-9]{8}',str(target)):
            raise QuotaError('APFS 卷路径不属于该实例')
        container, volume = find_volume(entry['volumeUUID'])
        actual = info(volume['DeviceIdentifier'])
        if actual.get('FilesystemType') != 'apfs' or actual.get('VolumeUUID') != entry['volumeUUID']:
            raise QuotaError('APFS 卷身份校验失败')
        if container['APFSContainerUUID'] != entry['containerUUID']:
            raise QuotaError('APFS 容器身份与登记不符')
        if actual.get('MountPoint') != str(target) or not os.path.ismount(target):
            raise QuotaError('APFS 卷未挂载到实例目录；禁止使用底层普通目录')
        if target.stat().st_dev == self.root.stat().st_dev:
            raise QuotaError('实例路径未处于独立文件系统')
        if volume.get('CapacityQuota') != entry['hardBytes'] or entry['hardBytes'] <= 0:
            raise QuotaError('APFS 实际容量上限与登记不符')
        for folder in ['', 'openclaw', 'workspace', 'auth']:
            directory = safe(target / folder)
            if not directory.is_dir() or directory.stat().st_dev != target.stat().st_dev:
                raise QuotaError('APFS 数据挂载目录缺失或跨卷')
            marker = safe(directory / MARKER)
            if marker.read_text().strip() != entry['volumeUUID']:
                raise QuotaError('APFS 挂载标记不符')
        record = json.loads(safe(target / 'instance.json').read_text())
        if record.get('id') != id:
            raise QuotaError('实例记录与 APFS 卷不符')
        if record.get('security') or record.get('pluginIsolation') or record.get('channelIsolation'):
            raise QuotaError('含独立执行卷的实例尚不支持完整 APFS 容量保护')
        return target, entry, container, volume

    def probe(self, id):
        result = {'supported': False, 'backend': 'apfs-volume', 'platform': sys.platform,
                  'scope': 'instance-volume', 'inodeQuota': False, 'provisioned': False}
        try:
            if sys.platform != 'darwin':
                raise QuotaError('APFS 独立卷后端仅支持 macOS 宿主')
            parent = filesystem_info(self.root)
            if parent.get('FilesystemType') != 'apfs':
                # diskutil accepts mount points, not arbitrary subdirectories.
                raise QuotaError('实例根目录所在文件系统不是 APFS')
            result.update(supported=True, reason='需使用离线工具创建并迁移独立配额卷')
            if id in self.entries():
                _, entry, _, _ = self.identity(id)
                result.update(provisioned=True, volumeUUID=entry['volumeUUID'], reason=None)
        except Exception as e:
            result.update(supported=False, reason=str(e))
        return result

    def status(self, id, full=False):
        target, entry, container, volume = self.identity(id)
        if full:
            device = target.stat().st_dev
            def error(e): raise e
            for directory, dirs, files in os.walk(target, followlinks=False, onerror=error):
                if Path(directory)==target:
                    dirs[:]=[n for n in dirs if n not in VOLUME_METADATA]
                    files=[n for n in files if n not in VOLUME_METADATA]
                for name in dirs + files:
                    s = (Path(directory) / name).lstat()
                    if s.st_dev != device:
                        raise QuotaError('实例包含未计入额度的跨卷路径')
                    if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode)):
                        raise QuotaError('实例包含不支持维护的特殊文件')
        fs = os.statvfs(target)
        config=self.root.parent.parent/'manager-host.json'
        automatic=False
        if config.is_file() and not config.is_symlink():automatic=json.loads(config.read_text()).get('apfsAutoRecovery') is True
        return {'verified': True, 'backend': 'apfs-volume', 'volumeUUID': entry['volumeUUID'],
                'hardBytes': volume['CapacityQuota'], 'usedBytes': volume['CapacityInUse'],
                'hardInodes': None, 'usedInodes': None, 'inodeQuota': False,
                'volumeAvailable': fs.f_bavail * fs.f_frsize,
                'filesystemAvailable': container['CapacityFree'], 'mountpoint': str(target),
                'restartPolicy': 'no', 'manualStartAfterMount': not automatic, 'automaticRecovery':automatic}

    def apply(self, id, hard_bytes, hard_inodes):
        result = self.status(id, True)
        if type(hard_bytes) is not int or hard_bytes != result['hardBytes']:
            raise QuotaError('APFS 扩缩容需离线迁移到新配额卷，禁止静默修改实际限制')
        record = json.loads((Path(result['mountpoint']) / 'instance.json').read_text())
        self.require_stopped(record)
        return result


def filesystem_info(path):
    """Find the actual mount point before asking diskutil for volume info."""
    path = Path(path).absolute()
    while not os.path.ismount(path):
        path = path.parent
    return info(path)
