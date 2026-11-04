"""Cloud Storage en disco: JSON API (metadata, upload media, alt=media, list)
y URLs firmadas V4 path-style (`/<bucket>/<objeto>`), sin validar la firma.

Cada objeto vive en <root>/<bucket>/<nombre codificado> y su metadata en
<…>.meta.json. Los buckets existen en cuanto se usan.
"""
import base64
import hashlib
import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from urllib.parse import quote, unquote

BUCKET = re.compile(r"^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$")


class StorageError(Exception):
    def __init__(self, code, reason, message):
        super().__init__(message)
        self.code, self.reason, self.message = code, reason, message

    def body(self):
        return {"error": {"code": self.code, "message": self.message,
                          "errors": [{"domain": "global", "reason": self.reason, "message": self.message}]}}


class Storage:
    def __init__(self, root):
        self.root = root
        self.lock = threading.Lock()
        os.makedirs(root, exist_ok=True)

    def _paths(self, bucket, name):
        if not BUCKET.match(bucket or ""):
            raise StorageError(400, "invalid", "Invalid bucket name")
        if not name or len(name.encode()) > 1024 or "\n" in name or "\r" in name:
            raise StorageError(400, "invalid", "Invalid object name")
        base = os.path.join(self.root, bucket, quote(name, safe=""))
        return base, base + ".meta.json"

    def put(self, bucket, name, data, content_type):
        data_path, meta_path = self._paths(bucket, name)
        os.makedirs(os.path.dirname(data_path), exist_ok=True)
        generation = str(time.time_ns() // 1000)
        meta = {
            "kind": "storage#object", "bucket": bucket, "name": name,
            "id": f"{bucket}/{name}/{generation}", "generation": generation, "metageneration": "1",
            "contentType": content_type or "application/octet-stream", "size": str(len(data)),
            "md5Hash": base64.b64encode(hashlib.md5(data).digest()).decode(),
            "updated": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        meta["timeCreated"] = meta["updated"]
        with self.lock:
            tmp = data_path + ".tmp"
            with open(tmp, "wb") as fh:
                fh.write(data)
            os.replace(tmp, data_path)
            with open(meta_path + ".tmp", "w") as fh:
                json.dump(meta, fh)
            os.replace(meta_path + ".tmp", meta_path)
        return meta

    def meta(self, bucket, name):
        _, meta_path = self._paths(bucket, name)
        try:
            with open(meta_path) as fh:
                return json.load(fh)
        except FileNotFoundError:
            raise StorageError(404, "notFound", f"No such object: {bucket}/{name}") from None

    def read(self, bucket, name):
        meta = self.meta(bucket, name)
        data_path, _ = self._paths(bucket, name)
        with open(data_path, "rb") as fh:
            return meta, fh.read()

    def list(self, bucket, prefix="", page_token=None, max_results=1000):
        if not BUCKET.match(bucket or ""):
            raise StorageError(400, "invalid", "Invalid bucket name")
        folder = os.path.join(self.root, bucket)
        names = []
        if os.path.isdir(folder):
            for entry in os.listdir(folder):
                if entry.endswith(".meta.json"):
                    name = unquote(entry[: -len(".meta.json")])
                    if name.startswith(prefix):
                        names.append(name)
        names.sort()
        start = 0
        if page_token:
            after = base64.urlsafe_b64decode(page_token.encode()).decode()
            start = next((i for i, n in enumerate(names) if n > after), len(names))
        page = names[start:start + max_results]
        body = {"kind": "storage#objects", "items": [self.meta(bucket, n) for n in page]}
        if start + max_results < len(names):
            body["nextPageToken"] = base64.urlsafe_b64encode(page[-1].encode()).decode()
        if not body["items"]:
            del body["items"]  # GCS omite `items` cuando no hay objetos
        return body


def fields_filter(resource, fields):
    """Subconjunto mínimo del parámetro `fields`: solo listas planas
    (`name,size`); con paréntesis devuelve el recurso completo."""
    if not fields or "(" in fields:
        return resource
    wanted = {f.strip() for f in fields.split(",") if f.strip()}
    return {k: v for k, v in resource.items() if k in wanted}


def signed_url_expired(query, now=None):
    """True si la URL V4 ya venció (X-Goog-Date + X-Goog-Expires). No valida la firma."""
    try:
        start = datetime.strptime(query["X-Goog-Date"][0], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        expires = int(query["X-Goog-Expires"][0])
    except (KeyError, ValueError, IndexError):
        return True
    current = now or datetime.now(timezone.utc)
    return (current - start).total_seconds() > expires
