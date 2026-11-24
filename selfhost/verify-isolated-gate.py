#!/usr/bin/env python3
"""Verify the first disabled gate installation; no client, service or runtime is run."""
import argparse, grp, hashlib, json, os, pwd, re, shutil, stat, subprocess
from pathlib import Path, PurePosixPath
BASE=Path('/opt/bittrees-chat-gate')
CONFIG=Path('/etc/bittrees-chat-gate')
STATE=Path('/var/lib/bittrees-chat-gate')
UNIT=Path('/etc/systemd/system/bittrees-chat-gate.service')
ACCOUNT='bittrees-chat-gate'
ENVIRONMENT_SHA256='954757796792fca29f602ae8ee732b22de4667c96d87b17ac67722877acb9cb9'
MAX_RECORD=4*1024*1024

def require(condition):
    if not condition: raise ValueError('Gate installation verification failed; preserve existing state')

def digest(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        meta=os.fstat(f.fileno());require(stat.S_ISREG(meta.st_mode) and meta.st_nlink==1)
        result=hashlib.sha256()
        while chunk:=f.read(1024*1024): result.update(chunk)
        after=os.fstat(f.fileno());require((meta.st_size,meta.st_mtime_ns,meta.st_ctime_ns)==(after.st_size,after.st_mtime_ns,after.st_ctime_ns))
    return result.hexdigest()

def read_record(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as f:
        meta=os.fstat(f.fileno());require(stat.S_ISREG(meta.st_mode) and meta.st_nlink==1 and meta.st_size<=MAX_RECORD)
        data=f.read(MAX_RECORD+1);require(len(data)<=MAX_RECORD)
    return json.loads(data)

def verify(commit,tree,bundle_sha,node_sha):
    require(os.geteuid()==0)
    for value,length in [(commit,40),(tree,40),(bundle_sha,64),(node_sha,64)]:require(isinstance(value,str) and re.fullmatch('[a-f0-9]{'+str(length)+'}',value))
    identity=pwd.getpwnam(ACCOUNT);group=grp.getgrnam(ACCOUNT)
    require(identity.pw_uid>0 and identity.pw_gid==group.gr_gid and identity.pw_shell=='/usr/sbin/nologin' and identity.pw_dir==str(STATE) and group.gr_mem==[])
    for folder,uid,gid,mode in [(BASE,0,identity.pw_gid,0o750),(CONFIG,0,identity.pw_gid,0o750),(STATE,identity.pw_uid,identity.pw_gid,0o700)]:
        info=folder.lstat();require(stat.S_ISDIR(info.st_mode) and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(uid,gid,mode))
    for path in [CONFIG/'install-receipt.json',CONFIG/'gate.env']:
        info=path.lstat();require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o600)
    require(digest(CONFIG/'gate.env')==ENVIRONMENT_SHA256)
    data=read_record(CONFIG/'install-receipt.json')
    require(data.get('version')==1 and (data.get('commit'),data.get('tree'),data.get('bundleSha256'))==(commit,tree,bundle_sha))
    require(data.get('enabled') is False and data.get('identityProvisioned') is False and data.get('activationApproved') is False)
    require(not os.path.lexists(CONFIG/'activation-approved') and not os.path.lexists(CONFIG/'rooms.json') and not list(STATE.iterdir()))
    files=data.get('files');require(isinstance(files,dict) and 0<len(files)<=100000)
    expected_dirs={BASE};actual_files=set()
    for name,expected in files.items():
        require(isinstance(name,str));rel=PurePosixPath(name)
        require(str(rel)==name and not rel.is_absolute() and '..' not in rel.parts and isinstance(expected,str) and re.fullmatch('[a-f0-9]{64}',expected))
        p=BASE.joinpath(*rel.parts)
        expected_dirs.update(p.parents[i] for i in range(len(rel.parts)))
        info=p.lstat();require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==0 and info.st_gid==identity.pw_gid and stat.S_IMODE(info.st_mode) in (0o440,0o550))
        require(digest(p)==expected)
    require(files.get('runtime/bin/node')==node_sha and stat.S_IMODE((BASE/'runtime/bin/node').stat().st_mode)==0o550)
    for p in [BASE,*BASE.rglob('*')]:
        info=p.lstat();require(not stat.S_ISLNK(info.st_mode))
        if stat.S_ISDIR(info.st_mode):require(p in expected_dirs and (info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))==(0,identity.pw_gid,0o750))
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==0 and info.st_gid==identity.pw_gid and stat.S_IMODE(info.st_mode) in (0o440,0o550))
            actual_files.add(str(p.relative_to(BASE)))
    require(actual_files==set(files)|{'bundle.json'})
    metadata=read_record(BASE/'bundle.json');require(metadata.get('files')==files and metadata.get('component')==ACCOUNT and metadata.get('commit')==commit and metadata.get('tree')==tree)
    require(digest(UNIT)==files.get('release/selfhost/systemd/system/bittrees-chat-gate.service'))
    unit=UNIT.lstat();require(stat.S_ISREG(unit.st_mode) and unit.st_nlink==1 and unit.st_uid==0 and stat.S_IMODE(unit.st_mode)==0o644)
    result=subprocess.run(['/usr/bin/systemctl','show','bittrees-chat-gate.service','-p','ActiveState','-p','UnitFileState','-p','MainPID'],check=True,capture_output=True,text=True,timeout=8,env={'PATH':'/usr/bin:/bin','LANG':'C'})
    props=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
    require(props.get('ActiveState')=='inactive' and props.get('UnitFileState')=='disabled' and props.get('MainPID')=='0')
    free=shutil.disk_usage(BASE).free;require(free>=2*1024*1024*1024)
    return {'rootFreeBytes':free,'rootReserveVerified':True,'installationVerified':True,'commit':commit,'tree':tree,'filesVerified':len(files),'dedicatedAccountVerified':True,'serviceEnabled':False,'identityCreated':False,'roomConfigured':False,'activationMarkerAbsent':True,'sdkOpened':False,'mailSent':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['commit','tree','bundle-sha256','node-sha256']:parser.add_argument('--'+name,required=True)
    args=parser.parse_args();print(json.dumps(verify(args.commit,args.tree,args.bundle_sha256,args.node_sha256)))

if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('Gate verification stopped. Preserve existing state and return to the operator; do not reinstall.')
