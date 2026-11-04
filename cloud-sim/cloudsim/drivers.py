"""Drivers de «VM»: Docker (un contenedor docker:dind por instancia, decisión
D6 del plan) y uno falso en memoria para las pruebas del contrato."""
import http.client
import json
import socket
import time
from urllib.parse import quote


class FakeDriver:
    """VMs instantáneas con IPv4 10.77.0.x; para pruebas sin Docker."""

    def __init__(self):
        self.vms = {}
        self.next_ip = 10
        self.fail_create = False

    def create(self, name):
        if self.fail_create:
            raise RuntimeError("boom")
        self.next_ip += 1
        self.vms[name] = {"state": "running", "ip": f"10.77.0.{self.next_ip}"}
        return self.vms[name]["ip"]

    def start(self, name):
        self.vms[name]["state"] = "running"
        return self.vms[name]["ip"]

    def stop(self, name):
        self.vms[name]["state"] = "exited"

    def delete(self, name):
        self.vms.pop(name, None)

    def status(self, name):
        vm = self.vms.get(name)
        return None if vm is None else vm["state"]

    def ip(self, name):
        vm = self.vms.get(name)
        return None if vm is None else vm["ip"]


class _UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.unix_path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self.unix_path)
        self.sock = sock


class DockerError(Exception):
    pass


class DockerDriver:
    """Engine API por el socket de Docker. Cada VM es `vm-<instancia>`:
    privilegiada (dind), en la red `network`, con dos volúmenes que hacen de
    disco persistente (/var/lib/docker y /var/lib/hermes) mientras la
    instancia exista. Stop/start conservan los volúmenes; delete los borra."""

    LABEL = "ale-jolly.cloud-sim"

    def __init__(self, image, network, metadata_base, socket_path="/var/run/docker.sock", env=None):
        self.image = image
        self.network = network
        self.metadata_base = metadata_base.rstrip("/")
        self.socket_path = socket_path
        self.extra_env = env or {}

    def _call(self, method, path, body=None, timeout=60, ok=(200, 201, 204, 304)):
        conn = _UnixConnection(self.socket_path, timeout)
        try:
            headers = {"Content-Type": "application/json"} if body is not None else {}
            conn.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
            response = conn.getresponse()
            raw = response.read()
        finally:
            conn.close()
        if response.status not in ok:
            raise DockerError(f"{method} {path.split('?')[0]} -> {response.status} {raw[:200]!r}")
        return response.status, (json.loads(raw) if raw and raw[:1] in b"{[" else None)

    @staticmethod
    def container(name):
        return f"vm-{name}"

    def _volumes(self, name):
        return [(f"vm-{name}-docker", "/var/lib/docker"), (f"vm-{name}-hermes", "/var/lib/hermes")]

    def create(self, name):
        env = {
            "VM_NAME": name,
            "HERMES_MD_URL": f"{self.metadata_base}/vm/{name}/computeMetadata/v1",
            "HERMES_DOCKER_CRED": "true",
            **self.extra_env,
        }
        body = {
            "Image": self.image,
            "Hostname": name,
            "Env": [f"{k}={v}" for k, v in env.items()],
            "Labels": {self.LABEL: "vm", f"{self.LABEL}.instance": name},
            "HostConfig": {
                "Privileged": True,
                "RestartPolicy": {"Name": "unless-stopped"},
                "Mounts": [{"Type": "volume", "Source": src, "Target": dst,
                            "VolumeOptions": {"Labels": {self.LABEL: "disk", f"{self.LABEL}.instance": name}}}
                           for src, dst in self._volumes(name)],
                "NetworkMode": self.network,
            },
            "NetworkingConfig": {"EndpointsConfig": {self.network: {"Aliases": [name]}}},
        }
        self.delete(name)  # restos de una instancia anterior: una instancia nueva nace con disco nuevo
        self._call("POST", f"/containers/create?name={quote(self.container(name))}", body, ok=(201,))
        return self.start(name)

    def start(self, name):
        self._call("POST", f"/containers/{quote(self.container(name))}/start")
        for _ in range(50):
            ip = self.ip(name)
            if ip:
                return ip
            time.sleep(0.2)
        raise DockerError("vm without IPv4")

    def stop(self, name):
        # Tiempo para que el dockerd de la VM apague Hermes limpio.
        self._call("POST", f"/containers/{quote(self.container(name))}/stop?t=30", timeout=90)

    def delete(self, name):
        self._call("DELETE", f"/containers/{quote(self.container(name))}?force=true", timeout=90, ok=(204, 404))
        for volume, _ in self._volumes(name):
            self._call("DELETE", f"/volumes/{quote(volume)}?force=true", ok=(204, 404))

    def _inspect(self, name):
        try:
            return self._call("GET", f"/containers/{quote(self.container(name))}/json")[1]
        except DockerError as exc:
            if "-> 404" in str(exc):
                return None
            raise

    def status(self, name):
        info = self._inspect(name)
        if info is None:
            return None
        return "running" if info["State"]["Running"] else "exited"

    def ip(self, name):
        info = self._inspect(name)
        if not info or not info["State"]["Running"]:
            return None
        net = info["NetworkSettings"]["Networks"].get(self.network) or {}
        return net.get("IPAddress") or None
