"""Link WhatsApp using the installed official Hermes bridge; preserve QR/status contracts and secrets."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from hermes_constants import find_node_executable, get_hermes_home, with_hermes_node_path

STATE = get_hermes_home() / "saleads" / "whatsapp-link"
EVENTS = STATE / "events.jsonl"
PID = STATE / "bridge.pid"


def session_path() -> Path:
    from hermes_cli.web_routers.messaging import _whatsapp_session_path

    return Path(_whatsapp_session_path())


def events() -> list[dict]:
    if not EVENTS.exists():
        return []
    out = []
    for line in EVENTS.read_text(errors="replace").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except ValueError:
                continue
    return out


def running() -> bool:
    try:
        os.kill(int(PID.read_text().strip()), 0)
        return True
    except (OSError, ValueError):
        return False


def linked() -> bool:
    return (session_path() / "creds.json").exists()


def start() -> None:
    from gateway.platforms.whatsapp_common import resolve_whatsapp_bridge_dir
    from hermes_cli.web_routers.messaging import _ensure_whatsapp_bridge_dependencies

    if linked():
        print("Already linked. Run finish to activate.")
        return
    if running():
        print("Pairing is already running. Request the QR with qr.")
        return
    STATE.mkdir(parents=True, exist_ok=True)
    bridge_dir = resolve_whatsapp_bridge_dir()
    _ensure_whatsapp_bridge_dependencies(bridge_dir)
    node = find_node_executable("node")
    if not node:
        print("ERROR: Node.js is unavailable for the WhatsApp bridge.")
        sys.exit(1)
    path = session_path()
    path.mkdir(parents=True, exist_ok=True)
    env = with_hermes_node_path()
    env["WHATSAPP_MODE"] = "self-chat"
    env["WHATSAPP_DM_POLICY"] = "pairing"
    EVENTS.write_text("")
    with EVENTS.open("a") as out:
        proc = subprocess.Popen(
            [node, str(bridge_dir / "bridge.js"), "--pair-only", "--pair-json", "--session", str(path)],
            cwd=str(bridge_dir), stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            start_new_session=True, env=env,
        )
    PID.write_text(str(proc.pid))
    for _ in range(40):  # el primer QR llega en pocos segundos
        time.sleep(0.5)
        if any(e.get("event") in ("qr", "connected", "error") for e in events()):
            break
    print("Pairing started. Request qr when the owner camera is ready.")


def qr() -> None:
    evs = events()
    if linked() or any(e.get("event") == "connected" for e in evs):
        print("CONECTADO: the phone is linked. Run finish.")
        return
    errors = [e for e in evs if e.get("event") == "error"]
    if errors and not running():
        print(f"ERROR: {errors[-1].get('error')}. Corre `start` de nuevo.")
        return
    codes = [e.get("qr") for e in evs if e.get("event") == "qr" and e.get("qr")]
    if not codes:
        print("No QR yet. Wait briefly and request it again, or run start.")
        return
    print("Reproduce this exact block in your response to the owner without altering it:")
    print(f"```whatsapp-qr\n{codes[-1]}\n```")


def finish() -> None:
    from hermes_cli.config import save_env_value
    from hermes_cli.web_routers.messaging import _whatsapp_linked_account_from_session, _write_platform_enabled

    if not linked():
        print("Not linked yet: the owner has not scanned the QR.")
        return
    _account_id, name, phone = _whatsapp_linked_account_from_session(session_path())
    save_env_value("WHATSAPP_MODE", "self-chat")
    save_env_value("WHATSAPP_DM_POLICY", "pairing")
    if phone:
        save_env_value("WHATSAPP_ALLOWED_USERS", phone)
    save_env_value("WHATSAPP_ENABLED", "true")
    _write_platform_enabled("whatsapp", True)
    if running():
        try:
            os.killpg(int(PID.read_text().strip()), 15)
        except (OSError, ValueError):
            pass
    print(f"ACTIVADO{f' para {name}' if name else ''}. Hermes toma WhatsApp en caliente: el dueño te escribe en su chat "
          "«Tú» (mensajes a sí mismo).")


def status() -> None:
    print(json.dumps({"vinculado": linked(), "emparejando": running(),
                      "activo": os.getenv("WHATSAPP_ENABLED", "") == "true"}, ensure_ascii=False))


if __name__ == "__main__":
    {"start": start, "qr": qr, "finish": finish, "status": status}.get(sys.argv[1] if len(sys.argv) > 1 else "status", status)()
