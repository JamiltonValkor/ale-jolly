"""Attempt-bound native transport receipts, not model-generated delivery claims."""
import asyncio
import hashlib
import json
from types import SimpleNamespace
import unittest

import test_continuity_plugin as fixtures

B1, NOW, exporter = fixtures.B1, fixtures.NOW, fixtures.exporter
import sys

delivery = sys.modules['mcl_plugin_fixture.delivery']


class HomeDeliveryTests(unittest.TestCase):
    setUp = fixtures.NativeContinuityTests.setUp
    registry = fixtures.NativeContinuityTests.registry
    capture = fixtures.NativeContinuityTests.capture
    execution = fixtures.NativeContinuityTests.execution
    def source(self):
        self.capture(home_state='configured')
        return SimpleNamespace(job_id='job-one', execution_id='execution-one', profile='default')

    def test_confirmed_provider_ack_is_durable_and_not_sent_twice(self):
        identity = self.source()
        calls = []
        async def sender(target, text):
            calls.append((target, text))
            return {'success': True, 'message_id': 'provider-message-123'}
        targets = lambda _j: [{'platform': 'test-native', 'chat_id': 'owner-home', 'thread_id': None}]
        one = asyncio.run(delivery.deliver(identity, 'A useful synthetic result.', root=self.root,
            target_resolver=targets, sender=sender, now=NOW))
        two = asyncio.run(delivery.deliver(identity, 'A useful synthetic result.', root=self.root,
            target_resolver=targets, sender=sender, now=NOW))
        self.assertEqual(one['state'], 'delivered')
        self.assertEqual(two, one)
        self.assertEqual(len(calls), 1)
        self.execution(outcome='delivered')
        projected = exporter.project(self.root, self.home)['notifications'][0]['delivery']
        self.assertEqual(projected['state'], 'delivered')
        self.assertEqual(projected['destination_version'], one['destination_version'])

    def test_uncertain_ack_is_never_a_replay_permission(self):
        identity = self.source()
        calls = []
        async def sender(target, text):
            calls.append(target)
            return {'success': True}  # Provider supplied no positive receipt.
        arguments = dict(root=self.root, target_resolver=lambda _j: [{'platform': 'test-native', 'chat_id': 'home'}], sender=sender)
        one = asyncio.run(delivery.deliver(identity, 'A useful synthetic result.', **arguments))
        two = asyncio.run(delivery.deliver(identity, 'A useful synthetic result.', **arguments))
        self.assertEqual(one['state'], 'unknown')
        self.assertEqual(two['state'], 'unknown')
        self.assertEqual(len(calls), 1)
        self.execution(outcome='failed')  # Native wrapper error is not proof that nothing was sent.
        self.assertEqual(exporter.project(self.root, self.home)['notifications'][0]['delivery']['state'], 'unknown')

    def test_late_positive_ack_updates_same_attempt_after_observation_timeout(self):
        identity = self.source()
        async def scenario():
            released = asyncio.Event()
            started = asyncio.Event()
            async def sender(target, text):
                started.set(); await released.wait()
                return {'success': True, 'message_id': 'late-provider-message'}
            pending = asyncio.create_task(delivery.deliver(identity, 'A useful synthetic result.', root=self.root,
                target_resolver=lambda _j: [{'platform': 'test-native', 'chat_id': 'home'}], sender=sender))
            await started.wait()
            self.assertEqual(delivery.read_result(self.root, identity.job_id, identity.execution_id)['state'], 'unknown')
            released.set()
            self.assertEqual((await pending)['state'], 'delivered')
        asyncio.run(scenario())

    def test_no_current_home_and_definite_pre_send_failure_have_distinct_receipts(self):
        identity = self.source()
        async def forbidden(*args):
            self.fail('No home must not attempt a send')
        result = asyncio.run(delivery.deliver(identity, 'A useful synthetic result.', root=self.root,
            target_resolver=lambda _j: [], sender=forbidden))
        self.assertEqual(result['state'], 'no_home')
        self.execution(outcome='failed')
        self.assertEqual(exporter.project(self.root, self.home)['notifications'][0]['delivery']['state'], 'no_home')

    def test_source_text_or_configured_language_change_prevents_send(self):
        identity = self.source()
        async def forbidden(*args):
            self.fail('Unbound/stale content cannot reach a sender')
        result = asyncio.run(delivery.deliver(identity, 'Different output.', root=self.root,
            target_resolver=lambda _j: [], sender=forbidden))
        self.assertEqual(result['state'], 'failed')
        self.values[0].update(response_locale='de', locale_revision=3)
        self.jobs[0].update(response_locale='de', locale_revision=3)
        self.registry()
        result = asyncio.run(delivery.deliver(identity, 'A useful synthetic result.', root=self.root,
            target_resolver=lambda _j: [], sender=forbidden))
        self.assertEqual(result['state'], 'failed')

    def test_forged_or_wrong_source_receipt_cannot_upgrade_projection(self):
        identity = self.source(); self.execution(outcome='delivered')
        directory = self.root / 'delivery-receipts'; directory.mkdir()
        proof = {'schema_version': 'managed-home-receipt/1', 'owner_id': 'foreign-owner',
            'business_id': B1, 'session_id': 'session-one', 'job_id': identity.job_id,
            'execution_id': identity.execution_id, 'response_locale': 'en', 'locale_revision': 1,
            'content_sha256': hashlib.sha256(b'A useful synthetic result.').hexdigest(),
            'state': 'delivered', 'targets': [{'state': 'delivered', 'ack_sha256': 'a' * 64}]}
        (directory / (delivery.key_for(identity.job_id, identity.execution_id) + '.json')).write_text(json.dumps(proof))
        self.assertEqual(exporter.project(self.root, self.home)['notifications'][0]['delivery']['state'], 'unknown')

    def test_one_confirmed_home_prevents_duplicate_despite_another_failure(self):
        identity = self.source()
        async def sender(target, text):
            return ({'success': True, 'message_id': 'real-receipt'} if target['chat_id'] == 'one'
                    else {'success': False, 'definitely_not_sent': True})
        result = asyncio.run(delivery.deliver(identity, 'A useful synthetic result.\n', root=self.root,
            target_resolver=lambda _j: [{'platform': 'test-native', 'chat_id': 'one'},
                                       {'platform': 'test-native', 'chat_id': 'two'}], sender=sender))
        self.assertEqual(result['state'], 'delivered')
        self.assertEqual([t['state'] for t in result['targets']], ['delivered', 'failed'])
        self.execution(outcome='failed')
        # Simulate crash after per-target ACK persistence and before aggregate update.
        result['state'] = 'unknown'
        delivery.atomic(self.root / 'delivery-receipts' / (delivery.key_for(identity.job_id, identity.execution_id) + '.json'), result)
        self.assertEqual(exporter.project(self.root, self.home)['notifications'][0]['delivery']['state'], 'delivered')

    def test_boolean_or_partial_provider_shapes_are_not_positive_receipts(self):
        for result in ({'success': True}, {'success': True, 'message_id': True},
                       {'success': True, 'raw_response': True},
                       {'success': True, 'message_id': 'head', 'raw_response': {'partial_overflow': True}},
                       {'success': True, 'message_id': 'head', 'raw_response': {'delivered_chunks': 1, 'total_chunks': 2}}):
            self.assertFalse(delivery.positive(result), result)


if __name__ == '__main__':
    unittest.main()
