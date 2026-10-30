import datetime as dt
from contextlib import closing
if __import__('os').name == 'nt':
    import msvcrt
else:
    import fcntl
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('backup', Path(__file__).parents[1] / 'scripts' / 'backup_instances.py')
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'instances'
        self.destination = self.root / 'backups'
        (self.source / 'active' / 'openclaw').mkdir(parents=True)
        (self.source / 'archived.kept' / 'workspace').mkdir(parents=True)
        (self.source / 'active' / 'instance.json').write_text(json.dumps({'id':'active','name':'fixture'}))
        (self.source / 'archived.kept' / 'instance.json').write_text(json.dumps({'id':'archived','name':'kept fixture'}))
        (self.source / 'active' / 'openclaw' / 'openclaw.json').write_text('{"key":"test-secret"}')
        (self.source / 'active' / 'openclaw' / '.env').write_text('TEST_SECRET=abcde\n')
        (self.source / 'archived.kept' / 'workspace' / 'keep.txt').write_text('preserved')

    def tearDown(self):
        self.temp.cleanup()

    def test_live_wal_database_restore_and_symlink_preservation(self):
        db = self.source / 'active' / 'openclaw' / 'state.sqlite'
        conn = sqlite3.connect(str(db))
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('CREATE TABLE messages(value TEXT)')
        conn.execute("INSERT INTO messages VALUES('committed-in-wal')")
        conn.commit()
        self.assertTrue(Path(str(db) + '-wal').exists())
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'do-not-follow').write_text('outside')
        try:
            (self.source / 'active' / 'link').symlink_to(outside, target_is_directory=True)
        except OSError as error:
            conn.close()
            self.skipTest('当前 Windows 用户没有符号链接权限：' + str(error))
        result = backup.run(self.source, self.destination)
        self.assertEqual(result['state'], 'success')
        record = result['lastSuccess']
        self.assertEqual(record['instanceCount'], 2)
        self.assertEqual(record['databaseCount'], 1)
        restored = self.root / 'restored'
        restored.mkdir()
        decrypted = self.root / 'restore.tar.gz'
        backup.crypto_transform('decrypt', self.destination / record['archive'], decrypted, self.root / 'backup-keys' / 'key')
        with tarfile.open(str(decrypted)) as archive:
            manifest = json.load(archive.extractfile('manifest.json'))
            self.assertNotIn('instances/active/link/do-not-follow', archive.getnames())
            self.assertTrue(archive.getmember('instances/active/link').issym())
            self.assertNotIn('instances/active/openclaw/state.sqlite-wal', archive.getnames())
            # Extract only a known regular database file, never arbitrary symlink targets.
            payload = archive.extractfile('instances/active/openclaw/state.sqlite').read()
            (restored / 'state.sqlite').write_bytes(payload)
        with closing(sqlite3.connect(str(restored / 'state.sqlite'))) as target:
            self.assertEqual(target.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(target.execute('SELECT value FROM messages').fetchone()[0], 'committed-in-wal')
        self.assertEqual((self.source / 'active' / 'openclaw' / '.env').read_text(), 'TEST_SECRET=abcde\n')
        self.assertEqual(manifest['entries']['active/openclaw/state.sqlite-wal']['kind'], 'sqlite-sidecar')
        conn.close()

    def test_encrypted_archive_restores_database_and_missing_key_fails_closed(self):
        db = self.source / 'active' / 'state.sqlite'
        with closing(sqlite3.connect(str(db))) as conn:
            conn.execute('CREATE TABLE secrets(value TEXT)')
            conn.execute("INSERT INTO secrets VALUES('synthetic-sensitive-message')")
            conn.commit()
        result = backup.run(self.source, self.destination)
        record = result['lastSuccess']
        encrypted = self.destination / record['archive']
        self.assertTrue(record['archive'].endswith('.tar.gz.enc'))
        self.assertEqual(record['encryption'], 'AES-256-GCM')
        self.assertNotIn(b'test-secret', encrypted.read_bytes())
        key = self.root / 'backup-keys' / 'key'
        decrypted = self.root / 'restored.tar.gz'
        backup.crypto_transform('decrypt', encrypted, decrypted, key)
        with tarfile.open(str(decrypted)) as archive:
            config = archive.extractfile('instances/active/openclaw/openclaw.json').read()
            self.assertIn(b'test-secret', config)
            restored_db = self.root / 'restored.sqlite'
            restored_db.write_bytes(archive.extractfile('instances/active/state.sqlite').read())
        with closing(sqlite3.connect(str(restored_db))) as conn:
            self.assertEqual(conn.execute('SELECT value FROM secrets').fetchone()[0], 'synthetic-sensitive-message')
        key.unlink()
        with self.assertRaisesRegex(RuntimeError, '密钥缺失'):
            backup.run(self.source, self.destination)
        self.assertFalse(key.exists())
        self.assertTrue(encrypted.exists())
        self.assertFalse(list(self.destination.glob('.in-progress-*')))

    def test_sandbox_workspace_is_included_in_authenticated_backup(self):
        import io
        record = {'id': 'active', 'security': {'profile': 'ssh-sandbox-v1', 'targets': {'main': {'workerId': 'fixture'}}}}
        (self.source / 'active' / 'instance.json').write_text(json.dumps(record))
        original_run = backup.subprocess.run
        def helper(args, **kwargs):
            if str(args[1]).endswith('backup-sandbox.cjs'):
                with tarfile.open(args[-1], 'w') as archive:
                    content = b'workspace-artifact'
                    info = tarfile.TarInfo('workspaces/artifact.txt')
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
                return
            return original_run(args, **kwargs)
        with patch.object(backup.subprocess, 'run', side_effect=helper):
            result = backup.run(self.source, self.destination)
        decrypted = self.root / 'sandbox-restored.tar.gz'
        backup.crypto_transform('decrypt', self.destination / result['lastSuccess']['archive'], decrypted, self.root / 'backup-keys' / 'key')
        with tarfile.open(str(decrypted)) as archive:
            payload = archive.extractfile('instances/active/manager/sandbox-workspace-archives/main.tar').read()
        with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
            self.assertEqual(archive.extractfile('workspaces/artifact.txt').read(), b'workspace-artifact')

    def test_plugin_isolation_change_during_backup_is_not_published(self):
        record = {'id': 'active', 'security': {'profile': 'ssh-sandbox-v1', 'targets': {'main': {'workerId': 'fixture'}}},
                  'pluginIsolation': {'targets': {'fixture': {'imageId': 'old'}}}}
        record_file = self.source / 'active' / 'instance.json'
        record_file.write_text(json.dumps(record))
        original_run = backup.subprocess.run
        def helper(args, **kwargs):
            if str(args[1]).endswith('backup-sandbox.cjs'):
                with tarfile.open(args[-1], 'w'):
                    pass
                record['pluginIsolation']['targets']['fixture']['imageId'] = 'changed'
                record_file.write_text(json.dumps(record))
                return
            return original_run(args, **kwargs)
        with patch.object(backup.subprocess, 'run', side_effect=helper):
            with self.assertRaisesRegex(RuntimeError, '改变'):
                backup.run(self.source, self.destination)
        self.assertFalse(list(self.destination.glob('*.enc')))
        self.assertFalse(list(self.destination.glob('.in-progress-*')))

    def test_failed_backup_keeps_success_and_never_prunes(self):
        success = backup.run(self.source, self.destination)['lastSuccess']
        existing = self.destination / success['archive']
        with patch.object(backup, 'copy_regular', side_effect=RuntimeError('simulated file failure')):
            with self.assertRaisesRegex(RuntimeError, 'simulated'):
                backup.run(self.source, self.destination)
        state = backup.read_json(self.destination / 'status.json')
        self.assertEqual(state['state'], 'failed')
        self.assertEqual(state['lastSuccess'], success)
        self.assertTrue(existing.exists())
        self.assertFalse(list(self.destination.glob('.in-progress-*')))
        self.assertEqual(len(list(self.destination.glob('*.tar.gz.enc'))), 1)

    def test_retention_seven_calendar_days_and_latest_per_day(self):
        self.destination.mkdir()
        current = dt.datetime(2026, 10, 15, 4, 0, tzinfo=backup.TZ)
        for day in range(10):
            date = (current - dt.timedelta(days=day)).date().isoformat()
            name = date + 'T033000-1234abcd.tar.gz'
            (self.destination / name).write_bytes(b'fixture')
            backup.atomic_json(self.destination / (name + '.json'), {'archive':name,'date':date,'completedAt':date+'T03:30:00+08:00'})
        name = '2026-10-15T043000-5678abcd.tar.gz'
        (self.destination / name).write_bytes(b'newer')
        backup.atomic_json(self.destination / (name + '.json'), {'archive':name,'date':'2026-10-15','completedAt':'2026-10-15T04:30:00+08:00'})
        unrelated = self.destination / 'manual-pre-fix.tar.gz'
        unrelated.write_bytes(b'never delete unrelated')
        backup.prune(self.destination, current)
        records = backup.completed(self.destination)
        self.assertEqual(len(records), 7)
        self.assertEqual(records[0]['archive'], name)
        self.assertTrue(unrelated.exists())
        self.assertEqual(min(record['date'] for record in records), '2026-10-09')

    def test_lock_prevents_duplicate_run_without_corrupting_status(self):
        self.destination.mkdir()
        lock = (self.destination / '.backup.lock').open('a+')
        if os.name == 'nt':
            lock.write('0')
            lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = backup.run(self.source, self.destination)
        self.assertEqual(result, {'skipped':'already-running'})
        self.assertFalse((self.destination / 'status.json').exists())
        lock.close()

    def test_scheduled_success_skips_same_day_but_manual_run_replaces_safely(self):
        original = backup.run(self.source, self.destination)['lastSuccess']
        self.assertEqual(backup.run(self.source,self.destination,scheduled=True), {'skipped':'already-backed-up-today'})
        newer = backup.run(self.source,self.destination)['lastSuccess']
        self.assertNotEqual(original['archive'], newer['archive'])
        self.assertEqual(len(backup.completed(self.destination)), 1)

    def test_unreadable_database_fails_without_publishing_archive(self):
        (self.source / 'active' / 'broken.sqlite').write_bytes(b'SQLite format 3\x00' + b'not-a-database')
        with self.assertRaisesRegex(RuntimeError, '数据库在线备份失败'):
            backup.run(self.source,self.destination)
        self.assertEqual(backup.read_json(self.destination/'status.json')['state'], 'failed')
        self.assertFalse(list(self.destination.glob('*.tar.gz.enc')))

    def test_destination_cannot_recurse_into_source(self):
        with self.assertRaises(ValueError):
            backup.run(self.source, self.source / 'bad-backups')

    def test_closed_wal_readonly_failure_uses_private_copy_without_source_writes(self):
        source = self.source / 'active' / 'closed.sqlite'
        with closing(sqlite3.connect(str(source))) as conn:
            conn.execute('CREATE TABLE fixture(value TEXT)')
            conn.execute("INSERT INTO fixture VALUES('keep-me')")
            conn.commit()
        original_hash = backup.sha256(source)
        actual = backup.backup_sqlite
        calls = []

        def simulate_readonly_limitation(src, dst, **kwargs):
            calls.append((src, kwargs.get('readonly', True)))
            if src.resolve() == source.resolve():
                raise sqlite3.OperationalError('unable to open database file')
            return actual(src, dst, **kwargs)

        with patch.object(backup, 'backup_sqlite', side_effect=simulate_readonly_limitation):
            result = backup.run(self.source,self.destination)
        self.assertEqual(result['state'], 'success')
        self.assertEqual(backup.sha256(source), original_hash)
        self.assertTrue(any(not readonly and src != source for src,readonly in calls))


if __name__ == '__main__':
    unittest.main()
