"""Durable batch/native idempotency boundary, without an inference provider."""
from __future__ import annotations

import hashlib
import hmac
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


PATH = Path(__file__).resolve().parents[3] / 'vm/extensions/curation-dispatcher.py'
SPEC = importlib.util.spec_from_file_location('mcl_curation_dispatcher_fixture', PATH)
dispatcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dispatcher
SPEC.loader.exec_module(dispatcher)
BUSINESS = '00000000-0000-4000-8000-000000000001'
OWNER = 'synthetic-owner'


def batch():
    return {'schema_version': 'curation-batch/1', 'batch_id': 'batch/one',
        'owner_id': OWNER, 'business_id': BUSINESS, 'state': 'pending',
        'native_task_id': None, 'native_run_id': None, 'idempotency_key': 'batch/one'}


def registry():
    return {'owner_id': OWNER, 'contexts': [{'owner_id': OWNER,
        'business_id': BUSINESS, 'actor_role': 'ale'}]}


class Brain:
    def __init__(self, pending):
        self.pending, self.calls = pending, []
        self.lose_bind_ack_once = False

    def post(self, path, body):
        self.calls.append((path, body))
        if path == '/continuous/batches/pending':
            return {'batches': self.pending}
        if self.lose_bind_ack_once:
            self.lose_bind_ack_once = False
            raise dispatcher.DispatchError('brain_unavailable')
        return {'bound': True}


class Kanban:
    def __init__(self, source):
        self.source, self.calls = source, []
        self.cards = {}
        self.status = 'ready'
        self.role = 'curador'

    def call(self, *args, body=None):
        self.calls.append((args, body))
        if args[0] == 'create':
            key = args[args.index('--idempotency-key') + 1]
            self.cards.setdefault(key, {'id': 't_synthetic', 'body': body,
                'tenant': BUSINESS, 'assignee': 'curador'})
            return self.cards[key]
        task = self.cards.get(self.source['idempotency_key'], {
            'id': 't_synthetic', 'body': dispatcher.body_for(self.source),
            'tenant': BUSINESS, 'assignee': 'curador'})
        return {'task': dict(task, status=self.status),
                'runs': [{'id': 7, 'profile': self.role}] if self.status in ('running', 'done') else []}


class DispatcherTests(unittest.TestCase):
    def test_empty_queue_never_creates_or_dispatches_native_work(self):
        brain, kanban = Brain([]), Kanban(batch())
        result = dispatcher.reconcile(registry(), brain, kanban)
        self.assertEqual(result['batches'], 0)
        self.assertEqual(kanban.calls, [])

    def test_creation_uses_stdin_server_batch_key_and_same_board(self):
        source = batch()
        brain, kanban = Brain([source]), Kanban(source)
        result = dispatcher.reconcile(registry(), brain, kanban)
        self.assertEqual(result['reconciled'], 1)
        args, body = kanban.calls[0]
        self.assertEqual(args[args.index('--body-file') + 1], '-')
        self.assertEqual(args[args.index('--tenant') + 1], BUSINESS)
        self.assertEqual(args[args.index('--assignee') + 1], 'curador')
        self.assertEqual(args[args.index('--idempotency-key') + 1], source['idempotency_key'])
        self.assertIn('saleads_commit_candidates', body)
        self.assertNotIn('dispatch', [call[0][0] for call in kanban.calls])
        self.assertEqual(brain.calls[-1][0], '/continuous/batches/batch%2Fone/native')

    def test_lost_bind_ack_replays_same_key_instead_of_duplicate_task(self):
        source = batch()
        brain, kanban = Brain([source]), Kanban(source)
        brain.lose_bind_ack_once = True
        with self.assertRaisesRegex(dispatcher.DispatchError, 'brain_unavailable'):
            dispatcher.reconcile(registry(), brain, kanban)
        dispatcher.reconcile(registry(), brain, kanban)
        self.assertEqual(len(kanban.cards), 1)
        self.assertEqual(len([c for c in kanban.calls if c[0][0] == 'create']), 2)
        self.assertEqual(brain.calls[-1][1]['task_id'], 't_synthetic')

    def test_existing_native_task_is_queried_and_run_bound_without_creation(self):
        source = batch()
        source.update(native_task_id='t_synthetic', native_run_id='7', state='running')
        brain, kanban = Brain([source]), Kanban(source)
        kanban.status = 'running'
        dispatcher.reconcile(registry(), brain, kanban)
        self.assertEqual([c[0][0] for c in kanban.calls], ['show'])
        self.assertEqual(brain.calls[-1][1]['run_id'], '7')

    def test_native_summary_does_not_claim_memory_commit(self):
        source = batch()
        source['native_task_id'] = 't_synthetic'
        brain, kanban = Brain([source]), Kanban(source)
        kanban.status = 'done'
        dispatcher.reconcile(registry(), brain, kanban)
        binding = brain.calls[-1][1]
        self.assertEqual(binding['error_code'], 'native_completed_without_curation_commit')
        self.assertNotIn('committed', binding.values())

    def test_foreign_owner_or_batch_business_cannot_enqueue(self):
        for key, value in (('owner_id', 'foreign-owner'), ('business_id', 'foreign-business')):
            source = batch(); source[key] = value
            brain, kanban = Brain([source]), Kanban(source)
            with self.assertRaisesRegex(dispatcher.DispatchError, 'brain_batch_binding_invalid'):
                dispatcher.reconcile(registry(), brain, kanban)
            self.assertEqual(kanban.calls, [])

    def test_foreign_native_profile_cannot_be_bound(self):
        source = batch()
        brain, kanban = Brain([source]), Kanban(source)
        kanban.status, kanban.role = 'running', 'investigador'
        with self.assertRaisesRegex(dispatcher.DispatchError, 'native_run_profile_mismatch'):
            dispatcher.reconcile(registry(), brain, kanban)
        self.assertEqual(len(brain.calls), 1)

    def test_native_cli_never_builds_shell_and_keeps_unknown_ack(self):
        captured = []
        def run(argv, **kwargs):
            captured.append((argv, kwargs))
            raise subprocess.TimeoutExpired(argv, 30)
        native = dispatcher.Kanban(Path('/synthetic/hermes'), run=run)
        with self.assertRaisesRegex(dispatcher.DispatchError, 'native_ack_unknown'):
            native.call('create', 'Fixed title', '--body-file', '-', body='$(not a shell command)')
        argv, kwargs = captured[0]
        self.assertEqual(argv[:7], [sys.executable, '-m', 'hermes_cli.main', '-p', 'default', 'kanban', 'create'])
        self.assertEqual(kwargs['input'], '$(not a shell command)')
        self.assertNotIn('shell', kwargs)

    def test_collector_derivation_uses_root_private_token_without_returning_it(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            private = 'synthetic-fixture-secret'
            (home / 'config.yaml').write_text(json.dumps({'mcp_servers': {'saleads-brain': {
                'url': 'http://saleads-brain:8765/mcp', 'headers': {'x-saleads-brain-token': private}}}}))
            base, token = dispatcher.credentials(home)
            self.assertEqual(base, 'http://saleads-brain:8765')
            self.assertEqual(token, hmac.new(private.encode(), b'mcl-collector', hashlib.sha256).hexdigest())
            self.assertNotEqual(token, private)

    def test_staged_completion_recovery_loads_fixed_package_helper(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            package = home / 'plugins/saleads-memory'; package.mkdir(parents=True)
            (package / '__init__.py').write_text('')
            (package / 'specialist_capture.py').write_text(
                'def reconcile_all(root):\n'
                '    (root / "recovered-fixture").write_text("reconciled")\n'
                '    return {"recovered": 1}\n')
            try:
                self.assertEqual(dispatcher.reconcile_staged_sources(home), {'recovered': 1})
                self.assertEqual((home / 'recovered-fixture').read_text(), 'reconciled')
            finally:
                for key in list(sys.modules):
                    if key.startswith('_saleads_memory_dispatch_recovery'):
                        sys.modules.pop(key)

    def test_staged_recovery_uses_the_real_packaged_helper_with_no_pending_work(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            package = home / 'plugins/saleads-memory'
            shutil.copytree(PATH.parent / 'saleads-memory', package,
                            ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            sentinel = home / 'unrelated-business.json'
            sentinel.write_text('unchanged fixture')
            try:
                self.assertEqual(dispatcher.reconcile_staged_sources(home), 0)
                self.assertEqual(sentinel.read_text(), 'unchanged fixture')
                self.assertFalse((home / 'profiles').exists())
                self.assertFalse((home / 'kanban.db').exists())
                self.assertFalse((home / 'saleads').exists())
            finally:
                for key in list(sys.modules):
                    if key.startswith('_saleads_memory_dispatch_recovery'):
                        sys.modules.pop(key)

    def test_private_status_retains_only_exception_class_not_private_message(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            directory = home / 'saleads/continuous'
            directory.mkdir(parents=True)
            output = io.StringIO()
            with patch.object(dispatcher, 'run_once', side_effect=TypeError('PRIVATE_MESSAGE_AND_KEY')):
                with contextlib.redirect_stderr(output):
                    self.assertEqual(dispatcher.main(home), 1)
            path = directory / 'curation-dispatch-status.json'
            value = json.loads(path.read_text())
            self.assertEqual(value['exit_code'], 1)
            self.assertEqual(value['exception_class'], 'TypeError')
            self.assertIsNone(value['error_code'])
            self.assertNotIn('PRIVATE_MESSAGE_AND_KEY', path.read_text() + output.getvalue())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertLess(path.stat().st_size, 512)
            self.assertEqual(list(directory.glob('.curation-status-*')), [])

    def test_dispatch_error_status_refuses_a_nonpublic_message(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            (home / 'saleads/continuous').mkdir(parents=True)
            with patch.object(dispatcher, 'run_once', side_effect=dispatcher.DispatchError('PRIVATE KEY=value')):
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(dispatcher.main(home), 2)
            value = json.loads((home / 'saleads/continuous/curation-dispatch-status.json').read_text())
            self.assertEqual(value['error_code'], 'dispatch_failed')
            self.assertEqual(value['exception_class'], 'DispatchError')


class NativeReadonlyAnchorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = os.environ.get('MCL_HERMES_SOURCE')
        if source:
            sys.path.insert(0, source)
        try:
            from hermes_cli.sqlite_safe_read import connect_tracked  # noqa: F401
        except ImportError:
            raise unittest.SkipTest('Pinned Hermes SDK required for actual tracked SQLite handles.') from None

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        shutil.copytree(PATH.parent / 'saleads-memory', self.home / 'plugins/saleads-memory',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        self.addCleanup(self.clean_modules)

    def clean_modules(self):
        context = sys.modules.get('_saleads_memory_dispatch_recovery.context')
        if context:
            context.release_native_sqlite_anchors(self.home)
        for key in list(sys.modules):
            if key.startswith('_saleads_memory_dispatch_recovery'):
                sys.modules.pop(key)

    def create_store(self, name):
        with contextlib.closing(sqlite3.connect(self.home / name)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE fixture (id INTEGER PRIMARY KEY)')
            db.commit()

    def assert_anchors(self, names):
        context = sys.modules['_saleads_memory_dispatch_recovery.context']
        for name in names:
            _identity, db = context._SQLITE_ANCHORS[self.home / name]
            self.assertFalse(db.in_transaction)
            self.assertEqual(db.total_changes, 0)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute('INSERT INTO fixture VALUES(99)')
            self.assertFalse(db.in_transaction)

    def test_actual_readers_warm_fresh_native_stores_before_brain_bind(self):
        source = batch()
        fixture = self
        class BoundBrain(Brain):
            def post(self, path, body):
                if path.endswith('/native'):
                    fixture.assert_anchors(['kanban.db', 'state.db'])
                return super().post(path, body)
        def run(argv, **_kwargs):
            if argv[6] == 'create':
                self.create_store('kanban.db')
                value = {'id': 't_synthetic'}
            else:
                self.assert_anchors(['kanban.db'])
                self.create_store('state.db')
                value = {'task': {'id': 't_synthetic', 'tenant': BUSINESS, 'assignee': 'curador',
                                  'body': dispatcher.body_for(source), 'status': 'ready'}, 'runs': []}
            return subprocess.CompletedProcess(argv, 0, json.dumps(value), '')
        result = dispatcher.reconcile(registry(), BoundBrain([source]), dispatcher.Kanban(self.home, run=run))
        self.assertEqual(result['reconciled'], 1)
        self.assert_anchors(['kanban.db', 'state.db'])

    def test_lost_cli_ack_still_retains_a_store_the_native_command_created(self):
        def run(argv, **_kwargs):
            self.create_store('kanban.db')
            raise subprocess.TimeoutExpired(argv, 30)
        with self.assertRaisesRegex(dispatcher.DispatchError, 'native_ack_unknown'):
            dispatcher.Kanban(self.home, run=run).call('create', 'Fixture')
        self.assert_anchors(['kanban.db'])
        self.assertFalse((self.home / 'state.db').exists())

    def test_existing_stores_are_retained_before_source_recovery(self):
        self.create_store('kanban.db')
        (self.home / 'saleads/continuous').mkdir(parents=True)
        (self.home / 'saleads/continuous/trusted-contexts.json').write_text(json.dumps({
            'schema_version': 'trusted-context-registry/1', **registry()}))
        def recover(home):
            self.assertEqual(home, self.home)
            self.assert_anchors(['kanban.db'])
            return 0
        with patch.object(dispatcher, 'reconcile_staged_sources', side_effect=recover):
            with patch.object(dispatcher, 'credentials', return_value=('http://fixture', 'synthetic-token')):
                with patch.object(dispatcher, 'Brain', return_value=Brain([])):
                    self.assertEqual(dispatcher.run_once(self.home)['batches'], 0)

    def test_symlinked_native_store_fails_before_any_brain_binding(self):
        target = self.home / 'foreign.sqlite'
        target.write_bytes(b'unchanged fixture')
        (self.home / 'kanban.db').symlink_to(target)
        with self.assertRaisesRegex(dispatcher.DispatchError, 'native_sqlite_anchor_unavailable'):
            dispatcher.retain_native_readers(self.home)
        self.assertEqual(target.read_bytes(), b'unchanged fixture')

    def test_real_module_cli_recovers_one_disposable_task_at_runtime_uid_without_path_entrypoint(self):
        self.assertEqual((os.geteuid(), os.getegid()), (10000, 10000),
                         'Run this native smoke at the actual published-image runtime UID/GID.')
        (self.home / 'config.yaml').write_text(json.dumps({
            'model': {'provider': 'meta-ai', 'default': 'muse-spark-1.3-contributor'},
            'kanban': {'auto_decompose': False, 'review_dispatch': False, 'max_in_progress': 2},
        }))
        env = {key: value for key, value in os.environ.items()
               if not key.startswith('HERMES_KANBAN_') and key not in
               {'HERMES_PROFILE', 'HERMES_TENANT', 'HERMES_SESSION_ID'}}
        env.update(HERMES_HOME=str(self.home), HERMES_KANBAN_HOME=str(self.home),
                   PATH='/usr/bin:/bin', PYTHONDONTWRITEBYTECODE='1')
        with patch.dict(os.environ, env, clear=True):
            self.assertIsNone(shutil.which('hermes'))
            from hermes_cli.profiles import create_profile
            create_profile('curador', no_alias=True, no_skills=True,
                           description='Synthetic native CLI smoke profile')
            native = dispatcher.Kanban(self.home)
            arguments = ('create', 'Synthetic native CLI fixture', '--body-file', '-',
                         '--tenant', BUSINESS, '--assignee', 'curador',
                         '--idempotency-key', 'mcl-native-entrypoint-fixture')
            first = native.call(*arguments, body=dispatcher.body_for(batch()))
            replay = native.call(*arguments, body=dispatcher.body_for(batch()))
            self.assertEqual(first['id'], replay['id'])
            shown = native.call('show', first['id'])
            self.assertEqual(shown['task']['tenant'], BUSINESS)
            self.assertEqual(shown['task']['assignee'], 'curador')
            self.assertEqual(shown['runs'], [])  # CRUD smoke never invokes a worker/model.
            with contextlib.closing(sqlite3.connect((self.home / 'kanban.db').as_uri() + '?mode=ro', uri=True)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM tasks').fetchone()[0], 1)
            self.assertTrue((self.home / 'profiles/curador/profile.yaml').is_file())
            self.assert_anchors(['kanban.db'])


if __name__ == '__main__':
    unittest.main()
