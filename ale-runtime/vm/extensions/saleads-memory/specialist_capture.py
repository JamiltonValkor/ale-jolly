"""Stage native specialist output, admitting it only after read-only terminal run proof."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
import hmac
import importlib.util
from itertools import islice
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from urllib.parse import urlsplit

from .client import BrainClient, MemoryFailure, canonical, read_token
from .dispatch import CurationTrigger
from .context import same_profile_session
from .schemas import record_schema
from .landing_experience import (CollectorInputs, LandingExperience, LandingEvidenceError, collect_native,
    native_snapshot, request_code_files, freeze_request_observation, checked_admission, checked_file_manifest, admission_identity, artifact_digest)

ROOT = Path('/opt/data')
MAX_PENDING_BYTES = 1048576
MAX_RESPONSE_CHARS = 131072
CHUNK_CHARS = 12000  # Even JSON control-character escaping plus bounded refs stays below the request cap.
PROFILES = frozenset(record_schema('specialist-experience')['properties']['specialist_role']['enum'])
NAME = re.compile(r'^[a-f0-9]{64}\.json$')
BOARD = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')  # Official pinned Hermes board slug contract.
CLI_PROOF_FIELDS = ('schema_version', 'context', 'session_id', 'text_sha256', 'worker_binding', 'landing_snapshot',
                    'landing_admission_identity', 'landing_cli_observation', 'landing_native_capture', 'landing_capture',
                    'source_native_title', 'landing_cli_pending', 'registered_ids', 'landing_native_source', 'landing_cli_validations')
MAX_METADATA_BYTES = 262144
MAX_HANDOFF_BYTES = 16384
HANDOFF_FIELDS = ('method', 'observed_errors_corrections', 'practical_lesson', 'queries_performed',
    'facts_sourced', 'sources_dated', 'missing_coverage', 'risks', 'assumptions', 'inferences',
    'hypotheses', 'angle_candidates', 'buyer_context', 'competitors_direct',
    'competitors_reference_vs_alternative', 'local_feasibility', 'next_question',
    'retrieved_references_applied', 'seasonal_moments_next_8w')
PRIVATE_FIELD = re.compile(r'(?i)(prompt|instruction|secret|token|password|credential|authorization|cookie|'
    r'api[_-]?key|private[_-]?key|worker|session|owner_id|business_id|native_task|native_run|goal_id|goal_revision|headers|environment)')
PRIVATE_BINDINGS = frozenset({'actor_role', 'profile', 'tenant', 'work_id', 'input', 'request',
    'messages', 'conversation', 'chat', 'system', 'developer', 'env'})
PRIVATE_VALUE = re.compile(r'(?i)(\bLLM_[A-Za-z0-9_]{12,}|\bsk-[A-Za-z0-9_-]{12,}|'
    r'\bBearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN[^\n]*PRIVATE KEY-----|'
    r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|'
    r'(?:api[_-]?key|access[_-]?token|refresh[_-]?token|\btoken|password|authorization|client_secret|'
    r'x-goog-signature|x-amz-signature|x-amz-security-token)\s*[:=]\s*\S+)')


def episode_for(context):
    return 'native-result-' + sha256(canonical([context['owner_id'], context['business_id'], context['native_task_id'], context['native_run_id']]).encode()).hexdigest()


def handoff_projection(run, context, text):
    """Only generated handoff fields; routing, prompts and credentials are never material."""
    metadata = run.get('_metadata')
    if not isinstance(metadata, dict):
        return None
    for key, expected in (('business_id', context['business_id']), ('native_task_id', context['native_task_id']),
                          ('native_run_id', context['native_run_id'])):
        if key in metadata and str(metadata[key]) != str(expected):
            return None
    limits = {'nodes': 0, 'truncated': False}
    def clean(value, depth=0):
        limits['nodes'] += 1
        if depth > 4 or limits['nodes'] > 256:
            limits['truncated'] = True
            return None
        if isinstance(value, str):
            if PRIVATE_VALUE.search(value):
                return None
            if len(value) > 4000:
                limits['truncated'] = True
            return value[:4000] if value.strip() else None
        if isinstance(value, list):
            limits['truncated'] |= len(value) > 24
            return [v for item in value[:24] if (v := clean(item, depth + 1)) is not None] or None
        if isinstance(value, dict):
            result = {}
            for key in sorted(key for key in value if isinstance(key, str)):
                if key in PRIVATE_BINDINGS or PRIVATE_FIELD.search(key):
                    continue
                if len(result) >= 32:
                    limits['truncated'] = True
                    break
                child = clean(value[key], depth + 1)
                if child is not None:
                    result[key] = child
            return result or None
        if type(value) in (int, bool) or isinstance(value, float) and math.isfinite(value):
            return value
        return None
    def envelope(values):
        return {'generated_handoff': values, 'capture': {'truncated': limits['truncated'],
            'omission_policy': 'Only generated handoff fields; identity, worker, prompt, instruction and credential fields/values excluded.'}}
    values = {}
    for field in HANDOFF_FIELDS:
        if field not in metadata or not isinstance(metadata[field], (str, list, dict)):
            continue
        value = clean(metadata[field])
        while value is not None and len(canonical(envelope({**values, field: value})).encode()) > MAX_HANDOFF_BYTES:
            limits['truncated'] = True
            if isinstance(value, list):
                value = value[:-1] or None
            elif isinstance(value, dict):
                value = dict(list(value.items())[:-1]) or None
            elif isinstance(value, str):
                value = value[:len(value) // 2] if len(value) > 32 else None
            else:
                value = None
        if value is not None:
            values[field] = value
    if not values:
        return None
    def novel(value):
        if isinstance(value, dict):
            return any(novel(v) for v in value.values())
        if isinstance(value, list):
            return any(novel(v) for v in value)
        return bool(str(value).strip()) and str(value).strip() not in text
    if not novel(values):
        return None
    return canonical(envelope(values))


def _private_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _private_create(path, value):
    """Publish the first sanitized handoff atomically; never replace its meaning."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix='.handoff-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _read(path):
    try:
        if not NAME.fullmatch(path.name) or path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_PENDING_BYTES:
            return None
        value = json.loads(path.read_text())
        if not isinstance(value, dict) or value.get('schema_version') != 'pending-specialist-result/1':
            return None
        return value
    except (OSError, ValueError):
        return None


def _cli_mac(home, value):
    token = read_token(home, collector=True)
    proof = {key: value.get(key) for key in CLI_PROOF_FIELDS}
    return hmac.new(token.encode(), canonical(proof).encode(), sha256).hexdigest()


def _verified_cli_record(home, value):
    signature = value.get('landing_cli_mac')
    try:
        return isinstance(signature, str) and re.fullmatch(r'[a-f0-9]{64}', signature) and hmac.compare_digest(signature, _cli_mac(home, value))
    except (TypeError, ValueError):
        return False


def _write_cli_record(home, path, value):
    value['landing_cli_mac'] = _cli_mac(home, value)
    if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_PENDING_BYTES:
        raise LandingEvidenceError('landing_cli_checkpoint_too_large')
    _private_write(path, value)


def _designer_database(root, pin):
    """Managed subset of native board paths, from a frozen dispatcher pin only.

    Hermes' kanban_db_path() is ambient/contextual and accepts arbitrary custom
    pins. Reconciliation has no worker environment, so it must validate the
    saved pin against source-verified canonical layouts without resolving a
    different board or mutating process environment.
    """
    if not isinstance(pin, str) or not pin or not root.is_absolute():
        raise OSError('Native board pin unavailable')
    path = Path(pin)
    if not path.is_absolute() or '..' in path.parts:
        raise OSError('Native board pin invalid')
    relative = path.relative_to(root)
    parts = relative.parts
    if parts == ('kanban.db',):
        board = 'default'
    elif (len(parts) == 4 and parts[:2] == ('kanban', 'boards') and parts[3] == 'kanban.db'
          and parts[2] != 'default' and BOARD.fullmatch(parts[2])):
        board = parts[2]
    else:
        raise OSError('Native board pin outside managed layout')
    if any(parent.is_symlink() for parent in (path, *path.parents)) or not path.is_file():
        raise OSError('Native board pin not a regular file')
    return path, board


def _events(root, task, *, database_pin):
    """Official read API; event payload storage is Hermes' contract, not ours."""
    from hermes_cli import kanban_db
    path, _board = _designer_database(root, database_pin)
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
        db.row_factory = sqlite3.Row
        return kanban_db.list_events(db, task)


def _worker_binding_matches(root, context, session, run, binding):
    if not isinstance(binding, dict) or binding.get('schema_version') != 'native-landing-worker-binding/1':
        return False
    keys = ('owner_id', 'business_id', 'actor_role', 'native_task_id', 'native_run_id')
    if (any(binding.get('context', {}).get(key) != context.get(key) for key in keys)
            or not same_profile_session(root / 'profiles' / context['actor_role'], binding.get('session_id'), session)
            or binding.get('workspace_path') != run.get('workspace_path')
            or binding.get('kanban_db') != run.get('kanban_db')
            or binding.get('started_at') != run.get('started_at')
            or str(run.get('latest_run_id')) != str(run['id'])
            or run.get('worker_pid') not in (None, binding.get('worker_pid'))):
        return False
    events = {event.id: event for event in _events(root, context['native_task_id'], database_pin=binding.get('kanban_db'))
              if event.task_id == context['native_task_id'] and event.run_id == run['id']}
    claim, spawn = events.get(binding.get('claim_event_id')), events.get(binding.get('spawn_event_id'))
    return bool(claim and claim.kind == 'claimed' and spawn and spawn.kind in {'spawned', 'worker_registered'}
                and isinstance(spawn.payload, dict) and spawn.payload.get('pid') == binding.get('worker_pid'))


def _native_run(root, context, session, *, terminal=True, worker_binding=None, check_session=True, database_pin=None):
    """No DDL, writes, inferred success, fallback task, or caller-selected database."""
    if not str(context.get('native_run_id', '')).isdigit():
        return None
    try:
        if context['actor_role'] == 'disenador_landings':
            pin = database_pin if not check_session else worker_binding.get('kanban_db') if isinstance(worker_binding, dict) else None
            path, board = _designer_database(root, pin)
        else:
            path, board = root / 'kanban.db', None
            if not path.is_file() or path.is_symlink():
                return None
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
            db.row_factory = sqlite3.Row
            columns = {column['name'] for column in db.execute('PRAGMA table_info(tasks)')}
            run_columns = {column['name'] for column in db.execute('PRAGMA table_info(task_runs)')}
            workspace = ',t.workspace_kind,t.workspace_path,t.current_run_id' if {'workspace_kind', 'workspace_path', 'current_run_id'} <= columns else ''
            worker = ',r.claim_lock,r.worker_pid' if {'claim_lock', 'worker_pid'} <= run_columns else ''
            row = db.execute('SELECT t.tenant,t.assignee,t.status AS task_status,t.title,r.task_id,r.id,r.profile,r.status,r.outcome,r.started_at,r.ended_at,r.metadata,r.summary,(SELECT MAX(latest.id) FROM task_runs latest WHERE latest.task_id=t.id) AS latest_run_id' + workspace + worker + ' FROM tasks t JOIN task_runs r ON r.task_id=t.id WHERE t.id=? AND r.id=?',
                (context['native_task_id'], int(context['native_run_id']))).fetchone()
        row = dict(row) if row is not None else None
        if row is not None and board is not None:
            row.update(kanban_db=str(path), native_board=board)
        if row is None or (row['tenant'], row['assignee'], row['profile']) != (context['business_id'], context['actor_role'], context['actor_role']):
            return None
        if terminal and ((row['status'], row['outcome']) not in {('done', 'completed'), ('blocked', 'blocked')} or row['task_status'] not in {'done', 'archived', 'blocked'}):
            return None
        if terminal and (type(row['ended_at']) is not int or type(row['started_at']) is not int or row['ended_at'] < row['started_at']):
            return None
        if not check_session:
            return dict(row)
        if context['actor_role'] == 'disenador_landings':
            return dict(row) if _worker_binding_matches(root, context, session, dict(row), worker_binding) else None
        raw = row['metadata'] or '{}'
        if not isinstance(raw, str) or len(raw.encode()) > MAX_METADATA_BYTES:
            return None
        metadata = json.loads(raw)
        if not isinstance(metadata, dict) or not isinstance(metadata.get('worker_session_id'), str) or not metadata['worker_session_id'] or not same_profile_session(root / 'profiles' / context['actor_role'], metadata['worker_session_id'], session):
            return None
        return {**dict(row), '_metadata': metadata}
    except (sqlite3.Error, OSError, ValueError, KeyError, TypeError, ImportError, AttributeError, RuntimeError):
        return None


def terminal_run(root, context, session, *, worker_binding=None):
    return _native_run(root, context, session, worker_binding=worker_binding)


def _url(value):
    if not isinstance(value, str) or len(value.encode(errors='replace')) > 2048 or any(ord(char) < 32 for char in value):
        return None
    try:
        parsed = urlsplit(value)
        return value if parsed.scheme in {'http', 'https'} and parsed.hostname and not parsed.username and not parsed.password else None
    except ValueError:
        return None


def search_evidence(home, context, session):
    """Only actual hosted-search receipts for this exact native task/run/session qualify."""
    if context['actor_role'] != 'investigador':
        return [], []
    directory = home / 'plugin-data/saleads-meta-search/receipts'
    citations, methods, seen = set(), [], set()
    try:
        for path in islice(directory.iterdir(), 1000):
            if not NAME.fullmatch(path.name) or path.is_symlink() or not path.is_file() or path.stat().st_size > 32768:
                continue
            try:
                value = json.loads(path.read_text())
            except (OSError, ValueError):
                continue
            if not isinstance(value, dict) or value.get('status') != 'completed' or value.get('model') != 'muse-spark-1.3-contributor' or type(value.get('search_calls')) is not int or value['search_calls'] < 1:
                continue
            expected = (context['business_id'], context['native_task_id'], context['native_run_id'], session)
            actual = (value.get('business_id'), value.get('native_task_id'), str(value.get('native_run_id')), value.get('session_id'))
            if actual[:3] != expected[:3] or not same_profile_session(home, actual[3], session) or not isinstance(value.get('response_id'), str) or len(value['response_id']) > 200:
                continue
            if value['response_id'] in seen:
                continue
            urls = [_url(item.get('url')) for item in value.get('citations', []) if isinstance(item, dict)] if isinstance(value.get('citations'), list) else []
            if not any(urls):
                continue
            citations.update(url for url in urls if url)
            methods.append({'response_id': value['response_id'], 'search_calls': value['search_calls'], 'model': value['model']})
            seen.add(value['response_id'])
            if len(methods) >= 5:
                break
    except OSError:
        pass
    return sorted(citations)[:20], sorted(methods, key=lambda item: item['response_id'])


def events_for(home, context, session, text, run, *, landing=None):
    citations, methods = search_evidence(home, context, session)
    observed = datetime.fromtimestamp(run['ended_at'], timezone.utc).isoformat()
    episode = episode_for(context)
    result_hash = sha256(text.encode()).hexdigest()
    refs = ['hermes-session:' + session, 'hermes-kanban-task:' + context['native_task_id'], 'hermes-kanban-run:' + context['native_run_id'], 'native-result-sha256:' + result_hash, *citations]
    if context['actor_role'] == 'disenador_landings' and run.get('native_board'):
        episode = 'native-result-' + sha256(canonical([episode, run['native_board']]).encode()).hexdigest()
        refs.append('hermes-kanban-board:' + run['native_board'])
    header = ('Generated specialist work, not owner testimony or independently verified platform metrics. '
        'Native terminal execution: ' + canonical({key: run[key] for key in ('title', 'status', 'outcome')}) + '\n'
        + ('Verified Meta hosted web_search method receipts: ' + canonical(methods) if methods else 'No independently matched hosted-search method receipt is attached.') + '\n')
    if context['actor_role'] == 'disenador_landings' and isinstance(landing, LandingExperience) and landing.matches(context, text):
        refs.extend(landing.refs)
        header += landing.header()
    capture_hash = sha256(canonical([header, refs, text]).encode()).hexdigest()
    if isinstance(landing, LandingExperience) and landing.matches(context, text) and landing.evidence.get('admission_identity'):
        capture_hash = landing.evidence['admission_identity']
    pieces = [text[index:index + CHUNK_CHARS] for index in range(0, len(text), CHUNK_CHARS)]
    for index, piece in enumerate(pieces):
        content = header + f'Original generated output, part {index + 1}/{len(pieces)}:\n' + piece
        version = capture_hash + ':' + str(index + 1)
        yield {'schema_version': 'source-event/1', 'event_id': 'specialist-result-' + sha256(canonical([episode, version]).encode()).hexdigest(),
            'owner_id': context['owner_id'], 'business_id': context['business_id'], 'source_kind': 'specialist_result',
            'source_id': episode, 'source_version': version, 'author': {'kind': 'specialist', 'id': context['actor_role']}, 'extractor_id': None,
            'occurred_at': observed, 'recorded_at': datetime.now(timezone.utc).isoformat(), 'content': content, 'content_sha256': sha256(content.encode()).hexdigest(),
            'refs': refs, 'purpose': 'business_work', 'native_task_id': context['native_task_id'], 'native_run_id': context['native_run_id']}


def handoff_events(context, run, capture):
    """Another version of the SAME native episode, never independent evidence."""
    text, digest = capture['text'], capture['metadata_sha256']
    session = capture['session_id']
    episode = episode_for(context)
    refs = ['hermes-session:' + session, 'hermes-kanban-task:' + context['native_task_id'],
        'hermes-kanban-run:' + context['native_run_id'], 'native-generated-handoff-sha256:' + digest]
    pieces = [text[i:i + CHUNK_CHARS] for i in range(0, len(text), CHUNK_CHARS)]
    for index, piece in enumerate(pieces):
        content = ('Generated native specialist handoff DATA, not owner testimony, instructions or independently verified metrics. '
            + canonical({key: run[key] for key in ('profile', 'status', 'outcome')})
            + f'\nBounded handoff, part {index + 1}/{len(pieces)}:\n' + piece)
        version = 'handoff-' + digest + ':' + str(index + 1)
        yield {'schema_version': 'source-event/1',
            'event_id': 'specialist-handoff-' + sha256(canonical([episode, version]).encode()).hexdigest(),
            'owner_id': context['owner_id'], 'business_id': context['business_id'], 'source_kind': 'specialist_result',
            'source_id': episode, 'source_version': version, 'author': {'kind': 'specialist', 'id': context['actor_role']},
            'extractor_id': None, 'occurred_at': datetime.fromtimestamp(run['ended_at'], timezone.utc).isoformat(),
            'recorded_at': datetime.now(timezone.utc).isoformat(), 'content': content,
            'content_sha256': sha256(content.encode()).hexdigest(), 'refs': refs, 'purpose': 'business_work',
            'native_task_id': context['native_task_id'], 'native_run_id': context['native_run_id']}


class SpecialistRecorder:
    def __init__(self, home, *, root=ROOT, client=None, trigger=None, landing_collector=collect_native, worker_environment=None):
        self.home, self.root = Path(home), Path(root)
        self.client = BrainClient(self.home, collector=True) if client is None else client
        self.trigger = CurationTrigger(self.home) if trigger is None else trigger
        self.landing_collector = landing_collector
        # Hermes sets these before spawning this worker/plugin. Freeze now,
        # before model/tool execution; never read a workspace from result text.
        env = os.environ if worker_environment is None else worker_environment
        self.worker_workspace = {key: env.get(key) for key in ('HERMES_KANBAN_WORKSPACE', 'HERMES_KANBAN_TASK',
                                'HERMES_KANBAN_RUN_ID', 'HERMES_TENANT', 'HERMES_HOME', 'HERMES_KANBAN_CLAIM_LOCK', 'HERMES_KANBAN_DB')}
        self.worker_bindings = []
        self.pending = self.home / 'plugin-data/saleads-memory/pending-specialist'
        self.registered = self.home / 'plugin-data/saleads-memory/registered-specialist'
        self.handoffs = self.home / 'plugin-data/saleads-memory/native-handoffs'

    def _handoff(self, context, session, text, run):
        path = self.handoffs / (episode_for(context).removeprefix('native-result-') + '.json')
        binding = {key: context[key] for key in ('owner_id', 'business_id', 'actor_role', 'native_task_id', 'native_run_id')}
        if not path.exists():
            projection = handoff_projection(run, context, text)
            if projection is None:
                return None, path
            _private_create(path, {'schema_version': 'native-specialist-handoff/1', 'binding': binding,
                'session_id': session, 'text': projection, 'metadata_sha256': sha256(projection.encode()).hexdigest(),
                'registered_ids': [], 'complete': False})
        try:
            if path.is_symlink() or path.stat().st_size > 65536:
                return None, path
            capture = json.loads(path.read_text())
            if (not isinstance(capture, dict) or capture.get('schema_version') != 'native-specialist-handoff/1'
                    or capture.get('binding') != binding or not isinstance(capture.get('text'), str)
                    or len(capture['text'].encode()) > MAX_HANDOFF_BYTES
                    or capture.get('metadata_sha256') != sha256(capture['text'].encode()).hexdigest()
                    or not isinstance(capture.get('registered_ids'), list)
                    or any(not isinstance(item, str) for item in capture['registered_ids'])
                    or type(capture.get('complete')) is not bool
                    or not isinstance(capture.get('session_id'), str)
                    or not (same_profile_session(self.home, capture['session_id'], session)
                            or same_profile_session(self.home, session, capture['session_id']))):
                return None, path
            return capture, path
        except (OSError, ValueError, TypeError):
            return None, path

    def _enrich(self, path, value, context, session, text, run, *, dispatch, deadline):
        capture, receipt = self._handoff(context, session, text, run)
        if capture is None or value.get('handoff_metadata_sha256') == capture['metadata_sha256']:
            return False
        ids = list(capture['registered_ids'])
        if not capture['complete']:
            for event in handoff_events(context, run, capture):
                if time.monotonic() >= deadline:
                    return False
                if event['event_id'] in ids:
                    continue
                response = self.client.request(context, '/continuous/sources', event, timeout=2)
                if response.get('accepted') is not True or response.get('event_id') != event['event_id']:
                    raise MemoryFailure('SOURCE_NOT_REGISTERED')
                ids.append(event['event_id'])
                capture['registered_ids'] = ids
                _private_write(receipt, capture)
            capture['complete'] = True
            _private_write(receipt, capture)
        value['registered_ids'] = list(dict.fromkeys([*value['registered_ids'], *ids]))
        value['handoff_metadata_sha256'] = capture['metadata_sha256']
        _private_write(path, value)
        if dispatch:
            self.trigger.request(context, ids)
        return True

    def _registered_paths(self):
        try:
            paths = sorted(path for path in self.registered.iterdir() if NAME.fullmatch(path.name))
        except OSError:
            return [], 0
        after = ''
        cursor = self.registered.parent / 'registered-scan-cursor.json'
        try:
            if not cursor.is_symlink() and cursor.stat().st_size <= 1024:
                value = json.loads(cursor.read_text())
                if isinstance(value, dict) and NAME.fullmatch(str(value.get('after', ''))):
                    after = value['after']
        except (OSError, ValueError):
            pass
        return [path for path in paths if path.name > after] + [path for path in paths if path.name <= after], len(paths)

    def bind(self, context, session):
        """pre_llm_call only: native claim/spawn + this profile's actual session.

        Claim credentials stay in process memory. Only nonsecret native event
        identities are frozen into the existing pending record after output.
        """
        if context.get('actor_role') != 'disenador_landings' or context.get('session_id') != session:
            return False
        env = self.worker_workspace
        keys = ('HERMES_KANBAN_TASK', 'HERMES_KANBAN_RUN_ID', 'HERMES_TENANT', 'HERMES_HOME')
        if tuple(env.get(key) for key in keys) != (context.get('native_task_id'), context.get('native_run_id'), context.get('business_id'), str(self.home)):
            return False
        run = _native_run(self.root, context, session, terminal=False, check_session=False, database_pin=env.get('HERMES_KANBAN_DB'))
        if (run is None or run['status'] != 'running' or run['task_status'] != 'running'
                or run.get('current_run_id') != run['id'] or run.get('latest_run_id') != run['id']
                or run.get('workspace_path') != env.get('HERMES_KANBAN_WORKSPACE')
                or type(run.get('started_at')) is not int or run['started_at'] < 1
                or type(run.get('worker_pid')) is not int or run['worker_pid'] < 1
                or not isinstance(run.get('claim_lock'), str) or not isinstance(env.get('HERMES_KANBAN_CLAIM_LOCK'), str)
                or not run['claim_lock'].isascii() or not env['HERMES_KANBAN_CLAIM_LOCK'].isascii()
                or not run['claim_lock'] or not hmac.compare_digest(run['claim_lock'], env['HERMES_KANBAN_CLAIM_LOCK'])):
            return False
        path = self.home / 'state.db'
        if not path.is_file() or path.is_symlink():
            return False
        try:
            from hermes_state import SessionDB
            with_session = SessionDB(path, read_only=True)
            try:
                actual = with_session.get_session(session)
            finally:
                with_session.close()
            if (not isinstance(actual, dict) or actual.get('id') != session or actual.get('source') != 'kanban'
                    or actual.get('profile_name') not in (None, '', context['actor_role'])):
                return False
            events = [event for event in _events(self.root, context['native_task_id'], database_pin=run['kanban_db'])
                      if event.task_id == context['native_task_id'] and event.run_id == run['id'] and isinstance(event.payload, dict)]
            claims = [event for event in events if event.kind == 'claimed' and isinstance(event.payload.get('lock'), str)
                      and event.payload['lock'].isascii()
                      and hmac.compare_digest(event.payload['lock'], env['HERMES_KANBAN_CLAIM_LOCK'])]
            spawns = [event for event in events if event.kind in {'spawned', 'worker_registered'} and event.payload.get('pid') == run['worker_pid']]
            if not claims or not spawns:
                return False
            binding = {'schema_version': 'native-landing-worker-binding/1', 'context': dict(context), 'session_id': session,
                       'workspace_path': run['workspace_path'], 'started_at': run['started_at'], 'worker_pid': run['worker_pid'],
                       'kanban_db': run['kanban_db'],
                       'claim_event_id': claims[-1].id, 'spawn_event_id': spawns[-1].id}
            if binding not in self.worker_bindings:
                self.worker_bindings.append(binding)
            return True
        except (ImportError, AttributeError, OSError, RuntimeError, ValueError, sqlite3.Error):
            return False

    def stage(self, context, session, text):
        if context.get('actor_role') not in PROFILES or not context.get('native_task_id') or not context.get('native_run_id') or context.get('session_id') != session:
            return False
        if not isinstance(text, str) or not text.strip() or text.strip() == '[SILENT]' or len(text) > MAX_RESPONSE_CHARS:
            return False
        binding = None
        if context['actor_role'] == 'disenador_landings':
            binding = next((item for item in reversed(self.worker_bindings)
                if all(item['context'].get(key) == context.get(key) for key in ('owner_id', 'business_id', 'actor_role', 'native_task_id', 'native_run_id'))
                and same_profile_session(self.home, item['session_id'], session)), None)
        identity = [context, session, text]
        if binding is not None:
            identity.append(binding['kanban_db'])
        fingerprint = sha256(canonical(identity).encode()).hexdigest()
        if (self.registered / (fingerprint + '.json')).is_file():
            return False
        path = self.pending / (fingerprint + '.json')
        value = {'schema_version': 'pending-specialist-result/1', 'context': context, 'session_id': session, 'text': text, 'text_sha256': sha256(text.encode()).hexdigest(), 'registered_ids': []}
        if not path.is_file():
            if context['actor_role'] == 'disenador_landings':
                value['worker_binding'] = binding
                run = _native_run(self.root, context, session, terminal=False, worker_binding=binding)
                env = self.worker_workspace
                expected = (context['native_task_id'], context['native_run_id'], context['business_id'], str(self.home))
                actual = tuple(env.get(key) for key in ('HERMES_KANBAN_TASK', 'HERMES_KANBAN_RUN_ID', 'HERMES_TENANT', 'HERMES_HOME'))
                if run is not None and actual == expected:
                    try:
                        inputs = self.landing_collector(context, session, run)
                        if inputs is not None:
                            value['landing_snapshot'] = native_snapshot(inputs, run, env['HERMES_KANBAN_WORKSPACE'])
                            sealed = {**value, 'landing_native_source': 'native-landing-source/2'}
                            _write_cli_record(self.home, path, sealed)
                            return True
                    except (LandingEvidenceError, MemoryFailure, OSError, UnicodeError):
                        pass  # Generated output remains eligible; unavailable artifacts are never invented.
            _private_write(path, value)
        return True

    def reconcile(self, *, dispatch=True, budget_seconds=5, only_record=None):
        count = 0
        registered_now = set()
        deadline = time.monotonic() + budget_seconds
        try:
            paths = ([self.pending / only_record] if isinstance(only_record, str) and NAME.fullmatch(only_record)
                     else [] if only_record is not None else list(islice(self.pending.iterdir(), 100)))
        except OSError:
            paths = []
        for path in paths:
            if only_record is not None and path.name != only_record:
                continue
            if time.monotonic() >= deadline:
                break
            value = _read(path)
            context = value.get('context') if value else None
            if not isinstance(context, dict) or context.get('actor_role') not in PROFILES or self.home.name != context['actor_role']:
                continue
            text, session = value.get('text'), value.get('session_id')
            if not isinstance(text, str) or not isinstance(session, str) or len(text) > MAX_RESPONSE_CHARS or sha256(text.encode()).hexdigest() != value.get('text_sha256'):
                continue
            protected = any(key in value for key in ('landing_native_source', 'landing_admission_identity',
                            'landing_cli_mac', 'landing_cli_observation', 'landing_cli_pending', 'landing_native_capture', 'landing_cli_validations'))
            cached = value.get('landing_capture', {})
            cached_evidence = cached.get('evidence', {}) if isinstance(cached, dict) and isinstance(cached.get('evidence'), dict) else {}
            cached_refs = cached.get('refs', []) if isinstance(cached, dict) and isinstance(cached.get('refs'), list) else []
            api_refs = (cached_evidence.get('persisted_version') is not None
                        or any(isinstance(ref, str) and ref.startswith('saleads-') for ref in cached_refs))
            if context['actor_role'] == 'disenador_landings' and protected:
                try:
                    if not _verified_cli_record(self.home, value) or value.get('landing_cli_pending') is True:
                        continue
                except MemoryFailure:
                    break
            elif context['actor_role'] == 'disenador_landings' and api_refs:
                continue  # Removing a MAC/marker cannot turn an API receipt into legacy native evidence.
            run = terminal_run(self.root, context, session, worker_binding=value.get('worker_binding'))
            if run is None:
                continue
            landing = None
            if context['actor_role'] == 'disenador_landings' and protected and isinstance(value.get('landing_capture'), dict):
                try:
                    landing = LandingExperience.restore(value['landing_capture'], context, text)
                except LandingEvidenceError:
                    continue
            elif context['actor_role'] == 'disenador_landings' and isinstance(value.get('landing_snapshot'), dict):
                try:
                    inputs = self.landing_collector(context, session, run)
                    expected_workspace = value['landing_snapshot'].get('workspace_path')
                    if inputs is not None and native_snapshot(inputs, run, expected_workspace) == value['landing_snapshot']:
                        landing = LandingExperience.extract(context, session, run, text, inputs)
                        if landing.evidence.get('persisted_version') is not None:
                            landing = None  # API observations enter only through the authenticated Root CLI producer.
                        else:
                            # Freeze verified refs before a possibly lost source ACK.
                            value['landing_capture'] = landing.saved()
                            if protected:
                                _write_cli_record(self.home, path, value)
                            else:
                                _private_write(path, value)
                except (LandingEvidenceError, OSError, UnicodeError):
                    pass  # A rejected artifact/receipt never adds a verified reference.
            try:
                ids = value.get('registered_ids', [])
                if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids):
                    continue
                source_run = {**run, 'title': value.get('source_native_title', run['title'])}
                for event in events_for(self.home, context, session, text, source_run, landing=landing):
                    if time.monotonic() >= deadline:
                        return count
                    if event['event_id'] in ids:
                        continue
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return count
                    response = self.client.request(context, '/continuous/sources', event, timeout=min(2, remaining))
                    if response.get('accepted') is not True or response.get('event_id') != event['event_id']:
                        raise MemoryFailure('SOURCE_NOT_REGISTERED')
                    ids.append(event['event_id'])
                    value['registered_ids'] = ids
                    if protected:
                        _write_cli_record(self.home, path, value)
                    else:
                        _private_write(path, value)
                self._enrich(path, value, context, session, text, run, dispatch=False, deadline=deadline)
                self.registered.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.replace(path, self.registered / path.name)
                registered_now.add(path.name)
                count += 1
                if dispatch:
                    self.trigger.request(context, value['registered_ids'])
            except MemoryFailure as error:
                if error.code in {'MEMORY_UNAVAILABLE', 'MEMORY_AUTH_UNAVAILABLE'}:
                    return count
            except (OSError, UnicodeError):
                continue
        paths, total = self._registered_paths()
        visited = None
        for path in paths[:100]:
            if time.monotonic() >= deadline:
                break
            visited = path.name
            if path.name in registered_now:
                continue
            value = _read(path)
            context = value.get('context') if value else None
            if (not isinstance(context, dict) or context.get('actor_role') not in PROFILES
                    or self.home.name != context['actor_role'] or value.get('handoff_metadata_sha256')):
                continue
            text, session, ids = value.get('text'), value.get('session_id'), value.get('registered_ids')
            if (not isinstance(text, str) or not isinstance(session, str) or len(text) > MAX_RESPONSE_CHARS
                    or sha256(text.encode()).hexdigest() != value.get('text_sha256')
                    or not isinstance(ids, list) or any(not isinstance(item, str) for item in ids)):
                continue
            run = terminal_run(self.root, context, session, worker_binding=value.get('worker_binding'))
            if run is None:
                continue
            try:
                if self._enrich(path, value, context, session, text, run, dispatch=dispatch, deadline=deadline):
                    count += 1
            except MemoryFailure as error:
                if error.code in {'MEMORY_UNAVAILABLE', 'MEMORY_AUTH_UNAVAILABLE'}:
                    break
            except (OSError, UnicodeError):
                continue
        if visited and (total > 100 or time.monotonic() >= deadline):
            _private_write(self.registered.parent / 'registered-scan-cursor.json',
                {'schema_version': 'specialist-scan-cursor/1', 'after': visited})
        return count


def _landing_records(recorder, deadline):
    seen = set()
    for directory in (recorder.pending, recorder.registered):
        if directory.is_symlink():
            raise LandingEvidenceError('landing_record_directory_invalid')
        try:
            paths = list(islice(directory.iterdir(), 1001))
        except FileNotFoundError:
            continue
        if len(paths) > 1000:
            raise LandingEvidenceError('landing_record_scan_incomplete')
        for path in paths:
            if time.monotonic() >= deadline:
                raise LandingEvidenceError('landing_capture_budget_exhausted')
            if path.name in seen:
                continue
            seen.add(path.name)
            value = _read(path)
            if value is not None:
                yield path, value


def _original_landing_record(recorder, request, workspace, deadline):
    matches = []
    for _path, value in _landing_records(recorder, deadline):
        if value.get('landing_admission_identity') is not None:
            continue
        context, snapshot = value.get('context'), value.get('landing_snapshot')
        if (not isinstance(context, dict) or context.get('actor_role') != 'disenador_landings'
                or context.get('business_id') != request['business_id'] or not isinstance(snapshot, dict)
                or snapshot.get('workspace_path') != workspace
                or any(key in request['metadata'] and str(request['metadata'][key]) != str(context.get(native))
                       for key, native in (('taskId', 'native_task_id'), ('runId', 'native_run_id')))):
            continue
        if value.get('landing_native_source') != 'native-landing-source/2' or not _verified_cli_record(recorder.home, value):
            continue  # Preserve historical generated records without fabricating an authenticated backfill.
        original_code = {name: snapshot.get('files', {}).get(name) for name in request['files']}
        if request['files'] != original_code and _normalization_for(value, request) is None:
            continue
        text, session = value.get('text'), value.get('session_id')
        if (not isinstance(text, str) or not isinstance(session, str) or context.get('session_id') != session
                or len(text) > MAX_RESPONSE_CHARS or sha256(text.encode()).hexdigest() != value.get('text_sha256')):
            continue
        run = terminal_run(recorder.root, context, session, worker_binding=value.get('worker_binding'))
        if run is None:
            continue
        native = collect_native(context, session, run)
        if native is None:
            continue
        current = native_snapshot(native, run, workspace)
        if (any(current['files'].get(name) != item for name, item in request['files'].items())
                or any(name not in {'index.html', 'styles.css', 'review-evidence.json'} and current['files'].get(name) != item
                       for name, item in snapshot['files'].items())):
            continue  # Root may finalize code / add evidence bookkeeping; it cannot rewrite the native design/critique.
        matches.append((value, run, native))
        if len(matches) > 1:
            raise LandingEvidenceError('landing_native_match_not_unique')
    if len(matches) != 1:
        raise LandingEvidenceError('landing_native_match_not_unique')
    return matches[0]


def _normalization_for(value, request):
    for observation in value.get('landing_cli_validations', []):
        if (observation.get('business_id') == request['business_id'] and observation.get('landing_id') == request['landing_id']
                and observation.get('metadata_sha256') == request['metadata_sha256']
                and observation.get('generated_document_sha256') == request['generated_document_sha256']
                and observation.get('output_files') == request['files']):
            return observation
    return None


def _root_request_observation(recorder, original, native, request_args):
    observed = freeze_request_observation(request_args)
    previous = _normalization_for(original, observed)
    if previous is not None:
        observed['metadata_projection_ref'] = previous.get('metadata_projection_ref')
        return observed
    try:
        return freeze_request_observation(request_args, native.files)
    except LandingEvidenceError:
        # The existing pilot mapper adds _pilotReviewEvidence and projects its
        # closed review shape. Reuse its actual pure code, never duplicate it or
        # treat its local-reference-integrity checks as authenticated vision.
        path = recorder.root / 'saleads/landing-pilot/build_metadata.py'
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 256 * 1024:
            raise LandingEvidenceError('landing_metadata_mapper_unavailable')
        source_hash = sha256(path.read_bytes()).hexdigest()
        name = '_saleads_landing_metadata_' + source_hash
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise LandingEvidenceError('landing_metadata_mapper_unavailable')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        metadata = request_args.get('metadata', {})
        projected = module.build(Path(original['landing_snapshot']['workspace_path']),
                                 {'lineage': metadata.get('lineage')}, metadata.get('taskId'), metadata.get('runId'))
        return freeze_request_observation(request_args, native.files, projected_metadata=projected,
                                         projection_ref='managed-landing-metadata-sha256:' + source_hash)


def _cli_landing_record(recorder, business, landing_id, n, digest, deadline, *, request=None, workspace=None):
    matches = []
    for path, value in _landing_records(recorder, deadline):
        if value.get('landing_admission_identity') is None or not _verified_cli_record(recorder.home, value):
            continue
        observation = value.get('landing_cli_observation', {})
        receipt = observation.get('admission', {})
        if (receipt.get('businessId') != business or receipt.get('landingId') != landing_id or receipt.get('n') != n
                or receipt.get('artifactDigest') != digest
                or request is not None and {key: item for key, item in observation.get('request', {}).items() if key != 'metadata_projection_ref'}
                    != {key: item for key, item in request.items() if key != 'metadata_projection_ref'}
                or workspace is not None and value.get('landing_snapshot', {}).get('workspace_path') != workspace):
            continue
        matches.append((path, value))
        if len(matches) > 1:
            raise LandingEvidenceError('landing_checkpoint_match_not_unique')
    return matches[0] if matches else None


def _checkpoint_landing_admission(recorder, original, run, native, request_args, admission):
    context, session, text = original['context'], original['session_id'], original['text']
    request = _root_request_observation(recorder, original, native, request_args)
    manifest = checked_file_manifest(original['landing_snapshot']['files'])
    checked_admission(context, run, request, admission, request['files'])
    identity = admission_identity(context, run, request, admission)
    name = sha256(canonical(['landing-admission-source/1', identity]).encode()).hexdigest() + '.json'
    receipt = {key: admission[key] for key in ('businessId', 'landingId', 'origin', 'n', 'artifactDigest', 'requestId', 'createdBy', 'createdAt')}
    review_hash = sha256(canonical(admission['review']).encode()).hexdigest() if 'review' in admission else None
    if 'review' in request['generated_document_sha256'] and review_hash != request['generated_document_sha256']['review']:
        raise LandingEvidenceError('landing_generated_document_mismatch')
    capture = {**original, 'landing_admission_identity': identity, 'landing_cli_pending': True,
               'landing_cli_observation': {'request': request, 'admission': receipt, 'admission_review_sha256': review_hash,
                    'normalization_ref': (_normalization_for(original, request) or {}).get('ref')},
               'landing_native_capture': LandingExperience.extract(context, session, run, text,
                    CollectorInputs(binding=context, files={}, native_manifest=manifest)).saved(),
               'source_native_title': run['title'], 'registered_ids': []}
    capture.pop('landing_capture', None)
    path = recorder.pending / name
    if path.exists() or (recorder.registered / name).exists():
        raise LandingEvidenceError('landing_checkpoint_identity_conflict')
    _write_cli_record(recorder.home, path, capture)
    return path, capture


def _finish_landing_admission(recorder, path, value, landing, version, deadline, *, admission=None):
    if not _verified_cli_record(recorder.home, value):
        raise LandingEvidenceError('landing_checkpoint_authenticity_invalid')
    context, session, text = value['context'], value['session_id'], value['text']
    run = terminal_run(recorder.root, context, session, worker_binding=value.get('worker_binding'))
    if run is None:
        raise LandingEvidenceError('landing_checkpoint_native_binding_unavailable')
    observation = value['landing_cli_observation']
    receipt = admission
    if receipt is None:
        receipt = dict(observation['admission'])
        review_hash = observation['admission_review_sha256']
        if review_hash is not None:
            if sha256(canonical(version.get('review')).encode()).hexdigest() != review_hash:
                raise LandingEvidenceError('landing_generated_document_mismatch')
            receipt['review'] = version['review']  # Actual readback bytes match the authenticated ACK's frozen hash.
    native = CollectorInputs(binding=dict(context), files={}, native_manifest=value['landing_snapshot']['files'],
        submitted_manifest=observation['request']['files'], normalization_ref=observation.get('normalization_ref'),
        observed_request=observation['request'], admission=receipt, landing=landing, version=version)
    evidence = LandingExperience.extract(context, session, run, text, native)
    if evidence.evidence['admission_identity'] != value['landing_admission_identity']:
        raise LandingEvidenceError('landing_checkpoint_identity_conflict')
    registered = recorder.registered / path.name
    if path.parent == recorder.registered:
        return {'accepted': True, 'pending': False}
    if value.get('landing_cli_pending') is True:
        value.update(landing_cli_pending=False, landing_capture=evidence.saved())
        _write_cli_record(recorder.home, path, value)
    recorder.reconcile(only_record=path.name, budget_seconds=max(0, deadline - time.monotonic()))
    accepted = registered.is_file() and not registered.is_symlink()
    return {'accepted': accepted, 'pending': not accepted and path.is_file()}


def observe_landing_admission(request_args, admission, landing, version, workspace, *, root=ROOT,
                              client=None, trigger=None, budget_seconds=5):
    """Root CLI's in-process REAL ACK hook, before reads or with all readbacks.

    None/None readbacks stage a signed, hash-only checkpoint in the existing
    queue. They never register API facts. Full readbacks corroborate the exact
    version; source POST recovery needs no commercial credential or new daemon.
    """
    unavailable = {'accepted': False, 'pending': False}
    deadline = time.monotonic() + max(0, min(5, budget_seconds))
    root = Path(root)
    recorder = SpecialistRecorder(root / 'profiles/disenador_landings', root=root, client=client, trigger=trigger, worker_environment={})
    try:
        if not isinstance(admission, dict):
            return unavailable
        request = freeze_request_observation(request_args)
        expected_workspace = str(Path(workspace).resolve(strict=True))
        existing = _cli_landing_record(recorder, request['business_id'], admission.get('landingId'), admission.get('n'),
            admission.get('artifactDigest'), deadline, request=request, workspace=expected_workspace)
        if existing is None:
            original, run, native = _original_landing_record(recorder, request, expected_workspace, deadline)
            existing = _checkpoint_landing_admission(recorder, original, run, native, request_args, admission)
        path, value = existing
        if landing is None and version is None:
            return {'accepted': path.parent == recorder.registered, 'pending': path.parent != recorder.registered}
        if not isinstance(landing, dict) or not isinstance(version, dict):
            return unavailable
        return _finish_landing_admission(recorder, path, value, landing, version, deadline, admission=admission)
    except (LandingEvidenceError, MemoryFailure, OSError, UnicodeError, ValueError, TypeError, KeyError, ImportError, AttributeError):
        return unavailable


def resume_landing_admission(request_args, landing, version, *, root=ROOT, client=None, trigger=None, budget_seconds=5):
    """Only a subsequent authenticated Root CLI get_version can finish reads.

    A model-edited output JSON is never loaded. Business/landing/n are selectors
    for one MAC-verified checkpoint; the designer makes no commercial request.
    """
    unavailable = {'accepted': False, 'pending': False}
    deadline = time.monotonic() + max(0, min(5, budget_seconds))
    root = Path(root)
    recorder = SpecialistRecorder(root / 'profiles/disenador_landings', root=root, client=client, trigger=trigger, worker_environment={})
    try:
        if (not isinstance(request_args, dict) or not isinstance(landing, dict) or not isinstance(version, dict)
                or not isinstance(request_args.get('business_id'), str) or not isinstance(request_args.get('landing_id'), str)
                or request_args.get('n') != version.get('n') or request_args['landing_id'].lower() != version.get('landingId')):
            return unavailable
        existing = _cli_landing_record(recorder, request_args['business_id'].lower(), version['landingId'], version['n'],
                                       version.get('artifactDigest'), deadline)
        if existing is None:
            return unavailable
        return _finish_landing_admission(recorder, *existing, landing, version, deadline)
    except (LandingEvidenceError, MemoryFailure, OSError, UnicodeError, ValueError, TypeError, KeyError):
        return unavailable


def stage_landing_admission(request_args, admission, workspace, *, root=ROOT, client=None, trigger=None, budget_seconds=5):
    """Explicit helper entry point for a REAL acceptance ACK before extra reads."""
    return observe_landing_admission(request_args, admission, None, None, workspace,
        root=root, client=client, trigger=trigger, budget_seconds=budget_seconds)


def observe_landing_validation(request_args, validation, workspace, *, root=ROOT, budget_seconds=5):
    """Root-only real validate-response hook, before any finalized-file copy.

    accepted here means a hash-chain was sealed locally, never Source ACK,
    publication permission, visual QA proof, or business-factual observation.
    """
    unavailable = {'accepted': False, 'pending': False}
    deadline = time.monotonic() + max(0, min(5, budget_seconds))
    root = Path(root)
    recorder = SpecialistRecorder(root / 'profiles/disenador_landings', root=root, worker_environment={})
    try:
        if not isinstance(validation, dict) or validation.get('publishable') is not True or validation.get('blocks') != []:
            return unavailable
        request = freeze_request_observation(request_args)
        expected_workspace = str(Path(workspace).resolve(strict=True))
        original, _run, native = _original_landing_record(recorder, request, expected_workspace, deadline)
        observed = _root_request_observation(recorder, original, native, request_args)
        final_files = request_code_files(validation)
        digest = artifact_digest(final_files)
        if validation.get('artifactDigest') != digest:
            return unavailable
        output = {name: {'sha256': sha256(body).hexdigest(), 'byteLength': len(body)} for name, body in final_files.items()}
        proof = {'schema_version': 'landing-cli-normalization-observation/1', 'business_id': request['business_id'],
                 'landing_id': request['landing_id'], 'input_files': request['files'], 'output_files': output,
                 'artifactDigest': digest, 'metadata_sha256': observed['metadata_sha256'],
                 'generated_document_sha256': observed['generated_document_sha256'],
                 'metadata_projection_ref': observed.get('metadata_projection_ref'),
                 'ref': f"saleads-landing-validation:{request['landing_id']}@sha256:{digest}"}
        proofs = original.get('landing_cli_validations', [])
        if proof not in proofs:
            if len(proofs) >= 8:
                return unavailable
            original['landing_cli_validations'] = [*proofs, proof]
            # Preserve the original record location and already-ACKed Source IDs.
            locations = [path for path, value in _landing_records(recorder, deadline)
                         if value.get('text_sha256') == original['text_sha256'] and value.get('context') == original['context']
                         and value.get('landing_admission_identity') is None]
            if len(locations) != 1:
                return unavailable
            _write_cli_record(recorder.home, locations[0], original)
        return {'accepted': True, 'pending': False}
    except (LandingEvidenceError, MemoryFailure, OSError, UnicodeError, ValueError, TypeError, KeyError, ImportError, AttributeError):
        return unavailable


def reconcile_all(root=ROOT):
    """Called by the independent no-agent dispatcher before it creates batches; never spawns itself."""
    return sum(SpecialistRecorder(Path(root) / 'profiles' / profile, root=root).reconcile(dispatch=False) for profile in PROFILES)
