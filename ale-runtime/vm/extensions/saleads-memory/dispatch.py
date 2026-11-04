"""Request deterministic native curation after complete material sources, never another chat turn."""
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread

from .client import canonical

SCRIPT = '/opt/data/saleads/runtime/curation-dispatcher.py'


def launch_dispatcher():
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('HERMES_KANBAN_') and key not in {'HERMES_TENANT', 'HERMES_PROFILE', 'HERMES_SESSION_ID'}}
    env.update(HERMES_HOME='/opt/data', HERMES_KANBAN_HOME='/opt/data')
    try:
        process = subprocess.Popen([sys.executable, SCRIPT, '--data-dir', '/opt/data'], env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True)
        Thread(target=process.wait, daemon=True).start()
        return True  # Spawn acceptance, not proof of a curator task or business progress.
    except OSError:
        return False


class CurationTrigger:
    def __init__(self, home, *, launch=None):
        self.home = Path(home)
        self.launch = launch_dispatcher if launch is None else launch

    def request(self, context, source_ids):
        if not source_ids:
            return False
        identity = sha256(canonical([context['owner_id'], context['business_id'], sorted(source_ids)]).encode()).hexdigest()
        directory = self.home / 'plugin-data/saleads-memory/dispatch-receipts'
        path = directory / (identity + '.json')
        try:
            if path.is_file() and not path.is_symlink():
                return False
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not self.launch():
                return False
            descriptor, temporary = tempfile.mkstemp(prefix='.pending-', dir=directory)
            try:
                with os.fdopen(descriptor, 'w') as output:
                    json.dump({'schema_version': 'curation-dispatch-request/1', 'source_event_ids': sorted(source_ids), 'spawn_requested': True}, output)
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            return True
        except OSError:
            return False  # Durable Brain sources are still recovered by the independent no-agent job.
