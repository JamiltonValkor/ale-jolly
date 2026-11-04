"""Build closed-shape Landing metadata from local pilot artifacts, without network I/O.

Evidence references are optional integrity checks, not provider authentication.
The integrator must obtain receipts from real native history/journal and prove
vision in the canary. An unavailable/mismatched receipt never blocks saving the
proposal: it produces visualSkipped=true and passed=false.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any
import uuid

MAX_METADATA = 32 * 1024
MAX_INPUT = 256 * 1024
MODEL = 'muse-spark-1.3-contributor'
CRITERIA = ('Concept', 'First viewport at 390px', 'Typography hierarchy', 'Color',
            'Grid and composition transitions', 'Imagery', 'Components',
            'Rhythm and transitions', 'Proof and truth', 'Polish')
LINEAGE_KEYS = frozenset(('goalId', 'taskId', 'betId', 'hypothesisId', 'strategyVersionId', 'campaignId'))
CREDENTIAL_KEYS = frozenset(('api_key', 'apikey', 'access_token', 'refresh_token', 'authorization', 'password', 'model_api_key'))


def compact(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def reject_nonfinite(_value: str) -> None:
    raise ValueError('Non-finite JSON number.')


def read_json(path: Path, *, limit: int = MAX_INPUT) -> Any:
    if path.is_symlink() or not path.is_file():
        raise ValueError('Input must be an existing regular JSON file, not a symlink.')
    if path.stat().st_size > limit:
        raise ValueError('Input JSON exceeds the pilot size limit.')
    return json.loads(path.read_text(encoding='utf-8'), parse_constant=reject_nonfinite)


def object_value(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be a JSON object.')
    return value


def no_credentials(value: Any) -> None:
    if isinstance(value, dict):
        if any(str(k).lower() in CREDENTIAL_KEYS for k in value):
            raise ValueError('Credentials do not belong in Landing metadata.')
        for child in value.values():
            no_credentials(child)
    elif isinstance(value, list):
        for child in value:
            no_credentials(child)


def reference(value: Any, label: str, maximum: int = 120) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or '\n' in value or '\r' in value:
        raise ValueError(f'{label} must be a bounded nonempty reference.')
    return value


def canonical_lineage(payload: Any) -> dict[str, str]:
    record = object_value(payload, 'Landing response')
    if record.get('ok') is False or record.get('isError') is True:
        raise ValueError('The Landing read did not succeed.')
    if isinstance(record.get('data'), dict):
        record = record['data']
    lineage = object_value(record.get('lineage', record), 'Canonical lineage')
    if set(lineage) - LINEAGE_KEYS:
        raise ValueError('Canonical lineage contains unsupported fields; pass the server lineage object.')
    result = {k: reference(v, f'lineage.{k}') for k, v in lineage.items()}
    if not result.get('betId') or not result.get('strategyVersionId'):
        raise ValueError('Use canonical betId and strategyVersionId from the successful Landing read.')
    for key in ('betId', 'hypothesisId', 'strategyVersionId', 'campaignId'):
        if key in result:
            try:
                uuid.UUID(result[key])
            except (ValueError, AttributeError) as error:
                raise ValueError(f'lineage.{key} is not a canonical UUID.') from error
    if 'hypothesisId' in result and uuid.UUID(result['betId']) != uuid.UUID(result['hypothesisId']):
        raise ValueError('betId and hypothesisId must refer to the same canonical bet.')
    # Preserve the exact server object; adding aliases or changing case can cause a CAS/lineage conflict.
    return result


def fonts_of(design: dict[str, Any]) -> dict[str, str]:
    english, original = design.get('fonts'), design.get('fuentes')
    if english is not None and original is not None and english != original:
        raise ValueError('fonts and fuentes disagree; choose the catalog IDs used by the design.')
    fonts = object_value(english if english is not None else original, 'Design fonts/fuentes')
    if set(fonts) - {'heading', 'body', 'accent'}:
        raise ValueError('Fonts accepts only heading, body and optional accent catalog IDs.')
    result = {}
    for key in ('heading', 'body', 'accent'):
        if key == 'accent' and fonts.get(key) in (None, ''):
            continue
        value = reference(fonts.get(key), f'fonts.{key}')
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,119}', value):
            raise ValueError('Use exact catalog font IDs, not family display names or URLs.')
        result[key] = value
    return result


def criteria_of(review: dict[str, Any]) -> list[dict[str, Any]]:
    rows = review.get('criteria', review.get('criterios', []))
    if rows == []:
        return []  # Honest unavailable review; do not synthesize ten assessed scores.
    if not isinstance(rows, list) or len(rows) != 10:
        raise ValueError('A scored review must contain exactly the ten criterion IDs 1–10.')
    result = {}
    for row in rows:
        row = object_value(row, 'Review criterion')
        ident, score = row.get('id'), row.get('score', row.get('puntaje'))
        if type(ident) is not int or ident not in range(1, 11) or ident in result:
            raise ValueError('Review criterion IDs must be unique integers 1–10.')
        if isinstance(score, bool) or not isinstance(score, (int, float)) or score not in (0, 1, 2):
            raise ValueError('Each review criterion score must be 0, 1 or 2.')
        note = row.get('note', row.get('nota', ''))
        if not isinstance(note, str) or len(note) > 1200:
            raise ValueError('Each criterion note must be text of at most 1200 characters.')
        result[ident] = {'id': ident, 'name': CRITERIA[ident - 1], 'score': int(score), 'note': note}
    return [result[ident] for ident in range(1, 11)]


def workspace_digest(workspace: Path) -> str:
    hashes = {}
    for name in ('index.html', 'styles.css'):
        path = workspace / name
        if path.is_symlink() or not path.is_file():
            raise ValueError('Visual evidence needs complete local HTML/CSS files.')
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashlib.sha256(compact(hashes)).hexdigest()


def inspect_evidence(workspace: Path) -> tuple[bool, dict[str, Any]]:
    summary: dict[str, Any] = {'validation': 'local-reference-integrity-only', 'visionEvidencePresent': False}
    evidence_file = workspace / 'review-evidence.json'
    if not evidence_file.exists():
        return False, {**summary, 'limitation': 'No native vision evidence references were supplied.'}
    try:
        evidence = object_value(read_json(evidence_file), 'Review evidence')
        digest = evidence.get('artifactDigest')
        if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest) or digest != workspace_digest(workspace):
            raise ValueError('Capture digest does not match the local finalized HTML/CSS.')
        shots = evidence.get('screenshots')
        if not isinstance(shots, list) or not shots or len(shots) > 32:
            raise ValueError('Actual screenshot file references are missing.')
        hashes: set[str] = set()
        refs = []
        for shot in shots:
            shot = object_value(shot, 'Screenshot reference')
            path = Path(reference(shot.get('path'), 'Screenshot path', 1000))
            path = path if path.is_absolute() else workspace / path
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
                raise ValueError('Screenshot must be an existing regular JPEG file.')
            raw = path.read_bytes()
            sha = hashlib.sha256(raw).hexdigest()
            if not raw.startswith(b'\xff\xd8') or sha != shot.get('sha256'):
                raise ValueError('Screenshot bytes/digest do not match the capture reference.')
            hashes.add(sha)
            viewport = shot.get('viewport')
            if viewport is not None and (not isinstance(viewport, str) or viewport not in ('celular', 'escritorio', 'mobile', 'desktop')):
                raise ValueError('Screenshot viewport must match the captured mobile/desktop reference.')
            refs.append({'path': str(path), 'sha256': sha, 'viewport': viewport})
        vision = object_value(evidence.get('vision'), 'Vision evidence')
        if vision.get('status') != 'completed' or vision.get('provider') != 'meta-ai' or vision.get('model') != MODEL:
            raise ValueError('Completed same-Spark vision evidence is missing.')
        inspected = vision.get('inputSha256')
        if not isinstance(inspected, list) or not inspected or any(not isinstance(s, str) or s not in hashes for s in inspected):
            raise ValueError('Vision inputs do not match the screenshot references.')
        receipt = object_value(evidence.get('visionReceipt', vision.get('receipt')), 'Native receipt reference')
        path = Path(reference(receipt.get('path'), 'Native receipt path', 1000))
        path = path if path.is_absolute() else workspace / path
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 4 * 1024 * 1024:
            raise ValueError('A nonempty exported native receipt is required.')
        if hashlib.sha256(path.read_bytes()).hexdigest() != receipt.get('sha256'):
            raise ValueError('Native receipt digest does not match its file.')
        # No claim that a provider is authenticated by a JSON field: the canary audits the real native run separately.
        return True, {**summary, 'visionEvidencePresent': True, 'artifactDigest': digest, 'screenshots': refs,
                      'inspectedSha256': inspected, 'visionReceipt': {'path': str(path), 'sha256': receipt['sha256']}}
    except (ValueError, OSError, UnicodeError, json.JSONDecodeError) as error:
        return False, {**summary, 'limitation': str(error)}


def build(workspace: Path, landing: Any, task_id: str | None = None, run_id: str | None = None) -> dict[str, Any]:
    page = object_value(read_json(workspace / 'page.json'), 'Page artifact')
    design = object_value(read_json(workspace / 'design.json'), 'Design artifact')
    review_path = workspace / 'review.json'
    review = object_value(read_json(review_path), 'Review artifact') if review_path.exists() else {}
    for data in (page, design, review):
        no_credentials(data)
    criteria = criteria_of(review)
    rounds = review.get('rounds', review.get('rondas', 0))
    if type(rounds) is not int or not 0 <= rounds <= 2:
        raise ValueError('Review rounds must be an integer between 0 and 2.')
    observations = review.get('observations', review.get('correcciones', review.get('findings', [])))
    if not isinstance(observations, list) or len(observations) > 20:
        raise ValueError('Review observations must be an array of at most 20 entries.')
    observations = [item if isinstance(item, str) else compact(item).decode('utf-8') for item in observations]
    if any(len(item) > 1200 for item in observations):
        raise ValueError('Each review observation must fit the existing 1200-character contract.')
    vision, evidence = inspect_evidence(workspace)
    skipped = not vision or review.get('visualSkipped') is True or not criteria or rounds == 0
    score = sum(row['score'] for row in criteria)
    target = len(criteria) == 10 and score >= 18 and all(row['score'] > 0 for row in criteria) and all(criteria[i - 1]['score'] == 2 for i in (1, 8, 9))
    if skipped and len(observations) < 20:
        observations.append('Visual review is unavailable or incomplete; no completed visual QA is claimed.')
    if '_pilotReviewEvidence' in design:
        raise ValueError('The reserved pilot evidence field is written by the mapper, not by the design artifact.')
    result: dict[str, Any] = {'skillVersion': 'landing-coder-pilot/1', 'fonts': fonts_of(design),
        'lineage': canonical_lineage(landing), 'artifacts': {'pagina': page, 'diseno': {**design, '_pilotReviewEvidence': evidence}},
        'review': {'score': score, 'passed': bool(target and not skipped), 'criteria': criteria,
                   'observations': observations, 'rounds': rounds, 'visualSkipped': skipped}}
    if task_id is not None:
        result['taskId'] = reference(task_id, 'task-id')
    if run_id is not None:
        result['runId'] = reference(run_id, 'run-id')
    if len(compact(result)) > MAX_METADATA:
        raise ValueError('Metadata exceeds 32 KiB; shorten source artifacts explicitly, never truncate them.')
    return result


def write_private(path: Path, value: dict[str, Any]) -> None:
    if path.is_symlink():
        raise ValueError('Refusing to replace a metadata symlink.')
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.landing-metadata-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(compact(value) + b'\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--landing', type=Path, required=True, help='Private successful server read or canonical lineage JSON')
    parser.add_argument('--task-id')
    parser.add_argument('--run-id')
    parser.add_argument('--output', type=Path, required=True)
    opts = parser.parse_args(argv)
    try:
        metadata = build(opts.workspace, read_json(opts.landing), opts.task_id, opts.run_id)
        write_private(opts.output, metadata)
        print(json.dumps({'ok': True, 'output': str(opts.output), **{k: metadata['review'][k] for k in ('score', 'passed', 'visualSkipped')} }))
        return 0
    except (ValueError, OSError, UnicodeError) as error:
        print(json.dumps({'ok': False, 'message': str(error)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
