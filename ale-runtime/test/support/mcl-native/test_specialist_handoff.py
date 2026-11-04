"""Pinned native Kanban SQLite proof for automatic handoff enrichment.

No model, dispatcher or live Brain. Only the transport sink is synthetic; the
database schema/task is created by the unmodified official Hermes SDK.
"""
from contextlib import closing
import copy
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[3] / 'vm/extensions/saleads-memory'
sys.path.insert(0, str(PACKAGE))
from test_memory import context, memory_module

capture = sys.modules[memory_module.__package__ + '.specialist_capture']


class PinnedNativeHandoffTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = os.environ.get('MCL_HERMES_SOURCE')
        if source:
            sys.path.insert(0, source)
        try:
            from hermes_cli import kanban_db, kanban_db_connect
        except ImportError:
            raise unittest.SkipTest('Run this integration gate in the exact pinned Hermes image.') from None
        cls.native = kanban_db
        cls.connection = kanban_db_connect

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='native-handoff-fixture-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / 'profiles/investigador'
        self.home.mkdir(parents=True)
        env = patch.dict(os.environ, {'HERMES_HOME': str(self.root), 'HERMES_KANBAN_HOME': str(self.root)})
        env.start()
        self.addCleanup(env.stop)
        self.database = self.root / 'kanban.db'
        self.worker_session = 'synthetic-native-worker-session'
        with closing(self.connection.connect(self.database)) as db:
            self.task = self.native.create_task(db, title='Synthetic source research', assignee='investigador',
                tenant=context()['business_id'], workspace_kind='scratch')
            self.assertNotIn('metadata', {r['name'] for r in db.execute('PRAGMA table_info(tasks)')})
            cursor = db.execute('INSERT INTO task_runs(task_id,profile,status,outcome,started_at,ended_at,metadata,summary) '
                'VALUES(?,?,?,?,?,?,?,?)', (self.task, 'investigador', 'done', 'completed', 1793100000, 1793100100,
                    json.dumps({'worker_session_id': self.worker_session}), 'Short native completion stub.'))
            self.run = cursor.lastrowid
            db.execute('UPDATE tasks SET status=?,current_run_id=? WHERE id=?', ('done', self.run, self.task))
            db.commit()
        self.context = context('investigador', native_task_id=self.task, native_run_id=str(self.run), session_id=self.worker_session)
        self.events = {}
        self.calls = []
        def request(bound, route, event, **_kwargs):
            self.assertEqual(route, '/continuous/sources')
            self.calls.append(copy.deepcopy(event))
            previous = self.events.setdefault(event['event_id'], copy.deepcopy(event))
            self.assertEqual(previous['content_sha256'], event['content_sha256'])
            return {'accepted': True, 'event_id': event['event_id']}
        self.recorder = capture.SpecialistRecorder(self.home, root=self.root,
            client=types.SimpleNamespace(request=request), trigger=types.SimpleNamespace(request=lambda *_: None))

    def update_metadata(self, values):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE task_runs SET metadata=? WHERE id=?',
                       (json.dumps({'worker_session_id': self.worker_session, **values}), self.run))

    def test_real_native_schema_registered_stub_enriches_one_episode_then_replays_without_churn(self):
        self.assertTrue(self.recorder.stage(self.context, self.worker_session, 'Short final response.'))
        self.assertEqual(self.recorder.reconcile(dispatch=False), 1)
        original = copy.deepcopy(next(iter(self.events.values())))
        self.update_metadata({'business_id': self.context['business_id'], 'native_task_id': self.task, 'native_run_id': self.run,
            'method': 'Compare original local sources with dated evidence.',
            'observed_errors_corrections': 'A reference storefront used foreign pricing; verify the local region.',
            'practical_lesson': 'Verify source region before comparing prices.',
            'queries_performed': ['synthetic local market sources'], 'missing_coverage': ['Current local availability'],
            'worker_prompt': 'PRIVATE_PROMPT_NOT_MATERIAL', 'api_key': 'LLM_synthetic_private_key_value'})
        before = self.database.read_bytes()
        self.assertEqual(self.recorder.reconcile(dispatch=False), 1)
        self.assertEqual(self.database.read_bytes(), before)
        self.assertEqual(self.events[original['event_id']], original)
        handoffs = [v for v in self.events.values() if v['source_version'].startswith('handoff-')]
        self.assertEqual(len(handoffs), 1)
        self.assertEqual(handoffs[0]['source_id'], original['source_id'])
        self.assertIn('observed_errors_corrections', handoffs[0]['content'])
        self.assertIn('practical_lesson', handoffs[0]['content'])
        self.assertNotIn('PRIVATE_PROMPT', handoffs[0]['content'])
        self.assertNotIn('LLM_synthetic', handoffs[0]['content'])
        calls = len(self.calls)
        self.assertEqual(self.recorder.reconcile(dispatch=False), 0)
        self.assertEqual(len(self.calls), calls)

    def test_full_native_schema_rejects_a_foreign_run_tenant_or_missing_session_proof(self):
        self.update_metadata({'method': 'A generated method.', 'practical_lesson': 'A generated practical lesson.'})
        for variant in (dict(self.context, native_run_id=str(self.run + 1)),
                        dict(self.context, business_id='22222222-2222-4222-8222-222222222222'),
                        dict(self.context, session_id='foreign-session')):
            self.recorder.stage(variant, variant['session_id'], 'Generated output without matching native proof.')
        self.assertEqual(self.recorder.reconcile(dispatch=False), 0)
        self.assertEqual(self.calls, [])
        self.update_metadata({'worker_session_id': '', 'method': 'No verified session.'})
        self.recorder.stage(self.context, self.worker_session, 'Still unproven.')
        self.assertEqual(self.recorder.reconcile(dispatch=False), 0)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
