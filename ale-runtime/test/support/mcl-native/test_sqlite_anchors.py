"""Idle WAL handles: stdlib unit tests plus the actual pinned SDK when available."""
from contextlib import closing
import importlib.util
from pathlib import Path
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
ENTRY = ROOT / 'vm/extensions/saleads-memory/__init__.py'
spec = importlib.util.spec_from_file_location('mcl_anchor_memory', ENTRY,
    submodule_search_locations=[str(ENTRY.parent)])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
context = sys.modules[spec.name + '.context']
memory = sys.modules[spec.name + '.memory']


def ordinary_ro(path):
    return sqlite3.connect(path.as_uri() + '?mode=ro', uri=True,
                           isolation_level=None, check_same_thread=False)


def create(path):
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE fixture(id TEXT PRIMARY KEY,value TEXT)')
    db.execute("INSERT INTO fixture VALUES('one','original')")
    db.commit()
    return db


class Anchors(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.opener = patch.object(context, '_open_native_readonly', side_effect=ordinary_ro)
        self.opener.start()

    def tearDown(self):
        context.release_native_sqlite_anchors()
        self.opener.stop()
        self.temporary.cleanup()

    def test_missing_and_unrelated_stores_are_not_created_or_opened(self):
        create(self.root / 'unrelated.db').close()
        context.retain_native_sqlite_anchors(self.root)
        self.assertEqual(context._SQLITE_ANCHORS, {})
        self.assertFalse((self.root / 'kanban.db').exists())
        self.assertFalse((self.root / 'state.db').exists())

    def test_retained_handles_are_readonly_idle_idempotent_and_do_not_starve_checkpoint(self):
        writer = create(self.root / 'kanban.db')
        create(self.root / 'state.db').close()
        context.retain_native_sqlite_anchors(self.root)
        anchors = {path: entry[1] for path, entry in context._SQLITE_ANCHORS.items()}
        self.assertEqual(set(path.name for path in anchors), {'kanban.db', 'state.db'})
        writer.close()
        context.retain_native_sqlite_anchors(self.root)
        self.assertEqual(anchors, {path: entry[1] for path, entry in context._SQLITE_ANCHORS.items()})
        for db in anchors.values():
            self.assertFalse(db.in_transaction)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute('CREATE TABLE forbidden(id INTEGER)')
        with closing(sqlite3.connect(self.root / 'kanban.db')) as writer:
            writer.execute("INSERT INTO fixture VALUES('two','new value')")
            writer.commit()
            self.assertEqual(writer.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0], 0)
        with closing(ordinary_ro(self.root / 'kanban.db')) as reader:
            self.assertEqual(reader.execute('SELECT count(*) FROM fixture').fetchone()[0], 2)
        context.release_native_sqlite_anchors(self.root)
        self.assertEqual(context._SQLITE_ANCHORS, {})

    def test_symlink_store_is_rejected(self):
        create(self.root / 'other.db').close()
        (self.root / 'kanban.db').symlink_to(self.root / 'other.db')
        with self.assertRaises(OSError):
            context.retain_native_sqlite_anchors(self.root)
        self.assertEqual(context._SQLITE_ANCHORS, {})

    def test_new_native_board_after_pre_is_retained_before_goal_validation_and_unloaded(self):
        callbacks, calls = [], []
        ctx = types.SimpleNamespace(current_cron_execution=lambda: None, on_unload=callbacks.append)
        value = {'owner_id': 'synthetic-owner', 'business_id': '11111111-1111-4111-8111-111111111111',
                 'session_id': 'owner-chat', 'actor_role': 'ale'}
        def request(_context, route, payload, **kwargs):
            calls.append(route)
            self.assertIn((self.root / 'kanban.db').resolve(), context._SQLITE_ANCHORS)
            return {'goal': {'owner_id': value['owner_id'], 'business_id': value['business_id'],
                             'goal_id': 'synthetic-goal', 'revision': 1}, 'accepted': True}
        plugin = memory.MemoryPlugin(ctx, home=self.root,
            client=types.SimpleNamespace(request=request), resolver=lambda **kwargs: value,
            sources=types.SimpleNamespace(current=lambda _context: []),
            specialists=types.SimpleNamespace(reconcile=lambda: 0), trigger=object())
        plugin.retain_native_stores()  # Native board does not exist at first pre.
        create(self.root / 'kanban.db').close()  # Official native creation is separate.
        self.assertIn('"accepted": true', plugin.goal({'native_task_ids': ['native-one']}, session_id='owner-chat'))
        self.assertEqual(calls, ['/continuous/goals', '/continuous/goals'])
        callbacks[0]()
        self.assertEqual(context._SQLITE_ANCHORS, {})


@unittest.skipUnless(os.environ.get('MCL_HERMES_SOURCE'), 'actual pinned Hermes SDK is required')
class NativeTrackedAnchor(unittest.TestCase):
    def test_native_tracking_lasts_until_release(self):
        sys.path.insert(0, os.environ['MCL_HERMES_SOURCE'])
        from hermes_cli.sqlite_safe_read import has_live_connection
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'kanban.db'
            create(path).close()
            context.retain_native_sqlite_anchors(path.parent)
            try:
                self.assertTrue(has_live_connection(path))
                self.assertFalse(context._SQLITE_ANCHORS[path.resolve()][1].in_transaction)
            finally:
                context.release_native_sqlite_anchors(path.parent)
            self.assertFalse(has_live_connection(path))


if __name__ == '__main__':
    unittest.main()
