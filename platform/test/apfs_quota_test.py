import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
import apfs_quota as m
from apfs_migrate import manifest


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name).resolve();self.root=self.home/'data'/'instances';self.target=self.root/'fixture'
        self.target.mkdir(parents=True)
        for folder in ['openclaw','workspace','auth']:(self.target/folder).mkdir()
        (self.target/'instance.json').write_text('{"id":"fixture"}')
        for folder in ['', 'openclaw','workspace','auth']:(self.target/folder/m.MARKER).write_text('unit-uuid\n')
        self.backend=m.Backend(self.root,self.home/'registry.json')
        self.entry={'path':str(self.target),'phase':'active','volumeUUID':'unit-uuid','containerUUID':'container','hardBytes':1024**3}
        self.volume={'DeviceIdentifier':'disk-test','CapacityQuota':1024**3,'CapacityInUse':1024**2}
        self.container={'APFSContainerUUID':'container','CapacityFree':10*1024**3}
        self.actual={'FilesystemType':'apfs','VolumeUUID':'unit-uuid','MountPoint':str(self.target)}
        self.addCleanup(patch.stopall)
        patch.object(self.backend,'entries',return_value={'fixture':self.entry}).start()
        patch.object(m,'find_volume',return_value=(self.container,self.volume)).start()
        patch.object(m,'info',side_effect=lambda _:self.actual).start()
        patch.object(m.os.path,'ismount',return_value=True).start()
        patch.object(m.os,'statvfs',return_value=SimpleNamespace(f_bavail=100,f_frsize=4096),create=True).start()
        original=Path.stat
        root=self.root
        def stat(p,*a,**kw):
            value=original(p,*a,**kw)
            if p==root:
                parts=list(value);parts[2]+=1;return os.stat_result(parts)
            return value
        patch.object(Path,'stat',stat).start()

    def test_verified_quota_has_no_fake_inode_enforcement(self):
        r=self.backend.status('fixture',True)
        self.assertTrue(r['verified']);self.assertFalse(r['inodeQuota']);self.assertIsNone(r['hardInodes'])
        self.assertEqual(r['backend'],'apfs-volume');self.assertEqual(r['filesystemAvailable'],10*1024**3)

    def test_mount_missing_wrong_uuid_or_quota_all_fail_closed(self):
        for key,value in [('MountPoint','/wrong'),('VolumeUUID','wrong'),('FilesystemType','other')]:
            saved=self.actual[key];self.actual[key]=value
            with self.assertRaises(m.QuotaError):self.backend.status('fixture')
            self.actual[key]=saved
        self.volume['CapacityQuota']=2*1024**3
        with self.assertRaises(m.QuotaError):self.backend.status('fixture')

    def test_markers_missing_or_stale_are_rejected(self):
        (self.target/'workspace'/m.MARKER).write_text('old-volume')
        with self.assertRaises(m.QuotaError):self.backend.status('fixture')

    def test_unregistered_in_progress_and_arbitrary_requests_rejected(self):
        self.entry['phase']='copying'
        with self.assertRaises(m.QuotaError):self.backend.status('fixture')
        for a,b in [('mount',{'id':'fixture'}),('quota-status',{'id':'fixture','path':'/etc'}),('quota-status',{'id':'fixture','full':1})]:
            with self.assertRaises(m.QuotaError):self.backend.dispatch(a,b)

    def test_resize_requires_offline_migration_and_apply_requires_stopped(self):
        with self.assertRaisesRegex(m.QuotaError,'离线迁移'):self.backend.apply('fixture',2*1024**3,1000)
        with patch.object(self.backend,'require_stopped',side_effect=m.QuotaError('running')):
            with self.assertRaisesRegex(m.QuotaError,'running'):self.backend.apply('fixture',1024**3,1000)

    def test_manifest_preserves_links_without_following_external_target(self):
        external=self.home/'external';external.write_text('outside')
        try:(self.target/'workspace'/'link').symlink_to(external)
        except OSError:return self.skipTest('symlink creation unavailable')
        r=manifest(self.target);self.assertEqual(r['workspace/link']['kind'],'link')
        self.assertNotIn('sha256',r['workspace/link'])

    def test_registry_rejects_untrusted_ownership_and_path(self):
        (self.home/'untrusted.json').write_text('{}')
        with patch.object(m.os,'getuid',return_value=501,create=True):
            with self.assertRaises(m.QuotaError):m.read_registry(self.home/'untrusted.json')
        with self.assertRaises(m.QuotaError):m.Backend(self.root,self.root.parent/'data'/'registry.json')


if __name__=='__main__':unittest.main(verbosity=2)
