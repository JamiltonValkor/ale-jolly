"""Synthetic landing evidence; no model, network, commercial data, or source writes."""
import copy
from dataclasses import replace
from hashlib import sha256
import importlib
import json
from pathlib import Path
import tempfile
import unittest

from test_memory import context, memory_module

landing = importlib.import_module(memory_module.__package__ + '.landing_experience')
capture = importlib.import_module(memory_module.__package__ + '.specialist_capture')
FIXTURE = json.loads((Path(__file__).parent / 'fixtures/landing-experience.json').read_text())


def episode(**overrides):
    ctx = context(landing.ROLE, native_task_id='landing-task-1', native_run_id='7', session_id='landing-session-1')
    ctx.update(overrides)
    run = {'tenant': ctx['business_id'], 'assignee': landing.ROLE, 'profile': landing.ROLE,
           'task_id': ctx['native_task_id'], 'id': int(ctx['native_run_id']), 'task_status': 'done',
           'status': 'done', 'outcome': 'completed', 'started_at': 1793100000, 'ended_at': 1793100100,
           'title': 'Build a mobile landing proposal', 'current_run_id': None, 'latest_run_id': int(ctx['native_run_id'])}
    files = {name: text.encode() for name, text in FIXTURE['files'].items()}
    digest = landing.artifact_digest(files)
    lineage = {'betId': FIXTURE['bet_id'], 'hypothesisId': FIXTURE['bet_id'],
               'strategyVersionId': FIXTURE['strategy_version_id']}
    receipt = {'landingId': FIXTURE['landing_id'], 'businessId': ctx['business_id'], 'origin': 'hermes',
               'n': 1, 'artifactDigest': digest, 'requestId': 'synthetic-request-1'}
    version = {'landingId': FIXTURE['landing_id'], 'n': 1, 'origin': 'hermes', 'artifactDigest': digest,
               'files': {name: files[name].decode() for name in landing.CODE}}
    manifest = {**{key: receipt[key] for key in ('landingId', 'n', 'artifactDigest', 'requestId')}, 'lineage': lineage,
                'files': {name: {'sha256': sha256(content).hexdigest(), 'byteLength': len(content)}
                          for name, content in files.items()}}
    inputs = landing.CollectorInputs(binding=copy.deepcopy(ctx), files=files,
        landing={'ok': True, 'command': 'saleads_landing_get', 'data': {
            'id': FIXTURE['landing_id'], 'businessId': ctx['business_id'], 'origin': 'hermes', 'lineage': lineage}},
        admission={'ok': True, 'command': 'saleads_landing_submit_version', 'data': receipt},
        version={'ok': True, 'command': 'saleads_landing_get_version', 'data': version}, manifest=manifest)
    return ctx, run, inputs


def extracted(ctx, run, inputs, text=None):
    return landing.LandingExperience.extract(ctx, ctx['session_id'], run, text or FIXTURE['result'], inputs)


class LandingEvidenceTests(unittest.TestCase):
    def test_complete_native_and_cli_refs_do_not_claim_lessons_or_review_success(self):
        ctx, run, inputs = episode()
        result = extracted(ctx, run, inputs)
        self.assertEqual(set(result.evidence['artifacts']), {'brief', 'visual_direction', 'html', 'css', 'critique', 'review_evidence'})
        self.assertEqual(result.evidence['persisted_version']['n'], 1)
        self.assertIn('saleads-bet:' + FIXTURE['bet_id'], result.refs)
        self.assertIn('saleads-strategy-version:' + FIXTURE['strategy_version_id'], result.refs)
        self.assertEqual(result.evidence['feedback_source_refs'], [])
        self.assertNotIn('lesson', result.evidence)
        self.assertNotIn('passed', result.evidence)
        self.assertIn('not owner testimony', result.header())

    def test_missing_service_corroboration_keeps_only_native_bytes(self):
        ctx, run, inputs = episode()
        native = replace(inputs, landing=None, admission=None, version=None, manifest=None)
        result = extracted(ctx, run, native)
        self.assertIsNone(result.evidence['persisted_version'])
        self.assertTrue(all(ref.startswith('native-landing-artifact:') for ref in result.refs))
        with self.assertRaisesRegex(landing.LandingEvidenceError, 'corroboration_incomplete'):
            extracted(ctx, run, replace(inputs, version=None))
        with self.assertRaisesRegex(landing.LandingEvidenceError, 'receipt_mismatch'):
            extracted(ctx, run, replace(native, manifest={'artifactDigest': '0' * 64, 'validated': True}))

    def test_hash_version_canonical_reference_and_tenant_mismatches_fail_closed(self):
        ctx, run, original = episode()
        cases = []
        for field, key, value in [('admission', 'artifactDigest', '0' * 64), ('version', 'n', 2),
                                  ('admission', 'landingId', '66666666-6666-4666-8666-666666666666'),
                                  ('landing', 'businessId', '22222222-2222-4222-8222-222222222222')]:
            changed = copy.deepcopy(getattr(original, field))
            changed['data'][key] = value
            cases.append(replace(original, **{field: changed}))
        for field, value in [('betId', 'not-a-canonical-id'), ('hypothesisId', FIXTURE['strategy_version_id'])]:
            changed = copy.deepcopy(original.landing)
            changed['data']['lineage'][field] = value
            cases.append(replace(original, landing=changed))
        for key in ('artifactDigest', 'n', 'lineage'):
            changed = copy.deepcopy(original.manifest)
            changed[key] = 'false-declared-reference'
            cases.append(replace(original, manifest=changed))
        changed = copy.deepcopy(original.manifest)
        changed['files']['styles.css']['sha256'] = '0' * 64
        cases.append(replace(original, manifest=changed))
        cases.append(replace(original, files={**original.files, 'styles.css': b'changed after validation'}))
        for inputs in cases:
            with self.subTest(inputs=cases.index(inputs)), self.assertRaises(landing.LandingEvidenceError):
                extracted(ctx, run, inputs)

    def test_only_exact_native_task_run_role_business_session_terminal_is_evidence(self):
        ctx, run, inputs = episode()
        for field, value in [('native_task_id', 'another-task'), ('native_run_id', '8'), ('actor_role', 'estratega'),
                             ('business_id', '22222222-2222-4222-8222-222222222222'), ('session_id', 'another-session')]:
            with self.subTest(field=field), self.assertRaises(landing.LandingEvidenceError):
                extracted({**ctx, field: value}, run, inputs)
        for field, value in [('id', 99), ('profile', 'estratega'), ('task_id', 'other-task'),
                             ('status', 'completed'), ('ended_at', None), ('task_status', 'running')]:
            with self.subTest(field=field), self.assertRaises(landing.LandingEvidenceError):
                extracted(ctx, {**run, field: value}, inputs)

    def test_feedback_requires_registered_owner_provenance_and_exact_version(self):
        ctx, run, inputs = episode()
        version_ref = extracted(ctx, run, inputs).evidence['persisted_version']['ref']
        text = 'Keep one primary action in the mobile header.'
        source = {'schema_version': 'source-event/1', 'event_id': 'authentic-owner-feedback', 'owner_id': ctx['owner_id'], 'business_id': ctx['business_id'],
                  'source_kind': 'owner_message', 'purpose': 'business_work', 'author': {'kind': 'owner', 'id': ctx['owner_id']},
                  'content': text, 'content_sha256': sha256(text.encode()).hexdigest(), 'refs': [version_ref]}
        self.assertIn('source-event:authentic-owner-feedback', extracted(ctx, run, replace(inputs, feedback_sources=(source,))).refs)
        invalid = [dict(source, source_kind='operator_canary', purpose='technical_canary', author={'kind': 'operator', 'id': 'test-runner'}),
                   dict(source, refs=[version_ref.replace('/1@', '/2@')]), dict(source, content_sha256='0' * 64),
                   dict(source, business_id='22222222-2222-4222-8222-222222222222')]
        for source in invalid:
            with self.assertRaisesRegex(landing.LandingEvidenceError, 'feedback_not_authentic_or_bound'):
                extracted(ctx, run, replace(inputs, feedback_sources=(source,)))

    def test_source_replay_and_chunks_keep_one_episode_and_exact_enrichment(self):
        ctx, run, inputs = episode()
        text = FIXTURE['result'] * 200
        evidence = extracted(ctx, run, inputs, text)
        one = list(capture.events_for(Path('/synthetic'), ctx, ctx['session_id'], text, run, landing=evidence))
        two = list(capture.events_for(Path('/synthetic'), ctx, ctx['session_id'], text, run, landing=evidence))
        self.assertGreater(len(one), 1)
        self.assertEqual([event['event_id'] for event in one], [event['event_id'] for event in two])
        self.assertEqual(len({event['source_id'] for event in one}), 1)
        for event in one:
            self.assertEqual((event['business_id'], event['author']['id'], event['native_task_id'], event['native_run_id']),
                             (ctx['business_id'], landing.ROLE, ctx['native_task_id'], ctx['native_run_id']))
            self.assertTrue(set(evidence.refs) <= set(event['refs']))
            self.assertLessEqual(len(event['refs']), 30)
            self.assertLessEqual(len(event['content']), 24000)

    def test_captured_evidence_cannot_be_attached_to_another_result_or_business(self):
        ctx, run, inputs = episode()
        evidence = extracted(ctx, run, inputs)
        for changed_ctx, text in ((ctx, FIXTURE['result'] + 'different output'),
                                  ({**ctx, 'business_id': '22222222-2222-4222-8222-222222222222'}, FIXTURE['result'])):
            event = next(capture.events_for(Path('/synthetic'), changed_ctx, changed_ctx['session_id'], text, run, landing=evidence))
            self.assertFalse(set(evidence.refs) & set(event['refs']))

    def test_native_loader_uses_fixed_files_and_rejects_symlink_or_mutated_root(self):
        ctx, run, inputs = episode()
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary).resolve()
            for name, content in inputs.files.items():
                (workspace / name).write_bytes(content)
            (workspace / 'unrelated-secret.txt').write_text('must never be collected')
            run.update(workspace_kind='dir', workspace_path=str(workspace))
            collected = landing.collect_native(ctx, ctx['session_id'], run)
            self.assertEqual(collected.files, inputs.files)
            snapshot = landing.native_snapshot(collected, run, str(workspace))
            self.assertNotIn('must never', str(snapshot))
            for changed in ({'latest_run_id': 8}, {'current_run_id': 8}, {'workspace_path': str(workspace / 'other')}):
                with self.assertRaises(landing.LandingEvidenceError):
                    landing.native_snapshot(collected, {**run, **changed}, str(workspace))
            (workspace / 'review.json').unlink()
            (workspace / 'review.json').symlink_to(workspace / 'design.json')
            with self.assertRaisesRegex(landing.LandingEvidenceError, 'file_invalid'):
                landing.collect_native(ctx, ctx['session_id'], run)


if __name__ == '__main__':
    unittest.main()
