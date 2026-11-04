"""Behavioral fixtures for the managed context and native-only projection."""
from __future__ import annotations

import datetime as dt
from contextlib import closing
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest


REPO = Path(__file__).resolve().parents[3]
PACKAGE = REPO / 'vm/extensions/saleads-continuity'


def load(name, path, package=False):
    spec = importlib.util.spec_from_file_location(name, path,
        submodule_search_locations=[str(path.parent)] if package else None)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


entry = load('mcl_plugin_fixture', PACKAGE / '__init__.py', True)
context = sys.modules['mcl_plugin_fixture.context']
notification = sys.modules['mcl_plugin_fixture.notifications']
exporter = load('mcl_exporter_fixture', REPO / 'vm/extensions/continuous-exporter.py')
B1 = '00000000-0000-4000-8000-000000000001'
B2 = '00000000-0000-4000-8000-000000000002'
NOW = dt.datetime(2026, 10, 27, 12, 0, tzinfo=dt.timezone.utc)


def bound(business=B1, session='session-one', locale='en', revision=1):
    return {'schema_version': 'trusted-context/1', 'owner_id': 'synthetic-owner',
        'business_id': business, 'session_id': session, 'actor_role': 'ale',
        'native_task_id': None, 'native_run_id': None, 'response_locale': locale,
        'locale_revision': revision, 'capabilities': [], 'mandate_id': None, 'pending_context': False}


class NativeContinuityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mcl-plugin-test-')
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.root = self.home / 'saleads/continuous'
        self.root.mkdir(parents=True)
        self.values = [bound(), bound(B2, 'session-two', 'fr', 2)]
        self.jobs = [{'job_id': 'job-one', 'business_id': B1, 'session_id': 'session-one',
                      'response_locale': 'en', 'locale_revision': 1}]
        self.registry()

    def registry(self):
        (self.root / 'trusted-contexts.json').write_text(json.dumps({
            'schema_version': 'trusted-context-registry/1', 'owner_id': 'synthetic-owner',
            'contexts': self.values, 'jobs': self.jobs}))

    def test_main_uses_exact_session_and_live_configured_language(self):
        first = context.resolve(session_id='session-one', root=self.root, env={})
        self.assertEqual(first['response_locale'], 'en')
        self.values[0].update(response_locale='pt-BR', locale_revision=3)
        self.registry()
        second = context.resolve(session_id='session-one', root=self.root, env={})
        self.assertEqual(second['response_locale'], 'pt-BR')
        self.assertIn('"response_locale":"pt-BR"', context.pack(second)['context'])
        self.assertIsNone(context.resolve(session_id='unknown-session', root=self.root, env={}))

    def test_no_first_business_fallback_or_conversation_identity(self):
        self.assertIsNone(context.resolve(session_id='business=' + B1, root=self.root, env={}))
        self.assertIsNone(context.resolve(session_id='worker', root=self.root,
            env={'HERMES_TENANT': 'foreign', 'HERMES_KANBAN_TASK': 't_one',
                 'HERMES_KANBAN_RUN_ID': '1', 'HERMES_HOME': '/opt/data/profiles/investigador'}))
        self.values.append(dict(self.values[0]))
        self.registry()
        self.assertIsNone(context.resolve(session_id='session-one', root=self.root, env={}))

    def test_worker_uses_native_tenant_role_and_run(self):
        env = {'HERMES_TENANT': B2, 'HERMES_KANBAN_TASK': 't_one',
               'HERMES_KANBAN_RUN_ID': '42', 'HERMES_HOME': '/opt/data/profiles/investigador'}
        value = context.resolve(session_id='native-worker-session', root=self.root, env=env)
        self.assertEqual((value['business_id'], value['actor_role'], value['response_locale']), (B2, 'investigador', 'fr'))
        self.assertEqual(value['native_run_id'], '42')
        self.assertEqual(value['session_id'], 'native-worker-session')
        env['HERMES_HOME'] = '/opt/data/profiles/unmanaged'
        self.assertIsNone(context.resolve(session_id='worker', root=self.root, env=env))

    def test_generated_roles_bind_each_worker_without_changing_business_or_language(self):
        catalog = json.loads((REPO / 'contracts/continuous-loop/v1/role-catalog.json').read_text())
        self.assertEqual(context.ROLES, frozenset(catalog['actor_roles']))
        self.assertIn('disenador_landings', context.ROLES)
        env = {'HERMES_TENANT': B2, 'HERMES_KANBAN_TASK': 't_landing', 'HERMES_KANBAN_RUN_ID': '7'}
        for role in context.ROLES - {'ale'}:
            with self.subTest(role=role):
                value = context.resolve(session_id='worker-session', root=self.root,
                    env={**env, 'HERMES_HOME': '/opt/data/profiles/' + role})
                self.assertEqual((value['business_id'], value['actor_role'], value['response_locale']), (B2, role, 'fr'))
                self.assertEqual((value['native_task_id'], value['native_run_id']), ('t_landing', '7'))
        designer = {**env, 'HERMES_HOME': '/opt/data/profiles/disenador_landings'}
        for patch in ({'HERMES_TENANT': 'foreign'}, {'HERMES_TENANT': ''}, {'HERMES_KANBAN_RUN_ID': ''}):
            self.assertIsNone(context.resolve(session_id='worker-session', root=self.root, env={**designer, **patch}))

    def test_cron_requires_registered_exact_job_and_locale_version(self):
        identity = SimpleNamespace(job_id='job-one', execution_id='execution-one', profile='default')
        value = context.resolve(session_id='unrelated-cron-session', cron_identity=identity, root=self.root, env={})
        self.assertEqual(value['session_id'], 'session-one')
        identity.job_id = 'unregistered-job'
        self.assertIsNone(context.resolve(session_id='session-one', cron_identity=identity, root=self.root, env={}))
        identity.job_id = 'job-one'
        self.jobs[0]['locale_revision'] = 9
        self.registry()
        self.assertIsNone(context.resolve(session_id='session-one', cron_identity=identity, root=self.root, env={}))

    def test_context_failure_and_oversize_never_spill_or_fallback(self):
        (self.root / 'trusted-contexts.json').write_text('{invalid')
        self.assertIsNone(context.resolve(session_id='session-one', root=self.root, env={}))
        self.assertIn('CONTEXT_UNAVAILABLE', context.pack(None)['context'])
        oversized = dict(self.values[0], capabilities=['x' * 9000])
        packed = context.pack(oversized)['context']
        self.assertLess(len(packed), context.MAX_CONTEXT_CHARS)
        self.assertNotIn('x' * 100, packed)

    def test_only_verified_native_compression_tip_recovers_canonical_business(self):
        relation = lambda canonical, actual: canonical == 'session-two' and actual == 'native-compression-tip'
        value = context.resolve(session_id='native-compression-tip', root=self.root, env={}, lineage_resolver=relation)
        self.assertEqual((value['business_id'], value['response_locale']), (B2, 'fr'))
        self.assertEqual(value['session_id'], 'session-two')
        self.assertIsNone(context.resolve(session_id='arbitrary-child', root=self.root, env={}, lineage_resolver=relation))
        ambiguous = lambda canonical, actual: actual == 'shared-invalid-tip'
        self.assertIsNone(context.resolve(session_id='shared-invalid-tip', root=self.root, env={}, lineage_resolver=ambiguous))

    def capture(self, *, text='A useful synthetic result.', home_state='no_home', execution='execution-one'):
        identity = SimpleNamespace(job_id='job-one', execution_id=execution, profile='default')
        return notification.capture(self.values[0], identity, text, root=self.root,
            home_resolver=lambda _j: {'state': home_state, 'fingerprint': None}, now=NOW)

    def execution(self, *, job='job-one', status='completed', outcome='suppressed', execution='execution-one'):
        (self.home / 'cron').mkdir(exist_ok=True)
        path = self.home / 'cron/executions.db'
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS executions (id TEXT,job_id TEXT,status TEXT,finished_at TEXT,delivery_outcome TEXT)')
            db.execute('INSERT INTO executions VALUES (?,?,?,?,?)', (execution, job, status, NOW.isoformat(), outcome))
        return path

    def test_receipt_is_atomic_first_write_idempotent_and_private(self):
        self.assertTrue(self.capture())
        self.assertFalse(self.capture(text='A different replay cannot replace it.'))
        files = list((self.root / 'receipts').glob('*.json'))
        self.assertEqual(len(files), 1)
        self.assertEqual(json.loads(files[0].read_text())['text'], 'A useful synthetic result.')
        self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)

    def test_silent_control_json_and_secret_shapes_are_not_published(self):
        for text in ('[SILENT]', 'SILENT', '{"task":"t_one"}', 'LLM_' + 'x' * 30,
                     'Bearer ' + 'x' * 30, 'SALEADS_FIRST_LOOP_TASK_V1 internal'):
            self.assertFalse(self.capture(text=text), text)
        self.assertFalse((self.root / 'receipts').exists())

    def test_export_exact_completion_no_home_and_read_only_native_db(self):
        self.capture()
        path = self.execution()
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        value = exporter.project(self.root, self.home, now=NOW)
        self.assertEqual(len(value['notifications']), 1)
        self.assertEqual(value['notifications'][0]['delivery']['state'], 'no_home')
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        destination = self.root / 'notifications.json.gz'
        exporter.write_projection(value, destination)
        self.assertEqual(json.loads(gzip.decompress(destination.read_bytes())), value)

    def test_acks_are_unknown_with_finite_deadline_not_fabricated_confirmed(self):
        self.capture(home_state='configured')
        self.execution(outcome='delivered')
        value = exporter.project(self.root, self.home, now=NOW)['notifications'][0]
        self.assertEqual(value['delivery']['state'], 'unknown')
        self.assertEqual(value['delivery']['reconcile_by'], (NOW + dt.timedelta(seconds=120)).isoformat())

    def test_delivery_failure_is_separate_from_successful_execution(self):
        self.capture(home_state='configured')
        self.execution(outcome='failed')
        value = exporter.project(self.root, self.home, now=NOW)['notifications'][0]
        self.assertEqual(value['terminal_state'], 'completed')
        self.assertEqual(value['delivery']['state'], 'failed')

    def test_mismatched_job_incomplete_execution_and_foreign_owner_are_omitted(self):
        self.capture()
        path = self.execution(job='wrong-job')
        self.assertEqual(exporter.project(self.root, self.home)['notifications'], [])
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('UPDATE executions SET job_id=?,status=?', ('job-one', 'running'))
        self.assertEqual(exporter.project(self.root, self.home)['notifications'], [])
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('UPDATE executions SET status=?', ('completed',))
        receipt = next((self.root / 'receipts').glob('*.json'))
        data = json.loads(receipt.read_text()); data['owner_id'] = 'foreign-owner'
        receipt.write_text(json.dumps(data))
        self.assertEqual(exporter.project(self.root, self.home)['notifications'], [])

    def test_actual_deployed_layout_and_data_dir_cli(self):
        directory = self.home / 'saleads/runtime'
        directory.mkdir(parents=True)
        installed = directory / 'continuous-exporter.py'
        shutil.copy2(REPO / 'vm/extensions/continuous-exporter.py', installed)
        shutil.copytree(PACKAGE, self.home / 'plugins/saleads-continuity')
        self.capture()
        self.execution()
        result = subprocess.run([sys.executable, str(installed), '--data-dir', str(self.home)],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(gzip.decompress((self.root / 'notifications.json.gz').read_bytes()))
        self.assertEqual(value['notifications'][0]['execution_id'], 'execution-one')

    def test_instants_follow_native_text_and_allow_numeric_compatibility(self):
        self.assertEqual(exporter.instant(NOW.isoformat()), NOW)
        self.assertEqual(exporter.instant(NOW.timestamp()), NOW)
        self.assertIsNone(exporter.instant(True))
        self.assertIsNone(exporter.instant('not-an-instant'))


if __name__ == '__main__':
    unittest.main()
