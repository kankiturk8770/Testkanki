#!/usr/bin/env python3
"""KANKI control plane. Standard-library only, loopback behind a TLS proxy."""
import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import tempfile
import threading
import time
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

DB = Path(os.environ.get('KANKI_ADMIN_DB', './admin.sqlite3'))
CONF = Path(os.environ.get('KANKI_CONF', './kanki.conf'))
STATUS = Path(os.environ.get('KANKI_STATUS', './status.txt'))
ADMIN = os.environ.get('KANKI_ADMIN_TOKEN', '')
BIND = os.environ.get('KANKI_ADMIN_BIND', '127.0.0.1')
HTTP_PORT = int(os.environ.get('KANKI_ADMIN_PORT', '8765'))
CLUSTER = os.environ.get('KANKI_CLUSTER', '0') == '1'
PUBLIC = os.environ.get('KANKI_PUBLIC_URL', '').rstrip('/')
HOST = os.environ.get('KANKI_PUBLIC_HOST', 'CHANGE_ME')
PORT = int(os.environ.get('KANKI_PORT', '4000'))
if len(ADMIN) < 32:
    raise SystemExit('Set KANKI_ADMIN_TOKEN to a random token >=32 characters')
os.umask(0o077)
DB.parent.mkdir(parents=True, exist_ok=True)
CONF.parent.mkdir(parents=True, exist_ok=True)
lock = threading.RLock()
with sqlite3.connect(DB) as c:
    c.executescript('''
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
      psk TEXT NOT NULL, ip TEXT UNIQUE NOT NULL, token TEXT UNIQUE NOT NULL,
      quota_bytes INTEGER NOT NULL DEFAULT 0, expires TEXT, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
      slot INTEGER NOT NULL, psk TEXT NOT NULL, ip TEXT UNIQUE NOT NULL, UNIQUE(user_id,slot));
    CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      host TEXT NOT NULL, port INTEGER NOT NULL, repeat INTEGER NOT NULL DEFAULT 4,
      fec_k INTEGER NOT NULL DEFAULT 8, fec INTEGER NOT NULL DEFAULT 1,
      autotune INTEGER NOT NULL DEFAULT 1, jitter INTEGER NOT NULL DEFAULT 0,
      mtu INTEGER NOT NULL DEFAULT 1280, dns TEXT NOT NULL DEFAULT '1.1.1.1');
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL);
    ''')
    if not c.execute('SELECT 1 FROM servers LIMIT 1').fetchone():
        c.execute('INSERT INTO servers(name,host,port) VALUES(?,?,?)', ('Primary',HOST,PORT))
    # Preserve imported credentials as device slot 1.
    c.execute('INSERT OR IGNORE INTO devices(user_id,slot,psk,ip) SELECT id,1,psk,ip FROM users')

sys.path.insert(0,str(Path(__file__).resolve().parent))
from kanki_cluster import Controller, ClusterError, APPLY_SECONDS
cluster_controller=Controller(DB,enabled=CLUSTER)
if CLUSTER: cluster_controller.require_ready()

def query(sql, args=()):
    with sqlite3.connect(DB) as c:
        c.row_factory = sqlite3.Row
        return [dict(x) for x in c.execute(sql, args)]

def users(): return query('SELECT * FROM users ORDER BY id')
def devices(uid): return query('SELECT * FROM devices WHERE user_id=? ORDER BY slot', (uid,))

def active(u):
    return bool(u['enabled']) and (not u['expires'] or u['expires'] >= dt.datetime.now(dt.timezone.utc).date().isoformat())

def expiry(u):
    if not u['expires']: return 0
    return max(1,int(dt.datetime.combine(dt.date.fromisoformat(u['expires']),dt.time(),dt.timezone.utc).timestamp())+86400)

def status():
    result = {'online':False,'updated':0,'accounts':{},'sessions':[]}
    try:
        lines = STATUS.read_text().splitlines()
        head = lines[0].split()
        if head[0] != 'KANKI_STATUS_V1': return result
        result['updated'] = int(head[1]); result['online'] = 0 <= time.time()-int(head[1]) < 5
        for line in lines[1:]:
            p = line.split()
            if p[0] == 'account': result['accounts'][p[1]] = {'rx':int(p[2]),'tx':int(p[3]),'quota':int(p[4])}
            elif p[0] == 'session': result['sessions'].append({'name':p[1],'account':p[2],'connected':p[3]=='1','ip':p[4],'last_rx':int(p[5])})
    except (OSError, ValueError, IndexError): pass
    return result

def publish():
    begin, end = '# BEGIN KANKI ADMIN USERS', '# END KANKI ADMIN USERS'
    original = CONF.read_text() if CONF.exists() else 'tun kanki0\naddress 10.66.0.1/16\nmtu 1280\nport udp 4000 repeat=4 fec_k=8 fec=1 autotune=1 jitter=0\n'
    if original.count(begin) != original.count(end) or original.count(begin)>1:
        raise ValueError('Invalid managed section in configuration')
    if begin in original:
        a, remainder = original.split(begin,1)
        if end not in remainder: raise ValueError('Invalid managed section order')
        original = a + remainder.split(end,1)[1]
    if any(re.match(r'\s*user\s', line) for line in original.splitlines()):
        raise ValueError('Unmanaged users in configuration; import them before enabling the panel')
    lines = []
    if not CLUSTER:
        # Single-server mode: the panel's server profiles are the engine's real
        # listeners, so a subscription always names the port the engine opened.
        original = '\n'.join(l for l in original.splitlines() if not re.match(r'\s*(port|mtu)(\s|$)', l))
        profiles = query('SELECT * FROM servers ORDER BY id')
        lines.append(f"mtu {max(x['mtu'] for x in profiles)}")
        for x in profiles:
            lines.append(f"port udp {x['port']} repeat={x['repeat']} fec_k={x['fec_k']} fec={int(bool(x['fec']))} autotune={int(bool(x['autotune']))} jitter={x['jitter']}")
    for u in users():
        # Retain inactive accounts in config so disable/expiry cannot reset quota.
        cutoff=expiry(u) if u['enabled'] and not CLUSTER else 1
        for d in devices(u['id']):
            lines.append(f"user {u['name']}-d{d['slot']} {d['psk']} {d['ip']} - group={u['name']} quota={u['quota_bytes']} expires={cutoff}")
    data = original.rstrip()+'\n'+begin+'\n'+'\n'.join(lines)+'\n'+end+'\n'
    if CONF.exists() and CONF.read_text()==data: return
    fd, tmp = tempfile.mkstemp(dir=CONF.parent, prefix='.kanki-')
    try:
        with os.fdopen(fd,'w') as f:
            os.fchmod(f.fileno(),0o640); f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,CONF)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def audit(c, action, target):
    c.execute('INSERT INTO audit(at,action,target) VALUES(?,?,?)',(int(time.time()),action,target))

def validate_user(d, create=False):
    if not isinstance(d,dict): raise ValueError('JSON object required')
    allowed = {'enabled','expires','quota_bytes','connections'} | ({'name'} if create else set())
    if not d or set(d)-allowed: raise ValueError('Unsupported fields')
    if create and (not isinstance(d.get('name'),str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,24}',d['name'])):
        raise ValueError('Name: 1–24 ASCII letters, digits, - or _')
    if 'enabled' in d and type(d['enabled']) is not bool: raise ValueError('enabled must be boolean')
    if d.get('expires') is not None:
        if not isinstance(d['expires'],str): raise ValueError('Invalid date')
        if dt.date.fromisoformat(d['expires']).isoformat()!=d['expires']: raise ValueError('Use YYYY-MM-DD')
    for key,lo,hi in [('quota_bytes',0,10**18),('connections',1,8)]:
        if key in d and (type(d[key]) is not int or not lo<=d[key]<=hi): raise ValueError('Invalid '+key)

def slots(c, uid, count):
    current = c.execute('SELECT slot FROM devices WHERE user_id=?',(uid,)).fetchall()
    total=c.execute('SELECT COUNT(*) FROM devices').fetchone()[0]
    if total+count-len(current)>4096: raise ValueError('Server capacity is 4096 provisioned device slots')
    used = {x[0] for x in c.execute('SELECT ip FROM devices')}
    net = ipaddress.ip_network('10.66.0.0/16')
    for slot in range(1,count+1):
        if any(x[0]==slot for x in current): continue
        ip = next((str(a) for a in net.hosts() if str(a)!='10.66.0.1' and str(a) not in used),None)
        if not ip: raise ValueError('Address pool exhausted')
        c.execute('INSERT INTO devices(user_id,slot,psk,ip) VALUES(?,?,?,?)',(uid,slot,secrets.token_hex(32),ip));used.add(ip)
    c.execute('DELETE FROM devices WHERE user_id=? AND slot>?',(uid,count))

class Handler(BaseHTTPRequestHandler):
    server_version='KANKI'
    def reply(self, code, body, typ='application/json'):
        if typ=='application/json': body=json.dumps(body,ensure_ascii=False)
        data=body.encode() if isinstance(body,str) else body
        self.send_response(code)
        for k,v in {'Content-Type':typ+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Length':str(len(data))}.items(): self.send_header(k,v)
        if typ=='text/html': self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers();self.wfile.write(data)
    def auth(self):
        value=self.headers.get('Authorization','')
        # Compare fixed-size digests, including when a malformed non-ASCII token arrives.
        return hmac.compare_digest(hashlib.sha256(value.encode()).digest(),hashlib.sha256(('Bearer '+ADMIN).encode()).digest())
    def body(self, maximum=16384):
        try: n=int(self.headers.get('Content-Length','0'))
        except ValueError: raise ValueError('Invalid Content-Length')
        if not 2<=n<=maximum: raise ValueError('Invalid body size')
        d=json.loads(self.rfile.read(n))
        if not isinstance(d,dict): raise ValueError('JSON object required')
        return d
    def do_GET(self):
        path=urlsplit(self.path).path
        if path in ('/','/app.js','/style.css'):
            file={'/':'index.html','/app.js':'app.js','/style.css':'style.css'}[path]
            return self.reply(200,Path(__file__).with_name(file).read_text(),{'/':'text/html','/app.js':'application/javascript','/style.css':'text/css'}[path])
        if re.fullmatch(r'/sub/[A-Za-z0-9_-]{32,128}',path):
            u=next((u for u in users() if hmac.compare_digest(u['token'],path[5:]) and active(u)),None)
            if not u: return self.reply(404,{'error':'Subscription unavailable'})
            profiles=cluster_controller.subscription_profiles(u) if CLUSTER else []
            if CLUSTER and not profiles: return self.reply(503,{'error':'Device assignment is pending or its node lease is offline'})
            for d in ([] if CLUSTER else devices(u['id'])):
                for s in query('SELECT * FROM servers ORDER BY id'):
                    profiles.append({'name':f"{s['name']} · Device {d['slot']}",'device':d['slot'],'server':s['host'],'port':s['port'],'key':d['psk'],'ip':d['ip'],'repeat':s['repeat'],'fec_k':s['fec_k'],'fec':bool(s['fec']),'autotune':bool(s['autotune']),'jitter':s['jitter'],'mtu':s['mtu'],'dns':s['dns']})
            return self.reply(200,{'version':1,'protocol':'kanki','account':u['name'],'expires':u['expires'],'quota_bytes':u['quota_bytes'],'profiles':profiles})
        if not self.auth(): return self.reply(401,{'error':'Unauthorized'})
        if path=='/api/nodes': return self.reply(200,cluster_controller.nodes())
        if path=='/api/status':
            if CLUSTER:
                ns=cluster_controller.nodes()
                return self.reply(200,{'mode':'cluster','online':any(n['online'] for n in ns),'updated':int(cluster_controller.clock()),'accounts':{},'sessions':[],'nodes':ns})
            return self.reply(200,{'mode':'local',**status()})
        if path=='/api/users':
            stats=status();result=[]
            for u in users():
                usage=cluster_controller.account_usage(u['id']) if CLUSTER else stats['accounts'].get(u['name'],{'rx':0,'tx':0})
                result.append({k:v for k,v in u.items() if k not in ('psk','token')}|{'active':active(u),'subscription':PUBLIC+'/sub/'+u['token'],'connections':len(devices(u['id'])),'usage':usage,'connected':sum(x['connected'] for x in stats['sessions'] if x['account']==u['name']) if stats['online'] else 0})
            if CLUSTER:
                now=int(cluster_controller.clock())
                for row in result:
                    row['devices']=cluster_controller.device_view(row['id'])
                    with cluster_controller.connect() as c:
                        row['connected']=c.execute('SELECT COUNT(*) FROM node_sessions s JOIN nodes n ON n.id=s.node_id WHERE s.account_id=? AND s.connected=1 AND n.enabled=1 AND n.ready=1 AND n.applied_until>?',(row['cluster_uuid'],now)).fetchone()[0]
            return self.reply(200,result)
        if path=='/api/servers': return self.reply(200,query('SELECT * FROM servers'))
        if path=='/api/audit': return self.reply(200,query('SELECT * FROM audit ORDER BY id DESC LIMIT 100'))
        return self.reply(404,{'error':'Not found'})
    def mutate(self, method):
        if not self.auth(): return self.reply(401,{'error':'Unauthorized'})
        path=urlsplit(self.path).path
        try:
            d={} if method=='DELETE' else self.body()
            if path.startswith('/api/nodes') or path.startswith('/api/devices/'):
                if not CLUSTER: raise ClusterError('Enable cluster mode before managing nodes',409)
                if method=='POST' and path=='/api/nodes': return self.reply(201,cluster_controller.create_node(d))
                m=re.fullmatch(r'/api/nodes/([a-f0-9]{32})',path)
                if m and method=='PATCH' and set(d)=={'enabled'}:
                    cluster_controller.set_enabled(m[1],d['enabled']);return self.reply(200,{'ok':True,'revocation_within_seconds':APPLY_SECONDS(cluster_controller.lease_seconds)})
                m=re.fullmatch(r'/api/devices/(\d+)/move',path)
                if m and method=='POST' and set(d)=={'node_id'} and isinstance(d['node_id'],str):
                    return self.reply(200,cluster_controller.move(int(m[1]),d['node_id']))
                return self.reply(404,{'error':'Not found'})
            with lock:
                # Check publishing permissions/unmanaged data before modifying the database.
                publish()
                with sqlite3.connect(DB) as c:
                    c.row_factory=sqlite3.Row
                    c.execute('BEGIN IMMEDIATE')
                    if method=='POST' and path=='/api/users':
                        validate_user(d,True)
                        # users.ip remains for backward-compatible schema; real slots have distinct IPs.
                        count=d.get('connections',1)
                        uid=c.execute('INSERT INTO users(name,psk,ip,token,quota_bytes,expires,enabled) VALUES(?,?,?,?,?,?,?)',
                            (d['name'],secrets.token_hex(32),'pending-'+secrets.token_hex(8),secrets.token_urlsafe(32),d.get('quota_bytes',0),d.get('expires'),int(d.get('enabled',True)))).lastrowid
                        slots(c,uid,count)
                        dev=c.execute('SELECT * FROM devices WHERE user_id=? AND slot=1',(uid,)).fetchone()
                        c.execute('UPDATE users SET ip=?,psk=? WHERE id=?',(dev['ip'],dev['psk'],uid))
                        audit(c,'create-user',d['name'])
                    elif (m:=re.fullmatch(r'/api/users/([A-Za-z0-9_-]{1,24})(/rotate)?',path)):
                        u=c.execute('SELECT * FROM users WHERE name=?',(m[1],)).fetchone()
                        if not u: return self.reply(404,{'error':'User not found'})
                        if method=='DELETE' and not m[2]:
                            c.execute('DELETE FROM devices WHERE user_id=?',(u['id'],));c.execute('DELETE FROM users WHERE id=?',(u['id'],))
                        elif method=='POST' and m[2]:
                            c.execute('UPDATE users SET token=? WHERE id=?',(secrets.token_urlsafe(32),u['id']))
                            for dev in c.execute('SELECT id,node_id FROM devices WHERE user_id=?',(u['id'],)).fetchall():
                                c.execute('UPDATE devices SET psk=? WHERE id=?',(secrets.token_hex(32),dev['id']))
                                if CLUSTER and dev['node_id']:
                                    c.execute('UPDATE devices SET required_seq=(SELECT seq+1 FROM nodes WHERE id=?) WHERE id=?',(dev['node_id'],dev['id']))
                        elif method=='PATCH' and not m[2]:
                            validate_user(d)
                            if CLUSTER and 'quota_bytes' in d: cluster_controller.validate_quota(c,u['id'],d['quota_bytes'])
                            if CLUSTER and 'connections' in d: cluster_controller.prepare_slot_change(c,u,d['connections'])
                            for k,v in d.items():
                                if k=='connections': slots(c,u['id'],v)
                                else: c.execute('UPDATE users SET '+k+'=? WHERE id=?',(v,u['id']))
                        else: return self.reply(405,{'error':'Method not allowed'})
                        audit(c,method.lower()+'-user'+('-rotate' if m[2] else ''),m[1])
                    elif path=='/api/servers' and method=='POST':
                        if CLUSTER: raise ClusterError('Cluster profiles are created with their node')
                        allowed={'name','host','port','repeat','fec_k','fec','autotune','jitter','mtu','dns'}
                        if set(d)-allowed or not isinstance(d.get('name'),str) or not 1<=len(d['name'])<=80: raise ValueError('Invalid server name')
                        if not isinstance(d.get('host'),str) or not re.fullmatch(r'[A-Za-z0-9.-]{1,253}',d['host']): raise ValueError('Invalid IPv4/hostname')
                        for k,lo,hi in [('port',1,65535),('repeat',3,10),('fec_k',2,16),('jitter',0,100000),('mtu',576,1400)]:
                            if k in d and (type(d[k]) is not int or not lo<=d[k]<=hi): raise ValueError('Invalid '+k)
                        if 'port' not in d: raise ValueError('Port required')
                        for k in ('fec','autotune'):
                            if k in d and type(d[k]) is not bool: raise ValueError('Invalid '+k)
                        if 'dns' in d and ipaddress.ip_address(d['dns']).version!=4: raise ValueError('IPv4 DNS required')
                        if c.execute('SELECT 1 FROM servers WHERE port=?',(d['port'],)).fetchone(): raise ValueError('This UDP port is already used by another profile')
                        if c.execute('SELECT COUNT(*) FROM servers').fetchone()[0]>=8: raise ValueError('Maximum 8 listening profiles')
                        keys=list(d);c.execute('INSERT INTO servers('+','.join(keys)+') VALUES('+','.join('?' for _ in keys)+')',list(d.values()));audit(c,'create-server',d['name'])
                    elif (m:=re.fullmatch(r'/api/servers/(\d+)',path)) and method=='DELETE':
                        if CLUSTER: raise ClusterError('Disable the node instead of deleting its accounting profile')
                        if c.execute('SELECT COUNT(*) FROM servers').fetchone()[0]<=1: raise ValueError('Keep at least one server')
                        c.execute('DELETE FROM servers WHERE id=?',(int(m[1]),));audit(c,'delete-server',m[1])
                    else: return self.reply(404,{'error':'Not found'})
                    cluster_controller.ensure_ids(c)
                publish()
            return self.reply(201 if method=='POST' else 200,{'ok':True,'apply_within_seconds':APPLY_SECONDS(cluster_controller.lease_seconds) if CLUSTER else 2})
        except ClusterError as e:
            return self.reply(e.code,{'error':str(e)})
        except (ValueError,TypeError,KeyError,sqlite3.IntegrityError) as e:
            return self.reply(400,{'error':str(e)})
        except (OSError,sqlite3.OperationalError):
            return self.reply(503,{'error':'Storage unavailable; check service logs and reconcile configuration'})
    def do_POST(self):
        if urlsplit(self.path).path=='/api/agent/sync':
            if not CLUSTER:return self.reply(503,{'error':'Cluster mode is disabled'})
            auth=self.headers.get('Authorization','')
            if not auth.startswith('Bearer ') or len(auth)>256:return self.reply(401,{'error':'Unauthorized node'})
            try:return self.reply(200,cluster_controller.sync(auth[7:],self.body(2097152)))
            except ClusterError as e:return self.reply(e.code,{'error':str(e)})
            except (ValueError,TypeError):return self.reply(400,{'error':'Invalid node payload'})
            except (OSError,sqlite3.Error):return self.reply(503,{'error':'Control-plane storage unavailable'})
        self.mutate('POST')
    def do_PATCH(self): self.mutate('PATCH')
    def do_DELETE(self): self.mutate('DELETE')
    def log_message(self,*args): pass  # subscription tokens must never enter access logs
    def setup(self):
        super().setup();self.connection.settimeout(10)

def reconcile():
    while True:
        time.sleep(2)
        try:
            with lock: publish()
        except (OSError,ValueError,sqlite3.Error) as e: print('Configuration reconciliation failed:',type(e).__name__,flush=True)

if __name__=='__main__':
    with lock: publish()
    threading.Thread(target=reconcile,daemon=True).start()
    print(f'KANKI panel: {BIND}:{HTTP_PORT}',flush=True)
    ThreadingHTTPServer((BIND,HTTP_PORT),Handler).serve_forever()
