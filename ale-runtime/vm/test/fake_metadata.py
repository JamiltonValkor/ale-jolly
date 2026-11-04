"""Fake GCE metadata server for the watcher tests (stdlib only, no Docker).

Serves instance/attributes/<key>, the recursive wait_for_change long poll
with ETag, guest-attributes PUT, and a fake signed-URL upload sink.
Test control: POST /_ctl/set/<key> (body = value), POST /_ctl/del/<key>,
GET /_ctl/guest/<key>, GET /_ctl/upload (last upload body),
GET /_ctl/upload-type, POST /_ctl/download (body served at /download/...),
POST /_ctl/download-code (HTTP status of /download/...), GET /_ctl/download-count.
"""
import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ATTR = "/computeMetadata/v1/instance/attributes/"
GUEST = "/computeMetadata/v1/instance/guest-attributes/hermes/"

attrs = {}
guest = {}
upload = {"body": b"", "type": ""}
download = {"body": b"", "code": 200, "count": 0}
uploads = []
cond = threading.Condition()


def etag():
    blob = json.dumps(attrs, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _flavor(self):
        if self.headers.get("Metadata-Flavor") != "Google":
            self._send(403, b"missing Metadata-Flavor")
            return False
        return True

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/_ctl/guest/"):
            k = u.path[len("/_ctl/guest/"):]
            return self._send(200, guest[k]) if k in guest else self._send(404)
        if u.path == "/_ctl/upload":
            return self._send(200, upload["body"])
        if u.path == "/_ctl/upload-type":
            return self._send(200, upload["type"].encode())
        if u.path == "/_ctl/upload-count":
            return self._send(200, str(len(uploads)).encode())
        if u.path == "/_ctl/download-count":
            return self._send(200, str(download["count"]).encode())
        if u.path.startswith("/download/"):
            download["count"] += 1
            if download["code"] != 200:
                return self._send(download["code"], b"error")
            return self._send(200, download["body"])
        if not self._flavor():
            return None
        if u.path == ATTR:
            q = parse_qs(u.query)
            with cond:
                if q.get("wait_for_change") == ["true"]:
                    last = q.get("last_etag", ["NONE"])[0]
                    timeout = float(q.get("timeout_sec", ["5"])[0])
                    cond.wait_for(lambda: etag() != last, timeout=timeout)
                body = json.dumps(attrs).encode()
                return self._send(200, body, {"ETag": etag()})
        if u.path.startswith(ATTR):
            k = u.path[len(ATTR):]
            with cond:
                if k in attrs:
                    return self._send(200, attrs[k])
            return self._send(404, b"not found")
        return self._send(404)

    def do_PUT(self):
        u = urlparse(self.path)
        if u.path.startswith("/upload/"):
            upload["body"] = self._body()
            upload["type"] = self.headers.get("Content-Type", "")
            uploads.append(u.path)
            return self._send(200)
        if not self._flavor():
            return None
        if u.path.startswith(GUEST):
            guest[u.path[len(GUEST):]] = self._body()
            return self._send(200)
        return self._send(404)

    def do_POST(self):
        u = urlparse(self.path)
        with cond:
            if u.path.startswith("/_ctl/set/"):
                attrs[u.path[len("/_ctl/set/"):]] = self._body()
            elif u.path == "/_ctl/download":
                download["body"] = self._body()
                return self._send(200)
            elif u.path == "/_ctl/download-code":
                download["code"] = int(self._body())
                return self._send(200)
            elif u.path.startswith("/_ctl/del/"):
                attrs.pop(u.path[len("/_ctl/del/"):], None)
            else:
                return self._send(404)
            cond.notify_all()
        return self._send(200)


def _as_text(v):
    return v.decode() if isinstance(v, bytes) else v


if __name__ == "__main__":
    json.JSONEncoder.default = lambda self, o: _as_text(o)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    sys.stdout.write(str(server.server_address[1]) + "\n")
    sys.stdout.flush()
    server.serve_forever()
