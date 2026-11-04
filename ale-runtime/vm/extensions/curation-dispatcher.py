#!/usr/bin/env python3
"""Deterministic curation reconciliation through Brain and official Kanban CLI.

No model is invoked by this script. A nonempty durable batch may enqueue one
native curator task, sharing the existing worker capacity. Empty work is silent.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

IDENTIFIER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$')
MAX_HTTP_BYTES = 2097152
MARKER = 'SALEADS_CURATION_BATCH_V1 '


class DispatchError(Exception):
    """Fixed public code only; never retain subprocess output or HTTP bodies."""


def read_registry(root):
    path = root / 'trusted-contexts.json'
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 524288:
        raise DispatchError('trusted_registry_unavailable')
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        raise DispatchError('trusted_registry_unavailable') from None
    if (not isinstance(value, dict) or value.get('schema_version') != 'trusted-context-registry/1'
            or not isinstance(value.get('owner_id'), str) or not value['owner_id']
            or not isinstance(value.get('contexts'), list)):
        raise DispatchError('trusted_registry_invalid')
    return value


def credentials(home):
    """Use a private collector token or derive it from the root-only MCP token."""
    private = home / 'plugin-data/saleads-memory/collector-token'
    if private.is_file() and not private.is_symlink():
        token = private.read_text().strip()
        if token:
            return 'http://saleads-brain:8765', token
    try:
        path = home / 'config.yaml'
        if path.is_symlink() or path.stat().st_size > 1048576:
            raise DispatchError('collector_auth_unavailable')
        text = path.read_text()
        try:
            config = json.loads(text)
        except ValueError:
            import hermes_yaml
            config = hermes_yaml.safe_load(text)
        server = config['mcp_servers']['saleads-brain']
        parsed = urlsplit(server['url'])
        if parsed.scheme != 'http' or parsed.hostname != 'saleads-brain' or parsed.port != 8765:
            raise DispatchError('brain_origin_invalid')
        token = server['headers']['x-saleads-brain-token']
        if not isinstance(token, str) or not token:
            raise DispatchError('collector_auth_unavailable')
        derived = hmac.new(token.encode(), b'mcl-collector', hashlib.sha256).hexdigest()
        return 'http://saleads-brain:8765', derived
    except (KeyError, TypeError, OSError, ImportError, ValueError):
        raise DispatchError('collector_auth_unavailable') from None


class Brain:
    def __init__(self, base, token):
        self.base, self.token = base, token

    def post(self, path, body):
        request = Request(self.base + path,
            data=json.dumps(body, separators=(',', ':')).encode(), method='POST',
            headers={'Content-Type': 'application/json', 'x-saleads-brain-token': self.token})
        try:
            with urlopen(request, timeout=15) as response:
                raw = response.read(MAX_HTTP_BYTES + 1)
            if len(raw) > MAX_HTTP_BYTES:
                raise DispatchError('brain_response_too_large')
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise DispatchError('brain_response_invalid')
            return value
        except HTTPError as error:
            raise DispatchError('brain_http_' + str(error.code)) from None
        except (URLError, TimeoutError, ValueError):
            raise DispatchError('brain_unavailable') from None


class Kanban:
    def __init__(self, home, *, run=subprocess.run):
        self.home, self.run = home, run

    def call(self, *arguments, body=None):
        env = dict(os.environ)
        for key in ('HERMES_TENANT', 'HERMES_KANBAN_TASK', 'HERMES_KANBAN_RUN_ID',
                    'HERMES_KANBAN_CLAIM_LOCK', 'HERMES_KANBAN_WORKSPACE', 'HERMES_PROFILE'):
            env.pop(key, None)
        env.update(HERMES_HOME=str(self.home), HERMES_KANBAN_HOME=str(self.home))
        try:
            # Gateway children may omit the venv bin directory from PATH. Use
            # the official console entrypoint with this same SDK interpreter.
            process = self.run([sys.executable, '-m', 'hermes_cli.main', '-p', 'default', 'kanban', *arguments, '--json'],
                input=body, text=True, capture_output=True, timeout=30, check=False, env=env)
        except subprocess.TimeoutExpired:
            # Creation may have committed: next attempt reuses the same idempotency key.
            raise DispatchError('native_ack_unknown') from None
        except OSError:
            raise DispatchError('native_cli_unavailable') from None
        finally:
            # A native command can create a root SQLite store, even when its ACK
            # is lost. Keep its idle RO handle before Brain opens its RO mount.
            retain_native_readers(self.home)
        if process.returncode != 0:
            raise DispatchError('native_cli_failed')
        try:
            return json.loads(process.stdout)
        except ValueError:
            raise DispatchError('native_response_invalid') from None


def body_for(batch):
    binding = {key: batch[key] for key in ('batch_id', 'business_id')}
    return ('Curate only the assigned durable batch. Read it using saleads_curation_batch. '
            'Preserve authentic authorship, evidence, validation states, business isolation, '
            'and individual specialist experience. Use saleads_commit_candidates to commit '
            'supported knowledge/experience or an explicit discard before kanban_complete. '
            'No owner message, commercial operation, terminal, web search, new worker, or skill edit.\n'
            + MARKER + json.dumps(binding, separators=(',', ':'), sort_keys=True))


def verified_task(shown, batch):
    if not isinstance(shown, dict) or not isinstance(shown.get('task'), dict):
        raise DispatchError('native_task_unverified')
    task = shown['task']
    if task.get('tenant') != batch['business_id'] or task.get('assignee') != 'curador':
        raise DispatchError('native_task_binding_mismatch')
    markers = [line[len(MARKER):] for line in str(task.get('body', '')).splitlines() if line.startswith(MARKER)]
    expected = {key: batch[key] for key in ('batch_id', 'business_id')}
    try:
        if len(markers) != 1 or json.loads(markers[0]) != expected:
            raise DispatchError('native_task_binding_mismatch')
    except ValueError:
        raise DispatchError('native_task_binding_mismatch') from None
    return task


def reconcile(registry, brain, kanban):
    owner = registry['owner_id']
    businesses = sorted({v['business_id'] for v in registry['contexts'] if isinstance(v, dict)
        and v.get('owner_id') == owner and v.get('actor_role') == 'ale'
        and isinstance(v.get('business_id'), str)})
    totals = {'batches': 0, 'created_or_recovered': 0, 'reconciled': 0}
    for business in businesses:
        pending = brain.post('/continuous/batches/pending', {'business_id': business}).get('batches')
        if not isinstance(pending, list):
            raise DispatchError('brain_batch_list_invalid')
        for batch in pending:
            if (not isinstance(batch, dict) or batch.get('schema_version') != 'curation-batch/1'
                    or batch.get('owner_id') != owner or batch.get('business_id') != business
                    or batch.get('state') not in {'pending', 'dispatched', 'running', 'failed'}
                    or not isinstance(batch.get('batch_id'), str) or not IDENTIFIER.fullmatch(batch['batch_id'])
                    or not isinstance(batch.get('idempotency_key'), str) or not IDENTIFIER.fullmatch(batch['idempotency_key'])):
                raise DispatchError('brain_batch_binding_invalid')
            totals['batches'] += 1
            native_id = batch.get('native_task_id')
            if native_id is None:
                created = kanban.call('create', 'Curate durable business evidence', '--body-file', '-',
                    '--tenant', business, '--assignee', 'curador', '--idempotency-key', batch['idempotency_key'],
                    body=body_for(batch))
                native_id = created.get('id') if isinstance(created, dict) else None
                totals['created_or_recovered'] += 1
            if not isinstance(native_id, str) or not IDENTIFIER.fullmatch(native_id):
                raise DispatchError('native_task_unverified')
            shown = kanban.call('show', native_id)
            task = verified_task(shown, batch)
            if task.get('id') != native_id:
                raise DispatchError('native_task_binding_mismatch')
            runs = shown.get('runs')
            if not isinstance(runs, list):
                raise DispatchError('native_runs_unverified')
            latest = runs[-1] if runs else None
            run_id = str(latest['id']) if isinstance(latest, dict) and latest.get('id') is not None else None
            if latest and latest.get('profile') != 'curador':
                raise DispatchError('native_run_profile_mismatch')
            binding = {'business_id': business, 'task_id': native_id, 'run_id': run_id}
            if task.get('status') in {'done', 'archived'}:
                # A summary is not a memory commit. Keep the same task/run for diagnosis/recovery.
                binding['error_code'] = 'native_completed_without_curation_commit'
            elif task.get('status') == 'blocked':
                binding['error_code'] = 'native_curation_blocked'
            brain.post('/continuous/batches/' + quote(batch['batch_id'], safe='') + '/native', binding)
            totals['reconciled'] += 1
    return totals


def memory_package(home: Path):
    """Load the same fixed package for recovery and its native RO handles."""
    directory = home / 'plugins/saleads-memory'
    entry = directory / '__init__.py'
    if directory.is_symlink() or not entry.is_file() or entry.is_symlink():
        raise DispatchError('memory_plugin_unavailable')
    name = '_saleads_memory_dispatch_recovery'
    try:
        if name not in sys.modules:
            spec = importlib.util.spec_from_file_location(name, entry, submodule_search_locations=[str(directory)])
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
        return name
    except (ImportError, AttributeError, OSError, ValueError):
        sys.modules.pop(name, None)
        raise DispatchError('source_recovery_unavailable') from None


def retain_native_readers(home: Path):
    """Keep only existing fixed root stores; never initialize a missing DB."""
    if not any((home / name).exists() or (home / name).is_symlink()
               for name in ('kanban.db', 'state.db')):
        return
    try:
        context = importlib.import_module(memory_package(home) + '.context')
        context.retain_native_sqlite_anchors(home)
    except (ImportError, AttributeError, OSError, ValueError, sqlite3.Error):
        raise DispatchError('native_sqlite_anchor_unavailable') from None


def reconcile_staged_sources(home: Path):
    """Recover verified native completions before querying pending batches."""
    try:
        capture = importlib.import_module(memory_package(home) + '.specialist_capture')
        return capture.reconcile_all(home)
    except (ImportError, AttributeError, OSError, ValueError):
        raise DispatchError('source_recovery_unavailable') from None


def run_once(home: Path):
    root = home / 'saleads/continuous'
    data = read_registry(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / '.curation-dispatch.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'busy': True}
        retain_native_readers(home)
        reconcile_staged_sources(home)
        base, token = credentials(home)
        return reconcile(data, Brain(base, token), Kanban(home))


def write_status(home: Path, exit_code, exception_class=None, error_code=None):
    """One bounded private diagnostic; never store exception messages or output."""
    directory = home / 'saleads/continuous'
    if directory.is_symlink() or not directory.is_dir():
        return
    value = {'schema_version': 'curation-dispatch-status/1',
             'finished_at': dt.datetime.now(dt.timezone.utc).isoformat(),
             'exit_code': exit_code, 'exception_class': exception_class,
             'error_code': error_code}
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix='.curation-status-', dir=directory)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True, separators=(',', ':'))
        os.replace(temporary, directory / 'curation-dispatch-status.json')
    except OSError:
        pass  # Observability cannot invent success or replace the real exit code.
    finally:
        if temporary and os.path.exists(temporary):
            try:
                os.unlink(temporary)
            except OSError:
                pass


def main(home: Path):
    try:
        run_once(home)
    except DispatchError as error:
        code = str(error)
        if re.fullmatch(r'[a-z][a-z0-9_]{0,63}', code) is None:
            code = 'dispatch_failed'
        write_status(home, 2, 'DispatchError', code)
        print(code, file=sys.stderr)
        return 2
    except Exception as error:
        write_status(home, 1, type(error).__name__[:64])
        print('curation_dispatch_failed', file=sys.stderr)
        return 1
    write_status(home, 0)
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, default=Path('/opt/data'))
    args = parser.parse_args()
    sys.exit(main(args.data_dir))
