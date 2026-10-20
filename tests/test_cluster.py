"""Cluster regression specification; run against actual controller HTTP API."""
import hashlib,hmac,json,os,time,unittest
import test_admin as fixtures

class ClusterTests(unittest.TestCase):
    def setUp(self):
        os.environ['KANKI_CLUSTER']='1'
        fixtures.AdminIntegration.setUpClass();self.api=fixtures.AdminIntegration('test_01_auth_and_public_shell')
        self.controller=self.api.app.cluster_controller;self.now=2000000000
        self.controller.clock=lambda:self.now;self.controller.chunk=400;self.controller.lease_seconds=5
        self.instance='a'*32
    def tearDown(self):
        fixtures.AdminIntegration.tearDownClass();os.environ.pop('KANKI_CLUSTER',None)
    def node(self,name):
        status,n=self.api.request('POST','/api/nodes',{'name':name,'host':name+'.test','port':4000})
        self.assertEqual(status,201,n);return n
    def user(self,name='gamer',quota=1000,connections=2):
        self.assertEqual(self.api.create(name,connections=connections,quota_bytes=quota)[0],201)
        return next(x for x in self.api.request('GET','/api/users')[1] if x['name']==name)
    def sync(self,n,seq=1,accounts=None,ack=None,instance=None,updated=None):
        body={'instance':instance or self.instance,'seq':seq,'ack':seq-1 if ack is None else ack,
            'stats':{'ready':True,'updated':self.now if updated is None else updated,'accounts':accounts or [],'sessions':[]},'error':None}
        result=self.controller.sync(n['token'],body)
        doc={k:v for k,v in result.items() if k!='signature'}
        signature=hmac.new(n['token'].encode(),json.dumps(doc,sort_keys=True,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
        self.assertEqual(result['signature'],signature);return result
    def assign(self,u,node,slot):
        dev=next(d for d in u['devices'] if d['slot']==slot)
        code,data=self.api.request('POST',f"/api/devices/{dev['id']}/move",{'node_id':node['id']});self.assertEqual(code,200,data)
        return dev
    def test_node_clock_offset_within_agent_tolerance_stays_online(self):
        for offset,online in ((2,True),(-9,True),(10,True),(40,False),(-40,False)):
            n=self.node('skew'+str(offset).replace('-','m'))
            self.sync(n,1);self.sync(n,2,updated=self.now+offset)
            state=next(x for x in self.controller.nodes() if x['id']==n['id'])
            self.assertEqual(state['online'],online,offset)
    def test_escrow_across_nodes_idempotence_and_caps(self):
        a,b=self.node('alpha'),self.node('beta');u=self.user();self.assign(u,a,1);self.assign(u,b,2)
        ra,rb=self.sync(a),self.sync(b)
        self.assertEqual(ra['users'][0]['quota'],400);self.assertEqual(rb['users'][0]['quota'],400)
        self.assertEqual(self.sync(a),ra)
        aid=ra['users'][0]['group'];stats=[{'id':aid,'charged':400,'rx':200,'tx':100}]
        r=self.sync(a,2,stats);self.assertEqual(r['users'][0]['quota'],600)
        stats[0]['charged']=600;r=self.sync(a,3,stats);self.assertEqual(r['users'][0]['quota'],600)
        stats[0]['charged']=400;r=self.sync(b,2,stats);self.assertEqual(r['users'][0]['quota'],400)
        account=self.controller.account_usage(u['id']);self.assertEqual(account['allocated'],1000);self.assertEqual(account['charged'],1000)
    def test_small_quota_idle_first_node_cannot_reserve_second_nodes_share(self):
        self.controller.chunk=1048576
        a,b=self.node('alpha'),self.node('beta');u=self.user(quota=8192)
        self.assign(u,a,1);self.assign(u,b,2)
        self.assertEqual(self.sync(a)['users'][0]['quota'],4096)
        self.assertEqual(self.sync(a,2)['users'][0]['quota'],4096)
        self.assertEqual(self.sync(b)['users'][0]['quota'],4096)
    def test_device_move_has_nonoverlapping_lease(self):
        a,b=self.node('alpha'),self.node('beta');u=self.user(connections=1);d=self.assign(u,a,1)
        r=self.sync(a);self.sync(a,2);self.assign(u,b,1)
        self.assertFalse(self.sync(b)['users']);self.assertFalse(self.sync(a,3)['users'])
        self.now+=18;r=self.sync(b,2);self.assertEqual(len(r['users']),1)
        self.assertEqual(r['users'][0]['ip'],d['ip']);self.assertLessEqual(r['users'][0]['expires'],self.now+5)
    def test_instance_loss_replay_and_forged_report_rejected(self):
        from kanki_cluster import ClusterError
        a=self.node('alpha');u=self.user(connections=1);self.assign(u,a,1);r=self.sync(a)
        with self.assertRaises(ClusterError):self.sync(a,2,instance='b'*32)
        with self.assertRaises(ClusterError):self.sync(a,1,accounts=[{'id':'foreign','charged':1,'rx':0,'tx':0}])
        with self.assertRaises(ClusterError):self.sync(a,2,accounts=[{'id':'foreign','charged':1,'rx':0,'tx':0}])
        aid=r['users'][0]['group'];self.sync(a,2,[{'id':aid,'charged':100,'rx':1,'tx':1}])
        with self.assertRaises(ClusterError):self.sync(a,3,[{'id':aid,'charged':99,'rx':1,'tx':1}])
    def test_agent_auth_scope_node_revocation_and_no_secrets_in_listing(self):
        from kanki_cluster import ClusterError
        n=self.node('alpha');self.sync(n)
        listing=self.api.request('GET','/api/nodes')[1];self.assertNotIn('token',listing[0]);self.assertNotIn('token_hash',listing[0])
        with self.assertRaises(ClusterError):self.controller.sync('bad',{})
        self.assertEqual(self.api.request('PATCH','/api/nodes/'+n['id'],{'enabled':False})[0],200)
        with self.assertRaises(ClusterError):self.sync(n,2)
    def test_subscriptions_require_ack_and_do_not_offer_unassigned_servers(self):
        n=self.node('alpha');u=self.user(connections=1);self.assign(u,n,1)
        path='/'+u['subscription'].split('/',3)[3]
        self.assertEqual(self.api.request('GET',path,auth=False)[0],503)
        self.sync(n);self.assertEqual(self.api.request('GET',path,auth=False)[0],503)
        self.sync(n,2);code,sub=self.api.request('GET',path,auth=False)
        self.assertEqual(code,200);self.assertEqual(len(sub['profiles']),1);self.assertEqual(sub['profiles'][0]['server'],'alpha.test')
        self.now+=6;self.assertEqual(self.api.request('GET',path,auth=False)[0],503)
    def test_rotation_requires_fresh_configuration_ack(self):
        n=self.node('alpha');u=self.user(connections=1);self.assign(u,n,1)
        self.sync(n);self.sync(n,2)
        self.assertEqual(self.api.request('POST','/api/users/gamer/rotate',{})[0],201)
        current=self.api.request('GET','/api/users')[1][0];path='/'+current['subscription'].split('/',3)[3]
        self.assertEqual(self.api.request('GET',path,auth=False)[0],503)
        self.sync(n,3);self.assertEqual(self.api.request('GET',path,auth=False)[0],503)
        self.sync(n,4);self.assertEqual(self.api.request('GET',path,auth=False)[0],200)
    def test_quota_cannot_shrink_below_outstanding_grants(self):
        n=self.node('alpha');u=self.user(connections=1);self.assign(u,n,1);self.sync(n)
        code,_=self.api.request('PATCH','/api/users/gamer',{'quota_bytes':100});self.assertEqual(code,400)
        self.assertEqual(self.api.request('PATCH','/api/users/gamer',{'enabled':False})[0],200)
        r=self.sync(n,2);self.assertEqual(r['users'][0]['expires'],1)

if __name__=='__main__':unittest.main(verbosity=2)
