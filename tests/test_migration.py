import os,sys,unittest
from pathlib import Path
import test_admin as fixtures
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'agent'))
from migrate_local import migrate
from kanki_agent import AgentError

class MigrationTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop('KANKI_CLUSTER',None);fixtures.AdminIntegration.setUpClass();self.api=fixtures.AdminIntegration('test_01_auth_and_public_shell');self.root=self.api.root
        self.assertEqual(self.api.create('previous',quota_bytes=1000)[0],201)
    def tearDown(self):fixtures.AdminIntegration.tearDownClass()
    def test_usage_import_backup_and_fencing(self):
        from kanki_cluster import ClusterError
        with self.assertRaises(ClusterError):self.api.app.cluster_controller.require_ready()
        status=self.root/'final';status.write_text('KANKI_STATUS_V1 1 999999 local\naccount previous 125 75 1000\n')
        backup=migrate(self.root/'db.sqlite3',status,self.root/'kanki.conf')
        self.assertTrue(Path(backup).exists());self.assertIn('expires=1', (self.root/'kanki.conf').read_text())
        self.api.app.cluster_controller.require_ready()
        user=self.api.app.users()[0];usage=self.api.app.cluster_controller.account_usage(user['id']);self.assertEqual(usage['charged'],200)
        with self.assertRaises(ClusterError):migrate(self.root/'db.sqlite3',status,self.root/'kanki.conf')
    @unittest.skipUnless(os.geteuid()==0,'ownership check needs root, like the real migration')
    def test_root_migration_keeps_panel_ownership(self):
        status=self.root/'final';status.write_text('KANKI_STATUS_V1 1 999999 local\naccount previous 1 2 1000\n')
        for f in ('db.sqlite3','kanki.conf'):os.chown(self.root/f,4242,4242)
        migrate(self.root/'db.sqlite3',status,self.root/'kanki.conf')
        for f in ('db.sqlite3','kanki.conf'):
            st=os.stat(self.root/f);self.assertEqual((st.st_uid,st.st_gid),(4242,4242),f)
    def test_missing_final_usage_refuses_to_reset_counters(self):
        from kanki_cluster import ClusterError
        status=self.root/'final';status.write_text('KANKI_STATUS_V1 1 999999 local\n')
        before=(self.root/'kanki.conf').read_text()
        with self.assertRaises(ClusterError):migrate(self.root/'db.sqlite3',status,self.root/'kanki.conf')
        self.assertEqual(before,(self.root/'kanki.conf').read_text())
if __name__=='__main__':unittest.main(verbosity=2)
