"""Deliver a verified native Kanban wake's existing result to current homes.

The original canonical API transcript is the fallback. This module never runs
inference, creates a cron identity, appends history, or overrides a built-in.
"""
from __future__ import annotations

from dataclasses import dataclass
from contextlib import closing
import datetime as dt
import fcntl
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time

from .context import ROOT, ROLES, native_continuation, resolve
from .delivery import atomic, encoded, native_send, positive
from .notifications import visible_text
from .turn_frames import TurnFrames

WAKE = re.compile(r'^\[kanban\] Task ([A-Za-z0-9][A-Za-z0-9_.:-]{0,199}) [^\n]+\n')
EVENTS = {'completed': ('done', 'completed'), 'blocked': ('blocked', 'blocked'),
          'crashed': ('crashed', 'crashed'), 'timed_out': ('timed_out', 'timed_out'),
          'gave_up': ('failed', 'gave_up')}
COMMERCIAL_PROFILES = ROLES - {'ale', 'curador'}


@dataclass(frozen=True)
class GoalWake:
    owner_id: str
    business_id: str
    session_id: str  # Canonical SaleADS conversation, independent of compression.
    actual_session_id: str
    response_locale: str
    locale_revision: int
    task_id: str
    run_id: str
    event_id: int
    event_kind: str

    @property
    def identity(self):
        return hashlib.sha256(encoded([self.owner_id, self.business_id, self.session_id,
            self.task_id, self.run_id, self.event_id])).hexdigest()


class GoalFrames:
    """Pre/post callbacks run on separate bounded workers; ContextVar writes do not cross them."""
    def __init__(self, *, root: Path = ROOT, clock=time.monotonic, max_pending=512, ttl_seconds=86400):
        self.root = root
        self._frames = TurnFrames(clock=clock, max_pending=max_pending, ttl_seconds=ttl_seconds)

    def capture(self, *, turn_id, context, session_id, user_message, platform, cron_identity=None):
        if not self._frames.valid(turn_id):
            return False
        frame = bind_wake(context, session_id=session_id, user_message=user_message,
            platform=platform, cron_identity=cron_identity, root=self.root)
        return frame is not None and self._frames.record(turn_id, frame)

    def take(self, turn_id):
        return self._frames.take(turn_id)


def bind_wake(context, *, session_id, user_message, platform, cron_identity=None,
              root: Path = ROOT, resolver=resolve, lineage_resolver=native_continuation):
    """Bind raw internal wake to a claimed native event in this owner's canonical API chat."""
    if (platform != 'api_server' or cron_identity is not None or not isinstance(user_message, str)
            or not isinstance(context, dict) or context.get('actor_role') != 'ale'):
        return None
    match = WAKE.match(user_message)
    if match is None:
        return None  # OWNER JSON/legacy envelopes, quoted literals, cron, workers and arbitrary text fail here.
    current = resolver(session_id=session_id, cron_identity=None, root=root)
    fields = ('owner_id', 'business_id', 'session_id', 'response_locale', 'locale_revision')
    if not current or any(current.get(key) != context.get(key) for key in fields):
        return None
    canonical = context['session_id']
    if session_id != canonical and not lineage_resolver(canonical, session_id):
        return None
    path = root.parent.parent / 'kanban.db'
    if path.is_symlink() or not path.is_file():
        return None
    try:
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)) as db:
            db.row_factory = sqlite3.Row
            task = db.execute('SELECT id,tenant,assignee FROM tasks WHERE id=?', (match[1],)).fetchone()
            if task is None or task['tenant'] != context['business_id'] or task['assignee'] not in COMMERCIAL_PROFILES:
                return None
            subscriptions = db.execute("SELECT chat_id,last_event_id FROM kanban_notify_subs WHERE task_id=? AND platform='api_server' AND COALESCE(notifier_profile,'default')='default' AND delivery_mode IN ('notify+wake','wake')", (task['id'],)).fetchall()
            matched = [sub for sub in subscriptions if sub['chat_id'] in {canonical, session_id}
                or lineage_resolver(sub['chat_id'], session_id)]
            if len(matched) != 1 or type(matched[0]['last_event_id']) is not int:
                return None
            cursor = matched[0]['last_event_id']
            event = db.execute("SELECT e.id,e.run_id,e.kind,r.profile,r.status,r.outcome,r.ended_at FROM task_events e JOIN task_runs r ON r.id=e.run_id AND r.task_id=e.task_id WHERE e.task_id=? AND e.id<=? AND e.kind IN ('completed','blocked','crashed','timed_out','gave_up') ORDER BY e.id DESC LIMIT 1", (task['id'], cursor)).fetchone()
            if (event is None or event['profile'] != task['assignee'] or EVENTS[event['kind']] != (event['status'], event['outcome'])
                    or type(event['ended_at']) is not int):
                return None
        return GoalWake(context['owner_id'], context['business_id'], canonical, session_id,
            context['response_locale'], context['locale_revision'], task['id'], str(event['run_id']), event['id'], event['kind'])
    except (OSError, sqlite3.Error, KeyError, TypeError, ValueError):
        return None


def current_home_targets():
    """Resolve actual /sethome destinations, without inventing a job or cron execution."""
    from cron.scheduler_delivery import _resolve_delivery_targets
    return [target for target in _resolve_delivery_targets({'deliver': 'all'})
            if str(target.get('platform', '')).lower() not in {'api_server', 'saleads_home'}]


def _read(path):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 131072:
            return None
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def _targets(values):
    if not isinstance(values, list):
        raise ValueError('invalid_targets')
    normalized = []
    for target in values:
        if not isinstance(target, dict) or not isinstance(target.get('platform'), str) or not target.get('chat_id'):
            raise ValueError('invalid_target')
        if target['platform'].lower() in {'api_server', 'saleads_home'}:
            continue
        selected = {key: target.get(key) for key in ('platform', 'chat_id', 'thread_id')}
        if selected not in normalized:
            normalized.append(selected)
    return normalized


def result_path(root, wake):
    return root / 'goal-delivery-receipts' / (wake.identity + '.json')


async def deliver(wake, response, *, root: Path = ROOT, target_resolver=current_home_targets,
                  sender=native_send, current_resolver=resolve, now=None):
    """Send the existing final text once per native event; unknown ACK never grants a replay."""
    text = visible_text(response)
    if not isinstance(wake, GoalWake) or text is None or text.startswith('[kanban]'):
        return {'state': 'failed', 'error': 'managed_goal_source_required', 'source_kind': 'goal_result'}
    directory = root / 'goal-delivery-receipts'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        return {'state': 'unknown', 'error': 'managed_goal_store_unavailable', 'source_kind': 'goal_result'}
    path = result_path(root, wake)
    if path.is_symlink() or path.with_suffix('.lock').is_symlink():
        return {'state': 'unknown', 'error': 'managed_goal_store_unavailable', 'source_kind': 'goal_result'}
    with path.with_suffix('.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'state': 'unknown', 'error': 'managed_goal_delivery_in_progress', 'source_kind': 'goal_result'}
        content_hash = hashlib.sha256(text.encode()).hexdigest()
        previous = _read(path)
        if path.exists() and previous is None:
            return {'state': 'unknown', 'error': 'managed_goal_receipt_unreadable', 'source_kind': 'goal_result'}
        if previous is not None:
            if previous.get('content_sha256') != content_hash:
                return {'state': 'unknown', 'error': 'managed_goal_source_mutation', 'source_kind': 'goal_result'}
            return previous
        now = now or dt.datetime.now(dt.timezone.utc)
        record = {'schema_version': 'managed-goal-home-receipt/1', 'source_kind': 'goal_result',
            'owner_id': wake.owner_id, 'business_id': wake.business_id, 'session_id': wake.session_id,
            'task_id': wake.task_id, 'native_run_id': wake.run_id, 'event_id': wake.event_id,
            'execution_id': 'goal-wake-' + wake.identity, 'attempt_id': 'goal-home-' + wake.identity,
            'response_locale': wake.response_locale, 'locale_revision': wake.locale_revision,
            'content_sha256': content_hash, 'state': 'unknown', 'targets': [],
            'fallback': 'native_canonical_history', 'extra_saleads_projection': False,
            'started_at': now.isoformat(), 'reconcile_by': (now + dt.timedelta(seconds=120)).isoformat(),
            'finished_at': None, 'destination_version': None}
        # The language belongs to generation time. A later preference change cannot relabel/send this old text.
        current = current_resolver(session_id=wake.session_id, cron_identity=None, root=root)
        keys = ('owner_id', 'business_id', 'session_id', 'response_locale', 'locale_revision')
        if not current or any(current.get(key) != record[key] for key in keys):
            record.update(state='failed', error='managed_goal_context_changed', finished_at=now.isoformat())
            atomic(path, record)
            return record
        try:
            targets = _targets(target_resolver())
        except (OSError, ValueError, TypeError, RuntimeError, ImportError):
            atomic(path, record)
            return record
        record['destination_version'] = hashlib.sha256(encoded(targets)).hexdigest()
        if not targets:
            record.update(state='no_home', finished_at=now.isoformat())
            atomic(path, record)
            return record
        record['targets'] = [{'target_hash': hashlib.sha256(encoded(target)).hexdigest(), 'state': 'unknown',
                              'message_id': None, 'ack_sha256': None} for target in targets]
        atomic(path, record)  # Intent is durable BEFORE a remote sender can accept anything.
        for index, target in enumerate(targets):
            try:
                answer = await sender(target, text)
            except Exception:
                answer = None  # Acceptance may have occurred. Never persist provider exception text.
            item = record['targets'][index]
            if positive(answer):
                item.update(state='delivered', message_id=str(answer['message_id']) if answer.get('message_id') else None,
                    ack_sha256=hashlib.sha256(encoded(answer.get('raw_response') or {'message_id': str(answer['message_id'])})).hexdigest())
            elif isinstance(answer, dict) and answer.get('definitely_not_sent') is True:
                item['state'] = 'failed'
            atomic(path, record)
        states = {target['state'] for target in record['targets']}
        state = 'delivered' if 'delivered' in states else 'failed' if states == {'failed'} else 'unknown'
        record.update(state=state, fallback=None if state == 'delivered' else 'native_canonical_history',
            finished_at=dt.datetime.now(dt.timezone.utc).isoformat())
        atomic(path, record)
        return record
