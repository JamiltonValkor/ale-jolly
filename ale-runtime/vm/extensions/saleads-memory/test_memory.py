"""Native memory transport tests: stdlib only, synthetic data, no model/cloud/Docker."""
import copy
from base64 import urlsafe_b64decode
from hashlib import sha256
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('saleads_memory_test_plugin', ROOT / '__init__.py', submodule_search_locations=[str(ROOT)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
client_module = sys.modules[spec.name + '.client']
memory_module = sys.modules[spec.name + '.memory']
schemas = sys.modules[spec.name + '.schemas']
FIXTURES = json.loads((ROOT.parents[2] / 'contracts/continuous-loop/v1/fixtures.json').read_text())


def context(role='ale', **overrides):
    value = copy.deepcopy(FIXTURES['trusted-context'])
    value.update(actor_role=role, pending_context=False)
    if role != 'ale':
        value.update(native_task_id='task-curation-fixture', native_run_id='run-curation-fixture')
    value.update(overrides)
    return value


def pack(ctx, **overrides):
    value = copy.deepcopy(FIXTURES['context-pack'])
    value.update(owner_id=ctx['owner_id'], business_id=ctx['business_id'], actor_role=ctx['actor_role'])
    value.update(overrides)
    value['text'] = json.dumps({key: value[key] for key in ('goal', 'knowledge', 'experiences', 'pending')}, ensure_ascii=False, separators=(',', ':'))
    return value


def batch_page(ctx):
    batch = copy.deepcopy(FIXTURES['curation-batch'])
    batch.update(owner_id=ctx['owner_id'], business_id=ctx['business_id'],
                 native_task_id=ctx['native_task_id'], native_run_id=ctx['native_run_id'])
    source = copy.deepcopy(FIXTURES['source-event'])
    document = client_module.canonical({'batch': batch, 'sources': [source]})
    return {'schema_version': 'curation-read-page/1',
            'binding': {key: batch[key] for key in ('owner_id', 'business_id', 'batch_id', 'native_task_id', 'native_run_id')},
            'payload_sha256': sha256(document.encode()).hexdigest(), 'offset': 0, 'total_chars': len(document),
            'fragment': document, 'next_cursor': None}


def token_file(home, role='ale'):
    path = home / 'plugin-data/saleads-memory/auth-token'
    path.parent.mkdir(parents=True, exist_ok=True)
    token = hmac.new(b'synthetic-master-never-installed', ('mcl-profile:' + role).encode(), sha256).hexdigest()
    path.write_text(token)
    path.chmod(0o600)
    return token


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name) / 'ale'
        self.token = token_file(self.home)
        self.native = context()
        self.calls = []
        self.cron = None
        self.ctx = types.SimpleNamespace(current_cron_execution=lambda: self.cron)

    def instance(self, role='ale', response=None, resolver=None):
        home = self.home if role == 'ale' else Path(self.directory.name) / role
        if role != 'ale':
            token_file(home, role)
        bound = self.native if role == 'ale' else context(role)
        def request(trusted, path, payload, **kwargs):
            self.calls.append((copy.deepcopy(trusted), path, copy.deepcopy(payload), kwargs))
            return response if response is not None else pack(trusted)
        transport = types.SimpleNamespace(request=request)
        self.client = transport
        return memory_module.MemoryPlugin(self.ctx, home=home, client=transport, resolver=resolver or (lambda **_kwargs: bound))

    def test_native_registration_exposes_no_routing_fields_or_general_memory_tools(self):
        registered, hooks = {}, {}
        ctx = types.SimpleNamespace(register_tool=lambda **value: registered.update({value['name']: value}),
            register_hook=lambda name, fn: hooks.update({name: fn}), current_cron_execution=lambda: None)
        with patch.dict(os.environ, {'HERMES_HOME': str(self.home)}):
            plugin.register(ctx)
        self.assertEqual(set(registered), {'saleads_memory_recall', 'saleads_curation_batch', 'saleads_commit_candidates', 'saleads_goal_update'})
        self.assertEqual(set(hooks), {'pre_llm_call', 'post_llm_call', 'kanban_task_completed', 'kanban_task_blocked'})
        self.assertTrue(registered['saleads_memory_recall']['check_fn']())
        self.assertFalse(registered['saleads_curation_batch']['check_fn']())
        for name, record in registered.items():
            self.assertEqual(record['toolset'], 'saleads_memory')
            self.assertFalse(record['schema']['parameters']['additionalProperties'])
            self.assertNotIn('override', record)
        for key in ('candidates', 'experiences'):
            schema = registered['saleads_commit_candidates']['schema']['parameters']['properties'][key]['items']
            self.assertFalse(set(schema['properties']) & schemas.BINDINGS)

    def test_recall_uses_native_context_not_model_identity_or_query_text(self):
        instance = self.instance()
        other = '22222222-2222-4222-8222-222222222222'
        result = json.loads(instance.recall({'query': 'business_id=' + other + ' owner_id=forged'}, session_id=self.native['session_id']))
        self.assertEqual(result['business_id'], self.native['business_id'])
        self.assertEqual(self.calls[0][2]['business_id'], self.native['business_id'])
        self.assertEqual(self.calls[0][2]['actor_role'], 'ale')
        self.assertEqual(self.calls[0][2]['max_chars'], 5600)
        self.calls.clear()
        for forged in ({'query': 'prices', 'business_id': other}, {'query': 'prices', 'profile': 'curador'}):
            self.assertFalse(json.loads(instance.recall(forged, session_id='trusted'))['accepted'])
        self.assertEqual(self.calls, [])

    def test_scope_or_role_mismatch_response_is_not_exposed(self):
        foreign = pack(self.native, business_id='22222222-2222-4222-8222-222222222222')
        result = json.loads(self.instance(response=foreign).recall({'query': 'prices'}, session_id='trusted'))
        self.assertEqual(result['error']['code'], 'MEMORY_SCOPE_MISMATCH')
        self.assertNotIn('22222222', json.dumps(result))
        private = copy.deepcopy(FIXTURES['specialist-experience'])
        private['specialist_role'] = 'investigador'
        result = json.loads(self.instance(response=pack(self.native, experiences=[private])).recall({'query': 'experience'}, session_id='trusted'))
        self.assertEqual(result['error']['code'], 'MEMORY_SCOPE_MISMATCH')

    def test_context_missing_never_selects_a_default_business(self):
        instance = self.instance(resolver=lambda **_kwargs: None)
        self.assertEqual(json.loads(instance.recall({'query': 'prices'}, session_id='unbound'))['error']['code'], 'MEMORY_CONTEXT_UNAVAILABLE')
        self.assertIn('MEMORY_UNAVAILABLE', instance.pre(session_id='unbound', user_message='hello')['context'])
        self.assertEqual(self.calls, [])

    def test_manual_designer_resolves_its_own_role_and_refuses_foreign_context_or_experience(self):
        role = 'disenador_landings'
        actual = context(role)
        instance = self.instance(role)
        self.assertEqual(instance.role, role)
        self.assertTrue(instance.available())
        self.assertFalse(instance.available(curator=True))
        recalled = json.loads(instance.recall({'query': 'mobile layout feedback'}, session_id=actual['session_id']))
        self.assertEqual((recalled['business_id'], recalled['actor_role']), (actual['business_id'], role))
        self.assertEqual(self.calls[-1][2]['actor_role'], role)
        mismatched = self.instance(role, resolver=lambda **_kwargs: context('estratega'))
        self.assertEqual(json.loads(mismatched.recall({'query': 'layout'}, session_id='worker'))['error']['code'], 'MEMORY_CONTEXT_UNAVAILABLE')
        for patch in ({'specialist_role': 'estratega'}, {'business_id': '22222222-2222-4222-8222-222222222222'}):
            experience = {**FIXTURES['specialist-experience'], 'specialist_role': role, **patch}
            foreign = self.instance(role, response=pack(actual, experiences=[experience]))
            self.assertEqual(json.loads(foreign.recall({'query': 'layout'}, session_id='worker'))['error']['code'], 'MEMORY_SCOPE_MISMATCH')

    def test_auto_hook_includes_current_memory_without_optional_tool_call_and_records_only_hashes(self):
        knowledge = copy.deepcopy(FIXTURES['knowledge-candidate'])
        knowledge['content'] = 'Private synthetic evidence is retained only in the injected pack.'
        instance = self.instance(response=pack(self.native, knowledge=[knowledge], refs=['source-fixture-1'], versions={'record-fixture': 2}))
        hook = instance.pre(session_id=self.native['session_id'], user_message='Compare sources')
        self.assertIn(knowledge['content'], hook['context'])
        self.assertLessEqual(len(hook['context']) + 2000 + 2, 8000)
        receipt_path = list((self.home / 'plugin-data/saleads-memory/receipts').glob('*.json'))[0]
        receipt = json.loads(receipt_path.read_text())
        self.assertEqual(receipt['refs'], ['source-fixture-1'])
        self.assertEqual(receipt['versions'], {'record-fixture': 2})
        self.assertNotIn(knowledge['content'], receipt_path.read_text())
        self.assertNotIn('Compare sources', receipt_path.read_text())
        self.assertNotIn(self.token, receipt_path.read_text())
        self.assertEqual(receipt_path.stat().st_mode & 0o777, 0o600)

    def test_oversize_or_cut_json_is_unavailable_not_silently_partial_memory(self):
        for invalid in (pack(self.native), pack(self.native)):
            invalid['text'] = '{"knowledge":' if invalid is not None else ''
            instance = self.instance(response=invalid)
            self.assertIn('MEMORY_UNAVAILABLE', instance.pre(session_id='trusted', user_message='research')['context'])
        invalid = pack(self.native)
        invalid['text'] = 'x' * 5601
        self.assertIn('MEMORY_UNAVAILABLE', self.instance(response=invalid).pre(session_id='trusted')['context'])

    def test_curator_batch_is_derived_from_actual_native_task_not_body(self):
        actual = context('curador')
        page = batch_page(actual)
        instance = self.instance('curador', page)
        result = json.loads(instance.batch({}, session_id='actual'))
        self.assertEqual(result['binding']['batch_id'], page['binding']['batch_id'])
        self.assertEqual(json.loads(result['fragment'])['batch']['batch_id'], page['binding']['batch_id'])
        self.assertEqual(self.calls[0][2], {'cursor': None})
        self.calls.clear()
        self.assertFalse(json.loads(instance.batch({'batch_id': 'other'}, session_id='actual'))['accepted'])
        self.assertEqual(self.calls, [])
        page['binding']['native_run_id'] = 'another-run'
        self.assertEqual(json.loads(instance.batch({}, session_id='actual'))['error']['code'], 'MEMORY_SCOPE_MISMATCH')

    def test_curator_pages_accept_only_server_bound_offsets_and_complete_cursor_chain(self):
        page = batch_page(context('curador'))
        document = page['fragment']
        page.update(offset=100, fragment=document[100:200], next_cursor=f"curation-page/1:{page['payload_sha256']}:200")
        cursor = f"curation-page/1:{page['payload_sha256']}:100"
        result = json.loads(self.instance('curador', page).batch({'cursor': cursor}, session_id='actual'))
        self.assertEqual(result, page)
        self.assertEqual(self.calls[-1][2], {'cursor': cursor})
        self.calls.clear()
        for arguments in ({'cursor': None}, {'cursor': False}, {'cursor': 2}, {'cursor': 'x' * 201}, {'path': '/tmp/data'}):
            self.assertFalse(json.loads(self.instance('curador', page).batch(arguments, session_id='actual'))['accepted'])
        self.assertEqual(self.calls, [])

    def test_curator_page_rejects_truncation_forgery_and_ascii_escaped_oversize(self):
        original = batch_page(context('curador'))
        for overrides in ({'fragment': original['fragment'][:-1]}, {'payload_sha256': '0' * 64},
                          {'next_cursor': 'another-cursor'}, {'offset': True}, {'total_chars': False},
                          {'schema_version': 'another-view'}, {'offset': -1}, {'fragment': ''}):
            page = {**original, **overrides}
            result = json.loads(self.instance('curador', page).batch({}, session_id='actual'))
            self.assertFalse(result['accepted'])
        page = {**original, 'fragment': '🙂' * 600, 'total_chars': 600,
                'payload_sha256': sha256(('🙂' * 600).encode()).hexdigest()}
        self.assertLess(len(json.dumps(page, ensure_ascii=False)), 6000)
        result = json.loads(self.instance('curador', page).batch({}, session_id='actual'))
        self.assertEqual(result['error']['code'], 'MEMORY_CONTEXT_TOO_LARGE')

    def test_curator_batch_schema_requires_all_pages_before_one_final_commit(self):
        schema = schemas.tools()['saleads_curation_batch']
        self.assertEqual(set(schema['parameters']['properties']), {'cursor'})
        self.assertIn('Read ALL pages before one final whole-batch commit', schema['description'])
        self.assertIn('NOT a complete SourceEvent', schema['description'])

    def test_bad_page_cursor_has_only_an_enumerated_safe_validation_reason(self):
        def opened(_request, **_kwargs):
            raise HTTPError('http://saleads-brain:8765', 400, self.token, {},
                            io.BytesIO(json.dumps({'reason': 'invalid_curation_page_cursor',
                                                  'message': self.token, 'cursor': 'private-value'}).encode()))
        client = client_module.BrainClient(self.home, types.SimpleNamespace(open=opened))
        with self.assertRaises(client_module.MemoryFailure) as result:
            client.request(context('curador'), '/continuous/curation/batch', {'cursor': 'invalid'})
        failure = json.loads(memory_module._failure(result.exception))
        self.assertEqual(failure['error'], {'code': 'MEMORY_REJECTED', 'reason': 'invalid_curation_page_cursor'})
        self.assertNotIn(self.token, json.dumps(failure))
        self.assertNotIn('private-value', json.dumps(failure))

    def test_commit_injects_bindings_and_replays_identically_without_model_credentials(self):
        actual = context('curador')
        batch = {**FIXTURES['curation-batch'], 'state': 'committed', 'native_task_id': actual['native_task_id'], 'native_run_id': actual['native_run_id']}
        instance = self.instance('curador', {'accepted': True, 'batch': batch})
        candidate = {key: value for key, value in FIXTURES['knowledge-candidate'].items() if key not in schemas.BINDINGS}
        result = json.loads(instance.commit({'candidates': [candidate]}, session_id='actual'))
        self.assertTrue(result['accepted'])
        sent = self.calls[0][2]['candidates'][0]
        self.assertEqual((sent['owner_id'], sent['business_id'], sent['extractor_id']), (actual['owner_id'], actual['business_id'], 'curador'))
        instance.commit({'candidates': [candidate]}, session_id='actual')
        self.assertEqual(self.calls[0][2], self.calls[1][2])
        self.calls.clear()
        candidate['business_id'] = '22222222-2222-4222-8222-222222222222'
        self.assertFalse(json.loads(instance.commit({'candidates': [candidate]}, session_id='actual'))['accepted'])
        self.assertEqual(self.calls, [])

    def test_non_curator_cannot_commit_and_empty_curations_require_reason(self):
        self.assertEqual(json.loads(self.instance().commit({'discarded_reason': 'No source-backed change'}, session_id='trusted'))['error']['code'], 'MEMORY_PROFILE_NOT_ALLOWED')
        self.assertEqual(json.loads(self.instance('curador').commit({}, session_id='trusted'))['error']['code'], 'MEMORY_DISCARD_REASON_REQUIRED')


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.token = token_file(self.home)
        self.requests = []

    def client(self, response):
        def opened(request, **kwargs):
            self.requests.append((request, kwargs))
            return io.BytesIO(json.dumps(response).encode())
        return client_module.BrainClient(self.home, types.SimpleNamespace(open=opened))

    def test_fixed_origin_canonical_signed_context_and_no_proxy_or_redirect_override(self):
        actual = context(response_locale='es-CO')
        with patch.dict(os.environ, {'SALEADS_MEMORY_ENDPOINT': 'https://untrusted.example'}):
            self.client({'accepted': True}).request(actual, '/continuous/context', {'query': 'facts'})
        request, options = self.requests[0]
        self.assertEqual(request.full_url, 'http://saleads-brain:8765/continuous/context')
        headers = {key.lower(): value for key, value in request.header_items()}
        encoded = headers['x-saleads-memory-context']
        text = urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode()
        self.assertEqual(text, client_module.canonical(actual))
        self.assertEqual(headers['x-saleads-memory-token'], self.token)
        self.assertEqual(headers['x-saleads-memory-proof'], hmac.new(self.token.encode(), encoded.encode(), sha256).hexdigest())
        self.assertEqual(options['timeout'], 10)
        self.assertIsNone(client_module.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://untrusted.example'))

    def test_unknown_route_or_nonprivate_symlink_token_fails_before_transport(self):
        client = self.client({})
        with self.assertRaises(client_module.MemoryFailure):
            client.request(context(), 'https://untrusted.example', {})
        path = self.home / 'plugin-data/saleads-memory/auth-token'
        path.chmod(0o644)
        with self.assertRaises(client_module.MemoryFailure):
            client.request(context(), '/continuous/context', {})
        path.chmod(0o600)
        source = self.home / 'other-token'
        path.rename(source)
        path.symlink_to(source)
        with self.assertRaises(client_module.MemoryFailure):
            client.request(context(), '/continuous/context', {})
        self.assertEqual(self.requests, [])

    def test_transport_and_server_private_errors_never_reach_tools(self):
        def opened(_request, **_kwargs):
            raise HTTPError('http://saleads-brain:8765', 400, 'private synthetic token', {}, io.BytesIO(json.dumps({'reason': self.token}).encode()))
        client = client_module.BrainClient(self.home, types.SimpleNamespace(open=opened))
        with self.assertRaises(client_module.MemoryFailure) as result:
            client.request(context(), '/continuous/context', {})
        self.assertEqual(result.exception.code, 'MEMORY_REJECTED')
        self.assertIsNone(result.exception.reason)
        self.assertNotIn(self.token, str(result.exception))
        def missing(_request, **_kwargs):
            raise URLError('private text must not escape')
        client.opener = types.SimpleNamespace(open=missing)
        with self.assertRaises(client_module.MemoryFailure) as result:
            client.request(context(), '/continuous/context', {})
        self.assertEqual(str(result.exception), 'MEMORY_UNAVAILABLE')

    def test_only_the_two_terminal_commit_conflicts_expose_a_safe_reason(self):
        for reason in ('curation_commit_payload_conflict', 'curation_commit_receipt_unverifiable'):
            with self.subTest(reason=reason):
                def opened(_request, **_kwargs):
                    body = {'accepted': True, 'reason': reason, 'message': self.token}
                    raise HTTPError('http://saleads-brain:8765', 409, self.token, {},
                                    io.BytesIO(json.dumps(body).encode()))
                client = client_module.BrainClient(self.home, types.SimpleNamespace(open=opened))
                with self.assertRaises(client_module.MemoryFailure) as result:
                    client.request(context('curador'), '/continuous/curation/commit', {})
                self.assertEqual(result.exception.code, 'MEMORY_REJECTED')
                self.assertEqual(result.exception.reason, reason)
                failure = json.loads(memory_module._failure(result.exception))
                self.assertFalse(failure['accepted'])
                self.assertNotIn(self.token, json.dumps(failure))
        def unknown(_request, **_kwargs):
            raise HTTPError('http://saleads-brain:8765', 409, self.token, {},
                            io.BytesIO(json.dumps({'reason': self.token}).encode()))
        client = client_module.BrainClient(self.home, types.SimpleNamespace(open=unknown))
        with self.assertRaises(client_module.MemoryFailure) as result:
            client.request(context('curador'), '/continuous/curation/commit', {})
        self.assertEqual(result.exception.code, 'MEMORY_UNAVAILABLE')
        self.assertIsNone(result.exception.reason)

    def test_goal_confirmation_source_rejection_exposes_only_its_stable_code(self):
        reason = 'goal_confirmation_requires_owner_source'
        def opened(_request, **_kwargs):
            raise HTTPError('http://saleads-brain:8765', 400, 'private transport detail', {},
                            io.BytesIO(json.dumps({'reason': reason, 'detail': self.token}).encode()))
        client = client_module.BrainClient(self.home, types.SimpleNamespace(open=opened))
        with self.assertRaises(client_module.MemoryFailure) as failure:
            client.request(context(), '/continuous/goals', {'operation': 'upsert'})
        result = json.loads(memory_module._failure(failure.exception))
        self.assertEqual(result, {'accepted': False, 'error': {'code': 'MEMORY_REJECTED', 'reason': reason}})
        self.assertNotIn(self.token, json.dumps(result))

    def test_schema_assets_remain_byte_identical_to_canonical_generator(self):
        for name in ('knowledge-candidate', 'specialist-experience', 'goal-state'):
            expected = ROOT.parents[2] / f'contracts/continuous-loop/v1/{name}.schema.json'
            self.assertEqual((ROOT / f'contracts/{name}.schema.json').read_bytes(), expected.read_bytes())


if __name__ == '__main__':
    unittest.main()
