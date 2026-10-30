#!/usr/bin/env python3
"""Dedicated Linux quota service; reuses the signed, replay-checked mailbox.

Run as a system service with a fixed instance root and operator-selected GID.
The Manager gets access to this mailbox, never CAP_SYS_ADMIN or a sudo shell.
"""
import argparse
import os
from pathlib import Path
import secrets
import threading
import concurrent.futures
from manager_host_service import Service
from storage_quota import backend, safe, QuotaError


class QuotaService(Service):
    def __init__(self, root, control, gid, registry=None):
        if os.geteuid()!=0:
            raise QuotaError('配额宿主服务需要 root 身份')
        self.backend=backend(root,registry)
        self.control=safe(control)
        if self.control.is_relative_to(self.backend.root):
            raise QuotaError('配额控制目录不能位于实例挂载内')
        self.control.mkdir(parents=True,exist_ok=True,mode=0o750)
        for folder,mode in [(self.control,0o750),(self.control/'requests',0o770),(self.control/'responses',0o750)]:
            safe(folder).mkdir(exist_ok=True)
            os.chown(folder,0,gid);os.chmod(folder,mode)
        key=safe(self.control/'key')
        if not key.exists():
            fd=os.open(key,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o640)
            with os.fdopen(fd,'w') as file:file.write(secrets.token_hex(32))
        os.chown(key,0,gid);os.chmod(key,0o640)
        self.key=key.read_text().strip()
        if len(self.key)!=64 or any(c not in '0123456789abcdef' for c in self.key):
            raise QuotaError('配额控制密钥无效')
        self.stop=threading.Event();self.running=set();self.pool=concurrent.futures.ThreadPoolExecutor(max_workers=2)

    def dispatch(self,action,body):
        return self.backend.dispatch(action,body)

    def recover(self):
        self.stop.wait()


if __name__=='__main__':
    import signal
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',required=True)
    parser.add_argument('--control',required=True)
    parser.add_argument('--gid',required=True,type=int)
    parser.add_argument('--registry')
    args=parser.parse_args()
    service=QuotaService(args.root,args.control,args.gid,args.registry)
    for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,lambda *_:service.stop.set())
    service.serve()
