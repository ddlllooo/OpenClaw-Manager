#!/usr/bin/env python3
"""Online instance backup. Standard library only; never stops containers.

SQLite uses its online backup API. Regular files are copied with stability checks;
growing append-only files may use a verified prefix. This is not a global point-in-time
snapshot across independent databases/files. Symlinks are preserved, never followed.
"""
import argparse
from contextlib import closing
import datetime as dt
import os
if os.name == 'nt':
    import msvcrt
else:
    import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import tarfile
import tempfile
import time
import uuid
import subprocess
import secrets
from zoneinfo import ZoneInfo

try:
    TZ = ZoneInfo('Asia/Shanghai')
except Exception:
    TZ = dt.timezone(dt.timedelta(hours=8), 'Asia/Shanghai')
ARCHIVE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{6}-[0-9a-f]{8}\.tar\.gz(?:\.enc)?$')


def now():
    return dt.datetime.now(TZ)


def atomic_json(file, data):
    file = Path(file)
    temp = file.with_name('.' + file.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(temp), str(file))
    finally:
        if temp.exists():
            temp.unlink()


def read_json(file, fallback=None):
    try:
        return json.loads(Path(file).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return fallback


def sha256(file):
    digest = hashlib.sha256()
    with open(file, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def backup_sqlite(source, target, timeout=90, readonly=True):
    started = time.monotonic()

    def progress(status, remaining, total):
        if time.monotonic() - started > timeout:
            raise TimeoutError('SQLite 在线备份超时')

    with closing(sqlite3.connect(source.as_uri() + ('?mode=ro' if readonly else '?mode=rw'), uri=True, timeout=5)) as src:
        src.execute('PRAGMA query_only=ON')
        with closing(sqlite3.connect(str(target))) as dst:
            src.backup(dst, pages=256, progress=progress, sleep=0.05)
            dst.execute('PRAGMA journal_mode=DELETE')
            checks = dst.execute('PRAGMA integrity_check').fetchall()
            if checks != [('ok',)]:
                raise RuntimeError('SQLite 备份完整性校验失败')
    os.chmod(str(target), 0o600)


def sqlite_with_closed_fallback(source, target, stage):
    try:
        return backup_sqlite(source, target)
    except sqlite3.OperationalError as error:
        if 'unable to open database file' not in str(error):
            raise
    # A closed WAL-mode database without sidecars may need SQLite to initialize
    # them. Never do this in the instance: clone a stable database+WAL pair first.
    siblings = [source, Path(str(source) + '-wal'), Path(str(source) + '-journal')]

    def signatures():
        return {file.name: (file.stat().st_ino, file.stat().st_size, file.stat().st_mtime_ns)
                for file in siblings if file.exists()}

    with tempfile.TemporaryDirectory(prefix='.sqlite-input-', dir=str(stage)) as temp:
        private = Path(temp) / source.name
        for attempt in range(3):
            before = signatures()
            for sibling in siblings:
                copied = Path(temp) / sibling.name
                if copied.exists():
                    copied.unlink()
                if sibling.exists():
                    copy_regular(sibling, copied)
            after = signatures()
            if before == after:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError('数据库持续变化，无法建立稳定的只读副本')
        # Read/write initialization is restricted to the private copy, with all
        # committed WAL records retained. The original database is never opened RW.
        return backup_sqlite(private, target, readonly=False)


def copy_regular(source, target):
    """Retry replacements/in-place writes; allow only verified append-only growth."""
    for attempt in range(3):
        with source.open('rb') as src, target.open('wb') as dst:
            before = os.fstat(src.fileno())
            remaining = before.st_size
            digest = hashlib.sha256()
            while remaining:
                block = src.read(min(1024 * 1024, remaining))
                if not block:
                    break
                dst.write(block)
                digest.update(block)
                remaining -= len(block)
            after = os.fstat(src.fileno())
            current = source.stat()
            unchanged = (not remaining and before.st_ino == current.st_ino and
                         before.st_size == after.st_size == current.st_size and
                         before.st_mtime_ns == after.st_mtime_ns == current.st_mtime_ns)
            if unchanged:
                os.chmod(str(target), stat.S_IMODE(before.st_mode))
                return 'stable'
            if not remaining and before.st_ino == current.st_ino and after.st_size > before.st_size:
                src.seek(0)
                prefix = hashlib.sha256()
                remaining = before.st_size
                while remaining:
                    block = src.read(min(1024 * 1024, remaining))
                    if not block:
                        break
                    prefix.update(block)
                    remaining -= len(block)
                if not remaining and prefix.digest() == digest.digest():
                    os.chmod(str(target), stat.S_IMODE(before.st_mode))
                    return 'verified-append-prefix'
        time.sleep(0.1)
    raise RuntimeError('文件持续变化，未发布不完整备份：' + str(source.name))


def inventory(source):
    result = {}

    def walk(directory):
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            path = Path(entry.path)
            relative = path.relative_to(source).as_posix()
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                result[relative] = {'kind': 'symlink', 'target': os.readlink(str(path))}
            elif stat.S_ISDIR(info.st_mode):
                result[relative] = {'kind': 'directory', 'mode': stat.S_IMODE(info.st_mode)}
                walk(path)
            elif stat.S_ISREG(info.st_mode):
                with path.open('rb') as stream:
                    is_db = stream.read(16) == b'SQLite format 3\x00'
                result[relative] = {'kind': 'sqlite' if is_db else 'file'}
            elif stat.S_ISSOCK(info.st_mode) or stat.S_ISFIFO(info.st_mode):
                result[relative] = {'kind': 'runtime-endpoint', 'excluded': '不可恢复的运行时 socket/FIFO'}
            else:
                raise RuntimeError('发现不支持的特殊文件：' + relative)

    walk(source)
    # SQLite backup includes committed WAL contents. Never ship stale sidecars beside it.
    for name, entry in list(result.items()):
        if entry['kind'] == 'sqlite':
            for suffix in ['-wal', '-shm', '-journal']:
                if name + suffix in result:
                    result[name + suffix] = {'kind': 'sqlite-sidecar', 'excluded': '已合并到数据库在线快照'}
    return result


def capture(source, stage, heartbeat=lambda: None):
    entries = inventory(source)
    instances = []
    for name, entry in entries.items():
        if name.count('/') == 1 and name.endswith('/instance.json'):
            record = read_json(source / name, {})
            instances.append({'id': record.get('id'), 'name': record.get('name'),
                              'directory': name.split('/')[0], 'image': record.get('image'),
                              'port': record.get('port'), 'kept': name.split('/')[0].endswith('.kept')})
    for name, entry in entries.items():
        heartbeat()
        if entry.get('excluded'):
            continue
        src = source / name
        dst = stage / 'instances' / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        if entry['kind'] == 'directory':
            dst.mkdir(exist_ok=True)
        elif entry['kind'] == 'symlink':
            dst.symlink_to(entry['target'])
        else:
            if entry['kind'] == 'sqlite':
                try:
                    sqlite_with_closed_fallback(src, dst, stage)
                except Exception as error:
                    raise RuntimeError('数据库在线备份失败（' + name + '）：' + str(error)) from error
                entry['capture'] = 'sqlite-online-backup'
            else:
                entry['capture'] = copy_regular(src, dst)
                if name.endswith('/instance.json') or name.endswith('/openclaw.json'):
                    read_json(dst)  # Detect an incomplete JSON config/record before publishing.
            entry['bytes'] = dst.stat().st_size
            entry['sha256'] = sha256(dst)
    # Registry changes imply missing instances. Fail safely instead of claiming full coverage.
    current = sorted(item.name for item in source.iterdir())
    original = sorted(name for name, entry in entries.items() if '/' not in name)
    if current != original:
        raise RuntimeError('实例目录在备份期间发生变化，请重试')
    for name, entry in sorted(entries.items(), key=lambda item: len(item[0]), reverse=True):
        if entry['kind'] == 'directory':
            os.chmod(str(stage / 'instances' / name), entry['mode'])
    return {'formatVersion': 1, 'createdAt': now().isoformat(), 'timezone': 'Asia/Shanghai',
            'source': str(source), 'method': 'online-sqlite-and-verified-files',
            'instances': instances, 'entries': entries}


def capture_sandbox_workspaces(source, stage, manifest):
    for instance in manifest['instances']:
        directory = instance['directory']
        record = read_json(source / directory / 'instance.json', {})
        if (source / directory / 'manager/security/migration.lock').exists():
            raise RuntimeError('实例正在安全迁移，备份延后重试')
        staged_record = read_json(stage / 'instances' / directory / 'instance.json', {})
        if any((staged_record.get(key) or {}) != (record.get(key) or {}) for key in ('security', 'pluginIsolation', 'channelIsolation')):
            raise RuntimeError('安全实例配置在捕获期间改变，请重试')
        security = record.get('security') or {}
        if security.get('profile') != 'ssh-sandbox-v1':
            continue
        node = os.environ.get('OPENCLAW_BACKUP_NODE') or shutil.which('node')
        if not node:
            raise RuntimeError('沙箱工作区备份需要 Node.js；未发布不完整备份')
        base = directory + '/manager/sandbox-workspace-archives'
        target = stage / 'instances' / base
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        for parent in [directory + '/manager', base]:
            manifest['entries'].setdefault(parent, {'kind': 'directory', 'mode': 0o700})
        for agent in security.get('targets', {}):
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', agent):
                raise RuntimeError('沙箱工作区标识无效')
            output = target / (agent + '.tar')
            env = {**os.environ, 'OPENCLAW_DATA_DIR': str(source)}
            subprocess.run([node, str(Path(__file__).with_name('backup-sandbox.cjs')), record['id'], agent, str(output)], env=env, check=True, capture_output=True, timeout=150)
            manifest['entries'][base + '/' + agent + '.tar'] = {'kind': 'file', 'capture': 'paused-sandbox-workspace', 'bytes': output.stat().st_size, 'sha256': sha256(output)}
        current_record = read_json(source / directory / 'instance.json', {})
        if any((current_record.get(key) or {}) != (record.get(key) or {}) for key in ('security', 'pluginIsolation', 'channelIsolation')):
            raise RuntimeError('沙箱配置在备份期间改变，请重试')


def verify_archive(archive, manifest):
    expected = {'instances/' + name: entry for name, entry in manifest['entries'].items() if not entry.get('excluded')}
    seen = set()
    with tarfile.open(str(archive), 'r:gz') as tar:
        for member in tar:
            if member.name == 'manifest.json':
                if json.load(tar.extractfile(member)) != manifest:
                    raise RuntimeError('备份清单校验不一致')
                seen.add(member.name)
            elif member.name in expected:
                entry = expected[member.name]
                if entry['kind'] in ['file', 'sqlite']:
                    digest = hashlib.sha256()
                    stream = tar.extractfile(member)
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(block)
                    if digest.hexdigest() != entry['sha256'] or member.size != entry['bytes']:
                        raise RuntimeError('归档文件内容校验失败')
                elif entry['kind'] == 'symlink' and member.linkname != entry['target']:
                    raise RuntimeError('归档符号链接校验失败')
                seen.add(member.name)
    if not set(expected).issubset(seen) or 'manifest.json' not in seen:
        raise RuntimeError('归档条目缺失')


def completed(destination):
    records = []
    for file in destination.glob('*.tar.gz*.json'):
        record = read_json(file)
        name = record.get('archive', '')
        if ARCHIVE_RE.fullmatch(name) and file.name == name + '.json' and (destination / name).is_file():
            records.append(record)
    return sorted(records, key=lambda item: item['completedAt'], reverse=True)


def prune(destination, current):
    # Only our completed daily archives. Never touch pre-fix or unrelated backups.
    cutoff = current.date() - dt.timedelta(days=6)
    kept_dates = set()
    removed = []
    for record in completed(destination):
        date = dt.date.fromisoformat(record['date'])
        if date >= cutoff and date not in kept_dates:
            kept_dates.add(date)
            continue
        archive = destination / record['archive']
        if archive.is_symlink() or archive.parent.resolve() != destination.resolve():
            raise RuntimeError('拒绝清理异常备份路径')
        archive.unlink()
        archive.with_name(archive.name + '.json').unlink()
        removed.append(archive.name)
    return removed


def crypto_transform(mode, source, target, key):
    node = os.environ.get('OPENCLAW_BACKUP_NODE') or shutil.which('node')
    if not node:
        raise RuntimeError('加密备份需要 Node.js；请设置 OPENCLAW_BACKUP_NODE，未生成明文备份')
    subprocess.run([node, str(Path(__file__).with_name('backup_crypto.cjs')), mode, str(source), str(target), str(key)], check=True, capture_output=True, timeout=1800)


def backup_key(source, destination):
    key = Path(os.environ.get('OPENCLAW_BACKUP_KEY_FILE') or str(source.parent / 'backup-keys' / 'key')).absolute()
    if key.is_symlink():
        raise RuntimeError('备份密钥不能是符号链接')
    resolved = key.resolve()
    if resolved == source or source in resolved.parents or resolved == destination or destination in resolved.parents:
        raise RuntimeError('备份密钥必须位于实例目录和备份目录之外')
    key.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not key.exists():
        if any(destination.glob('*.tar.gz.enc')):
            raise RuntimeError('备份密钥缺失；禁止生成新密钥覆盖原有恢复能力')
        with key.open('xb') as stream:
            os.chmod(str(key), 0o600)
            stream.write(secrets.token_bytes(32))
            stream.flush()
            os.fsync(stream.fileno())
    if key.stat().st_size != 32:
        raise RuntimeError('备份密钥无效；保留旧备份，未自动替换密钥')
    return key


def run(source, destination, scheduled=False):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_dir() or source == destination or source in destination.parents:
        raise ValueError('备份源不存在或备份目录位于实例数据目录内')
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(str(destination), 0o700)
    state_file = destination / 'status.json'
    lock = (destination / '.backup.lock').open('a+')
    os.chmod(str(destination / '.backup.lock'), 0o600)
    try:
        if os.name == 'nt':
            lock.seek(0)
            if not lock.read(1):
                lock.write('0')
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, PermissionError):
        lock.close()
        return {'skipped': 'already-running'}
    state = read_json(state_file, {})
    if scheduled and (state.get('lastSuccess') or {}).get('date') == now().date().isoformat():
        lock.close()
        return {'skipped': 'already-backed-up-today'}
    started = now()
    state.update({'state': 'running', 'startedAt': started.isoformat(), 'pid': os.getpid(), 'lastError': None})
    atomic_json(state_file, state)
    stage = None
    last_heartbeat = [0]

    def heartbeat():
        if time.monotonic() - last_heartbeat[0] > 10:
            state['heartbeatAt'] = now().isoformat()
            atomic_json(state_file, state)
            last_heartbeat[0] = time.monotonic()

    try:
        # Interrupted staging directories contain no published backup; clear only our
        # own verified directories, while holding the inter-process backup lock.
        for stale in destination.glob('.in-progress-*'):
            if stale.is_dir() and not stale.is_symlink() and stale.parent.resolve() == destination:
                shutil.rmtree(str(stale))
        # SQLite snapshots + staging + final compressed file; conservatively require 2x source.
        size = sum(path.stat().st_size for path in source.rglob('*') if path.is_file() and not path.is_symlink())
        if shutil.disk_usage(str(destination)).free < max(size * 2, 512 * 1024 * 1024):
            raise RuntimeError('备份磁盘空间不足，旧备份已保留')
        stage = Path(tempfile.mkdtemp(prefix='.in-progress-', dir=str(destination)))
        manifest = capture(source, stage, heartbeat)
        capture_sandbox_workspaces(source, stage, manifest)
        atomic_json(stage / 'manifest.json', manifest)
        name = started.strftime('%Y-%m-%dT%H%M%S') + '-' + uuid.uuid4().hex[:8] + '.tar.gz'
        temporary = stage / 'archive.tar.gz'
        with tarfile.open(str(temporary), 'w:gz', compresslevel=1, dereference=False) as archive:
            archive.add(str(stage / 'instances'), arcname='instances', recursive=True)
            archive.add(str(stage / 'manifest.json'), arcname='manifest.json')
        heartbeat()
        verify_archive(temporary, manifest)
        record = {'archive': name, 'date': started.date().isoformat(), 'completedAt': now().isoformat(),
                  'bytes': temporary.stat().st_size, 'sha256': sha256(temporary),
                  'instanceCount': len(manifest['instances']),
                  'fileCount': sum('sha256' in item for item in manifest['entries'].values()),
                  'databaseCount': sum(item['kind'] == 'sqlite' for item in manifest['entries'].values()),
                  'durationSeconds': round((now() - started).total_seconds(), 2)}
        key = backup_key(source, destination)
        encrypted = stage / 'archive.tar.gz.enc'
        crypto_transform('encrypt', temporary, encrypted, key)
        verified = stage / 'verify.tar.gz'
        crypto_transform('decrypt', encrypted, verified, key)
        if sha256(verified) != sha256(temporary):
            raise RuntimeError('加密备份回读校验失败')
        temporary = encrypted
        name += '.enc'
        record.update(archive=name, bytes=temporary.stat().st_size, sha256=sha256(temporary), encryption='AES-256-GCM', format='OCBK1')
        os.chmod(str(temporary), 0o600)
        with temporary.open('r+b') as stream:
            os.fsync(stream.fileno())
        os.replace(str(temporary), str(destination / name))
        atomic_json(destination / (name + '.json'), record)
        state.update({'state': 'success', 'finishedAt': now().isoformat(), 'lastSuccess': record,
                      'lastError': None, 'pid': None})
        atomic_json(state_file, state)
        removed = prune(destination, now())
        state['prunedArchives'] = removed
        atomic_json(state_file, state)
        return state
    except Exception as error:
        state.update({'state': 'failed', 'finishedAt': now().isoformat(), 'pid': None,
                      'lastError': '备份失败，请检查密钥、运行环境、磁盘空间和文件权限；旧备份已保留'})
        atomic_json(state_file, state)
        raise
    finally:
        if stage:
            # stage is a fresh tempfile immediately under the validated backup root.
            if stage.parent.resolve() != destination or not stage.name.startswith('.in-progress-'):
                raise RuntimeError('拒绝清理非临时备份目录')
            shutil.rmtree(str(stage))
        lock.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    parser.add_argument('--scheduled', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if hasattr(os, 'getpriority'):
            priority = os.getpriority(os.PRIO_PROCESS, 0)
            if priority < 10:
                os.nice(10 - priority)
        result = run(args.source, args.destination, args.scheduled)
        print(json.dumps({'state': result.get('state'), 'skipped': result.get('skipped'),
                          'lastSuccess': result.get('lastSuccess')}, ensure_ascii=False))
    except Exception as error:
        print('Backup failed: check key, runtime, storage and permissions; previous backups retained.', file=__import__('sys').stderr)
        raise SystemExit(1)
