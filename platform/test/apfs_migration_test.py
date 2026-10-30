import json
from pathlib import Path
import sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
import apfs_migrate as m


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        home=Path(self.tmp.name).resolve();self.target=home/'instance';self.backup=home/'original'
        self.backup.mkdir();(self.backup/'instance.json').write_text('{"id":"fixture"}')
        (self.backup/'remember').write_text('original data')
        self.obj=object.__new__(m.Migration);o=self.obj
        o.id='fixture';o.target=self.target;o.home=home;o.file=home/'journal.json';o.state=home/'storage/fixture.json'
        o.stopped=lambda:None;o.registry_entry=lambda _:None
        self.j={'phase':'switching','id':'fixture','backup':str(self.backup),'volumeUUID':'test','staging':str(home/'stage'),'oldStorage':None}
        self.save()
        self.addCleanup(patch.stopall)
        patch.object(m,'find_volume',return_value=({}, {'DeviceIdentifier':'test'})).start()
        patch.object(m,'info',return_value={}).start()

    def save(self):self.obj.file.write_text(json.dumps(self.j))
    def test_crash_after_original_rename_restores_original(self):
        result=self.obj.rollback();self.assertEqual(result['phase'],'rolled-back')
        self.assertEqual((self.target/'remember').read_text(),'original data')
    def test_empty_underlying_mountpoint_is_removed_before_restore(self):
        self.target.mkdir();self.obj.rollback();self.assertTrue((self.target/'instance.json').is_file())
    def test_nonempty_underlying_directory_never_overwrites_original(self):
        self.target.mkdir();(self.target/'new').write_text('keep')
        with self.assertRaises(m.QuotaError):self.obj.rollback()
        self.assertTrue((self.backup/'remember').is_file());self.assertTrue((self.target/'new').is_file())
    def test_committed_rollback_requires_explicit_new_data_archival(self):
        self.j['phase']='committed';self.save()
        with self.assertRaisesRegex(m.QuotaError,'archive-new'):self.obj.rollback()
        self.assertTrue(self.backup.exists())
    def test_repeated_rollback_is_idempotent(self):
        self.obj.rollback();self.assertEqual(self.obj.rollback()['phase'],'rolled-back')


if __name__=='__main__':unittest.main(verbosity=2)
