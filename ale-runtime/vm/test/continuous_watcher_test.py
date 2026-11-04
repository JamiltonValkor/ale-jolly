"""Managed watcher behavior with metadata HTTP + the existing fake Docker.

No Docker daemon, cloud access, model calls or source-string ordering assertions.
ACK observations inspect actual installed artifacts at the moment of publication.
"""

from __future__ import annotations

import base64
from contextlib import closing
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
WATCHER = HERE.parent / "startup-script.sh"
ASSETS = HERE.parent / "extensions"
BUSINESS = "11111111-1111-4111-8111-111111111111"
CANARY = "22222222-2222-4222-8222-222222222222"
OWNER = "fixture-owner"
API_KEY = "synthetic-watcher-test-key-" + "a" * 40
ROLES = ("investigador", "estratega", "estructurador", "analista", "optimizador", "curador")
LEGACY_FILES = (
    "plugins/saleads-meta-search/plugin.yaml", "plugins/saleads-meta-search/__init__.py",
    "plugins/saleads-meta-search/search.py", "runtime/first-loop-exporter.py",
)
CONTINUITY_FILES = LEGACY_FILES + (
    "plugins/saleads-continuity/plugin.yaml", "plugins/saleads-continuity/__init__.py",
    "plugins/saleads-continuity/context.py", "plugins/saleads-continuity/notifications.py",
    "runtime/continuous-exporter.py",
)


def canonical_extension_assets() -> dict[str, str]:
    """Read the fixed TypeScript inventory, including shared-source aliases, without compiling Node."""
    source = (HERE.parent.parent / "src/activation/vm-extensions.ts").read_text()
    block = re.search(r"export const META_EXTENSION_FILES\s*=\s*Object\.freeze\(\{(.*?)\}\);", source, re.S)
    if block is None:
        raise ValueError("Canonical fixed extension inventory was not found")
    assets: dict[str, str] = {}
    for line in block[1].splitlines():
        if not line.strip() or line.lstrip().startswith("//"):
            continue
        pair = re.fullmatch(r"\s*'([^'\r\n]+)'\s*:\s*'([^'\r\n]+)'\s*,?\s*", line)
        if pair is None or pair[1] in assets:
            raise ValueError("Canonical extension inventory must contain unique literal asset pairs")
        assets[pair[1]] = pair[2]
    if not assets or not set(CONTINUITY_FILES) <= set(assets):
        raise ValueError("Canonical inventory lost required legacy fixture assets")
    return assets


EXTENSION_ASSETS = canonical_extension_assets()
MANAGED_FILES = tuple(EXTENSION_ASSETS)
LANDING_MEMORY_FILES = tuple(name for name in MANAGED_FILES if not name.startswith("runtime/landing-pilot/"))
MANAGED_CATALOG_FILES = tuple(name for name in LANDING_MEMORY_FILES if name != "plugins/saleads-memory/landing_experience.py")
MANAGED_V10_FILES = tuple(name for name in MANAGED_CATALOG_FILES if name != "plugins/saleads-continuity/role-catalog.json")
MANAGED_V9_FILES = tuple(name for name in MANAGED_V10_FILES if name != "plugins/saleads-continuity/run_receipts.py")


def asset(name: str) -> Path:
    return ASSETS / EXTENSION_ASSETS[name]


def archive(files: tuple[str, ...], extra: str | None = None) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        for name in (*files, *((extra,) if extra else ())):
            data = asset(name).read_bytes() if name in MANAGED_FILES else b"unexpected executable"
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return base64.b64encode(output.getvalue())


def registry() -> dict:
    return {"schema_version": "trusted-context-registry/1", "owner_id": OWNER, "jobs": [], "contexts": [{
        "schema_version": "trusted-context/1", "owner_id": OWNER, "business_id": BUSINESS,
        "session_id": "fixture-session", "actor_role": "ale", "native_task_id": None, "native_run_id": None,
        "response_locale": "pt-BR", "locale_revision": 4, "capabilities": ["saleads:read"],
        "mandate_id": None, "pending_context": False,
    }], "operator_canary_client_message_ids": [CANARY]}


def profile_archive(include_curator: bool = True) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        for role in ROLES if include_curator else ROLES[:-1]:
            config = {"toolsets": {"cli": ["skills", "saleads_memory"]}, "mcp_servers": {
                "saleads-brain": {"tools": {"include": []}},
                "saleads": {"tools": {"include": [] if role == "curador" else ["saleads_get_business_bootstrap"]}},
            }}
            for filename, data in (("SOUL.md", f"Managed specialist {role}.".encode()),
                                   ("profile-config.yaml", json.dumps(config).encode())):
                info = tarfile.TarInfo(f"profiles/{role}/{filename}")
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    return base64.b64encode(output.getvalue())


def helper(mode: str, data: bytes, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", "-c", 'source "$1"; shift; run_helper "$@"', "test", str(WATCHER), mode, *args],
                          input=data, capture_output=True, timeout=15,
                          env={**os.environ, "HERMES_PY_CMD": sys.executable})


class WatcherFixture:
    def __init__(self, *, failure: str = "") -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="mcl-watcher-")
        self.path = Path(self.tmp.name)
        self.root = self.path / "root"
        self.data = self.root / "data"
        self.state = self.root / "state"
        self.docker_state = self.path / "docker.state"
        self.data.mkdir(parents=True)
        self.state.mkdir(parents=True)
        self.docker_state.write_text("true")
        (self.root / "docker-config").mkdir()
        (self.root / "docker-config/config.json").write_text("{}")
        self.ack_observations: list[dict] = []
        self.ready_calls: list[dict] = []

        spec = importlib.util.spec_from_file_location("continuous_fake_metadata", HERE / "fake_metadata.py")
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        fixture = self

        class ObservingHandler(module.Handler):
            def do_POST(self) -> None:
                if self.path == "/_brain/continuous/ready":
                    self._body()
                    root_token = hashlib.sha256(("saleads-brain-ale:" + API_KEY).encode()).hexdigest().encode()
                    expected = hmac.new(root_token, b"mcl-collector", hashlib.sha256).hexdigest()
                    authenticated = hmac.compare_digest(self.headers.get("x-saleads-memory-token", ""), expected)
                    ready = authenticated and fixture.readiness_at_ack()["brain"]
                    fixture.ready_calls.append({"authenticated": authenticated, "ready": ready})
                    if failure == "ready_old":
                        return self._send(404, b"{}")
                    if failure == "ready_unavailable":
                        return self._send(503, b'{"ready":false}')
                    if failure == "ready_bad_shape":
                        return self._send(200, b'{"ready":true,"unexpected":true}')
                    return self._send(200 if ready else 403, json.dumps({"ready": ready}).encode())
                super().do_POST()

            def do_PUT(self) -> None:
                if self.path.endswith("/continuous-context-hash"):
                    fixture.ack_observations.append(fixture.readiness_at_ack())
                super().do_PUT()

        self.server = module.ThreadingHTTPServer(("127.0.0.1", 0), ObservingHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        docker = self.path / "fake-docker"
        docker.write_text("#!/usr/bin/env python3\nimport os,sys,subprocess,json,sqlite3,time\nfrom pathlib import Path\na=sys.argv[1:]\n"
                          "failure=os.environ.get('FAKE_CONTINUOUS_FAILURE','')\n"
                          "gateway_start=(a and ((a[0] in ('start','restart') and a[-1]=='hermes') or (a[0]=='run' and '--name' in a and a[a.index('--name')+1]=='hermes')))\n"
                          "if gateway_start:\n"
                          " data=Path(os.environ['HERMES_DATA_DIR']); accepted=data/'saleads/continuous/run-receipts/accepted'\n"
                          " proofs=[json.loads(p.read_text()) for p in accepted.glob('*.json')] if accepted.exists() else []\n"
                          " (Path(os.environ['FAKE_DOCKER_STATE']).parent/'gateway-start-proof.json').write_text(json.dumps({'terminal_copied':any(p.get('terminal_proven') is True for p in proofs)}))\n"
                          " native=data/'runs_idempotency.db'\n"
                          " if native.exists():\n"
                          "  db=sqlite3.connect(native)\n"
                          "  try:\n"
                          "   db.execute(\"DELETE FROM run_idempotency WHERE json_extract(status_json,'$.status') IN ('completed','failed','cancelled','interrupted') AND updated_at<?\",(time.time()-86400,));db.commit()\n"
                          "  finally:db.close()\n"
                          "if failure=='brain' and a and a[0]=='run' and '--name' in a and a[a.index('--name')+1]=='saleads-brain':sys.exit(1)\n"
                          "if failure=='dispatcher' and a[:4]==['exec','hermes','hermes','cron'] and 'create' in a and 'saleads:memory-reconcile' in a:sys.exit(1)\n"
                          "if a and a[0]=='exec' and 'python3' in a and '-c' in a and '/continuous/ready' in a[a.index('-c')+1]:\n"
                          " code=a[a.index('-c')+1].replace('/opt/data',os.environ['HERMES_DATA_DIR']).replace('http://saleads-brain:8765',os.environ['FAKE_CONTINUOUS_BRAIN_URL'])\n"
                          " with open(os.environ['FAKE_DOCKER_LOG'],'a') as log:log.write('ready-probe\\n')\n"
                          " sys.exit(subprocess.run([sys.executable,'-c',code]).returncode)\n"
                          f"os.execv('/bin/bash',['bash',{str(HERE / 'fake-docker.sh')!r},*a])\n")
        docker.chmod(0o700)
        python = self.path / "fake-helper.py"
        python.write_text("import os,sys\n"
                          "if os.environ.get('FAKE_CONTINUOUS_FAILURE')=='auth' and len(sys.argv)>3 and sys.argv[3]=='memory-token':sys.exit(1)\n"
                          "if len(sys.argv)>1 and sys.argv[1].endswith('/run_receipts.py'):\n"
                          " with open(os.environ['FAKE_DOCKER_LOG'],'a') as log:log.write('run-receipt-refresh\\n')\n"
                          " if os.environ.get('FAKE_CONTINUOUS_FAILURE')=='run_receipts':sys.exit(1)\n"
                          "os.execv(sys.executable,[sys.executable,*sys.argv[1:]])\n")
        self.env = {**os.environ, "HERMES_MD_URL": self.base + "/computeMetadata/v1", "HERMES_ROOT": str(self.root),
                    "HERMES_DATA_DIR": str(self.data), "HERMES_STATE_DIR": str(self.state),
                    "HERMES_OWNER": f"{os.getuid()}:{os.getgid()}", "HERMES_DOCKER": str(docker),
                    "HERMES_PY_CMD": f"{sys.executable} {python}", "FAKE_CONTINUOUS_FAILURE": failure,
                    "FAKE_CONTINUOUS_BRAIN_URL": self.base + "/_brain",
                    "FAKE_DOCKER_STATE": str(self.docker_state), "FAKE_DOCKER_LOG": str(self.path / "docker.log")}

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    def request(self, path: str, value: bytes | None = None) -> bytes:
        request = urllib.request.Request(self.base + path, data=value, method="GET" if value is None else "POST")
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.read()

    def metadata(self, key: str, value: str | bytes) -> None:
        self.request("/_ctl/set/" + key, value.encode() if isinstance(value, str) else value)

    def guest(self, key: str) -> bytes | None:
        try:
            return self.request("/_ctl/guest/" + key)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                error.close()
                return None
            raise

    def apply(self) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(WATCHER), "apply"], env=self.env, capture_output=True, timeout=60)

    def configure(self, *, managed: bool = True, brain: bool = True, extensions: bool = True) -> None:
        model = {"provider": "meta-ai", "default": "muse-spark-1.3-contributor"} if managed else {"provider": "fixture-legacy", "default": "owner-model"}
        self.metadata("hermes-api-key", API_KEY)
        self.metadata("hermes-env", "MODEL_API_KEY=synthetic-fixture-model-key\nTELEGRAM_BOT_TOKEN=synthetic-home-token\n")
        self.metadata("hermes-config", json.dumps({"model": model, "timezone": "America/Bogota",
                      "mcp_servers": {"saleads": {"url": "https://fixture.invalid/mcp"}, "saleads-brain": {"url": "http://saleads-brain:8765/mcp"}},
                      "plugins": {"enabled": []}}))
        self.metadata("hermes-bundle-version", "fixture@1.5.12")
        if brain:
            self.metadata("hermes-brain-image", "us-central1-docker.pkg.dev/fixture/brain@sha256:" + "b" * 64)
        if extensions:
            self.metadata("hermes-extensions", archive(MANAGED_FILES if managed else LEGACY_FILES))
            self.metadata("hermes-profiles", profile_archive(include_curator=managed))
        if managed:
            self.metadata("hermes-continuous-contexts", json.dumps(registry(), indent=2))

    def readiness_at_ack(self) -> dict:
        role_homes = [self.data, *(self.data / "profiles" / role for role in ROLES)]
        return {
            "tokens": all((home / "plugin-data/saleads-memory/auth-token").is_file()
                          and (home / "plugin-data/saleads-memory/collector-token").is_file() for home in role_homes),
            "brain": Path(str(self.docker_state) + ".saleads-brain").is_file()
                     and Path(str(self.docker_state) + ".saleads-brain").read_text().strip() == "true",
            "dispatcher": Path(str(self.docker_state) + ".cron").is_file()
                          and "saleads:memory-reconcile" in Path(str(self.docker_state) + ".cron").read_text(),
            "registry": (self.data / "saleads/continuous/trusted-contexts.json").is_file(),
            "ready_probe": bool(self.ready_calls) and self.ready_calls[-1]["authenticated"] and self.ready_calls[-1]["ready"],
        }

    def accepted_run_awaiting_terminal_copy(self) -> tuple[str, str]:
        """A real SQLite row and private pre journal, before the gateway restarts."""
        run_id = "run_" + "e" * 32
        turn_id = "33333333-3333-4333-8333-333333333333"
        old = time.time() - 90000
        native = self.data / "runs_idempotency.db"
        status = {"object": "hermes.run", "run_id": run_id, "session_id": "fixture-session", "status": "running"}
        with closing(sqlite3.connect(native)) as db, db:
            db.execute("CREATE TABLE run_idempotency(scope TEXT,idempotency_key TEXT,fingerprint TEXT,run_id TEXT,"
                       "status_json TEXT,created_at REAL,updated_at REAL)")
            db.execute("INSERT INTO run_idempotency VALUES(?,?,?,?,?,?,?)",
                ("c" * 64, "first-loop-" + turn_id, "f" * 64, run_id, json.dumps(status), old, old))
        spec = importlib.util.spec_from_file_location("watcher_run_receipt_fixture", ASSETS / "saleads-continuity/run_receipts.py")
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        captured = module.capture(registry()["contexts"][0], "Synthetic API input.",
            root=self.data / "saleads/continuous", home=self.data, run_id_provider=lambda: run_id, clock=lambda: old + 1)
        if not captured:
            raise AssertionError("Receipt fixture was not accepted")
        status["status"] = "completed"
        with closing(sqlite3.connect(native)) as db, db:
            db.execute("UPDATE run_idempotency SET status_json=?,updated_at=?", (json.dumps(status), old + 100))
        return turn_id, run_id


class ContinuousWatcherHelpers(unittest.TestCase):
    def test_archive_is_complete_fixed_assets_with_legacy_backcompat(self) -> None:
        for names in (LEGACY_FILES, CONTINUITY_FILES, MANAGED_V9_FILES, MANAGED_V10_FILES, MANAGED_CATALOG_FILES, LANDING_MEMORY_FILES, MANAGED_FILES):
            with self.subTest(names=len(names)):
                result = helper("extensions", archive(names))
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                with tarfile.open(fileobj=io.BytesIO(result.stdout)) as tar:
                    self.assertEqual(set(tar.getnames()), set(names))
                    self.assertTrue(all(member.mode == 0o600 for member in tar.getmembers()))

    def test_incomplete_extra_duplicate_and_escape_members_are_rejected(self) -> None:
        before_generation_frames = tuple(name for name in MANAGED_FILES if not name.endswith(("/turn_frames.py", "/goal_delivery.py")))
        for blob in (archive(MANAGED_FILES[:-1]), archive(MANAGED_FILES, "runtime/unmanaged.py"),
                     archive(MANAGED_FILES, "../escape.py"), archive(MANAGED_FILES, MANAGED_FILES[0]),
                     archive(before_generation_frames)):
            self.assertNotEqual(helper("extensions", blob).returncode, 0)

    def test_hmac_helper_refuses_unknown_roles_and_preserves_personal_config(self) -> None:
        self.assertNotEqual(helper("memory-token", b"a" * 64, "unrelated-personal-profile").returncode, 0)
        config = {"agent": {"disabled_toolsets": ["voice"]}, "plugins": {"enabled": ["owner-plugin"]},
                  "memory": {"custom_owner_setting": True}, "platforms": {"telegram": {"home_channel": "fixture-home"}},
                  "mcp_servers": {"owner-mcp": {"url": "https://fixture.invalid/owner"}, "saleads-brain": {"tools": {"include": ["brain_ingest"]}}}}
        result = helper("managed-memory-config", json.dumps(config).encode())
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        changed = json.loads(result.stdout)
        self.assertEqual(changed["platforms"], config["platforms"])
        self.assertEqual(changed["plugins"], config["plugins"])
        self.assertEqual(changed["mcp_servers"]["owner-mcp"], config["mcp_servers"]["owner-mcp"])
        self.assertEqual(changed["mcp_servers"]["saleads-brain"]["tools"], {"include": []})
        self.assertEqual(set(changed["agent"]["disabled_toolsets"]), {"voice", "memory", "session_search"})
        self.assertFalse(changed["memory"]["memory_enabled"])
        self.assertFalse(changed["memory"]["user_profile_enabled"])
        self.assertFalse(changed["auxiliary"]["background_review"]["enabled"])

    def test_generated_role_catalog_controls_per_role_authentication(self) -> None:
        catalog = (ASSETS / "saleads-continuity/role-catalog.json").read_bytes()
        resolved = helper("managed-roles", catalog)
        self.assertEqual(resolved.returncode, 0, resolved.stderr.decode())
        roles = resolved.stdout.decode()
        self.assertEqual(roles.split(), json.loads(catalog)["actor_roles"])
        self.assertIn("disenador_landings", roles.split())
        secret = b"synthetic-role-derivation-secret" + b"a" * 40
        for role in roles.split():
            token = helper("memory-token", secret, role, roles)
            self.assertEqual(token.returncode, 0, token.stderr.decode())
            self.assertTrue(hmac.compare_digest(token.stdout.decode(), hmac.new(secret, ("mcl-profile:" + role).encode(), hashlib.sha256).hexdigest()))
        self.assertNotEqual(helper("memory-token", secret, "unmanaged", roles).returncode, 0)
        self.assertNotEqual(helper("managed-roles", b"{invalid}").returncode, 0)
        legacy = helper("managed-roles", b"")
        self.assertEqual(legacy.returncode, 0)
        self.assertEqual(set(legacy.stdout.decode().split()), {"ale", *ROLES})


class ContinuousWatcherApply(unittest.TestCase):
    def fixture(self, **kwargs) -> WatcherFixture:
        fixture = WatcherFixture(**kwargs)
        self.addCleanup(fixture.close)
        return fixture

    def test_managed_designer_install_and_manual_upgrade_preserve_work_and_owner_skills(self) -> None:
        source = HERE.parent.parent / "distribution/saleads-sales-agent/1.5.13/profiles/disenador_landings"
        output = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(profile_archive())), mode="r:gz") as original, \
                tarfile.open(fileobj=output, mode="w:gz") as combined:
            for member in original.getmembers():
                combined.addfile(member, original.extractfile(member))
            members = {"SOUL.md": (source / "SOUL.md").read_bytes(),
                       "profile-config.yaml": json.dumps({"mcp_servers": {"saleads": {"tools": {"include": []}},
                         "saleads-brain": {"tools": {"include": []}}}, "platform_toolsets": {
                         "cli": ["file", "skills", "todo", "vision", "saleads_memory"]}}).encode()}
            members.update({str(path.relative_to(source)): path.read_bytes() for path in (source / "skills").rglob("*") if path.is_file()})
            for name, data in members.items():
                member = tarfile.TarInfo("profiles/disenador_landings/" + name)
                member.size = len(data)
                combined.addfile(member, io.BytesIO(data))
        root_skills = source.parents[1] / "skills"
        root_output = io.BytesIO()
        root_sources = {str(path.relative_to(root_skills)): path.read_bytes() for path in root_skills.rglob("*") if path.is_file()}
        with tarfile.open(fileobj=root_output, mode="w:gz") as root_archive:
            for name, data in root_sources.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                root_archive.addfile(member, io.BytesIO(data))
        for existing in (False, True):
            with self.subTest(existing_manual_profile=existing):
                fixture = self.fixture()
                fixture.configure()
                home = fixture.data / "profiles/disenador_landings"
                protected = {}
                if existing:
                    home.mkdir(parents=True)
                    (home / "profile.yaml").write_text("name: disenador_landings\n")
                    (home / "SOUL.md").write_bytes((source / "SOUL.md").read_bytes())
                    for relative in ("memories/owner.md", "sessions/native.json", "artifacts/index.html", "skills/personal/SKILL.md"):
                        target = home / relative
                        target.parent.mkdir(parents=True, exist_ok=True)
                        protected[target] = b"Existing owner content stays byte-for-byte."
                        target.write_bytes(protected[target])
                fixture.metadata("hermes-profiles", base64.b64encode(output.getvalue()))
                fixture.metadata("hermes-skills", base64.b64encode(root_output.getvalue()))
                for _ in range(2):
                    result = fixture.apply()
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    for relative, data in members.items():
                        if relative != "profile-config.yaml": self.assertEqual((home / relative).read_bytes(), data)
                    for target, data in protected.items(): self.assertEqual(target.read_bytes(), data)
                    for relative, data in root_sources.items(): self.assertEqual((fixture.data / "skills" / relative).read_bytes(), data)
                    for relative in ("cli/landing_cli.py", "cli/README.md", "build_metadata.py"):
                        target = fixture.data / "saleads/landing-pilot" / relative
                        self.assertEqual(target.read_bytes(), (ASSETS / "landing-pilot" / relative).read_bytes())
                        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                    config = json.loads((home / "config.yaml").read_text())
                    self.assertEqual(config["mcp_servers"]["saleads"]["tools"], {"include": []})
                    self.assertEqual(config["platform_toolsets"]["cli"], ["file", "skills", "todo", "vision", "saleads_memory"])
                    self.assertTrue((home / "plugin-data/saleads-memory/auth-token").is_file())
                    self.assertEqual(fixture.guest("watcher-version"), b"11")
                created = Path(str(fixture.docker_state) + ".profiles").read_text().splitlines()
                self.assertEqual(created.count("disenador_landings"), 0 if existing else 1)

    def test_manual_designer_receives_its_own_scoped_plugins_and_auth_without_default_installation(self) -> None:
        fixture = self.fixture()
        fixture.configure()
        role = "disenador_landings"
        home = fixture.data / "profiles" / role
        home.mkdir(parents=True)
        (home / "profile.yaml").write_text("name: disenador_landings\n")
        soul = "Manual landing coder; no bundled profile installation."
        (home / "SOUL.md").write_text(soul)
        configured = {"toolsets": {"cli": ["files", "skills", "saleads_memory"]},
                      "mcp_servers": {"saleads": {"tools": {"include": []}}}, "plugins": {"enabled": []}}
        (home / "config.yaml").write_text(json.dumps(configured))
        personal = fixture.data / "profiles" / "unmanaged"
        personal.mkdir()
        (personal / "profile.yaml").write_text("name: unmanaged\n")
        (personal / "config.yaml").write_text(json.dumps(configured))
        result = fixture.apply()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        config = json.loads((home / "config.yaml").read_text())
        self.assertTrue({"saleads-continuity", "saleads-memory"} <= set(config["plugins"]["enabled"]))
        self.assertEqual(config["mcp_servers"]["saleads"]["tools"], {"include": []})
        self.assertEqual(config["toolsets"], configured["toolsets"])
        self.assertFalse(config["memory"]["memory_enabled"])
        self.assertTrue({"memory", "session_search"} <= set(config["agent"]["disabled_toolsets"]))
        self.assertEqual((home / "SOUL.md").read_text(), soul)
        self.assertEqual((home / "plugins/saleads-continuity/role-catalog.json").read_bytes(),
                         (ASSETS / "saleads-continuity/role-catalog.json").read_bytes())
        self.assertEqual((home / "plugins/saleads-memory/landing_experience.py").read_bytes(),
                         (ASSETS / "saleads-memory/landing_experience.py").read_bytes())
        root_token = hashlib.sha256(("saleads-brain-ale:" + API_KEY).encode()).hexdigest().encode()
        token = home / "plugin-data/saleads-memory/auth-token"
        expected = hmac.new(root_token, ("mcl-profile:" + role).encode(), hashlib.sha256).hexdigest()
        self.assertTrue(hmac.compare_digest(token.read_text(), expected))
        self.assertNotEqual(token.read_bytes(), (fixture.data / "profiles/estratega/plugin-data/saleads-memory/auth-token").read_bytes())
        collector = home / "plugin-data/saleads-memory/collector-token"
        self.assertTrue(hmac.compare_digest(collector.read_text(), hmac.new(root_token, b"mcl-collector", hashlib.sha256).hexdigest()))
        self.assertEqual(stat.S_IMODE(token.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(collector.stat().st_mode), 0o600)
        self.assertFalse((personal / "plugin-data").exists())
        self.assertFalse((personal / "plugins").exists())
        clean = self.fixture()
        clean.configure()
        self.assertEqual(clean.apply().returncode, 0)
        self.assertFalse((clean.data / "profiles" / role).exists())

    def test_upgrade_of_cached_v8_config_installs_scoped_plugins_and_preserves_owner_home(self) -> None:
        fixture = self.fixture()
        fixture.configure(extensions=False)
        # Existing v8 metadata/config cache, followed by an extension-only upgrade.
        fixture.request("/_ctl/del/hermes-continuous-contexts", b"")
        self.assertEqual(fixture.apply().returncode, 0)
        existing = json.loads((fixture.data / "config.yaml").read_text())
        personal = {"telegram": {"enabled": True, "home_channel": "fixture-owner-home"}}
        existing["platforms"] = personal
        existing.setdefault("mcp_servers", {})["owner-mcp"] = {"url": "https://fixture.invalid/personal"}
        (fixture.data / "config.yaml").write_text(json.dumps(existing))
        (fixture.state / "config-merge-version.sha").write_text("8")
        fixture.metadata("hermes-extensions", archive(MANAGED_FILES))
        fixture.metadata("hermes-profiles", profile_archive())
        fixture.metadata("hermes-continuous-contexts", json.dumps(registry(), indent=2))
        result = fixture.apply()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        root = json.loads((fixture.data / "config.yaml").read_text())
        self.assertEqual(root["platforms"]["telegram"], personal["telegram"])
        self.assertEqual(root["mcp_servers"]["owner-mcp"], {"url": "https://fixture.invalid/personal"})
        self.assertTrue({"saleads-continuity", "saleads-memory"} <= set(root["plugins"]["enabled"]))
        self.assertTrue(root["platforms"]["saleads_home"]["enabled"])
        self.assertEqual(root["model"]["provider"], "meta-ai")
        self.assertEqual(root["mcp_servers"]["saleads-brain"]["tools"], {"include": []})
        self.assertTrue({"memory", "session_search"} <= set(root["agent"]["disabled_toolsets"]))
        self.assertFalse(root["memory"]["memory_enabled"])
        self.assertFalse(root["memory"]["user_profile_enabled"])
        self.assertFalse(root["auxiliary"]["background_review"]["enabled"])
        for role in ROLES:
            home = fixture.data / "profiles" / role
            config = json.loads((home / "config.yaml").read_text())
            self.assertTrue({"saleads-continuity", "saleads-memory"} <= set(config["plugins"]["enabled"]))
            self.assertTrue({"memory", "session_search"} <= set(config["agent"]["disabled_toolsets"]))
            self.assertFalse(config["memory"]["memory_enabled"])
            self.assertFalse(config["memory"]["user_profile_enabled"])
            self.assertFalse(config["auxiliary"]["background_review"]["enabled"])
            self.assertEqual(config["mcp_servers"]["saleads-brain"]["tools"], {"include": []})
            if role == "curador":
                self.assertEqual(config["mcp_servers"]["saleads"]["tools"], {"include": []})
        self.assertTrue(fixture.ack_observations)
        self.assertTrue(all(all(observation.values()) for observation in fixture.ack_observations), fixture.ack_observations)
        self.assertEqual(fixture.guest("watcher-version"), b"11")
        self.assertEqual(fixture.apply().returncode, 0)

    def test_tokens_private_canary_json_and_brain_identity_are_installed_before_ack(self) -> None:
        fixture = self.fixture()
        fixture.configure()
        result = fixture.apply()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        root_token = hashlib.sha256(("saleads-brain-ale:" + API_KEY).encode()).hexdigest().encode()
        for role, home in (("ale", fixture.data), *((role, fixture.data / "profiles" / role) for role in ROLES)):
            directory = home / "plugin-data/saleads-memory"
            for filename, purpose in (("auth-token", "mcl-profile:" + role), ("collector-token", "mcl-collector")):
                path = directory / filename
                self.assertTrue(hmac.compare_digest(path.read_text(), hmac.new(root_token, purpose.encode(), hashlib.sha256).hexdigest()),
                                f"Private {filename} derivative mismatch for {role}; values withheld.")
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
        canary = fixture.data / "saleads/continuous/operator-canary-client-ids.json"
        self.assertEqual(json.loads(canary.read_text()), {"schema_version": "operator-canary-clients/1", "owner_id": OWNER, "client_message_ids": [CANARY]})
        self.assertEqual(stat.S_IMODE(canary.stat().st_mode), 0o600)
        env = (fixture.state / "brain.env").read_text()
        self.assertIn("BRAIN_OWNER_ID=" + OWNER + "\n", env)
        self.assertIn("BRAIN_MANAGED_CURATION=true\n", env)
        self.assertTrue(fixture.ack_observations)
        self.assertTrue(all(all(observation.values()) for observation in fixture.ack_observations), fixture.ack_observations)
        self.assertNotIn(API_KEY, result.stderr.decode())
        self.assertNotIn(root_token.decode(), result.stderr.decode())

    def test_run_receipt_module_is_fixed_private_and_copied_before_gateway_pruning(self) -> None:
        fixture = self.fixture()
        fixture.configure()
        fixture.docker_state.write_text("false")
        turn_id, run_id = fixture.accepted_run_awaiting_terminal_copy()
        result = fixture.apply()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        for home in (fixture.data, *(fixture.data / "profiles" / role for role in ROLES)):
            installed = home / "plugins/saleads-continuity/run_receipts.py"
            self.assertEqual(installed.read_bytes(), (ASSETS / "saleads-continuity/run_receipts.py").read_bytes())
            self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o600)
        observed = json.loads((fixture.path / "gateway-start-proof.json").read_text())
        self.assertTrue(observed["terminal_copied"])
        proof = json.loads((fixture.data / "saleads/continuous/run-receipts/accepted" / (turn_id + ".json")).read_text())
        self.assertEqual(proof["run_id"], run_id)
        self.assertTrue(proof["terminal_proven"])
        self.assertEqual(proof["native_status"], "completed")
        with closing(sqlite3.connect(fixture.data / "runs_idempotency.db")) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM run_idempotency").fetchone()[0], 0)
        self.assertEqual(fixture.guest("run-receipts-status"), b"refreshed")

    def test_offline_receipt_helper_uses_fixed_image_user_mount_and_no_network_or_env(self) -> None:
        fixture = self.fixture()
        fixture.configure()
        self.assertEqual(fixture.apply().returncode, 0)
        turn_id, _run_id = fixture.accepted_run_awaiting_terminal_copy()
        captured = fixture.path / "offline-helper-args.json"
        docker = fixture.path / "offline-receipt-docker"
        docker.write_text("#!/usr/bin/env python3\nimport json,os,sys,subprocess\na=sys.argv[1:]\n"
                          f"json.dump(a,open({str(captured)!r},'w'))\n"
                          "mount=a[a.index('-v')+1].rsplit(':/opt/data',1)[0]\n"
                          "script='/opt/data/plugins/saleads-continuity/run_receipts.py'.replace('/opt/data',mount)\n"
                          "sys.exit(subprocess.run([sys.executable,script,'--data-dir',mount]).returncode)\n")
        docker.chmod(0o700)
        stage = fixture.path / "offline-stage"
        stage.mkdir()
        (stage / "hermes-continuous-contexts").write_text(json.dumps(registry()))
        result = subprocess.run(["bash", "-c", 'source "$1"; refresh_native_run_receipts "$2"',
                                 "test", str(WATCHER), str(stage)],
                                env={**fixture.env, "HERMES_PY_CMD": "", "HERMES_DOCKER": str(docker)},
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        args = json.loads(captured.read_text())
        self.assertEqual(args[:2], ["run", "--rm"])
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertEqual(args[args.index("--user") + 1], fixture.env["HERMES_OWNER"])
        self.assertEqual(args[args.index("-v") + 1], str(fixture.data) + ":/opt/data")
        self.assertEqual(args[args.index("--entrypoint") + 1], "python3")
        self.assertIn("nousresearch/hermes-agent@sha256:55e192fba0cd4fde61142abbff5adeacff40efdb482ccd0ff877924bd274f909", args)
        self.assertNotIn("--env-file", args)
        self.assertNotIn("gateway", args)
        proof = json.loads((fixture.data / "saleads/continuous/run-receipts/accepted" / (turn_id + ".json")).read_text())
        self.assertTrue(proof["terminal_proven"])

    def test_receipt_refresh_failure_keeps_stopped_gateway_and_does_not_ack(self) -> None:
        fixture = self.fixture(failure="run_receipts")
        fixture.configure()
        fixture.docker_state.write_text("false")
        fixture.accepted_run_awaiting_terminal_copy()
        result = fixture.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(fixture.docker_state.read_text().strip(), "false")
        self.assertFalse((fixture.path / "gateway-start-proof.json").exists())
        self.assertIsNone(fixture.guest("continuous-context-hash"))
        self.assertEqual(fixture.guest("run-receipts-status"), b"refresh_failed")
        self.assertEqual(fixture.guest("apply-status"), b"error")

    def test_unrelated_custom_profile_is_unchanged(self) -> None:
        fixture = self.fixture()
        fixture.configure()
        personal = fixture.data / "profiles/owner-personal"
        personal.mkdir(parents=True)
        (personal / "profile.yaml").write_text("name: owner-personal\n")
        (personal / "config.yaml").write_text(json.dumps({"plugins": {"enabled": ["owner-plugin", "saleads-meta-search"]}, "memory": {"memory_enabled": True}, "platforms": {"telegram": {"home_channel": "personal-home"}}}))
        (personal / "MEMORY.md").write_text("Private personal context.")
        before = {str(path.relative_to(personal)): path.read_bytes() for path in personal.rglob("*") if path.is_file()}
        result = fixture.apply()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        after = {str(path.relative_to(personal)): path.read_bytes() for path in personal.rglob("*") if path.is_file()}
        self.assertEqual(set(after), set(before), "An unrelated personal profile gained or lost managed files.")
        for name in before:
            self.assertEqual(hashlib.sha256(after[name]).hexdigest(), hashlib.sha256(before[name]).hexdigest(),
                             f"Unrelated profile file changed: {name}")

    def test_classic_mode_does_not_enable_managed_brain_or_disable_owner_memory(self) -> None:
        fixture = self.fixture()
        fixture.configure(managed=False)
        result = fixture.apply()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        env = (fixture.state / "brain.env").read_text()
        self.assertNotIn("BRAIN_OWNER_ID=", env)
        self.assertNotIn("BRAIN_MANAGED_CURATION=", env)
        config = json.loads((fixture.data / "config.yaml").read_text())
        self.assertNotIn("memory", config.get("agent", {}).get("disabled_toolsets", []))
        self.assertFalse((fixture.data / "plugin-data/saleads-memory/auth-token").exists())
        self.assertFalse(fixture.ack_observations)

    def test_no_context_ack_when_a_required_installation_step_fails(self) -> None:
        for failure in ("auth", "brain", "dispatcher", "ready_old", "ready_unavailable", "ready_bad_shape"):
            with self.subTest(failure=failure):
                fixture = self.fixture(failure=failure)
                fixture.configure()
                result = fixture.apply()
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(fixture.guest("continuous-context-hash"))
                self.assertEqual(fixture.guest("apply-status"), b"error")
                self.assertFalse(fixture.ack_observations)

    def test_missing_brain_configuration_cannot_ack_a_managed_context_as_ready(self) -> None:
        fixture = self.fixture()
        fixture.configure(brain=False)
        result = fixture.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(fixture.guest("continuous-context-hash"))
        self.assertFalse(fixture.ack_observations)


if __name__ == "__main__":
    unittest.main()
