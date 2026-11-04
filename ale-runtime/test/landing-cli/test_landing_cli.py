import base64
from contextlib import contextmanager, redirect_stdout, redirect_stderr
import hashlib
import importlib.util
import io
import json
import logging
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import sys

SPEC = importlib.util.spec_from_file_location('landing_cli', Path(__file__).resolve().parents[2] / 'vm/extensions/landing-pilot/cli/landing_cli.py')
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


class LandingFileAdapterTests(unittest.TestCase):
    def test_destination_commands_reuse_the_installed_cli_without_artifact_files(self):
        args = {'business_id': 'business', 'bet_id': 'bet', 'landing_id': 'landing',
                'published_n': 6, 'expected_revision': 0, 'client_request_id': 'destination:request-01'}
        self.assertEqual(cli.prepare_args('saleads_agent_prepare_landing_destination', args, None), args)
        read = {'business_id': 'business', 'bet_id': 'bet'}
        self.assertEqual(cli.prepare_args('saleads_agent_get_landing_destination', read, None), read)

    def test_destination_preparation_requires_its_exact_durable_key_contract(self):
        for value in (None, '', 'short', 'x' * 129, 'key with spaces'):
            with self.assertRaisesRegex(ValueError, 'client_request_id'):
                cli.prepare_args('saleads_agent_prepare_landing_destination', {'client_request_id': value}, None)

    def test_destination_extension_does_not_admit_paid_commands_or_workspace_files(self):
        for name in ('saleads_agent_publish_campaign', 'saleads_agent_request_activation',
                     'saleads_agent_prepare_landing_destination_extra'):
            with self.assertRaisesRegex(ValueError, 'Landing commands'):
                cli.prepare_args(name, {'client_request_id': 'destination-request-01'}, None)
        with self.assertRaisesRegex(ValueError, 'workspace'):
            cli.prepare_args('saleads_agent_get_landing_destination', {}, Path('unused'))

    def test_pack_roundtrip_maximum_code_with_json_escapes_and_unicode(self):
        with tempfile.TemporaryDirectory() as d:
            workspace = Path(d)
            raw = ('😀\\"\n'.encode() * 50_000)[:280 * 1024]
            # Ensure UTF-8 remains well-formed after choosing a boundary.
            raw = ('\\"\n'.encode() * 100_000)[:280 * 1024]
            css = b' ' * (400 * 1024 - len(raw))
            (workspace / 'index.html').write_bytes(raw)
            (workspace / 'styles.css').write_bytes(css)
            args = cli.prepare_args('saleads_landing_submit_version', {
                'business_id': 'business', 'landing_id': 'landing', 'client_request_id': 'work-revision-001',
                'expected_latest_n': 0, 'metadata': {'taskId': 'task-1'},
            }, workspace)
            self.assertLessEqual(len(cli.json_bytes(args)), 576 * 1024)
            for name, source in [('index.html', raw), ('styles.css', css)]:
                descriptor = args['files'][name]
                self.assertEqual(base64.b64decode(descriptor['content'], validate=True), source)
                self.assertEqual(descriptor['sha256'], hashlib.sha256(source).hexdigest())
                self.assertEqual(descriptor['byteLength'], len(source))

    def test_invalid_utf8_size_metadata_and_symlink_rejected_before_cli(self):
        with tempfile.TemporaryDirectory() as d:
            workspace = Path(d)
            (workspace / 'index.html').write_bytes(b'\xff')
            (workspace / 'styles.css').write_text('body{}')
            with self.assertRaises(UnicodeError):
                cli.pack_files(workspace)
            (workspace / 'index.html').write_bytes(b'x' * (300 * 1024 + 1))
            with self.assertRaisesRegex(ValueError, '300 KiB'):
                cli.pack_files(workspace)
            (workspace / 'index.html').unlink()
            (workspace / 'index.html').symlink_to(workspace / 'styles.css')
            with self.assertRaisesRegex(ValueError, 'regular'):
                cli.pack_files(workspace)
            with self.assertRaisesRegex(ValueError, '32 KiB'):
                cli.prepare_args('saleads_landing_create', {'client_request_id': 'request-1', 'metadata': {'note': 'x' * 33_000}}, None)

    def test_required_durable_request_id_and_no_url_token_options(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError, 'client_request_id'):
                cli.prepare_args('saleads_landing_submit_version', {}, Path(d))
        with self.assertRaisesRegex(ValueError, 'durable'):
            cli.prepare_args('saleads_landing_create', {}, None)
        with self.assertRaisesRegex(ValueError, 'Landing commands'):
            cli.prepare_args('saleads_agent_publish_campaign', {}, None)

    def test_complete_descriptor_readback_and_jpegs_saved_without_compaction(self):
        with tempfile.TemporaryDirectory() as d:
            html = '<html lang="es">Sí 😀' + ('\\"' * 5000) + '</html>'
            files = {name: {'encoding': 'base64', 'content': base64.b64encode(raw).decode(),
                            'sha256': hashlib.sha256(raw).hexdigest(), 'byteLength': len(raw)}
                     for name, raw in [('index.html', html.encode()), ('styles.css', b'body{}')]}
            result = {'ok': True, 'data': {'files': files, 'shots': [
                {'viewport': 'celular', 'tile': 1, 'mediaType': 'image/jpeg', 'base64': base64.b64encode(b'\xff\xd8fixture\xff\xd9').decode()}]}}
            output = Path(d)
            artifacts = cli.extract_result(result, output)
            self.assertEqual((output / 'index.html').read_bytes(), html.encode())
            self.assertEqual((output / 'shots-01.jpg').read_bytes(), b'\xff\xd8fixture\xff\xd9')
            self.assertEqual(len(artifacts), 3)
            self.assertEqual((output / 'index.html').stat().st_mode & 0o777, 0o600)
            files['index.html']['sha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'integrity'):
                cli.extract_result(result, output)

    def test_reuses_installed_cli_executor_discovery_identity_and_full_output(self):
        calls = []
        installed = types.SimpleNamespace(
            load_settings=lambda: {'rest': 'https://service-configured.test'}, read_token=lambda: 'fixture-token-not-printed',
            catalog=lambda settings, token, refresh: [{'name': 'saleads_landing_get_version', 'read_only': True}],
            execute=lambda *args: calls.append(args) or {'ok': True, 'data': {'files': {}}},
            http=object(),
        )
        with patch.object(cli, 'ensure_runtime_auth'):
            result = cli.run_command(installed, 'saleads_landing_get_version', {'business_id': 'biz', 'landing_id': 'page', 'n': 1})
        self.assertTrue(result['ok'])
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][3]['full'])
        self.assertEqual(calls[0][3]['transport'], 'rest')
        self.assertEqual(calls[0][3]['wait'], 0)

    def test_main_writes_request_before_network_and_only_emits_summary(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            args = directory / 'args.json'
            output = directory / 'result.json'
            args.write_text(json.dumps({'business_id': 'biz', 'client_request_id': 'durable-request-1'}))
            fake = types.SimpleNamespace(CliError=type('FixtureCliError', (Exception,), {}))
            def run(installed, command, data):
                self.assertTrue(output.with_suffix('.json.request.json').exists())
                return {'ok': True, 'data': {'id': 'page', 'files': {'index.html': 'not printed', 'styles.css': 'body{}'}}}
            captured = io.StringIO()
            with patch.object(cli, 'load_cli', return_value=fake), patch.object(cli, 'run_command', side_effect=run), redirect_stdout(captured):
                self.assertEqual(cli.main(['saleads_landing_create', '--args', str(args), '--output', str(output)]), 0)
            self.assertNotIn('not printed', captured.getvalue())
            self.assertEqual(json.loads(output.read_text())['data']['files']['index.html'], 'not printed')


class LandingOperationAdapterTests(unittest.TestCase):
    OP = '11111111-1111-4111-8111-111111111111'

    class FakeClock:
        def __init__(self):
            self.value = 0.0
            self.sleeps = []
        def now(self):
            return self.value
        def sleep(self, seconds):
            self.sleeps.append(seconds)
            self.value += seconds

    def pending(self, status='running', delay=2):
        return {'ok': True, 'client_request_id': 'same-create-request',
                'data': {'operation_id': self.OP, 'status': status, 'poll_after_s': delay}}

    def test_slow_landing_calls_get180_timeout_and_restore_the_installed_transport(self):
        slow = ['saleads_landing_prepare_assets', 'saleads_landing_validate',
                'saleads_landing_submit_version', 'saleads_landing_preview']
        calls = []
        def http(*args, **kwargs):
            calls.append(kwargs['timeout'])
            return {'ok': True}
        installed = types.SimpleNamespace(
            load_settings=lambda: {}, read_token=lambda: 'fixture-not-output',
            catalog=lambda *args, **kwargs: [{'name': name, 'read_only': True} for name in slow],
            http=http,
        )
        installed.execute = lambda *args: installed.http('POST', 'https://fixture.test', 'fixture', timeout=90)
        with patch.object(cli, 'ensure_runtime_auth'):
            for name in slow:
                cli.run_command(installed, name, {})
                self.assertIs(installed.http, http)
        self.assertEqual(calls, [180] * len(slow))

    def test_async_create_polls_only_the_existing_operation_and_unwraps_its_result(self):
        clock = self.FakeClock()
        original = self.pending()
        updates = [self.pending('queued', 3), {'ok': True, 'data': {
            'operation_id': self.OP, 'status': 'succeeded', 'result': {'id': 'page', 'origin': 'hermes'}}}]
        saved = []
        with patch.object(cli, 'run_command', side_effect=updates) as run, \
             patch.object(cli.time, 'monotonic', side_effect=clock.now), \
             patch.object(cli.time, 'sleep', side_effect=clock.sleep):
            result = cli.resolve_operation(object(), original, 30, saved.append,
                                           client_request_id='same-create-request')
        self.assertEqual(result['data'], {'id': 'page', 'origin': 'hermes'})
        self.assertEqual(result['operation']['status'], 'succeeded')
        self.assertEqual(result['client_request_id'], 'same-create-request')
        self.assertEqual(clock.sleeps, [2, 3])
        self.assertTrue(all(call.args[1] == 'saleads_get_operation' for call in run.call_args_list))
        self.assertTrue(all(call.args[2] == {'operation_id': self.OP} for call in run.call_args_list))
        self.assertTrue(saved and saved[0]['data']['operation_id'] == self.OP)

    def test_pending_budget_is_finite_respects_poll_after_and_keeps_handle(self):
        clock = self.FakeClock()
        with patch.object(cli, 'run_command') as run, \
             patch.object(cli.time, 'monotonic', side_effect=clock.now), \
             patch.object(cli.time, 'sleep', side_effect=clock.sleep):
            result = cli.resolve_operation(object(), self.pending(delay=15), 5, lambda _: None)
        self.assertTrue(result['pending'])
        self.assertEqual(result['operation_id'], self.OP)
        run.assert_not_called()
        self.assertEqual(clock.sleeps, [])

    def test_terminal_failed_envelope_is_not_success_even_when_http_cli_was_ok(self):
        error = {'code': 'MCP-E-UPSTREAM-UNAVAILABLE', 'message': 'fixture failure',
                 'next_action': 'Inspect the operation.', 'retryable': False, 'details': {}, 'action_url': None}
        for status in ['failed', 'cancelled', 'abandoned']:
            result = cli.resolve_operation(object(), {'ok': True, 'data': {
                'operation_id': self.OP, 'status': status, 'error': error}}, 0, lambda _: None)
            self.assertFalse(result['ok'])
            self.assertEqual(result['error'], error)
            self.assertEqual(result['operation_id'], self.OP)

    def test_read_resume_is_allowed_but_no_write_or_credential_override_is_added(self):
        self.assertEqual(cli.prepare_args('saleads_get_operation', {'operation_id': self.OP}, None),
                         {'operation_id': self.OP})
        with self.assertRaises(ValueError):
            cli.prepare_args('saleads_get_operation', {'operation_id': self.OP, 'token': 'forged'}, None)
        with self.assertRaises(ValueError):
            cli.prepare_args('saleads_get_operation', {}, None)

    def test_main_pending_exit4_and_read_resume_preserve_the_original_request(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d); args = directory/'args.json'; output = directory/'result.json'
            original = {'business_id': 'biz', 'client_request_id': 'same-create-request'}
            args.write_text(json.dumps(original))
            fake = types.SimpleNamespace(CliError=type('FixtureCliError', (Exception,), {}), EXIT_TRANSIENT=4)
            capture = io.StringIO()
            with patch.object(cli, 'load_cli', return_value=fake), \
                 patch.object(cli, 'run_command', return_value=self.pending()) as run, redirect_stdout(capture):
                self.assertEqual(cli.main(['saleads_landing_create', '--args', str(args), '--output', str(output), '--wait', '0']), 4)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(json.loads(output.with_suffix('.json.request.json').read_text()), original)
            self.assertTrue(json.loads(capture.getvalue())['pending'])
            args.write_text(json.dumps({'operation_id': self.OP}))
            done = {'ok': True, 'data': {'operation_id': self.OP, 'status': 'succeeded', 'result': {'id': 'page'}}}
            with patch.object(cli, 'load_cli', return_value=fake), \
                 patch.object(cli, 'run_command', return_value=done) as run, redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['saleads_get_operation', '--args', str(args), '--output', str(output), '--wait', '0']), 0)
            self.assertEqual(run.call_args.args[1], 'saleads_get_operation')
            self.assertEqual(json.loads(output.with_suffix('.json.request.json').read_text()), original)
            self.assertEqual(json.loads(output.read_text())['data'], {'id': 'page'})

    def test_create_ack_loss_does_not_retry_and_retains_the_exact_request_id(self):
        class FixtureError(Exception):
            exit_code = 4
            def payload(self):
                return {'ok': False, 'code': 'MCP-HTTP-0', 'message': 'fixture timeout', 'retryable': False}
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d); args=directory/'args.json'; output=directory/'result.json'
            body={'business_id':'biz','client_request_id':'same-create-request'};args.write_text(json.dumps(body))
            fake=types.SimpleNamespace(CliError=FixtureError)
            with patch.object(cli,'load_cli',return_value=fake), \
                 patch.object(cli,'run_command',side_effect=FixtureError()) as run, redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['saleads_landing_create','--args',str(args),'--output',str(output)]),4)
            self.assertEqual(run.call_count,1)
            self.assertEqual(json.loads(output.with_suffix('.json.request.json').read_text()),body)

    def test_poll_ack_loss_keeps_operation_handle_without_repeating_create(self):
        class FixtureError(Exception):
            exit_code=4
            def payload(self): return {'ok':False,'code':'MCP-HTTP-0','message':'fixture poll timeout','retryable':True}
        clock=self.FakeClock()
        with tempfile.TemporaryDirectory() as d:
            directory=Path(d);args=directory/'args.json';output=directory/'result.json'
            args.write_text(json.dumps({'business_id':'biz','client_request_id':'same-create-request'}))
            fake=types.SimpleNamespace(CliError=FixtureError)
            with patch.object(cli,'load_cli',return_value=fake), \
                 patch.object(cli,'run_command',side_effect=[self.pending(delay=1),FixtureError()]) as run, \
                 patch.object(cli.time,'monotonic',side_effect=clock.now), \
                 patch.object(cli.time,'sleep',side_effect=clock.sleep), redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['saleads_landing_create','--args',str(args),'--output',str(output),'--wait','5']),4)
            self.assertEqual([call.args[1] for call in run.call_args_list], ['saleads_landing_create','saleads_get_operation'])
            saved=json.loads(output.read_text());self.assertEqual(saved['operation_id'],self.OP)
            self.assertEqual(saved['client_request_id'],'same-create-request')


class LandingNativeOAuthTests(unittest.TestCase):
    class CliError(Exception):
        def __init__(self, exit_code, code, message, next_action='', retryable=False):
            super().__init__(message)
            self.exit_code, self.code, self.next_action = exit_code, code, next_action
        def payload(self):
            return {'ok': False, 'code': self.code, 'message': str(self), 'retryable': False}

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.tokens = self.home / 'mcp-tokens'
        self.tokens.mkdir()
        self.token_path = self.tokens / 'saleads.json'
        self.client_path = self.tokens / 'saleads.client.json'
        self.client_path.write_text(json.dumps({'client_id': 'existing-client'}))
        self.write_token(900)
        self.config = {'mcp_servers': {'saleads': {'auth': 'oauth', 'oauth': {'client_id': 'existing-client'}}}}
        self.probes = []
        self.suppressed = False
        self.installed = types.SimpleNamespace(
            home=lambda: str(self.home), CliError=self.CliError, EXIT_AUTH=5,
            load_settings=lambda: {}, read_token=lambda: json.loads(self.token_path.read_text())['access_token'],
            catalog=Mock(return_value=[{'name': 'saleads_landing_create'}]),
            execute=Mock(return_value={'ok': True, 'data': {'id': 'page'}}), http=object(),
        )
        @contextmanager
        def suppress():
            self.suppressed = True
            try:
                yield
            finally:
                self.suppressed = False
        def probe(name, config, *, connect_timeout):
            self.assertTrue(self.suppressed)
            self.assertEqual((name, config['oauth']['client_id']), ('saleads', 'existing-client'))
            self.probes.append(connect_timeout)
            print('fixture-auth-must-not-escape')
            print('fixture-stderr-must-not-escape', file=sys.stderr)
            logging.error('fixture-log-must-not-escape')
            self.write_token(1500, access='refreshed-fixture')
            return [('existing_tool', 'existing tool')]
        self.native_probe = Mock(side_effect=probe)
        modules = {
            'hermes_cli': types.ModuleType('hermes_cli'), 'tools': types.ModuleType('tools'),
            'hermes_cli.config': types.SimpleNamespace(load_config_readonly=lambda: self.config),
            'hermes_cli.mcp_config': types.SimpleNamespace(_probe_single_server=self.native_probe),
            'tools.mcp_oauth': types.SimpleNamespace(suppress_interactive_oauth=suppress),
        }
        self.modules = patch.dict(sys.modules, modules)
        self.modules.start(); self.addCleanup(self.modules.stop)
        self.clock = patch.object(cli.time, 'time', return_value=1000)
        self.clock.start(); self.addCleanup(self.clock.stop)

    def write_token(self, expiry, *, access='expired-fixture'):
        self.token_path.write_text(json.dumps({'access_token': access, 'refresh_token': 'existing-refresh-fixture', 'expires_at': expiry}))

    def test_fresh_access_skips_native_probe(self):
        self.write_token(1061)
        cli.ensure_runtime_auth(self.installed)
        self.native_probe.assert_not_called()

    def test_expired_and_near_expiry_access_use_existing_native_auth_without_output(self):
        previous = logging.root.manager.disable
        for expiry in (999, 1060):
            self.write_token(expiry)
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                result = cli.run_command(self.installed, 'saleads_landing_create', {'client_request_id': 'same-request'})
            self.assertTrue(result['ok'])
            self.assertEqual(self.installed.execute.call_args.args[1], 'refreshed-fixture')
            self.assertEqual((out.getvalue(), err.getvalue()), ('', ''))
            self.assertEqual(logging.root.manager.disable, previous)
        self.assertEqual(self.probes, [30, 30])

    def test_client_mismatch_stops_before_probe_without_invalidating_credentials(self):
        self.config['mcp_servers']['saleads']['oauth']['client_id'] = 'different-client'
        before = self.token_path.read_bytes(), self.client_path.read_bytes()
        with self.assertRaises(self.CliError) as caught:
            cli.ensure_runtime_auth(self.installed)
        self.assertEqual(caught.exception.code, 'AUTH_REQUIRED')
        self.native_probe.assert_not_called()
        self.assertEqual((self.token_path.read_bytes(), self.client_path.read_bytes()), before)

    def test_refresh_rejection_returns_auth_required_without_cli_write_or_secret(self):
        self.native_probe.side_effect = RuntimeError('fixture-auth-must-not-escape')
        with self.assertRaises(self.CliError) as caught:
            cli.run_command(self.installed, 'saleads_landing_create', {'client_request_id': 'same-request'})
        self.assertEqual((caught.exception.exit_code, caught.exception.code), (5, 'AUTH_REQUIRED'))
        self.assertNotIn('fixture-auth-must-not-escape', str(caught.exception))
        self.installed.catalog.assert_not_called()
        self.installed.execute.assert_not_called()

    def test_missing_refresh_or_unverified_expiry_never_starts_interactive_authorization(self):
        for record in ({'access_token': 'fixture', 'expires_at': 900},
                       {'access_token': 'fixture', 'refresh_token': 'existing-fixture'}):
            self.token_path.write_text(json.dumps(record))
            with self.assertRaises(self.CliError) as caught:
                cli.ensure_runtime_auth(self.installed)
            self.assertEqual(caught.exception.code, 'AUTH_REQUIRED')
        self.native_probe.assert_not_called()

    def test_probe_cannot_allow_a_command_when_the_saved_access_is_still_expired(self):
        self.native_probe.side_effect = lambda *_args, **_kwargs: []
        with self.assertRaises(self.CliError) as caught:
            cli.run_command(self.installed, 'saleads_landing_create', {'client_request_id': 'same-request'})
        self.assertEqual(caught.exception.code, 'AUTH_REQUIRED')
        self.installed.execute.assert_not_called()

    def test_native_probe_keeps_the_remaining_operation_read_budget(self):
        with patch.object(cli.time, 'monotonic', return_value=20):
            cli.ensure_runtime_auth(self.installed, deadline=25)
        self.assertEqual(self.probes, [5])
        self.native_probe.reset_mock()
        with patch.object(cli.time, 'monotonic', return_value=25):
            with self.assertRaises(TimeoutError):
                cli.ensure_runtime_auth(self.installed, deadline=25)
        self.native_probe.assert_not_called()

    def test_write_ack_loss_after_refresh_does_not_send_another_command(self):
        args, output = self.home/'args.json', self.home/'output.json'
        body = {'business_id': 'fixture-business', 'client_request_id': 'same-create-request'}
        args.write_text(json.dumps(body))
        self.installed.execute.side_effect = self.CliError(4, 'MCP-HTTP-0', 'Uncertain write acknowledgement.')
        with patch.object(cli, 'load_cli', return_value=self.installed), redirect_stdout(io.StringIO()):
            code = cli.main(['saleads_landing_create', '--args', str(args), '--output', str(output)])
        self.assertEqual(code, 4)
        self.assertEqual((self.native_probe.call_count, self.installed.execute.call_count), (1, 1))
        self.assertEqual(json.loads(output.with_suffix('.json.request.json').read_text()), body)


class LandingMemoryReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.workspace = self.home / 'native-workspace'
        self.workspace.mkdir()
        (self.workspace / 'index.html').write_text('<html lang="en">Existing authorized page.</html>')
        (self.workspace / 'styles.css').write_text('body{}')
        self.args = self.home / 'args.json'
        self.output = self.home / 'result.json'
        self.body = {'business_id': 'business-fixture', 'landing_id': 'landing-fixture',
                     'client_request_id': 'same-admission-request', 'expected_latest_n': 5}
        self.args.write_text(json.dumps(self.body))
        self.admission = {'landingId': self.body['landing_id'], 'businessId': self.body['business_id'],
                          'origin': 'hermes', 'n': 6, 'artifactDigest': 'a' * 64,
                          'requestId': self.body['client_request_id']}
        self.landing = {'id': self.body['landing_id'], 'businessId': self.body['business_id'], 'origin': 'hermes'}
        self.version = {'landingId': self.body['landing_id'], 'origin': 'hermes', 'n': 6,
                        'artifactDigest': 'a' * 64, 'files': cli.pack_files(self.workspace)}
        self.installed = types.SimpleNamespace(home=lambda: str(self.home),
            CliError=LandingNativeOAuthTests.CliError, EXIT_TRANSIENT=4, EXIT_DENIED=3)
        self.observer = Mock(return_value={'accepted': True})
        self.stager = Mock(return_value={'accepted': False, 'pending': True})
        self.resumer = Mock(return_value={'accepted': True, 'pending': False})
        self.validator = Mock(return_value={'accepted': True, 'pending': False})

    def invoke(self, run, *, command='saleads_landing_submit_version', wait='0', extract=False):
        args = [command, '--args', str(self.args), '--output', str(self.output), '--wait', wait]
        if command in cli.ARTIFACT_COMMANDS:
            args += ['--workspace', str(self.workspace)]
        if extract:
            args += ['--extract', str(self.home / 'extracted')]
        with patch.object(cli, 'load_cli', return_value=self.installed), \
             patch.object(cli, 'run_command', side_effect=run) as calls, \
             patch.object(cli, 'native_landing_observer', return_value=self.observer), \
             patch.object(cli, 'native_landing_stager', return_value=self.stager), \
             patch.object(cli, 'native_landing_resumer', return_value=self.resumer), \
             patch.object(cli, 'native_landing_validator', return_value=self.validator), \
             redirect_stdout(io.StringIO()):
            code = cli.main(args)
        return code, calls

    def successful_commands(self, installed, command, args, **kwargs):
        if command == 'saleads_landing_submit_version':
            self.sent = args
            return {'ok': True, 'data': dict(self.admission)}
        # The real accepted response must already be durable before extra reads.
        self.assertEqual(json.loads(self.output.read_text())['data'], self.admission)
        self.assertGreater(kwargs['deadline'], cli.time.monotonic())
        if command == 'saleads_landing_get':
            self.assertEqual(args, {'business_id': self.body['business_id'], 'landing_id': self.body['landing_id']})
            return {'ok': True, 'data': self.landing}
        self.assertEqual(command, 'saleads_landing_get_version')
        self.assertEqual(args['n'], 6)  # Exact accepted version, never mutable latest/published.
        return {'ok': True, 'data': self.version}

    def test_authenticated_submit_reads_exact_version_then_observes_frozen_bytes_before_extract(self):
        def extract(result, directory):
            self.observer.assert_called_once()
            return []
        with patch.object(cli, 'extract_result', side_effect=extract):
            code, calls = self.invoke(self.successful_commands, extract=True)
        self.assertEqual(code, 0)
        self.assertEqual([x.args[1] for x in calls.call_args_list],
                         ['saleads_landing_submit_version', 'saleads_landing_get', 'saleads_landing_get_version'])
        args = self.observer.call_args.args
        self.assertEqual(args, (self.sent, self.admission, self.landing, self.version, self.workspace.resolve()))
        self.assertEqual(self.observer.call_args.kwargs['root'], self.home)
        self.assertNotIn('taskId', self.sent.get('metadata', {}))
        self.assertEqual(json.loads(self.output.read_text())['_landing_memory_capture']['status'], 'recorded')

    def test_auxiliary_read_failure_keeps_commercial_ack_and_never_resubmits(self):
        def run(installed, command, args, **kwargs):
            if command == 'saleads_landing_submit_version':
                return {'ok': True, 'data': self.admission}
            raise RuntimeError('fixture-secret-must-not-escape')
        code, calls = self.invoke(run)
        self.assertEqual(code, 0)
        self.assertEqual([x.args[1] for x in calls.call_args_list], ['saleads_landing_submit_version', 'saleads_landing_get'])
        self.observer.assert_not_called()
        saved = json.loads(self.output.read_text())
        self.assertTrue(saved['ok'])
        self.assertEqual(saved['data'], self.admission)
        self.assertTrue(saved['_landing_memory_capture']['checkpointed'])
        self.assertNotIn('fixture-secret-must-not-escape', self.output.read_text())
        self.assertEqual(json.loads(self.output.with_suffix('.json.request.json').read_text())['client_request_id'], self.body['client_request_id'])

    def test_observer_rejection_does_not_turn_an_admission_into_a_write_retry(self):
        self.observer.side_effect = RuntimeError('fixture-secret-must-not-escape')
        code, calls = self.invoke(self.successful_commands)
        self.assertEqual(code, 0)
        self.assertEqual(sum(x.args[1] == 'saleads_landing_submit_version' for x in calls.call_args_list), 1)
        self.assertEqual(json.loads(self.output.read_text())['_landing_memory_capture']['status'], 'unavailable')
        self.assertNotIn('fixture-secret-must-not-escape', self.output.read_text())

    def test_pending_source_capture_is_distinct_from_an_accepted_source(self):
        self.observer.return_value = {'accepted': False, 'pending': True}
        code, _calls = self.invoke(self.successful_commands)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(self.output.read_text())['_landing_memory_capture']['status'], 'pending')

    def test_reads_and_native_observation_share_one_remaining_budget(self):
        now = [100.0]
        def run(installed, command, args, **kwargs):
            result = self.successful_commands(installed, command, args, **kwargs)
            if command != 'saleads_landing_submit_version':
                self.assertEqual(kwargs['deadline'], 115)
                now[0] += 3
            return result
        with patch.object(cli.time, 'monotonic', side_effect=lambda: now[0]):
            code, _calls = self.invoke(run)
        self.assertEqual(code, 0)
        self.assertEqual(self.observer.call_args.kwargs['budget_seconds'], 9)

    def test_optional_capture_annotation_write_failure_keeps_the_saved_commercial_ack(self):
        original = cli.atomic_write
        def save(path, data):
            if path == self.output and b'_landing_memory_capture' in data:
                raise OSError('fixture-private-disk-error')
            original(path, data)
        with patch.object(cli, 'atomic_write', side_effect=save):
            code, calls = self.invoke(self.successful_commands)
        self.assertEqual(code, 0)
        saved = json.loads(self.output.read_text())
        self.assertTrue(saved['ok'])
        self.assertEqual(saved['data'], self.admission)
        self.assertNotIn('_landing_memory_capture', saved)
        self.assertEqual(sum(x.args[1] == 'saleads_landing_submit_version' for x in calls.call_args_list), 1)

    def test_unavailable_managed_module_does_not_add_reads_or_reject_the_admission(self):
        with patch.object(cli, 'native_landing_observer', side_effect=ImportError('fixture-private-detail')):
            with patch.object(cli, 'load_cli', return_value=self.installed), \
                 patch.object(cli, 'run_command', return_value={'ok': True, 'data': self.admission}) as run, \
                 redirect_stdout(io.StringIO()):
                code = cli.main(['saleads_landing_submit_version', '--args', str(self.args),
                    '--workspace', str(self.workspace), '--output', str(self.output), '--wait', '0'])
        self.assertEqual(code, 0)
        self.assertEqual(run.call_count, 1)
        self.assertNotIn('fixture-private-detail', self.output.read_text())

    def test_pending_or_rejected_submit_does_not_claim_a_memory_receipt(self):
        pending = {'ok': True, 'data': {'operation_id': 'existing-operation', 'status': 'running', 'poll_after_s': 2}}
        code, calls = self.invoke(lambda *_a, **_k: pending)
        self.assertEqual(code, 4)
        self.assertEqual(calls.call_count, 1)
        self.observer.assert_not_called()
        self.assertNotIn('_landing_memory_capture', json.loads(self.output.read_text()))

    def test_native_checkpoint_follows_saved_ack_and_precedes_all_corroborating_reads(self):
        events = []
        def run(installed, command, args, **kwargs):
            events.append(command)
            return self.successful_commands(installed, command, args, **kwargs)
        def stage(args, admission, workspace, **kwargs):
            self.assertEqual(json.loads(self.output.read_text())['data'], self.admission)
            self.assertEqual((args['files'], admission, workspace),
                             (cli.pack_files(self.workspace), self.admission, self.workspace.resolve()))
            events.append('native-checkpoint')
            return {'accepted': False, 'pending': True}
        self.stager.side_effect = stage
        code, _calls = self.invoke(run)
        self.assertEqual(code, 0)
        self.assertEqual(events, ['saleads_landing_submit_version', 'native-checkpoint',
                                  'saleads_landing_get', 'saleads_landing_get_version'])

    def test_rejected_native_checkpoint_adds_no_reads_and_does_not_reject_the_write(self):
        self.stager.return_value = {'accepted': False, 'pending': False}
        code, calls = self.invoke(self.successful_commands)
        self.assertEqual(code, 0)
        self.assertEqual(calls.call_count, 1)
        self.observer.assert_not_called()
        self.assertEqual(json.loads(self.output.read_text())['_landing_memory_capture']['status'], 'unavailable')

    def test_actual_get_version_recovers_with_one_current_read_without_replaying_submit(self):
        self.args.write_text(json.dumps({'business_id': self.body['business_id'],
            'landing_id': self.body['landing_id'], 'n': 6}))
        self.output.with_suffix('.json.request.json').write_text(json.dumps({'forged_admission': 'must-not-be-proof'}))
        def run(installed, command, args, **kwargs):
            if command == 'saleads_landing_get_version':
                self.assertNotIn('deadline', kwargs)
                return {'ok': True, 'data': self.version}
            self.assertEqual(command, 'saleads_landing_get')
            self.assertEqual(json.loads(self.output.read_text())['data'], self.version)
            self.assertGreater(kwargs['deadline'], cli.time.monotonic())
            return {'ok': True, 'data': self.landing}
        code, calls = self.invoke(run, command='saleads_landing_get_version')
        self.assertEqual(code, 0)
        self.assertEqual([x.args[1] for x in calls.call_args_list],
                         ['saleads_landing_get_version', 'saleads_landing_get'])
        self.resumer.assert_called_once()
        self.assertEqual(self.resumer.call_args.args, (json.loads(self.args.read_text()), self.landing, self.version))
        self.stager.assert_not_called()
        self.observer.assert_not_called()
        self.assertEqual(json.loads(self.output.read_text())['_landing_memory_capture']['status'], 'recorded')

    def test_read_only_recovery_failure_keeps_the_current_version_ack_without_any_write(self):
        self.args.write_text(json.dumps({'business_id': self.body['business_id'], 'landing_id': self.body['landing_id'], 'n': 6}))
        def run(installed, command, args, **kwargs):
            if command == 'saleads_landing_get_version':
                return {'ok': True, 'data': self.version}
            raise RuntimeError('fixture-private-read-failure')
        code, calls = self.invoke(run, command='saleads_landing_get_version')
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(self.output.read_text())['ok'])
        self.assertEqual([x.args[1] for x in calls.call_args_list], ['saleads_landing_get_version', 'saleads_landing_get'])
        self.resumer.assert_not_called()
        self.assertNotIn('fixture-private-read-failure', self.output.read_text())

    def test_current_validation_seals_raw_to_final_hashes_after_ack_before_extraction_without_reads(self):
        validation = {'files': self.version['files'], 'artifactDigest': self.version['artifactDigest'], 'publishable': True}
        frozen = None
        def execute(installed, command, args, **kwargs):
            nonlocal frozen
            self.assertEqual(command, 'saleads_landing_validate')
            frozen = args
            return {'ok': True, 'data': validation}
        def seal(args, data, workspace, **kwargs):
            self.assertEqual(json.loads(self.output.read_text())['data'], validation)
            self.assertEqual((args, data, workspace), (frozen, validation, self.workspace.resolve()))
            self.assertGreater(kwargs['budget_seconds'], 0)
            self.assertLessEqual(kwargs['budget_seconds'], 15)
            return {'accepted': True, 'pending': False}
        self.validator.side_effect = seal
        def extract(result, directory):
            self.validator.assert_called_once()
            self.assertEqual(result['_landing_memory_validation']['status'], 'sealed')
            return []
        with patch.object(cli, 'extract_result', side_effect=extract):
            code, calls = self.invoke(execute, command='saleads_landing_validate', extract=True)
        self.assertEqual(code, 0)
        self.assertEqual(calls.call_count, 1)
        self.observer.assert_not_called()
        self.stager.assert_not_called()
        self.assertNotIn('_landing_memory_capture', json.loads(self.output.read_text()))

    def test_failed_validation_seal_keeps_current_validation_success_and_never_retries_it(self):
        self.validator.side_effect = RuntimeError('fixture-private-validation-error')
        response = {'ok': True, 'data': {'files': self.version['files'], 'artifactDigest': self.version['artifactDigest']}}
        code, calls = self.invoke(lambda *_a, **_kw: response, command='saleads_landing_validate')
        self.assertEqual(code, 0)
        self.assertEqual(calls.call_count, 1)
        saved = json.loads(self.output.read_text())
        self.assertTrue(saved['ok'])
        self.assertEqual(saved['_landing_memory_validation']['status'], 'unavailable')
        self.assertNotIn('fixture-private-validation-error', self.output.read_text())

    def test_pending_validation_does_not_seal_an_unfinished_api_response(self):
        pending = {'ok': True, 'data': {'operation_id': 'existing-validation', 'status': 'running', 'poll_after_s': 2}}
        code, calls = self.invoke(lambda *_a, **_kw: pending, command='saleads_landing_validate')
        self.assertEqual(code, 4)
        self.assertEqual(calls.call_count, 1)
        self.validator.assert_not_called()

    def test_validation_preserves_real_metadata_mapper_output_without_calling_it_native_json(self):
        source = Path(__file__).resolve().parents[2] / 'vm/extensions/landing-pilot/build_metadata.py'
        spec = importlib.util.spec_from_file_location('cli_actual_metadata_fixture', source)
        mapper = importlib.util.module_from_spec(spec); spec.loader.exec_module(mapper)
        design = {'direction': 'Readable existing offer', 'fonts': {'heading': 'anton', 'body': 'dm-sans'}}
        review = {'rounds': 1, 'criteria': [{'id': i, 'score': 2, 'note': 'Generated craft assessment.'} for i in range(1, 11)]}
        for name, value in [('page.json', {'blocks': [{'id': 'hero'}]}), ('design.json', design), ('review.json', review)]:
            (self.workspace/name).write_text(json.dumps(value))
        lineage = {'betId': '44444444-4444-4444-8444-444444444444',
                   'hypothesisId': '44444444-4444-4444-8444-444444444444',
                   'strategyVersionId': '55555555-5555-4555-8555-555555555555'}
        metadata = mapper.build(self.workspace, {'lineage': lineage})
        self.args.write_text(json.dumps({**self.body, 'metadata': metadata}))
        raw_css = (self.workspace/'styles.css').read_bytes()
        normalized_css = raw_css + b'/* deterministic server finalization */'
        final_files = {**self.version['files'], 'styles.css': {'encoding': 'base64',
            'content': base64.b64encode(normalized_css).decode(), 'sha256': hashlib.sha256(normalized_css).hexdigest(),
            'byteLength': len(normalized_css)}}
        final_digest = hashlib.sha256(mapper.compact({name: value['sha256'] for name, value in final_files.items()})).hexdigest()
        validation = {'files': final_files, 'artifactDigest': final_digest, 'publishable': True,
                      'blocks': [], 'warnings': [], 'testimonials': []}
        code, calls = self.invoke(lambda *_a, **_kw: {'ok': True, 'data': validation},
                                  command='saleads_landing_validate', extract=True)
        self.assertEqual(code, 0)
        self.assertEqual(calls.call_count, 1)
        actual_args = self.validator.call_args.args[0]
        self.assertEqual(actual_args['metadata'], metadata)
        self.assertIn('_pilotReviewEvidence', metadata['artifacts']['diseno'])
        self.assertNotIn('_pilotReviewEvidence', design)
        self.assertEqual(metadata['review']['score'], 20)
        self.assertFalse(metadata['review']['passed'])  # Generated rubric is not authenticated vision.
        self.assertEqual((self.home/'extracted/styles.css').read_bytes(), normalized_css)
        self.assertEqual((self.workspace/'styles.css').read_bytes(), raw_css)

    def test_read_resume_never_uses_a_saved_request_as_authenticated_submission_proof(self):
        self.args.write_text(json.dumps({'operation_id': 'existing-operation'}))
        self.output.with_suffix('.json.request.json').write_text(json.dumps(self.body))
        done = {'ok': True, 'data': {'operation_id': 'existing-operation', 'status': 'succeeded', 'result': self.admission}}
        code, calls = self.invoke(lambda *_a, **_k: done, command='saleads_get_operation')
        self.assertEqual(code, 0)
        self.assertEqual(calls.call_count, 1)
        self.observer.assert_not_called()
        self.assertNotIn('_landing_memory_capture', json.loads(self.output.read_text()))

    def test_observer_loader_uses_only_the_fixed_root_plugin_and_separates_homes(self):
        def install(home, value):
            folder = home / 'plugins/saleads-memory'
            folder.mkdir(parents=True)
            (folder/'__init__.py').write_text('from . import specialist_capture\n')
            (folder/'specialist_capture.py').write_text(
                'def observe_landing_admission(*args, **kwargs):\n    return ' + repr(value) + '\n')
        install(self.home, 'first-managed-plugin')
        another = self.home/'another-root'
        install(another, 'second-managed-plugin')
        first = cli.native_landing_observer(self.installed)
        second = cli.native_landing_observer(types.SimpleNamespace(home=lambda: str(another)))
        self.assertEqual((first(), second()), ('first-managed-plugin', 'second-managed-plugin'))

    def test_observer_loader_refuses_specialist_homes_and_symlinked_modules(self):
        designer = self.home/'profiles/disenador_landings'
        with self.assertRaises(ImportError):
            cli.native_landing_observer(types.SimpleNamespace(home=lambda: str(designer)))
        folder = self.home/'plugins/saleads-memory'
        folder.mkdir(parents=True)
        (folder/'__init__.py').write_text('')
        (folder/'specialist_capture.py').symlink_to(self.args)
        with self.assertRaises(ImportError):
            cli.native_landing_observer(self.installed)


if __name__ == '__main__':
    unittest.main()
