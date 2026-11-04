import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
SPEC = importlib.util.spec_from_file_location('exporter', Path(__file__).parents[1] / 'extensions' / 'first-loop-exporter.py')
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)
W='11111111-1111-4111-8111-111111111111'
B='22222222-2222-4222-8222-222222222222'
class ExporterTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.db=sqlite3.connect(self.root/'kanban.db')
  self.db.executescript('CREATE TABLE tasks(id TEXT,title TEXT,body TEXT,assignee TEXT,status TEXT,project_id TEXT,tenant TEXT,result TEXT);CREATE TABLE task_runs(id INTEGER PRIMARY KEY,task_id TEXT,profile TEXT,status TEXT,ended_at INTEGER,started_at INTEGER,outcome TEXT,summary TEXT,metadata TEXT);CREATE TABLE task_links(parent_id TEXT,child_id TEXT);')
 def tearDown(self):self.db.close();self.tmp.cleanup()
 def task(self,runs=True):
  marker='SALEADS_FIRST_LOOP_TASK_V1 '+json.dumps({'work_id':W,'business_id':B,'stage':'research','revision':1,'response_locale':'en'})
  self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)',('t1','Research',marker,'investigador','done',W,B,'A supported proposal with https://example.org/source'))
  if runs:self.db.execute('INSERT INTO task_runs VALUES(?,?,?,?,?,?,?,?,?)',(1,'t1','investigador','done',1793059200,1793055600,'completed',None,None))
  self.db.commit()
 def test_native_run_and_artifact_proof_without_sql_writes(self):
  self.task();x=exporter.export(self.root);self.assertEqual(x['works'][0]['tasks'][0]['execution_verified'],True);self.assertEqual(len(x['works'][0]['artifacts']),1);self.assertEqual(self.db.execute('SELECT count(*) FROM tasks').fetchone()[0],1)
 def test_real_native_completion_uses_run_summary_metadata_and_string_rowid(self):
  self.task();self.db.execute('UPDATE tasks SET result=NULL')
  self.db.execute('UPDATE task_runs SET summary=?,metadata=? WHERE id=1',('Grounded proposal',json.dumps({'findings':['A supported hypothesis'],'citations':[{'url':'https://example.org/native','title':'Evidence'}],'environment':{'MODEL_API_KEY':'must-not-export'},'workspace_path':'/opt/data/private'})))
  self.db.commit();work=exporter.export(self.root)['works'][0]
  self.assertEqual(work['tasks'][0]['run_refs'],['1']);self.assertTrue(work['tasks'][0]['execution_verified'])
  self.assertEqual(len(work['artifacts']),1);body=work['artifacts'][0]['content'];self.assertIn('Grounded proposal',body);self.assertIn('A supported hypothesis',body);self.assertNotIn('must-not-export',body);self.assertNotIn('/opt/data/private',body)
  self.assertEqual(work['artifacts'][0]['sources'][0]['url'],'https://example.org/native')
 def test_failed_run_summary_is_not_a_completed_deliverable(self):
  self.task();self.db.execute('UPDATE tasks SET result=NULL');self.db.execute("UPDATE task_runs SET status='failed',outcome='failed',summary='Not a deliverable'");self.db.commit()
  work=exporter.export(self.root)['works'][0];self.assertFalse(work['tasks'][0]['execution_verified']);self.assertEqual(work['artifacts'],[])
 def test_no_run_does_not_verify_completion(self):
  self.task(False);self.assertFalse(exporter.export(self.root)['works'][0]['tasks'][0]['execution_verified'])
 def test_traversal_and_symlink_are_rejected(self):
  safe=self.root/'safe';safe.mkdir();secret=self.root/'secret.txt';secret.write_text('do not export');(safe/'link.txt').symlink_to(secret)
  self.assertFalse(exporter.regular(safe/'../secret.txt',safe));self.assertFalse(exporter.regular(safe/'link.txt',safe))
 def test_missing_schema_fails_instead_of_exporting_empty(self):
  self.db.execute('DROP TABLE task_runs');self.db.commit()
  with self.assertRaises(ValueError):exporter.export(self.root)
 def researcher(self,session='worker-session-1'):
  self.task();self.db.execute('UPDATE tasks SET result=NULL');self.db.execute('UPDATE task_runs SET summary=?,metadata=? WHERE id=1',('Actual completed native research without inline links',json.dumps({'worker_session_id':session,'findings':['Preserve the real native summary']})));self.db.commit()
 def receipt(self,number=1,**changes):
  directory=self.root/'profiles'/'investigador'/'plugin-data'/'saleads-meta-search'/'receipts';directory.mkdir(parents=True,exist_ok=True)
  value={'status':'completed','model':'muse-spark-1.3-contributor','response_id':f'resp-{number}','search_calls':2,'citations':[{'url':f'https://example.org/research/{number}','title':'Actual hosted-search source'}],'observed_at':'2026-10-27T10:00:00+00:00','usage':{},'query_sha256':'0'*64,'session_id':'worker-session-1'}
  value.update(changes);path=directory/(f'{number:064x}'+'.json');path.write_text(json.dumps(value));return path
 def test_verified_research_joins_exact_worker_session_and_hermes_task_alias(self):
  self.researcher();self.receipt();self.receipt(2,session_id=None,task_id='worker-session-1')
  work=exporter.export(self.root)['works'][0];artifact=work['artifacts'][0]
  self.assertTrue(work['tasks'][0]['execution_verified']);self.assertIn('Actual completed native research',artifact['content']);self.assertIn('Preserve the real native summary',artifact['content'])
  self.assertEqual({s['url'] for s in artifact['sources']},{'https://example.org/research/1','https://example.org/research/2'})
  self.assertNotIn('worker-session-1',artifact['content']);self.assertNotIn('worker_session_id',artifact['content']);self.assertNotIn('resp-1',artifact['content'])
  self.assertEqual(self.db.execute('SELECT count(*) FROM task_runs').fetchone()[0],1)
 def test_exact_native_task_binding_without_session_is_accepted(self):
  self.researcher();self.receipt(session_id=None,task_id='t1')
  self.assertEqual(len(exporter.export(self.root)['works'][0]['artifacts'][0]['sources']),1)
 def test_unbound_contradictory_failed_and_wrong_model_receipts_cannot_supply_sources(self):
  self.researcher()
  values=[{'session_id':'another-worker'},{'session_id':'another-worker','task_id':'t1'},{'session_id':None,'task_id':'other-task'},{'session_id':None,'task_id':None},{'status':'failed'},{'model':'another-model'},{'search_calls':0},{'search_calls':True}]
  for number,changes in enumerate(values,1):self.receipt(number,**changes)
  artifact=exporter.export(self.root)['works'][0]['artifacts'][0];self.assertEqual(artifact['sources'],[]);self.assertNotIn('Research sources',artifact['content'])
 def test_only_verified_completed_research_run_can_import_receipts(self):
  self.researcher();self.receipt();self.db.execute("UPDATE task_runs SET status='failed',outcome='failed'");self.db.commit()
  self.assertEqual(exporter.export(self.root)['works'][0]['artifacts'],[])
 def test_receipt_url_validation_and_duplicate_bound_sources(self):
  self.researcher();urls=['https://example.org/public','https://example.org/public','file:///etc/passwd','https://user:password@example.org/private','https://example.org/private?access_token=secret','http://127.0.0.1/private','http://localhost/private','https://example.org/space path','https://example.org/\nunsafe','https://example.org:invalid/port','https://example.org/#access_token=secret']
  self.receipt(citations=[{'url':url,'title':'Source'} for url in urls]);artifact=exporter.export(self.root)['works'][0]['artifacts'][0]
  self.assertEqual([s['url'] for s in artifact['sources']],['https://example.org/public']);self.assertNotIn('access_token',artifact['content']);self.assertNotIn('127.0.0.1',artifact['content'])
 def test_symlink_oversized_and_invalid_receipts_are_ignored(self):
  self.researcher();path=self.receipt();saved=path.read_text();outside=self.root/'outside.json';outside.write_text(saved);path.unlink();path.symlink_to(outside)
  oversized=self.receipt(2);oversized.write_text('x'*(exporter.MAX_TEXT+1));invalid=self.receipt(3);invalid.write_text('{')
  self.assertEqual(exporter.export(self.root)['works'][0]['artifacts'][0]['sources'],[])
 def test_receipt_source_append_preserves_native_content_and_text_bound(self):
  self.researcher();self.receipt(session_id=None,task_id='t1');summary='x'*(exporter.MAX_TEXT-10);self.db.execute('UPDATE task_runs SET summary=?,metadata=NULL',(summary,));self.db.commit()
  artifact=exporter.export(self.root)['works'][0]['artifacts'][0];self.assertEqual(artifact['content'],summary);self.assertLessEqual(artifact['bytes'],exporter.MAX_TEXT)
  self.assertEqual(artifact['sources'][0]['url'],'https://example.org/research/1')
 def test_exact_provider_url_punctuation_is_preserved_in_source_field(self):
  self.researcher();url='https://example.org/research_(topic)?market=local';self.receipt(citations=[{'url':url}])
  artifact=exporter.export(self.root)['works'][0]['artifacts'][0];self.assertEqual([s['url'] for s in artifact['sources']],[url]);self.assertIn('<'+url+'>',artifact['content'])
 def test_receipt_scan_and_source_count_are_bounded(self):
  self.researcher();self.receipt(citations=[{'url':f'https://example.org/{n}'} for n in range(10)])
  with patch.object(exporter,'MAX_RECEIPTS',0):self.assertEqual(exporter.export(self.root)['works'][0]['artifacts'][0]['sources'],[])
  with patch.object(exporter,'MAX_SOURCES',2):self.assertEqual(len(exporter.export(self.root)['works'][0]['artifacts'][0]['sources']),2)
 def test_internal_run_task_and_session_metadata_is_not_a_rendered_artifact(self):
  self.researcher();self.db.execute('UPDATE task_runs SET metadata=?',(json.dumps({'worker_session_id':'private-worker','session_id':'private-session','run_id':'private-run','task_id':'private-card','nested':{'worker_run_id':'private-nested','finding':'Keep supported facts'}}),));self.db.commit()
  content=exporter.export(self.root)['works'][0]['artifacts'][0]['content'];self.assertNotIn('private-',content);self.assertIn('Keep supported facts',content)
if __name__=='__main__':unittest.main()
