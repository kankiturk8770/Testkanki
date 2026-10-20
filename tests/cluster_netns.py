#!/usr/bin/env python3
"""Real HTTPS controller -> two agents -> two Linux TUN engines/clients, shared quota.
Run as root in the disposable tests container with NET_ADMIN/SYS_ADMIN and /dev/net/tun.
"""
import http.server,importlib.util,json,os,secrets,socket,ssl,subprocess,sys,tempfile,threading,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'agent'))
from kanki_agent import Agent

def run(*args,**kw):return subprocess.run(list(map(str,args)),check=True,**kw)
def ns(n,*cmd,**kw):return run('ip','netns','exec',n,*cmd,**kw)
def wait_for(fn,seconds=12):
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        if fn():return
        time.sleep(.15)
    raise AssertionError('Timed out waiting for engine configuration')

def main():
    if os.geteuid()!=0 or not Path('/dev/net/tun').exists():print('SKIP: capable root container + TUN required');return 77
    run('make','-C',ROOT/'server','all','test-client',stdout=subprocess.DEVNULL)
    namespaces=[];processes=[];agents=[];httpd=None
    with tempfile.TemporaryDirectory(prefix='kanki-cluster-') as tmp:
        work=Path(tmp);logs=[]
        def launch(command,name):
            log=open(work/(name+'.log'),'w');logs.append(log);p=subprocess.Popen(list(map(str,command)),stdout=log,stderr=subprocess.STDOUT);processes.append(p);return p
        try:
            token=secrets.token_urlsafe(48)
            os.environ.update(KANKI_CLUSTER='1',KANKI_ADMIN_TOKEN=token,KANKI_ADMIN_DB=str(work/'db.sqlite3'),KANKI_CONF=str(work/'local.conf'),KANKI_STATUS=str(work/'local.status'),KANKI_PUBLIC_URL='https://controller.test',KANKI_PUBLIC_HOST='controller.test')
            spec=importlib.util.spec_from_file_location('cluster_app',ROOT/'admin/kanki_admin.py');app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)
            run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',work/'tls.key','-out',work/'tls.pem','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(work/'tls.pem',work/'tls.key')
            httpd=http.server.ThreadingHTTPServer(('127.0.0.1',0),app.Handler);httpd.socket=ctx.wrap_socket(httpd.socket,server_side=True)
            thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start();origin=f'https://127.0.0.1:{httpd.server_port}'
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=work/'tls.pem')))
            def api(path,body=None):
                req=urllib.request.Request(origin+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
                with opener.open(req,timeout=5) as r:return json.load(r)
            nodes=[api('/api/nodes',{'name':f'node{i}','host':f'198.18.{i}.1','port':4000}) for i in (1,2)]
            api('/api/users',{'name':'shared','quota_bytes':8192,'connections':2});user=api('/api/users')[0]
            for i,(d,n) in enumerate(zip(user['devices'],nodes),1):api(f"/api/devices/{d['id']}/move",{'node_id':n['id']})
            for i,n in enumerate(nodes,1):
                server=f'kc-s{i}-{os.getpid()}';client=f'kc-c{i}-{os.getpid()}'
                for name in (server,client):run('ip','netns','add',name);namespaces.append(name);run('ip','-n',name,'link','set','lo','up')
                left=f'ks{i}';right=f'kcx{i}'
                run('ip','link','add',left,'type','veth','peer','name',right);run('ip','link','set',left,'netns',server);run('ip','link','set',right,'netns',client)
                for name,iface,ip in ((server,left,f'198.18.{i}.1/24'),(client,right,f'198.18.{i}.2/24')):run('ip','-n',name,'address','add',ip,'dev',iface);run('ip','-n',name,'link','set',iface,'up')
                directory=work/str(i);directory.mkdir()
                a=Agent(origin,n['token'],directory/'agent.json',directory/'config',directory/'status',directory/'credit.log',ROOT/'server/kanki-vpnd',ca=work/'tls.pem');agents.append(a);a.sync_once()
                launch(['ip','netns','exec',server,ROOT/'server/kanki-vpnd','--config',a.config,'--status-file',a.status,'--credit-ledger',a.ledger],f'engine{i}')
                launch(['ip','netns','exec',server,'python3',ROOT/'tests/echo_servers.py'],f'echo{i}')
                wait_for(lambda:a.stats()['ready']);a.sync_once()
                conf=a.config.read_text();key=next(line.split()[2] for line in conf.splitlines() if line.startswith('user '));keyfile=directory/'key';keyfile.write_text(key+'\n')
                launch(['ip','netns','exec',client,ROOT/'tests/tools/kanki-vpn-client','--server',f'198.18.{i}.1','--key-file',keyfile,'--address',user['devices'][i-1]['ip']],f'client{i}')
                wait_for(lambda:subprocess.run(['ip','-n',client,'link','show','up','dev','kankic0'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0)
                run('ip','-n',client,'route','add','default','dev','kankic0')
            # 228 bytes each direction: durable quota permits a few echoes then blocks.
            probe='''import json,socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(.25);ok=lost=0
for i in range(20):
 s.sendto(bytes([i])*200,('10.66.0.1',18081))
 try:
  d,_=s.recvfrom(1024);assert d==bytes([i])*200;ok+=1
 except socket.timeout:lost+=1
print(json.dumps({'echoes':ok,'blocked':lost}))
assert ok>0 and lost>0
'''
            results=[]
            for i in (1,2):
                result=json.loads(subprocess.check_output(['ip','netns','exec',f'kc-c{i}-{os.getpid()}','python3','-c',probe],text=True));results.append(result)
            for a in agents:
                wait_for(lambda:a.stats()['ready']);a.sync_once()
            usage=app.cluster_controller.account_usage(user['id'])
            assert usage['allocated']==8192 and usage['charged']==8192,usage
            assert 0<usage['rx']+usage['tx']<=8192,usage
            # Kill/reopen engine 1: no credit is regained by a crash or identity retry.
            engine=next(p for p in processes if str(p.args[-1])==str(agents[0].ledger));engine.kill();engine.wait()
            a=agents[0];launch(['ip','netns','exec',f'kc-s1-{os.getpid()}',ROOT/'server/kanki-vpnd','--config',a.config,'--status-file',a.status,'--credit-ledger',a.ledger],'engine1-restarted')
            wait_for(lambda:a.stats()['ready']);a.sync_once()
            assert app.cluster_controller.account_usage(user['id'])['allocated']==8192
            print(json.dumps({'test':'HTTPS -> 2 agents -> 2 real TUN engines + clients, quota exhaustion + crash','nodes':results,'usage':usage,'result':'PASS'},sort_keys=True))
        except Exception:
            for a in agents:
                print('NODE CONFIG',a.config.read_text());print('NODE STATUS',a.status.read_text() if a.status.exists() else 'missing')
            for log in logs:log.flush();print('\nFIXTURE LOG',log.name,Path(log.name).read_text()[-5000:])
            raise
        finally:
            for p in reversed(processes):
                if p.poll() is None:p.terminate()
            for p in processes:
                try:p.wait(timeout=3)
                except subprocess.TimeoutExpired:p.kill();p.wait()
            for a in agents:a.close()
            if httpd:httpd.shutdown();httpd.server_close()
            for n in reversed(namespaces):subprocess.run(['ip','netns','delete',n],stderr=subprocess.DEVNULL)
            for log in logs:log.close()
    return 0
if __name__=='__main__':raise SystemExit(main())
