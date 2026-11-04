"""Prueba de humo con Docker real (no corre en `unittest` por defecto).

Levanta una red propia con Caddy (CA interna, `storage.googleapis.com`),
el espejo de registro y cloud-sim con el driver Docker, y recorre lo que hace
ale-runtime con una VM: crear con metadata hermes-* → ack del watcher y Hermes
sano → archivo por URL firmada → stop/start → delete → VM nueva con
restauración. Uso:

    python3 cloud-sim/tests/vm_smoke.py --startup-script <ale-runtime>/vm/startup-script.sh [--keep]
"""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NET = "cloud-sim-smoke"
PORT = 18070
PROJECT, ZONE = "ale-local", "local-sim1-a"
NAME = "sa-assistant-" + hashlib.sha256(b"smoke").hexdigest()[:32]
BUCKET = "ale-local-assistant-memories"
KEYS = ("hermes-api-key hermes-archive-url hermes-bundle-version hermes-config hermes-env hermes-mcp-tokens "
        "hermes-skills hermes-soul hermes-brain-image hermes-seed-url hermes-snapshot-url hermes-restore-url "
        "hermes-profiles hermes-extensions hermes-first-loop-url hermes-continuous-contexts hermes-continuous-url").split()
BEARER = {"Authorization": "Bearer smoke"}


def sh(*cmd, check=True, capture=True):
    result = subprocess.run(cmd, check=False, text=True, capture_output=capture)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])}… failed: {result.stderr.strip()[-400:]}")
    return (result.stdout or "").strip()


def call(method, path, body=None, raw=False):
    data = None if body is None else json.dumps(body).encode()
    headers = dict(BEARER, **({"Content-Type": "application/json"} if data else {}))
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = resp.read()
            return resp.status, payload if raw else json.loads(payload or b"{}")
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def zone(rest):
    return f"/compute/v1/projects/{PROJECT}/zones/{ZONE}{rest}"


def wait(what, fn, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(2)
    raise AssertionError(f"timeout waiting for {what}")


def wait_op(op):
    return wait(f"operation {op['name']}", lambda: (lambda o: o if o["status"] == "DONE" else None)(
        call("GET", zone(f"/operations/{op['name']}"))[1]), 180)


def guest(key):
    status, body = call("GET", zone(f"/instances/{NAME}/getGuestAttributes?variableKey=hermes/{key}"))
    return body["variableValue"] if status == 200 else None


def applied_version(items):
    values = {i["key"]: i["value"] for i in items}
    lines = "".join(f"{k} {hashlib.sha256(values[k].encode()).hexdigest()}\n" for k in KEYS if k in values)
    return hashlib.sha256(lines.encode()).hexdigest()


def signed(obj, method_headers):
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return (f"https://storage.googleapis.com/{BUCKET}/{obj}?X-Goog-Algorithm=GOOG4-RSA-SHA256"
            f"&X-Goog-Credential=sa%40ale-local.iam.gserviceaccount.com%2F{now[:8]}%2Fauto%2Fstorage%2Fgoog4_request"
            f"&X-Goog-Date={now}&X-Goog-Expires=3600&X-Goog-SignedHeaders={method_headers}&X-Goog-Signature={'ab' * 256}")


def set_metadata(values):
    _, inst = call("GET", zone(f"/instances/{NAME}"))
    items = [i for i in inst["metadata"]["items"] if i["key"] not in values] + [
        {"key": k, "value": v} for k, v in values.items()]
    status, op = call("POST", zone(f"/instances/{NAME}/setMetadata"),
                      {"fingerprint": inst["metadata"]["fingerprint"], "items": items})
    assert status == 200, op
    wait_op(op)
    return items


def hermes_healthy():
    """Como lo ve ale-runtime: otro contenedor de la red, a la IP de la VM y el puerto 8642."""
    _, inst = call("GET", zone(f"/instances/{NAME}"))
    ip = inst["networkInterfaces"][0].get("networkIP")
    out = sh("docker", "exec", "smoke-cloud-sim", "wget", "-qO-", "-T", "5", f"http://{ip}:8642/health", check=False)
    return '"status": "ok"' in out


TLS_PROBE = """
import urllib.request, urllib.error
try:
    urllib.request.urlopen("https://storage.googleapis.com/ale-local-assistant-memories/probe", timeout=10)
except urllib.error.HTTPError:
    pass
print("tls-ok")
"""


def hermes_trusts_local_ca():
    """Hermes (contenedor anidado) resuelve storage.googleapis.com y confía en la CA local."""
    out = sh("docker", "exec", f"vm-{NAME}", "docker", "exec", "hermes", "python3", "-c", TLS_PROBE, check=False)
    return out.endswith("tls-ok")


def up(startup_script, mirror):
    sh("docker", "network", "create", NET, check=False)
    caddyfile = os.path.join(tempfile.mkdtemp(), "Caddyfile")
    with open(caddyfile, "w") as fh:
        fh.write("storage.googleapis.com {\n\ttls internal\n\treverse_proxy cloud-sim:8070\n}\n")
    sh("docker", "run", "-d", "--name", "smoke-caddy", "--network", NET, "--network-alias", "storage.googleapis.com",
       "-v", f"{caddyfile}:/etc/caddy/Caddyfile:ro", "-v", "smoke-caddy-data:/data", "caddy:2.8.4-alpine")
    wait("caddy root CA", lambda: subprocess.run(
        ["docker", "exec", "smoke-caddy", "test", "-f", "/data/caddy/pki/authorities/local/root.crt"]).returncode == 0, 60)
    if mirror:
        sh("docker", "run", "-d", "--name", "smoke-registry", "--network", NET, "--network-alias", "cloud-sim-registry",
           "-e", "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io", "-v", "cloud-sim-registry:/var/lib/registry",
           "registry:2.8.3")
    sh("docker", "run", "-d", "--name", "smoke-cloud-sim", "--network", NET, "--network-alias", "cloud-sim",
       "-p", f"127.0.0.1:{PORT}:8070", "-v", "/var/run/docker.sock:/var/run/docker.sock",
       "-v", f"{os.path.abspath(startup_script)}:/template/startup-script.sh:ro",
       "-v", "smoke-caddy-data:/caddy:ro",
       "-e", "CLOUD_SIM_CA_FILE=/caddy/caddy/pki/authorities/local/root.crt",
       "-e", f"CLOUD_SIM_NETWORK={NET}", "-e", "CLOUD_SIM_DATA=/tmp/data",
       *(["-e", "CLOUD_SIM_REGISTRY_MIRROR=cloud-sim-registry:5000"] if mirror else []),
       "ale-jolly/cloud-sim:local")
    wait("cloud-sim", lambda: call("GET", "/healthz")[0] == 200 if _reachable() else None, 30)


def _reachable():
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{PORT}/healthz", timeout=2)
        return True
    except Exception:
        return False


def down():
    for c in ("smoke-cloud-sim", "smoke-caddy", "smoke-registry", f"vm-{NAME}"):
        sh("docker", "rm", "-f", c, check=False)
    for v in ("smoke-caddy-data", f"vm-{NAME}-docker", f"vm-{NAME}-hermes"):
        sh("docker", "volume", "rm", "-f", v, check=False)
    sh("docker", "network", "rm", NET, check=False)


def insert(items, request_id):
    query = f"?sourceInstanceTemplate=projects/{PROJECT}/global/instanceTemplates/t&requestId={request_id}"
    status, op = call("POST", zone(f"/instances{query}"), {"name": NAME, "metadata": {"items": items}})
    assert status == 200, op
    assert "error" not in wait_op(op), op


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--startup-script", required=True)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--no-mirror", action="store_true")
    args = parser.parse_args()
    t0 = time.time()
    down()
    try:
        up(args.startup_script, not args.no_mirror)
        _, template = call("GET", f"/compute/v1/projects/{PROJECT}/global/instanceTemplates/t")
        hermes = [{"key": "hermes-api-key", "value": "smoke-api-key-0123456789"},
                  {"key": "hermes-config", "value": "timezone: UTC\n"},
                  {"key": "hermes-env", "value": "SMOKE=1\n"},
                  {"key": "hermes-soul", "value": "# Smoke\n"}]
        items = template["properties"]["metadata"]["items"] + hermes
        insert(items, "aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa")
        print(f"[{time.time() - t0:5.0f}s] VM RUNNING", flush=True)
        expected = applied_version(items)
        wait("applied-version ack", lambda: guest("applied-version") == expected, 900)
        wait("Hermes /health", hermes_healthy, 300)
        assert hermes_trusts_local_ca(), "Hermes does not trust the local CA"
        print(f"[{time.time() - t0:5.0f}s] ack ok + Hermes healthy + local CA trusted", flush=True)

        sh("docker", "exec", f"vm-{NAME}", "sh", "-c",
           "mkdir -p /var/lib/hermes/data/memories && echo 'recuerdo de humo' > /var/lib/hermes/data/memories/MEMORY.md")
        obj = "u-smoke/20261104T120000Z.tgz"
        set_metadata({"hermes-archive-url": signed(obj, "content-type%3Bhost")})
        status = wait("archive-status", lambda: guest("archive-status"), 300)
        assert status.startswith("uploaded:"), status
        code, meta = call("GET", f"/storage/v1/b/{BUCKET}/o/{obj.replace('/', '%2F')}?fields=name,size")
        assert code == 200 and int(meta["size"]) > 0, meta
        print(f"[{time.time() - t0:5.0f}s] archive {status} size={meta['size']}", flush=True)

        wait_op(call("POST", zone(f"/instances/{NAME}/stop"))[1])
        assert call("GET", zone(f"/instances/{NAME}"))[1]["status"] == "TERMINATED"
        wait_op(call("POST", zone(f"/instances/{NAME}/start"))[1])
        assert call("GET", zone(f"/instances/{NAME}"))[1]["status"] == "RUNNING"
        wait("Hermes /health after start", hermes_healthy, 300)
        print(f"[{time.time() - t0:5.0f}s] stop/start ok", flush=True)

        wait_op(call("DELETE", zone(f"/instances/{NAME}"))[1])
        assert call("GET", zone(f"/instances/{NAME}"))[0] == 404
        items = template["properties"]["metadata"]["items"] + hermes + [
            {"key": "hermes-restore-url", "value": signed(obj, "host")}]
        insert(items, "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb")
        status = wait("restore-status", lambda: guest("restore-status"), 900)
        assert status.startswith("restored:"), status
        wait("applied-version ack (restored VM)", lambda: guest("applied-version") == applied_version(items), 300)
        restored = sh("docker", "exec", f"vm-{NAME}", "cat", "/var/lib/hermes/data/memories/MEMORY.md")
        assert restored == "recuerdo de humo", restored
        print(f"[{time.time() - t0:5.0f}s] delete + restore ok ({status})", flush=True)
        print("SMOKE OK")
    except Exception:
        subprocess.run(["docker", "logs", "--tail", "60", f"vm-{NAME}"])
        raise
    finally:
        if not args.keep:
            down()


if __name__ == "__main__":
    main()
