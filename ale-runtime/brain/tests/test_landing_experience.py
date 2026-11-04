"""Synthetic MAL-013 ingest/recall/correction through existing MCL writers.

The synthetic curator and next-output fixture below prove contract/scoping and
observable decision references only. They do not prove the live external
curator or Spark applied a lesson (the real MAL-017/C12 gate remains separate).
"""
from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from test_continuous_server import client_for, headers, managed
from test_knowledge import BUSINESS, CTX, OTHER, candidate, experience, source

from saleads_brain.curation import CurationQueue
from saleads_brain.knowledge import MemoryContext, MemoryError, MemoryWriter, validate_contract
from saleads_brain.recall import MemoryRecall

PLUGIN = Path(__file__).resolve().parents[2] / 'vm/extensions/saleads-memory'
NAME = 'landing_mcl_synthetic_plugin'
spec = importlib.util.spec_from_file_location(NAME, PLUGIN / '__init__.py', submodule_search_locations=[str(PLUGIN)])
plugin = importlib.util.module_from_spec(spec)
sys.modules[NAME] = plugin
spec.loader.exec_module(plugin)
landing = sys.modules[NAME + '.landing_experience']
capture = sys.modules[NAME + '.specialist_capture']
FIXTURE = json.loads((PLUGIN / 'fixtures/landing-experience.json').read_text())
ROLE = 'disenador_landings'


def native_episode(task='landing-task-1', run='7', text=None, canonical=False):
    context = {'owner_id': CTX.owner_id, 'business_id': BUSINESS, 'actor_role': ROLE,
               'native_task_id': task, 'native_run_id': run, 'session_id': 'synthetic-landing-session'}
    terminal = {'tenant': BUSINESS, 'assignee': ROLE, 'profile': ROLE, 'task_id': task, 'id': int(run),
                'status': 'done', 'task_status': 'done', 'outcome': 'completed', 'title': 'Mobile landing proposal',
                'started_at': 1793100000, 'ended_at': 1793100100}
    files = {name: content.encode() for name, content in FIXTURE['files'].items()}
    inputs = landing.CollectorInputs(binding=context, files=files)
    if canonical:
        def encoded(values):
            return {name: {'encoding': 'base64', 'content': base64.b64encode(body).decode(),
                'sha256': hashlib.sha256(body).hexdigest(), 'byteLength': len(body)} for name, body in values.items()}
        raw = {name: files[name] for name in landing.CODE}
        final = {**raw, 'styles.css': raw['styles.css'] + b'/* server-owned font finalization */'}
        documents = {'pagina': json.loads(files['page.json']), 'diseno': json.loads(files['design.json'])}
        request = {'business_id': BUSINESS, 'landing_id': FIXTURE['landing_id'], 'client_request_id': 'synthetic-cli-admission',
            'expected_latest_n': 0, 'files': encoded(raw), 'metadata': {'artifacts': documents}}
        receipt = {'businessId': BUSINESS, 'landingId': FIXTURE['landing_id'], 'origin': 'hermes', 'n': 1,
            'artifactDigest': landing.artifact_digest(final), 'requestId': request['client_request_id'],
            'createdBy': 'agent', 'createdAt': '2026-10-29T12:00:00Z'}
        record = {'businessId': BUSINESS, 'id': FIXTURE['landing_id'], 'origin': 'hermes', 'lineage': {
            'betId': FIXTURE['bet_id'], 'hypothesisId': FIXTURE['bet_id'], 'strategyVersionId': FIXTURE['strategy_version_id']}}
        version = {key: receipt[key] for key in ('landingId', 'origin', 'n', 'artifactDigest', 'createdBy', 'createdAt')}
        version.update(files=encoded(final), artifacts=documents)
        inputs = landing.CollectorInputs(binding=context, files=files, request=request,
            admission=receipt, landing=record, version=version)
    text = text or FIXTURE['result']
    evidence = landing.LandingExperience.extract(context, context['session_id'], terminal, text, inputs)
    return list(capture.events_for(PLUGIN, context, context['session_id'], text, terminal, landing=evidence))


def curated(memory, events):
    """A synthetic external curator chooses the lesson; adapter emits no lesson."""
    for event in events:
        memory.register_source(CTX, event)
    queue = CurationQueue(memory.ledger, memory)
    batch = queue.create(CTX)
    queue.bind_native(CTX, batch['batch_id'], 'synthetic-curation-task', '99')
    payload = experience(experience_id='landing-experience-1', specialist_role=ROLE,
        task_id=events[0]['native_task_id'], run_id=events[0]['native_run_id'], confidence='validated',
        source_event_ids=[event['event_id'] for event in events], **FIXTURE['curator_experience'])
    # Existing writer is durable before batch ACK. Replaying it in the batch
    # preserves one admission and enables the separately curated summary's edge.
    memory.experience(CTX, payload)
    committed = queue.commit(CTX, batch['batch_id'], candidates=[], experiences=[payload])
    return payload, committed


def ready(tmp_path):
    brain = managed(tmp_path)
    memory = MemoryWriter(brain.ledger, brain.store)
    events = native_episode()
    payload, batch = curated(memory, events)
    return brain, memory, events, payload, batch


def test_landing_sources_are_bound_and_replay_is_one_independent_native_episode(tmp_path):
    brain = managed(tmp_path)
    memory = MemoryWriter(brain.ledger, brain.store)
    events = native_episode(text=FIXTURE['result'] * 200)
    for event in events:
        validate_contract('source-event', event)
        assert memory.register_source(CTX, event) == memory.register_source(CTX, copy.deepcopy(event))
        assert (event['business_id'], event['author']['id'], event['native_task_id'], event['native_run_id']) == (
            BUSINESS, ROLE, 'landing-task-1', '7')
    assert len(events) > 1 and len({event['source_id'] for event in events}) == 1
    lesson, receipt = curated(memory, events)
    saved = memory.get(CTX, lesson['experience_id'])
    assert receipt['state'] == 'committed' and saved['evidence_count'] == 1
    assert saved['payload']['confidence'] == 'supported'  # No authentic human proof was supplied.
    assert saved['provenance'] == 'inferred'
    assert CurationQueue(memory.ledger, memory).pending(CTX) == []
    assert not brain.settings.llm_enabled and brain._graphiti is None
    for change in ({'task_id': 'wrong-task'}, {'run_id': '8'}, {'specialist_role': 'estratega'}):
        with pytest.raises(MemoryError, match='experience_requires_native_role_result'):
            memory.experience(CTX, {**lesson, 'experience_id': 'mismatched-experience', **change})
    with pytest.raises(MemoryError, match='source_not_found_in_business'):
        memory.source(MemoryContext(CTX.owner_id, OTHER, ROLE), events[0]['event_id'])


def test_canonical_cli_refs_are_same_episode_craft_evidence_not_owner_proof(tmp_path):
    brain = managed(tmp_path)
    memory = MemoryWriter(brain.ledger, brain.store)
    native, canonical = native_episode(), native_episode(canonical=True)
    assert native[0]['source_id'] == canonical[0]['source_id']
    assert native[0]['source_version'] != canonical[0]['source_version']
    for event in [*native, *canonical]:
        validate_contract('source-event', event)
    assert any(ref.startswith('saleads-landing-version:') for ref in canonical[0]['refs'])
    assert any(ref.startswith('saleads-landing-artifact:') for ref in canonical[0]['refs'])
    assert all(event['source_kind'] == 'specialist_result' and event['author']['kind'] == 'specialist'
               for event in canonical)
    lesson, _ = curated(memory, [*native, *canonical])
    saved = memory.get(CTX, lesson['experience_id'])
    assert saved['evidence_count'] == 1 and saved['payload']['confidence'] == 'supported'
    with pytest.raises(MemoryError, match='owner_quote_not_in_registered_source'):
        memory.candidate(CTX, candidate('false-generated-proof', 'This generated HTML proves sales.', entity_type='Proof',
            attributes={}, source_event_ids=[canonical[0]['event_id']], epistemic='declared', validation_state='confirmed'))
    recalled = MemoryRecall(memory).retrieve(replace(CTX, actor_role=ROLE), 'Review mobile landing primary action.')
    assert recalled['experiences'][0]['experience_id'] == lesson['experience_id']
    assert recalled['refs'] == sorted(event['event_id'] for event in [*native, *canonical])
    for context in (replace(CTX, actor_role='ale'), replace(CTX, actor_role='estratega'), MemoryContext(CTX.owner_id, OTHER, ROLE)):
        assert MemoryRecall(memory).retrieve(context, 'Review mobile landing primary action.')['experiences'] == []


def test_correction_gets_new_identity_instead_of_rewriting_the_registered_source(tmp_path):
    _, memory, events, old, _ = ready(tmp_path)
    changed = copy.deepcopy(events[0])
    changed['content'] += '\nChanged in place.'
    changed['content_sha256'] = hashlib.sha256(changed['content'].encode()).hexdigest()
    with pytest.raises(MemoryError, match='source_identity_conflict'):
        memory.register_source(CTX, changed)
    with pytest.raises(MemoryError, match='candidate_idempotency_conflict'):
        memory.experience(CTX, {**old, 'correction': 'Silently replace the old correction.'})
    corrected_events = native_episode(task='landing-task-correction', run='8',
        text='Corrected the mobile header to one primary action; visual review remains unavailable.')
    for event in corrected_events:
        memory.register_source(CTX, event)
    corrected = {**old, 'experience_id': 'landing-experience-correction', 'task_id': 'landing-task-correction',
                 'run_id': '8', 'lesson': 'For mobile landing navigation, keep one primary action with readable contrast.',
                 'source_event_ids': [event['event_id'] for event in corrected_events]}
    new = memory.experience(CTX, corrected)
    assert new['record_id'] != memory.get(CTX, old['experience_id'])['record_id']
    assert corrected_events[0]['source_id'] != events[0]['source_id']
    assert memory.get(CTX, old['experience_id'])['payload']['correction'] == old['correction']


def test_new_session_recovers_full_pack_and_next_output_records_applied_decision_ref(tmp_path):
    brain, memory, events, payload, _ = ready(tmp_path)
    saved = memory.get(CTX, payload['experience_id'])
    query = 'Design the next mobile landing header with a primary action.'
    with client_for(brain) as client:
        response = client.post('/continuous/context', headers=headers(ROLE, session_id='new-synthetic-session',
            native_task_id='landing-next-task', native_run_id='9'),
            json={'business_id': BUSINESS, 'actor_role': ROLE, 'query': query, 'max_chars': 5600})
        assert response.status_code == 200
        pack = response.json()
    validate_contract('context-pack', pack)
    assert pack['experiences'][0]['experience_id'] == payload['experience_id']
    delivered = [*pack['knowledge'], *pack['experiences']]
    assert pack['versions'][saved['record_id']] == saved['revision']
    assert len(pack['versions']) == len(delivered)
    assert pack['refs'] == sorted({ref for item in delivered for ref in item['source_event_ids']})
    assert set(event['event_id'] for event in events) <= set(pack['refs'])
    assert not pack['truncated'] and len(pack['text']) <= 5600
    injected = json.loads(pack['text'])
    assert injected['experiences'] == pack['experiences']
    # Synthetic next-output fixture, explicitly dependent on the delivered pack.
    # This is a contract witness, not an assertion about Spark's live behavior.
    next_design = copy.deepcopy(FIXTURE['next_design'])
    next_design['decision_refs'] = [injected['experiences'][0]['experience_id']]
    assert next_design['decision_refs'] == [payload['experience_id']]
    assert 'one primary action' in next_design['decision']
    assert next_design['index.html'] != FIXTURE['files']['index.html']
    assert '<header>' in next_design['index.html'] and 'header .primary' in next_design['styles.css']
    assert memory.get(replace(CTX, actor_role=ROLE), next_design['decision_refs'][0])['payload']['lesson'] == payload['lesson']
    assert MemoryRecall(memory).retrieve(replace(CTX, actor_role=ROLE), 'Unrelated office scheduling.')['experiences'] == []


def test_ale_and_other_roles_receive_only_a_separate_curated_summary_not_private_experience(tmp_path):
    brain, memory, events, payload, _ = ready(tmp_path)
    query = 'Review the next mobile landing primary action.'
    for role in ('ale', 'estratega'):
        with pytest.raises(MemoryError, match='private_experience_role_mismatch'):
            memory.get(replace(CTX, actor_role=role), payload['experience_id'])
        with pytest.raises(MemoryError, match='private_source_role_mismatch'):
            memory.source(replace(CTX, actor_role=role), events[0]['event_id'])
        assert MemoryRecall(memory).retrieve(replace(CTX, actor_role=role), query)['experiences'] == []
        assert MemoryRecall(memory).retrieve(replace(CTX, actor_role=role), query)['knowledge'] == []
    # shared_summary in the experience did not auto-promote. The curator must
    # explicitly create a different typed record, with its own identity/scope.
    summary = candidate('landing-team-summary', FIXTURE['curated_team_summary'], entity_type='Learning',
        attributes={'derived_from_ref': payload['experience_id']}, scope='team', epistemic='inferred',
        validation_state='proposed', source_event_ids=[events[0]['event_id']])
    saved = memory.candidate(CTX, summary)
    assert saved['record_id'] != memory.get(CTX, payload['experience_id'])['record_id']
    with client_for(brain) as client:
        ale = client.post('/continuous/context', json={'business_id': BUSINESS, 'query': query}, headers=headers('ale')).json()
        denied = client.post('/continuous/context', json={'business_id': OTHER, 'query': query}, headers=headers(ROLE))
    assert ale['experiences'] == [] and ale['knowledge'][0]['candidate_id'] == 'landing-team-summary'
    assert payload['observed_result'] not in ale['text'] and payload['shared_summary'] not in ale['text']
    assert events[0]['content'] not in ale['text']
    assert ale['refs'] == sorted({ref for item in ale['knowledge'] for ref in item['source_event_ids']})
    assert events[0]['event_id'] in ale['refs'] and ale['versions'][saved['record_id']] == saved['revision']
    assert len(ale['versions']) == len(ale['knowledge']) and not ale['truncated']
    assert denied.status_code == 400 and denied.json()['reason'] == 'memory_binding_mismatch'
    assert MemoryRecall(memory).retrieve(MemoryContext(CTX.owner_id, OTHER, ROLE), query)['experiences'] == []


def test_technical_canary_cannot_become_human_feedback_or_business_fact(tmp_path):
    _, memory, events, payload, _ = ready(tmp_path)
    technical = source('operator_canary', 'Owner quote: Keep one primary action.', event_id='automated-cto-test')
    memory.register_source(CTX, technical)
    for proposed in (candidate('false-owner-fact', 'Keep one primary action.', source_event_ids=[technical['event_id']]),):
        with pytest.raises(MemoryError, match='non_business_source_not_admissible'):
            memory.candidate(CTX, proposed)
    with pytest.raises(MemoryError, match='non_business_source_not_admissible'):
        memory.experience(CTX, {**payload, 'experience_id': 'false-human-proof',
            'source_event_ids': [events[0]['event_id'], technical['event_id']], 'confidence': 'validated'})
