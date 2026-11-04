"""Current owning-API data is injected independently of model tool selection."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
import subprocess
import tempfile
import os
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
PKG = ROOT / 'vm/extensions/saleads-continuity'
spec = importlib.util.spec_from_file_location('mcl_state_context_fixture', PKG / 'context.py')
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)
BIZ = '00000000-0000-4000-8000-000000000001'
PAGE = '00000000-0000-4000-8000-000000000002'
BOUND = {'owner_id':'synthetic-owner','business_id':BIZ,'session_id':'session-one','actor_role':'ale',
         'native_task_id':None,'native_run_id':None,'response_locale':'pt-BR','locale_revision':3,'pending_context':False}

live = context.CurrentLandingState
NOW = dt.datetime(2026,10,28,12,0,tzinfo=dt.timezone.utc)

def summary(identifier=PAGE):
    return {'id':identifier,'origin':'hermes','name':'Synthetic page','format':'product_page','status':'draft','eventCounts':{}}

def response(*, business=BIZ, status='published', extra=None):
    row = {'id':PAGE,'businessId':business,'origin':'hermes','status':status,'latestN':6,'publishedN':6,
           'updatedAt':'2026-10-28T11:00:00Z', **(extra or {})}
    return {'ok':True,'data':{'landings':[row]}}


class CurrentStateRed(unittest.TestCase):
    def test_current_published_state_is_present_before_generation_within_unchanged_budget(self):
        state = {'status':'current','source':'saleads_landing_list','observed_at':'2026-10-28T12:00:00+00:00',
                 'landings':[{'id':PAGE,'status':'published','latestN':6,'publishedN':6}],'omitted':0}
        output = context.pack(BOUND, read_state=lambda binding, max_chars: state)['context']
        self.assertIn('SALEADS_CURRENT_LANDING_STATE_V1_DATA', output)
        self.assertIn('"publishedN":6', output)
        self.assertIn('"response_locale":"pt-BR"', output)
        self.assertLessEqual(len(output), 2000)


class EpistemicAuthorityPolicy(unittest.TestCase):
    def assert_period_evidence_policy(self, text):
        self.assertIn('Role experience guides method, not current business facts or owner choices.', text)
        self.assertIn("A price alone does not establish this business's billing frequency.", text)
        self.assertIn('explicit owner/API evidence of that period', text)
        self.assertIn('conditional scenarios', text)
        self.assertIn('keep researching without needless questions', text)

    def test_all_roles_receive_method_and_business_fact_separation(self):
        for role in ('ale', 'investigador', 'curador'):
            with self.subTest(role=role):
                reads = []
                text = context.pack({**BOUND, 'actor_role': role}, read_state=lambda *_:
                    reads.append(True) or live.unavailable('fixture'))['context']
                self.assert_period_evidence_policy(text)
                self.assertEqual(len(reads), int(role == 'ale'))
                self.assertIn('"response_locale":"pt-BR"', text)
                self.assertLessEqual(len(text), 2000)

    def test_three_landing_details_fit_with_policy_and_original_memory_allowance(self):
        bound = {**BOUND, 'owner_id': '00000000-0000-4000-8000-000000000003',
                 'session_id': 'saleads-flow-00000000-0000-4000-8000-000000000004'}
        rows = [{**response()['data']['landings'][0],
                 'id': f'00000000-0000-4000-8000-{number:012d}'} for number in range(10, 13)]
        text = context.pack(bound, read_state=lambda binding, budget:
            live.project({'ok': True, 'data': {'landings': rows}}, binding,
                         max_chars=budget, now=NOW))['context']
        self.assert_period_evidence_policy(text)
        self.assertEqual(text.count('"status":"published"'), 3)
        self.assertIn('"omitted":0', text)
        self.assertIn('"owner_id":"' + bound['owner_id'] + '"', text)
        self.assertIn('"response_locale":"pt-BR"', text)
        self.assertLessEqual(len(text), 2000)
        self.assertLessEqual(len(text) + 5998 + 2, 8000)

    def test_failed_state_read_keeps_policy_routing_and_language(self):
        def unavailable(*_):
            raise OSError('private transport detail')
        text = context.pack(BOUND, read_state=unavailable)['context']
        self.assert_period_evidence_policy(text)
        self.assertIn('"reason":"read_failed"', text)
        self.assertIn('"business_id":"' + BIZ + '"', text)
        self.assertIn('"locale_revision":3', text)
        self.assertNotIn('private transport detail', text)
        self.assertLessEqual(len(text), 2000)

    def test_next_generation_refreshes_locale_without_dropping_evidence_policy(self):
        # Every pre_llm_call, including a native wake, uses this same uncached pack.
        for locale, revision in (('es', 3), ('en', 4)):
            with self.subTest(locale=locale):
                text = context.pack({**BOUND, 'response_locale': locale, 'locale_revision': revision},
                                    read_state=lambda *_: live.unavailable('fixture'))['context']
                self.assert_period_evidence_policy(text)
                self.assertIn('"response_locale":"' + locale + '"', text)
                self.assertIn('"locale_revision":' + str(revision), text)

    def test_registered_pre_hook_keeps_policy_for_native_wake_as_for_web_input(self):
        from test_turn_frames import entry
        hooks = {}
        host = SimpleNamespace(current_cron_execution=lambda: None,
            register_hook=lambda name, callback: hooks.__setitem__(name, callback))
        bound = BOUND.copy()
        with patch.object(entry, 'resolve', side_effect=lambda **_: bound.copy()), \
             patch.object(entry, 'bind_wake', return_value=None), \
             patch.object(entry, 'capture_api_run_acceptance', return_value=None), \
             patch.object(entry, 'register_delivery'), \
             patch.object(entry, 'pack', side_effect=lambda value:
                 context.pack(value, read_state=lambda *_: live.unavailable('fixture'))):
            entry.register(host)
            for message, turn_id, locale, revision in (
                ('Synthetic web input', 'session-one:session-one:0123abcd', 'es', 3),
                ('Synthetic native task completion wake', 'session-one:session-one:89abcdef', 'en', 4),
            ):
                bound.update(response_locale=locale, locale_revision=revision)
                text = hooks['pre_llm_call'](session_id='session-one', turn_id=turn_id,
                    user_message=message, platform='api_server')['context']
                self.assert_period_evidence_policy(text)
                self.assertIn('"response_locale":"' + locale + '"', text)
                self.assertIn('"locale_revision":' + str(revision), text)


class CurrentStateProjection(unittest.TestCase):
    def test_minimal_sourced_publication_projection_excludes_private_fields(self):
        result = live.project(response(extra={'html':'secret body','context':{'private':'private facts'},'token':'sensitive'}), BOUND, max_chars=1000, now=NOW)
        self.assertEqual(result['source'], 'saleads_landing_list')
        self.assertEqual(result['observed_at'], NOW.isoformat())
        self.assertEqual(result['landings'][0]['publishedN'],6)
        self.assertNotIn('secret',live.encoded(result))
        self.assertNotIn('sensitive',live.encoded(result))
        self.assertNotIn('private',live.encoded(result))

    def test_other_business_wrong_origin_and_invalid_revision_are_rejected(self):
        cases = [response(business=PAGE), response(extra={'origin':'web'}), response(extra={'publishedN':True}),
                 response(extra={'updatedAt':'not-a-date'}), {'ok':True,'data':{'landings':{}}}, {'ok':False}]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises((ValueError,TypeError,KeyError)):
                    live.project(value,BOUND,max_chars=1000,now=NOW)

    def test_draft_unpublished_and_empty_list_do_not_become_published(self):
        for status in ['draft','unpublished']:
            result = live.project(response(status=status,extra={'publishedN':None}),BOUND,max_chars=1000,now=NOW)
            self.assertEqual(result['landings'][0]['status'],status)
            self.assertIsNone(result['landings'][0]['publishedN'])
        result = live.project({'ok':True,'data':{'landings':[]}},BOUND,max_chars=1000,now=NOW)
        self.assertEqual(result['landings'],[])
        self.assertEqual(result['omitted'],0)

    def test_many_rows_fit_budget_and_declare_omission_without_partial_json(self):
        raw = response(extra={'html':'x'*100000})
        raw['data']['landings'] *= 80
        result = live.project(raw,BOUND,max_chars=1000,now=NOW)
        self.assertLessEqual(len(live.encoded(result)),1000)
        self.assertGreater(result['omitted'],0)
        self.assertEqual(result['omitted']+len(result['landings']),80)
        self.assertNotIn('html',live.encoded(result))

    def test_unknown_or_specialist_context_never_runs_commercial_read(self):
        calls=[]
        for role in ['investigador','curador','disenador_landings']:
            output=context.pack({**BOUND,'actor_role':role},read_state=lambda *_:calls.append(True))
            self.assertNotIn('CURRENT_LANDING',output['context'])
        self.assertEqual(calls,[])
        self.assertIsNone(live.read({**BOUND,'actor_role':'investigador'},1000,runner=lambda *_:calls.append(True)))

    def test_context_budget_overflow_is_explicit_and_does_not_reduce_memory_budget(self):
        output=context.pack(BOUND,read_state=lambda *_:{'landings':['x'*10000]})['context']
        self.assertLessEqual(len(output),2000)
        self.assertIn('context_budget',output)
        self.assertLessEqual(len(output)+5998+2,8000)
        self.assertIn('response_locale',output)

    def test_missing_cli_fails_without_running_subprocess(self):
        with tempfile.TemporaryDirectory() as tmp:
            result=live.read(BOUND,1000,home=tmp,runner=lambda *_:self.fail('should not run'))
        self.assertEqual(result,live.unavailable('cli_unavailable'))

    def test_deadline_and_large_result_are_explicit_without_stale_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'skills/saleads-cli/scripts/saleads.py'
            source.parent.mkdir(parents=True);source.write_text('#fixture')
            calls=[]
            def timeout(argv,**kwargs):
                calls.append((argv,kwargs))
                raise subprocess.TimeoutExpired(argv,kwargs['timeout'])
            result=live.read(BOUND,1000,home=tmp,runner=timeout)
            self.assertEqual(result,live.unavailable('deadline_exceeded'))
            self.assertEqual(calls[0][1]['timeout'],2.8)
            self.assertEqual(json.loads(calls[0][1]['input']),{'business_id':BIZ,'response_locale':'pt-BR','max_chars':1000})
            self.assertNotIn('token',' '.join(calls[0][0]))
            result=live.read(BOUND,1000,home=tmp,runner=lambda *a,**k:SimpleNamespace(stdout=b'x'*20000))
            self.assertEqual(result,live.unavailable('invalid_projection'))

    def test_installed_cli_auth_discovery_schema_execute_reused_with_fixed_read_args(self):
        calls=[]
        cli=SimpleNamespace(load_settings=lambda:{'rest':'service-owned'},read_token=lambda:'fixture-secret',
            catalog=lambda settings,token,refresh:calls.append(('catalog',refresh)) or [{'name':n,'read_only':True} for n in [live.COMMAND,'saleads_landing_get']],
            execute=lambda settings,token,name,opts,entry:calls.append((name,opts)) or ({'ok':True,'data':{'landings':[summary()]}} if name==live.COMMAND else {'ok':True,'data':response()['data']['landings'][0]}))
        with patch.object(live,'load_cli',return_value=cli):
            self.assertTrue(live.query_cli(BOUND,home=Path('/fixture'))['ok'])
        self.assertEqual(calls[1][0],live.COMMAND)
        self.assertEqual(calls[1][1]['args'],{'business_id':BIZ,'origin':'hermes','locale':'pt-BR'})
        self.assertTrue(calls[1][1]['full'])
        self.assertIsNone(calls[1][1]['id'])
        cli.catalog=lambda *a,**k:[{'name':live.COMMAND,'read_only':False}]
        with patch.object(live,'load_cli',return_value=cli):
            with self.assertRaises(ValueError):live.query_cli(BOUND,home=Path('/fixture'))

    def test_actual_child_reuses_installed_cli_and_filters_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'skills/saleads-cli/scripts/saleads.py'
            source.parent.mkdir(parents=True)
            fixture=response(extra={'html':'PRIVATE_HTML','credentials':'SECRET'})
            source.write_text('def load_settings():return {}\ndef read_token():return "PRIVATE_TOKEN"\n'
              'def catalog(*a,**k):return [{"name":n,"read_only":True} for n in ["saleads_landing_list","saleads_landing_get"]]\n'
              'def execute(settings,token,name,opts,entry):\n'
              ' print("PRIVATE_DEBUG")\n'
              ' assert opts["args"]["business_id"]=="'+BIZ+'"\n'
              ' return '+repr({'ok':True,'data':{'landings':[summary()]}})+' if name=="saleads_landing_list" else '+repr({'ok':True,'data':fixture['data']['landings'][0]})+'\n')
            result=live.read(BOUND,1000,home=tmp)
            self.assertEqual(result['status'],'current')
            self.assertEqual(result['landings'][0]['publishedN'],6)
            self.assertNotIn('PRIVATE',live.encoded(result))
            self.assertNotIn('SECRET',live.encoded(result))

    def test_real_subprocess_deadline_kills_slow_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'skills/saleads-cli/scripts/saleads.py';source.parent.mkdir(parents=True)
            source.write_text('import time\ntime.sleep(30)\n')
            result=live.read(BOUND,1000,home=tmp)
            self.assertEqual(result['reason'],'deadline_exceeded')


    def test_current_read_exception_preserves_routing_locale_and_explicit_unavailability(self):
        def failed(*_):raise ValueError('private underlying error must not leak')
        value=context.pack(BOUND,read_state=failed)['context']
        self.assertIn('"response_locale":"pt-BR"',value)
        self.assertIn('"locale_revision":3',value)
        self.assertIn('"reason":"read_failed"',value)
        self.assertIn('Omitted is not absent',value)
        self.assertNotIn('private underlying',value)
        self.assertLessEqual(len(value),2000)


    def test_actual_summary_contract_requires_detail_read_before_versions_are_projected(self):
        summary={'id':PAGE,'origin':'hermes','name':'Synthetic page','format':'product_page','status':'draft','eventCounts':{}}
        calls=[]
        def execute(settings,token,name,opts,entry):
            calls.append((name,opts['args']))
            return {'ok':True,'data':{'landings':[summary]}} if name=='saleads_landing_list' else {'ok':True,'data':response()['data']['landings'][0]}
        cli=SimpleNamespace(load_settings=lambda:{},read_token=lambda:'private',
            catalog=lambda *a,**k:[{'name':n,'read_only':True} for n in ['saleads_landing_list','saleads_landing_get']],execute=execute)
        with patch.object(live,'load_cli',return_value=cli):
            result=live.query_cli(BOUND,home=Path('/fixture'))
        state=live.project(result,BOUND,max_chars=1000,now=NOW)
        self.assertEqual(state['landings'][0]['publishedN'],6)
        self.assertEqual([name for name,_ in calls],['saleads_landing_list','saleads_landing_get'])
        self.assertEqual(calls[1][1],{'business_id':BIZ,'locale':'pt-BR','landing_id':PAGE})


    def test_summary_list_has_at_most_three_detail_reads_and_declares_the_rest(self):
        identifiers=[f'00000000-0000-4000-8000-{n:012d}' for n in range(10,15)]
        calls=[]
        def execute(settings,token,name,opts,entry):
            calls.append((name,opts['args']))
            if name==live.COMMAND:return {'ok':True,'data':{'landings':[summary(i) for i in identifiers]}}
            row=response()['data']['landings'][0].copy();row['id']=opts['args']['landing_id']
            return {'ok':True,'data':row}
        cli=SimpleNamespace(load_settings=lambda:{},read_token=lambda:'private',
            catalog=lambda *a,**k:[{'name':n,'read_only':True} for n in [live.COMMAND,'saleads_landing_get']],execute=execute)
        with patch.object(live,'load_cli',return_value=cli):result=live.query_cli(BOUND,home=Path('/fixture'))
        self.assertEqual([name for name,_ in calls],[live.COMMAND]+['saleads_landing_get']*3)
        self.assertEqual(result['omitted'],2)
        self.assertEqual([row['id'] for row in result['data']['landings']],identifiers[:3])
        self.assertTrue(all(set(args)=={'business_id','locale','landing_id'} for name,args in calls if name=='saleads_landing_get'))
        self.assertEqual(live.project(result,BOUND,max_chars=2000,now=NOW)['omitted'],2)

    def test_empty_typed_list_is_current_without_detail_capability_or_call(self):
        calls=[]
        cli=SimpleNamespace(load_settings=lambda:{},read_token=lambda:'private',
            catalog=lambda *a,**k:[{'name':live.COMMAND,'read_only':True}],
            execute=lambda *args:calls.append(args[2]) or {'ok':True,'data':{'landings':[]}})
        with patch.object(live,'load_cli',return_value=cli):result=live.query_cli(BOUND,home=Path('/fixture'))
        self.assertEqual(calls,[live.COMMAND])
        state=live.project(result,BOUND,max_chars=1000,now=NOW)
        self.assertEqual(state['landings'],[])
        self.assertNotIn('detail_source',state)

    def test_detail_id_and_business_must_match_list_and_runtime_before_projection(self):
        for delta in [{'id':BIZ},{'businessId':PAGE}]:
            with self.subTest(delta=delta):
                detail={**response()['data']['landings'][0],**delta}
                cli=SimpleNamespace(load_settings=lambda:{},read_token=lambda:'private',
                    catalog=lambda *a,**k:[{'name':n,'read_only':True} for n in [live.COMMAND,'saleads_landing_get']],
                    execute=lambda settings,token,name,opts,entry:({'ok':True,'data':{'landings':[summary()]}} if name==live.COMMAND else {'ok':True,'data':detail}))
                with patch.object(live,'load_cli',return_value=cli):
                    with self.assertRaisesRegex(ValueError,'binding_mismatch'):
                        live.query_cli(BOUND,home=Path('/fixture'))

    def test_actual_detail_omitted_revision_fields_remain_nullable(self):
        detail=response(status='draft')['data']['landings'][0]
        detail.pop('latestN');detail.pop('publishedN')
        state=live.project({'ok':True,'data':{'landings':[detail]}},BOUND,max_chars=1000,now=NOW)
        self.assertIsNone(state['landings'][0]['latestN'])
        self.assertIsNone(state['landings'][0]['publishedN'])


    def test_real_installed_execute_does_not_change_shared_selected_business_hint(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'HERMES_HOME':tmp}):
            home=Path(tmp); source=home/'skills/saleads-cli/scripts/saleads.py';source.parent.mkdir(parents=True)
            source.write_bytes((ROOT/'distribution/saleads-sales-agent/1.5.12/skills/saleads-cli/scripts/saleads.py').read_bytes())
            (source.parent.parent/'config.json').write_text(json.dumps({'url':'https://fixture.test'}))
            (home/'mcp-tokens').mkdir();(home/'mcp-tokens/saleads.json').write_text(json.dumps({'access_token':'fixture-private-token'}))
            cache=home/'cache/saleads-cli/business.json';cache.parent.mkdir(parents=True)
            original=json.dumps({'base':'https://fixture.test','business_id':PAGE}).encode();cache.write_bytes(original)
            calls=[]
            cli=live.load_cli(home)
            def http(method,url,token,body=None,headers=None,timeout=90):
                self.assertEqual(token,'fixture-private-token')
                name=url.rsplit('/',1)[-1]
                if method=='GET' and name=='commands':
                    value={'commands':[{'name':n,'read_only':True} for n in [live.COMMAND,'saleads_landing_get']]}
                elif method=='GET':
                    fields=['business_id','locale']+(['origin'] if name==live.COMMAND else ['landing_id'])
                    value={'input_schema':{'properties':{field:{} for field in fields},'required':['business_id'],'additionalProperties':False}}
                else:
                    calls.append((name,body))
                    value={'landings':[summary()]} if name==live.COMMAND else response()['data']['landings'][0]
                return 200,json.dumps({'ok':True,'data':value}).encode(),{}
            cli.http=http
            with patch.object(live,'load_cli',return_value=cli):
                result=live.query_cli({**BOUND,'response_locale':'es'},home=home)
            self.assertTrue(result['ok'])
            self.assertEqual([name for name,_ in calls],[live.COMMAND,'saleads_landing_get'])
            self.assertEqual(cache.read_bytes(),original)
