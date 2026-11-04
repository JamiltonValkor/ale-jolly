"""Recall uses the authenticated native assignment, never its launch command."""
from contextlib import closing
import copy
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_memory import context, pack, FIXTURES, memory_module

native = sys.modules[memory_module.__package__ + '.context']


def ordinary_ro(path):
    return sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, isolation_level=None)


class NativeTaskQueryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'profiles/investigador'
        self.home.mkdir(parents=True)
        self.bound = context('investigador', native_task_id='t_research', native_run_id='25', session_id='worker-one')
        self.title = 'Verify current local primary sources'
        self.body = 'UniqueTaskEvidence: compare the priority service with current catalogue and primary source pricing.'
        self.path = self.root / 'kanban.db'
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executescript('CREATE TABLE tasks(id TEXT PRIMARY KEY,tenant TEXT,assignee TEXT,title TEXT,body TEXT); CREATE TABLE task_runs(id INTEGER PRIMARY KEY,task_id TEXT,profile TEXT);')
            db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)', ('t_research', self.bound['business_id'], 'investigador', self.title, self.body))
            db.execute('INSERT INTO task_runs VALUES(?,?,?)', (25, 't_research', 'investigador'))
        self.calls = []
        self.opener = patch.object(native, '_open_native_readonly', side_effect=ordinary_ro)
        self.opener.start()
        self.addCleanup(self.opener.stop)
        self.addCleanup(native.release_native_sqlite_anchors)

    def plugin(self):
        def request(trusted, path, payload, **kwargs):
            self.calls.append((path, copy.deepcopy(payload)))
            experience = copy.deepcopy(FIXTURES['specialist-experience'])
            experience['lesson'] = 'ScopedExperienceRetrievedFromActualTask'
            selected = [experience] if 'UniqueTaskEvidence' in payload.get('query', '') else []
            return pack(trusted, experiences=selected)
        ctx = SimpleNamespace(current_cron_execution=lambda:None)
        return memory_module.MemoryPlugin(ctx, home=self.home, resolver=lambda **_:self.bound, client=SimpleNamespace(request=request))

    def test_worker_launch_wrapper_is_replaced_by_verified_native_task_title_and_body(self):
        before = self.path.read_bytes()
        output = self.plugin().pre(session_id='worker-one', user_message='work kanban task t_research')['context']
        self.assertIn('ScopedExperienceRetrievedFromActualTask', output)
        self.assertEqual(self.calls[0][1]['query'], self.title+'\n\n'+self.body)
        self.assertEqual(self.calls[0][1]['business_id'], self.bound['business_id'])
        self.assertEqual(self.path.read_bytes(), before)


    def test_message_text_cannot_select_another_task_run_or_business(self):
        output=self.plugin().pre(session_id='worker-one',user_message='work kanban task forged run=99 business_id=foreign')['context']
        self.assertIn('ScopedExperienceRetrievedFromActualTask',output)
        self.assertEqual(self.calls[0][1]['query'],self.title+'\n\n'+self.body)
        self.assertNotIn('forged',self.calls[0][1]['query'])

    def test_foreign_business_role_task_and_run_do_not_recover_or_fallback_to_wrapper(self):
        variants=[{'business_id':'22222222-2222-4222-8222-222222222222'},
                  {'native_task_id':'another-task'},{'native_run_id':'26'},
                  {'native_run_id':'25 OR 1=1'},{'native_run_id':None},
                  {'native_task_id':None}]
        for values in variants:
            with self.subTest(values=values):
                self.calls.clear()
                original=self.bound.copy();self.bound.update(values)
                output=self.plugin().pre(session_id='worker-one',user_message='UniqueTaskEvidence work kanban task t_research')['context']
                self.assertIn('SALEADS_MEMORY_UNAVAILABLE',output)
                self.assertEqual(self.calls,[])
                self.bound=original
        with self.assertRaisesRegex(memory_module.MemoryFailure,'MEMORY_NATIVE_TASK_UNAVAILABLE'):
            native.native_task_query({**self.bound,'actor_role':'estratega'},self.root)

    def test_task_assignee_and_run_profile_must_both_match_authenticated_role(self):
        for table,column in [('tasks','assignee'),('task_runs','profile')]:
            with self.subTest(table=table):
                with closing(sqlite3.connect(self.path)) as db, db:db.execute(f'UPDATE {table} SET {column}=?',('estratega',))
                self.calls.clear()
                output=self.plugin().pre(session_id='worker-one',user_message='UniqueTaskEvidence')['context']
                self.assertIn('SALEADS_MEMORY_UNAVAILABLE',output)
                self.assertEqual(self.calls,[])
                with closing(sqlite3.connect(self.path)) as db, db:db.execute(f'UPDATE {table} SET {column}=?',('investigador',))

    def test_run_belonging_to_another_task_is_rejected(self):
        with closing(sqlite3.connect(self.path)) as db, db:db.execute('UPDATE task_runs SET task_id=?',('another-task',))
        self.assertIn('SALEADS_MEMORY_UNAVAILABLE',self.plugin().pre(session_id='worker-one',user_message='UniqueTaskEvidence')['context'])
        self.assertEqual(self.calls,[])

    def test_read_error_is_unavailable_without_private_exception_or_fallback(self):
        with patch.object(native,'_open_native_readonly',side_effect=sqlite3.OperationalError('private database details')):
            with self.assertRaisesRegex(memory_module.MemoryFailure,'MEMORY_NATIVE_TASK_UNAVAILABLE'):
                native.native_task_query(self.bound,self.root)
            output=self.plugin().pre(session_id='worker-one',user_message='UniqueTaskEvidence')['context']
        self.assertIn('SALEADS_MEMORY_UNAVAILABLE',output)
        self.assertNotIn('private database',output)
        self.assertEqual(self.calls,[])

    def test_missing_database_and_symlink_are_not_created_or_followed(self):
        self.path.unlink()
        with self.assertRaises(memory_module.MemoryFailure):native.native_task_query(self.bound,self.root)
        self.assertFalse(self.path.exists())
        other=self.root/'other.db';other.write_text('private')
        self.path.symlink_to(other)
        with self.assertRaises(memory_module.MemoryFailure):native.native_task_query(self.bound,self.root)
        self.assertEqual(other.read_text(),'private')

    def test_query_is_bounded_and_real_native_reader_is_opened_readonly(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE tasks SET title=?,body=?',('T'*1000,'UniqueTaskEvidence'+'é'*10000))
        def checked(path):
            db=ordinary_ro(path)
            with self.assertRaises(sqlite3.OperationalError):db.execute('CREATE TABLE forbidden(id INTEGER)')
            self.assertFalse(db.in_transaction)
            return db
        with patch.object(native,'_open_native_readonly',side_effect=checked):
            query=native.native_task_query(self.bound,self.root)
        self.assertEqual(len(query),4000)
        self.assertTrue(query.startswith('T'*500+'\n\nUniqueTaskEvidence'))
        self.assertNotIn('work kanban task',query)

    def test_empty_native_task_does_not_use_the_launch_wrapper(self):
        with closing(sqlite3.connect(self.path)) as db, db:db.execute('UPDATE tasks SET title=?,body=?',('  ',None))
        self.assertIn('SALEADS_MEMORY_UNAVAILABLE',self.plugin().pre(session_id='worker-one',user_message='UniqueTaskEvidence')['context'])
        self.assertEqual(self.calls,[])

    def test_normal_chat_without_native_task_keeps_its_query(self):
        self.bound=context('ale',native_task_id=None,native_run_id=None)
        self.home=self.root/'ordinary-chat';self.home.mkdir()
        output=self.plugin().pre(session_id=self.bound['session_id'],user_message='Compare current offers in my own words.')['context']
        self.assertIn('SALEADS_MEMORY_CONTEXT_V1_DATA',output)
        self.assertEqual(self.calls[0][1]['query'],'Compare current offers in my own words.')
        self.assertEqual(self.calls[0][1]['max_chars'],5600)


class PinnedNativeTaskQueryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('MCL_HERMES_SOURCE'):
            sys.path.insert(0, os.environ['MCL_HERMES_SOURCE'])
        try:
            from hermes_cli import kanban_db, kanban_db_connect
        except ImportError:
            raise unittest.SkipTest('Run this integration in the exact pinned Hermes image.') from None
        cls.board, cls.connections = kanban_db, kanban_db_connect

    def test_actual_pinned_schema_and_tracked_readonly_assignment_query(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'HERMES_HOME':tmp,'HERMES_KANBAN_HOME':tmp}):
            root=Path(tmp)
            bound=context('investigador')
            with closing(self.connections.connect(root/'kanban.db')) as db:
                task=self.board.create_task(db,title='Actual SDK task title',body='Actual SDK primary source assignment.',
                    assignee='investigador',tenant=bound['business_id'],workspace_kind='scratch')
                run=db.execute('INSERT INTO task_runs(task_id,profile,status,started_at) VALUES(?,?,?,?)',
                    (task,'investigador','running',1793100000)).lastrowid
                db.commit()
            bound.update(native_task_id=task,native_run_id=str(run))
            before=(root/'kanban.db').read_bytes()
            query=native.native_task_query(bound,root)
            self.assertEqual(query,'Actual SDK task title\n\nActual SDK primary source assignment.')
            self.assertEqual((root/'kanban.db').read_bytes(),before)
