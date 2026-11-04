"""Disposable compatibility probe against an official Hermes checkout/image.

Only synthetic data and a loopback fake provider are used. This proves native
mechanisms, not Meta inference, deployed plugin installation, or business work.
The two upstream test helpers are supplied from the exact pinned checkout.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time


PLUGIN = '''import dataclasses, json, os
from pathlib import Path
def register(ctx):
    def record(event, **kw):
        ident = ctx.current_cron_execution()
        row = {"event": event, "session_id": kw.get("session_id"),
               "tenant": os.environ.get("HERMES_TENANT"),
               "task": os.environ.get("HERMES_KANBAN_TASK"),
               "run": os.environ.get("HERMES_KANBAN_RUN_ID"),
               "cron": dataclasses.asdict(ident) if ident else None}
        with (Path(os.environ["HERMES_HOME"]) / "native-probe.jsonl").open("a") as f:
            f.write(json.dumps(row) + "\\n")
    def pre(**kw):
        record("pre", **kw)
        return {"context": "MCL_SYNTHETIC_CONTEXT business=synthetic-business"}
    ctx.register_hook("pre_llm_call", pre)
    ctx.register_hook("post_llm_call", lambda **kw: record("post", **kw))
    ctx.register_hook("kanban_task_completed", lambda **kw: record("completed", **kw))
'''


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def install_plugin(home: Path):
    directory = home / "plugins" / "mcl-native-probe"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "plugin.yaml").write_text("name: mcl-native-probe\nversion: 0.0.1\n")
    (directory / "__init__.py").write_text(PLUGIN)


def rows(home: Path):
    path = home / "native-probe.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def clean_env(home: Path, checkout: Path):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("HERMES_", "_HERMES_"))
           and not k.endswith(("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_CREDENTIALS"))}
    env.update(HERMES_HOME=str(home), PYTHONPATH=str(checkout), NO_COLOR="1", TERM="dumb")
    return env


def child(args):
    from hermes_cli.plugins import get_plugin_manager
    get_plugin_manager().discover_and_load()
    if args.child == "api":
        # Actual API agent factory, actual AIAgent loop, loopback provider.
        from gateway.config import PlatformConfig
        from gateway.platforms.api_server import APIServerAdapter
        adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
        agent = adapter._create_agent(session_id="mcl-synthetic-api")
        try:
            result = agent.run_conversation("Synthetic compatibility probe only.")
            assert result.get("completed"), result
        finally:
            agent.close()
        print(json.dumps({"api_agent_completed": True}))
    elif args.child == "cron":
        from cron import scheduler
        from cron.executions import list_executions
        from hermes_cli.plugins import get_plugin_manager
        scheduler.tick(verbose=False, sync=True)
        executions = list_executions(job_id="mcl-synthetic-cron")
        assert len(executions) == 1, executions
        print(json.dumps({"executions": executions}, default=str))
    elif args.child == "no-agent":
        from cron.jobs import get_job, list_jobs
        from cron.scheduler import run_job
        job = next(j for j in list_jobs(include_disabled=True) if j.get("name") == "mcl-no-agent")
        ok, document, response, error = run_job(job)
        assert ok and not error and response.strip() in ("", "[SILENT]"), (ok, response, error)
        print(json.dumps({"no_agent": get_job(job["id"])["no_agent"], "empty_stdout": True}))


def main(args):
    fake = load("mcl_fake_provider", Path(args.helpers) / "fake_llm_provider.py")
    board_module = load("mcl_board_helpers", Path(args.helpers) / "tests/e2e/core/kanban/_helpers.py")
    board_module.REPO = Path(args.checkout).resolve()
    results = {"mechanism_only": True, "real_inference": False, "checks": {}}
    def mark(check):
        results["checks"][check] = "PASS"
        print(json.dumps({"mechanism_check": check, "status": "PASS"}), flush=True)
    checkout = Path(args.checkout).resolve()
    with tempfile.TemporaryDirectory(prefix="mcl-native-") as directory:
        root = Path(directory)
        if not args.only_kanban:
            with fake.FakeLLMServer(default_text="Synthetic compatibility answer.") as server:
                home = fake.write_hermes_home(root / "api-home", server.base_url,
                    extra_config="plugins:\n  enabled: [mcl-native-probe]\nupdates:\n  check: false\n")
                install_plugin(home)
                env = clean_env(home, checkout)
                proc = subprocess.run([sys.executable, __file__, "--checkout", str(checkout), "--child", "api"],
                    env=env, capture_output=True, text=True, timeout=180)
                assert proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-3000:]
                captured = rows(home)
                assert {"pre", "post"}.issubset({r["event"] for r in captured}), captured
                assert "MCL_SYNTHETIC_CONTEXT" in str(server.requests), "context never reached provider"
                mark("api_factory_pre_post_and_wire_context")

                cron_home = fake.write_hermes_home(root / "cron-home", server.base_url,
                    extra_config="plugins:\n  enabled: [mcl-native-probe]\nupdates:\n  check: false\n")
                install_plugin(cron_home)
                (cron_home / "cron").mkdir()
                (cron_home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [{
                    "id": "mcl-synthetic-cron", "name": "Synthetic cron compatibility", "prompt": "Synthetic probe.",
                    "schedule": {"kind": "interval", "minutes": 240}, "next_run_at": "2020-01-01T00:00:00+00:00",
                    "enabled": True, "state": "scheduled", "deliver": "local",
                    "repeat": {"times": 1, "completed": 0}}]}))
                proc = subprocess.run([sys.executable, __file__, "--checkout", str(checkout), "--child", "cron"],
                    env=clean_env(cron_home, checkout), capture_output=True, text=True, timeout=180)
                assert proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-3000:]
                captured = rows(cron_home)
                assert {"pre", "post"}.issubset({r["event"] for r in captured}), captured
                assert all(r["cron"] and r["cron"]["execution_id"] for r in captured), captured
                mark("cron_pre_post_execution_identity_and_terminal_ledger")

                scripts = home / "scripts"
                scripts.mkdir()
                (scripts / "mcl-empty.py").write_text("# Empty pending queue: intentionally no output or inference.\n")
                command = [sys.executable, "-m", "hermes_cli.main", "cron", "create", "every 3h", "--name",
                           "mcl-no-agent", "--script", "mcl-empty.py", "--no-agent", "--deliver", "local"]
                proc = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
                assert proc.returncode == 0, proc.stdout + proc.stderr
                before = len(server.requests)
                proc = subprocess.run([sys.executable, __file__, "--checkout", str(checkout), "--child", "no-agent"],
                    env=env, capture_output=True, text=True, timeout=90)
                assert proc.returncode == 0, proc.stdout + proc.stderr
                assert len(server.requests) == before, "empty script invoked provider"
                mark("native_cli_no_agent_empty_queue_zero_inference")

        release = threading.Event()
        def complete(rec):
            if rec["body"]["messages"][-1].get("role") == "tool":
                return fake.Text("Synthetic completion.")
            assert release.wait(120), "capacity probe not released"
            return fake.ToolCall("kanban_complete", {"summary": "Synthetic compatibility completion."})
        with fake.FakeLLMServer(complete) as server:
            board = board_module.Board(root / "board", server.base_url,
                extra_config="kanban:\n  max_in_progress: 2\nplugins:\n  enabled: [mcl-native-probe]\n")
            install_plugin(board.hermes_home)
            try:
                proc = subprocess.run([sys.executable, "-m", "hermes_cli.main", "profile", "create", "curador",
                    "--clone", "--no-alias"], env=board.env(), capture_output=True, text=True, timeout=90)
                assert proc.returncode == 0, proc.stdout + proc.stderr
                profile = board.hermes_home / "profiles" / "curador"
                install_plugin(profile)
                ids = []
                for index in range(3):
                    body = "Synthetic only: do not access external services or business data."
                    command = [sys.executable, "-m", "hermes_cli.main", "kanban", "create", f"Synthetic curator {index}",
                               "--body-file", "-", "--tenant", "synthetic-business", "--assignee", "curador",
                               "--idempotency-key", f"mcl-native-{index}", "--json"]
                    one = subprocess.run(command, input=body, env=board.env(), capture_output=True, text=True, timeout=60)
                    replay = subprocess.run(command, input=body, env=board.env(), capture_output=True, text=True, timeout=60)
                    assert one.returncode == replay.returncode == 0, one.stderr + replay.stderr
                    created, repeated = json.loads(one.stdout), json.loads(replay.stdout)
                    assert created["id"] == repeated["id"]
                    ids.append(created["id"])
                first = board.dispatch()
                assert len(first["spawned"]) == 2, first
                board_module.wait_until(lambda: len(server.main_requests()) >= 2, 100, "two real native workers")
                second = board.dispatch()
                assert not second["spawned"], second
                waiting = next(t for t in ids if board.task(t)["status"] == "ready")
                release.set()
                for tid in ids:
                    pid = board.task(tid)["worker_pid"]
                    if pid:
                        board.wait_worker_exit(tid, pid, timeout=100)
                third = board.dispatch()
                assert len(third["spawned"]) == 1 and third["spawned"][0]["task_id"] == waiting, third
                board.wait_worker_exit(waiting, board.task(waiting)["worker_pid"], timeout=100)
                for tid in ids:
                    assert board.task(tid)["status"] == "done", board.diag(tid)
                    assert len(board.runs(tid)) == 1, board.runs(tid)
                    assert board.cli_json("show", tid)["task"]["id"] == tid
                    assert len(json.loads(board.cli("runs", tid, "--json").stdout)) == 1
                    assert any(e["kind"] == "completed" for e in board.events(tid)), board.events(tid)
                captured = rows(profile)
                assert {"pre", "post", "completed"}.issubset({r["event"] for r in captured}), captured
                assert all(r["tenant"] == "synthetic-business" and r["task"] and r["run"] for r in captured), captured
                assert "MCL_SYNTHETIC_CONTEXT" in str(server.requests), "worker context absent from wire"
                mark("curator_profile_real_workers_hooks_tenant_run_and_journal")
                mark("cli_stdin_idempotency_same_board_capacity_two_restart_tick")
            finally:
                release.set()
                board.kill_workers()
    results["temporary_state_removed"] = not root.exists()
    print(json.dumps(results, sort_keys=True))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", default="/opt/hermes")
    parser.add_argument("--helpers", default="/workspace/upstream-helpers")
    parser.add_argument("--only-kanban", action="store_true")
    parser.add_argument("--child", choices=["api", "cron", "no-agent"])
    options = parser.parse_args()
    sys.path.insert(0, options.checkout)
    child(options) if options.child else main(options)
