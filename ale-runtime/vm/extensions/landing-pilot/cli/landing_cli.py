#!/usr/bin/env python3
"""Experimental Landing file adapter over the existing SaleADS CLI and Hermes runtime.

No URL/token input, custom OAuth client, direct service call or automatic write retry.
The installed SaleADS CLI supplies its service-owned host, OAuth credential,
discovery/schema validation and HTTP executor. This adapter only packs/reads files.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import importlib.util
import json
import io
import logging
import os
import re
from pathlib import Path
import stat
import tempfile
import sys
import time
import math
from typing import Any

OPERATION_COMMAND = 'saleads_get_operation'
PENDING_STATUSES = frozenset({'queued', 'running'})
FAILURE_STATUSES = frozenset({'failed', 'cancelled', 'abandoned'})
DEFAULT_WAIT = 120
MAX_WAIT = 600
AUTH_REFRESH_WINDOW = 60
AUTH_CONNECT_TIMEOUT = 30
MEMORY_CORROBORATION_TIMEOUT = 15

ARTIFACT_COMMANDS = frozenset({'saleads_landing_validate', 'saleads_landing_preview', 'saleads_landing_submit_version'})
DESTINATION_COMMANDS = frozenset({'saleads_agent_prepare_landing_destination', 'saleads_agent_get_landing_destination'})
MAX_FILE = 300 * 1024
MAX_TOTAL = 400 * 1024
MAX_METADATA = 32 * 1024
MAX_REQUEST = 576 * 1024
FILENAMES = ('index.html', 'styles.css')


def json_bytes(value: Any) -> bytes:
    # Match the existing CLI's actual HTTP serialization, including ensure_ascii=True.
    return json.dumps(value).encode('utf-8')


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def pack_files(workspace: Path) -> dict[str, Any]:
    files = {}
    total = 0
    directory = workspace.resolve(strict=True)
    for name in FILENAMES:
        path = directory / name
        if path.is_symlink() or not stat.S_ISREG(path.stat().st_mode):
            raise ValueError('Landing files must be regular files, not symlinks.')
        raw = path.read_bytes()
        raw.decode('utf-8', errors='strict')
        if len(raw) > MAX_FILE:
            raise ValueError(f'{name} exceeds the 300 KiB limit.')
        total += len(raw)
        files[name] = {'encoding': 'base64', 'content': base64.b64encode(raw).decode('ascii'),
                       'sha256': hashlib.sha256(raw).hexdigest(), 'byteLength': len(raw)}
    if total > MAX_TOTAL:
        raise ValueError('Combined HTML/CSS exceeds the 400 KiB limit.')
    return files


def prepare_args(command: str, args: dict[str, Any], workspace: Path | None) -> dict[str, Any]:
    out = dict(args)
    if command == OPERATION_COMMAND:
        if set(out) != {'operation_id'} or not isinstance(out['operation_id'], str) or not out['operation_id'].strip():
            raise ValueError('Read resume requires only the saved operation_id.')
    elif not command.startswith('saleads_landing_') and command not in DESTINATION_COMMANDS:
        raise ValueError('This adapter only serves the Landing commands discovered by SaleADS.')
    if command in ARTIFACT_COMMANDS:
        if workspace is None:
            raise ValueError('An artifact command requires --workspace.')
        if not isinstance(out.get('client_request_id'), str):
            raise ValueError('Artifact requests require a durable client_request_id.')
        out['files'] = pack_files(workspace)
    elif workspace is not None:
        raise ValueError('--workspace is only valid for artifact commands.')
    if command == 'saleads_landing_create' and not isinstance(out.get('client_request_id'), str):
        raise ValueError('Create requires a durable client_request_id.')
    if command == 'saleads_agent_prepare_landing_destination' and (
            not isinstance(out.get('client_request_id'), str)
            or not re.fullmatch(r'[A-Za-z0-9_.:-]{8,128}', out['client_request_id'])):
        raise ValueError('Destination preparation requires a durable client_request_id of8–128 allowed characters.')
    if command in ARTIFACT_COMMANDS or command == 'saleads_landing_create':
        if not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', out['client_request_id']):
            raise ValueError('client_request_id must be8–100 letters, digits, underscores or hyphens.')
    if len(json_bytes(out.get('metadata', {}))) > MAX_METADATA:
        raise ValueError('Artifact metadata exceeds 32 KiB.')
    if len(json_bytes(out)) > MAX_REQUEST:
        raise ValueError('Serialized request exceeds 576 KiB; nothing was sent.')
    return out


def load_cli() -> Any:
    home = Path(os.environ.get('HERMES_HOME') or '/opt/data')
    source = home / 'skills/saleads-cli/scripts/saleads.py'
    spec = importlib.util.spec_from_file_location('saleads_installed_cli', source)
    if spec is None or spec.loader is None:
        raise ValueError('Installed SaleADS CLI was not found.')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _native_auth_json(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise ValueError('Native authorization record unavailable.')
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('Native authorization record invalid.')
    return value


def _access_expiry(record: dict[str, Any]) -> float:
    expiry = record.get('expires_at')
    if (type(expiry) not in (int, float) or not math.isfinite(expiry)
            or not isinstance(record.get('access_token'), str) or not record['access_token']):
        raise ValueError('Native access metadata unavailable.')
    return float(expiry)


def ensure_runtime_auth(cli: Any, *, deadline: float | None = None) -> None:
    """Ask the official MCP probe to renew the existing authorization; never implement OAuth here."""
    timeout = AUTH_CONNECT_TIMEOUT
    if deadline is not None:
        timeout = min(timeout, deadline - time.monotonic())
        if timeout <= 0:
            raise TimeoutError('Operation read budget exhausted.')
    try:
        directory = Path(cli.home()) / 'mcp-tokens'
        token_path, client_path = directory / 'saleads.json', directory / 'saleads.client.json'
        record = _native_auth_json(token_path)
        if _access_expiry(record) > time.time() + AUTH_REFRESH_WINDOW:
            return
        if not isinstance(record.get('refresh_token'), str) or not record['refresh_token']:
            raise ValueError('Existing refresh authorization unavailable.')
        previous = logging.root.manager.disable
        try:
            logging.disable(logging.CRITICAL)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                from hermes_cli.config import load_config_readonly
                from hermes_cli.mcp_config import _probe_single_server
                from tools.mcp_oauth import suppress_interactive_oauth
                config = load_config_readonly().get('mcp_servers', {}).get('saleads', {})
                client_id = config.get('oauth', {}).get('client_id')
                stored = _native_auth_json(client_path)
                if config.get('auth') != 'oauth' or not isinstance(client_id, str) or not client_id or stored.get('client_id') != client_id:
                    raise ValueError('Existing OAuth client binding unavailable.')
                with suppress_interactive_oauth():
                    _probe_single_server('saleads', config, connect_timeout=timeout)
        finally:
            logging.disable(previous)
        # Hermes owns refresh, concurrency control and token persistence. Reload only its files.
        if (_native_auth_json(client_path).get('client_id') != client_id
                or _access_expiry(_native_auth_json(token_path)) <= time.time()):
            raise ValueError('Native authorization did not leave valid existing access.')
    except Exception:
        # SDK errors may contain credential material; the CLI receives only this fixed envelope.
        raise cli.CliError(getattr(cli, 'EXIT_AUTH', 5), 'AUTH_REQUIRED',
                           'SaleADS access could not be renewed through the existing Hermes authorization.',
                           'Report the access issue through SaleADS; do not automatically repeat a write.') from None


def run_command(cli: Any, command: str, args: dict[str, Any], *, deadline: float | None = None) -> dict[str, Any]:
    settings = cli.load_settings()
    ensure_runtime_auth(cli, deadline=deadline)
    token = cli.read_token()
    original_http = cli.http
    slow = command in ARTIFACT_COMMANDS or command == 'saleads_landing_prepare_assets'
    if slow or deadline is not None:
        def bounded_http(method: str, url: str, credential: str, body: Any = None,
                         headers: dict[str, str] | None = None, timeout: float = 90) -> Any:
            limit = max(timeout, 180) if slow else timeout
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Operation read budget exhausted.')
                limit = min(limit, remaining)
            return original_http(method, url, credential, body, headers, timeout=limit)
        cli.http = bounded_http
    try:
        entries = cli.catalog(settings, token, refresh=True)
        entry = next((row for row in entries if row.get('name') == command), None)
        if entry is None:
            raise cli.CliError(cli.EXIT_DENIED, 'MCP-E-UNKNOWN-COMMAND', 'Landing capability is unavailable.',
                               'Read the live SaleADS command catalog; do not call internal services.')
        opts = {'args': args, 'loose': {}, 'positional': [], 'full': True, 'fields': None,
                'id': args.get('client_request_id'), 'wait': 0, 'transport': 'rest',
                'language': args.get('locale'), 'max_credits': None}
        return cli.execute(settings, token, command, opts, entry)
    finally:
        cli.http = original_http


def _native_landing_function(cli: Any, function_name: str) -> Any:
    """Only the managed Root plugin can corroborate the designer's native record."""
    home = Path(cli.home())
    if not home.is_absolute() or home.parent.name == 'profiles':
        raise ImportError('Managed Root memory is unavailable.')
    folder = home / 'plugins/saleads-memory'
    entry = folder / '__init__.py'
    source = folder / 'specialist_capture.py'
    if any(path.is_symlink() or not path.is_file() for path in (entry, source)):
        raise ImportError('Managed landing observer is unavailable.')
    name = '_saleads_landing_memory_' + hashlib.sha256(str(home).encode()).hexdigest()[:16]
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, entry, submodule_search_locations=[str(folder)])
        if spec is None or spec.loader is None:
            raise ImportError('Managed landing observer is unavailable.')
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    module = importlib.import_module(name + '.specialist_capture')
    observer = getattr(module, function_name, None)
    if not callable(observer):
        raise ImportError('Managed landing observer is unavailable.')
    return observer


def native_landing_observer(cli: Any) -> Any:
    return _native_landing_function(cli, 'observe_landing_admission')


def native_landing_stager(cli: Any) -> Any:
    return _native_landing_function(cli, 'stage_landing_admission')


def native_landing_resumer(cli: Any) -> Any:
    return _native_landing_function(cli, 'resume_landing_admission')


def native_landing_validator(cli: Any) -> Any:
    return _native_landing_function(cli, 'observe_landing_validation')


def seal_landing_validation(cli: Any, args: dict[str, Any], result: dict[str, Any], workspace: Path) -> dict[str, Any]:
    """Seal only this authenticated normalization, before extraction can replace native files."""
    status = {'schema_version': 'landing-cli-memory-validation/1', 'status': 'unavailable'}
    deadline = time.monotonic() + MEMORY_CORROBORATION_TIMEOUT
    previous = logging.root.manager.disable
    try:
        logging.disable(logging.CRITICAL)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if result.get('ok') is not True or result.get('pending') or not isinstance(result.get('data'), dict):
                return status
            validate = native_landing_validator(cli)
            remaining = max(0, deadline - time.monotonic())
            if not remaining:
                return status
            receipt = validate(args, result['data'], workspace.resolve(strict=True),
                               root=Path(cli.home()), budget_seconds=remaining)
            if isinstance(receipt, dict) and receipt.get('accepted') is True:
                status['status'] = 'sealed'  # Hash-chain checkpoint only, never a Source ACK or learning claim.
            return status
    except Exception:
        return status
    finally:
        logging.disable(previous)


def capture_landing_admission(cli: Any, args: dict[str, Any], result: dict[str, Any],
                              workspace: Path) -> dict[str, Any]:
    """Corroborate an in-memory accepted write; failure never changes its outcome."""
    status = {'schema_version': 'landing-cli-memory-capture/1', 'status': 'unavailable'}
    deadline = time.monotonic() + MEMORY_CORROBORATION_TIMEOUT
    previous = logging.root.manager.disable
    try:
        logging.disable(logging.CRITICAL)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            admission = result.get('data')
            if (result.get('ok') is not True or result.get('pending') or not isinstance(admission, dict)
                    or admission.get('origin') != 'hermes' or admission.get('businessId') != args.get('business_id')
                    or admission.get('landingId') != args.get('landing_id')
                    or admission.get('requestId') != args.get('client_request_id')
                    or type(admission.get('n')) is not int or admission['n'] < 1):
                return status
            observer = native_landing_observer(cli)
            stage = native_landing_stager(cli)
            checkpoint = stage(args, admission, workspace.resolve(strict=True), root=Path(cli.home()),
                               budget_seconds=max(0, deadline - time.monotonic()))
            if not isinstance(checkpoint, dict):
                return status
            if checkpoint.get('accepted') is True:
                status['status'] = 'recorded'
                return status
            if checkpoint.get('pending') is not True:
                return status
            status['checkpointed'] = True
            identity = {'business_id': args['business_id'], 'landing_id': admission['landingId']}
            landing = run_command(cli, 'saleads_landing_get', identity, deadline=deadline)
            version = run_command(cli, 'saleads_landing_get_version', {**identity, 'n': admission['n']}, deadline=deadline)
            if (landing.get('ok') is not True or version.get('ok') is not True
                    or not isinstance(landing.get('data'), dict) or not isinstance(version.get('data'), dict)):
                return status
            remaining = max(0, deadline - time.monotonic())
            if not remaining:
                return status
            receipt = observer(args, admission, landing['data'], version['data'], workspace.resolve(strict=True),
                               root=Path(cli.home()), budget_seconds=remaining)
            if isinstance(receipt, dict):
                if receipt.get('accepted') is True:
                    status['status'] = 'recorded'
                elif receipt.get('pending') is True:
                    status['status'] = 'pending'
            return status
    except Exception:
        return status  # No raw errors, credentials, invented sources or commercial write replay.
    finally:
        logging.disable(previous)


def resume_landing_capture(cli: Any, args: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """Recover only from a verified native checkpoint and this exact current API read."""
    status = {'schema_version': 'landing-cli-memory-capture/1', 'status': 'unavailable'}
    deadline = time.monotonic() + MEMORY_CORROBORATION_TIMEOUT
    previous = logging.root.manager.disable
    try:
        logging.disable(logging.CRITICAL)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            version = result.get('data')
            if (result.get('ok') is not True or result.get('pending') or not isinstance(version, dict)
                    or version.get('origin') != 'hermes' or version.get('landingId') != args.get('landing_id')
                    or type(args.get('n')) is not int or args['n'] < 1 or version.get('n') != args['n']):
                return status
            resume = native_landing_resumer(cli)
            identity = {'business_id': args['business_id'], 'landing_id': args['landing_id']}
            landing = run_command(cli, 'saleads_landing_get', identity, deadline=deadline)
            if landing.get('ok') is not True or not isinstance(landing.get('data'), dict):
                return status
            remaining = max(0, deadline - time.monotonic())
            if not remaining:
                return status
            receipt = resume(args, landing['data'], version, root=Path(cli.home()), budget_seconds=remaining)
            if isinstance(receipt, dict):
                if receipt.get('accepted') is True:
                    status['status'] = 'recorded'
                elif receipt.get('pending') is True:
                    status['status'] = 'pending'
            return status
    except Exception:
        return status  # The current read remains successful; never reconstruct or resend a write.
    finally:
        logging.disable(previous)


def operation_envelope(result: dict[str, Any]) -> dict[str, Any] | None:
    data = result.get('data')
    if not isinstance(data, dict) or not isinstance(data.get('operation_id'), str):
        return None
    if data.get('status') not in PENDING_STATUSES | FAILURE_STATUSES | {'succeeded'}:
        raise ValueError('Unknown operation status; inspect the saved response.')
    return data


def resolve_operation(cli: Any, result: dict[str, Any], wait: int, persist: Any,
                      *, client_request_id: str | None = None,
                      expected_operation_id: str | None = None) -> dict[str, Any]:
    deadline = time.monotonic() + wait
    operation_id = expected_operation_id
    for _ in range(41):
        envelope = operation_envelope(result)
        if envelope is None:
            if operation_id:
                raise ValueError('Operation response is missing the saved handle.')
            persist(result)
            return result
        if operation_id is not None and envelope['operation_id'] != operation_id:
            raise ValueError('Operation response does not match the saved handle.')
        operation_id = envelope['operation_id']
        out = {**result, 'operation_id': operation_id, 'operation': envelope}
        if client_request_id:
            out['client_request_id'] = client_request_id
        status = envelope['status']
        if status == 'succeeded':
            if not isinstance(envelope.get('result'), dict):
                raise ValueError('Successful operation is missing its result.')
            out['data'] = envelope['result']
            persist(out)
            return out
        if status in FAILURE_STATUSES:
            if not isinstance(envelope.get('error'), dict):
                raise ValueError('Failed operation is missing its error.')
            out.update(ok=False, error=envelope['error'])
            persist(out)
            return out
        out['pending'] = True
        persist(out)  # Save the handle before any sleep/read, including process interruption.
        delay = envelope.get('poll_after_s')
        if isinstance(delay, bool) or not isinstance(delay, (int, float)) or not math.isfinite(delay) or delay <= 0:
            raise ValueError('Pending operation has invalid poll_after_s.')
        remaining = deadline - time.monotonic()
        if wait == 0 or delay >= remaining or _ == 40:
            return out
        time.sleep(delay)
        if time.monotonic() >= deadline:
            return out
        result = run_command(cli, OPERATION_COMMAND, {'operation_id': operation_id}, deadline=deadline)
    return out


def wait_seconds(value: str) -> int:
    number = int(value)
    if not 0 <= number <= MAX_WAIT:
        raise argparse.ArgumentTypeError(f'--wait must be between0 and{MAX_WAIT} seconds.')
    return number


def extract_result(result: dict[str, Any], directory: Path) -> list[dict[str, Any]]:
    data = result.get('data') or {}
    artifacts = []
    files = data.get('files')
    if isinstance(files, dict):
        for name in FILENAMES:
            content = files.get(name)
            if isinstance(content, str):
                raw = content.encode('utf-8')
            elif isinstance(content, dict) and content.get('encoding') == 'base64':
                raw = base64.b64decode(content.get('content', ''), validate=True)
                if len(raw) != content.get('byteLength') or hashlib.sha256(raw).hexdigest() != content.get('sha256'):
                    raise ValueError('Version response failed file integrity verification.')
                raw.decode('utf-8', errors='strict')
            else:
                raise ValueError('Version response is missing complete HTML/CSS files.')
            atomic_write(directory / name, raw)
            artifacts.append({'path': str(directory / name), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    # Both actual page captures and curated visual references remain bytes, never private URLs only.
    for key in ('shots', 'references'):
        rows = data.get(key)
        if not isinstance(rows, list):
            continue
        for i, row in enumerate(rows):
            if not isinstance(row, dict) or row.get('mediaType') != 'image/jpeg' or not isinstance(row.get('base64'), str):
                raise ValueError('Invalid image artifact in Landing response.')
            raw = base64.b64decode(row['base64'], validate=True)
            if not raw.startswith(b'\xff\xd8'):
                raise ValueError('Image artifact does not contain JPEG bytes.')
            name = f'{key}-{i + 1:02d}.jpg'
            atomic_write(directory / name, raw)
            artifacts.append({'path': str(directory / name), 'bytes': len(raw),
                              'viewport': row.get('viewport'), 'tile': row.get('tile'),
                              'sha256': hashlib.sha256(raw).hexdigest()})
    return artifacts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', help='Exact name from the live SaleADS command catalog')
    parser.add_argument('--args', required=True, type=Path, help='JSON object with business/landing/request context')
    parser.add_argument('--workspace', type=Path, help='Directory containing index.html and styles.css')
    parser.add_argument('--output', required=True, type=Path, help='Private full JSON response file; no compaction')
    parser.add_argument('--extract', type=Path, help='Directory for complete HTML/CSS and JPEG artifacts')
    parser.add_argument('--wait', type=wait_seconds, default=DEFAULT_WAIT,
                        help='Bounded wait for an existing operation; pending exits4. Resume with saleads_get_operation.')
    opts = parser.parse_args(argv)
    cli = None
    last_result: dict[str, Any] | None = None
    client_request_id = None
    known_operation_id = None
    def save_result(value: dict[str, Any]) -> None:
        nonlocal last_result
        last_result = value
        atomic_write(opts.output, json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8'))
    try:
        args = json.loads(opts.args.read_text(encoding='utf-8'))
        if not isinstance(args, dict):
            raise ValueError('--args must contain a JSON object.')
        args = prepare_args(opts.command, args, opts.workspace)
        request_path = opts.output.with_suffix(opts.output.suffix + '.request.json')
        client_request_id = args.get('client_request_id')
        if opts.command == OPERATION_COMMAND:
            known_operation_id = args['operation_id']
            if opts.output.exists():
                previous = json.loads(opts.output.read_text(encoding='utf-8'))
                if isinstance(previous, dict) and previous.get('operation_id') not in (None, known_operation_id):
                    raise ValueError('Read resume must match the operation_id saved in this output.')
            # A read resume must not overwrite the original creation bytes/request ID.
            if request_path.exists():
                try:
                    original = json.loads(request_path.read_text(encoding='utf-8'))
                    if isinstance(original, dict):
                        client_request_id = original.get('client_request_id')
                except (OSError, ValueError):
                    pass
            request_path = opts.output.with_suffix(opts.output.suffix + '.operation-read.request.json')
        elif opts.output.exists():
            previous = json.loads(opts.output.read_text(encoding='utf-8'))
            if isinstance(previous, dict) and previous.get('pending') and previous.get('operation_id'):
                raise ValueError('An operation is already pending; resume its saved operation_id with saleads_get_operation.')
        # Persist exact input before network I/O; never generate another creation request ID.
        atomic_write(request_path, json_bytes(args))
        cli = load_cli()
        result = run_command(cli, opts.command, args)
        result = resolve_operation(cli, result, opts.wait, save_result,
                                   client_request_id=client_request_id,
                                   expected_operation_id=known_operation_id)
        if (opts.command in {'saleads_landing_validate', 'saleads_landing_submit_version', 'saleads_landing_get_version'}
                and result.get('ok') is True and not result.get('pending')):
            # resolve_operation saved the authoritative ACK before optional reads/MCL or extraction.
            key = '_landing_memory_capture'
            if opts.command == 'saleads_landing_validate':
                key = '_landing_memory_validation'
                receipt = seal_landing_validation(cli, args, result, opts.workspace)
            elif opts.command == 'saleads_landing_submit_version':
                receipt = capture_landing_admission(cli, args, result, opts.workspace)
            else:
                receipt = resume_landing_capture(cli, args, result)
            result = {**result, key: receipt}
            try:
                save_result(result)
            except OSError:
                pass  # The already-saved commercial ACK remains authoritative.
        artifacts = extract_result(result, opts.extract) if opts.extract and not result.get('pending') and result.get('ok') else []
        data = result.get('data') or {}
        summary = {'ok': result.get('ok') is True and not result.get('pending'), 'response_file': str(opts.output), 'artifacts': artifacts}
        if result.get('operation_id'):
            summary['operation_id'] = result['operation_id']
            summary['status'] = result.get('operation', {}).get('status')
        if result.get('pending'):
            summary.update(pending=True, poll_after_s=data.get('poll_after_s'),
                           next_action='Resume only with saleads_get_operation and this operation_id; do not repeat creation.')
        if isinstance(result.get('error'), dict):
            summary['error'] = result['error']
        for field in ('landingId', 'id', 'n', 'artifactDigest', 'origin', 'review_url', 'publishable', 'publishedN', 'url'):
            if field in data:
                summary[field] = data[field]
        if 'client_request_id' in result:
            summary['client_request_id'] = result['client_request_id']
        print(json.dumps(summary, ensure_ascii=False))
        if result.get('pending'):
            return getattr(cli, 'EXIT_TRANSIENT', 4)
        if result.get('ok') is not True:
            return getattr(cli, 'EXIT_TRANSIENT', 4) if result.get('error', {}).get('retryable') else getattr(cli, 'EXIT_DENIED', 3)
        return 0
    except Exception as error:
        if cli is not None and isinstance(error, cli.CliError):
            payload, exit_code = error.payload(), error.exit_code
        else:
            message = str(error) if isinstance(error, (ValueError, UnicodeError)) else 'Unable to process the Landing files or installed CLI.'
            payload = {'ok': False, 'code': 'LANDING-CLI-INPUT', 'message': message, 'retryable': False}
            exit_code = 2
        if client_request_id:
            payload.setdefault('client_request_id', client_request_id)
        handle = (last_result or {}).get('operation_id') or known_operation_id
        if handle:
            if isinstance(error, TimeoutError):
                exit_code = getattr(cli, 'EXIT_TRANSIENT', 4)
            saved = {**(last_result or {}), 'ok': False, 'operation_id': handle, 'poll_error': payload}
            saved['pending'] = (last_result or {}).get('pending', True)
            atomic_write(opts.output, json.dumps(saved, ensure_ascii=False, indent=2).encode('utf-8'))
            payload = {**payload, 'operation_id': handle, 'pending': saved['pending'],
                       'response_file': str(opts.output)}
        elif cli is not None and isinstance(error, cli.CliError):
            atomic_write(opts.output, json.dumps(payload, ensure_ascii=False).encode('utf-8'))
        print(json.dumps(payload, ensure_ascii=False))
        return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
