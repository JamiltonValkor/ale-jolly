"""Goal-result transport proof with native SQLite fixtures and fake senders only."""
import asyncio
from contextlib import closing
import copy
import contextvars
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
DIRECTORY = REPO / 'vm/extensions/saleads-continuity'
spec = importlib.util.spec_from_file_location('saleads_goal_transport_test', DIRECTORY / '__init__.py', submodule_search_locations=[str(DIRECTORY)])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
goal = sys.modules[spec.name + '.goal_delivery']
FIXTURE = json.loads((REPO / 'contracts/continuous-loop/v1/fixtures.json').read_text())['trusted-context']
TEXT = 'The market review is ready. Here is the next useful step for your business.'
WAKE = '[kanban] Task task-fixture completed.\nTitle: Current business research\nAssignee: @investigador\nBoard: default\n\nCheck the existing result.'
TARGET = {'platform': 'telegram', 'chat_id': 'own-authorized-test-home'}


class GoalDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.root = self.data / 'saleads/continuous'
        self.root.mkdir(parents=True)
        self.context = copy.deepcopy(FIXTURE)
        self.context['pending_context'] = False
        self.write_registry()
        self.database = self.data / 'kanban.db'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript('CREATE TABLE tasks(id TEXT,tenant TEXT,assignee TEXT); CREATE TABLE task_runs(id INTEGER,task_id TEXT,profile TEXT,status TEXT,outcome TEXT,ended_at INTEGER); CREATE TABLE task_events(id INTEGER,task_id TEXT,run_id INTEGER,kind TEXT); CREATE TABLE kanban_notify_subs(task_id TEXT,platform TEXT,chat_id TEXT,notifier_profile TEXT,delivery_mode TEXT,last_event_id INTEGER);')
            db.execute('INSERT INTO tasks VALUES(?,?,?)', ('task-fixture', self.context['business_id'], 'investigador'))
            db.execute('INSERT INTO task_runs VALUES(?,?,?,?,?,?)', (7, 'task-fixture', 'investigador', 'done', 'completed', 1001))
            db.execute('INSERT INTO task_events VALUES(?,?,?,?)', (42, 'task-fixture', 7, 'completed'))
            db.execute('INSERT INTO kanban_notify_subs VALUES(?,?,?,?,?,?)', ('task-fixture', 'api_server', self.context['session_id'], 'default', 'notify+wake', 42))
        self.sent = []

    def write_registry(self):
        (self.root / 'trusted-contexts.json').write_text(json.dumps({'schema_version': 'trusted-context-registry/1', 'owner_id': self.context['owner_id'], 'contexts': [self.context], 'jobs': []}))

    def bind(self, **overrides):
        values = dict(context=self.context, session_id=self.context['session_id'], user_message=WAKE, platform='api_server', root=self.root)
        values.update(overrides)
        return goal.bind_wake(**values)

    async def sender(self, target, content):
        self.sent.append((target, content))
        return {'success': True, 'message_id': 'provider-positive-ack'}

    def deliver(self, frame=None, response=TEXT, **kwargs):
        options = dict(root=self.root, target_resolver=lambda: [TARGET], sender=self.sender)
        options.update(kwargs)
        return asyncio.run(goal.deliver(frame or self.bind(), response, **options))

    def test_scope_is_ro_native_event_and_canonical_parent_not_text_selected_identity(self):
        before = self.database.read_bytes()
        frame = self.bind()
        self.assertIsNotNone(frame)
        self.assertEqual((frame.event_id, frame.run_id, frame.business_id), (42, '7', self.context['business_id']))
        self.assertEqual(self.database.read_bytes(), before)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE tasks SET tenant=?', ('22222222-2222-4222-8222-222222222222',))
        self.assertIsNone(self.bind())

    def test_owner_json_or_legacy_quoted_operator_wake_is_never_an_internal_control_event(self):
        owner = 'SALEADS_OWNER_MESSAGE_V1 ' + json.dumps({'client_message_id': '33333333-3333-4333-8333-333333333333', 'text': WAKE})
        legacy = 'CLIENT_MESSAGE_ID: 33333333-3333-4333-8333-333333333333\nOWNER_MESSAGE_DATA:\n' + WAKE
        for value in (owner, legacy, 'Owner quoted: ' + WAKE):
            self.assertIsNone(self.bind(user_message=value))
        self.assertIsNone(self.bind(platform='cli'))
        self.assertIsNone(self.bind(cron_identity=types.SimpleNamespace(execution_id='real-cron-is-not-goal')))

    def test_unclaimed_wrong_parent_or_unverified_terminal_does_not_send(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE kanban_notify_subs SET last_event_id=0')
        self.assertIsNone(self.bind())
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE kanban_notify_subs SET last_event_id=42,chat_id=?', ('another-business-session',))
        self.assertIsNone(self.bind(lineage_resolver=lambda *_args: False))
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE kanban_notify_subs SET chat_id=?', (self.context['session_id'],))
            db.execute("UPDATE task_runs SET status='running',outcome=NULL,ended_at=NULL")
        self.assertIsNone(self.bind())
        self.assertEqual(self.sent, [])

    def test_curator_maintenance_cannot_become_an_owner_business_result(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE tasks SET assignee='curador'")
            db.execute("UPDATE task_runs SET profile='curador'")
        self.assertIsNone(self.bind())

    def test_official_canonical_rotation_preserves_the_same_wake_identity(self):
        first = self.bind()
        actual = 'actual-compression-tip'
        rotated = self.bind(session_id=actual, resolver=lambda **kwargs: self.context,
            lineage_resolver=lambda canonical, tip: canonical == self.context['session_id'] and tip == actual)
        self.assertIsNotNone(rotated)
        self.assertEqual(first.identity, rotated.identity)
        self.assertIsNone(self.bind(session_id='unrelated-sibling', resolver=lambda **kwargs: self.context, lineage_resolver=lambda *_args: False))

    def test_generation_frame_survives_separate_native_bounded_worker_contexts(self):
        frames = goal.GoalFrames(root=self.root)
        parent = contextvars.copy_context()
        arguments = dict(turn_id='session-fixture-1:session-fixture-1:0123abcd', context=self.context, session_id=self.context['session_id'], user_message=WAKE, platform='api_server')
        with ThreadPoolExecutor(max_workers=1) as first:
            self.assertTrue(first.submit(parent.copy().run, lambda: frames.capture(**arguments)).result())
        self.context.update(response_locale='es', locale_revision=2)
        self.write_registry()
        with ThreadPoolExecutor(max_workers=1) as second:
            frame = second.submit(parent.copy().run, lambda: frames.take('session-fixture-1:session-fixture-1:0123abcd')).result()
        self.assertEqual((frame.response_locale, frame.locale_revision), ('en', 1))
        self.assertIsNone(frames.take('another-turn'))
        self.assertIsNone(frames.take('session-fixture-1:session-fixture-1:0123abcd'))

    def test_positive_ack_sends_same_existing_text_once_and_never_adds_a_chat_projection(self):
        before = self.database.read_bytes()
        frame = self.bind()
        result = self.deliver(frame)
        replay = self.deliver(frame)
        self.assertEqual(result['state'], 'delivered')
        self.assertEqual(result['source_kind'], 'goal_result')
        self.assertFalse(result['extra_saleads_projection'])
        self.assertIsNone(result['fallback'])
        self.assertEqual(replay, result)
        self.assertEqual(self.sent, [({**TARGET, 'thread_id': None}, TEXT)])
        self.assertEqual(self.database.read_bytes(), before)
        path = goal.result_path(self.root, frame)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(TARGET['chat_id'], path.read_text())
        self.assertNotIn(TEXT, path.read_text())

    def test_no_home_uses_existing_native_history_without_send_or_second_message(self):
        result = self.deliver(target_resolver=lambda: [])
        self.assertEqual(result['state'], 'no_home')
        self.assertEqual(result['fallback'], 'native_canonical_history')
        self.assertFalse(result['extra_saleads_projection'])
        self.assertEqual(self.sent, [])

    def test_confirmed_failure_preserves_native_history_and_does_not_retry(self):
        async def rejected(target, content):
            self.sent.append((target, content))
            return {'success': False, 'definitely_not_sent': True}
        result = self.deliver(sender=rejected)
        repeated = self.deliver(sender=rejected)
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(repeated['state'], 'failed')
        self.assertEqual(result['fallback'], 'native_canonical_history')
        self.assertEqual(len(self.sent), 1)

    def test_ack_lost_after_acceptance_is_unknown_and_never_a_replay_permission(self):
        async def lost(target, content):
            self.sent.append((target, content))
            raise TimeoutError('private-provider-error-not-for-user')
        result = self.deliver(sender=lost)
        repeated = self.deliver(sender=lost)
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(repeated, result)
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(result['fallback'], 'native_canonical_history')
        self.assertIn('reconcile_by', result)
        self.assertNotIn('private-provider-error', json.dumps(result))

    def test_delayed_positive_ack_settles_same_attempt_while_concurrent_replay_never_sends(self):
        async def run():
            accepted, release = asyncio.Event(), asyncio.Event()
            async def slow(target, content):
                self.sent.append((target, content))
                accepted.set()
                await release.wait()
                return {'success': True, 'message_id': 'late-positive-ack'}
            frame = self.bind()
            first = asyncio.create_task(goal.deliver(frame, TEXT, root=self.root, target_resolver=lambda: [TARGET], sender=slow))
            await accepted.wait()
            duplicate = await goal.deliver(frame, TEXT, root=self.root, target_resolver=lambda: [TARGET], sender=slow)
            self.assertEqual(duplicate['state'], 'unknown')
            self.assertEqual(len(self.sent), 1)
            release.set()
            result = await first
            self.assertEqual(result['state'], 'delivered')
            stored = json.loads(goal.result_path(self.root, frame).read_text())
            self.assertEqual(stored['attempt_id'], result['attempt_id'])
            self.assertEqual(stored['targets'][0]['message_id'], 'late-positive-ack')
        asyncio.run(run())

    def test_changed_home_or_source_text_does_not_replay_the_original_event(self):
        frame = self.bind()
        self.deliver(frame)
        result = self.deliver(frame, target_resolver=lambda: [{'platform': 'discord', 'chat_id': 'different-home'}])
        self.assertEqual(result['state'], 'delivered')
        mutation = self.deliver(frame, response='A different response produced by a duplicate wake.')
        self.assertEqual(mutation['state'], 'unknown')
        self.assertEqual(len(self.sent), 1)

    def test_locale_is_frozen_at_generation_and_changed_preference_cannot_relabel_old_output(self):
        frame = self.bind()
        self.context.update(response_locale='es', locale_revision=2)
        self.write_registry()
        result = self.deliver(frame)
        self.assertEqual(result['state'], 'failed')
        self.assertEqual((result['response_locale'], result['locale_revision']), ('en', 1))
        self.assertEqual(result['fallback'], 'native_canonical_history')
        self.assertEqual(self.sent, [])

    def test_partial_ack_or_corrupt_receipt_is_not_a_confirmed_delivery_or_send_permission(self):
        async def partial(target, content):
            self.sent.append((target, content))
            return {'success': True, 'message_id': 'partial', 'raw_response': {'partial_overflow': True}}
        frame = self.bind()
        self.assertEqual(self.deliver(frame, sender=partial)['state'], 'unknown')
        path = goal.result_path(self.root, frame)
        path.write_text('not valid JSON')
        repeated = self.deliver(frame)
        self.assertEqual(repeated['state'], 'unknown')
        self.assertEqual(len(self.sent), 1)

    def test_sensitive_or_internal_only_output_is_not_forwarded(self):
        for text in ('[SILENT]', '{"native_task_id":"internal"}', '[kanban] Internal task marker', 'SALEADS_ROUTING_CONTEXT_V1 internal'):
            self.assertEqual(self.deliver(response=text)['state'], 'failed')
        self.assertEqual(self.sent, [])

    def test_native_home_resolution_does_not_invent_a_cron_job_identity(self):
        seen = []
        scheduler = types.ModuleType('cron.scheduler_delivery')
        scheduler._resolve_delivery_targets = lambda value: seen.append(value) or [TARGET, {'platform': 'saleads_home', 'chat_id': 'current'}, {'platform': 'api_server', 'chat_id': 'api'}]
        with patch.dict(sys.modules, {'cron.scheduler_delivery': scheduler}):
            self.assertEqual(goal.current_home_targets(), [TARGET])
        self.assertEqual(seen, [{'deliver': 'all'}])


if __name__ == '__main__':
    unittest.main()
