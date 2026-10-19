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
        with tarfile.open(str(self.destination / record['archive'])) as archive:
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
        self.assertEqual(len(list(self.destination.glob('*.tar.gz'))), 1)

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
        self.assertFalse(list(self.destination.glob('*.tar.gz')))

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
