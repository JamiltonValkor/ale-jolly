#!/usr/bin/env python3
"""Read-only native cron projection. Never invokes a model or edits Hermes DBs."""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile

MAX_RECEIPTS = 1000
MAX_RECEIPT_BYTES = 100000
RECONCILE_SECONDS = 120
PROFILE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')


def plugin():
    candidates = [Path(__file__).parent / 'saleads-continuity',
                  Path(__file__).parent.parent / 'plugins/saleads-continuity',
                  Path(__file__).parents[2] / 'plugins/saleads-continuity']
    directory = next((p for p in candidates if (p / '__init__.py').is_file()), None)
    if directory is None:
        raise RuntimeError('managed_continuity_plugin_missing')
    name = '_saleads_continuity_exporter'
    spec = importlib.util.spec_from_file_location(name, directory / '__init__.py', submodule_search_locations=[str(directory)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return sys.modules[name + '.context'], sys.modules[name + '.notifications']


def instant(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return dt.datetime.fromtimestamp(value, dt.timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo is not None else None
    except ValueError:
        return None


def row(path: Path, sql: str, params):
    if path.is_symlink() or not path.is_file():
        return None
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    try:
        result = connection.execute(sql, params).fetchone()
        return dict(result) if result else None
    finally:
        connection.close()


def read_delivery(home: Path, execution_id):
    path = home / 'cron/deliveries.db'
    result = row(path, 'SELECT execution_id,status,finished_at,error FROM deliveries WHERE execution_id=?', (execution_id,))
    if result is None and path.is_file():
        result = row(path, 'SELECT execution_id,terminal_status AS status,finished_at FROM delivery_tombstones WHERE execution_id=?', (execution_id,))
    return result


def disposition(receipt, execution, queued, finished, proof=None):
    reference = 'native:cron/executions/' + receipt['execution_id']
    if (isinstance(proof, dict) and proof.get('schema_version') == 'managed-home-receipt/1'
            and all(proof.get(key) == receipt.get(key) for key in ('owner_id', 'business_id', 'session_id',
                    'job_id', 'execution_id', 'response_locale', 'locale_revision'))
            and proof.get('content_sha256') == hashlib.sha256(receipt['text'].encode()).hexdigest()
            and isinstance(proof.get('targets'), list)):
        confirmed = [target for target in proof['targets'] if isinstance(target, dict)
                     and target.get('state') == 'delivered' and isinstance(target.get('ack_sha256'), str)
                     and re.fullmatch(r'[a-f0-9]{64}', target['ack_sha256'])]
        # Also recovers a crash after a target ACK was persisted but before the
        # final aggregate state was written. No resend is necessary.
        state = 'delivered' if confirmed else proof.get('state')
        if state == 'delivered' and not confirmed:
            state = 'unknown'
        if state in {'delivered', 'failed', 'no_home', 'unknown'}:
            result = {'state': state, 'evidence_ref': 'native:managed-home/' + receipt['execution_id'],
                      'reconcile_by': (finished + dt.timedelta(seconds=RECONCILE_SECONDS)).isoformat() if state == 'unknown' else None}
            if isinstance(proof.get('destination_version'), str):
                result['destination_version'] = proof['destination_version']
            return result
    if execution.get('delivery_outcome') == 'failed' or (queued and queued.get('status') == 'failed'):
        return {'state': 'failed', 'evidence_ref': reference, 'reconcile_by': None}
    if receipt.get('home', {}).get('state') == 'no_home':
        return {'state': 'no_home', 'evidence_ref': reference, 'reconcile_by': None}
    # Native delivered can include an in-flight timeout or ackless adapter success.
    # Without an attempt-bound provider confirmation this remains uncertain, even
    # when the queue calls it delivered. No resend is performed by the exporter.
    return {'state': 'unknown', 'evidence_ref': reference,
            'reconcile_by': (finished + dt.timedelta(seconds=RECONCILE_SECONDS)).isoformat()}


def project(root: Path, hermes_home: Path, *, now=None):
    context, notification = plugin()
    data = context.registry(root)
    now = now or dt.datetime.now(dt.timezone.utc)
    if data is None:
        raise ValueError('trusted_context_registry_unavailable')
    output = {'schema_version': 'native-notifications/1', 'owner_id': data['owner_id'],
              'observed_at': now.isoformat(), 'notifications': []}
    # First API use may have no cron-output directory. Copy/export acceptance
    # proof before that independent delivery path's early return.
    output['run_receipts'] = sys.modules[context.__package__ + '.run_receipts'].projection(
        data, root=root, home=hermes_home)
    directory = root / 'receipts'
    if not directory.is_dir() or directory.is_symlink():
        return output
    jobs = {j.get('job_id'): j for j in data['jobs'] if isinstance(j, dict)}
    duplicate_jobs = {j.get('job_id') for j in data['jobs'] if isinstance(j, dict)
                      and sum(1 for other in data['jobs'] if isinstance(other, dict) and other.get('job_id') == j.get('job_id')) > 1}
    for path in sorted(directory.glob('*.json'))[:MAX_RECEIPTS]:
        if path.is_symlink() or path.stat().st_size > MAX_RECEIPT_BYTES:
            continue
        try:
            receipt = json.loads(path.read_text())
            if not isinstance(receipt, dict) or receipt.get('schema_version') != 'native-cron-receipt/1':
                continue
            job = jobs.get(receipt.get('job_id'))
            if (not job or receipt.get('job_id') in duplicate_jobs or receipt.get('owner_id') != data['owner_id']
                    or any(receipt.get(k) != job.get(k) for k in ('business_id', 'session_id', 'response_locale', 'locale_revision'))):
                continue
            matches = [v for v in data['contexts'] if context.valid_context(v, data['owner_id'])
                       and v.get('actor_role') == 'ale' and v['business_id'] == receipt['business_id']
                       and v['session_id'] == receipt['session_id']]
            if len(matches) != 1 or notification.visible_text(receipt.get('text')) is None:
                continue
            execution_id = receipt.get('execution_id')
            if not isinstance(execution_id, str) or not execution_id or len(execution_id) > 200:
                continue
            profile = receipt.get('profile')
            if profile in (None, '', 'default'):
                native_home = hermes_home
            elif isinstance(profile, str) and PROFILE.fullmatch(profile):
                native_home = hermes_home / 'profiles' / profile
            else:
                continue
            if native_home.is_symlink():
                continue
            execution = row(native_home / 'cron/executions.db',
                'SELECT id,job_id,status,finished_at,delivery_outcome FROM executions WHERE id=?', (execution_id,))
            if not execution or execution['job_id'] != receipt['job_id'] or execution['status'] != 'completed':
                continue
            finished = instant(execution.get('finished_at'))
            if finished is None:
                continue
            queued = read_delivery(native_home, execution_id)
            managed = sys.modules[context.__package__ + '.delivery'].read_result(root, receipt['job_id'], execution_id)
            output['notifications'].append({
                'job_id': receipt['job_id'], 'execution_id': execution_id, 'source_version': '1',
                'response_locale': receipt['response_locale'], 'locale_revision': receipt['locale_revision'],
                'text': receipt['text'], 'terminal_state': 'completed', 'limitations': [],
                'finished_at': finished.isoformat(),
                'delivery': disposition(receipt, execution, queued, finished, managed),
            })
        except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
            # Skip this source; no fallback to another execution, owner, business, or text.
            continue
    output['notifications'].sort(key=lambda v: (v['finished_at'], v['execution_id']))
    return output


def write_projection(output, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    encoded = json.dumps(output, separators=(',', ':'), sort_keys=True, ensure_ascii=False).encode()
    fd, temporary = tempfile.mkstemp(prefix='.notifications-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(gzip.compress(encoded, mtime=0))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return hashlib.sha256(encoded).hexdigest()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, default=Path('/opt/data'))
    parser.add_argument('--root', type=Path)
    parser.add_argument('--hermes-home', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    root = args.root or args.data_dir / 'saleads/continuous'
    document = project(root, args.hermes_home or args.data_dir)
    write_projection(document, args.out or root / 'notifications.json.gz')
