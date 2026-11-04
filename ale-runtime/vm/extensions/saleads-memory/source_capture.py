"""Register native owner inputs with true provenance, without extracting facts or using a model."""
from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import tempfile
import uuid

from .client import BrainClient, MemoryFailure, canonical

POLICY = Path('/opt/data/saleads/continuous/operator-canary-client-ids.json')
OWNER = re.compile(r'^CLIENT_MESSAGE_ID: ([0-9a-fA-F-]{36})\nOWNER_MESSAGE_DATA:\n([\s\S]*)$')
OWNER_PREFIX = 'SALEADS_OWNER_MESSAGE_V1 '
SERVER_PREFIXES = ('FIRST_USE_ORIENTATION', 'CONFIRMED_PROPOSAL_KICKOFF', '[kanban]')


def _owner_message(value):
    if value.startswith(OWNER_PREFIX):
        line, separator, remaining = value.partition('\n')
        if separator and remaining and not remaining.startswith('\nSERVER_CONTEXT:'):
            return None
        try:
            payload = json.loads(line[len(OWNER_PREFIX):])
            if not isinstance(payload, dict) or set(payload) != {'client_message_id', 'text'} or not isinstance(payload['text'], str):
                return None
            return str(uuid.UUID(payload['client_message_id'])), payload['text']
        except (ValueError, TypeError, AttributeError):
            return None
    legacy = OWNER.fullmatch(value)
    if legacy:
        try:
            return str(uuid.UUID(legacy[1])), legacy[2].split('\n\nSERVER_CONTEXT:', 1)[0]
        except ValueError:
            return None
    return None


def _canary_clients(context, path):
    try:
        if path.is_symlink() or path.stat().st_size > 65536:
            raise MemoryFailure('SOURCE_POLICY_UNAVAILABLE')
        value = json.loads(path.read_text())
        if (not isinstance(value, dict) or value.get('schema_version') != 'operator-canary-clients/1'
                or value.get('owner_id') != context['owner_id'] or not isinstance(value.get('client_message_ids'), list)):
            raise MemoryFailure('SOURCE_POLICY_UNAVAILABLE')
        return {str(uuid.UUID(item)) for item in value['client_message_ids']}
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise MemoryFailure('SOURCE_POLICY_UNAVAILABLE') from error


def _event(context, text, client_id, operator=False, server=False):
    timestamp = datetime.now(timezone.utc).isoformat()
    kind, author = ('server_instruction', 'server') if server else ('operator_canary', 'operator') if operator else ('owner_message', 'owner')
    try:
        original_hash = sha256(text.encode()).hexdigest()
        content_hash = sha256(text[:24000].encode()).hexdigest()
    except UnicodeError as error:
        raise MemoryFailure('SOURCE_CONTENT_INVALID') from error
    source_id = original_hash if server else client_id
    identity = sha256(canonical([context['owner_id'], context['business_id'], context['session_id'], kind, source_id]).encode()).hexdigest()
    content = text[:24000]
    return {
        'schema_version': 'source-event/1', 'event_id': 'source-' + identity,
        'owner_id': context['owner_id'], 'business_id': context['business_id'], 'source_kind': kind,
        'source_id': source_id, 'source_version': '1', 'author': {'kind': author, 'id': context['owner_id'] if author == 'owner' else 'saleads-' + author},
        'extractor_id': None, 'occurred_at': timestamp, 'recorded_at': timestamp,
        'content': content, 'content_sha256': content_hash,
        'refs': ['hermes-session:' + context['session_id'], ('native-input-sha256:' + source_id) if server else 'saleads-client-message:' + client_id],
        'purpose': 'technical_canary' if operator or server else 'business_work',
        'native_task_id': None, 'native_run_id': None,
    }


class SourceRecorder:
    def __init__(self, home, *, client=None, policy=POLICY):
        self.home = Path(home)
        self.client = BrainClient(self.home, collector=True) if client is None else client
        self.policy = policy

    def _path(self, context):
        identity = sha256(canonical([context['owner_id'], context['business_id'], context['session_id']]).encode()).hexdigest()
        return self.home / 'plugin-data/saleads-memory/current-sources' / (identity + '.json')

    def _save(self, context, event_id, purpose):
        path = self._path(context)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        value = {'schema_version': 'current-source/1', 'owner_id': context['owner_id'], 'business_id': context['business_id'],
                 'session_id': context['session_id'], 'source_event_id': event_id, 'purpose': purpose}
        descriptor, temporary = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'w') as output:
                json.dump(value, output)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def clear(self, context):
        try:
            self._path(context).unlink(missing_ok=True)
        except OSError as error:
            raise MemoryFailure('SOURCE_RECEIPT_UNAVAILABLE') from error

    def record(self, context, user_message, *, cron_identity=None):
        if context['actor_role'] != 'ale' or cron_identity is not None or context.get('native_task_id'):
            return None
        self.clear(context)
        if not isinstance(user_message, str):
            return None
        original = _owner_message(user_message)
        if original:
            client_id, text = original
            if not text.strip() or len(text) > 8000:
                return None
            event = _event(context, text, client_id, operator=client_id in _canary_clients(context, self.policy))
        elif user_message.lstrip().startswith(SERVER_PREFIXES):
            event = _event(context, user_message, '', server=True)
        else:
            return None
        response = self.client.request(context, '/continuous/sources', event, timeout=3)
        event_id = response.get('event_id')
        if response.get('accepted') is not True or not isinstance(event_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}', event_id):
            raise MemoryFailure('SOURCE_NOT_REGISTERED')
        try:
            self._save(context, event_id, event['purpose'])
        except OSError as error:
            raise MemoryFailure('SOURCE_RECEIPT_UNAVAILABLE') from error
        return event_id

    def current(self, context):
        path = self._path(context)
        try:
            if path.is_symlink() or path.stat().st_size > 8192:
                return []
            value = json.loads(path.read_text())
            expected = (context['owner_id'], context['business_id'], context['session_id'], 'business_work')
            actual = (value.get('owner_id'), value.get('business_id'), value.get('session_id'), value.get('purpose'))
            if value.get('schema_version') != 'current-source/1' or actual != expected:
                return []
            return [value['source_event_id']] if isinstance(value.get('source_event_id'), str) else []
        except (OSError, ValueError, AttributeError):
            return []
