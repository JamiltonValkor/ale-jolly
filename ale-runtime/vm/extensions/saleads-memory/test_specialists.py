"""Native terminal proof, source replay and deterministic dispatch; no real model/process/network."""
import base64
import copy
from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import patch

from test_memory import context, pack, memory_module, client_module
import sys
module = sys.modules[memory_module.__package__ + '.specialist_capture']
dispatch_module = sys.modules[memory_module.__package__ + '.dispatch']


class SpecialistTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'profiles/investigador'
        self.home.mkdir(parents=True)
        self.ctx = context('investigador', native_task_id='native-research', native_run_id='7', session_id='native-session')
        self.sources, self.dispatches = [], []
        def request(ctx, path, payload, **_kwargs):
            self.sources.append(copy.deepcopy(payload))
            return {'accepted': True, 'event_id': payload['event_id']}
        trigger = types.SimpleNamespace(request=lambda ctx, ids: self.dispatches.append(list(ids)))
        self.recorder = module.SpecialistRecorder(self.home, root=self.root, client=types.SimpleNamespace(request=request), trigger=trigger)
        self.database = self.root / 'kanban.db'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript('CREATE TABLE tasks(id TEXT PRIMARY KEY,tenant TEXT,assignee TEXT,status TEXT,title TEXT); CREATE TABLE task_runs(id INTEGER PRIMARY KEY,task_id TEXT,profile TEXT,status TEXT,outcome TEXT,started_at INTEGER,ended_at INTEGER,metadata TEXT,summary TEXT);')
            db.execute('INSERT INTO tasks VALUES(?,?,?,?,?)', ('native-research', self.ctx['business_id'], 'investigador', 'in_progress', 'Read current market evidence'))
            db.execute('INSERT INTO task_runs VALUES(?,?,?,?,?,?,?,?,?)', (7, 'native-research', 'investigador', 'running', None, 1793100000, None, json.dumps({'worker_session_id': 'native-session'}), None))

    def complete(self, blocked=False):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE tasks SET status=?', ('blocked' if blocked else 'done',))
            db.execute('UPDATE task_runs SET status=?,outcome=?,ended_at=?', ('blocked' if blocked else 'done', 'blocked' if blocked else 'completed', 1793100100))

    def metadata(self, **values):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE task_runs SET metadata=?', (json.dumps({'worker_session_id': 'native-session', **values}),))

    def handoff(self, **values):
        return {'method': 'Check the local original source and its publication date.',
            'observed_errors_corrections': 'A reference storefront used a foreign currency; use the actual local source.',
            'practical_lesson': 'Verify region and date before comparing a source.',
            'queries_performed': ['synthetic current local source'],
            'facts_sourced': [{'fact': 'Synthetic fact.', 'url': 'https://example.org/local', 'date': '2026-10-29'}],
            'sources_dated': [{'url': 'https://example.org/local', 'observed_at': '2026-10-28'}], **values}

    def test_post_output_is_pending_until_exact_native_run_is_terminal(self):
        self.assertTrue(self.recorder.stage(self.ctx, 'native-session', 'Actual generated research proposal.'))
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertEqual(self.sources, []); self.assertEqual(self.dispatches, [])
        self.complete()
        before = self.database.read_bytes()
        self.assertEqual(self.recorder.reconcile(), 1)
        self.assertEqual(self.database.read_bytes(), before)
        event = self.sources[0]
        self.assertEqual((event['source_kind'], event['author']['kind'], event['author']['id']), ('specialist_result', 'specialist', 'investigador'))
        self.assertEqual((event['native_task_id'], event['native_run_id']), ('native-research', '7'))
        self.assertIn('not owner testimony or independently verified platform metrics', event['content'])
        self.assertEqual(len(self.dispatches), 1)
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertFalse(self.recorder.stage(self.ctx, 'native-session', 'Actual generated research proposal.'))

    def test_forged_tenant_role_run_or_session_produces_no_source(self):
        self.complete()
        variants = [dict(self.ctx, business_id='22222222-2222-4222-8222-222222222222'), dict(self.ctx, native_run_id='8'), dict(self.ctx, actor_role='estratega'), dict(self.ctx, session_id='another-session')]
        for ctx in variants:
            self.recorder.stage(ctx, ctx['session_id'], 'Generated work for the wrong binding.')
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertEqual(self.sources, [])

    def test_worker_rotation_uses_official_tip_of_its_own_read_only_profile_store(self):
        self.complete()
        (self.home / 'state.db').write_bytes(b'synthetic-state-fixture')
        opened = []
        class NativeStore:
            def __init__(self, path, read_only=False):
                opened.append((path, read_only))
            def get_session(self, session):
                return {'id': session, 'profile_name': 'investigador'}
            def get_compression_tip(self, canonical):
                return 'native-continuation-tip' if canonical == 'native-session' else canonical
            def close(self): pass
        rotated = dict(self.ctx, session_id='native-continuation-tip')
        with patch.dict(sys.modules, {'hermes_state': types.SimpleNamespace(SessionDB=NativeStore)}):
            self.recorder.stage(rotated, 'native-continuation-tip', 'Generated result after an official compression rotation.')
            self.assertEqual(self.recorder.reconcile(), 1)
            self.assertEqual(opened, [(self.home / 'state.db', True)])
            self.assertFalse(module.same_profile_session(self.home, 'native-session', 'unrelated-sibling'))
        self.assertEqual(len(self.sources), 1)
        self.assertIn('hermes-session:native-continuation-tip', self.sources[0]['refs'])

    def test_wrong_profile_stamp_cannot_authorize_a_session_alias(self):
        (self.home / 'state.db').write_bytes(b'synthetic-state-fixture')
        class ForeignStore:
            def __init__(self, path, read_only=False): pass
            def get_session(self, session): return {'id': session, 'profile_name': 'estratega'}
            def get_compression_tip(self, session): return 'native-continuation-tip'
            def close(self): pass
        with patch.dict(sys.modules, {'hermes_state': types.SimpleNamespace(SessionDB=ForeignStore)}):
            self.assertFalse(module.same_profile_session(self.home, 'native-session', 'native-continuation-tip'))

    def test_curator_and_unbound_or_silent_output_never_recurse(self):
        for ctx, text in [(context('curador'), 'A curation receipt'), (context(), 'Main reply'), (dict(self.ctx, native_run_id=None), 'Unknown run'), (self.ctx, '[SILENT]')]:
            self.assertFalse(self.recorder.stage(ctx, ctx['session_id'], text))
        self.assertEqual(self.sources, [])

    def test_no_database_is_created_for_missing_or_wrong_board(self):
        missing = self.root / 'missing'
        missing.mkdir()
        self.assertIsNone(module.terminal_run(missing, self.ctx, 'native-session'))
        self.assertFalse((missing / 'kanban.db').exists())

    def test_legacy_role_retains_fixed_root_board_policy_with_a_worker_pin_present(self):
        self.complete()
        with patch.dict(os.environ, {'HERMES_KANBAN_DB': '/untrusted/named/kanban.db'}):
            self.recorder.stage(self.ctx, 'native-session', 'Existing role result uses its established root board.')
            self.assertEqual(self.recorder.reconcile(), 1)
        self.assertEqual(self.sources[0]['author']['id'], 'investigador')

    def test_verified_search_receipt_requires_exact_task_run_business_and_session(self):
        self.complete()
        directory = self.home / 'plugin-data/saleads-meta-search/receipts'
        directory.mkdir(parents=True)
        base = {'status': 'completed', 'model': 'muse-spark-1.3-contributor', 'search_calls': 2, 'response_id': 'real-search-fixture', 'business_id': self.ctx['business_id'], 'native_task_id': 'native-research', 'native_run_id': '7', 'session_id': 'native-session', 'citations': [{'url': 'https://example.org/verified-source'}]}
        invalid = dict(base, response_id='wrong-run', native_run_id='99', citations=[{'url': 'https://example.org/wrong-run'}])
        (directory / ('a' * 64 + '.json')).write_text(json.dumps(invalid))
        (directory / ('b' * 64 + '.json')).write_text(json.dumps(base))
        self.recorder.stage(self.ctx, 'native-session', 'Generated report claiming https://example.org/unverified-prose')
        self.recorder.reconcile()
        event = self.sources[0]
        self.assertIn('https://example.org/verified-source', event['refs'])
        self.assertNotIn('https://example.org/wrong-run', event['refs'])
        self.assertNotIn('https://example.org/unverified-prose', event['refs'])
        self.assertIn('Verified Meta hosted web_search', event['content'])

    def test_chunks_are_one_episode_and_replay_after_lost_source_ack_is_idempotent(self):
        self.complete()
        text = 'Documented generated result. ' * 1200
        self.recorder.stage(self.ctx, 'native-session', text)
        real_request = self.recorder.client.request
        lost = True
        def unreliable(ctx, path, payload, **kwargs):
            nonlocal lost
            result = real_request(ctx, path, payload, **kwargs)
            if lost:
                lost = False
                raise client_module.MemoryFailure('MEMORY_UNAVAILABLE')
            return result
        self.recorder.client.request = unreliable
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertEqual(self.dispatches, [])
        self.assertEqual(self.recorder.reconcile(), 1)
        self.assertEqual(self.sources[0]['event_id'], self.sources[1]['event_id'])
        self.assertEqual(len({event['source_id'] for event in self.sources}), 1)
        self.assertGreater(len({event['source_version'] for event in self.sources}), 1)
        for event in self.sources:
            self.assertLessEqual(len(event['content']), 24000)
            self.assertLessEqual(len(client_module.canonical(event).encode()), 128000)
            self.assertEqual(event['content_sha256'], sha256(event['content'].encode()).hexdigest())
        self.assertEqual(len(self.dispatches), 1)

    def test_blocked_attempt_is_captured_as_blocked_not_successful_business_result(self):
        self.complete(blocked=True)
        self.recorder.stage(self.ctx, 'native-session', 'Source lookup failed; do not fabricate measurements.')
        self.recorder.reconcile()
        self.assertIn('"outcome":"blocked"', self.sources[0]['content'])

    def test_recovery_can_register_pending_source_without_spawning_another_dispatcher(self):
        self.recorder.stage(self.ctx, 'native-session', 'Durable generated work.')
        self.complete()
        self.assertEqual(self.recorder.reconcile(dispatch=False), 1)
        self.assertEqual(len(self.sources), 1)
        self.assertEqual(self.dispatches, [])

    def test_native_terminal_before_or_after_post_is_observed_without_invented_hook(self):
        def request(ctx, path, payload, **kwargs):
            return pack(ctx)
        ctx = types.SimpleNamespace(current_cron_execution=lambda: None)
        plugin = memory_module.MemoryPlugin(ctx, home=self.home, resolver=lambda **kwargs: self.ctx, client=types.SimpleNamespace(request=request), specialists=self.recorder)
        plugin.post(session_id='native-session', assistant_response='Actual worker result after model turn.')
        self.assertEqual(self.sources, [])
        self.complete()
        plugin.native_terminal(task_id='native-research', run_id=7, assignee='investigador')
        self.assertEqual(len(self.sources), 1)
    def test_terminal_hook_before_post_waits_for_actual_generated_output(self):
        self.complete()
        runtime = types.SimpleNamespace(current_cron_execution=lambda: None)
        plugin = memory_module.MemoryPlugin(runtime, home=self.home, resolver=lambda **kwargs: self.ctx, specialists=self.recorder)
        plugin.native_terminal(task_id='native-research', run_id=7)
        self.assertEqual(self.sources, [])
        plugin.post(session_id='native-session', assistant_response='Generated result after the terminal transition.')
        self.assertEqual(len(self.sources), 1)

    def test_unavailable_sidecar_does_not_try_every_pending_record_forever(self):
        self.complete()
        self.recorder.stage(self.ctx, 'native-session', 'First result.')
        self.recorder.stage(self.ctx, 'native-session', 'Second result.')
        calls = []
        def unavailable(*args, **kwargs):
            calls.append(True)
            raise client_module.MemoryFailure('MEMORY_UNAVAILABLE')
        self.recorder.client.request = unavailable
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertEqual(calls, [True])
        self.assertEqual(self.dispatches, [])

    def test_owner_sources_trigger_after_final_response_not_during_pre_hook(self):
        with tempfile.TemporaryDirectory() as home:
            launches = []
            trigger = dispatch_module.CurationTrigger(home, launch=lambda: launches.append(True) or True)
            sources = types.SimpleNamespace(record=lambda *args, **kwargs: None, current=lambda ctx: ['current-owner-source'])
            owner = context()
            runtime = types.SimpleNamespace(current_cron_execution=lambda: None)
            plugin = memory_module.MemoryPlugin(runtime, home=Path(home) / 'ale', resolver=lambda **kwargs: owner,
                client=types.SimpleNamespace(request=lambda ctx, path, data, **kwargs: pack(ctx)), sources=sources, trigger=trigger)
            plugin.pre(turn_id='session-fixture-1:session-fixture-1:0123abcd', session_id=owner['session_id'], user_message='A genuine answer in the normal dialogue.')
            self.assertEqual(launches, [])
            plugin.post(turn_id='session-fixture-1:session-fixture-1:0123abcd', session_id=owner['session_id'], assistant_response='Acknowledged in the configured user language.')
            plugin.post(turn_id='session-fixture-1:session-fixture-1:0123abcd', session_id=owner['session_id'], assistant_response='Same completion observed again.')
            self.assertEqual(launches, [True])
            sources.current = lambda ctx: []
            plugin.pre(turn_id='session-fixture-1:session-fixture-1:0123abcd', session_id=owner['session_id'], user_message='FIRST_USE_ORIENTATION server request')
            plugin.post(turn_id='session-fixture-1:session-fixture-1:0123abcd', session_id=owner['session_id'], assistant_response='A proposed read-only discovery is ready.')
            self.assertEqual(launches, [True])

    def test_generated_metadata_is_material_without_exposing_prompt_identity_or_credentials(self):
        self.complete()
        metadata = self.handoff(
            business_id=self.ctx['business_id'], native_task_id='native-research', native_run_id=7,
            goal_id='PRIVATE_GOAL_NOT_A_SOURCE', worker_prompt='PRIVATE_WORKER_PROMPT',
            unknown_metadata={'value': 'UNKNOWN_TOP_LEVEL'},
            facts_sourced=[{'fact': 'Synthetic sourced fact.', 'url': 'https://example.org/local',
                           'owner_prompt': 'PRIVATE_OWNER_PROMPT', 'input': 'PRIVATE_OWNER_INPUT',
                           'download_url': 'https://example.org/file?token=PRIVATE_QUERY_TOKEN',
                           'api_key': 'LLM_synthetic_secret_value'}],
            risks=['Authorization: Bearer synthetic_secret_value_12345', 'Do not infer a causal winner.'])
        self.metadata(**metadata)
        self.recorder.stage(self.ctx, 'native-session', 'Summary only.')
        self.assertEqual(self.recorder.reconcile(), 1)
        original = next(v for v in self.sources if not v['source_version'].startswith('handoff-'))
        enriched = [v for v in self.sources if v['source_version'].startswith('handoff-')]
        self.assertTrue(enriched)
        content = '\n'.join(v['content'] for v in enriched)
        for field in ('method', 'observed_errors_corrections', 'practical_lesson', 'queries_performed', 'facts_sourced'):
            self.assertIn(field, content)
        for private in ('PRIVATE_GOAL', 'PRIVATE_WORKER_PROMPT', 'PRIVATE_OWNER_PROMPT', 'LLM_synthetic',
                        'PRIVATE_OWNER_INPUT', 'PRIVATE_QUERY_TOKEN', 'UNKNOWN_TOP_LEVEL',
                        'synthetic_secret_value_12345', 'worker_session_id'):
            self.assertNotIn(private, content)
        for event in enriched:
            self.assertEqual(event['source_id'], original['source_id'])
            self.assertNotEqual(event['source_version'], original['source_version'])
            self.assertEqual(event['author'], {'kind': 'specialist', 'id': 'investigador'})
            self.assertIn('native-generated-handoff-sha256:', '\n'.join(event['refs']))
            self.assertEqual(event['content_sha256'], sha256(event['content'].encode()).hexdigest())
            self.assertLessEqual(len(event['content']), 24000)
            self.assertLessEqual(len(client_module.canonical(event).encode()), 128000)
        count = len(self.sources)
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertEqual(len(self.sources), count)
        self.assertEqual(len(self.dispatches), 1)

    def test_registered_stub_is_enriched_once_by_recovery_without_changing_original_source(self):
        self.complete()
        self.recorder.stage(self.ctx, 'native-session', 'Short terminal stub.')
        self.assertEqual(self.recorder.reconcile(), 1)
        original = copy.deepcopy(self.sources[0])
        path = next(self.recorder.registered.glob('*.json'))
        old = json.loads(path.read_text())
        self.metadata(**self.handoff())
        self.assertEqual(self.recorder.reconcile(dispatch=False), 1)
        updated = json.loads(path.read_text())
        self.assertEqual(self.sources[0], original)
        self.assertEqual(updated['text_sha256'], old['text_sha256'])
        self.assertTrue(set(old['registered_ids']) < set(updated['registered_ids']))
        self.assertEqual(len(self.dispatches), 1)  # No-agent recovery never spawns itself.
        self.assertEqual(self.recorder.reconcile(), 0)
        self.metadata(**self.handoff(practical_lesson='Later edited metadata must not replace the captured handoff.'))
        self.recorder.stage(self.ctx, 'native-session', 'Another view of the same terminal execution.')
        self.recorder.reconcile()
        self.assertEqual(len({v['source_version'] for v in self.sources if v['source_version'].startswith('handoff-')}), 1)
        self.assertNotIn('Later edited metadata', '\n'.join(v['content'] for v in self.sources))

    def test_unknown_metadata_only_does_not_create_an_enrichment_or_churn(self):
        self.complete()
        self.metadata(unknown_generated={'content': 'Not an approved handoff field.'},
                      system_prompt='PRIVATE_SYSTEM_PROMPT', access_token='PRIVATE_ACCESS_TOKEN')
        self.recorder.stage(self.ctx, 'native-session', 'Normal generated output.')
        self.recorder.reconcile()
        self.assertEqual(len(self.sources), 1)
        self.assertFalse(self.recorder.handoffs.exists())
        path = next(self.recorder.registered.glob('*.json'))
        before = path.read_bytes()
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertEqual(path.read_bytes(), before)

    def test_missing_session_proof_or_oversized_native_metadata_is_not_admitted(self):
        self.complete()
        self.metadata(worker_session_id='', **self.handoff())
        self.recorder.stage(self.ctx, 'native-session', 'Generated output missing proof.')
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertEqual(self.sources, [])
        self.metadata(method='x' * module.MAX_METADATA_BYTES)
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertEqual(self.sources, [])

    def test_wrong_metadata_identity_is_never_promoted_as_a_handoff(self):
        self.complete()
        self.metadata(**self.handoff(business_id='22222222-2222-4222-8222-222222222222', native_run_id=99))
        self.recorder.stage(self.ctx, 'native-session', 'Bound original final response.')
        self.recorder.reconcile()
        self.assertEqual(len(self.sources), 1)
        self.assertFalse(any(v['source_version'].startswith('handoff-') for v in self.sources))

    def test_bounded_handoff_tags_truncation_and_never_exceeds_source_limits(self):
        self.complete()
        self.metadata(**self.handoff(method='Known method. ' * 1500,
            facts_sourced=[{'fact': 'A sourced synthetic observation. ' * 12, 'url': 'https://example.org/' + str(i)} for i in range(100)]))
        self.recorder.stage(self.ctx, 'native-session', 'Bounded summary.')
        self.recorder.reconcile()
        snapshot = json.loads(next(self.recorder.handoffs.glob('*.json')).read_text())
        self.assertLessEqual(len(snapshot['text'].encode()), module.MAX_HANDOFF_BYTES)
        self.assertTrue(json.loads(snapshot['text'])['capture']['truncated'])
        self.assertIn('credential', json.loads(snapshot['text'])['capture']['omission_policy'])
        for event in self.sources:
            self.assertLessEqual(len(event['content']), 24000)
            self.assertLessEqual(len(client_module.canonical(event).encode()), 128000)

    def test_lost_handoff_ack_retries_the_frozen_first_material_without_another_version(self):
        self.complete()
        self.recorder.stage(self.ctx, 'native-session', 'Legacy stub.')
        self.recorder.reconcile()
        self.metadata(**self.handoff())
        original = self.recorder.client.request
        lost = True
        def unreliable(ctx, path, event, **kwargs):
            nonlocal lost
            response = original(ctx, path, event, **kwargs)
            if lost and event['source_version'].startswith('handoff-'):
                lost = False
                raise client_module.MemoryFailure('MEMORY_UNAVAILABLE')
            return response
        self.recorder.client.request = unreliable
        self.assertEqual(self.recorder.reconcile(), 0)
        self.metadata(**self.handoff(practical_lesson='Changed after the first lost acknowledgment.'))
        self.assertEqual(self.recorder.reconcile(), 1)
        handoffs = [v for v in self.sources if v['source_version'].startswith('handoff-')]
        self.assertEqual(len(handoffs), 2)
        self.assertEqual(handoffs[0]['event_id'], handoffs[1]['event_id'])
        self.assertEqual(handoffs[0]['content_sha256'], handoffs[1]['content_sha256'])
        self.assertNotIn('Changed after', handoffs[1]['content'])
        self.assertEqual(self.recorder.reconcile(), 0)

    def test_registered_scan_cursor_reaches_a_stub_after_the_first_hundred_unrelated_receipts(self):
        self.complete()
        self.recorder.stage(self.ctx, 'native-session', 'A recoverable old stub.')
        self.recorder.reconcile()
        path = next(self.recorder.registered.glob('*.json'))
        self.assertGreater(int(path.stem, 16), 100)
        for i in range(100):
            value = {'schema_version': 'pending-specialist-result/1', 'context': {'actor_role': 'unbound'}}
            (self.recorder.registered / (format(i, '064x') + '.json')).write_text(json.dumps(value))
        self.metadata(**self.handoff())
        self.assertEqual(self.recorder.reconcile(), 0)
        self.assertEqual(self.recorder.reconcile(), 1)
        self.assertTrue(json.loads(path.read_text())['handoff_metadata_sha256'])
        self.assertEqual(len([v for v in self.sources if v['source_version'].startswith('handoff-')]), 1)


class LandingCaptureTests(unittest.TestCase):
    def setUp(self):
        from test_landing_experience import episode, FIXTURE
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'profiles/disenador_landings'
        self.home.mkdir(parents=True)
        self.workspace = self.root / 'native-workspace'
        self.workspace.mkdir()
        self.ctx, self.run, self.inputs = episode()
        self.text = FIXTURE['result']
        for name, content in self.inputs.files.items():
            (self.workspace / name).write_bytes(content)
        self.database = self.root / 'kanban.db'
        with sqlite3.connect(self.database) as db:
            db.executescript('CREATE TABLE tasks(id TEXT PRIMARY KEY,tenant TEXT,assignee TEXT,status TEXT,title TEXT,workspace_kind TEXT,workspace_path TEXT,current_run_id INTEGER); CREATE TABLE task_runs(id INTEGER PRIMARY KEY,task_id TEXT,profile TEXT,status TEXT,outcome TEXT,started_at INTEGER,ended_at INTEGER,metadata TEXT,summary TEXT,claim_lock TEXT,worker_pid INTEGER);')
            db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)', (self.ctx['native_task_id'], self.ctx['business_id'], 'disenador_landings', 'running', 'Build a landing proposal', 'dir', str(self.workspace), 7))
            db.execute('INSERT INTO task_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)', (7, self.ctx['native_task_id'], 'disenador_landings', 'running', None, 1793100000, None, json.dumps({'workspace_path': '/untrusted/model/path'}), None, 'synthetic-native-claim', 4242))
        self.events = [types.SimpleNamespace(id=1, task_id=self.ctx['native_task_id'], run_id=7, kind='claimed', payload={'lock': 'synthetic-native-claim', 'run_id': 7}),
                       types.SimpleNamespace(id=2, task_id=self.ctx['native_task_id'], run_id=7, kind='spawned', payload={'pid': 4242, 'started_at': 'synthetic-process-fingerprint'})]
        self.event_databases = []
        def native_events(db, task):
            self.event_databases.append(Path(db.execute('PRAGMA database_list').fetchone()['file']))
            return self.events
        self.session_source, self.profile_stamp = 'kanban', 'disenador_landings'
        self.state_reads = []
        owner = self
        class NativeSessions:
            def __init__(self, path, read_only=False): owner.state_reads.append((path, read_only))
            def get_session(self, session): return {'id': session, 'source': owner.session_source, 'profile_name': owner.profile_stamp}
            def close(self): pass
        (self.home / 'state.db').write_bytes(b'synthetic-native-state')
        self.enterContext(patch.dict(sys.modules, {
            'hermes_cli': types.SimpleNamespace(kanban_db=types.SimpleNamespace(list_events=native_events)),
            'hermes_state': types.SimpleNamespace(SessionDB=NativeSessions)}))
        self.env = {'HERMES_KANBAN_WORKSPACE': str(self.workspace), 'HERMES_KANBAN_TASK': self.ctx['native_task_id'],
                    'HERMES_KANBAN_RUN_ID': '7', 'HERMES_TENANT': self.ctx['business_id'], 'HERMES_HOME': str(self.home),
                    'HERMES_KANBAN_CLAIM_LOCK': 'synthetic-native-claim', 'HERMES_KANBAN_DB': str(self.database)}
        self.sources = []
        self.client = types.SimpleNamespace(request=self.request)
        collector_token = self.home / 'plugin-data/saleads-memory/collector-token'
        collector_token.parent.mkdir(parents=True)
        collector_token.write_text('c' * 64)
        collector_token.chmod(0o600)

    def request(self, ctx, path, payload, **kwargs):
        self.sources.append(copy.deepcopy(payload))
        return {'accepted': True, 'event_id': payload['event_id']}

    def recorder(self, *, bind=True, **kwargs):
        recorder = module.SpecialistRecorder(self.home, root=self.root, client=self.client,
            trigger=types.SimpleNamespace(request=lambda *args: True), worker_environment=self.env, **kwargs)
        if bind:
            self.assertTrue(recorder.bind(self.ctx, self.ctx['session_id']))
        return recorder

    def complete(self):
        with sqlite3.connect(self.database) as db:
            # Official completion clears current_run_id. It does not erase workspace_path.
            db.execute("UPDATE tasks SET status='done',current_run_id=NULL")
            db.execute("UPDATE task_runs SET status='done',outcome='completed',ended_at=1793100100,worker_pid=NULL")

    def admission_data(self, *, normalized=False):
        """Actual CLI/Landing DTO fields; there is no invented command field."""
        landing = sys.modules[memory_module.__package__ + '.landing_experience']
        raw = {name: self.inputs.files[name] for name in landing.CODE}
        final = {**raw, 'styles.css': raw['styles.css'] + b'/* server-owned font finalization */'} if normalized else raw
        def descriptors(files):
            return {name: {'encoding': 'base64', 'content': base64.b64encode(body).decode(),
                           'sha256': sha256(body).hexdigest(), 'byteLength': len(body)} for name, body in files.items()}
        artifacts = {'pagina': json.loads(self.inputs.files['page.json']), 'diseno': json.loads(self.inputs.files['design.json'])}
        args = {'business_id': self.ctx['business_id'], 'landing_id': self.inputs.admission['data']['landingId'],
                'client_request_id': 'synthetic-authenticated-import', 'expected_latest_n': 0,
                'files': descriptors(raw), 'metadata': {'artifacts': artifacts}}
        receipt = {**self.inputs.admission['data'], 'artifactDigest': landing.artifact_digest(final),
                   'requestId': args['client_request_id'], 'createdBy': 'agent', 'createdAt': '2026-11-03T12:00:00Z'}
        record = {**copy.deepcopy(self.inputs.landing['data']), 'latestN': 1, 'publishedN': 6,
                  'updatedAt': '2026-10-29T12:00:00Z', 'review_url': 'https://app.example.test/review'}
        version = {'landingId': args['landing_id'], 'n': receipt['n'], 'origin': 'hermes', 'createdBy': 'agent',
                   'createdAt': receipt['createdAt'], 'artifactDigest': receipt['artifactDigest'], 'files': descriptors(final),
                   'artifacts': artifacts}
        return args, receipt, record, version

    def projected_metadata(self):
        """Synthetic managed-mapper fixture; the actual pilot mapper has its own integration gate."""
        path = self.root / 'saleads/landing-pilot/build_metadata.py'
        path.parent.mkdir(parents=True)
        path.write_text('import json\n'
            'def build(workspace, landing, task_id=None, run_id=None):\n'
            ' page=json.loads((workspace/"page.json").read_text())\n'
            ' design=json.loads((workspace/"design.json").read_text())\n'
            ' return {"lineage":landing["lineage"],"fonts":{"heading":"inter","body":"inter"},'
            '"artifacts":{"pagina":page,"diseno":{**design,"_pilotReviewEvidence":{"validation":"local-reference-integrity-only"}}},'
            '"review":{"score":0,"passed":False,"criteria":[],"observations":["Generated review is unavailable."],"rounds":0,"visualSkipped":True}}\n')
        spec = __import__('importlib.util', fromlist=['spec_from_file_location']).spec_from_file_location('synthetic_root_mapper', path)
        module_mapper = __import__('importlib.util', fromlist=['module_from_spec']).module_from_spec(spec)
        spec.loader.exec_module(module_mapper)
        return module_mapper.build(self.workspace, {'lineage': self.inputs.landing['data']['lineage']})

    def original_result(self):
        recorder = self.recorder()
        recorder.stage(self.ctx, self.ctx['session_id'], self.text)
        self.complete()
        self.assertEqual(recorder.reconcile(), 1)
        return recorder

    def observe(self, data, **kwargs):
        return module.observe_landing_admission(*data, self.workspace, root=self.root, client=self.client,
            trigger=types.SimpleNamespace(request=lambda *args: True), **kwargs)

    def test_admission_correlates_actual_cli_dtos_and_server_finalized_files(self):
        self.original_result()
        data = self.admission_data(normalized=True)
        before = self.database.read_bytes()
        response = self.observe(data)
        self.assertEqual(response, {'accepted': True, 'pending': False})
        self.assertEqual(self.database.read_bytes(), before)
        self.assertEqual(len(self.sources), 2)
        self.assertEqual(self.sources[0]['source_id'], self.sources[1]['source_id'])
        self.assertNotEqual(self.sources[0]['source_version'], self.sources[1]['source_version'])
        self.assertIn('saleads-landing-version:' + data[1]['landingId'] + '/1@sha256:' + data[1]['artifactDigest'], self.sources[1]['refs'])
        self.assertTrue(any(ref.startswith('saleads-landing-file:') for ref in self.sources[1]['refs']))
        self.assertTrue(any(ref.startswith('saleads-landing-artifact:') for ref in self.sources[1]['refs']))
        self.assertNotIn(data[3]['files']['index.html']['content'], self.sources[1]['content'])
        self.assertTrue(all(event['source_kind'] == 'specialist_result' and event['author']['kind'] == 'specialist' for event in self.sources))

    def test_real_validate_hash_chain_allows_finalized_copy_and_root_generated_metadata(self):
        self.original_result()
        data = self.admission_data(normalized=True)
        data[0]['metadata'] = self.projected_metadata()
        data[1]['review'] = data[3]['review'] = data[0]['metadata']['review']
        data[3]['artifacts'] = data[0]['metadata']['artifacts']
        validation = {'files': data[3]['files'], 'artifactDigest': data[1]['artifactDigest'],
                      'publishable': True, 'blocks': [], 'warnings': [], 'testimonials': []}
        self.assertEqual(module.observe_landing_validation(data[0], validation, self.workspace, root=self.root),
                         {'accepted': True, 'pending': False})
        self.assertEqual(len(self.sources), 1)  # A validator ACK is not a stored-version Source ACK.
        for name, descriptor in validation['files'].items():
            (self.workspace / name).write_bytes(base64.b64decode(descriptor['content']))
        data[0]['files'] = copy.deepcopy(validation['files'])
        self.assertTrue(self.observe(data)['accepted'])
        event = self.sources[-1]
        self.assertIn('"finalized_before_submit":true', event['content'])
        self.assertIn('"generated_document_author":"root_projection"', event['content'])
        self.assertTrue(any(ref.startswith('managed-landing-metadata-sha256:') for ref in event['refs']))
        self.assertTrue(any(ref.startswith('saleads-landing-validation:') for ref in event['refs']))
        self.assertEqual(event['source_kind'], 'specialist_result')

    def test_changed_code_without_a_real_validation_seal_is_not_attributed_to_native_work(self):
        self.original_result()
        data = self.admission_data(normalized=True)
        for name, descriptor in data[3]['files'].items():
            (self.workspace / name).write_bytes(base64.b64decode(descriptor['content']))
        data[0]['files'] = copy.deepcopy(data[3]['files'])
        self.assertEqual(self.observe(data), {'accepted': False, 'pending': False})
        self.assertEqual(len(self.sources), 1)

    def test_admission_replay_ignores_mutable_landing_state_urls_and_timestamps(self):
        self.original_result()
        data = self.admission_data()
        self.assertTrue(self.observe(data)['accepted'])
        identity = self.sources[-1]['event_id']
        data[2].update(latestN=999, publishedN=6, status='published', updatedAt='2026-10-27T12:00:00Z',
                       review_url='https://app.example.test/other?token=untrusted-url')
        data[1]['createdAt'] = data[3]['createdAt'] = '2026-11-01T12:00:00Z'
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE tasks SET title='A later task title edit'")
        self.assertEqual(self.observe(data), {'accepted': True, 'pending': False})
        self.assertEqual(len(self.sources), 2)
        self.assertEqual(self.sources[-1]['event_id'], identity)

    def test_admission_requires_exactly_one_native_workspace_and_raw_hash_match(self):
        recorder = self.recorder()
        recorder.stage(self.ctx, self.ctx['session_id'], self.text)
        recorder.stage(self.ctx, self.ctx['session_id'], self.text + ' Another eligible output with identical files.')
        self.complete()
        self.assertEqual(recorder.reconcile(), 2)
        self.assertEqual(self.observe(self.admission_data()), {'accepted': False, 'pending': False})
        self.assertEqual(len(self.sources), 2)

    def test_admission_rejects_other_business_digest_and_unmatched_raw_input(self):
        self.original_result()
        for change in ('business', 'digest', 'raw'):
            data = list(self.admission_data())
            if change == 'business': data[1]['businessId'] = '22222222-2222-4222-8222-222222222222'
            if change == 'digest': data[1]['artifactDigest'] = '0' * 64
            if change == 'raw':
                raw = b'other valid bytes not generated by this native task'
                data[0]['files']['styles.css'] = {'encoding': 'base64', 'content': base64.b64encode(raw).decode(),
                    'sha256': sha256(raw).hexdigest(), 'byteLength': len(raw)}
            with self.subTest(change=change):
                self.assertEqual(self.observe(data), {'accepted': False, 'pending': False})
                self.assertEqual(len(self.sources), 1)

    def test_admission_corroborates_review_as_generated_document_without_human_proof(self):
        review = {'score': 8, 'passed': False, 'criteria': [], 'observations': ['Generated critique; conversion is not measured.'],
                  'rounds': 1, 'visualSkipped': True}
        self.inputs.files['review.json'] = json.dumps(review).encode()
        (self.workspace / 'review.json').write_bytes(self.inputs.files['review.json'])
        self.original_result()
        data = self.admission_data()
        data[0]['metadata']['review'] = data[1]['review'] = data[3]['review'] = review
        self.assertTrue(self.observe(data)['accepted'])
        event = self.sources[-1]
        self.assertTrue(any(ref.startswith('saleads-landing-review:') for ref in event['refs']))
        self.assertEqual((event['author']['kind'], event['source_kind']), ('specialist', 'specialist_result'))
        self.assertNotIn('"passed":true', event['content'])
        self.assertIn('generated critique is not owner testimony', event['content'])

    def test_admission_rejects_swapped_generated_documents_and_optional_native_selectors(self):
        self.original_result()
        for change in ('request_document', 'stored_document', 'native_selector'):
            data = list(copy.deepcopy(self.admission_data()))
            if change == 'request_document':
                data[0]['metadata']['artifacts']['pagina'] = {'objective': 'A document not written by this task.'}
                data[3]['artifacts']['pagina'] = data[0]['metadata']['artifacts']['pagina']
            if change == 'stored_document': data[3]['artifacts']['diseno'] = {'direction': 'A different stored design.'}
            if change == 'native_selector': data[0]['metadata']['taskId'] = 'another-native-task'
            with self.subTest(change=change):
                self.assertEqual(self.observe(data), {'accepted': False, 'pending': False})
                self.assertEqual(len(self.sources), 1)

    def test_admission_lost_source_ack_recovers_from_existing_pending_without_cli(self):
        self.original_result()
        def lose_ack(*args, **kwargs):
            self.request(*args, **kwargs)
            raise client_module.MemoryFailure('MEMORY_UNAVAILABLE')
        self.client = types.SimpleNamespace(request=lose_ack)
        self.assertEqual(self.observe(self.admission_data()), {'accepted': False, 'pending': True})
        canonical = self.sources[-1]['event_id']
        self.client = types.SimpleNamespace(request=self.request)
        recovered = self.recorder(bind=False)
        recovered.worker_workspace = {}
        self.assertEqual(recovered.reconcile(dispatch=False), 1)
        self.assertEqual(self.sources[-1]['event_id'], canonical)
        self.assertEqual(recovered.reconcile(dispatch=False), 0)

    def test_real_admission_checkpoint_resumes_from_read_only_data_without_raw_html_storage(self):
        self.original_result()
        data = self.admission_data(normalized=True)
        self.assertEqual(self.observe((data[0], data[1], None, None)), {'accepted': False, 'pending': True})
        recorder = self.recorder(bind=False)
        checkpoints = [path for path in recorder.pending.glob('*.json') if json.loads(path.read_text()).get('landing_cli_pending')]
        self.assertEqual(len(checkpoints), 1)
        saved = json.loads(checkpoints[0].read_text())
        self.assertIn('landing_cli_mac', saved)
        self.assertNotIn(data[0]['files']['index.html']['content'], checkpoints[0].read_text())
        self.assertNotIn('c' * 64, checkpoints[0].read_text())
        self.assertEqual(recorder.reconcile(dispatch=False), 0)  # Designer never makes commercial reads.
        # A prior helper extraction may have materialized normalized bytes later.
        (self.workspace / 'styles.css').write_text('later normalized content is not the original generated input')
        read_args = {'business_id': self.ctx['business_id'], 'landing_id': data[1]['landingId'], 'n': data[1]['n']}
        response = module.resume_landing_admission(read_args, data[2], data[3], root=self.root,
            client=self.client, trigger=types.SimpleNamespace(request=lambda *args: True))
        self.assertEqual(response, {'accepted': True, 'pending': False})
        self.assertEqual(len(self.sources), 2)
        self.assertEqual(self.sources[0]['source_id'], self.sources[1]['source_id'])

    def test_model_written_or_tampered_checkpoint_cannot_certify_api_refs(self):
        self.original_result()
        data = self.admission_data()
        self.assertTrue(self.observe((data[0], data[1], None, None))['pending'])
        recorder = self.recorder(bind=False)
        path = next(recorder.pending.glob('*.json'))
        saved = json.loads(path.read_text())
        saved['landing_cli_pending'] = False
        saved['source_native_title'] = 'A model-edited receipt is not an authenticated API observation.'
        path.write_text(json.dumps(saved))
        self.assertEqual(recorder.reconcile(dispatch=False), 0)
        response = module.resume_landing_admission(
            {'business_id': self.ctx['business_id'], 'landing_id': data[1]['landingId'], 'n': data[1]['n']},
            data[2], data[3], root=self.root, client=self.client, trigger=types.SimpleNamespace(request=lambda *args: True))
        self.assertEqual(response, {'accepted': False, 'pending': False})
        self.assertEqual(len(self.sources), 1)

    def test_unsigned_api_capture_cannot_downgrade_to_a_legacy_native_record(self):
        recorder = self.original_result()
        original = json.loads(next(recorder.registered.glob('*.json')).read_text())
        landing = sys.modules[memory_module.__package__ + '.landing_experience']
        forged = copy.deepcopy(original)
        forged['landing_capture'] = landing.LandingExperience.extract(self.ctx, self.ctx['session_id'], self.run,
            self.text, self.inputs).saved()
        for key in ('landing_admission_identity', 'landing_cli_mac', 'landing_native_source'):
            forged.pop(key, None)
        forged['registered_ids'] = []
        module._private_write(recorder.pending / ('a' * 64 + '.json'), forged)
        self.assertEqual(recorder.reconcile(dispatch=False), 0)
        self.assertEqual(len(self.sources), 1)

    def test_unsigned_historical_native_record_is_preserved_without_api_backfill(self):
        recorder = self.original_result()
        path = next(recorder.registered.glob('*.json'))
        legacy = json.loads(path.read_text())
        legacy.pop('landing_native_source', None)
        legacy.pop('landing_cli_mac', None)
        path.write_text(json.dumps(legacy))
        before = path.read_bytes()
        self.assertEqual(self.observe(self.admission_data()), {'accepted': False, 'pending': False})
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(len(self.sources), 1)

    def test_historical_replay_or_conflicting_api_creation_time_is_not_this_native_result(self):
        self.original_result()
        for kind in ('historical', 'conflicting'):
            data = list(self.admission_data())
            data[1]['createdAt'] = '2026-10-28T12:00:00Z'
            if kind == 'historical': data[3]['createdAt'] = data[1]['createdAt']
            with self.subTest(kind=kind):
                self.assertEqual(self.observe(data), {'accepted': False, 'pending': False})
                self.assertEqual(len(self.sources), 1)

    def test_native_workspace_is_frozen_before_model_and_requires_terminal_readback(self):
        recorder = self.recorder()
        self.env['HERMES_KANBAN_WORKSPACE'] = '/later/model/chosen/path'
        self.assertTrue(recorder.stage(self.ctx, self.ctx['session_id'], self.text))
        self.assertEqual(recorder.reconcile(), 0)
        self.complete()
        before = self.database.read_bytes()
        self.assertEqual(recorder.reconcile(), 1)
        self.assertEqual(self.database.read_bytes(), before)
        self.assertTrue(any(ref.startswith('native-landing-artifact:') for ref in self.sources[0]['refs']))
        self.assertFalse(any(ref.startswith('saleads-landing-version:') for ref in self.sources[0]['refs']))
        self.assertNotIn('/untrusted/model/path', self.sources[0]['content'])
        self.assertNotIn('synthetic-native-claim', next(recorder.registered.glob('*.json')).read_text())
        self.assertTrue(all(read_only for _, read_only in self.state_reads))
        self.assertEqual(recorder.reconcile(), 0)

    def test_lost_ack_replay_preserves_source_identity_and_native_hash_snapshot(self):
        recorder = self.recorder()
        recorder.stage(self.ctx, self.ctx['session_id'], self.text)
        self.complete()
        lose = True
        def unreliable(*args, **kwargs):
            nonlocal lose
            accepted = self.request(*args, **kwargs)
            if lose:
                lose = False
                raise client_module.MemoryFailure('MEMORY_UNAVAILABLE')
            return accepted
        recorder.client = types.SimpleNamespace(request=unreliable)
        self.assertEqual(recorder.reconcile(), 0)
        (self.workspace / 'styles.css').write_text('later change after an accepted source ACK was lost')
        # Recovery has no worker env; original snapshot is durable in the existing pending record.
        recovered = self.recorder(bind=False)
        recovered.worker_workspace = {}
        self.assertEqual(recovered.reconcile(), 1)
        self.assertEqual([event['event_id'] for event in self.sources], [self.sources[0]['event_id']] * 2)

    def test_named_board_exact_native_layout_reconciles_from_saved_pin_without_worker_env(self):
        named = self.root / 'kanban/boards/landing-pilot-fixture/kanban.db'
        named.parent.mkdir(parents=True)
        self.database.replace(named)
        self.database = named
        decoy = self.root / 'kanban.db'
        decoy.write_bytes(b'unrelated default-board fixture; never read as SQLite')
        self.env['HERMES_KANBAN_DB'] = str(named)
        recorder = self.recorder()
        recorder.stage(self.ctx, self.ctx['session_id'], self.text)
        pending = json.loads(next(recorder.pending.glob('*.json')).read_text())
        self.assertEqual(pending['worker_binding']['kanban_db'], str(named))
        self.complete()
        before, decoy_before = named.read_bytes(), decoy.read_bytes()
        recovered = self.recorder(bind=False)
        recovered.worker_workspace = {}  # Independent no-agent recovery is not that worker.
        self.assertEqual(recovered.reconcile(dispatch=False), 1)
        self.assertEqual(named.read_bytes(), before)
        self.assertEqual(decoy.read_bytes(), decoy_before)
        self.assertTrue(self.event_databases)
        self.assertEqual(set(self.event_databases), {named})
        self.assertIn('hermes-kanban-board:landing-pilot-fixture', self.sources[0]['refs'])
        self.assertTrue(any(ref.startswith('native-landing-artifact:') for ref in self.sources[0]['refs']))
        self.assertEqual(recovered.reconcile(dispatch=False), 0)

    def test_invalid_or_symlink_database_pins_never_fall_back_to_a_valid_root_board(self):
        boards = self.root / 'kanban/boards'
        boards.mkdir(parents=True)
        linked_file = boards / 'linked-file/kanban.db'
        linked_file.parent.mkdir()
        linked_file.symlink_to(self.database)
        linked_dir = boards / 'linked-dir'
        linked_dir.symlink_to(self.root, target_is_directory=True)
        custom = self.root / 'custom.db'
        custom.write_bytes(self.database.read_bytes())
        bad_pins = [None, 'kanban.db', str(self.root.parent / 'outside.db'), str(custom),
                    str(boards / 'missing/kanban.db'), str(boards / 'WrongSlug/kanban.db'),
                    str(linked_file), str(linked_dir / 'kanban.db'), str(boards) + '/../kanban.db']
        for pin in bad_pins:
            with self.subTest(pin=pin):
                self.env['HERMES_KANBAN_DB'] = pin
                recorder = self.recorder(bind=False)
                self.assertFalse(recorder.bind(self.ctx, self.ctx['session_id']))
                self.assertEqual(recorder.worker_bindings, [])
        self.assertEqual(self.sources, [])

    def test_same_task_and_run_ids_on_two_boards_are_distinct_source_episodes(self):
        refs = []
        for board in ('default', 'landing-pilot-fixture'):
            run = {**self.run, 'native_board': board}
            refs.append(next(module.events_for(self.home, self.ctx, self.ctx['session_id'], self.text, run)))
        self.assertNotEqual(refs[0]['source_id'], refs[1]['source_id'])
        self.assertNotEqual(refs[0]['event_id'], refs[1]['event_id'])

    def test_saved_pin_is_revalidated_after_a_database_becomes_a_symlink(self):
        recorder = self.recorder()
        recorder.stage(self.ctx, self.ctx['session_id'], self.text)
        self.complete()
        moved = self.root / 'moved-native.db'
        self.database.replace(moved)
        self.database.symlink_to(moved)
        self.assertEqual(recorder.reconcile(), 0)
        self.assertEqual(self.sources, [])

    def test_unbound_session_or_fake_completed_status_never_registers(self):
        recorder = self.recorder(bind=False)
        self.session_source = 'api_server'
        self.assertFalse(recorder.bind(self.ctx, self.ctx['session_id']))
        recorder.stage(self.ctx, self.ctx['session_id'], self.text)
        self.complete()
        self.assertEqual(recorder.reconcile(), 0)
        with sqlite3.connect(self.database) as db:
            db.execute('UPDATE task_runs SET metadata=?,status=?', (json.dumps({'worker_session_id': self.ctx['session_id']}), 'completed'))
        self.assertEqual(recorder.reconcile(), 0)
        self.assertEqual(self.sources, [])

    def test_pre_hook_binds_native_session_claim_and_spawn_before_output(self):
        recorder = self.recorder(bind=False)
        plugin = memory_module.MemoryPlugin(types.SimpleNamespace(current_cron_execution=lambda: None),
            home=self.home, resolver=lambda **kwargs: self.ctx, specialists=recorder,
            sources=types.SimpleNamespace(record=lambda *args, **kwargs: None, current=lambda ctx: []),
            client=types.SimpleNamespace(request=lambda ctx, *args, **kwargs: pack(ctx)))
        plugin.retain_native_stores = lambda: None
        plugin.pre(session_id=self.ctx['session_id'], turn_id='synthetic-turn', user_message='[kanban] Native work')
        self.assertEqual(len(recorder.worker_bindings), 1)
        self.complete()
        plugin.post(session_id=self.ctx['session_id'], turn_id='synthetic-turn', assistant_response=self.text)
        self.assertEqual(len(self.sources), 1)

    def test_wrong_claim_spawn_profile_or_native_env_cannot_bind(self):
        for condition in ('claim', 'spawn', 'profile', 'env'):
            with self.subTest(condition=condition):
                recorder = self.recorder(bind=False)
                if condition == 'claim': recorder.worker_workspace['HERMES_KANBAN_CLAIM_LOCK'] = 'false-claim'
                if condition == 'spawn': self.events[1].payload['pid'] = 99
                if condition == 'profile': self.profile_stamp = 'estratega'
                if condition == 'env': recorder.worker_workspace['HERMES_KANBAN_RUN_ID'] = '99'
                self.assertFalse(recorder.bind(self.ctx, self.ctx['session_id']))
                self.assertEqual(recorder.worker_bindings, [])
                self.events[1].payload['pid'], self.profile_stamp = 4242, 'disenador_landings'

    def test_newer_run_workspace_change_or_modified_file_cannot_enrich_old_output(self):
        for condition in ('newer_run', 'root_changed', 'file_changed', 'scratch_removed', 'missing_environment'):
            with self.subTest(condition=condition):
                with sqlite3.connect(self.database) as db:
                    db.execute("UPDATE tasks SET status='running',current_run_id=7")
                    db.execute("UPDATE task_runs SET status='running',outcome=NULL,ended_at=NULL,worker_pid=4242 WHERE id=7")
                recorder = self.recorder(bind=condition != 'missing_environment')
                if condition == 'missing_environment':
                    recorder.worker_workspace = {}
                recorder.stage(self.ctx, self.ctx['session_id'], self.text + condition)
                self.complete()
                original_css = (self.workspace / 'styles.css').read_bytes()
                with sqlite3.connect(self.database) as db:
                    if condition == 'newer_run':
                        db.execute('INSERT INTO task_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)', (8, self.ctx['native_task_id'], 'disenador_landings', 'done', 'completed', 1793100110, 1793100200, '{}', None, 'synthetic-other-claim', None))
                    if condition == 'root_changed':
                        db.execute('UPDATE tasks SET workspace_path=?', (str(self.root / 'other-workspace'),))
                if condition == 'file_changed':
                    (self.workspace / 'styles.css').write_text('mutated after staging')
                if condition == 'scratch_removed':
                    self.workspace.rename(self.root / 'removed-workspace')
                before = len(self.sources)
                expected = 0 if condition in {'newer_run', 'root_changed', 'missing_environment'} else 1
                self.assertEqual(recorder.reconcile(), expected)
                if expected:
                    self.assertFalse(any(ref.startswith('native-landing-artifact:') for ref in self.sources[-1]['refs']))
                else:
                    self.assertEqual(len(self.sources), before)
                if condition == 'scratch_removed':
                    (self.root / 'removed-workspace').rename(self.workspace)
                (self.workspace / 'styles.css').write_bytes(original_css)
                with sqlite3.connect(self.database) as db:
                    db.execute('DELETE FROM task_runs WHERE id=8')
                    db.execute('UPDATE tasks SET workspace_path=?', (str(self.workspace),))
                for pending in recorder.pending.glob('*.json'):
                    pending.unlink()

    def test_native_collector_receipt_values_cannot_replace_the_authenticated_root_cli_hook(self):
        from dataclasses import replace
        landing = sys.modules[memory_module.__package__ + '.landing_experience']
        def collector(ctx, session, run):
            native = landing.collect_native(ctx, session, run)
            return replace(self.inputs, files=native.files)
        recorder = self.recorder(landing_collector=collector)
        recorder.stage(self.ctx, self.ctx['session_id'], self.text)
        self.complete()
        self.assertEqual(recorder.reconcile(), 1)
        self.assertFalse(any(ref.startswith('saleads-landing-version:') for ref in self.sources[0]['refs']))
        self.inputs.admission['data']['artifactDigest'] = '0' * 64
        recorder.stage(self.ctx, self.ctx['session_id'], self.text + ' A forged validated claim.')
        self.assertEqual(recorder.reconcile(), 1)
        self.assertFalse(any(ref.startswith('saleads-landing-version:') for ref in self.sources[-1]['refs']))


class TriggerTests(unittest.TestCase):
    def test_fixed_process_argv_and_root_home_without_worker_binding_or_external_agent(self):
        process = types.SimpleNamespace(wait=lambda: 0)
        with patch.object(dispatch_module.subprocess, 'Popen', return_value=process) as popen, patch.dict(os.environ, {'HERMES_HOME': '/opt/data/profiles/investigador', 'HERMES_TENANT': 'foreign', 'HERMES_KANBAN_TASK': 'worker', 'HERMES_KANBAN_DB': '/unexpected/board.db', 'HERMES_PROFILE': 'investigador'}):
            self.assertTrue(dispatch_module.launch_dispatcher())
        argv = popen.call_args.args[0]
        self.assertEqual(argv[1:], ['/opt/data/saleads/runtime/curation-dispatcher.py', '--data-dir', '/opt/data'])
        env = popen.call_args.kwargs['env']
        self.assertEqual(env['HERMES_HOME'], '/opt/data')
        self.assertEqual(env['HERMES_KANBAN_HOME'], '/opt/data')
        self.assertNotIn('HERMES_TENANT', env); self.assertNotIn('HERMES_KANBAN_TASK', env); self.assertNotIn('HERMES_KANBAN_DB', env)
        self.assertNotIn('shell', popen.call_args.kwargs)

    def test_coalescing_records_only_spawn_request_not_completed_value(self):
        with tempfile.TemporaryDirectory() as home:
            calls = []
            trigger = dispatch_module.CurationTrigger(home, launch=lambda: calls.append(True) or True)
            self.assertTrue(trigger.request(context(), ['source-1']))
            self.assertFalse(trigger.request(context(), ['source-1']))
            self.assertFalse(trigger.request(context(), []))
            self.assertEqual(calls, [True])
            receipt = list((Path(home) / 'plugin-data/saleads-memory/dispatch-receipts').glob('*.json'))[0]
            self.assertEqual(json.loads(receipt.read_text())['spawn_requested'], True)
            self.assertNotIn('completed', receipt.read_text())
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
