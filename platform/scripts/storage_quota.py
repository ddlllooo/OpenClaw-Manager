#!/usr/bin/env python3
"""Scoped XFS project quotas. No mount, format, shell or arbitrary path API.

Kernel ABI: include/uapi/linux/{fs.h,dqblk_xfs.h}. The privileged helper only
accepts an instance ID below its administrator-configured root. Its registry
must be outside the Manager-writable data tree.
"""
import argparse
import ctypes
import errno
import hashlib
import json
import os
import platform
from pathlib import Path
import re
import secrets
import shutil
import stat
import struct
import subprocess
import sys
import tempfile

ID = re.compile(r'^[a-z0-9_-]{1,80}$', re.I)
GETXATTR = 0x801c581f
PROJINHERIT = 0x200


class QuotaError(Exception):
    status = 409


class DiskQuota(ctypes.Structure):
    _fields_ = [('version', ctypes.c_int8), ('flags', ctypes.c_int8), ('mask', ctypes.c_uint16), ('id', ctypes.c_uint32),
                ('hard', ctypes.c_uint64), ('soft', ctypes.c_uint64), ('ihard', ctypes.c_uint64), ('isoft', ctypes.c_uint64),
                ('used', ctypes.c_uint64), ('inodes', ctypes.c_uint64), ('itimer', ctypes.c_int32), ('btimer', ctypes.c_int32),
                ('iwarns', ctypes.c_uint16), ('bwarns', ctypes.c_uint16), ('timer_hi', ctypes.c_int8 * 4),
                ('rthard', ctypes.c_uint64), ('rtsoft', ctypes.c_uint64), ('rtused', ctypes.c_uint64),
                ('rttimer', ctypes.c_int32), ('rtwarns', ctypes.c_uint16), ('padding', ctypes.c_int16), ('padding4', ctypes.c_char * 8)]


def safe(path):
    path = Path(os.path.abspath(path))
    for part in [*reversed(path.parents), path]:
        if part.is_symlink():
            raise QuotaError('配额路径不能包含符号链接')
    return path


def atomic(file, value):
    file = safe(file)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=file.parent, prefix='.quota-')
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, file)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Backend:
    def __init__(self, root, registry=None):
        self.root = safe(root)
        stamp = hashlib.sha256(str(self.root).encode()).hexdigest()[:24]
        registry_path=registry or Path('/var/lib/openclaw-quota') / (stamp + '.json')
        # macOS /var is normally a symlink. A read-only unsupported-platform
        # probe must report the OS limitation before touching a Linux registry.
        self.registry = safe(registry_path) if sys.platform=='linux' else Path(os.path.abspath(registry_path))
        if self.registry.is_relative_to(self.root) or self.registry.is_relative_to(self.root.parent):
            raise QuotaError('特权配额注册表必须位于 Manager 数据目录之外')

    def run(self, args):
        result = subprocess.run(args, text=True, capture_output=True, timeout=60, env={**os.environ, 'LC_ALL': 'C'})
        if result.returncode or result.stderr.strip():
            raise QuotaError('宿主配额命令执行失败；请检查工具、权限和项目配额状态')
        return result.stdout

    def target(self, id):
        if not isinstance(id, str) or not ID.fullmatch(id):
            raise QuotaError('实例 ID 无效')
        target = safe(self.root / id)
        record = json.loads(safe(target / 'instance.json').read_text())
        if record.get('id') != id:
            raise QuotaError('实例记录与目录不符')
        if record.get('security') or record.get('pluginIsolation') or record.get('channelIsolation'):
            raise QuotaError('此实例含独立执行卷，当前 XFS 后端不能完整覆盖；不支持启用硬配额')
        return target, record

    def mount(self, target):
        value = json.loads(self.run(['findmnt', '--json', '--target', str(target), '--output', 'TARGET,FSTYPE,OPTIONS,SOURCE']))
        rows = value.get('filesystems', [])
        if len(rows) != 1:
            raise QuotaError('无法唯一识别数据文件系统')
        return rows[0]

    def attributes(self, target):
        import fcntl
        fd = os.open(safe(target), os.O_RDONLY | os.O_NOFOLLOW)
        try:
            data = fcntl.ioctl(fd, GETXATTR, bytes(28))
        finally:
            os.close(fd)
        flags, _, _, project = struct.unpack_from('=IIII', data)
        return project, bool(flags & PROJINHERIT)

    def read_quota(self, mount, project):
        libc = ctypes.CDLL(None, use_errno=True)
        # glibc does not currently expose a quotactl_fd wrapper. Linux x86-64
        # and asm-generic arm64 use syscall 443 (Linux >= 5.14).
        if platform.machine().lower() not in ['x86_64','amd64','aarch64','arm64'] or ctypes.sizeof(ctypes.c_void_p)!=8:
            raise QuotaError('当前 CPU ABI 未验证 quotactl_fd，不能宣称支持硬配额')
        row = DiskQuota()
        fd = os.open(mount['target'], os.O_RDONLY | os.O_DIRECTORY)
        try:
            if libc.syscall(ctypes.c_long(443),ctypes.c_int(fd),ctypes.c_int(((ord('X') << 8) + 3) << 8 | 2),ctypes.c_uint32(project),ctypes.byref(row)) != 0:
                if ctypes.get_errno() not in [errno.ENOENT, errno.ESRCH]:
                    raise QuotaError('无法通过内核读取项目配额')
        finally:
            os.close(fd)
        return {'projectId': project, 'hardBytes': row.hard * 512, 'usedBytes': row.used * 512,
                'hardInodes': row.ihard, 'usedInodes': row.inodes, 'softBytes': row.soft * 512, 'softInodes': row.isoft}

    def probe(self, id):
        result = {'supported': False, 'backend': 'xfs-project', 'platform': sys.platform, 'scope': 'instance-directory'}
        try:
            target, _ = self.target(id)
            if sys.platform != 'linux':
                raise QuotaError('当前宿主系统不支持 XFS 项目配额；Docker Desktop 的全局磁盘上限不是实例配额')
            if not all(shutil.which(tool) for tool in ['findmnt', 'xfs_quota', 'docker']):
                raise QuotaError('宿主缺少 findmnt、xfs_quota 或 Docker CLI')
            mount = self.mount(target)
            result['filesystem'] = mount['fstype']
            if mount['fstype'] != 'xfs':
                raise QuotaError('实例目录不在 XFS 文件系统上；未启用硬配额')
            if os.geteuid() != 0 or not int(Path('/proc/self/status').read_text().split('CapEff:')[1].split()[0], 16) & (1 << 21):
                raise QuotaError('需要有 CAP_SYS_ADMIN 的专用宿主配额服务；请勿提升业务容器权限')
            output = self.run(['xfs_quota', '-x', '-c', 'state -p', mount['target']])
            if not re.search(r'Accounting:\s+ON', output) or not re.search(r'Enforcement:\s+ON', output):
                raise QuotaError('XFS 项目配额未同时开启统计和强制执行，请由宿主管理员配置 prjquota')
            if not re.fullmatch(r'[A-Za-z0-9_./:-]+', str(target)) or not re.fullmatch(r'[A-Za-z0-9_./:-]+', mount['target']):
                raise QuotaError('当前配额后端不支持含空格或特殊字符的宿主路径')
            self.read_quota(mount, self.attributes(target)[0])
            result.update(supported=True, reason=None, mountpoint=mount['target'])
        except Exception as error:
            result['reason'] = str(error) if isinstance(error, QuotaError) else '无法安全探测宿主文件系统或实例目录'
        return result

    def registry_data(self):
        if not self.registry.exists():
            return {}
        info = self.registry.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise QuotaError('特权配额注册表归属或权限不安全')
        data = json.loads(self.registry.read_text())
        if not isinstance(data, dict):
            raise QuotaError('配额注册表损坏')
        return data

    def tree(self, target, project=None, allow_unassigned=False):
        device = target.stat().st_dev
        used_bytes=0;inodes=0
        def walk_error(error):
            raise QuotaError('无法完整读取实例目录，已拒绝修改配额') from error
        for directory, dirs, files in os.walk(target, followlinks=False, onerror=walk_error):
            for file in [Path(directory), *(Path(directory) / n for n in files)]:
                safe(file)
                info = file.lstat()
                used_bytes+=info.st_blocks*512;inodes+=1
                if info.st_dev != device or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
                    raise QuotaError('实例含跨文件系统路径、链接或特殊文件，无法完整覆盖硬配额')
                current, inherit = self.attributes(file)
                if project is not None and not (allow_unassigned and current == 0) and (current != project or (file.is_dir() and not inherit)):
                    raise QuotaError('项目配额未覆盖完整实例目录')
                if project is None and current:
                    raise QuotaError('实例已有非平台分配的项目 ID，拒绝覆盖')
            for name in dirs:
                file = safe(Path(directory) / name)
                if file.stat().st_dev != device:
                    raise QuotaError('实例含其他文件系统挂载，无法完整覆盖硬配额')
        return {'usedBytes':used_bytes,'usedInodes':inodes}

    def require_stopped(self, record):
        # Inspect the label set, not only the record's primary container.
        rows = self.run(['docker', 'ps', '-aq', '--filter', 'label=openclaw.instance=' + record['id']]).split()
        for id in rows:
            row = json.loads(self.run(['docker', 'inspect', id]))[0]
            if row.get('State', {}).get('Running') or row.get('State', {}).get('Paused') or row.get('State', {}).get('Restarting'):
                raise QuotaError('启用或修改硬配额前必须停止该实例及关联容器')

    def status(self, id, full=False):
        capability = self.probe(id)
        if not capability['supported']:
            raise QuotaError(capability['reason'])
        target, _ = self.target(id)
        entry = self.registry_data().get(id)
        if not entry or entry.get('path') != str(target) or entry.get('device') != target.stat().st_dev or entry.get('inode') != target.stat().st_ino:
            raise QuotaError('未找到匹配当前实例目录的宿主配额登记')
        project = entry['projectId']
        if type(project) is not int or not 0<project<2**31:
            raise QuotaError('配额项目 ID 登记损坏')
        for folder in [target, *(target / name for name in ['openclaw', 'workspace', 'auth'])]:
            if self.attributes(safe(folder)) != (project, True) or folder.stat().st_dev != target.stat().st_dev:
                raise QuotaError('实例挂载目录的项目 ID 或继承标志已变化')
        if full:
            self.tree(target, project)
        value = self.read_quota(self.mount(target), project)
        value.update(verified=value['hardBytes'] > 0 and value['hardBytes']==entry.get('hardBytes') and value['hardInodes']==entry.get('hardInodes'), backend='xfs-project', scope='instance-directory')
        return value

    def apply(self, id, hard_bytes, hard_inodes):
        if type(hard_bytes) is not int or not 1024**2 <= hard_bytes <= 1024**5 or hard_bytes % 4096 or type(hard_inodes) is not int or not 100 <= hard_inodes <= 100000000:
            raise QuotaError('硬配额参数无效：容量至少 1MiB 且按 4KiB 对齐，文件数至少 100')
        capability = self.probe(id)
        if not capability['supported']:
            raise QuotaError(capability['reason'])
        import fcntl
        safe(self.registry.parent).mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.registry.parent.stat().st_uid != 0 or self.registry.parent.stat().st_mode & 0o022:
            raise QuotaError('配额注册表目录必须归 root 所有且不可被其他用户写入')
        lock = safe(self.registry.with_suffix('.lock'))
        with lock.open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            target, record = self.target(id)
            self.require_stopped(record)
            entries = self.registry_data()
            entry = entries.get(id)
            mount = self.mount(target)
            if entry:
                if entry.get('path')!=str(target) or entry.get('device')!=target.stat().st_dev or entry.get('inode')!=target.stat().st_ino:
                    raise QuotaError('配额登记与当前目录身份不符，拒绝覆盖')
                self.tree(target,entry['projectId'],allow_unassigned=entry.get('phase')=='applying')
                current = self.read_quota(mount,entry['projectId'])
                if current['usedBytes'] >= hard_bytes or current['usedInodes'] >= hard_inodes:
                    raise QuotaError('新硬上限必须高于当前实际空间和文件数用量')
                project = entry['projectId']
            else:
                initial=self.tree(target)
                if initial['usedBytes']>=hard_bytes or initial['usedInodes']>=hard_inodes:
                    raise QuotaError('新硬上限必须高于当前目录已使用的空间和文件数')
                used = {v['projectId'] for v in entries.values()}
                projects=Path('/etc/projects')
                if projects.exists():
                    used.update(int(line.split(':',1)[0]) for line in projects.read_text().splitlines() if re.match(r'^\d+:',line))
                # Never reuse another administrator's project, even if not in our registry.
                project = None
                for _ in range(64):
                    candidate = secrets.randbelow(2**30) + 2**30
                    row = self.read_quota(mount, candidate)
                    if candidate not in used and not any(row[k] for k in ['hardBytes','hardInodes','softBytes','softInodes','usedBytes','usedInodes']):
                        project = candidate
                        break
                if project is None:
                    raise QuotaError('无法分配未使用的项目 ID')
                entries[id] = {'path':str(target), 'projectId':project, 'device':target.stat().st_dev, 'inode':target.stat().st_ino}
            entries[id].update(phase='applying',hardBytes=hard_bytes,hardInodes=hard_inodes)
            atomic(self.registry, entries)
            # Set limits BEFORE assigning data to this project. Never remove an
            # existing hard limit on a failed apply or failed readback.
            self.run(['xfs_quota','-x','-c',f'limit -p bsoft=0 isoft=0 bhard={hard_bytes // 1024}k ihard={hard_inodes} {project}',mount['target']])
            with tempfile.TemporaryDirectory(prefix='openclaw-quota-') as tmp:
                projects=Path(tmp)/'projects'
                projects.write_text(f'{project}:{target}\n')
                self.run(['xfs_quota','-x','-D',str(projects),'-P','/dev/null','-c',f'project -s -p {target} {project}',mount['target']])
            value = self.status(id, full=True)
            if value['hardBytes'] != hard_bytes or value['hardInodes'] != hard_inodes:
                raise QuotaError('内核读回的硬配额与请求不符，拒绝标记为生效')
            entries[id]['phase']='verified'
            atomic(self.registry, entries)
            return value

    def dispatch(self, action, body):
        allowed = {'quota-probe': {'id'}, 'quota-status': {'id','full'}, 'quota-apply': {'id','hardBytes','hardInodes'}}
        if action not in allowed or not isinstance(body, dict) or set(body) - allowed[action]:
            raise QuotaError('不支持的配额操作或字段')
        id = body.get('id')
        if action == 'quota-probe':
            return self.probe(id)
        if action == 'quota-status':
            if 'full' in body and type(body['full']) is not bool:
                raise QuotaError('校验参数无效')
            return self.status(id, body.get('full', False))
        return self.apply(id, body.get('hardBytes'), body.get('hardInodes'))


def backend(root, registry=None):
    if sys.platform == 'darwin':
        from apfs_quota import Backend as APFSBackend
        return APFSBackend(root, registry)
    return Backend(root, registry)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--registry')
    args = parser.parse_args()
    try:
        request=json.load(sys.stdin)
        print(json.dumps(backend(args.root,args.registry).dispatch(request.get('action'),request.get('body',{}))))
    except Exception as error:
        print(json.dumps({'error': str(error) if isinstance(error,QuotaError) else '宿主配额操作失败，请检查目录、权限和工具'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
