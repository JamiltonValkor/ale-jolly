"""Servidor HTTP de cloud-sim (stdlib). Rutas:

- Compute v1 bajo `/compute/v1` (COMPUTE_API_BASE).
- Token del metadata server: `/token` y la ruta completa de GCE (GCP_METADATA_TOKEN_URL).
- IAM Credentials `…/projects/-/serviceAccounts/<email>:signBlob` (IAM_CREDENTIALS_API_BASE).
- GCS JSON API `/storage/v1/…` y `/upload/storage/v1/…` (STORAGE_API_BASE).
- URLs firmadas V4 `/<bucket>/<objeto>?X-Goog-…` (Caddy manda aquí `storage.googleapis.com`).
- Metadata de cada VM: `/vm/<instancia>/computeMetadata/v1/…` (HERMES_MD_URL de la VM),
  más `/vm/ca.crt` (la CA local para la VM) y `/healthz`.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from .compute import ApiError, Cloud
from .storage import Storage, StorageError, fields_filter, signed_url_expired

ZONE_PATH = re.compile(r"^/compute/v1/projects/([a-z][-a-z0-9]{4,28}[a-z0-9])/zones/([a-z0-9-]+)(/.*)$")
TEMPLATE_PATH = re.compile(r"^/compute/v1/projects/([^/]+)/global/instanceTemplates/([^/]+)$")
INSTANCE_PATH = re.compile(r"^/instances/([^/:]+)(?:/(setMetadata|stop|start|getGuestAttributes))?$")
SIGN_BLOB = re.compile(r"/projects/-/serviceAccounts/([^/:]+):signBlob$")
OBJECT_PATH = re.compile(r"^/storage/v1/b/([^/]+)/o/(.+)$")
LIST_PATH = re.compile(r"^/storage/v1/b/([^/]+)/o$")
UPLOAD_PATH = re.compile(r"^/upload/storage/v1/b/([^/]+)/o$")
VM_PATH = re.compile(r"^/vm/([a-z](?:[-a-z0-9]{0,61}[a-z0-9])?)/computeMetadata/v1/(.*)$")
TOKEN_PATHS = ("/token", "/computeMetadata/v1/instance/service-accounts/default/token")
GUEST_PREFIX = "instance/guest-attributes/"
ATTR_PREFIX = "instance/attributes/"
SIGNED_HOST = "storage.googleapis.com"


def log(message):
    sys.stderr.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} cloud-sim: {message}\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    cloud: Cloud = None
    storage: Storage = None
    ca_file = None

    def log_message(self, *args):  # sin cuerpos ni URLs firmadas en los logs
        pass

    # --------------------------------------------------------- utilidades
    def _send(self, code, body=b"", content_type="application/json; charset=UTF-8", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _json(self):
        raw = self._body()
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            raise ApiError(400, "parseError", "Parse Error") from None

    def _bearer(self):
        if not (self.headers.get("Authorization") or "").startswith("Bearer "):
            self._send(401, {"error": {"code": 401, "message": "Request is missing required authentication credential.",
                                       "status": "UNAUTHENTICATED",
                                       "errors": [{"reason": "required", "message": "Login Required."}]}})
            return False
        return True

    def _flavor(self):
        if self.headers.get("Metadata-Flavor") != "Google":
            self._send(403, "Missing Metadata-Flavor:Google header.", "text/plain")
            return False
        return True

    def _route(self):
        url = urlparse(self.path)
        return url.path, parse_qs(url.query, keep_blank_values=True)

    def _q(self, query, key, default=None):
        return query.get(key, [default])[0]

    # ----------------------------------------------------------- verbos
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        path, query = self._route()
        try:
            host = (self.headers.get("Host") or "").split(":")[0]
            if host == SIGNED_HOST or "X-Goog-Signature" in query:
                return self._signed(method, path, query)
            if path == "/healthz":
                return self._send(200, {"ok": True})
            if path == "/vm/ca.crt":
                return self._ca()
            if path in TOKEN_PATHS:
                return self._token()
            if path.startswith("/vm/"):
                return self._metadata(method, path, query)
            if path.startswith("/compute/v1/"):
                return self._bearer() and self._compute(method, path, query)
            if SIGN_BLOB.search(path):
                return self._bearer() and self._sign_blob(method, path)
            if path.startswith("/storage/v1/") or path.startswith("/upload/storage/v1/"):
                return self._bearer() and self._gcs(method, path, query)
            return self._send(404, {"error": {"code": 404, "message": "Not Found", "errors": [{"reason": "notFound"}]}})
        except (ApiError, StorageError) as exc:
            return self._send(exc.code, exc.body())
        except BrokenPipeError:
            return None

    # ------------------------------------------------------------ Compute
    def _compute(self, method, path, query):
        cloud = self.cloud
        match = TEMPLATE_PATH.match(path)
        if match and method == "GET":
            return self._send(200, cloud.template(match.group(1), match.group(2)))
        match = ZONE_PATH.match(path)
        if not match:
            raise ApiError(404, "notFound", "The requested URL was not found")
        _, zone, rest = match.groups()
        if zone != cloud.zone:
            raise ApiError(404, "notFound", f"The resource 'zones/{zone}' was not found")
        if rest == "/instances" and method == "POST":
            body = self._json()
            items = (body.get("metadata") or {}).get("items")
            op = cloud.insert(body.get("name"), items, self._q(query, "requestId"))
            log(f"insert instance={body.get('name')} op={op['name']}")
            return self._send(200, op)
        if rest.startswith("/operations/") and method == "GET":
            return self._send(200, cloud.operation(rest[len("/operations/"):]))
        match = INSTANCE_PATH.match(rest)
        if not match:
            raise ApiError(404, "notFound", "The requested URL was not found")
        name, verb = match.groups()
        if verb is None and method == "GET":
            return self._send(200, cloud.instance_view(name))
        if verb is None and method == "DELETE":
            log(f"delete instance={name}")
            return self._send(200, cloud.delete(name))
        if verb == "setMetadata" and method == "POST":
            body = self._json()
            return self._send(200, cloud.set_metadata(name, body.get("fingerprint"), body.get("items")))
        if verb in ("stop", "start") and method == "POST":
            self._body()
            log(f"{verb} instance={name}")
            return self._send(200, cloud.stop(name) if verb == "stop" else cloud.start(name))
        if verb == "getGuestAttributes" and method == "GET":
            return self._send(200, cloud.guest_attributes(
                name, self._q(query, "variableKey"), self._q(query, "queryPath")))
        raise ApiError(405, "methodNotAllowed", "Method not allowed")

    # --------------------------------------------- token, IAM y CA local
    def _token(self):
        if not self._flavor():
            return None
        return self._send(200, {"access_token": f"ya29.cloud-sim.{secrets.token_urlsafe(24)}",
                                "expires_in": 3599, "token_type": "Bearer"},
                          headers={"Metadata-Flavor": "Google"})

    def _sign_blob(self, method, path):
        if method != "POST":
            raise ApiError(405, "methodNotAllowed", "Method not allowed")
        payload = self._json().get("payload")
        try:
            blob = base64.b64decode(payload or "", validate=True)
        except ValueError:
            raise ApiError(400, "invalid", "Invalid value at 'payload'") from None
        # 256 bytes como una firma RSA-2048; determinista y sin llave (nadie la valida en local).
        digest = hashlib.sha256(blob).digest()
        signature = b"".join(hashlib.sha256(digest + bytes([i])).digest() for i in range(8))
        return self._send(200, {"keyId": "cloud-sim-local", "signedBlob": base64.b64encode(signature).decode()})

    def _ca(self):
        if not self.ca_file or not os.path.isfile(self.ca_file):
            return self._send(404, "no local CA configured", "text/plain")
        with open(self.ca_file, "rb") as fh:
            return self._send(200, fh.read(), "application/x-pem-file")

    # ---------------------------------------------------------------- GCS
    def _gcs(self, method, path, query):
        store = self.storage
        match = UPLOAD_PATH.match(path)
        if match and method == "POST":
            if self._q(query, "uploadType") != "media":
                raise StorageError(400, "invalid", "cloud-sim only supports uploadType=media")
            name = self._q(query, "name")
            meta = store.put(unquote(match.group(1)), name, self._body(), self.headers.get("Content-Type"))
            return self._send(200, meta)
        match = LIST_PATH.match(path)
        if match and method == "GET":
            body = store.list(unquote(match.group(1)), self._q(query, "prefix", ""), self._q(query, "pageToken"),
                              int(self._q(query, "maxResults", "1000")))
            return self._send(200, body)
        match = OBJECT_PATH.match(path)
        if match and method == "GET":
            bucket, name = unquote(match.group(1)), unquote(match.group(2))
            if self._q(query, "alt") == "media":
                meta, data = store.read(bucket, name)
                return self._send(200, data, meta["contentType"])
            return self._send(200, fields_filter(store.meta(bucket, name), self._q(query, "fields")))
        raise StorageError(404, "notFound", "Not Found")

    def _signed(self, method, path, query):
        """URL firmada V4 path-style: PUT sube, GET/HEAD baja. Vence, pero la firma no se valida."""
        bucket, _, name = path.lstrip("/").partition("/")
        bucket, name = unquote(bucket), unquote(name)
        if signed_url_expired(query):
            return self._send(400 if "X-Goog-Date" not in query else 403,
                              "<?xml version='1.0' encoding='UTF-8'?><Error><Code>ExpiredToken</Code></Error>",
                              "application/xml; charset=UTF-8")
        try:
            if method == "PUT":
                self.storage.put(bucket, name, self._body(), self.headers.get("Content-Type"))
                return self._send(200, b"", "text/html; charset=UTF-8")
            if method in ("GET", "HEAD"):
                meta, data = self.storage.read(bucket, name)
                return self._send(200, data, meta["contentType"])
        except StorageError as exc:
            code = "NoSuchKey" if exc.code == 404 else "InvalidArgument"
            return self._send(exc.code, f"<?xml version='1.0' encoding='UTF-8'?><Error><Code>{code}</Code></Error>",
                              "application/xml; charset=UTF-8")
        return self._send(405, "", "text/plain")

    # ------------------------------------------- metadata server de la VM
    def _metadata(self, method, path, query):
        match = VM_PATH.match(path)
        if not match:
            return self._send(404, "not found", "text/plain")
        if not self._flavor():
            return None
        name, rest = match.groups()
        flavor = {"Metadata-Flavor": "Google"}
        if method == "PUT" and rest.startswith(GUEST_PREFIX):
            key = rest[len(GUEST_PREFIX):]
            if not re.match(r"^[a-z0-9-]{1,63}/[a-z0-9-]{1,63}$", key):
                return self._send(400, "bad guest attribute key", "text/plain", flavor)
            value = self._body().decode("utf-8", "replace")
            if not self.cloud.put_guest(name, key, value):
                return self._send(404, "not found", "text/plain", flavor)
            return self._send(200, "", "text/plain", flavor)
        if method != "GET" and method != "HEAD":
            return self._send(405, "", "text/plain", flavor)
        if rest == ATTR_PREFIX or rest == ATTR_PREFIX.rstrip("/"):
            if self._q(query, "wait_for_change") == "true":
                timeout = min(float(self._q(query, "timeout_sec", "60")), 300.0)
                current = self.cloud.wait_attributes(name, self._q(query, "last_etag", "NONE"), timeout)
            else:
                current = self.cloud.vm_attributes(name)
            if current is None:
                return self._send(404, "not found", "text/plain", flavor)
            attrs, etag = current
            if self._q(query, "recursive") == "true" or self._q(query, "alt") == "json":
                return self._send(200, attrs, headers={**flavor, "ETag": etag})
            return self._send(200, "".join(f"{k}\n" for k in attrs), "application/text", {**flavor, "ETag": etag})
        if rest.startswith(ATTR_PREFIX):
            current = self.cloud.vm_attributes(name)
            key = rest[len(ATTR_PREFIX):]
            if current is None or key not in current[0]:
                return self._send(404, "not found", "text/html", flavor)
            return self._send(200, current[0][key], "application/text", {**flavor, "ETag": current[1]})
        info = self.cloud.vm_info(name)
        if info is None:
            return self._send(404, "not found", "text/plain", flavor)
        simple = {
            "instance/id": info["id"],
            "instance/name": name,
            "instance/hostname": f"{name}.{self.cloud.zone}.c.{self.cloud.project}.internal",
            "instance/zone": f"projects/0/zones/{self.cloud.zone}",
            "instance/network-interfaces/0/ip": info["ip"] or "",
            "project/project-id": self.cloud.project,
        }
        if rest in simple:
            return self._send(200, simple[rest], "application/text", flavor)
        if rest == "instance/service-accounts/default/token":
            return self._token()
        return self._send(404, "not found", "text/plain", flavor)


def build_server(cloud, storage, port, ca_file=None, host="0.0.0.0"):
    handler = type("BoundHandler", (Handler,), {"cloud": cloud, "storage": storage, "ca_file": ca_file})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server
