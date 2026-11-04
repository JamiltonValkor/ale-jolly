import base64
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import unittest
SCRIPT=Path(__file__).parents[1]/'startup-script.sh'
FILES=['plugins/saleads-meta-search/plugin.yaml','plugins/saleads-meta-search/__init__.py','plugins/saleads-meta-search/search.py','runtime/first-loop-exporter.py']
def archive(names):
 stream=io.BytesIO()
 with tarfile.open(fileobj=stream,mode='w:gz') as t:
  for n in names:
   b=b'fixed test content';v=tarfile.TarInfo(n);v.size=len(b);t.addfile(v,io.BytesIO(b))
 return base64.b64encode(stream.getvalue())
def helper(mode,data,action=None):
 return subprocess.run(['bash','-c','source "$1"; run_helper "$2" "$3"','test',str(SCRIPT),mode,action or 'enable'],input=data,capture_output=True,env={**os.environ,'HERMES_PY_CMD':sys.executable},timeout=10)
class ExtensionTests(unittest.TestCase):
 def test_closed_archive(self):
  r=helper('extensions',archive(FILES));self.assertEqual(r.returncode,0,r.stderr)
  with tarfile.open(fileobj=io.BytesIO(r.stdout)) as t:self.assertEqual(sorted(t.getnames()),sorted(FILES))
 def test_extra_and_traversal_refused(self):
  for n in ['runtime/other.py','../escape.py','/tmp/absolute.py']:
   with self.subTest(n=n):self.assertNotEqual(helper('extensions',archive(FILES+[n])).returncode,0)
 def test_enabling_preserves_user_plugins_and_settings(self):
  cfg={'plugins':{'enabled':['custom-user-plugin'],'other':True},'model':{'default':'test-model'}}
  r=helper('plugins-enable',json.dumps(cfg).encode());self.assertEqual(r.returncode,0,r.stderr);v=json.loads(r.stdout);self.assertEqual(v['plugins']['enabled'],['custom-user-plugin','saleads-meta-search']);self.assertEqual(v['model'],cfg['model']);self.assertTrue(v['plugins']['other'])
 def test_disable_only_managed_plugin_preserves_others(self):
  cfg={'plugins':{'enabled':['custom-user-plugin','saleads-meta-search'],'other':True}}
  r=helper('plugins-enable',json.dumps(cfg).encode(),'disable');self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(json.loads(r.stdout)['plugins']['enabled'],['custom-user-plugin'])
 def test_profile_merge_preserves_personal_plugins(self):
  stream=io.BytesIO()
  with tarfile.open(fileobj=stream,mode='w') as t:
   for n,data in [('meta',{'model':{'default':'test'}}),('layer',{'toolsets':{'cli':['skills']}}),('current',{'plugins':{'enabled':['custom-user-plugin'],'custom_setting':True}})]:
    raw=json.dumps(data).encode();v=tarfile.TarInfo(n);v.size=len(raw);t.addfile(v,io.BytesIO(raw))
  r=helper('profile-config',stream.getvalue());self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(json.loads(r.stdout)['plugins']['enabled'],['custom-user-plugin'])
if __name__=='__main__':unittest.main()
