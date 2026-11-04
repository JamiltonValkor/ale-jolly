"""Real official platform registry/adapter/async bridge with synthetic transport.

Run in the pinned Hermes image; no model, external recipient, or credentials.
"""
import asyncio
from concurrent.futures import TimeoutError as ObservationTimeout
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading


def main():
    with tempfile.TemporaryDirectory(prefix='mcl-home-sdk-') as directory:
        home = Path(directory)
        os.environ['HERMES_HOME'] = str(home)
        for key in list(os.environ):
            if key.endswith(('_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD')):
                os.environ.pop(key)
        sys.path.insert(0, '/opt/hermes')
        from hermes_cli.plugins import PluginContext, PluginManifest, PluginManager
        from gateway.config import PlatformConfig
        from gateway.platform_registry import platform_registry
        from cron.execution_identity import enter_cron_execution, exit_cron_execution
        from agent.async_utils import safe_schedule_threadsafe
        path = Path('/workspace/saleads-continuity')
        spec = importlib.util.spec_from_file_location('home_sdk_continuity', path / '__init__.py',
            submodule_search_locations=[str(path)])
        package = importlib.util.module_from_spec(spec); sys.modules[spec.name] = package
        spec.loader.exec_module(package)
        delivery = sys.modules[spec.name + '.delivery']
        notifications = sys.modules[spec.name + '.notifications']
        root = home / 'saleads/continuous'; root.mkdir(parents=True)
        context = {'schema_version': 'trusted-context/1', 'owner_id': 'synthetic-owner',
            'business_id': '00000000-0000-4000-8000-000000000001', 'session_id': 'synthetic-session',
            'actor_role': 'ale', 'native_task_id': None, 'native_run_id': None,
            'response_locale': 'en', 'locale_revision': 1, 'capabilities': [], 'mandate_id': None, 'pending_context': False}
        (root / 'trusted-contexts.json').write_text(json.dumps({'schema_version': 'trusted-context-registry/1',
            'owner_id': 'synthetic-owner', 'contexts': [context], 'jobs': [{'job_id': 'synthetic-job',
                'business_id': context['business_id'], 'session_id': context['session_id'], 'response_locale': 'en', 'locale_revision': 1}]}))
        (home / 'config.yaml').write_text(json.dumps({'platforms': {
            'mcl_fake_home': {'enabled': True}, 'saleads_home': {'enabled': True}}}))
        manager = PluginManager()
        ctx = PluginContext(PluginManifest(name='synthetic-home-sdk-probe', source='user'), manager)
        started, released = threading.Event(), threading.Event()
        seen = []
        async def synthetic_sender(config, chat_id, message, **kwargs):
            identity = ctx.current_cron_execution()
            assert identity and identity.execution_id == 'synthetic-execution'
            started.set()
            while not released.is_set():
                await asyncio.sleep(0.01)
            seen.append((identity.execution_id, chat_id))
            return {'success': True, 'message_id': 'synthetic-provider-message'}
        ctx.register_platform(name='mcl_fake_home', label='Synthetic test transport',
            adapter_factory=lambda config: None, check_fn=lambda: True,
            validate_config=lambda config: True, standalone_sender_fn=synthetic_sender)
        target = {'platform': 'mcl_fake_home', 'chat_id': 'synthetic-owner-home', 'thread_id': None}
        delivery.register(ctx, root=root, target_resolver=lambda job: [target])
        registered = platform_registry.get('saleads_home')
        assert registered and registered.standalone_sender_fn
        adapter = platform_registry.create_adapter('saleads_home', PlatformConfig(enabled=True))
        assert adapter is not None, 'actual SDK refused managed adapter'
        loop = asyncio.new_event_loop()
        thread = threading.Thread(target=loop.run_forever); thread.start()
        token = enter_cron_execution({'id': 'synthetic-job', 'name': 'Synthetic'},
            'synthetic-execution', {'source': 'direct', 'started_at': '2026-10-29T11:17:27+00:00'})
        try:
            identity = ctx.current_cron_execution()
            assert notifications.capture(context, identity, 'Synthetic owner result.', root=root,
                home_resolver=lambda job: {'state': 'configured', 'fingerprint': 'synthetic'})
            future = safe_schedule_threadsafe(adapter.send('current', 'Synthetic owner result.'), loop)
            assert started.wait(15), 'native underlying sender never ran'
            try:
                future.result(timeout=0.01)
                raise AssertionError('expected observation timeout before provider ACK')
            except ObservationTimeout:
                pass
            assert delivery.read_result(root, 'synthetic-job', 'synthetic-execution')['state'] == 'unknown'
        finally:
            exit_cron_execution(token)
        try:
            assert ctx.current_cron_execution() is None
            released.set()
            assert future.result(timeout=15).success
            receipt = delivery.read_result(root, 'synthetic-job', 'synthetic-execution')
            assert receipt['state'] == 'delivered' and len(seen) == 1
            assert receipt['targets'][0]['message_id'] == 'synthetic-provider-message'
        finally:
            released.set(); loop.call_soon_threadsafe(loop.stop); thread.join(timeout=5); loop.close()
        print(json.dumps({'official_platform_registration': 'PASS', 'official_adapter_factory': 'PASS',
            'native_underlying_sender': 'PASS', 'cron_context_across_actual_async_bridge': 'PASS',
            'late_positive_ack_same_attempt': 'PASS', 'provider_calls': len(seen),
            'real_model': False, 'external_messages': 0}), flush=True)


if __name__ == '__main__':
    main()
