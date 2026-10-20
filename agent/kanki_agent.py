#!/usr/bin/env python3
"""Pull-only KANKI node agent. No shell commands arrive from the controller."""
import argparse
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

HEADER=b'KANKI_CREDIT_V1\n'
MAX=10**18
class AgentError(ValueError):pass

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'))
def atomic(path,data,mode=0o600):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    raw=data.encode() if isinstance(data,str) else data
    fd,tmp=tempfile.mkstemp(dir=path.parent,prefix='.kanki-agent-')
    try:
        with os.fdopen(fd,'wb') as f:os.fchmod(f.fileno(),mode);f.write(raw);f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
        directory=os.open(path.parent,os.O_DIRECTORY);os.fsync(directory);os.close(directory)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def number(value,lo,hi,name):
    if type(value) is not int or not lo<=value<=hi:raise AgentError('Invalid '+name)
    return value

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise AgentError('Controller redirects are not accepted')

class Agent:
    def __init__(self,controller,token,state,config,status,ledger,binary,tun='kanki0',ca=None,clock=time.time,allow_loopback_http=False):
        self.controller=controller.rstrip('/');self.token=token;self.state_path=Path(state);self.config=Path(config)
        self.status=Path(status);self.ledger=Path(ledger);self.binary=str(binary);self.tun=tun;self.clock=clock;self.error=None
        parts=urllib.parse.urlsplit(self.controller)
        try:loopback=ipaddress.ip_address(parts.hostname or '').is_loopback
        except ValueError:loopback=parts.hostname=='localhost'
        if parts.scheme!='https' and not (allow_loopback_http and loopback and parts.scheme=='http'):raise AgentError('HTTPS controller URL required')
        if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ('','/'):raise AgentError('Controller must be an HTTPS origin')
        if not isinstance(token,str) or not 32<=len(token)<=128 or not re.fullmatch(r'[A-Za-z0-9_-]+',token):raise AgentError('Invalid node credential')
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,15}',tun):raise AgentError('Invalid TUN name')
        context=ssl.create_default_context(cafile=ca)
        handlers=[NoRedirect(),urllib.request.HTTPSHandler(context=context)]
        if loopback:handlers.append(urllib.request.ProxyHandler({})) # only local test/control traffic
        self.http=urllib.request.build_opener(*handlers)
        self.state_path.parent.mkdir(parents=True,exist_ok=True)
        self.lock=open(str(self.state_path)+'.lock','a')
        try:fcntl.flock(self.lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:self.lock.close();raise AgentError('Another agent owns this node state')
        try:
            if self.state_path.exists():
                self.state=json.loads(self.state_path.read_text())
                if self.state.get('version')!=1 or not re.fullmatch('[a-f0-9]{32}',self.state.get('instance','')):raise AgentError('Invalid node identity state')
            else:
                if self.ledger.exists() and self.ledger.read_bytes()!=HEADER:raise AgentError('State missing beside an established journal; restore identity instead of resetting quota')
                self.state={'version':1,'instance':secrets.token_hex(16),'seq':1,'applied':0,'initialized':False,'pending':None,'node_id':None,'known':{},'lease_until':0}
                self.save()
            if not self.state.get('initialized'):
                if not self.ledger.exists():
                    self.ledger.parent.mkdir(parents=True,exist_ok=True)
                    fd=os.open(self.ledger,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
                    with os.fdopen(fd,'wb') as f:f.write(HEADER);f.flush();os.fsync(f.fileno())
                    directory=os.open(self.ledger.parent,os.O_DIRECTORY);os.fsync(directory);os.close(directory)
                self.state['initialized']=True;self.save()
            if not self.ledger.exists():raise AgentError('Durable journal missing: refusing to recreate previously issued credit')
            with self.ledger.open('rb') as f:
                if f.readline()!=HEADER:raise AgentError('Invalid durable journal header')
        except Exception:self.close();raise
    def close(self):
        if getattr(self,'lock',None):self.lock.close();self.lock=None
    def save(self):atomic(self.state_path,canonical(self.state))
    def stats(self):
        ready=False;updated=0;sessions=[]
        try:
            lines=self.status.read_text().splitlines();header=lines[0].split()
            if len(header)<4 or header[0]!='KANKI_STATUS_V1' or header[3]!='credit-v1':raise AgentError('Engine must run with --credit-ledger')
            updated=int(header[1]);generation=next(int(x.split()[1]) for x in lines if x.startswith('generation '))
            ready=0<=self.clock()-updated<=5 and generation==self.state['applied']
            for line in lines[1:]:
                p=line.split()
                if p and p[0]=='account' and p[1] in self.state['known']:
                    if len(p)!=6:raise AgentError('Credit counters missing from engine status')
                    rx,tx,charged=int(p[2]),int(p[3]),int(p[5]);old=self.state['known'][p[1]]
                    if not old['charged']<=charged<=old['quota'] or rx<0 or tx<0 or rx+tx>charged:raise AgentError('Nonmonotonic engine credit counters')
                    old.update(charged=charged,rx=max(old['rx'],rx),tx=max(old['tx'],tx))
                elif p and p[0]=='session' and len(p)>=6 and p[2] in self.state['known']:
                    sessions.append({'name':p[1],'account':p[2],'connected':p[3]=='1','last_rx':int(p[5])})
        except FileNotFoundError:pass # bootstrap is permitted before the engine starts
        except (ValueError,IndexError,StopIteration) as e:
            if isinstance(e,AgentError):raise
            raise AgentError('Invalid engine status') from e
        accounts=[{'id':aid,'charged':v['charged'],'rx':v['rx'],'tx':v['tx']} for aid,v in sorted(self.state['known'].items())]
        return {'ready':ready,'updated':updated,'accounts':accounts,'sessions':sessions}
    def render(self,document):
        p=document['profile'];port=number(p.get('port'),1,65535,'port');repeat=number(p.get('repeat'),3,10,'repeat')
        fk=number(p.get('fec_k'),2,16,'FEC');jitter=number(p.get('jitter'),0,100000,'jitter');mtu=number(p.get('mtu'),576,1400,'MTU')
        for k in ('fec','autotune'):
            if p.get(k) not in (0,1,False,True) or not isinstance(p.get(k),(bool,int)):raise AgentError('Invalid profile flag')
        lines=[f'tun {self.tun}','address 10.66.0.1/16',f'mtu {mtu}',f'port udp {port} repeat={repeat} fec_k={fk} fec={int(p["fec"])} autotune={int(p["autotune"])} jitter={jitter}',f'generation {document["seq"]}']
        # Listener changes require a deliberate engine restart; never silently apply only half a profile.
        listener='\n'.join(lines[:4])
        if self.state.get('listener') and self.state['listener']!=listener:raise AgentError('Listener changed; stop engine and use explicit reprovisioning')
        names=set();addresses=set();keys=set();users=document.get('users')
        if not isinstance(users,list) or len(users)>4096:raise AgentError('Invalid users list')
        now=int(self.clock())
        for u in users:
            if set(u)!={'name','key','ip','group','quota','expires'} or not re.fullmatch('a[a-f0-9]{32}',u.get('group','')):raise AgentError('Invalid account identity')
            if not isinstance(u.get('name'),str) or not re.fullmatch(re.escape(u['group'])+r'-d[1-8]',u['name']):raise AgentError('Invalid device identity')
            if not isinstance(u.get('key'),str) or not re.fullmatch('[a-fA-F0-9]{64}',u['key']):raise AgentError('Invalid key')
            try:
                ip=ipaddress.ip_address(u['ip']);net=ipaddress.ip_network('10.66.0.0/16')
                if ip.version!=4 or ip not in net or str(ip) in ('10.66.0.0','10.66.0.1','10.66.255.255'):raise ValueError()
            except (ValueError,TypeError):raise AgentError('Invalid tunnel address')
            number(u['quota'],0,MAX,'credit');number(u['expires'],1,document['lease_until'],'lease cutoff')
            if u['name'] in names or u['ip'] in addresses or u['key'] in keys:raise AgentError('Duplicate device credentials/address')
            names.add(u['name']);addresses.add(u['ip']);keys.add(u['key'])
            old=self.state['known'].get(u['group'])
            if old and u['quota']<old['quota']:raise AgentError('Issued credit cannot decrease')
            lines.append(f'user {u["name"]} {u["key"]} {ip} - group={u["group"]} quota={u["quota"]} expires={u["expires"]}')
        return '\n'.join(lines)+'\n',listener
    def apply(self,document):
        if not isinstance(document,dict):raise AgentError('Invalid controller response')
        signature=document.get('signature','');payload={k:v for k,v in document.items() if k!='signature'}
        expected=hmac.new(self.token.encode(),canonical(payload).encode(),hashlib.sha256).hexdigest()
        if not isinstance(signature,str) or not hmac.compare_digest(signature,expected):raise AgentError('Controller signature verification failed')
        if document.get('version')!=1 or document.get('instance')!=self.state['instance'] or document.get('seq')!=self.state['seq']:raise AgentError('Response does not match persisted request')
        node_id=document.get('node_id')
        if not isinstance(node_id,str) or not re.fullmatch('[a-f0-9]{32}',node_id):raise AgentError('Invalid node identity')
        if self.state['node_id'] and self.state['node_id']!=node_id:raise AgentError('Node credential identity changed')
        now=int(self.clock());server=number(document.get('server_time'),0,2**53-1,'server time');until=number(document.get('lease_until'),server+1,server+60,'lease')
        if abs(now-server)>10 and until>now:raise AgentError('Node/controller clocks differ by more than 10 seconds')
        if until<=now:
            # A committed cached response can expire before a retry arrives. Advance
            # its sequence without claiming it was installed; request a fresh lease.
            self.fail_closed();self.state.update(seq=self.state['seq']+1,pending=None,node_id=node_id);self.save();return False
        config,listener=self.render(document)
        self.config.parent.mkdir(parents=True,exist_ok=True)
        fd,tmp=tempfile.mkstemp(dir=self.config.parent,prefix='.kanki-validate-');os.close(fd)
        try:
            atomic(tmp,config,0o640)
            check=subprocess.run([self.binary,'--config',tmp,'--check-config'],capture_output=True,timeout=15)
            if check.returncode:raise AgentError('Engine rejected signed node configuration')
            if self.clock()>=until:raise AgentError('Lease expired during configuration validation')
            atomic(self.config,config,0o640)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
        for u in document['users']:
            current=self.state['known'].setdefault(u['group'],{'charged':0,'rx':0,'tx':0,'quota':0})
            current['quota']=u['quota']
        # Reports already committed by this response may retire removed accounts.
        # Absolute grants and the engine journal remain authoritative if they return.
        active={u['group'] for u in document['users']}
        self.state['known']={aid:v for aid,v in self.state['known'].items() if aid in active}
        self.state.update(seq=self.state['seq']+1,applied=document['seq'],pending=None,node_id=node_id,listener=listener,lease_until=until)
        self.save();self.error=None;return True
    def fail_closed(self):
        if not self.config.exists():return
        lines=[]
        for line in self.config.read_text().splitlines():
            if line.startswith('user '):
                line=re.sub(r' expires=[0-9]+', ' expires=1',line)
                if ' expires=' not in line:line+=' expires=1'
            lines.append(line)
        atomic(self.config,'\n'.join(lines)+'\n',0o640)
    def sync_once(self):
        if self.state['pending'] is None:
            self.state['pending']={'instance':self.state['instance'],'seq':self.state['seq'],'ack':self.state['applied'],'stats':self.stats(),'error':self.error}
            self.save() # retry the exact same committed request after network/agent failures
        request=urllib.request.Request(self.controller+'/api/agent/sync',data=canonical(self.state['pending']).encode(),headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'},method='POST')
        try:
            with self.http.open(request,timeout=10) as response:
                raw=response.read(2097153)
                if len(raw)>2097152:raise AgentError('Controller response exceeds limit')
                document=json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code in (401,403,409):self.fail_closed()
            raise AgentError('Controller HTTP '+str(e.code)) from e
        except (urllib.error.URLError,TimeoutError,OSError,ValueError) as e:
            if self.clock()>=self.state['lease_until']:self.fail_closed()
            self.error=type(e).__name__[:120]
            raise
        try:return self.apply(document)
        except (AgentError,KeyError,TypeError) as e:
            # Never keep serving past the lease; report why on the next request.
            if self.clock()>=self.state['lease_until']:self.fail_closed()
            self.error=('Configuration rejected: '+(str(e) if isinstance(e,AgentError) else type(e).__name__))[:240]
            raise

def main():
    p=argparse.ArgumentParser();p.add_argument('--once',action='store_true');args=p.parse_args()
    agent=Agent(os.environ['KANKI_CONTROLLER'],os.environ['KANKI_NODE_TOKEN'],
        os.environ.get('KANKI_NODE_STATE','/var/lib/kanki/agent.json'),os.environ.get('KANKI_CONF','/etc/kanki/kanki.conf'),
        os.environ.get('KANKI_STATUS','/var/lib/kanki/status.txt'),os.environ.get('KANKI_CREDIT_LEDGER','/var/lib/kanki/credit.log'),
        os.environ.get('KANKI_VPND','/usr/local/bin/kanki-vpnd'),tun=os.environ.get('KANKI_TUN','kanki0'),ca=os.environ.get('KANKI_CONTROLLER_CA'))
    try:
        while True:
            try:applied=agent.sync_once()
            except Exception as e:
                print('Node synchronization failed:',type(e).__name__,str(e)[:160],flush=True)
                if args.once:raise SystemExit(1)
            else:
                if args.once:raise SystemExit(0 if applied else 1)
            time.sleep(3)
    finally:agent.close()
if __name__=='__main__':main()
