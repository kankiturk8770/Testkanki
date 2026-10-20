import concurrent.futures
import http.client
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

class AdminIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory();cls.root=Path(cls.tmp.name)
        cls.token='test-'+('a'*48)
        for k,v in {'KANKI_ADMIN_TOKEN':cls.token,'KANKI_ADMIN_DB':str(cls.root/'db.sqlite3'),'KANKI_CONF':str(cls.root/'kanki.conf'),'KANKI_STATUS':str(cls.root/'status.txt'),'KANKI_PUBLIC_URL':'https://vpn.example.test','KANKI_PUBLIC_HOST':'vpn.example.test'}.items(): os.environ[k]=v
        spec=importlib.util.spec_from_file_location('admin',Path(__file__).resolve().parents[1]/'admin/kanki_admin.py')
        cls.app=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.app)
        cls.http=ThreadingHTTPServer(('127.0.0.1',0),cls.app.Handler)
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls): cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.tmp.cleanup()
    def request(self,method,path,body=None,auth=True,raw=False):
        c=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=5)
        headers={'Authorization':'Bearer '+self.token} if auth else {}
        data=body if raw else (json.dumps(body) if body is not None else None)
        try:
            c.request(method,path,data,headers);r=c.getresponse();payload=r.read();typ=r.getheader('Content-Type','')
            return r.status, json.loads(payload) if typ.startswith('application/json') else payload.decode()
        finally: c.close()
    def create(self,name,**extra):return self.request('POST','/api/users',{'name':name,**extra})
    def test_01_auth_and_public_shell(self):
        self.assertEqual(self.request('GET','/')[0],200)
        self.assertEqual(self.request('GET','/api/users',auth=False)[0],401)
        self.assertEqual(self.request('POST','/api/users',{'name':'bad'},auth=False)[0],401)
        self.assertEqual(self.request('GET','/api/users')[0],200)
    def test_02_lifecycle_subscription_slots_and_rotation(self):
        self.assertEqual(self.create('alice',connections=2,quota_bytes=1024)[0],201)
        listing=self.request('GET','/api/users')[1];u=next(x for x in listing if x['name']=='alice')
        self.assertNotIn('psk',u);self.assertNotIn('token',u)
        path='/'+u['subscription'].split('/',3)[3];code,sub=self.request('GET',path,auth=False)
        self.assertEqual(code,200);self.assertEqual(sub['protocol'],'kanki');self.assertEqual(len(sub['profiles']),2)
        a,b=sub['profiles'];self.assertNotEqual(a['ip'],b['ip']);self.assertNotEqual(a['key'],b['key'])
        conf=(self.root/'kanki.conf').read_text();self.assertIn('group=alice quota=1024',conf)
        self.assertEqual(self.request('POST','/api/users/alice/rotate',{})[0],201)
        self.assertEqual(self.request('GET',path,auth=False)[0],404)
        self.assertEqual(self.request('PATCH','/api/users/alice',{'enabled':False})[0],200)
        self.assertIn('user alice-d',(self.root/'kanki.conf').read_text())
        self.assertIn('expires=1',(self.root/'kanki.conf').read_text())
        self.assertEqual(self.request('PATCH','/api/users/alice',{'enabled':True,'connections':1,'expires':'2000-01-01'})[0],200)
        self.assertIn('user alice-d',(self.root/'kanki.conf').read_text())
        current=next(x for x in self.request('GET','/api/users')[1] if x['name']=='alice')
        self.assertFalse(current['active'])
        self.assertEqual(self.request('GET','/'+current['subscription'].split('/',3)[3],auth=False)[0],404)
        self.assertEqual(self.request('DELETE','/api/users/alice')[0],200)
    def test_03_invalid_inputs(self):
        for data in [[],None,{'name':'x\nuser y'}, {'name':'bad','connections':9},{'name':'bad','quota_bytes':True},{'name':'bad','expires':'no'},{'name':'bad','enabled':1}]:
            self.assertEqual(self.request('POST','/api/users',json.dumps(data),raw=True)[0],400,str(data))
        self.assertEqual(self.create('duplicate')[0],201);self.assertEqual(self.create('duplicate')[0],400)
        self.assertEqual(self.request('PATCH','/api/users/duplicate',{'expires':False})[0],400)
        self.assertEqual(self.request('PATCH','/api/users/duplicate',{'enabled':'yes'})[0],400)
    def test_04_concurrent_allocation(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            results=list(ex.map(lambda n:self.create('parallel'+str(n),connections=2),range(16)))
        self.assertTrue(all(x[0]==201 for x in results),results)
        ds=self.app.query('SELECT ip FROM devices');self.assertEqual(len(ds),len(set(x['ip'] for x in ds)))
        conf=(self.root/'kanki.conf').read_text();self.assertEqual(conf.count('# BEGIN KANKI ADMIN USERS'),1)
    def test_05_servers_and_bad_profiles(self):
        self.assertEqual(self.request('POST','/api/servers',{'name':'Test','host':'127.0.0.1','port':4001,'fec_k':17})[0],400)
        self.assertEqual(self.request('POST','/api/servers',{'name':'Test','host':'127.0.0.1','port':4001,'mtu':1280,'repeat':6})[0],201)
        # Single-server mode: profiles are the engine's real listeners.
        conf=(self.root/'kanki.conf').read_text()
        self.assertIn('port udp 4000 repeat=4',conf);self.assertIn('port udp 4001 repeat=6',conf)
        self.assertEqual(sum(1 for l in conf.splitlines() if l.startswith('port ')),2);self.assertEqual(conf.count('\nmtu '),1)
        self.assertEqual(self.request('POST','/api/servers',{'name':'Dup','host':'127.0.0.1','port':4001})[0],400)
        check=__import__('subprocess').run([str(Path(__file__).resolve().parents[1]/'server/kanki-vpnd'),'--config',str(self.root/'kanki.conf'),'--check-config'],capture_output=True)
        self.assertEqual(check.returncode,0,check.stderr)
        sid=self.request('GET','/api/servers')[1][-1]['id'];self.assertEqual(self.request('DELETE',f'/api/servers/{sid}')[0],200)
        self.assertNotIn('port udp 4001',(self.root/'kanki.conf').read_text())
        self.assertEqual(self.request('DELETE','/api/servers/1')[0],400)
    def test_06_status_and_audit(self):
        (self.root/'status.txt').write_text('KANKI_STATUS_V1 1 123\naccount demo 45 67 100\nsession demo-d1 demo 1 10.66.0.2 1\n')
        s=self.request('GET','/api/status')[1];self.assertFalse(s['online']);self.assertEqual(s['accounts']['demo']['rx'],45)
        self.assertGreater(len(self.request('GET','/api/audit')[1]),0)
    def test_07_preserve_unmanaged_configuration(self):
        conf=self.root/'kanki.conf';old=conf.read_text();conf.write_text('user unmanaged '+'a'*64+' 10.66.0.4\n')
        try:self.assertEqual(self.create('no-clobber')[0],400);self.assertFalse(any(u['name']=='no-clobber' for u in self.app.users()))
        finally:conf.write_text(old)

if __name__=='__main__':unittest.main(verbosity=2)
