"""Estado de Compute Engine: instancias, operaciones zonales, metadata con
fingerprint y guest attributes. Las «VMs» las crea un driver (Docker o falso).

Semántica imitada de Compute v1 (la que usa ale-runtime):
- insert con requestId: repetir el mismo requestId devuelve la misma operación;
  otro requestId sobre un nombre existente da 409 `alreadyExists`.
- la instancia nace con la metadata enviada (REEMPLAZA la de la plantilla).
- setMetadata exige el fingerprint vigente: si no, 412 `conditionNotMet`.
- stop → STOPPING → TERMINATED; start → STAGING → RUNNING; delete → 404 después.
- los guest attributes los escribe la VM por el metadata server y se borran
  solo con la instancia.
"""
import base64
import json
import os
import re
import secrets
import threading
import time
from datetime import datetime, timezone

NAME = re.compile(r"^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$")


def now_rfc3339():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_fingerprint():
    return base64.b64encode(secrets.token_bytes(8)).decode()


def metadata_etag(items):
    import hashlib
    blob = json.dumps({i["key"]: i["value"] for i in items}, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


class ApiError(Exception):
    """Error con el cuerpo de Compute: {"error": {"code", "message", "errors": [{"reason"}]}}."""

    def __init__(self, code, reason, message):
        super().__init__(message)
        self.code, self.reason, self.message = code, reason, message

    def body(self):
        return {"error": {"code": self.code, "message": self.message,
                          "errors": [{"domain": "global", "reason": self.reason, "message": self.message}]}}


class Cloud:
    def __init__(self, driver, project, zone, template_items, state_file=None, op_delay=0.0):
        self.driver = driver
        self.project = project
        self.zone = zone
        self.template_items = template_items
        self.state_file = state_file
        self.op_delay = op_delay  # pausa entre transiciones, para que se vean estados intermedios
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.instances = {}   # name -> dict
        self.operations = {}  # op name -> dict
        self.requests = {}    # requestId -> op name
        self.busy = {}        # name -> threading.Lock (una operación de ciclo de vida a la vez)
        self._load()

    # ------------------------------------------------------------- estado
    def _load(self):
        if not self.state_file or not os.path.exists(self.state_file):
            return
        with open(self.state_file) as fh:
            data = json.load(fh)
        self.instances = data.get("instances", {})
        self.operations = data.get("operations", {})
        self.requests = data.get("requests", {})
        # Reconciliar con el driver: lo transitorio se resuelve con lo que hay de verdad.
        for name, inst in list(self.instances.items()):
            real = self.driver.status(name)
            if real is None:
                del self.instances[name]
            elif real == "running":
                inst["status"] = "RUNNING"
                inst["ip"] = self.driver.ip(name) or inst.get("ip")
            else:
                inst["status"] = "TERMINATED"
        for op in self.operations.values():
            if op["status"] != "DONE":
                op["status"] = "DONE"
                op["error"] = {"errors": [{"code": "INTERNAL_ERROR", "message": "cloud-sim restarted"}]}
        self._save()

    def _save(self):
        if not self.state_file:
            return
        # Solo las últimas 500 operaciones: GCE también las olvida.
        ops = dict(sorted(self.operations.items(), key=lambda kv: kv[1]["insertTime"])[-500:])
        self.operations = ops
        self.requests = {k: v for k, v in self.requests.items() if v in ops}
        tmp = self.state_file + ".tmp"
        with open(tmp, "w") as fh:
            json.dump({"instances": self.instances, "operations": ops, "requests": self.requests}, fh)
        os.replace(tmp, self.state_file)

    def _touch(self):
        self._save()
        self.changed.notify_all()

    # -------------------------------------------------------- recursos
    def zone_url(self):
        return f"https://www.googleapis.com/compute/v1/projects/{self.project}/zones/{self.zone}"

    def template(self, project, name):
        return {
            "kind": "compute#instanceTemplate",
            "id": "1000000000000000001",
            "name": name,
            "selfLink": f"https://www.googleapis.com/compute/v1/projects/{project}/global/instanceTemplates/{name}",
            "properties": {
                "machineType": "e2-standard-2",
                "metadata": {"kind": "compute#metadata", "items": list(self.template_items)},
                "networkInterfaces": [{"network": "global/networks/ale"}],
            },
        }

    def _instance(self, name):
        inst = self.instances.get(name)
        if inst is None:
            raise ApiError(404, "notFound", f"The resource 'projects/{self.project}/zones/{self.zone}/instances/{name}' was not found")
        return inst

    def instance_view(self, name):
        with self.lock:
            inst = self._instance(name)
            nic = {"kind": "compute#networkInterface", "name": "nic0", "network": "global/networks/ale"}
            if inst.get("ip"):
                nic["networkIP"] = inst["ip"]
            return {
                "kind": "compute#instance",
                "id": inst["id"],
                "creationTimestamp": inst["created"],
                "name": name,
                "zone": self.zone_url(),
                "machineType": f"{self.zone_url()}/machineTypes/e2-standard-2",
                "status": inst["status"],
                "networkInterfaces": [nic],
                "metadata": {"kind": "compute#metadata", "fingerprint": inst["fingerprint"],
                             "items": [dict(i) for i in inst["items"]]},
                "selfLink": f"{self.zone_url()}/instances/{name}",
            }

    # -------------------------------------------------------- operaciones
    def _new_op(self, kind, name, target_id, done=False):
        op_name = f"operation-{int(time.time() * 1000)}-{secrets.token_hex(6)}"
        op = {
            "kind": "compute#operation", "id": str(secrets.randbelow(10 ** 18) + 10 ** 18), "name": op_name,
            "zone": self.zone_url(), "operationType": kind,
            "targetLink": f"{self.zone_url()}/instances/{name}", "targetId": target_id,
            "status": "DONE" if done else "RUNNING", "progress": 100 if done else 0,
            "insertTime": now_rfc3339(), "startTime": now_rfc3339(),
            "selfLink": f"{self.zone_url()}/operations/{op_name}",
        }
        if done:
            op["endTime"] = now_rfc3339()
        self.operations[op_name] = op
        return op

    def _finish(self, op_name, error_code=None, message=""):
        with self.lock:
            op = self.operations[op_name]
            op.update(status="DONE", progress=100, endTime=now_rfc3339())
            if error_code:
                op["error"] = {"errors": [{"code": error_code, "message": message or error_code}]}
            self._touch()

    def operation(self, op_name):
        with self.lock:
            op = self.operations.get(op_name)
            if op is None:
                raise ApiError(404, "notFound", f"The resource 'operations/{op_name}' was not found")
            return dict(op)

    def _run(self, name, fn):
        """Corre `fn` en segundo plano, una operación de ciclo de vida por instancia a la vez."""
        with self.lock:
            gate = self.busy.setdefault(name, threading.Lock())

        def worker():
            with gate:
                fn()
        threading.Thread(target=worker, daemon=True).start()

    def _set_status(self, name, status, **extra):
        with self.lock:
            inst = self.instances.get(name)
            if inst is not None:
                inst["status"] = status
                inst.update(extra)
                self._touch()

    def _pause(self):
        if self.op_delay:
            time.sleep(self.op_delay)

    # -------------------------------------------------------- verbos
    def insert(self, name, items, request_id):
        if not isinstance(name, str) or not NAME.match(name):
            raise ApiError(400, "invalid", "Invalid value for field 'resource.name'")
        with self.lock:
            if request_id and request_id in self.requests:
                return dict(self.operations[self.requests[request_id]])
            if name in self.instances:
                raise ApiError(409, "alreadyExists",
                               f"The resource 'projects/{self.project}/zones/{self.zone}/instances/{name}' already exists")
            inst_id = str(secrets.randbelow(9 * 10 ** 18) + 10 ** 18)
            self.instances[name] = {
                "id": inst_id, "created": now_rfc3339(), "status": "PROVISIONING", "ip": None,
                "fingerprint": new_fingerprint(),
                "items": [{"key": i["key"], "value": i["value"]} for i in (items if items is not None else self.template_items)],
                "guest": {},
            }
            op = self._new_op("insert", name, inst_id)
            if request_id:
                self.requests[request_id] = op["name"]
            self._touch()

        def create():
            self._pause()
            self._set_status(name, "STAGING")
            try:
                ip = self.driver.create(name)
            except Exception as exc:  # la VM no nació: GCE deja la operación con error y sin instancia
                with self.lock:
                    self.instances.pop(name, None)
                self._finish(op["name"], "INTERNAL_ERROR", f"vm create failed: {type(exc).__name__}")
                return
            self._set_status(name, "RUNNING", ip=ip)
            self._finish(op["name"])
        self._run(name, create)
        return dict(op)

    def set_metadata(self, name, fingerprint, items):
        with self.lock:
            inst = self._instance(name)
            if fingerprint != inst["fingerprint"]:
                raise ApiError(412, "conditionNotMet",
                               "Supplied fingerprint does not match current metadata fingerprint.")
            clean = []
            for item in items or []:
                if not isinstance(item, dict) or not isinstance(item.get("key"), str):
                    raise ApiError(400, "invalid", "Invalid value for field 'resource.items'")
                clean.append({"key": item["key"], "value": str(item.get("value", ""))})
            inst["items"] = clean
            inst["fingerprint"] = new_fingerprint()
            op = self._new_op("setMetadata", name, inst["id"], done=True)
            self._touch()
            return dict(op)

    def stop(self, name):
        with self.lock:
            inst = self._instance(name)
            op = self._new_op("stop", name, inst["id"])
            self._touch()

        def run():
            with self.lock:
                status = self.instances.get(name, {}).get("status")
            if status not in (None, "TERMINATED"):
                self._set_status(name, "STOPPING")
                self._pause()
                try:
                    self.driver.stop(name)
                except Exception as exc:
                    self._finish(op["name"], "INTERNAL_ERROR", f"vm stop failed: {type(exc).__name__}")
                    return
                self._set_status(name, "TERMINATED")
            self._finish(op["name"])
        self._run(name, run)
        return dict(op)

    def start(self, name):
        with self.lock:
            inst = self._instance(name)
            op = self._new_op("start", name, inst["id"])
            self._touch()

        def run():
            with self.lock:
                status = self.instances.get(name, {}).get("status")
            if status == "TERMINATED":
                self._set_status(name, "STAGING")
                self._pause()
                try:
                    ip = self.driver.start(name)
                except Exception as exc:
                    self._set_status(name, "TERMINATED")
                    self._finish(op["name"], "INTERNAL_ERROR", f"vm start failed: {type(exc).__name__}")
                    return
                self._set_status(name, "RUNNING", ip=ip)
            self._finish(op["name"])
        self._run(name, run)
        return dict(op)

    def delete(self, name):
        with self.lock:
            inst = self._instance(name)
            op = self._new_op("delete", name, inst["id"])
            self._touch()

        def run():
            self._set_status(name, "STOPPING")
            self._pause()
            try:
                self.driver.delete(name)
            except Exception as exc:
                self._finish(op["name"], "INTERNAL_ERROR", f"vm delete failed: {type(exc).__name__}")
                return
            with self.lock:
                self.instances.pop(name, None)
                self._touch()
            self._finish(op["name"])
        self._run(name, run)
        return dict(op)

    # ----------------------------------------------------- guest attributes
    def guest_attributes(self, name, variable_key=None, query_path=None):
        with self.lock:
            inst = self._instance(name)
            guest = inst["guest"]
            if variable_key is not None:
                if variable_key not in guest:
                    raise ApiError(404, "notFound", f"The resource 'guestAttributes/{variable_key}' was not found")
                return {"kind": "compute#guestAttributes", "variableKey": variable_key,
                        "variableValue": guest[variable_key],
                        "selfLink": f"{self.zone_url()}/instances/{name}/getGuestAttributes"}
            prefix = (query_path or "").lstrip("/")
            items = []
            for full, value in sorted(guest.items()):
                if not full.startswith(prefix):
                    continue
                namespace, _, key = full.partition("/")
                items.append({"namespace": namespace, "key": key, "value": value})
            if not items:
                raise ApiError(404, "notFound", f"The resource 'guestAttributes/{prefix}' was not found")
            return {"kind": "compute#guestAttributes", "queryPath": query_path,
                    "queryValue": {"items": items},
                    "selfLink": f"{self.zone_url()}/instances/{name}/getGuestAttributes"}

    # ------------------------------------------------ lado de la VM (metadata)
    def vm_attributes(self, name):
        """(items como dict, etag) de una VM; None si la instancia no existe."""
        with self.lock:
            inst = self.instances.get(name)
            if inst is None:
                return None
            return {i["key"]: i["value"] for i in inst["items"]}, metadata_etag(inst["items"])

    def wait_attributes(self, name, last_etag, timeout):
        deadline = time.monotonic() + timeout
        with self.lock:
            while True:
                current = self.vm_attributes(name)
                if current is None or current[1] != last_etag:
                    return current
                left = deadline - time.monotonic()
                if left <= 0:
                    return current
                self.changed.wait(left)

    def put_guest(self, name, key, value):
        with self.lock:
            inst = self.instances.get(name)
            if inst is None:
                return False
            inst["guest"][key] = value
            self._touch()
            return True

    def vm_info(self, name):
        with self.lock:
            inst = self.instances.get(name)
            return None if inst is None else {"id": inst["id"], "ip": inst.get("ip")}
