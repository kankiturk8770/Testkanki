"""Lease-based node control and durable, transactional quota escrow.

Nodes are trusted operators. A grant is never silently reclaimed from an
unreachable node. A device belongs to one node and migrations wait out its old
lease. Packet crypto/FEC/Repeat/Jitter are outside this control-plane module.
"""
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import sqlite3
import time

MAX_VOLUME=10**18
# Agents reject offsets >10 seconds; migrations cover that bound plus scheduling.
LEASE_GUARD=12
# Agents pull every 3 seconds: a change reaches every node within lease + guard + one pull.
APPLY_SECONDS=lambda lease:lease+LEASE_GUARD+3

def canonical(data): return json.dumps(data,sort_keys=True,separators=(',',':'))
class ClusterError(ValueError):
    def __init__(self,message,code=400): super().__init__(message);self.code=code

def integer(value,lo,hi,label):
    if type(value) is not int or not lo<=value<=hi: raise ClusterError('Invalid '+label)
    return value

def profile(data):
    allowed={'name','host','port','repeat','fec_k','fec','autotune','jitter','mtu','dns'}
    if set(data)-allowed: raise ClusterError('Unsupported node fields')
    if not isinstance(data.get('name'),str) or not 1<=len(data['name'])<=80: raise ClusterError('Invalid node name')
    if not isinstance(data.get('host'),str) or not re.fullmatch(r'[A-Za-z0-9.-]{1,253}',data['host']): raise ClusterError('Invalid public host')
    result={'repeat':4,'fec_k':8,'fec':True,'autotune':True,'jitter':0,'mtu':1280,'dns':'1.1.1.1',**data}
    for k,lo,hi in [('port',1,65535),('repeat',3,10),('fec_k',2,16),('jitter',0,100000),('mtu',576,1400)]: integer(result.get(k),lo,hi,k)
    for k in ('fec','autotune'):
        if type(result[k]) is not bool: raise ClusterError('Invalid '+k)
    try:
        if ipaddress.ip_address(result['dns']).version!=4: raise ValueError()
    except (ValueError,TypeError): raise ClusterError('Invalid IPv4 DNS')
    return result

class Controller:
    def __init__(self,db,enabled=False,clock=time.time,lease_seconds=30,chunk=1048576):
        self.db=db;self.clock=clock;self.lease_seconds=lease_seconds;self.chunk=chunk
        with self.connect() as c:
            c.executescript('''
            CREATE TABLE IF NOT EXISTS cluster_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS nodes (
              id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
              instance TEXT,seq INTEGER NOT NULL DEFAULT 0,applied_seq INTEGER NOT NULL DEFAULT 0,
              request_hash TEXT,response TEXT,last_seen INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,
              ready INTEGER NOT NULL DEFAULT 0,error TEXT,profile_id INTEGER,applied_until INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS node_grants (
              node_id TEXT NOT NULL,account_id TEXT NOT NULL,allocated INTEGER NOT NULL DEFAULT 0,
              charged INTEGER NOT NULL DEFAULT 0,rx INTEGER NOT NULL DEFAULT 0,tx INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY(node_id,account_id));
            CREATE TABLE IF NOT EXISTS node_sessions (
              node_id TEXT NOT NULL,name TEXT NOT NULL,account_id TEXT NOT NULL,connected INTEGER NOT NULL,
              last_rx INTEGER NOT NULL,PRIMARY KEY(node_id,name));
            CREATE TABLE IF NOT EXISTS retired_slots (account_id TEXT NOT NULL,slot INTEGER NOT NULL,until INTEGER NOT NULL,
              PRIMARY KEY(account_id,slot));
            ''')
            for table,col,definition in [('users','cluster_uuid','TEXT'),('users','base_usage','INTEGER NOT NULL DEFAULT 0'),
                ('devices','node_id','TEXT'),('devices','pending_until','INTEGER NOT NULL DEFAULT 0'),
                ('devices','required_seq','INTEGER NOT NULL DEFAULT 0'),('servers','node_id','TEXT'),('nodes','applied_until','INTEGER NOT NULL DEFAULT 0')]:
                if col not in {r['name'] for r in c.execute('PRAGMA table_info('+table+')')}:
                    c.execute('ALTER TABLE '+table+' ADD COLUMN '+col+' '+definition)
            c.execute('CREATE UNIQUE INDEX IF NOT EXISTS users_cluster_uuid ON users(cluster_uuid)')
            self.ensure_ids(c)
            if enabled and c.execute('SELECT COUNT(*) FROM users').fetchone()[0]==0:
                c.execute("INSERT OR IGNORE INTO cluster_meta VALUES('migrated','1')")
    def connect(self):
        c=sqlite3.connect(self.db,timeout=15);c.row_factory=sqlite3.Row;return c
    def ensure_ids(self,c):
        for r in c.execute('SELECT id FROM users WHERE cluster_uuid IS NULL').fetchall():
            c.execute('UPDATE users SET cluster_uuid=? WHERE id=?',('a'+secrets.token_hex(16),r['id']))
    def require_ready(self):
        with self.connect() as c:
            r=c.execute("SELECT value FROM cluster_meta WHERE key='migrated'").fetchone()
            if not r or r[0]!='1':raise ClusterError('Existing local users require offline cluster migration before enabling nodes',409)
    def create_node(self,data):
        self.require_ready();p=profile(data);node_id=secrets.token_hex(16);token=secrets.token_urlsafe(48)
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            if c.execute('SELECT COUNT(*) FROM nodes').fetchone()[0]>=64: raise ClusterError('Maximum 64 nodes')
            keys=list(p)+['node_id'];pid=c.execute('INSERT INTO servers('+','.join(keys)+') VALUES('+','.join('?' for _ in keys)+')',list(p.values())+[node_id]).lastrowid
            c.execute('INSERT INTO nodes(id,name,token_hash,profile_id) VALUES(?,?,?,?)',(node_id,p['name'],hashlib.sha256(token.encode()).hexdigest(),pid))
            c.execute('INSERT INTO audit(at,action,target) VALUES(?,?,?)',(int(self.clock()),'create-node',node_id))
        return {'id':node_id,'name':p['name'],'token':token,'profile_id':pid,'lease_seconds':self.lease_seconds}
    def nodes(self):
        now=int(self.clock())
        with self.connect() as c:
            rows=[dict(r) for r in c.execute('SELECT id,name,enabled,instance,seq,applied_seq,last_seen,lease_until,applied_until,ready,error,profile_id FROM nodes ORDER BY name')]
            for n in rows:
                n['online']=bool(n['enabled'] and n['ready'] and n['applied_until']>now and n['applied_seq']>0)
                n['devices']=c.execute('SELECT COUNT(*) FROM devices WHERE node_id=?',(n['id'],)).fetchone()[0]
                n['allocated']=c.execute('SELECT COALESCE(SUM(allocated),0) FROM node_grants WHERE node_id=?',(n['id'],)).fetchone()[0]
            return rows
    def set_enabled(self,node_id,value):
        if type(value) is not bool:raise ClusterError('enabled must be boolean')
        with self.connect() as c:
            if not c.execute('UPDATE nodes SET enabled=? WHERE id=?',(value,node_id)).rowcount:raise ClusterError('Node not found',404)
            c.execute('INSERT INTO audit(at,action,target) VALUES(?,?,?)',(int(self.clock()),'enable-node' if value else 'disable-node',node_id))
    def move(self,device_id,node_id):
        now=int(self.clock())
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            d=c.execute('SELECT * FROM devices WHERE id=?',(device_id,)).fetchone()
            if not d:raise ClusterError('Device not found',404)
            node=c.execute('SELECT * FROM nodes WHERE id=? AND enabled=1',(node_id,)).fetchone()
            if not node:raise ClusterError('Target node not enabled',400)
            if d['node_id']==node_id:return {'ok':True,'ready_at':d['pending_until']}
            if c.execute('SELECT COUNT(*) FROM devices WHERE node_id=?',(node_id,)).fetchone()[0]>=4096:raise ClusterError('Node capacity is 4096 device slots',409)
            ready=max(now,d['pending_until'])
            if d['node_id']:
                old=c.execute('SELECT lease_until FROM nodes WHERE id=?',(d['node_id'],)).fetchone()
                if old:ready=max(ready,old[0]+LEASE_GUARD)
            account=c.execute('SELECT cluster_uuid FROM users WHERE id=?',(d['user_id'],)).fetchone()[0]
            retired=c.execute('SELECT until FROM retired_slots WHERE account_id=? AND slot=?',(account,d['slot'])).fetchone()
            if retired:ready=max(ready,retired[0])
            c.execute('UPDATE devices SET node_id=?,pending_until=?,required_seq=? WHERE id=?',(node_id,ready,node['seq']+1,device_id))
            c.execute('INSERT INTO audit(at,action,target) VALUES(?,?,?)',(now,'move-device',str(device_id)))
            return {'ok':True,'ready_at':ready,'node_id':node_id}
    def prepare_slot_change(self,c,user,count):
        now=int(self.clock())
        for d in c.execute('SELECT * FROM devices WHERE user_id=? AND slot>?',(user['id'],count)).fetchall():
            until=max(now,d['pending_until'])
            if d['node_id']:
                node=c.execute('SELECT lease_until FROM nodes WHERE id=?',(d['node_id'],)).fetchone()
                if node:until=max(until,node[0]+LEASE_GUARD)
            c.execute('INSERT INTO retired_slots VALUES(?,?,?) ON CONFLICT(account_id,slot) DO UPDATE SET until=MAX(until,excluded.until)',(user['cluster_uuid'],d['slot'],until))
    def validate_quota(self,c,user_id,quota):
        u=c.execute('SELECT cluster_uuid,base_usage FROM users WHERE id=?',(user_id,)).fetchone()
        assigned=c.execute('SELECT COALESCE(SUM(allocated),0) FROM node_grants WHERE account_id=?',(u['cluster_uuid'],)).fetchone()[0]
        if quota and quota<u['base_usage']+assigned:raise ClusterError('Quota cannot be reduced below issued node credit; increase it or disable the account')
    def usage_in(self,c,u):
        r=c.execute('SELECT COALESCE(SUM(allocated),0),COALESCE(SUM(charged),0),COALESCE(SUM(rx),0),COALESCE(SUM(tx),0) FROM node_grants WHERE account_id=?',(u['cluster_uuid'],)).fetchone()
        return {'allocated':r[0]+u['base_usage'],'charged':r[1]+u['base_usage'],'rx':r[2],'tx':r[3]+u['base_usage'],'quota':u['quota_bytes']}
    def account_usage(self,uid):
        with self.connect() as c:
            u=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone();return self.usage_in(c,u)
    def device_view(self,uid):
        now=int(self.clock())
        with self.connect() as c:
            rows=[dict(r) for r in c.execute('SELECT id,slot,ip,node_id,pending_until,required_seq FROM devices WHERE user_id=? ORDER BY slot',(uid,))]
            for d in rows:
                n=c.execute('SELECT * FROM nodes WHERE id=?',(d['node_id'],)).fetchone() if d['node_id'] else None
                d['ready']=bool(n and n['enabled'] and n['ready'] and n['applied_until']>now and d['pending_until']<=now and n['applied_seq']>=d['required_seq'])
            return rows
    def subscription_profiles(self,u):
        ready={d['id'] for d in self.device_view(u['id']) if d['ready']}
        result=[]
        with self.connect() as c:
            for d in c.execute('SELECT * FROM devices WHERE user_id=?',(u['id'],)):
                if d['id'] not in ready:continue
                for s in c.execute('SELECT * FROM servers WHERE node_id=?',(d['node_id'],)):
                    result.append({'name':f"{s['name']} · Device {d['slot']}",'device':d['slot'],'node':d['node_id'],
                        'server':s['host'],'port':s['port'],'key':d['psk'],'ip':d['ip'],'repeat':s['repeat'],'fec_k':s['fec_k'],
                        'fec':bool(s['fec']),'autotune':bool(s['autotune']),'jitter':s['jitter'],'mtu':s['mtu'],'dns':s['dns']})
        return result
    def sync(self,token,data):
        if not isinstance(data,dict) or set(data)-{'instance','seq','ack','stats','error'}:raise ClusterError('Invalid sync request')
        instance=data.get('instance');seq=integer(data.get('seq'),1,2**53-1,'sequence');ack=integer(data.get('ack'),0,seq-1,'ack')
        if not isinstance(instance,str) or not re.fullmatch('[a-f0-9]{32}',instance):raise ClusterError('Invalid instance identity')
        stats=data.get('stats')
        if not isinstance(stats,dict) or type(stats.get('ready')) is not bool:raise ClusterError('Invalid stats')
        reports=stats.get('accounts',[]);sessions=stats.get('sessions',[])
        if not isinstance(reports,list) or len(reports)>4096 or not isinstance(sessions,list) or len(sessions)>4096:raise ClusterError('Too many report rows')
        error=data.get('error')
        if error is not None and (not isinstance(error,str) or len(error)>240):raise ClusterError('Invalid node error')
        request_hash=hashlib.sha256(canonical(data).encode()).hexdigest();token_hash=hashlib.sha256(token.encode()).hexdigest();now=int(self.clock())
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            node=c.execute('SELECT * FROM nodes WHERE token_hash=? AND enabled=1',(token_hash,)).fetchone()
            if not node:raise ClusterError('Unauthorized node',401)
            if node['instance'] and node['instance']!=instance:raise ClusterError('Instance changed: restore node identity or provision a new node',409)
            if seq==node['seq']:
                if node['request_hash']!=request_hash:raise ClusterError('Sequence reused with different data',409)
                return json.loads(node['response'])
            if seq!=node['seq']+1 or ack>node['seq'] or ack<node['applied_seq']:raise ClusterError('Out-of-order sync sequence',409)
            seen=set()
            for r in reports:
                if not isinstance(r,dict) or set(r)!={'id','charged','rx','tx'} or not isinstance(r['id'],str) or r['id'] in seen:raise ClusterError('Invalid account report')
                seen.add(r['id'])
                for k in ('charged','rx','tx'):integer(r[k],0,MAX_VOLUME,k)
                grant=c.execute('SELECT * FROM node_grants WHERE node_id=? AND account_id=?',(node['id'],r['id'])).fetchone()
                if not grant or not grant['charged']<=r['charged']<=grant['allocated']:raise ClusterError('Unissued or nonmonotonic credit report',409)
                if r['rx']+r['tx']>r['charged']:raise ClusterError('Payload counters exceed durable credit',409)
                c.execute('UPDATE node_grants SET charged=?,rx=MAX(rx,?),tx=MAX(tx,?) WHERE node_id=? AND account_id=?',(r['charged'],r['rx'],r['tx'],node['id'],r['id']))
            c.execute('DELETE FROM node_sessions WHERE node_id=?',(node['id'],))
            for r in sessions:
                if not isinstance(r,dict) or set(r)!={'name','account','connected','last_rx'} or not isinstance(r['name'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,63}',r['name']) or not isinstance(r['account'],str) or type(r['connected']) is not bool:raise ClusterError('Invalid session report')
                integer(r['last_rx'],0,2**53-1,'last_rx')
                if not c.execute('SELECT 1 FROM node_grants WHERE node_id=? AND account_id=?',(node['id'],r['account'])).fetchone():raise ClusterError('Foreign session report',409)
                c.execute('INSERT INTO node_sessions VALUES(?,?,?,?,?)',(node['id'],r['name'],r['account'],r['connected'],r['last_rx']))
            applied_until=node['applied_until']
            if ack and ack==node['seq']:applied_until=json.loads(node['response'])['lease_until']
            until=now+self.lease_seconds
            profile_row=c.execute('SELECT * FROM servers WHERE id=?',(node['profile_id'],)).fetchone()
            if not profile_row:raise ClusterError('Node profile missing',409)
            selected=c.execute('SELECT d.*,u.name AS account_name,u.cluster_uuid,u.enabled,u.expires,u.quota_bytes,u.base_usage FROM devices d JOIN users u ON d.user_id=u.id WHERE d.node_id=? AND d.pending_until<=? ORDER BY d.id',(node['id'],now)).fetchall()
            output=[];local_grants={}
            for d in selected:
                aid=d['cluster_uuid']
                if aid not in local_grants:
                    c.execute('INSERT OR IGNORE INTO node_grants(node_id,account_id) VALUES(?,?)',(node['id'],aid))
                    grant=c.execute('SELECT * FROM node_grants WHERE node_id=? AND account_id=?',(node['id'],aid)).fetchone()
                    cutoff=0 if not d['expires'] else max(1,int(dt.datetime.combine(dt.date.fromisoformat(d['expires']),dt.time(),dt.timezone.utc).timestamp())+86400)
                    allowed=d['enabled'] and (not cutoff or cutoff>now)
                    peers=c.execute('SELECT COUNT(DISTINCT node_id) FROM devices WHERE user_id=? AND node_id IS NOT NULL',(d['user_id'],)).fetchone()[0]
                    fair=max(1,d['quota_bytes']//max(1,peers)) if d['quota_bytes'] else self.chunk
                    if allowed and grant['allocated']-grant['charged']<=max(1,min(self.chunk,fair)//4):
                        total=c.execute('SELECT COALESCE(SUM(allocated),0) FROM node_grants WHERE account_id=?',(aid,)).fetchone()[0]+d['base_usage']
                        remaining=max(0,d['quota_bytes']-total) if d['quota_bytes'] else MAX_VOLUME-total
                        allocation=min(self.chunk,fair,remaining)
                        c.execute('UPDATE node_grants SET allocated=allocated+? WHERE node_id=? AND account_id=?',(allocation,node['id'],aid))
                    amount=c.execute('SELECT allocated FROM node_grants WHERE node_id=? AND account_id=?',(node['id'],aid)).fetchone()[0]
                    local_grants[aid]=(amount,1 if not allowed else min(until,cutoff) if cutoff else until)
                amount,expires=local_grants[aid]
                output.append({'name':aid+'-d'+str(d['slot']),'key':d['psk'],'ip':d['ip'],'group':aid,'quota':amount,'expires':expires})
                c.execute('UPDATE devices SET required_seq=? WHERE id=? AND required_seq=0',(seq,d['id']))
            document={'version':1,'node_id':node['id'],'instance':instance,'seq':seq,'server_time':now,'lease_until':until,
                'profile':{k:profile_row[k] for k in ('name','host','port','repeat','fec_k','fec','autotune','jitter','mtu','dns')},'users':output}
            document['signature']=hmac.new(token.encode(),canonical(document).encode(),hashlib.sha256).hexdigest()
            # The agent already checked freshness against its own clock. Here only
            # reject clearly stale reports, allowing the same clock offset agents accept.
            fresh=stats['ready'] and type(stats.get('updated')) is int and -LEASE_GUARD<=now-stats['updated']<=5+LEASE_GUARD
            c.execute('UPDATE nodes SET instance=?,seq=?,applied_seq=?,request_hash=?,response=?,last_seen=?,lease_until=?,ready=?,error=?,applied_until=? WHERE id=?',
                (instance,seq,ack,request_hash,canonical(document),now,until,int(fresh),error,applied_until,node['id']))
            return document
