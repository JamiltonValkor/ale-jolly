"""Bounded cross-hook bookkeeping keyed only by Hermes' native immutable turn ID.

With hook timeouts enabled, pre and post run on different copied contexts.
ContextVar mutations cannot carry plugin state between those worker threads.
Eviction/expiry only forgets observer data; it never declares a turn finished,
stops work, releases authorization, or grants permission to retry inference.
"""
from __future__ import annotations

import re
from copy import deepcopy
import threading
import time

# agent/turn_context.py:_bind_turn_identity and agent/turn_facade.py:
# <session-or-session>:<effective-task-id>:<uuid4.hex[:8]>. Scope IDs may contain colons.
TURN_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,1023}:[0-9a-f]{8}$')


class TurnFrames:
    def __init__(self, *, clock=time.monotonic, max_pending=512, ttl_seconds=86400):
        if max_pending < 1 or ttl_seconds <= 0:
            raise ValueError('invalid_turn_frame_bounds')
        self.clock, self.max_pending, self.ttl_seconds = clock, max_pending, ttl_seconds
        self._lock, self._frames = threading.Lock(), {}

    @staticmethod
    def valid(turn_id):
        return isinstance(turn_id, str) and turn_id.count(':') >= 2 and bool(TURN_ID.fullmatch(turn_id))

    def record(self, turn_id, value):
        if not self.valid(turn_id):
            return False
        with self._lock:
            now = self.clock()
            self._frames = {key: item for key, item in self._frames.items() if now - item[0] < self.ttl_seconds}
            if turn_id in self._frames:
                return False  # Repeated pre observation cannot relabel an existing generation.
            if len(self._frames) >= self.max_pending:
                self._frames.pop(next(iter(self._frames)))
            self._frames[turn_id] = (now, deepcopy(value))
            return True

    def peek(self, turn_id):
        if not self.valid(turn_id):
            return None
        with self._lock:
            item = self._frames.get(turn_id)
            if item and self.clock() - item[0] < self.ttl_seconds:
                return item[1]
            self._frames.pop(turn_id, None)
            return None

    def take(self, turn_id):
        if not self.valid(turn_id):
            return None
        with self._lock:
            item = self._frames.pop(turn_id, None)
            return item[1] if item and self.clock() - item[0] < self.ttl_seconds else None
