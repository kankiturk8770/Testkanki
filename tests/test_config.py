from pathlib import Path
import subprocess, tempfile, unittest
ROOT=Path(__file__).resolve().parents[1]
BASE='tun kanki0\naddress 10.66.0.1/16\nmtu 1280\nport udp 4000\n'
KEY='a'*64
class ConfigTests(unittest.TestCase):
    def check_config(self,text):
        with tempfile.NamedTemporaryFile(mode='w',suffix='.conf') as f:
            f.write(text);f.flush();return subprocess.run([str(ROOT/'server/kanki-vpnd'),'--config',f.name,'--check-config'],capture_output=True).returncode
    def test_valid(self):self.assertEqual(self.check_config(BASE+f'user a {KEY} 10.66.0.2 - group=a quota=1024 expires=1900000000\n'),0)
    def test_bad_key(self):self.assertNotEqual(self.check_config(BASE+f'user a {"ag"*32} 10.66.0.2\n'),0)
    def test_duplicate_ip(self):self.assertNotEqual(self.check_config(BASE+f'user a {KEY} 10.66.0.2\nuser b {"b"*64} 10.66.0.2\n'),0)
    def test_duplicate_key(self):self.assertNotEqual(self.check_config(BASE+f'user a {KEY} 10.66.0.2\nuser b {KEY} 10.66.0.3\n'),0)
    def test_invalid_network(self):
        for ip in ['10.66.0.0','10.66.0.1','10.66.255.255','10.67.0.2']:
            self.assertNotEqual(self.check_config(BASE+f'user a {KEY} {ip}\n'),0)
    def test_invalid_interface(self):self.assertNotEqual(self.check_config(BASE.replace('tun kanki0','tun bad;touch_bad')),0)
if __name__=='__main__':unittest.main(verbosity=2)
