"""Positive API-run acceptance observations and read-only durable status copies.

No request text, provider output, errors, API credentials, or prompt is stored.
The native run ContextVar is joined to its exact SQLite row; no replay POST is
issued and no native table is changed, including when retention has expired.
"""
from __future__ import annotations

from contextlib import closing
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import time

ROOT = Path('/opt/data/saleads/continuous')
HOME = Path('/opt/data')
RUN_ID = re.compile(r'^run_[a-f0-9]{32}$')
KEY = re.compile(r'^first-loop-([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$')
HASH = re.compile(r'^[a-f0-9]{64}$')
TERMINAL = frozenset({'completed', 'failed', 'cancelled', 'interrupted'})
STATUSES = TERMINAL | {'queued', 'running', 'waiting_for_approval', 'stopping'}
MAX_FILE_BYTES = 32768
MAX_INPUT_BYTES = 262144


class ReceiptError(ValueError):
    """Fixed diagnostic code only, never a source exception or private value."""


def native_run_id():
    """The approval namespace is an actual run ID only for /v1/runs."""
    try:
        from gateway.session_context import get_session_env
        value = get_session_env('HERMES_SESSION_KEY', '')
        if isinstance(value, str) and RUN_ID.fullmatch(value):
            return value
        from tools.approval_context import get_current_session_key
        value = get_current_session_key('')
        return value if isinstance(value, str) and RUN_ID.fullmatch(value) else None
    except (ImportError, AttributeError, RuntimeError):
        return None


def iso(value):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ReceiptError('invalid_native_run_timestamp')
    try:
        return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat()
    except (ValueError, OverflowError, OSError):
        raise ReceiptError('invalid_native_run_timestamp') from None


def read_json(path):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            return None
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or path.is_symlink():
        raise ReceiptError('run_receipt_path_invalid')
    fd, temporary = tempfile.mkstemp(prefix='.run-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True, separators=(',', ':'))
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def native_row(home, run_id):
    path = home / 'runs_idempotency.db'
    if path.is_symlink() or not path.is_file() or not RUN_ID.fullmatch(run_id):
        return None
    try:
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute("SELECT scope AS native_scope_sha256,idempotency_key,fingerprint,run_id,created_at,updated_at,"
                              "json_extract(status_json,'$.run_id') AS status_run_id,"
                              "json_extract(status_json,'$.session_id') AS native_session_id,"
                              "json_extract(status_json,'$.status') AS native_status "
                              'FROM run_idempotency WHERE run_id=? LIMIT 2', (run_id,)).fetchall()
        if len(rows) != 1:
            return None
        row = dict(rows[0])
        match = KEY.fullmatch(row['idempotency_key'])
        if (match is None or not HASH.fullmatch(row['fingerprint']) or not HASH.fullmatch(row['native_scope_sha256'])
                or row.pop('status_run_id') != run_id or row.get('native_status') not in STATUSES
                or not isinstance(row.get('native_session_id'), str) or not row['native_session_id']):
            return None
        # Deliberately never return status.output/error/usage/model or the auth scope.
        return {**row, 'turn_id': match.group(1), 'native_created_at': iso(row['created_at']),
                'native_updated_at': iso(row['updated_at'])}
    except (sqlite3.Error, ValueError, TypeError, KeyError):
        return None


def binding_valid(context):
    return (isinstance(context, dict) and context.get('actor_role') == 'ale'
            and context.get('schema_version') == 'trusted-context/1'
            and all(isinstance(context.get(key), str) and bool(context[key])
                    for key in ('owner_id', 'business_id', 'session_id')))


def pre_valid(value):
    return (isinstance(value, dict) and value.get('schema_version') == 'native-run-pre/1'
            and bool(RUN_ID.fullmatch(str(value.get('run_id', ''))))
            and bool(HASH.fullmatch(str(value.get('request_text_sha256', ''))))
            and all(isinstance(value.get(key), str) and 0 < len(value[key]) <= 200
                    for key in ('owner_id', 'business_id', 'session_id', 'native_session_id'))
            and isinstance(value.get('observed_at'), str))


def promote(pre, row, root, *, observed_at):
    """One backend turn can never silently acquire a different native run."""
    path = root / 'run-receipts/accepted' / (row['turn_id'] + '.json')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = read_json(path)
        if previous is None and path.exists():
            raise ReceiptError('run_receipt_corrupt')
        identity = ('owner_id', 'business_id', 'session_id', 'request_text_sha256', 'run_id')
        if previous and (any(previous.get(key) != pre.get(key) for key in identity)
                         or previous.get('native_request_fingerprint') != row['fingerprint']
                         or previous.get('native_scope_sha256') != row['native_scope_sha256']):
            # Keep the first native identity. Record only an opaque conflict mark.
            previous['proof_gap'] = 'native_turn_identity_conflict'
            atomic(path, previous)
            return previous
        if not previous and row['native_session_id'] not in (pre['session_id'], pre['native_session_id']):
            raise ReceiptError('native_run_session_mismatch')
        terminal = row['native_status'] in TERMINAL
        receipt = previous or {
            'schema_version': 'native-run-receipt/1',
            **{key: pre[key] for key in identity}, 'turn_id': row['turn_id'],
            'idempotency_key': row['idempotency_key'], 'native_request_fingerprint': row['fingerprint'],
            'native_scope_sha256': row['native_scope_sha256'],
            'accepted_at': pre['observed_at'], 'native_created_at': row['native_created_at'],
            'native_status': row['native_status'], 'terminal_proven': terminal,
            'native_updated_at': row['native_updated_at'], 'status_observed_at': observed_at,
            'native_record_present': True, 'proof_gap': None,
        }
        if receipt['terminal_proven']:
            if terminal and receipt['native_status'] != row['native_status']:
                receipt['proof_gap'] = 'native_terminal_identity_conflict'
            # Stale running reads cannot erase an already copied terminal proof.
        elif row['native_updated_at'] >= receipt['native_updated_at']:
            gap = receipt.get('proof_gap')
            receipt.update(native_status=row['native_status'], terminal_proven=terminal,
                native_updated_at=row['native_updated_at'], status_observed_at=observed_at,
                native_record_present=True, proof_gap=gap)
        atomic(path, receipt)
        return receipt


def capture(context, user_message, *, native_session_id='', root=ROOT, home=HOME,
            run_id_provider=native_run_id, clock=time.time):
    """Called from pre_llm_call, before a model or tool effect is allowed to run."""
    if not binding_valid(context) or not isinstance(user_message, str):
        return False
    run_id = run_id_provider()
    if not isinstance(run_id, str) or RUN_ID.fullmatch(run_id) is None:
        return False
    try:
        raw = user_message.encode('utf-8')
    except UnicodeError:
        return False
    if not raw or len(raw) > MAX_INPUT_BYTES:
        return False
    observed_at = iso(clock())
    pre = {'schema_version': 'native-run-pre/1', 'owner_id': context['owner_id'],
        'business_id': context['business_id'], 'session_id': context['session_id'],
        'native_session_id': native_session_id or context['session_id'], 'run_id': run_id,
        'request_text_sha256': hashlib.sha256(raw).hexdigest(), 'observed_at': observed_at}
    path = root / 'run-receipts/pre' / (run_id + '.json')
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = read_json(path)
        if previous is None and path.exists():
            raise ReceiptError('run_pre_receipt_corrupt')
        if previous:
            if any(previous.get(key) != pre[key] for key in pre if key != 'observed_at'):
                raise ReceiptError('native_run_pre_identity_conflict')
            pre = previous
        else:
            atomic(path, pre)
    row = native_row(home, run_id)
    if row is not None:
        promote(pre, row, root, observed_at=observed_at)
    return True


def refresh(*, root=ROOT, home=HOME, clock=time.time):
    """Copy exact statuses before a new native reserve/lookup prunes expired rows."""
    observed_at = iso(clock())
    directory = root / 'run-receipts/pre'
    if directory.is_symlink() or not directory.is_dir():
        return 0
    copied = 0
    for path in sorted(directory.glob('run_*.json')):
        pre = read_json(path)
        if not pre_valid(pre):
            continue
        row = native_row(home, pre['run_id'])
        if row is not None:
            try:
                promote(pre, row, root, observed_at=observed_at)
                copied += 1
            except ReceiptError:
                continue
    return copied


def projection(registry, *, root=ROOT, home=HOME, clock=time.time):
    """Only backend-correlatable opaque proof is exported; missing is not failed."""
    refresh(root=root, home=home, clock=clock)
    matches = {(entry.get('owner_id'), entry.get('business_id'), entry.get('session_id'))
               for entry in registry.get('contexts', []) if isinstance(entry, dict)
               and entry.get('actor_role') == 'ale' and entry.get('owner_id') == registry.get('owner_id')}
    directory = root / 'run-receipts/accepted'
    if directory.is_symlink() or not directory.is_dir():
        return []
    result = []
    for path in sorted(directory.glob('*.json')):
        value = read_json(path)
        if (not value or value.get('schema_version') != 'native-run-receipt/1'
                or (value.get('owner_id'), value.get('business_id'), value.get('session_id')) not in matches
                or KEY.fullmatch(str(value.get('idempotency_key', ''))) is None
                or 'first-loop-' + str(value.get('turn_id', '')) != value.get('idempotency_key')
                or not RUN_ID.fullmatch(str(value.get('run_id', '')))
                or not HASH.fullmatch(str(value.get('request_text_sha256', '')))
                or not HASH.fullmatch(str(value.get('native_request_fingerprint', '')))
                or not HASH.fullmatch(str(value.get('native_scope_sha256', '')))
                or value.get('native_status') not in STATUSES or type(value.get('terminal_proven')) is not bool
                or value['terminal_proven'] and value['native_status'] not in TERMINAL
                or value.get('proof_gap') not in (None, 'native_turn_identity_conflict', 'native_terminal_identity_conflict')
                or any(not isinstance(value.get(key), str) for key in
                       ('accepted_at', 'native_created_at', 'native_updated_at', 'status_observed_at'))):
            continue
        # This output is a closed whitelist. Never forward arbitrary local fields.
        entry = {key: value[key] for key in ('schema_version', 'owner_id', 'business_id', 'session_id',
            'turn_id', 'idempotency_key', 'run_id', 'request_text_sha256', 'native_request_fingerprint',
            'native_scope_sha256',
            'accepted_at', 'native_created_at', 'native_updated_at', 'status_observed_at',
            'native_status', 'terminal_proven', 'proof_gap')}
        present = native_row(home, value['run_id']) is not None
        entry['native_record_present'] = present
        if not present and not value['terminal_proven'] and entry['proof_gap'] is None:
            entry['proof_gap'] = 'native_terminal_proof_unavailable'
        result.append(entry)
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, default=HOME)
    options = parser.parse_args()
    # Offline copier is safe before Hermes starts; stdout contains no receipts.
    refresh(root=options.data_dir / 'saleads/continuous', home=options.data_dir)
