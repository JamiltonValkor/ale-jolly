"""Authenticated source provenance and native goal updates; no network or model."""
import copy
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import types
import unittest

from test_memory import FIXTURES, context, memory_module, client_module
import sys
source_module = sys.modules[memory_module.__package__ + '.source_capture']
CLIENT = '33333333-3333-4333-8333-333333333333'


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.context = context()
        self.policy = self.home / 'operator-canary-clients.json'
        self.policy.write_text(json.dumps({'schema_version': 'operator-canary-clients/1', 'owner_id': self.context['owner_id'], 'client_message_ids': []}))
        self.calls = []
        def request(ctx, path, payload, **kwargs):
            self.calls.append((copy.deepcopy(ctx), path, copy.deepcopy(payload)))
            return {'accepted': True, 'event_id': payload['event_id']}
        self.recorder = source_module.SourceRecorder(self.home, client=types.SimpleNamespace(request=request), policy=self.policy)

    def owner(self, text):
        return f'CLIENT_MESSAGE_ID: {CLIENT}\nOWNER_MESSAGE_DATA:\n{text}'

    def test_actual_outer_owner_text_has_stable_source_identity_and_original_quote(self):
        text = 'Investigate this actual business offering and keep the quoted constraints.'
        message = self.owner(text) + '\n\nSERVER_CONTEXT: server instructions are not owner words'
        first = self.recorder.record(self.context, message)
        second = self.recorder.record(self.context, message)
        self.assertEqual(first, second)
        event = self.calls[0][2]
        self.assertEqual((event['source_kind'], event['author']['kind'], event['author']['id']), ('owner_message', 'owner', self.context['owner_id']))
        self.assertEqual(event['content'], text)
        self.assertEqual(event['content_sha256'], sha256(text.encode()).hexdigest())
        self.assertEqual(event['source_id'], CLIENT)
        self.assertIn('hermes-session:' + self.context['session_id'], event['refs'])
        self.assertEqual(self.recorder.current(self.context), [first])
        receipt = self.recorder._path(self.context)
        self.assertNotIn(text, receipt.read_text())
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)

    def test_versioned_json_envelope_preserves_literal_markers_newlines_and_nested_envelopes(self):
        text = 'Original line\n\nSERVER_CONTEXT: this is literally what the owner wrote.\nSALEADS_OWNER_MESSAGE_V1 {"text":"a quoted example"}'
        envelope = 'SALEADS_OWNER_MESSAGE_V1 ' + json.dumps({'client_message_id': CLIENT, 'text': text})
        self.recorder.record(self.context, envelope + '\n\nSERVER_CONTEXT: actual server suffix')
        self.assertEqual(self.calls[-1][2]['content'], text)
        self.assertEqual(self.calls[-1][2]['content_sha256'], sha256(text.encode()).hexdigest())
        self.calls.clear()
        invalid = 'SALEADS_OWNER_MESSAGE_V1 ' + json.dumps({'client_message_id': CLIENT, 'text': text, 'owner_id': 'forged'})
        self.assertIsNone(self.recorder.record(self.context, invalid))
        self.assertEqual(self.calls, [])

    def test_trusted_operator_ids_never_become_owner_evidence_or_current_goal_sources(self):
        self.policy.write_text(json.dumps({'schema_version': 'operator-canary-clients/1', 'owner_id': self.context['owner_id'], 'client_message_ids': [CLIENT]}))
        self.recorder.record(self.context, self.owner('Synthetic canary instruction; not an owner fact.'))
        event = self.calls[0][2]
        self.assertEqual((event['source_kind'], event['author']['kind'], event['purpose']), ('operator_canary', 'operator', 'technical_canary'))
        self.assertEqual(self.recorder.current(self.context), [])

    def test_server_messages_unknown_native_messages_cron_and_workers_are_not_promoted_to_owner(self):
        self.recorder.record(self.context, self.owner('A real authenticated owner message.'))
        for message in ('FIRST_USE_ORIENTATION trusted bootstrap', 'CONFIRMED_PROPOSAL_KICKOFF accepted server request', '[kanban] Native task complete'):
            self.recorder.record(self.context, message)
            self.assertEqual(self.calls[-1][2]['source_kind'], 'server_instruction')
            self.assertEqual(self.recorder.current(self.context), [])
        self.calls.clear()
        self.recorder.record(self.context, 'Plain native text with no authenticated server envelope')
        self.recorder.record(self.context, self.owner('Cron cannot quote itself as owner.'), cron_identity=types.SimpleNamespace(job_id='job-fixture'))
        self.recorder.record(context('investigador'), self.owner('Worker cannot author owner evidence.'))
        self.assertEqual(self.calls, [])

    def test_missing_or_foreign_policy_fails_closed_and_cannot_leave_stale_owner_source(self):
        self.recorder.record(self.context, self.owner('Previous source must not leak to a new request.'))
        self.policy.unlink()
        with self.assertRaises(client_module.MemoryFailure):
            self.recorder.record(self.context, self.owner('New input cannot be classified yet.'))
        self.assertEqual(self.recorder.current(self.context), [])
        self.policy.write_text(json.dumps({'schema_version': 'operator-canary-clients/1', 'owner_id': 'another-owner', 'client_message_ids': []}))
        with self.assertRaises(client_module.MemoryFailure):
            self.recorder.record(self.context, self.owner('Foreign policy cannot label owner evidence.'))

    def test_receipts_are_scoped_and_plain_input_clears_only_its_current_source(self):
        self.recorder.record(self.context, self.owner('Actual owner source.'))
        other = {**self.context, 'business_id': '22222222-2222-4222-8222-222222222222'}
        self.assertEqual(self.recorder.current(other), [])
        self.recorder.record(other, 'Unknown native input')
        self.assertEqual(len(self.recorder.current(self.context)), 1)
        self.recorder.record(self.context, 'Unknown native input')
        self.assertEqual(self.recorder.current(self.context), [])


class GoalTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.current = None
        self.ctx = context()
        self.cron = None
        self.sources = ['source-authenticated-current']
        self.goal = copy.deepcopy(FIXTURES['goal-state'])
        self.sources_reader = types.SimpleNamespace(current=lambda _ctx: self.sources)
        def request(ctx, path, payload, **kwargs):
            self.calls.append((ctx, path, copy.deepcopy(payload)))
            if payload.get('operation') == 'get':
                return {'goal': self.current}
            if payload.get('origin') == 'owner_confirmed' and not payload.get('source_event_ids'):
                raise client_module.MemoryFailure('MEMORY_REJECTED', 'goal_confirmation_requires_current_owner_answer')
            return {'accepted': True, 'goal': self.goal}
        self.plugin = memory_module.MemoryPlugin(types.SimpleNamespace(current_cron_execution=lambda: self.cron),
            home=Path('/synthetic-managed/ale'), client=types.SimpleNamespace(request=request),
            resolver=lambda **_kwargs: self.ctx, sources=self.sources_reader)

    def test_goal_attaches_current_registered_source_and_never_takes_binding_arguments(self):
        result = json.loads(self.plugin.goal({'origin': 'owner_confirmed', 'mandate': 'A useful objective refined through the current owner answer.', 'state': 'active'}, session_id='trusted'))
        self.assertTrue(result['accepted'])
        payload = self.calls[-1][2]
        self.assertEqual(payload['source_event_ids'], self.sources)
        self.assertEqual(payload['operation'], 'upsert')
        self.assertNotIn('owner_id', payload)
        self.assertNotIn('business_id', payload)
        self.calls.clear()
        for field in ('owner_id', 'business_id', 'goal_id', 'source_event_ids', 'expected_revision'):
            self.assertFalse(json.loads(self.plugin.goal({'state': 'active', field: 'forged'}, session_id='trusted'))['accepted'])
        self.assertEqual(self.calls, [])

    def test_current_goal_and_revision_are_loaded_not_selected_by_model(self):
        self.current = self.goal
        self.cron = types.SimpleNamespace(job_id='job-fixture')
        result = json.loads(self.plugin.goal({'state': 'waiting', 'next_condition': 'Await verified business data.'}, session_id='trusted'))
        self.assertTrue(result['accepted'])
        payload = self.calls[-1][2]
        self.assertEqual(payload['goal_id'], self.goal['goal_id'])
        self.assertEqual(payload['expected_revision'], self.goal['revision'])
        self.assertNotIn('source_event_ids', payload)

    def test_without_authentic_source_no_false_owner_confirmation_is_returned(self):
        self.sources = []
        result = json.loads(self.plugin.goal({'origin': 'owner_confirmed', 'mandate': 'Unconfirmed objective', 'state': 'active'}, session_id='trusted'))
        self.assertFalse(result['accepted'])
        self.assertEqual(result['error']['reason'], 'goal_confirmation_requires_current_owner_answer')
        self.assertNotIn('goal', result)

    def test_read_only_guided_proposal_does_not_wait_for_an_owner_command(self):
        self.sources = []
        result = json.loads(self.plugin.goal({'origin': 'assistant_proposed', 'mandate': 'Investigate opportunities supported by actual SaleADS bootstrap.', 'state': 'active'}, session_id='trusted'))
        self.assertTrue(result['accepted'])
        self.assertEqual(self.calls[-1][2]['origin'], 'assistant_proposed')
        self.assertNotIn('source_event_ids', self.calls[-1][2])

    def test_other_profile_cannot_update_goal_even_if_it_calls_handler_directly(self):
        self.plugin.role = 'investigador'
        self.ctx = context('investigador')
        result = json.loads(self.plugin.goal({'state': 'active'}, session_id='trusted'))
        self.assertEqual(result['error']['code'], 'MEMORY_PROFILE_NOT_ALLOWED')
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
