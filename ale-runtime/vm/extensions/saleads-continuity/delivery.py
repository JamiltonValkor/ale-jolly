"""Managed outbound-only platform using native homes and native adapter senders.

The virtual selector never changes /sethome, receives inbound traffic, invokes
a model, or retries a send whose acknowledgement is unknown.
"""
from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import tempfile

from .context import ROOT, resolve
from .notifications import visible_text

PLATFORM = 'saleads_home'


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.delivery-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encoded(value)); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def native_targets(job_id):
    from cron.scheduler_delivery import _resolve_delivery_targets
    return [t for t in _resolve_delivery_targets({'id': job_id, 'deliver': 'all'})
            if str(t.get('platform', '')).lower() != PLATFORM]


async def native_send(target, content):
    from gateway.config import load_gateway_config
    from tools.send_message_tool import _resolve_platform_config, _send_via_adapter
    platform, config, _entry, error = _resolve_platform_config(target['platform'], load_gateway_config())
    if error:
        # Configuration validation failed before invoking a remote sender.
        return {'success': False, 'definitely_not_sent': True}
    return await _send_via_adapter(platform, config, str(target['chat_id']), content,
        thread_id=target.get('thread_id'))


def key_for(job_id, execution_id):
    return hashlib.sha256((job_id + '\0' + execution_id).encode()).hexdigest()


def read_result(root, job_id, execution_id):
    path = root / 'delivery-receipts' / (key_for(job_id, execution_id) + '.json')
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 100000:
            return None
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def positive(result):
    raw = result.get('raw_response') if isinstance(result, dict) else None
    if isinstance(raw, dict) and (raw.get('partial_overflow') or raw.get('delivered') is False
            or (isinstance(raw.get('delivered_chunks'), int) and isinstance(raw.get('total_chunks'), int)
                and raw['delivered_chunks'] < raw['total_chunks'])):
        return False
    identifier = result.get('message_id') if isinstance(result, dict) else None
    has_identifier = (isinstance(identifier, str) and bool(identifier.strip())) or (type(identifier) is int and identifier >= 0)
    has_raw = isinstance(raw, (dict, list)) and bool(raw)
    return (isinstance(result, dict) and result.get('success') is True
            and result.get('delivered') is not False
            and (has_identifier or has_raw)
            and not result.get('partial_overflow'))


async def deliver(identity, content, *, selector='current', root: Path = ROOT,
                  target_resolver=native_targets, sender=native_send, now=None):
    content = visible_text(content)
    if identity is None or selector != 'current' or content is None:
        return {'state': 'failed', 'error': 'managed_delivery_binding_required'}
    value = resolve(session_id='', cron_identity=identity, root=root)
    if value is None:
        return {'state': 'failed', 'error': 'managed_delivery_binding_required'}
    job_id, execution_id = identity.job_id, identity.execution_id
    source_path = root / 'receipts' / (key_for(job_id, execution_id) + '.json')
    try:
        source = json.loads(source_path.read_text()) if not source_path.is_symlink() and source_path.stat().st_size <= 100000 else None
    except (OSError, ValueError):
        source = None
    if (not isinstance(source, dict) or source.get('job_id') != job_id or source.get('execution_id') != execution_id
            or source.get('text') != content
            or any(source.get(key) != value[key] for key in ('owner_id', 'business_id', 'session_id', 'response_locale', 'locale_revision'))):
        return {'state': 'failed', 'error': 'managed_source_or_locale_mismatch'}
    directory = root / 'delivery-receipts'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        return {'state': 'unknown', 'error': 'managed_delivery_store_unavailable'}
    path = directory / (key_for(job_id, execution_id) + '.json')
    lock_path = path.with_suffix('.lock')
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'state': 'unknown', 'error': 'managed_delivery_in_progress'}
        previous = read_result(root, job_id, execution_id)
        content_hash = hashlib.sha256(content.encode()).hexdigest()
        if previous is not None:
            if previous.get('content_sha256') != content_hash:
                return {'state': 'unknown', 'error': 'managed_delivery_source_mutation'}
            # Started/unknown includes lost responses. Never call the native sender again.
            return previous
        now = now or dt.datetime.now(dt.timezone.utc)
        record = {'schema_version': 'managed-home-receipt/1', 'job_id': job_id, 'execution_id': execution_id,
            'owner_id': value['owner_id'], 'business_id': value['business_id'], 'session_id': value['session_id'],
            'response_locale': value['response_locale'], 'locale_revision': value['locale_revision'],
            'content_sha256': content_hash, 'state': 'unknown', 'targets': [], 'started_at': now.isoformat(),
            'finished_at': None, 'destination_version': None}
        try:
            targets = target_resolver(job_id)
            if not isinstance(targets, list):
                raise ValueError('invalid_targets')
            normalized = []
            for target in targets:
                if not isinstance(target, dict) or target.get('platform') == PLATFORM:
                    continue
                if not isinstance(target.get('platform'), str) or not target.get('chat_id'):
                    raise ValueError('invalid_target')
                selected = {key: target.get(key) for key in ('platform', 'chat_id', 'thread_id')}
                if selected not in normalized:
                    normalized.append(selected)
        except (OSError, ValueError, TypeError, RuntimeError, ImportError):
            atomic(path, record)
            return record
        record['destination_version'] = hashlib.sha256(encoded(normalized)).hexdigest()
        if not normalized:
            record.update(state='no_home', finished_at=now.isoformat())
            atomic(path, record)
            return record
        # Persist intent and stable target identities BEFORE any remote send. A crash
        # in the following await leaves an unknown receipt, never a replay permission.
        record['targets'] = [{'target_hash': hashlib.sha256(encoded(target)).hexdigest(),
                              'state': 'unknown', 'message_id': None, 'ack_sha256': None} for target in normalized]
        atomic(path, record)
        for index, target in enumerate(normalized):
            try:
                result = await sender(target, content)
            except Exception:
                # The request may have reached the provider. Persist no exception body.
                result = None
            item = record['targets'][index]
            if positive(result):
                item.update(state='delivered', message_id=str(result.get('message_id')) if result.get('message_id') else None,
                    ack_sha256=hashlib.sha256(encoded(result.get('raw_response') or {'message_id': str(result['message_id'])})).hexdigest())
            elif isinstance(result, dict) and result.get('definitely_not_sent') is True:
                item['state'] = 'failed'
            atomic(path, record)
        states = {target['state'] for target in record['targets']}
        # One complete positive owner-home ACK suffices to avoid a duplicate in
        # SaleADS. Other configured homes retain their individual outcomes.
        state = 'delivered' if 'delivered' in states else 'failed' if states == {'failed'} else 'unknown'
        record.update(state=state, finished_at=dt.datetime.now(dt.timezone.utc).isoformat())
        atomic(path, record)
        return record


def register(ctx, *, root: Path = ROOT, target_resolver=native_targets, sender=native_send):
    """Official outbound adapter extension; built-in registrations stay unchanged."""
    def factory(config):
        from gateway.config import Platform
        from gateway.platforms.base import BasePlatformAdapter, SendResult

        class ManagedHomeAdapter(BasePlatformAdapter):
            splits_long_messages = True
            interactive_resume = False

            def __init__(self):
                super().__init__(config, Platform(PLATFORM))

            async def connect(self, *, is_reconnect=False):
                self._running = True
                return True

            async def disconnect(self):
                self._running = False

            async def get_chat_info(self, chat_id):
                return {'name': 'Managed owner delivery', 'type': 'dm'}

            async def send(self, chat_id, content, reply_to=None, metadata=None):
                record = await deliver(ctx.current_cron_execution(), content, selector=chat_id,
                    root=root, target_resolver=target_resolver, sender=sender)
                ok = record.get('state') == 'delivered'
                return SendResult(success=ok, message_id=('managed:' + record['execution_id']) if ok else None,
                    error=None if ok else 'managed_delivery_' + record.get('state', 'unknown'))

        return ManagedHomeAdapter()

    async def standalone(_config, chat_id, message, *, thread_id=None, media_files=None, force_document=False):
        if media_files:
            return {'error': 'managed_text_delivery_only'}
        record = await deliver(ctx.current_cron_execution(), message, selector=chat_id,
            root=root, target_resolver=target_resolver, sender=sender)
        return ({'success': True, 'message_id': 'managed:' + record['execution_id']}
                if record.get('state') == 'delivered' else {'error': 'managed_delivery_' + record.get('state', 'unknown')})

    ctx.register_platform(name=PLATFORM, label='Managed owner delivery', adapter_factory=factory,
        check_fn=lambda: True, validate_config=lambda config: bool(config.enabled),
        required_env=[], cron_deliver_env_var='SALEADS_HOME_CHANNEL', standalone_sender_fn=standalone,
        allow_update_command=False)
