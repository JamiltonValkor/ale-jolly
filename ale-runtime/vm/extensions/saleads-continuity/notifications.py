"""Capture final cron output without launching a turn or delivering a message."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from .context import ROOT

MAX_TEXT = 16000
SENSITIVE = re.compile(r'Bearer\s+[A-Za-z0-9._-]{20,}|LLM_[A-Za-z0-9_]{12,}|-----BEGIN .*PRIVATE KEY|<analysis>|SALEADS_FIRST_LOOP_TASK_V1|SALEADS_TRUSTED_CONTEXT_V1|SALEADS_ROUTING_CONTEXT_V1', re.I)


def visible_text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_TEXT:
        return None
    value = value.strip()
    if value.upper() in {'SILENT', '[SILENT]'} or SENSITIVE.search(value) or '\x00' in value:
        return None
    try:
        parsed = json.loads(value)
        if isinstance(parsed, (dict, list)):
            return None
    except ValueError:
        pass
    return value


def native_home(job_id):
    """Pin adapter to the verified upstream resolver; never call a model."""
    try:
        from cron.jobs import get_job
        from cron.scheduler_delivery import _resolve_delivery_targets
        job = get_job(job_id)
        if not job or job.get('id') != job_id:
            return {'state': 'unknown', 'fingerprint': None}
        targets = _resolve_delivery_targets(job)
        fingerprint = hashlib.sha256(json.dumps(targets, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        return {'state': 'configured' if targets else 'no_home', 'fingerprint': fingerprint}
    except (ImportError, OSError, ValueError, TypeError, RuntimeError):
        return {'state': 'unknown', 'fingerprint': None}


def capture(value, identity, response, *, root: Path = ROOT, home_resolver=native_home, now=None):
    text = visible_text(response)
    if value is None or identity is None or text is None or value.get('actor_role') != 'ale':
        return False
    job_id, execution_id = getattr(identity, 'job_id', None), getattr(identity, 'execution_id', None)
    if not isinstance(job_id, str) or not job_id or not isinstance(execution_id, str) or not execution_id:
        return False
    now = now or dt.datetime.now(dt.timezone.utc)
    receipt = {'schema_version': 'native-cron-receipt/1',
        'owner_id': value['owner_id'], 'business_id': value['business_id'], 'session_id': value['session_id'],
        'job_id': job_id, 'execution_id': execution_id, 'source_version': '1',
        'response_locale': value['response_locale'], 'locale_revision': value['locale_revision'],
        'text': text, 'profile': getattr(identity, 'profile', None),
        'captured_at': now.isoformat(), 'home': home_resolver(job_id)}
    directory = root / 'receipts'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        return False
    name = hashlib.sha256((job_id + '\0' + execution_id).encode()).hexdigest() + '.json'
    target = directory / name
    # Atomic creation without replacement: a repeated callback cannot change the first receipt.
    fd, temporary = tempfile.mkstemp(prefix='.receipt-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(receipt, stream, ensure_ascii=False, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            return False
        return True
    finally:
        os.unlink(temporary)
