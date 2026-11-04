import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from cloudsim.compute import Cloud  # noqa: E402
from cloudsim.drivers import FakeDriver  # noqa: E402
from cloudsim.server import build_server  # noqa: E402
from cloudsim.storage import Storage  # noqa: E402

PROJECT, ZONE = "ale-local", "local-sim1-a"
TEMPLATE = [{"key": "startup-script", "value": "#!/bin/bash\necho hi\n"},
            {"key": "enable-guest-attributes", "value": "TRUE"}]
BEARER = {"Authorization": "Bearer ya29.test"}
FLAVOR = {"Metadata-Flavor": "Google"}


class Sim:
    """cloud-sim en un puerto efímero con el driver falso."""

    def __init__(self, state_file=None, driver=None, ca_file=None):
        self.tmp = tempfile.mkdtemp()
        self.driver = driver or FakeDriver()
        self.cloud = Cloud(self.driver, PROJECT, ZONE, TEMPLATE, state_file=state_file)
        self.server = build_server(self.cloud, Storage(os.path.join(self.tmp, "gcs")), 0,
                                   ca_file=ca_file, host="127.0.0.1")
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def call(self, method, path, body=None, headers=None, raw=False, content_type=None):
        data = None
        hdrs = dict(headers if headers is not None else BEARER)
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
            hdrs["Content-Type"] = content_type or "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = resp.read()
                return resp.status, (payload if raw else json.loads(payload or b"{}")), dict(resp.headers)
        except urllib.error.HTTPError as err:
            payload = err.read()
            try:
                parsed = payload if raw else json.loads(payload or b"{}")
            except ValueError:
                parsed = payload
            return err.code, parsed, dict(err.headers)

    def zone(self, rest=""):
        return f"/compute/v1/projects/{PROJECT}/zones/{ZONE}{rest}"

    def wait_op(self, op_name, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            _, op, _ = self.call("GET", self.zone(f"/operations/{op_name}"))
            if op["status"] == "DONE":
                return op
            time.sleep(0.02)
        raise AssertionError(f"operation {op_name} never finished")
