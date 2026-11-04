"""Deterministic landing source evidence; experience admission belongs to the MCL curator.

Inputs come from a trusted collector, never a tool/model argument. Native file
bytes establish generated artifacts only. Persisted version/lineage references
additionally require corroborated responses from the existing SaleADS CLI.
This module does no network I/O, inference, source lookup, or commercial writes.
"""
from __future__ import annotations

from base64 import b64decode, b64encode
from dataclasses import dataclass, field
from datetime import datetime
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat

from .client import canonical
from .schemas import record_schema

ROLE = 'disenador_landings'
ROLES = frozenset(record_schema('specialist-experience')['properties']['specialist_role']['enum'])
IDENTIFIER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
DIGEST = re.compile(r'^[a-f0-9]{64}$')
FILES = {'page.json': 'brief', 'design.json': 'visual_direction', 'index.html': 'html',
         'styles.css': 'css', 'review.json': 'critique', 'review-evidence.json': 'review_evidence',
         'correction.json': 'correction'}
CODE = frozenset({'index.html', 'styles.css'})
BINDINGS = ('owner_id', 'business_id', 'actor_role', 'native_task_id', 'native_run_id', 'session_id')


class LandingEvidenceError(ValueError):
    """Stable reason only; never include file contents or private responses."""


@dataclass(frozen=True)
class CollectorInputs:
    """Already collected with native/CLI identity, outside the model interface.

    A local file calling itself a receipt is not a CLI response. A producer must
    obtain landing/admission/version through the existing authenticated CLI
    adapter. Absent that producer, leave them empty and emit native refs only.
    feedback_sources must be original registered SourceEvents, with the exact
    landing-version reference corroborated by their trusted producer. There is
    deliberately no SourceById HTTP helper here.
    """

    binding: dict
    files: dict = field(default_factory=dict)
    landing: dict | None = None
    admission: dict | None = None
    version: dict | None = None
    manifest: dict | None = None
    feedback_sources: tuple = ()
    request: dict | None = None
    observed_request: dict | None = None
    native_manifest: dict | None = None
    submitted_manifest: dict | None = None
    normalization_ref: str | None = None


def collect_native(context, session, run):
    """Read only fixed files from the dispatcher's persisted native task workspace.

    workspace_path/kind must have been selected as native task columns by the
    terminal collector, never taken from run metadata or generated output. A
    model-written review-evidence.json is just another generated artifact.
    This default collector cannot attest persistence or authentic feedback; a
    trusted caller may separately add actual CLI/registered-source inputs.
    """
    path = run.get('workspace_path')
    if (context.get('actor_role') != ROLE or not isinstance(path, str) or not path
            or not isinstance(run.get('workspace_kind'), str) or not run['workspace_kind']):
        return None
    workspace = Path(path)
    if not workspace.is_absolute() or '..' in workspace.parts:
        raise LandingEvidenceError('landing_workspace_invalid')
    if any(parent.is_symlink() for parent in (workspace, *workspace.parents)) or not workspace.is_dir():
        raise LandingEvidenceError('landing_workspace_invalid')
    files = {}
    for name in FILES:
        candidate = workspace / name
        try:
            initial = candidate.lstat()
            if not stat.S_ISREG(initial.st_mode):
                raise LandingEvidenceError('landing_native_file_invalid')
            descriptor = os.open(candidate, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            continue
        except OSError as error:
            raise LandingEvidenceError('landing_native_file_unavailable') from error
        with os.fdopen(descriptor, 'rb') as source:
            before = os.fstat(source.fileno())
            maximum = 300 * 1024 if name in CODE else 32 * 1024
            if (not stat.S_ISREG(before.st_mode) or before.st_size > maximum
                    or (initial.st_dev, initial.st_ino) != (before.st_dev, before.st_ino)):
                raise LandingEvidenceError('landing_native_file_invalid')
            content = source.read(maximum + 1)
            after = os.fstat(source.fileno())
        if (len(content) > maximum or (before.st_ino, before.st_size, before.st_mtime_ns)
                != (after.st_ino, after.st_size, after.st_mtime_ns) or len(content) != after.st_size):
            raise LandingEvidenceError('landing_native_file_changed')
        files[name] = content
    return CollectorInputs(binding={**context, 'session_id': session}, files=files)


def native_snapshot(inputs, run, expected_workspace):
    """Freeze the current native workspace/hash observation at output staging."""
    if (str(run.get('latest_run_id')) != str(run.get('id'))
            or run.get('current_run_id') not in (None, run.get('id'))
            or run.get('workspace_path') != expected_workspace or not expected_workspace):
        raise LandingEvidenceError('landing_workspace_run_not_current')
    return {'workspace_kind': run.get('workspace_kind'), 'workspace_path': run['workspace_path'],
            'files': {name: {'sha256': sha256(content).hexdigest(), 'byteLength': len(content)}
                      for name, content in _files(inputs.files).items()}}


def artifact_digest(files):
    """Same canonical final-file digest as Landing's deterministic artifact contract."""
    return sha256(canonical({name: sha256(files[name]).hexdigest() for name in sorted(CODE)}).encode()).hexdigest()


def _response(value, command):
    if not isinstance(value, dict):
        raise LandingEvidenceError('landing_cli_response_missing')
    if 'ok' in value:
        if (value.get('ok') is not True or value.get('command', command) != command
                or not isinstance(value.get('data'), dict)):
            raise LandingEvidenceError('landing_cli_response_invalid')
        return value['data']
    return value


def _files(value):
    if not isinstance(value, dict) or not set(value) <= FILES.keys():
        raise LandingEvidenceError('landing_files_invalid')
    result, code_bytes, metadata_bytes = {}, 0, 0
    for name, content in value.items():
        if not isinstance(content, bytes):
            raise LandingEvidenceError('landing_native_bytes_required')
        try:
            content.decode('utf-8')
        except UnicodeError as error:
            raise LandingEvidenceError('landing_file_utf8_invalid') from error
        if name in CODE:
            code_bytes += len(content)
            if len(content) > 300 * 1024:
                raise LandingEvidenceError('landing_file_too_large')
        else:
            metadata_bytes += len(content)
        result[name] = content
    if code_bytes > 400 * 1024 or metadata_bytes > 32 * 1024:
        raise LandingEvidenceError('landing_artifacts_too_large')
    return result


def _version_files(version):
    values = version.get('files')
    if not isinstance(values, dict) or set(values) != CODE:
        raise LandingEvidenceError('landing_version_files_missing')
    result = {}
    for name, value in values.items():
        if isinstance(value, str):
            result[name] = value.encode('utf-8')
            continue
        if not isinstance(value, dict) or value.get('encoding') != 'base64':
            raise LandingEvidenceError('landing_version_files_invalid')
        try:
            content = b64decode(value.get('content', ''), validate=True)
        except (ValueError, TypeError) as error:
            raise LandingEvidenceError('landing_version_files_invalid') from error
        if (b64encode(content).decode() != value.get('content') or type(value.get('byteLength')) is not int
                or len(content) != value['byteLength'] or sha256(content).hexdigest() != value.get('sha256')):
            raise LandingEvidenceError('landing_version_files_invalid')
        result[name] = content
    return _files(result)


def _manifest(manifest, files, persisted):
    if manifest is None:
        return
    if not isinstance(manifest, dict):
        raise LandingEvidenceError('landing_manifest_invalid')
    # Claims may corroborate bytes/receipts; they never certify themselves.
    declared = manifest.get('files', {})
    if not isinstance(declared, dict) or not set(declared) <= files.keys():
        raise LandingEvidenceError('landing_manifest_files_mismatch')
    for name, value in declared.items():
        if (not isinstance(value, dict) or value.get('sha256') != sha256(files[name]).hexdigest()
                or type(value.get('byteLength')) is not int or value['byteLength'] != len(files[name])):
            raise LandingEvidenceError('landing_manifest_files_mismatch')
    for key in ('landingId', 'n', 'artifactDigest', 'requestId', 'lineage'):
        if key in manifest and (persisted is None or manifest[key] != persisted[key]):
            raise LandingEvidenceError('landing_manifest_receipt_mismatch')


def checked_file_manifest(value):
    if not isinstance(value, dict) or not set(value) <= FILES.keys():
        raise LandingEvidenceError('landing_native_manifest_invalid')
    code, documents = 0, 0
    for name, item in value.items():
        if (not isinstance(item, dict) or set(item) != {'sha256', 'byteLength'}
                or not isinstance(item['sha256'], str) or not DIGEST.fullmatch(item['sha256'])
                or type(item['byteLength']) is not int or item['byteLength'] < 0):
            raise LandingEvidenceError('landing_native_manifest_invalid')
        if name in CODE:
            code += item['byteLength']
            if item['byteLength'] > 300 * 1024:
                raise LandingEvidenceError('landing_native_manifest_invalid')
        else:
            documents += item['byteLength']
    if code > 400 * 1024 or documents > 32 * 1024:
        raise LandingEvidenceError('landing_native_manifest_invalid')
    return value


def freeze_request_observation(request, files=None, *, projected_metadata=None, projection_ref=None):
    """Hash-only observation of the helper's actual in-process HTTP input."""
    raw = request_code_files(request)
    if files is not None and raw != {name: files[name] for name in CODE}:
        raise LandingEvidenceError('landing_request_native_files_mismatch')
    metadata = request.get('metadata', {})
    if not isinstance(metadata, dict):
        raise LandingEvidenceError('landing_request_metadata_invalid')
    artifacts = metadata.get('artifacts', {})
    if not isinstance(artifacts, dict):
        raise LandingEvidenceError('landing_request_artifacts_invalid')
    documents = {}
    if projected_metadata is not None and any(canonical(metadata.get(key)) != canonical(projected_metadata.get(key))
                                               for key in ('artifacts', 'review', 'fonts')):
        raise LandingEvidenceError('landing_generated_projection_mismatch')
    for name, filename in (('pagina', 'page.json'), ('diseno', 'design.json'), ('review', 'review.json')):
        declared = metadata.get('review') if name == 'review' else artifacts.get(name)
        if declared is None:
            continue
        if files is not None and projected_metadata is None and canonical(declared) != canonical(json_document(files.get(filename))):
            raise LandingEvidenceError('landing_generated_document_mismatch')
        documents[name] = sha256(canonical(declared).encode()).hexdigest()
    return {'schema_version': 'landing-cli-request-observation/1',
            **{key: request.get(key) for key in ('client_request_id', 'expected_latest_n')},
            **{key: request[key].lower() if isinstance(request.get(key), str) else request.get(key) for key in ('business_id', 'landing_id')},
            'files': {name: {'sha256': sha256(raw[name]).hexdigest(), 'byteLength': len(raw[name])} for name in sorted(CODE)},
            'metadata': {key: metadata[key] for key in ('taskId', 'runId', 'lineage') if key in metadata},
            'metadata_sha256': sha256(canonical(metadata).encode()).hexdigest(),
            'metadata_projection_ref': projection_ref,
            'generated_document_sha256': documents}


def admission_identity(context, run, request, receipt):
    return sha256(canonical([
        context['owner_id'], context['business_id'], context['actor_role'], run.get('native_board'),
        context['native_task_id'], context['native_run_id'], receipt['landingId'], receipt['n'],
        receipt['artifactDigest'], {name: request['files'][name]['sha256'] for name in sorted(CODE)},
    ]).encode()).hexdigest()


def checked_admission(context, run, request, receipt, native_manifest):
    """A real ACK can be checkpointed before reads, without claiming corroboration."""
    if (not isinstance(request, dict) or request.get('schema_version') != 'landing-cli-request-observation/1'
            or not isinstance(receipt, dict) or not isinstance(request.get('business_id'), str)
            or request['business_id'].lower() != context['business_id'] or receipt.get('businessId') != context['business_id']
            or not isinstance(receipt.get('landingId'), str) or not UUID.fullmatch(receipt['landingId'])
            or not isinstance(request.get('landing_id'), str) or request['landing_id'].lower() != receipt['landingId']
            or receipt.get('origin') != 'hermes' or receipt.get('createdBy') != 'agent'
            or type(receipt.get('n')) is not int or receipt['n'] < 1
            or type(request.get('expected_latest_n')) is not int or request['expected_latest_n'] < 0
            or request['expected_latest_n'] + 1 != receipt['n']
            or request.get('client_request_id') != receipt.get('requestId')
            or not isinstance(receipt.get('requestId'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', receipt['requestId'])
            or not isinstance(receipt.get('artifactDigest'), str) or not DIGEST.fullmatch(receipt['artifactDigest'])
            or checked_file_manifest(request.get('files')) != {name: native_manifest[name] for name in CODE}):
        raise LandingEvidenceError('landing_request_receipt_mismatch')
    metadata = request.get('metadata', {})
    if not isinstance(metadata, dict):
        raise LandingEvidenceError('landing_request_metadata_invalid')
    for key, native in (('taskId', 'native_task_id'), ('runId', 'native_run_id')):
        if key in metadata and str(metadata[key]) != context[native]:
            raise LandingEvidenceError('landing_request_native_selector_mismatch')
    try:
        created = datetime.fromisoformat(receipt['createdAt'].replace('Z', '+00:00'))
        if created.tzinfo is None or type(run.get('started_at')) is not int or created.timestamp() < run['started_at']:
            raise LandingEvidenceError('landing_admission_predates_native_run')
    except (KeyError, TypeError, AttributeError, ValueError) as error:
        raise LandingEvidenceError('landing_admission_time_invalid') from error


def _persisted(context, run, inputs, files, native_manifest):
    supplied = (inputs.landing, inputs.admission, inputs.version)
    if not any(value is not None for value in supplied):
        return None
    if not all(value is not None for value in supplied) or not CODE <= native_manifest.keys():
        raise LandingEvidenceError('landing_cli_corroboration_incomplete')
    landing = _response(inputs.landing, 'saleads_landing_get')
    receipt = _response(inputs.admission, 'saleads_landing_submit_version')
    version = _response(inputs.version, 'saleads_landing_get_version')
    landing_id = landing.get('id', landing.get('landingId'))
    if (not isinstance(landing_id, str) or not UUID.fullmatch(landing_id)
            or landing.get('businessId') != context['business_id'] or receipt.get('businessId') != context['business_id']):
        raise LandingEvidenceError('landing_business_mismatch')
    if receipt.get('landingId') != landing_id or version.get('landingId') != landing_id:
        raise LandingEvidenceError('landing_id_mismatch')
    if any(value.get('origin') != 'hermes' for value in (landing, receipt, version)):
        raise LandingEvidenceError('landing_origin_mismatch')
    final_files = _version_files(version)
    n, digest = receipt.get('n'), artifact_digest(final_files)
    if type(n) is not int or n < 1 or type(version.get('n')) is not int or version['n'] != n:
        raise LandingEvidenceError('landing_version_mismatch')
    if receipt.get('artifactDigest') != digest or version.get('artifactDigest') != digest:
        raise LandingEvidenceError('landing_digest_mismatch')
    request_id = receipt.get('requestId')
    if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', request_id):
        raise LandingEvidenceError('landing_request_id_invalid')
    lineage = landing.get('lineage')
    if (not isinstance(lineage, dict) or any(not isinstance(lineage.get(key), str)
            or not UUID.fullmatch(lineage[key]) for key in ('betId', 'hypothesisId', 'strategyVersionId'))
            or lineage['betId'] != lineage['hypothesisId']):
        raise LandingEvidenceError('landing_canonical_lineage_invalid')
    documents = {}
    request = inputs.observed_request
    if request is None and inputs.request is not None:
        request = freeze_request_observation(inputs.request, files)
    if request is None:
        if not CODE <= files.keys() or final_files != {name: files[name] for name in CODE}:
            raise LandingEvidenceError('landing_digest_mismatch')
    else:
        submitted = checked_file_manifest(inputs.submitted_manifest) if inputs.submitted_manifest is not None else {name: native_manifest[name] for name in CODE}
        checked_admission(context, run, request, receipt, submitted)
        if version.get('createdBy') != 'agent':
            raise LandingEvidenceError('landing_request_receipt_mismatch')
        try:
            if datetime.fromisoformat(receipt['createdAt'].replace('Z', '+00:00')) != datetime.fromisoformat(version['createdAt'].replace('Z', '+00:00')):
                raise LandingEvidenceError('landing_admission_time_mismatch')
        except (KeyError, TypeError, AttributeError, ValueError) as error:
            raise LandingEvidenceError('landing_admission_time_mismatch') from error
        metadata = request['metadata']
        declared_lineage = metadata.get('lineage', {})
        if not isinstance(declared_lineage, dict) or any(lineage.get(key) != value for key, value in declared_lineage.items()):
            raise LandingEvidenceError('landing_request_lineage_mismatch')
        stored_artifacts = version.get('artifacts', {})
        if not isinstance(stored_artifacts, dict):
            raise LandingEvidenceError('landing_request_artifacts_invalid')
        for name, expected_hash in request['generated_document_sha256'].items():
            if name not in {'pagina', 'diseno', 'review'}:
                raise LandingEvidenceError('landing_generated_document_mismatch')
            stored = version.get('review') if name == 'review' else stored_artifacts.get(name)
            if (sha256(canonical(stored).encode()).hexdigest() != expected_hash
                    or name == 'review' and sha256(canonical(receipt.get('review')).encode()).hexdigest() != expected_hash):
                raise LandingEvidenceError('landing_generated_document_mismatch')
            documents[name] = expected_hash
    return {'landingId': landing_id, 'n': n, 'artifactDigest': digest, 'requestId': request_id,
            'lineage': {key: lineage[key] for key in ('betId', 'hypothesisId', 'strategyVersionId')},
            'native_generated_sha256': {name: native_manifest[name]['sha256'] for name in sorted(CODE)},
            'submitted_sha256': {name: (request['files'][name]['sha256'] if request is not None else native_manifest[name]['sha256']) for name in sorted(CODE)},
            'persisted_sha256': {name: sha256(final_files[name]).hexdigest() for name in sorted(CODE)},
            'server_finalized': any((request['files'][name]['sha256'] if request is not None else native_manifest[name]['sha256']) != sha256(final_files[name]).hexdigest() for name in CODE),
            'finalized_before_submit': request is not None and any(native_manifest[name]['sha256'] != request['files'][name]['sha256'] for name in CODE),
            'generated_document_author': 'root_projection' if request is not None and request.get('metadata_projection_ref') else 'native_copy',
            'generated_documents': documents}


def json_document(raw):
    """A generated planning/review document, never business proof."""
    if not isinstance(raw, bytes):
        raise LandingEvidenceError('landing_generated_document_missing')
    return json.loads(raw.decode('utf-8'))


def request_code_files(request):
    """Decode only actual in-process CLI request descriptors, not a receipt file."""
    if not isinstance(request, dict):
        raise LandingEvidenceError('landing_request_invalid')
    return _version_files(request)


@dataclass(frozen=True)
class LandingExperience:
    """References/evidence description only; never a generated lesson or candidate."""

    refs: tuple
    evidence: dict
    binding: dict

    @classmethod
    def extract(cls, context, session, run, text, inputs):
        if ROLE not in ROLES or context.get('actor_role') != ROLE:
            raise LandingEvidenceError('landing_role_required')
        if (not isinstance(inputs, CollectorInputs) or any(inputs.binding.get(key) != context.get(key) for key in BINDINGS)
                or session != context.get('session_id')):
            raise LandingEvidenceError('landing_native_binding_mismatch')
        if (run.get('tenant'), run.get('assignee'), run.get('profile'), str(run.get('task_id')), str(run.get('id'))) != (
                context['business_id'], ROLE, ROLE, context.get('native_task_id'), context.get('native_run_id')):
            raise LandingEvidenceError('landing_native_run_mismatch')
        if ((run.get('status'), run.get('outcome')) != ('done', 'completed') or run.get('task_status') != 'done'
                or type(run.get('ended_at')) is not int):
            raise LandingEvidenceError('landing_native_run_not_terminal')
        if any(not isinstance(context.get(key), str) or not IDENTIFIER.fullmatch(context[key])
               for key in ('native_task_id', 'native_run_id', 'session_id')):
            raise LandingEvidenceError('landing_native_reference_invalid')
        files = _files(inputs.files)
        native_manifest = (checked_file_manifest(inputs.native_manifest) if inputs.native_manifest is not None
                           else {name: {'sha256': sha256(body).hexdigest(), 'byteLength': len(body)} for name, body in files.items()})
        persisted = _persisted(context, run, inputs, files, native_manifest)
        _manifest(inputs.manifest, files, persisted)
        refs, artifacts = [], {}
        for name in sorted(native_manifest):
            ref = (f"native-landing-artifact:{context['native_task_id']}/{context['native_run_id']}/{name}"
                   f"@sha256:{native_manifest[name]['sha256']}")
            refs.append(ref)
            artifacts[FILES[name]] = ref
        evidence = {'schema_version': 'landing-experience-evidence/1', 'artifacts': artifacts,
                    'result_ref': 'native-result-sha256:' + sha256(text.encode()).hexdigest(),
                    'terminal_outcome': run['outcome'], 'persisted_version': None, 'feedback_source_refs': []}
        if persisted is not None:
            version_ref = (f"saleads-landing-version:{persisted['landingId']}/{persisted['n']}"
                           f"@sha256:{persisted['artifactDigest']}")
            evidence['persisted_version'] = {**persisted, 'ref': version_ref}
            refs.extend([version_ref, 'saleads-bet:' + persisted['lineage']['betId'],
                         'saleads-strategy-version:' + persisted['lineage']['strategyVersionId']])
            if inputs.request is not None or inputs.observed_request is not None:
                for name, digest in persisted['persisted_sha256'].items():
                    refs.append(f"saleads-landing-file:{persisted['landingId']}/{persisted['n']}/{name}@sha256:{digest}")
                for name, digest in persisted['generated_documents'].items():
                    kind = 'saleads-landing-review:' if name == 'review' else 'saleads-landing-artifact:'
                    refs.append(f"{kind}{persisted['landingId']}/{persisted['n']}/{name}@sha256:{digest}")
                observed = inputs.observed_request or freeze_request_observation(inputs.request, files)
                evidence['admission_identity'] = admission_identity(context, run, observed, persisted)
                if observed.get('metadata_projection_ref'):
                    refs.append(observed['metadata_projection_ref'])
                if inputs.normalization_ref:
                    refs.append(inputs.normalization_ref)
        for source in inputs.feedback_sources:
            if (persisted is None or not isinstance(source, dict)
                    or source.get('schema_version') != 'source-event/1'
                    or (source.get('owner_id'), source.get('business_id'), source.get('source_kind'), source.get('purpose'))
                    != (context['owner_id'], context['business_id'], 'owner_message', 'business_work')
                    or source.get('author') != {'kind': 'owner', 'id': context['owner_id']}
                    or not isinstance(source.get('content'), str)
                    or sha256(source['content'].encode()).hexdigest() != source.get('content_sha256')
                    or not isinstance(source.get('event_id'), str) or not IDENTIFIER.fullmatch(source['event_id'])
                    or version_ref not in source.get('refs', [])):
                raise LandingEvidenceError('landing_feedback_not_authentic_or_bound')
            ref = 'source-event:' + source['event_id']
            refs.append(ref)
            evidence['feedback_source_refs'].append(ref)
        # SourceEventV1 allows 30 refs; scoped native capture contributes up to five more.
        refs = tuple(sorted(set(refs)))
        if len(refs) > 25 or any(len(ref) > 2048 for ref in refs) or len(canonical(evidence)) > 8000:
            raise LandingEvidenceError('landing_evidence_too_large')
        return cls(refs, evidence, {key: context[key] for key in BINDINGS})

    def matches(self, context, text):
        return (self.binding == {key: context.get(key) for key in BINDINGS}
                and self.evidence.get('result_ref') == 'native-result-sha256:' + sha256(text.encode()).hexdigest())

    def saved(self):
        return {'refs': list(self.refs), 'evidence': self.evidence, 'binding': self.binding}

    @classmethod
    def restore(cls, value, context, text):
        """Restore only the collector's private pending snapshot for ACK recovery."""
        try:
            size = len(canonical(value.get('evidence'))) if isinstance(value, dict) else 8001
        except (TypeError, ValueError) as error:
            raise LandingEvidenceError('landing_saved_capture_invalid') from error
        if (not isinstance(value, dict) or set(value) != {'refs', 'evidence', 'binding'}
                or not isinstance(value['refs'], list) or len(value['refs']) > 25
                or any(not isinstance(ref, str) or len(ref) > 2048 or any(ord(char) < 32 for char in ref) for ref in value['refs'])
                or not isinstance(value['evidence'], dict) or size > 8000
                or value['evidence'].get('schema_version') != 'landing-experience-evidence/1'):
            raise LandingEvidenceError('landing_saved_capture_invalid')
        result = cls(tuple(value['refs']), value['evidence'], value['binding'])
        if not result.matches(context, text):
            raise LandingEvidenceError('landing_saved_capture_binding_mismatch')
        return result

    def header(self):
        return ('Corroborated landing references (file bytes/persistence only; generated critique is not owner testimony, '
                'factual proof, publication, sales, or a causal conversion result). Curator decides any experience/candidate; '
                'a technical specialist result supports craft experience only.\n' + canonical(self.evidence) + '\n')
