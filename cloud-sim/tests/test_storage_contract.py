"""Contrato GCS e IAM tal como lo usa ale-runtime (src/lifecycle/memory-archive.ts)
y el watcher de la VM (PUT/GET con URL firmada V4)."""
import base64
import unittest
from datetime import datetime, timezone
from urllib.parse import quote

from helpers import BEARER, Sim

BUCKET = "ale-local-assistant-memories"
OBJECT = "00000000-0000-4000-a000-000000000001/20261104T120000Z.tgz"
EMAIL = "sa-assistant-service@ale-local.iam.gserviceaccount.com"


def signed_path(obj=OBJECT, date=None, expires=900):
    date = date or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = "/" + BUCKET + "/" + "/".join(quote(p, safe="") for p in obj.split("/"))
    return (f"{path}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential={quote(EMAIL, safe='')}%2F{date[:8]}"
            f"%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date={date}&X-Goog-Expires={expires}"
            f"&X-Goog-SignedHeaders=content-type%3Bhost&X-Goog-Signature=" + "ab" * 256)


class StorageContract(unittest.TestCase):
    def setUp(self):
        self.sim = Sim()

    def tearDown(self):
        self.sim.close()

    def exists(self, obj=OBJECT):
        return self.sim.call("GET", f"/storage/v1/b/{BUCKET}/o/{quote(obj, safe='')}?fields=name,size")

    def test_sign_blob(self):
        status, body, _ = self.sim.call(
            "POST", f"/v1/projects/-/serviceAccounts/{quote(EMAIL, safe='')}:signBlob",
            {"payload": base64.b64encode(b"GOOG4-RSA-SHA256\n...").decode()})
        self.assertEqual(status, 200)
        self.assertEqual(len(base64.b64decode(body["signedBlob"])), 256)

    def test_signed_put_then_exists_then_signed_get(self):
        self.assertEqual(self.exists()[0], 404)
        status, _, _ = self.sim.call("PUT", signed_path(), b"\x1f\x8b-archive", headers={"Host": "storage.googleapis.com"},
                                     raw=True, content_type="application/gzip")
        self.assertEqual(status, 200)
        status, body, _ = self.exists()
        self.assertEqual(status, 200)
        self.assertEqual(body, {"name": OBJECT, "size": "10"})
        status, data, headers = self.sim.call("GET", signed_path().replace("content-type%3Bhost", "host"),
                                              headers={"Host": "storage.googleapis.com"}, raw=True)
        self.assertEqual((status, data, headers["Content-Type"]), (200, b"\x1f\x8b-archive", "application/gzip"))

    def test_signed_url_expires_and_missing_is_no_such_key(self):
        status, body, _ = self.sim.call("PUT", signed_path(date="20200101T000000Z"), b"x",
                                        headers={"Host": "storage.googleapis.com"}, raw=True, content_type="application/gzip")
        self.assertEqual(status, 403)
        self.assertIn(b"ExpiredToken", body)
        status, body, _ = self.sim.call("GET", signed_path(obj="nope/x.tgz"), headers={"Host": "storage.googleapis.com"}, raw=True)
        self.assertEqual(status, 404)
        self.assertIn(b"NoSuchKey", body)

    def test_upload_media_download_and_list(self):
        name = "stock/negocio/foto 1.jpg"
        status, meta, _ = self.sim.call(
            "POST", f"/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name={quote(name, safe='')}",
            b"jpegbytes", content_type="image/jpeg")
        self.assertEqual((status, meta["name"], meta["size"]), (200, name, "9"))
        status, data, headers = self.sim.call("GET", f"/storage/v1/b/{BUCKET}/o/{quote(name, safe='')}?alt=media", raw=True)
        self.assertEqual((status, data, headers["Content-Type"]), (200, b"jpegbytes", "image/jpeg"))
        for i in range(3):
            self.sim.call("POST", f"/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name=u%2F2026110{i}T000000Z.tgz",
                          b"z" * (i + 1), content_type="application/gzip")
        status, body, _ = self.sim.call("GET", f"/storage/v1/b/{BUCKET}/o?prefix=u%2F&fields=items(name%2Csize)%2CnextPageToken")
        self.assertEqual(status, 200)
        self.assertEqual([(i["name"], i["size"]) for i in body["items"]],
                         [("u/20261100T000000Z.tgz", "1"), ("u/20261101T000000Z.tgz", "2"), ("u/20261102T000000Z.tgz", "3")])
        _, page1, _ = self.sim.call("GET", f"/storage/v1/b/{BUCKET}/o?prefix=u%2F&maxResults=2")
        self.assertEqual(len(page1["items"]), 2)
        _, page2, _ = self.sim.call("GET", f"/storage/v1/b/{BUCKET}/o?prefix=u%2F&maxResults=2&pageToken={page1['nextPageToken']}")
        self.assertEqual([i["name"] for i in page2["items"]], ["u/20261102T000000Z.tgz"])
        self.assertNotIn("nextPageToken", page2)
        _, empty, _ = self.sim.call("GET", f"/storage/v1/b/{BUCKET}/o?prefix=nadie%2F")
        self.assertNotIn("items", empty)

    def test_json_api_requires_bearer(self):
        self.assertEqual(self.sim.call("GET", f"/storage/v1/b/{BUCKET}/o", headers={})[0], 401)


if __name__ == "__main__":
    unittest.main()
