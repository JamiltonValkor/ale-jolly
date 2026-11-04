"""Physical SQLite fixtures for API acceptance recovery, no native runtime/model.

Set MCL_HERMES_SOURCE to the exact pinned upstream checkout to additionally run
the fixtures through its real RunIdempotencyStore reserve/update/prune APIs.
The default fixture uses the source-verified full native table shape.
"""
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


PATH = Path(__file__).resolve().parents[3] / 'vm/extensions/saleads-continuity/run_receipts.py'
SPEC = importlib.util.spec_from_file_location('mcl_run_receipts_fixture', PATH)
receipts = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = receipts
SPEC.loader.exec_module(receipts)
RUN = 'run_' + 'a' * 32
OTHER_RUN = 'run_' + 'b' * 32
TURN = '00000000-0000-4000-8000-000000000001'
FINGERPRINT = 'f' * 64
SCOPE_HASH = hashlib.sha256(b'default\0synthetic-api-key').hexdigest()
CONTEXT = {'schema_version': 'trusted-context/1', 'owner_id': 'synthetic-owner',
    'business_id': '00000000-0000-4000-8000-000000000002', 'session_id': 'synthetic-canonical-session',
    'actor_role': 'ale', 'native_task_id': None, 'native_run_id': None, 'response_locale': 'fr',
    'locale_revision': 1, 'capabilities': [], 'mandate_id': None, 'pending_context': False}
TEXT = 'SALEADS_OWNER_MESSAGE_V1 {"client_message_id":"synthetic-id","text":"PRIVATE_OWNER_TEXT"}'


class PhysicalNativeSqliteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mcl-run-receipt-test-')
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.root = self.home / 'saleads/continuous'
        self.root.mkdir(parents=True)
        self.dbpath = self.home / 'runs_idempotency.db'
        self.when = time.time() - 100
        with closing(sqlite3.connect(self.dbpath)) as db, db:
            db.execute('''CREATE TABLE run_idempotency (
                scope TEXT NOT NULL,idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,
                run_id TEXT NOT NULL,status_json TEXT NOT NULL,owner_pid INTEGER NOT NULL DEFAULT 0,
                owner_started INTEGER NOT NULL DEFAULT 0,retention_until REAL NOT NULL DEFAULT 0,
                acknowledged_at REAL,created_at REAL NOT NULL,updated_at REAL NOT NULL,
                PRIMARY KEY(scope,idempotency_key))''')
            db.execute('CREATE UNIQUE INDEX run_idempotency_run_id ON run_idempotency(run_id)')
        self.row()

    def row(self, *, run=RUN, turn=TURN, status='running', session=CONTEXT['session_id'],
            fingerprint=FINGERPRINT, key=None, scope=SCOPE_HASH, updated=None):
        payload = {'object': 'hermes.run', 'run_id': run, 'session_id': session, 'status': status,
                   'output': 'PRIVATE_PROVIDER_OUTPUT', 'error': 'PRIVATE_PROVIDER_ERROR',
                   'approval': {'credential': 'PRIVATE_NEVER_EXPORT'}}
        with closing(sqlite3.connect(self.dbpath)) as db, db:
            db.execute('INSERT OR REPLACE INTO run_idempotency VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                (scope, key or 'first-loop-' + turn, fingerprint, run, json.dumps(payload), 1, 1, 0, None,
                 self.when, updated or self.when))

    def capture(self, *, context=None, text=TEXT, run=RUN, native_session=None):
        return receipts.capture(context or CONTEXT, text, native_session_id=native_session or CONTEXT['session_id'],
            root=self.root, home=self.home, run_id_provider=lambda: run, clock=lambda: self.when + 1)

    def project(self, *, registry=None):
        return receipts.projection(registry or {'owner_id': CONTEXT['owner_id'], 'contexts': [CONTEXT]},
            root=self.root, home=self.home)

    def registry(self, context=CONTEXT):
        value = {'schema_version': 'trusted-context-registry/1', 'owner_id': context['owner_id'],
                 'contexts': [context], 'jobs': []}
        (self.root / 'trusted-contexts.json').write_text(json.dumps(value))
        return value

    def load_entry(self):
        package = PATH.parent
        name = '_mcl_receipt_entry_integration'
        spec = importlib.util.spec_from_file_location(name, package / '__init__.py',
            submodule_search_locations=[str(package)])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module

    def load_exporter(self):
        path = PATH.parent.parent / 'continuous-exporter.py'
        name = '_mcl_receipt_exporter_integration'
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module

    def test_positive_pre_receipt_matches_exact_turn_hash_and_session_without_private_content(self):
        before = hashlib.sha256(self.dbpath.read_bytes()).hexdigest()
        self.assertTrue(self.capture())
        values = self.project()
        self.assertEqual(len(values), 1)
        value = values[0]
        self.assertEqual(value['turn_id'], TURN)
        self.assertEqual(value['run_id'], RUN)
        self.assertEqual(value['request_text_sha256'], hashlib.sha256(TEXT.encode()).hexdigest())
        self.assertEqual(value['native_scope_sha256'], SCOPE_HASH)
        self.assertFalse(value['terminal_proven'])
        self.assertEqual(value['native_status'], 'running')
        self.assertEqual(hashlib.sha256(self.dbpath.read_bytes()).hexdigest(), before)
        for path in self.root.rglob('*.json'):
            text = path.read_text()
            for forbidden in ('PRIVATE_OWNER_TEXT', 'PRIVATE_PROVIDER_OUTPUT', 'PRIVATE_PROVIDER_ERROR',
                              'PRIVATE_NEVER_EXPORT', 'synthetic-private-scope'):
                self.assertNotIn(forbidden, text)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_successful_post_hook_is_not_used_as_terminal_proof(self):
        self.capture()
        value = self.project()[0]
        self.assertFalse(value['terminal_proven'])
        self.row(status='completed', updated=self.when + 20)
        value = self.project()[0]
        self.assertTrue(value['terminal_proven'])
        self.assertEqual(value['native_status'], 'completed')

    def test_terminal_copy_survives_native_pruning_and_reopen(self):
        self.capture()
        self.row(status='completed', updated=self.when + 30)
        self.project()
        with closing(sqlite3.connect(self.dbpath)) as db, db:
            db.execute('DELETE FROM run_idempotency')
        value = self.project()[0]
        self.assertTrue(value['terminal_proven'])
        self.assertFalse(value['native_record_present'])
        self.assertEqual(value['native_status'], 'completed')
        self.assertIsNone(value['proof_gap'])

    def test_acceptance_only_after_prune_is_unknown_proof_gap_not_failure(self):
        self.capture()
        with closing(sqlite3.connect(self.dbpath)) as db, db:
            db.execute('DELETE FROM run_idempotency')
        value = self.project()[0]
        self.assertFalse(value['terminal_proven'])
        self.assertFalse(value['native_record_present'])
        self.assertEqual(value['native_status'], 'running')  # Explicitly last-observed, not live-state proof.
        self.assertEqual(value['proof_gap'], 'native_terminal_proof_unavailable')
        self.assertNotEqual(value['native_status'], 'failed')

    def test_same_turn_never_acquires_a_different_run_even_after_retention_loss(self):
        self.capture()
        self.row(run=OTHER_RUN, scope='d' * 64, updated=self.when + 20)
        self.assertTrue(self.capture(run=OTHER_RUN))
        value = self.project()[0]
        self.assertEqual(value['run_id'], RUN)
        self.assertEqual(value['proof_gap'], 'native_turn_identity_conflict')
        self.assertEqual(len(self.project()), 1)

    def test_wrong_business_wrong_session_and_nonbackend_keys_never_export(self):
        self.row(session='other-session')
        with self.assertRaisesRegex(receipts.ReceiptError, 'native_run_session_mismatch'):
            self.capture()
        self.assertEqual(self.project(), [])
        self.row(key='another-client-key')
        self.capture()
        self.assertEqual(self.project(), [])
        self.row()
        self.capture()
        foreign = {**CONTEXT, 'business_id': '00000000-0000-4000-8000-000000000003'}
        self.assertEqual(self.project(registry={'owner_id': CONTEXT['owner_id'], 'contexts': [foreign]}), [])

    def test_selfwake_and_worker_contexts_do_not_capture_backend_runs(self):
        for run in (CONTEXT['session_id'], '', 'run_a', 'not-an-api-run'):
            self.assertFalse(self.capture(run=run))
        self.assertFalse(self.capture(context={**CONTEXT, 'actor_role': 'curador'}))
        self.assertEqual(self.project(), [])

    def test_corrupt_existing_proof_is_not_silently_replaced(self):
        self.capture()
        accepted = self.root / 'run-receipts/accepted' / (TURN + '.json')
        accepted.write_text('{invalid')
        with self.assertRaisesRegex(receipts.ReceiptError, 'run_receipt_corrupt'):
            self.capture()
        self.assertEqual(accepted.read_text(), '{invalid')

    def test_non_ascii_and_whitespace_are_hashed_exactly_without_normalizing_owner_input(self):
        text = '\nSALEADS_OWNER_MESSAGE_V1 {"client_message_id":"one","text":"Niñez, café ☕"}\n '
        self.capture(text=text)
        self.assertEqual(self.project()[0]['request_text_sha256'], hashlib.sha256(text.encode('utf-8')).hexdigest())

    def test_terminal_proof_cannot_be_downgraded_by_a_stale_running_row(self):
        self.capture(); self.row(status='completed', updated=self.when + 30)
        self.project()
        self.row(status='running', updated=self.when + 10)
        value = self.project()[0]
        self.assertTrue(value['terminal_proven'])
        self.assertEqual(value['native_status'], 'completed')

    def test_native_getter_rejects_raw_chat_keys_and_accepts_only_run_namespace(self):
        fake = SimpleNamespace(get_session_env=lambda name, default: CONTEXT['session_id'])
        approval = SimpleNamespace(get_current_session_key=lambda default: '')
        with patch.dict(sys.modules, {'gateway.session_context': fake, 'tools.approval_context': approval}):
            self.assertIsNone(receipts.native_run_id())
            fake.get_session_env = lambda name, default: RUN
            self.assertEqual(receipts.native_run_id(), RUN)

    def test_entry_persists_api_acceptance_before_any_model_or_post_hook(self):
        self.registry()
        entry = self.load_entry()
        hooks = {}
        ctx = SimpleNamespace(current_cron_execution=lambda: None,
            register_hook=lambda name, callback: hooks.__setitem__(name, callback),
            register_platform=lambda **kwargs: None)
        entry.register(ctx, root=self.root)
        def observe(value, user_message, **kwargs):
            return receipts.capture(value, user_message, **kwargs, run_id_provider=lambda: RUN)
        with patch.object(entry, 'capture_api_run_acceptance', side_effect=observe) as observer:
            hooks['pre_llm_call'](session_id=CONTEXT['session_id'], turn_id='native-turn-one',
                user_message=TEXT, platform='api_server')
        observer.assert_called_once()
        self.assertTrue((self.root / 'run-receipts/accepted' / (TURN + '.json')).is_file())
        self.assertFalse(self.project()[0]['terminal_proven'])

    def test_entry_does_not_capture_cli_or_cron_as_a_backend_api_request(self):
        self.registry()
        entry = self.load_entry()
        hooks = {}
        identity = [None]
        ctx = SimpleNamespace(current_cron_execution=lambda: identity[0],
            register_hook=lambda name, callback: hooks.__setitem__(name, callback),
            register_platform=lambda **kwargs: None)
        entry.register(ctx, root=self.root)
        with patch.object(entry, 'capture_api_run_acceptance') as observer:
            hooks['pre_llm_call'](session_id=CONTEXT['session_id'], turn_id='cli', user_message=TEXT, platform='cli')
            identity[0] = SimpleNamespace(job_id='unknown-cron', execution_id='cron-id')
            hooks['pre_llm_call'](session_id=CONTEXT['session_id'], turn_id='cron', user_message=TEXT, platform='api_server')
        observer.assert_not_called()

    def test_exporter_includes_only_run_proof_without_any_cron_directory(self):
        self.registry()
        self.capture()
        self.assertFalse((self.root / 'receipts').exists())
        document = self.load_exporter().project(self.root, self.home)
        self.assertEqual(document['notifications'], [])
        self.assertEqual(document['run_receipts'][0]['turn_id'], TURN)
        self.assertEqual(document['run_receipts'][0]['native_scope_sha256'], SCOPE_HASH)
        self.assertNotIn('PRIVATE_OWNER_TEXT', json.dumps(document))
        self.assertNotIn('PRIVATE_PROVIDER_OUTPUT', json.dumps(document))

    def test_exporter_omits_other_owner_acceptance_and_unlisted_private_fields(self):
        self.registry()
        self.capture()
        accepted = self.root / 'run-receipts/accepted' / (TURN + '.json')
        value = json.loads(accepted.read_text())
        value['unlisted_private_data'] = 'DO_NOT_EXPORT_ANY_UNKNOWN_KEY'
        accepted.write_text(json.dumps(value))
        exporter = self.load_exporter()
        self.assertNotIn('DO_NOT_EXPORT_ANY_UNKNOWN_KEY', json.dumps(exporter.project(self.root, self.home)))
        self.registry({**CONTEXT, 'owner_id': 'another-owner'})
        self.assertEqual(exporter.project(self.root, self.home)['run_receipts'], [])


class RealNativeConstructorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = os.environ.get('MCL_HERMES_SOURCE')
        if source:
            sys.path.insert(0, source)
        try:
            from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore
        except ImportError:
            raise unittest.SkipTest('Pinned Hermes SDK not on this interpreter; run in the native image or set MCL_HERMES_SOURCE.') from None
        cls.Store = RunIdempotencyStore

    def test_actual_native_contextvars_keep_concurrent_runs_and_selfwake_separate(self):
        from gateway.session_context import clear_session_vars, set_session_vars
        barrier = threading.Barrier(3)
        def observe(key):
            tokens = set_session_vars(platform='api_server', session_key=key, session_id=CONTEXT['session_id'])
            try:
                barrier.wait(timeout=5)
                return receipts.native_run_id()
            finally:
                clear_session_vars(tokens)
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(observe, key) for key in (RUN, OTHER_RUN, CONTEXT['session_id'])]
            self.assertEqual([future.result(timeout=10) for future in futures], [RUN, OTHER_RUN, None])

    def test_actual_native_constructor_reserve_update_prune_preserves_copied_proof(self):
        with tempfile.TemporaryDirectory(prefix='mcl-real-run-store-') as folder:
            home = Path(folder); root = home / 'saleads/continuous'
            root.mkdir(parents=True)
            with patch.dict(os.environ, {'HERMES_HOME': str(home)}):
                store = self.Store(str(home / 'runs_idempotency.db'))
                try:
                    old = time.time() - self.Store.RETENTION_SECONDS - 1000
                    status = {'object': 'hermes.run', 'run_id': RUN, 'session_id': CONTEXT['session_id'], 'status': 'running'}
                    with patch('gateway.platforms.api_server_run_idempotency.time.time', return_value=old):
                        outcome, _ = store.reserve(SCOPE_HASH, 'first-loop-' + TURN, FINGERPRINT, RUN, status)
                    self.assertEqual(outcome, 'created')
                    self.assertTrue(receipts.capture(CONTEXT, TEXT, root=root, home=home,
                        run_id_provider=lambda: RUN, clock=lambda: old + 1))
                    with patch('gateway.platforms.api_server_run_idempotency.time.time', return_value=old + 100):
                        store.update_status(RUN, {**status, 'status': 'completed', 'output': 'PRIVATE_NATIVE_OUTPUT'})
                    receipts.refresh(root=root, home=home, clock=lambda: old + 101)
                    # The real native lookup prunes its own terminal TTL row.
                    self.assertEqual(store.lookup(SCOPE_HASH, 'first-loop-' + TURN, FINGERPRINT), ('missing', None))
                    values = receipts.projection({'owner_id': CONTEXT['owner_id'], 'contexts': [CONTEXT]}, root=root, home=home)
                    self.assertEqual(values[0]['native_status'], 'completed')
                    self.assertTrue(values[0]['terminal_proven'])
                    self.assertFalse(values[0]['native_record_present'])
                    self.assertNotIn('PRIVATE_NATIVE_OUTPUT', json.dumps(values))
                finally:
                    store.close()


if __name__ == '__main__':
    unittest.main()
