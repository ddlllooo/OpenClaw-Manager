#!/usr/bin/env python3
"""Read-only cutover inventory. This command never starts/stops containers."""
import argparse,hashlib,json,os,re,subprocess,time
from pathlib import Path
def write(file,value):
    raw=json.dumps(value,ensure_ascii=False,indent=2);fd=os.open(str(file),os.O_CREAT|os.O_TRUNC|os.O_WRONLY,0o600)
    with os.fdopen(fd,'w') as stream:stream.write(raw)
def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()
def prepare(source,socket,output):
    source=Path(source).resolve();output=Path(output).resolve();output.mkdir(parents=True,exist_ok=True,mode=0o700)
    settings=json.loads((source.parent/'startup-settings.json').read_text());rows=[];inspect_rows=[];records={}
    for file in sorted(source.glob('*/instance.json')):
        id=file.parent.name
        if id.endswith('.kept'):continue
        if not re.fullmatch('[a-zA-Z0-9_-]{1,80}',id) or file.parent.is_symlink() or file.is_symlink():raise ValueError('Invalid instance path')
        record=json.loads(file.read_text());assert record['id']==id
        row=None;cid=record.get('containerId')
        if cid:
            if not re.fullmatch('[a-f0-9]{12,64}',cid):raise ValueError('Invalid container ID')
            p=subprocess.run(['/usr/local/bin/docker','--host','unix://'+socket,'inspect',cid],capture_output=True,text=True,timeout=15)
            if p.returncode==0:
                row=json.loads(p.stdout)[0]
                if row['Config']['Labels'].get('openclaw.instance')!=id or row['Config']['Labels'].get('openclaw.managed')!='true' or row['Name'].lstrip('/')!=record['containerName']:raise ValueError('Container ownership mismatch')
                inspect_rows.append(row)
        state=row['State']['Status'] if row else 'missing';cfg=file.parent/'openclaw/openclaw.json';records[id]=record
        rows.append({'id':id,'sourceContainerId':cid,'state':state,'startOnCutover':state=='running','targetRestartPolicy':'unless-stopped' if settings['instancesAutoStart'] and settings['instanceOverrides'].get(id,True) else 'no','recordSHA256':sha(file),'configSHA256':sha(cfg) if cfg.exists() else None,'imageId':row['Image'] if row else None,'port':record.get('port')})
    plan={'createdAt':time.time(),'sourceSocket':socket,'sourceDirectory':str(source),'settings':settings,'instances':rows,'startOnlyTheseIds':[r['id'] for r in rows if r['startOnCutover']],'keepStoppedIds':[r['id'] for r in rows if not r['startOnCutover']],'targetProfile':'openclaw-headless','targetSocket':str(Path.home()/'.colima/openclaw-headless/docker.sock'),'automaticCutoverEnabled':False,'requiresFreshInventoryAtCutover':True,'physicalMacRebootVerified':False,'steps':['Refresh online backup and verify hashes/SQLite integrity.','Revalidate inventory; abort if instance records or states changed.','Prepare the distinct production VM and load verified images; keep source context unchanged.','Stop only source instances listed in startOnlyTheseIds; leave all others stopped.','Create target containers and remap record IDs transactionally, retaining original source containers.','Start only startOnlyTheseIds; enforce target restart policies and verify health/native RPC/Feishu routes.','Switch Manager Compose and system controller to the target socket; never run the same instance on both engines.'],'rollback':['Disable new controller before any rollback, to prevent automatic starts.','Stop only target containers started by this cutover.','Restore original instance container-ID records and Manager Compose/controller configuration.','Start only source IDs recorded as running before cutover.','Do not overwrite live business databases from old backups without a separate data-recovery decision.']}
    write(output/'migration-plan.json',plan);write(output/'source-instance-records.json',records);write(output/'source-container-inspect.json',inspect_rows)
    return {'plan':str(output/'migration-plan.json'),'runningCount':len(plan['startOnlyTheseIds']),'keepStoppedCount':len(plan['keepStoppedIds']),'readOnly':True}
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',required=True);parser.add_argument('--socket',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();print(json.dumps(prepare(args.source,args.socket,args.output)))
