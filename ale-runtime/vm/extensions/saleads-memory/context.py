"""Load only the managed native context resolver; never parse identity from messages."""
from functools import lru_cache
from contextlib import closing
import atexit
import importlib.util
from pathlib import Path
import sqlite3
import threading

from .client import MemoryFailure

CONTEXT_MODULE = Path('/opt/data/plugins/saleads-continuity/context.py')
_SQLITE_ANCHORS = {}
_SQLITE_ANCHORS_LOCK = threading.RLock()


def _open_native_readonly(path):
    # Native tracking prevents its raw-file diagnostics from cancelling this
    # process's SQLite advisory locks. No custom VFS or untracked SDK fork.
    from hermes_cli.sqlite_safe_read import connect_tracked
    return connect_tracked(path.as_uri() + '?mode=ro', tracking_path=path,
                           uri=True, timeout=1, isolation_level=None,
                           check_same_thread=False)


def retain_native_sqlite_anchors(root):
    """Retain idle native RO handles so Brain's RO mount can open WAL stores.

    Only existing fixed root stores are eligible. Their official SDK owners
    initialize fresh databases; call this again after native creation, before a
    Brain bind. Warm-up consumes/closes its cursor, leaving no read transaction
    or checkpoint-starving end mark. No database, task or session is created.
    """
    root = Path(root)
    if root.is_symlink():
        raise OSError('Native SQLite root must not be a symlink')
    root = root.resolve()
    with _SQLITE_ANCHORS_LOCK:
        for name in ('kanban.db', 'state.db'):
            path = root / name
            if path.is_symlink():
                raise OSError('Native SQLite store must not be a symlink')
            if not path.is_file():
                continue
            identity = (path.stat().st_dev, path.stat().st_ino)
            previous = _SQLITE_ANCHORS.get(path)
            if previous and previous[0] == identity:
                continue
            if previous:
                previous[1].close()
                del _SQLITE_ANCHORS[path]
            db = _open_native_readonly(path)
            try:
                cursor = db.execute('PRAGMA schema_version')
                try:
                    cursor.fetchall()
                finally:
                    cursor.close()
                if db.in_transaction:
                    raise sqlite3.OperationalError('Native SQLite anchor has a transaction')
                _SQLITE_ANCHORS[path] = (identity, db)
            except BaseException:
                db.close()
                raise


def release_native_sqlite_anchors(root=None):
    """Official plugin unload/process shutdown releases its idle descriptors."""
    root = Path(root).resolve() if root is not None else None
    with _SQLITE_ANCHORS_LOCK:
        for path in list(_SQLITE_ANCHORS):
            if root is None or path.parent == root:
                _SQLITE_ANCHORS[path][1].close()
                del _SQLITE_ANCHORS[path]


atexit.register(release_native_sqlite_anchors)


@lru_cache(maxsize=1)
def resolver():
    specification = importlib.util.spec_from_file_location('_saleads_managed_context', CONTEXT_MODULE)
    if specification is None or specification.loader is None:
        raise OSError('Managed context resolver unavailable')
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module.resolve


def resolve_context(*, session_id, cron_identity):
    try:
        return resolver()(session_id=session_id, cron_identity=cron_identity)
    except (OSError, ImportError, AttributeError, ValueError):
        return None


def same_profile_session(home, canonical, actual):
    """Only the official compression tip in this exact profile's read-only native store is an alias."""
    if not isinstance(canonical, str) or not isinstance(actual, str) or not canonical or not actual:
        return False
    if canonical == actual:
        return True
    path = Path(home) / 'state.db'
    if not path.is_file() or path.is_symlink():
        return False
    try:
        from hermes_state import SessionDB
        db = SessionDB(path, read_only=True)
        try:
            rows = (db.get_session(canonical), db.get_session(actual))
            if any(not isinstance(row, dict) or row.get('profile_name') not in (None, '', Path(home).name) for row in rows):
                return False
            return db.get_compression_tip(canonical) == actual
        finally:
            db.close()
    except (ImportError, AttributeError, OSError, RuntimeError, ValueError, sqlite3.Error):
        return False


def native_task_query(context, root):
    """Read only this authenticated task/run's actual assignment for lexical recall.

    The launch command is administrative input, not the work description. No
    identity, path or selector is derived from message text; a failed binding
    never falls back to querying that wrapper or a different task.
    """
    task, run = context.get('native_task_id'), context.get('native_run_id')
    if task is None and run is None:
        return None
    if (not isinstance(task, str) or not task or len(task) > 200
            or not isinstance(run, str) or not run.isascii() or not run.isdigit() or len(run) > 18):
        raise MemoryFailure('MEMORY_NATIVE_TASK_UNAVAILABLE')
    root = Path(root)
    path = root / 'kanban.db'
    try:
        if root.is_symlink() or path.is_symlink() or not path.is_file():
            raise MemoryFailure('MEMORY_NATIVE_TASK_UNAVAILABLE')
        with closing(_open_native_readonly(path.resolve())) as db:
            db.row_factory = sqlite3.Row
            cursor = db.execute(
                'SELECT t.id AS task_id,t.tenant,t.assignee,r.id AS run_id,r.profile,'
                'substr(t.title,1,500) AS title,substr(t.body,1,4000) AS body,'
                'typeof(t.title) AS title_type,typeof(t.body) AS body_type '
                'FROM tasks t JOIN task_runs r ON r.task_id=t.id WHERE t.id=? AND r.id=?',
                (task, int(run)))
            try:
                row = cursor.fetchone()
            finally:
                cursor.close()
        expected = (task, context['business_id'], context['actor_role'], run, context['actor_role'])
        if row is None or (row['task_id'], row['tenant'], row['assignee'], str(row['run_id']), row['profile']) != expected:
            raise MemoryFailure('MEMORY_NATIVE_TASK_UNAVAILABLE')
        if row['title_type'] != 'text' or row['body_type'] not in ('text','null'):
            raise MemoryFailure('MEMORY_NATIVE_TASK_UNAVAILABLE')
        query = (row['title'] + '\n\n' + (row['body'] or '')).strip()[:4000]
        if not query:
            raise MemoryFailure('MEMORY_NATIVE_TASK_UNAVAILABLE')
        return query
    except (ImportError, OSError, sqlite3.Error, ValueError, KeyError, TypeError, OverflowError, RuntimeError, AttributeError) as error:
        raise MemoryFailure('MEMORY_NATIVE_TASK_UNAVAILABLE') from error
