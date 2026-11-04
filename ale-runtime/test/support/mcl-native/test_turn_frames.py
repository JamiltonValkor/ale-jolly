"""Cross-worker generation state, including the unmodified pinned native dispatch mixin.

Set MCL_HERMES_SOURCE to the pinned checkout for native mixin cases. The ordinary
stdlib cases always run and model the same separate copied worker contexts.
"""
from contextlib import contextmanager, closing
import ast
import asyncio
import inspect
import contextvars
from concurrent.futures import ThreadPoolExecutor
import copy
import importlib.util
import json
import os
import sqlite3
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
from typing import Any

REPO = Path(__file__).resolve().parents[3]
CONTINUITY = REPO / 'vm/extensions/saleads-continuity'
MEMORY = REPO / 'vm/extensions/saleads-memory'


def load(name, path, package=False):
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=[str(path.parent)] if package else None)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


entry = load('mcl_turn_frame_continuity', CONTINUITY / '__init__.py', True)
notifications = sys.modules[entry.__name__ + '.notifications']
frames_module = sys.modules[entry.__name__ + '.turn_frames']
memory_package = load('mcl_turn_frame_memory', MEMORY / '__init__.py', True)
memory_module = sys.modules[memory_package.__name__ + '.memory']
FRAMEWORK_EXECUTION = contextvars.ContextVar('native_test_execution', default=None)
FRAMEWORK_PROFILE = contextvars.ContextVar('native_test_profile', default=None)
SOURCE = os.environ.get('MCL_HERMES_SOURCE')


def trusted(business='11111111-1111-4111-8111-111111111111', session='owner-chat', locale='en'):
    return {'schema_version': 'trusted-context/1', 'owner_id': 'synthetic-owner', 'business_id': business,
        'session_id': session, 'actor_role': 'ale', 'native_task_id': None, 'native_run_id': None,
        'response_locale': locale, 'locale_revision': 1, 'capabilities': [], 'mandate_id': None, 'pending_context': False}


def copied(callback, **kwargs):
    context = contextvars.copy_context()
    with ThreadPoolExecutor(max_workers=1) as worker:
        return worker.submit(context.run, lambda: callback(**kwargs)).result()


@contextmanager
def native_manager(hooks):
    source = Path(SOURCE)
    sys.path.insert(0, str(source))
    origin = types.ModuleType('hermes_cli.plugins')
    origin._resolve_hook_callback_timeout = lambda: 30.0
    # Our callbacks in this fixture are synchronous; production bridge otherwise awaits async callbacks.
    bridge_tree = ast.parse((source / 'hermes_cli/plugins.py').read_text())
    bridge = next(node for node in bridge_tree.body if isinstance(node, ast.FunctionDef) and node.name == 'resolve_plugin_command_result')
    namespace = {'Any': Any, 'asyncio': asyncio, 'inspect': inspect, 'contextvars': contextvars, 'threading': threading}
    exec(compile(ast.Module(body=[bridge], type_ignores=[]), str(source / 'hermes_cli/plugins.py'), 'exec'), namespace)
    origin.resolve_plugin_command_result = namespace['resolve_plugin_command_result']
    with patch.dict(sys.modules, {'hermes_cli.plugins': origin}):
        module = load('mcl_actual_native_dispatch', source / 'hermes_cli/plugins_dispatch.py')
        class Manager(module.PluginDispatchMixin):
            def __init__(self):
                self._hooks = hooks
                self._hook_timeout_lock = threading.Lock()
                self._hook_timeout_suppressed_until = {}
                self._hook_running_callbacks = {}
                self._hook_abandoned = {}
                self._hook_failures_reported = set()
                self._hook_timeout_suppression_seconds = 60.0
        yield Manager()
    sys.path.remove(str(source))


class TurnFramesTests(unittest.TestCase):
    def test_real_native_turn_key_and_type_are_required_no_session_default(self):
        store = frames_module.TurnFrames()
        valid = 'owner-chat:owner-chat:0123abcd'
        self.assertTrue(store.record(valid, {'response_locale': 'en'}))
        for invalid in ('', None, {}, 'owner-chat', 'owner-chat:owner-chat:nothex', 'owner-chat:0123abcd'):
            self.assertFalse(store.record(invalid, {'response_locale': 'es'}))
        self.assertEqual(store.take(valid), {'response_locale': 'en'})
        self.assertIsNone(store.take(valid))

    def test_concurrent_turns_do_not_mix_and_source_values_are_frozen(self):
        store = frames_module.TurnFrames()
        first, second = trusted(), trusted('22222222-2222-4222-8222-222222222222', 'other-chat', 'fr')
        copied(store.record, turn_id='owner-chat:owner-chat:0123abcd', value=first)
        copied(store.record, turn_id='other-chat:other-chat:89abcdef', value=second)
        first.update(response_locale='es', locale_revision=2)
        self.assertEqual(copied(store.take, turn_id='other-chat:other-chat:89abcdef')['business_id'], second['business_id'])
        self.assertEqual(copied(store.take, turn_id='owner-chat:owner-chat:0123abcd')['response_locale'], 'en')

    def test_expiry_and_capacity_forget_only_bookkeeping_not_work_state(self):
        clock = [0.0]
        store = frames_module.TurnFrames(clock=lambda: clock[0], max_pending=1, ttl_seconds=86400)
        work = {'native_status': 'running'}
        store.record('s:t:0123abcd', work)
        store.record('s:t:89abcdef', work)
        self.assertIsNone(store.take('s:t:0123abcd'))
        clock[0] = 86401
        self.assertIsNone(store.take('s:t:89abcdef'))
        self.assertEqual(work['native_status'], 'running')

    def test_shared_source_mirror_is_byte_identical(self):
        self.assertEqual((CONTINUITY / 'turn_frames.py').read_bytes(), (MEMORY / 'turn_frames.py').read_bytes())


class CallbackFixtures:
    def cron(self, invoke):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hooks, profiles = {}, []
            def register_hook(name, callback): hooks.setdefault(name, []).append(callback)
            ctx = types.SimpleNamespace(register_hook=register_hook, register_platform=lambda **kwargs: None,
                current_cron_execution=lambda: FRAMEWORK_EXECUTION.get())
            first, second = trusted(), trusted('22222222-2222-4222-8222-222222222222', 'other-chat', 'pt-BR')
            values = {'job-one': first, 'job-two': second}
            def resolve(**kwargs):
                profiles.append(FRAMEWORK_PROFILE.get())
                return copy.deepcopy(values[kwargs['cron_identity'].job_id])
            def capture(value, identity, text, **_kwargs):
                return notifications.capture(value, identity, text, root=root, home_resolver=lambda _job: {'state': 'no_home', 'fingerprint': None})
            with patch.object(entry, 'resolve', resolve), patch.object(entry, 'capture', capture):
                entry.register(ctx)
                with invoke(hooks) as run:
                    FRAMEWORK_PROFILE.set('native-default-profile')
                    one = types.SimpleNamespace(job_id='job-one', execution_id='execution-one', profile='default')
                    two = types.SimpleNamespace(job_id='job-two', execution_id='execution-two', profile='default')
                    FRAMEWORK_EXECUTION.set(one)
                    run('pre_llm_call', session_id='native-cron-session-one', turn_id='native-one:native-one:0123abcd')
                    FRAMEWORK_EXECUTION.set(two)
                    run('pre_llm_call', session_id='native-cron-session-two', turn_id='native-two:native-two:89abcdef')
                    first.update(response_locale='es', locale_revision=9)
                    FRAMEWORK_EXECUTION.set(two)
                    run('post_llm_call', session_id='native-cron-session-two', turn_id='native-two:native-two:89abcdef', assistant_response='Resultados prontos com fontes verificadas.')
                    FRAMEWORK_EXECUTION.set(one)
                    run('post_llm_call', session_id='native-cron-compression-tip', turn_id='native-one:native-one:0123abcd', assistant_response='A useful result with verified sources.')
            receipts = [json.loads(path.read_text()) for path in (root / 'receipts').glob('*.json')]
            by_execution = {value['execution_id']: value for value in receipts}
            self.assertEqual(len(receipts), 2)
            self.assertEqual(by_execution['execution-one']['response_locale'], 'en')
            self.assertEqual(by_execution['execution-one']['session_id'], 'owner-chat')
            self.assertEqual(by_execution['execution-two']['business_id'], second['business_id'])
            self.assertEqual(set(profiles), {'native-default-profile'})

    def owner(self, invoke):
        with tempfile.TemporaryDirectory() as directory:
            FRAMEWORK_EXECUTION.set(None)
            one, two = trusted(), trusted('22222222-2222-4222-8222-222222222222', 'other-chat', 'fr')
            values = {'owner-chat': one, 'owner-compression-tip': one, 'other-chat': two}
            sent = []
            def request(context, path, payload, **kwargs):
                data = {'goal': None, 'knowledge': [], 'experiences': [], 'pending': []}
                return {'schema_version': 'context-pack/1', 'pack_id': 'synthetic-pack', 'owner_id': context['owner_id'], 'business_id': context['business_id'], 'actor_role': 'ale', **data, 'text': json.dumps(data), 'truncated': False}
            runtime = types.SimpleNamespace(current_cron_execution=lambda: FRAMEWORK_EXECUTION.get())
            sources = types.SimpleNamespace(record=lambda *args, **kwargs: None,
                current=lambda context: ['source-' + context['business_id']])
            plugin = memory_module.MemoryPlugin(runtime, home=Path(directory) / 'ale',
                client=types.SimpleNamespace(request=request), resolver=lambda **kwargs: copy.deepcopy(values[kwargs['session_id']]), sources=sources,
                specialists=types.SimpleNamespace(reconcile=lambda: 0), trigger=types.SimpleNamespace(request=lambda context, ids: sent.append((context, ids))))
            hooks = {'pre_llm_call': [plugin.pre], 'post_llm_call': [plugin.post]}
            with invoke(hooks) as run:
                run('pre_llm_call', session_id='owner-chat', turn_id='owner-chat:owner-chat:0123abcd', user_message='An authentic answer from the current owner.')
                run('pre_llm_call', session_id='other-chat', turn_id='other-chat:other-chat:89abcdef', user_message='A separate business answer.')
                one.update(response_locale='es', locale_revision=3)
                run('post_llm_call', session_id='other-chat', turn_id='other-chat:other-chat:89abcdef', assistant_response='Une réponse utile.')
                run('post_llm_call', session_id='owner-compression-tip', turn_id='owner-chat:owner-chat:0123abcd', assistant_response='A useful response.')
            self.assertEqual(len(sent), 2)
            self.assertEqual(sent[0][0]['business_id'], two['business_id'])
            self.assertEqual(sent[1][0]['business_id'], one['business_id'])
            self.assertEqual(sent[1][0]['response_locale'], 'en')
            self.assertEqual(sent[1][1], ['source-' + one['business_id']])

    def goal_home(self, invoke):
        for has_home in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                data = Path(directory)
                root = data / 'saleads/continuous'
                root.mkdir(parents=True)
                value = trusted()
                (root / 'trusted-contexts.json').write_text(json.dumps({'schema_version': 'trusted-context-registry/1', 'owner_id': value['owner_id'], 'contexts': [value], 'jobs': []}))
                with closing(sqlite3.connect(data / 'kanban.db')) as db, db:
                    db.executescript('CREATE TABLE tasks(id TEXT,tenant TEXT,assignee TEXT); CREATE TABLE task_runs(id INTEGER,task_id TEXT,profile TEXT,status TEXT,outcome TEXT,ended_at INTEGER); CREATE TABLE task_events(id INTEGER,task_id TEXT,run_id INTEGER,kind TEXT); CREATE TABLE kanban_notify_subs(task_id TEXT,platform TEXT,chat_id TEXT,notifier_profile TEXT,delivery_mode TEXT,last_event_id INTEGER);')
                    db.execute('INSERT INTO tasks VALUES(?,?,?)', ('task-one', value['business_id'], 'investigador'))
                    db.execute('INSERT INTO task_runs VALUES(?,?,?,?,?,?)', (7, 'task-one', 'investigador', 'done', 'completed', 1001))
                    db.execute('INSERT INTO task_events VALUES(?,?,?,?)', (42, 'task-one', 7, 'completed'))
                    db.execute('INSERT INTO kanban_notify_subs VALUES(?,?,?,?,?,?)', ('task-one', 'api_server', value['session_id'], 'default', 'notify+wake', 42))
                hooks, sent = {}, []
                runtime = types.SimpleNamespace(register_hook=lambda name, callback: hooks.setdefault(name, []).append(callback), register_platform=lambda **kwargs: None, current_cron_execution=lambda: FRAMEWORK_EXECUTION.get())
                FRAMEWORK_EXECUTION.set(None)
                FRAMEWORK_PROFILE.set('native-default-profile')
                original = entry.deliver_goal_result
                async def sender(target, text):
                    await asyncio.sleep(0)
                    sent.append((target, text, FRAMEWORK_PROFILE.get()))
                    return {'success': True, 'message_id': 'positive-provider-ack'}
                async def deliver(frame, text, **kwargs):
                    return await original(frame, text, root=root,
                        target_resolver=lambda: [{'platform': 'telegram', 'chat_id': 'authorized-own-home'}] if has_home else [], sender=sender)
                with patch.object(entry, 'deliver_goal_result', deliver):
                    entry.register(runtime, root=root)
                    with invoke(hooks) as run:
                        run('pre_llm_call', turn_id='owner-chat:owner-chat:0123abcd', session_id=value['session_id'], platform='api_server', user_message='[kanban] Task task-one completed.\nTitle: Read actual business data\n')
                        result = run('post_llm_call', turn_id='owner-chat:owner-chat:0123abcd', session_id=value['session_id'], assistant_response='A useful final result in the configured user language.')
                self.assertEqual(result[0]['state'], 'delivered' if has_home else 'no_home')
                self.assertFalse(result[0]['extra_saleads_projection'])
                self.assertEqual(len(sent), 1 if has_home else 0)
                if has_home:
                    self.assertEqual(sent[0][2], 'native-default-profile')
                records = list((root / 'goal-delivery-receipts').glob('*.json'))
                self.assertEqual(len(records), 1)


@contextmanager
def separate_workers(hooks):
    def run(name, **kwargs):
        return [copied(callback, **kwargs) for callback in hooks[name]]
    yield run


class CopiedWorkerIntegrationTests(unittest.TestCase, CallbackFixtures):
    def test_cron_source_capture_is_frozen_and_separated_across_real_worker_threads(self): self.cron(separate_workers)
    def test_owner_post_dispatch_survives_worker_copy_and_compaction(self): self.owner(separate_workers)


@unittest.skipUnless(SOURCE and (Path(SOURCE) / 'hermes_cli/plugins_dispatch.py').is_file(), 'Set MCL_HERMES_SOURCE for the exact pinned native mixin')
class ActualNativeDispatchTests(unittest.TestCase, CallbackFixtures):
    @contextmanager
    def dispatch(self, hooks):
        with native_manager(hooks) as manager:
            yield manager.invoke_hook
    def test_unmodified_native_30s_bounded_manager_captures_actual_cron_profile_scope(self): self.cron(self.dispatch)
    def test_unmodified_native_30s_bounded_manager_dispatches_owner_curator_sources(self): self.owner(self.dispatch)
    def test_unmodified_native_manager_awaits_goal_home_async_result_and_native_history_fallback(self): self.goal_home(self.dispatch)


if __name__ == '__main__':
    unittest.main()
