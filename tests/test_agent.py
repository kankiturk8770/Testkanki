"""Real HTTP control-plane and persisted node identity regressions."""
import hashlib,hmac,json,os,sys,unittest,urllib.error
from pathlib import Path
import test_admin as fixtures
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'agent'))
from kanki_agent import Agent,AgentError,canonical

class AgentTests(unittest.TestCase):
    def setUp(self):
        os.environ['KANKI_CLUSTER']='1';fixtures.AdminIntegration.setUpClass()
        self.api=fixtures.AdminIntegration('test_01_auth_and_public_shell');self.root=self.api.root
        self.controller=self.api.app.cluster_controller;self.now=2000000000
        self.controller.clock=lambda:self.now;self.controller.chunk=400;self.controller.lease_seconds=5
        code,self.node=self.api.request('POST','/api/nodes',{'name':'alpha','host':'alpha.test','port':4000});self.assertEqual(code,201)
        self.assertEqual(self.api.create('player',quota_bytes=1000)[0],201)
        self.user=self.api.request('GET','/api/users')[1][0]
        self.assertEqual(self.api.request('POST',f"/api/devices/{self.user['devices'][0]['id']}/move",{'node_id':self.node['id']})[0],200)
        self.agent=self.new_agent()
    def tearDown(self):
        self.agent.close();fixtures.AdminIntegration.tearDownClass();os.environ.pop('KANKI_CLUSTER',None)
    def new_agent(self):
        return Agent(f'http://127.0.0.1:{self.api.http.server_port}',self.node['token'],self.root/'agent.json',self.root/'node.conf',self.root/'node.status',self.root/'credit.log',Path(__file__).resolve().parents[1]/'server/kanki-vpnd',clock=lambda:self.now,allow_loopback_http=True)
    def status(self):
        lines=[f'KANKI_STATUS_V1 {self.now} 123 credit-v1',f"generation {self.agent.state['applied']}"]
        for aid,v in self.agent.state['known'].items():lines.append(f"account {aid} 0 0 {v['quota']} 0")
        (self.root/'node.status').write_text('\n'.join(lines)+'\n')
    def test_real_http_signed_config_and_engine_ack(self):
        self.assertTrue(self.agent.sync_once());self.assertIn('generation 1',self.agent.config.read_text())
        self.assertFalse(self.controller.nodes()[0]['online']);self.status();self.agent.sync_once()
        self.assertTrue(self.controller.nodes()[0]['online']);self.assertEqual(self.agent.state['applied'],2)
    def test_lost_response_retries_exact_request_after_restart(self):
        real=self.agent.apply
        def lost(doc):raise OSError('lost after server commit')
        self.agent.apply=lost
        with self.assertRaises(OSError):self.agent.sync_once()
        pending=canonical(self.agent.state['pending']);self.agent.close();self.agent=self.new_agent()
        self.assertEqual(canonical(self.agent.state['pending']),pending);self.agent.sync_once()
        self.assertEqual(self.agent.state['applied'],1);self.assertEqual(self.controller.nodes()[0]['seq'],1)
    def test_forged_signature_and_signed_config_injection_rejected(self):
        self.agent.sync_once();old=self.agent.config.read_text();self.status()
        self.agent.state['pending']={'instance':self.agent.state['instance'],'seq':2,'ack':1,'stats':self.agent.stats(),'error':None};self.agent.save()
        doc=self.controller.sync(self.node['token'],self.agent.state['pending']);doc['users'][0]['key']='bad\nport udp 1'
        with self.assertRaises(AgentError):self.agent.apply(doc)
        payload={k:v for k,v in doc.items() if k!='signature'}
        doc['signature']=hmac.new(self.node['token'].encode(),canonical(payload).encode(),hashlib.sha256).hexdigest()
        with self.assertRaises(AgentError):self.agent.apply(doc)
        self.assertEqual(self.agent.config.read_text(),old)
    def test_revoked_node_immediately_fences_local_configuration(self):
        self.agent.sync_once();self.controller.set_enabled(self.node['id'],False)
        with self.assertRaises(AgentError):self.agent.sync_once()
        self.assertIn('expires=1\n',self.agent.config.read_text())
    def test_missing_ledger_and_duplicate_identity_fail_closed(self):
        with self.assertRaises(AgentError):self.new_agent()
        self.agent.close();self.agent.ledger.unlink()
        with self.assertRaises(AgentError):self.new_agent()
    def test_deleted_accounts_do_not_permanently_fill_report_limit(self):
        self.agent.sync_once();self.status()
        self.assertTrue(self.agent.state['known'])
        self.assertEqual(self.api.request('DELETE','/api/users/player')[0],200)
        self.agent.sync_once();self.assertEqual(self.agent.state['known'],{})
        self.assertEqual(self.agent.stats()['accounts'],[])
    def test_expired_cached_response_is_not_acknowledged(self):
        def lost(doc):raise OSError('lost')
        self.agent.apply=lost
        with self.assertRaises(OSError):self.agent.sync_once()
        self.agent.close();self.now+=8;self.agent=self.new_agent()
        self.assertFalse(self.agent.sync_once());self.assertEqual(self.agent.state['applied'],0)
        self.assertTrue(self.agent.sync_once());self.assertFalse(self.controller.nodes()[0]['online'])
        self.status();self.agent.sync_once();self.assertTrue(self.controller.nodes()[0]['online'])

if __name__=='__main__':unittest.main(verbosity=2)
