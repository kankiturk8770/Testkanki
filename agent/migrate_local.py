#!/usr/bin/env python3
"""Offline v0.3 single-node -> cluster migration. Stop both services first."""
import argparse,os,re,sqlite3,time
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'admin'))
from kanki_cluster import Controller,ClusterError
from kanki_agent import atomic

def keep_owner(path,like):
    # The migration runs as root; the panel runs as the kanki user and must keep
    # read/write access to everything rewritten here.
    if os.geteuid()==0 and os.path.exists(path):os.chown(path,like.st_uid,like.st_gid)

def migrate(db,status,config):
    db_stat=os.stat(db);config_stat=os.stat(config)
    controller=Controller(db);stamp=str(time.time_ns());backup=str(db)+'.pre-cluster-'+stamp
    c=controller.connect()
    try:
        if c.execute("SELECT value FROM cluster_meta WHERE key='migrated' AND value='1'").fetchone():raise ClusterError('Database already migrated')
        if c.execute('SELECT 1 FROM nodes LIMIT 1').fetchone():raise ClusterError('Nodes already provisioned')
        rows=c.execute('SELECT * FROM users').fetchall()
        lines=Path(status).read_text().splitlines()
        if not lines or not lines[0].startswith('KANKI_STATUS_V1 '):raise ClusterError('Final local engine status required')
        if 'credit-v1' in lines[0]:raise ClusterError('Expected local, not existing cluster status')
        usage={}
        for line in lines[1:]:
            p=line.split()
            if p and p[0]=='account':
                if len(p)<5 or not all(x.isdecimal() for x in p[2:5]):raise ClusterError('Invalid final account counters')
                usage[p[1]]=int(p[2])+int(p[3])
        if any(u['name'] not in usage for u in rows):raise ClusterError('Every local account needs final usage; start/stop the local engine once before migration')
        old=Path(config).read_text();fenced=[]
        for line in old.splitlines():
            if line.lstrip().startswith('user '):
                line=re.sub(r' expires=[0-9]+',' expires=1',line)
                if ' expires=' not in line:line+=' expires=1'
            fenced.append(line)
        with sqlite3.connect(backup) as dest:c.backup(dest)
        os.chmod(backup,0o600);atomic(str(config)+'.pre-cluster-'+stamp,old)
        atomic(config,'\n'.join(fenced)+'\n',0o640);keep_owner(config,config_stat)
        with c:
            c.execute('BEGIN IMMEDIATE')
            for u in rows:c.execute('UPDATE users SET base_usage=? WHERE id=?',(max(u['base_usage'],usage[u['name']]),u['id']))
            c.execute("INSERT INTO cluster_meta VALUES('migrated','1')")
            c.execute('INSERT INTO audit(at,action,target) VALUES(?,?,?)',(int(time.time()),'offline-cluster-migration',str(len(rows))))
    finally:
        c.close()
    for suffix in ('','-wal','-shm'):keep_owner(str(db)+suffix,db_stat)
    return backup

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--db',required=True,type=Path);p.add_argument('--status',required=True,type=Path);p.add_argument('--config',required=True,type=Path);p.add_argument('--offline',action='store_true',required=True,help='Confirm local engine/admin are stopped and status is their final snapshot')
    a=p.parse_args();print('Backup:',migrate(a.db,a.status,a.config))
if __name__=='__main__':main()
