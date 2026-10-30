"""Disposable XFS kernel test. Run only in the dedicated no-bind Docker fixture.

Formats a newly-created regular file INSIDE the disposable container, never a
host device or directory. No Docker socket is mounted. Kernel and helper are
real; the local docker CLI stub represents an empty test container label set.
"""
import errno
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0,'/fixture/scripts')
from storage_quota import Backend


def command(args):
    return subprocess.run(args,check=True,text=True,capture_output=True).stdout


def main():
    base=Path(tempfile.mkdtemp(prefix='openclaw-quota-kernel-',dir='/tmp'))
    image=base/'test-filesystem.img';mount=base/'mount';mount.mkdir()
    mounted=False
    try:
        # All mutating filesystem commands have a literal regular-file target
        # under this newly-created fixture directory.
        with image.open('xb') as file:file.truncate(512*1024**2)
        assert image.is_file() and image.parent==base and not image.is_symlink()
        command(['mkfs.xfs','-f',str(image)])
        command(['mount','-o','loop,prjquota',str(image),str(mount)]);mounted=True
        root=mount/'instances';target=root/'fixture';target.mkdir(parents=True)
        for name in ['openclaw','workspace','auth']:(target/name).mkdir()
        (target/'instance.json').write_text(json.dumps({'id':'fixture'}))
        registry=base/'private'/'registry.json';backend=Backend(root,registry)
        capability=backend.probe('fixture')
        assert capability['supported'],capability
        print('PASS: live XFS accounting and enforcement detected',flush=True)
        request={'action':'quota-apply','body':{'id':'fixture','hardBytes':8*1024**2,'hardInodes':100}}
        child=subprocess.run([sys.executable,'/fixture/scripts/storage_quota.py','--root',str(root),'--registry',str(registry)],input=json.dumps(request),text=True,capture_output=True)
        assert child.returncode==0,(child.stdout,child.stderr)
        assert json.loads(child.stdout)['verified']
        # The quota setter has EXITED; the kernel still blocks unrelated writers.
        file=target/'workspace'/'large.bin';fd=os.open(file,os.O_WRONLY|os.O_CREAT,0o600);denied=False
        try:
            for _ in range(32):os.write(fd,b'x'*(1024**2))
            os.fsync(fd)
        except OSError as error:
            assert error.errno in [errno.ENOSPC,errno.EDQUOT],error
            denied=True
        finally:os.close(fd)
        assert denied,'kernel allowed allocations beyond the project hard limit'
        value=backend.status('fixture',True);assert value['usedBytes']<=value['hardBytes'],value
        print('PASS: hard byte cap remains enforced after controller exit',flush=True)
        file.unlink()
        denied=False
        for i in range(200):
            try:(target/'workspace'/f'empty-{i}').touch(exist_ok=False)
            except OSError as error:
                assert error.errno in [errno.ENOSPC,errno.EDQUOT],error
                denied=True;break
        assert denied,'kernel did not enforce the inode cap'
        print('PASS: empty files cannot bypass the inode cap',flush=True)
        expanded=backend.apply('fixture',16*1024**2,200)
        assert expanded['verified'] and expanded['hardInodes']==200
        (target/'workspace'/'after-expansion').touch()
        print('PASS: explicit offline expansion verified and writes recover',flush=True)
        project=expanded['projectId']
        command(['xfs_quota','-x','-c',f'limit -p bhard=32m {project}',str(mount)])
        assert not backend.status('fixture')['verified']
        print('PASS: out-of-band hard-limit changes are detected',flush=True)
    finally:
        if mounted:
            result=subprocess.run(['umount',str(mount)],capture_output=True,text=True)
            if result.returncode:
                raise RuntimeError('Fixture unmount failed; refusing recursive cleanup of a mounted filesystem')
        assert base.name.startswith('openclaw-quota-kernel-') and base.parent==Path('/tmp')
        shutil.rmtree(base)


if __name__=='__main__':main()
