import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('landing_metadata', Path(__file__).resolve().parents[2] / 'vm/extensions/landing-pilot/build_metadata.py')
mapper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mapper)

BET = '4ab8788c-9cbc-4e56-8749-9232adbb1a51'
VERSION = 'fa579367-de1c-4b7a-b575-2336f73ab887'
LINEAGE = {'betId': BET, 'hypothesisId': BET, 'strategyVersionId': VERSION, 'goalId': 'native-goal-1', 'taskId': 'original-task-1'}


class MetadataMappingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.write('page.json', {'blocks': [{'id': 'hero', 'copy': 'Una propuesta verificable'}]})
        self.write('design.json', {'concept': 'Editorial', 'fonts': {'heading': 'anton', 'body': 'dm-sans', 'accent': 'jetbrains-mono'}})
        self.review = {'score': 999, 'passed': True, 'rounds': 1,
            'criteria': [{'id': i, 'score': 2, 'note': 'Observed criterion finding.'} for i in range(1, 11)],
            'observations': ['Preserve the approved promise.'],
            'capturedDigest': 'not a server field', 'screenshots': ['unverified.jpg'], 'changes': ['Not copied into review']}
        self.write('review.json', self.review)
        self.write('landing.json', {'ok': True, 'data': {'id': 'landing-id', 'lineage': LINEAGE}})
        (self.work / 'index.html').write_text('<!doctype html><html><body>Fixture</body></html>')
        (self.work / 'styles.css').write_text('body{color:#333}')

    def write(self, name, value):
        (self.work / name).write_text(json.dumps(value, ensure_ascii=False))

    def build(self, landing=None, **kwargs):
        return mapper.build(self.work, landing or {'lineage': LINEAGE}, **kwargs)

    def evidence(self):
        # Synthetic bytes/receipt test only local-reference integrity. No actual vision is claimed by this unit test.
        jpeg = b'\xff\xd8synthetic-jpeg-fixture\xff\xd9'
        (self.work / 'capture.jpg').write_bytes(jpeg)
        image_sha = hashlib.sha256(jpeg).hexdigest()
        native = b'{"event":"fixture-of-exported-native-tool-result"}'
        (self.work / 'native-receipt.json').write_bytes(native)
        body = {'artifactDigest': mapper.workspace_digest(self.work),
            'screenshots': [{'path': 'capture.jpg', 'sha256': image_sha, 'viewport': 'celular'}],
            'vision': {'status': 'completed', 'provider': 'meta-ai', 'model': mapper.MODEL, 'inputSha256': [image_sha]},
            'visionReceipt': {'path': 'native-receipt.json', 'sha256': hashlib.sha256(native).hexdigest()}}
        self.write('review-evidence.json', body)
        return body

    def test_closed_shape_and_computed_score_ignore_extra_review_keys_and_claimed_pass(self):
        result = self.build(task_id='next-native-task', run_id='native-run')
        self.assertEqual(set(result), {'skillVersion', 'fonts', 'lineage', 'artifacts', 'review', 'taskId', 'runId'})
        self.assertEqual(set(result['review']), {'score', 'passed', 'criteria', 'observations', 'rounds', 'visualSkipped'})
        self.assertEqual(set(result['artifacts']), {'pagina', 'diseno'})
        self.assertEqual(result['review']['score'], 20)
        self.assertFalse(result['review']['passed'])
        self.assertTrue(result['review']['visualSkipped'])
        self.assertEqual([row['id'] for row in result['review']['criteria']], list(range(1, 11)))
        self.assertEqual(result['lineage'], LINEAGE)
        self.assertEqual(result['lineage']['taskId'], 'original-task-1')
        self.assertEqual(result['taskId'], 'next-native-task')
        self.assertNotIn('capturedDigest', result['review'])
        self.assertEqual(result['artifacts']['diseno']['_pilotReviewEvidence']['validation'], 'local-reference-integrity-only')

    def test_fuentes_alias_and_canonical_server_lineage_are_preserved_without_new_aliases(self):
        self.write('design.json', {'fuentes': {'heading': 'anton', 'body': 'dm-sans'}})
        supplied = {'betId': BET.upper(), 'strategyVersionId': VERSION.upper()}
        result = self.build({'ok': True, 'data': {'lineage': supplied}})
        self.assertEqual(result['fonts'], {'heading': 'anton', 'body': 'dm-sans'})
        self.assertEqual(result['lineage'], supplied)
        self.assertNotIn('hypothesisId', result['lineage'])
        self.write('design.json', {'fonts': {'heading': 'anton', 'body': 'dm-sans'}, 'fuentes': {'heading': 'different', 'body': 'dm-sans'}})
        with self.assertRaisesRegex(ValueError, 'disagree'):
            self.build()

    def test_original_critique_aliases_keep_ids_scores_and_corrections(self):
        self.write('review.json', {'criterios': [{'id': i, 'puntaje': 2, 'nota': 'Hallazgo real del ejemplo.'} for i in range(10, 0, -1)],
            'correcciones': ['Mantener la promesa.'], 'rondas': 1})
        result = self.build()
        self.assertEqual(result['review']['criteria'][0]['id'], 1)
        self.assertEqual(result['review']['criteria'][-1]['id'], 10)
        self.assertEqual(result['review']['score'], 20)
        self.assertIn('Mantener la promesa.', result['review']['observations'])
        self.assertFalse(result['review']['passed'])

    def test_reference_integrity_allows_computed_aesthetic_target_but_is_not_provider_authentication(self):
        self.evidence()
        result = self.build()
        self.assertTrue(result['review']['passed'])
        self.assertFalse(result['review']['visualSkipped'])
        self.assertEqual(result['artifacts']['diseno']['_pilotReviewEvidence']['validation'], 'local-reference-integrity-only')
        self.review['criteria'][0]['score'] = 1
        self.write('review.json', self.review)
        self.assertEqual(self.build()['review']['score'], 19)
        self.assertFalse(self.build()['review']['passed'])
        self.review['criteria'][0]['score'] = 2
        self.review['criteria'][1]['score'] = 0
        self.write('review.json', self.review)
        self.assertEqual(self.build()['review']['score'], 18)
        self.assertFalse(self.build()['review']['passed'])

    def test_missing_or_tampered_receipts_and_stale_capture_never_block_proposal_but_skip_vision(self):
        evidence = self.evidence()
        (self.work / 'native-receipt.json').unlink()
        self.assertTrue(self.build()['review']['visualSkipped'])
        self.evidence()
        (self.work / 'capture.jpg').write_bytes(b'\xff\xd8tampered\xff\xd9')
        self.assertFalse(self.build()['review']['passed'])
        self.evidence()
        (self.work / 'styles.css').write_text('body{color:red}')
        self.assertTrue(self.build()['review']['visualSkipped'])
        self.write('review-evidence.json', {**evidence, 'vision': {'status': 'completed', 'provider': 'other', 'model': 'different'}})
        self.assertFalse(self.build()['review']['passed'])

    def test_missing_review_can_save_a_proposal_without_invented_assessment(self):
        (self.work / 'review.json').unlink()
        result = self.build()
        self.assertEqual(result['review']['criteria'], [])
        self.assertEqual(result['review']['score'], 0)
        self.assertFalse(result['review']['passed'])
        self.assertTrue(result['review']['visualSkipped'])

    def test_round_limits_partial_duplicate_criteria_and_boolean_scores_are_rejected(self):
        for rounds in [-1, 3, 1.5, True]:
            self.write('review.json', {**self.review, 'rounds': rounds})
            with self.assertRaisesRegex(ValueError, 'rounds'):
                self.build()
        self.write('review.json', {**self.review, 'criteria': self.review['criteria'][:-1]})
        with self.assertRaisesRegex(ValueError, 'ten'):
            self.build()
        duplicate = [dict(row) for row in self.review['criteria']]
        duplicate[9]['id'] = 9
        self.write('review.json', {**self.review, 'criteria': duplicate})
        with self.assertRaisesRegex(ValueError, 'unique'):
            self.build()
        bad = [dict(row) for row in self.review['criteria']]
        bad[0]['score'] = True
        self.write('review.json', {**self.review, 'criteria': bad})
        with self.assertRaisesRegex(ValueError, 'score'):
            self.build()

    def test_32k_budget_credentials_and_wrong_server_lineage_fail_without_truncation(self):
        self.write('page.json', {'copy': 'x' * 33000})
        with self.assertRaisesRegex(ValueError, '32 KiB'):
            self.build()
        self.write('page.json', {'api_key': 'synthetic-only'})
        with self.assertRaisesRegex(ValueError, 'Credentials'):
            self.build()
        self.write('page.json', {'copy': 'safe'})
        with self.assertRaisesRegex(ValueError, 'did not succeed'):
            self.build({'ok': False, 'data': {'lineage': LINEAGE}})
        with self.assertRaisesRegex(ValueError, 'same canonical bet'):
            self.build({**LINEAGE, 'hypothesisId': VERSION})

    def test_cli_writes_private_metadata_and_only_summary_to_stdout(self):
        out = self.work / 'metadata.json'
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            result = mapper.main(['--workspace', str(self.work), '--landing', str(self.work / 'landing.json'), '--output', str(out)])
        self.assertEqual(result, 0)
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)
        self.assertEqual(json.loads(out.read_text())['lineage'], LINEAGE)
        self.assertNotIn('Una propuesta verificable', stream.getvalue())
        self.assertNotIn('files', json.loads(stream.getvalue()))


if __name__ == '__main__':
    unittest.main()
