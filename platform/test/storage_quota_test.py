import ctypes
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
import storage_quota as m


class FakeBackend(m.Backend):
    def __init__(self,root,registry):
        super().__init__(root,registry)
        self.assigned=0;self.limits={};self.commands=[];self.mismatch=False
    def probe(self,id):
        self.target(id)
        return {'supported':True}
    def mount(self,target):return {'target':str(self.root.parent),'fstype':'xfs'}
    def attributes(self,target):return (self.assigned,bool(self.assigned))
    def require_stopped(self,record):pass
    def read_quota(self,mount,project):
        return {'projectId':project,'hardBytes':self.limits.get(project,(0,0))[0]+(4096 if self.mismatch and project in self.limits else 0),'hardInodes':self.limits.get(project,(0,0))[1],
                'usedBytes':4096 if self.assigned==project else 0,'usedInodes':5 if self.assigned==project else 0,'softBytes':0,'softInodes':0}
    def run(self,args):
        self.commands.append(args)
        command=args[args.index('-c')+1]
        if command.startswith('limit '):
            self.limits[int(command.split()[-1])]=(int(re.search(r'bhard=(\d+)k',command)[1])*1024,int(re.search(r'ihard=(\d+)',command)[1]))
        elif command.startswith('project -s'):self.assigned=int(command.split()[-1])
        return ''


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='quota-unit-');self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve()/'data'/'instances';self.target=self.root/'fixture';self.target.mkdir(parents=True)
        for name in ['openclaw','workspace','auth']:(self.target/name).mkdir()
        (self.target/'instance.json').write_text(json.dumps({'id':'fixture'}))
        self.backend=m.Backend(self.root,Path(self.tmp.name).resolve()/'private'/'registry.json')
    def test_kernel_structure_layout_and_invalid_request_fields(self):
        self.assertEqual(ctypes.sizeof(m.DiskQuota),112)
        for action,body in [('exec',{}),('quota-apply',{'id':'fixture','path':'/etc'}),('quota-status',{'id':'fixture','full':'true'})]:
            with self.assertRaises(m.QuotaError):self.backend.dispatch(action,body)
        with self.assertRaises(m.QuotaError):self.backend.target('../escape')
        with self.assertRaises(m.QuotaError):m.Backend(self.root,self.root.parent/'registry.json')
    def test_independent_volumes_are_explicitly_unsupported(self):
        (self.target/'instance.json').write_text(json.dumps({'id':'fixture','security':{'profile':'ssh-sandbox-v1'}}))
        self.assertFalse(self.backend.probe('fixture')['supported'])
        self.assertIn('独立执行卷',self.backend.probe('fixture')['reason'])
    def test_non_linux_probe_is_explicit_and_read_only(self):
        with patch.object(m.sys,'platform','win32'):
            value=self.backend.probe('fixture')
        self.assertFalse(value['supported']);self.assertIn('Docker Desktop',value['reason']);self.assertFalse(self.backend.registry.exists())
    @unittest.skipUnless(sys.platform=='linux','XFS host ABI tests also run inside the Linux smoke container')
    def test_apply_limits_before_tree_assignment_and_readback(self):
        b=FakeBackend(self.root,self.backend.registry)
        value=b.apply('fixture',8*1024**2,1000)
        self.assertTrue(value['verified']);self.assertTrue(b.commands[0][b.commands[0].index('-c')+1].startswith('limit '))
        self.assertEqual(value['hardBytes'],8*1024**2)
        registry=json.loads(b.registry.read_text());self.assertEqual(registry['fixture']['phase'],'verified')
        b.limits[b.assigned]=(16*1024**2,1000)
        self.assertFalse(b.status('fixture')['verified'])
    @unittest.skipUnless(sys.platform=='linux','fcntl project registration is exercised in Linux smoke tests')
    def test_wrong_readback_and_foreign_project_never_succeed(self):
        b=FakeBackend(self.root,self.backend.registry);b.mismatch=True
        with self.assertRaises(m.QuotaError):b.apply('fixture',8*1024**2,1000)
        self.assertNotEqual(json.loads(b.registry.read_text())['fixture'].get('phase'),'verified')
        self.backend.registry.unlink();b=FakeBackend(self.root,self.backend.registry);b.assigned=999
        with self.assertRaisesRegex(m.QuotaError,'非平台'):b.apply('fixture',8*1024**2,1000)
    @unittest.skipUnless(sys.platform=='linux','Linux inode and link semantics are exercised in the smoke container')
    def test_links_and_nested_filesystems_fail_closed(self):
        (self.target/'workspace'/'escape').symlink_to(self.root.parent)
        with self.assertRaises(m.QuotaError):self.backend.tree(self.target)
        (self.target/'workspace'/'escape').unlink()
        source=self.target/'workspace'/'file';source.write_text('data');os.link(source,self.target/'auth'/'link')
        with self.assertRaises(m.QuotaError):self.backend.tree(self.target)
    @unittest.skipUnless(sys.platform=='linux','Dedicated privileged service is Linux-only')
    def test_quota_service_exposes_no_arbitrary_host_actions(self):
        if os.geteuid()!=0:self.skipTest('dedicated service fixture requires container root')
        from quota_host_service import QuotaService
        service=QuotaService(self.root,Path(self.tmp.name).resolve()/'control',os.getgid(),self.backend.registry)
        try:
            with self.assertRaises(m.QuotaError):service.dispatch('exec',{'command':'id'})
            with self.assertRaises(m.QuotaError):service.dispatch('quota-apply',{'id':'fixture','path':'/'})
            self.assertEqual((service.control/'key').stat().st_mode&0o777,0o640)
        finally:service.pool.shutdown()


if __name__=='__main__':unittest.main(verbosity=2)
