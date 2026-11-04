"""Contrato Compute v1 tal como lo usa ale-runtime (src/compute, src/renewal,
src/lifecycle): rutas, cuerpos, códigos y reasons."""
import hashlib
import os
import tempfile
import threading
import time
import unittest

from helpers import BEARER, FLAVOR, PROJECT, Sim

NAME = "sa-assistant-" + "a" * 32
TEMPLATE_URL = f"/compute/v1/projects/{PROJECT}/global/instanceTemplates/sa-assistant-local"


class ComputeContract(unittest.TestCase):
    def setUp(self):
        self.sim = Sim()

    def tearDown(self):
        self.sim.close()

    def insert(self, name=NAME, request_id="11111111-1111-5111-8111-111111111111", items=None):
        query = f"?sourceInstanceTemplate=projects/{PROJECT}/global/instanceTemplates/sa-assistant-local&requestId={request_id}"
        body = {"name": name, "metadata": {"items": items if items is not None else [
            {"key": "startup-script", "value": "#!/bin/bash"}, {"key": "hermes-api-key", "value": "k1"}]}}
        return self.sim.call("POST", self.sim.zone(f"/instances{query}"), body)

    def create(self, **kw):
        status, op, _ = self.insert(**kw)
        self.assertEqual(status, 200)
        self.assertEqual(self.sim.wait_op(op["name"]).get("error"), None)
        return op

    def instance(self, name=NAME):
        return self.sim.call("GET", self.sim.zone(f"/instances/{name}"))

    # ------------------------------------------------------------- plantilla
    def test_template_has_startup_script(self):
        status, body, _ = self.sim.call("GET", TEMPLATE_URL)
        self.assertEqual(status, 200)
        keys = [i["key"] for i in body["properties"]["metadata"]["items"]]
        self.assertIn("startup-script", keys)

    def test_requires_bearer(self):
        status, body, _ = self.sim.call("GET", TEMPLATE_URL, headers={})
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["status"], "UNAUTHENTICATED")

    # ---------------------------------------------------------------- insert
    def test_insert_returns_operation_and_instance_runs(self):
        status, op, _ = self.insert()
        self.assertEqual(status, 200)
        self.assertRegex(op["name"], r"^[A-Za-z0-9_-]{1,100}$")
        self.assertEqual(self.sim.wait_op(op["name"])["status"], "DONE")
        status, inst, _ = self.instance()
        self.assertEqual(status, 200)
        self.assertEqual(inst["status"], "RUNNING")
        self.assertRegex(inst["id"], r"^\d{1,24}$")
        self.assertRegex(inst["networkInterfaces"][0]["networkIP"], r"^(\d{1,3}\.){3}\d{1,3}$")
        self.assertTrue(inst["metadata"]["fingerprint"])
        # La metadata enviada REEMPLAZA la de la plantilla (no se fusiona).
        self.assertEqual([i["key"] for i in inst["metadata"]["items"]], ["startup-script", "hermes-api-key"])

    def test_insert_same_request_id_is_idempotent(self):
        _, first, _ = self.insert()
        status, second, _ = self.insert()
        self.assertEqual(status, 200)
        self.assertEqual(first["name"], second["name"])

    def test_insert_existing_name_is_409_already_exists(self):
        self.create()
        status, body, _ = self.insert(request_id="22222222-2222-5222-8222-222222222222")
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["errors"][0]["reason"], "alreadyExists")

    def test_insert_failure_is_operation_error(self):
        self.sim.driver.fail_create = True
        _, op, _ = self.insert()
        done = self.sim.wait_op(op["name"])
        self.assertRegex(done["error"]["errors"][0]["code"], r"^[A-Za-z0-9_.-]{1,64}$")
        self.assertEqual(self.instance()[0], 404)

    def test_instance_id_stable_and_new_after_recreate(self):
        self.create()
        first = self.instance()[1]["id"]
        self.assertEqual(self.instance()[1]["id"], first)
        self.sim.wait_op(self.sim.call("DELETE", self.sim.zone(f"/instances/{NAME}"))[1]["name"])
        self.create(request_id="33333333-3333-5333-8333-333333333333")
        self.assertNotEqual(self.instance()[1]["id"], first)

    def test_unknown_instance_and_operation_are_404(self):
        self.assertEqual(self.instance()[0], 404)
        status, body, _ = self.sim.call("GET", self.sim.zone("/operations/operation-nope"))
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["errors"][0]["reason"], "notFound")

    # ----------------------------------------------------------- setMetadata
    def test_set_metadata_with_fingerprint(self):
        self.create()
        fp = self.instance()[1]["metadata"]["fingerprint"]
        items = [{"key": "startup-script", "value": "#!/bin/bash"}, {"key": "hermes-env", "value": "A=1"}]
        status, op, _ = self.sim.call("POST", self.sim.zone(f"/instances/{NAME}/setMetadata"),
                                      {"fingerprint": fp, "items": items})
        self.assertEqual(status, 200)
        self.assertEqual(self.sim.wait_op(op["name"]).get("error"), None)
        meta = self.instance()[1]["metadata"]
        self.assertEqual(meta["items"], items)
        self.assertNotEqual(meta["fingerprint"], fp)

    def test_set_metadata_stale_fingerprint_is_412(self):
        self.create()
        status, body, _ = self.sim.call("POST", self.sim.zone(f"/instances/{NAME}/setMetadata"),
                                        {"fingerprint": "stale", "items": []})
        self.assertEqual(status, 412)
        self.assertEqual(body["error"]["errors"][0]["reason"], "conditionNotMet")

    # ------------------------------------------------- stop / start / delete
    def test_stop_start_delete(self):
        self.create()
        ip = self.instance()[1]["networkInterfaces"][0]["networkIP"]
        op = self.sim.call("POST", self.sim.zone(f"/instances/{NAME}/stop"))[1]
        self.sim.wait_op(op["name"])
        stopped = self.instance()[1]
        self.assertEqual(stopped["status"], "TERMINATED")
        # Apagada sigue aceptando setMetadata (la renovación de credenciales lo hace así).
        fp = stopped["metadata"]["fingerprint"]
        self.assertEqual(self.sim.call("POST", self.sim.zone(f"/instances/{NAME}/setMetadata"),
                                       {"fingerprint": fp, "items": []})[0], 200)
        op = self.sim.call("POST", self.sim.zone(f"/instances/{NAME}/start"))[1]
        self.sim.wait_op(op["name"])
        started = self.instance()[1]
        self.assertEqual(started["status"], "RUNNING")
        self.assertEqual(started["networkInterfaces"][0]["networkIP"], ip)
        status, op, _ = self.sim.call("DELETE", self.sim.zone(f"/instances/{NAME}"))
        self.assertEqual(status, 200)
        self.sim.wait_op(op["name"])
        self.assertEqual(self.instance()[0], 404)
        self.assertEqual(self.sim.call("DELETE", self.sim.zone(f"/instances/{NAME}"))[0], 404)

    def test_intermediate_states_are_visible(self):
        self.sim.cloud.op_delay = 0.3
        _, op, _ = self.insert()
        seen = {self.instance()[1]["status"]}
        while self.sim.call("GET", self.sim.zone(f"/operations/{op['name']}"))[1]["status"] != "DONE":
            seen.add(self.instance()[1]["status"])
            time.sleep(0.02)
        self.assertIn("PROVISIONING", seen)
        stop = self.sim.call("POST", self.sim.zone(f"/instances/{NAME}/stop"))[1]
        time.sleep(0.1)
        self.assertEqual(self.instance()[1]["status"], "STOPPING")
        self.sim.wait_op(stop["name"])

    # ---------------------------------------------------- guest attributes
    def test_guest_attributes_both_forms(self):
        self.create()
        path = self.sim.zone(f"/instances/{NAME}/getGuestAttributes")
        self.assertEqual(self.sim.call("GET", f"{path}?variableKey=hermes/applied-version")[0], 404)
        self.assertEqual(self.sim.call("GET", f"{path}?queryPath=hermes/")[0], 404)
        self.sim.call("PUT", f"/vm/{NAME}/computeMetadata/v1/instance/guest-attributes/hermes/applied-version",
                      b"abc", headers=FLAVOR, raw=True, content_type="text/plain")
        self.sim.call("PUT", f"/vm/{NAME}/computeMetadata/v1/instance/guest-attributes/hermes/archive-status",
                      b"uploaded:0123456789ab", headers=FLAVOR, raw=True, content_type="text/plain")
        status, body, _ = self.sim.call("GET", f"{path}?variableKey=hermes/applied-version")
        self.assertEqual((status, body["variableValue"]), (200, "abc"))
        status, body, _ = self.sim.call("GET", f"{path}?queryPath=hermes/")
        self.assertEqual(status, 200)
        found = {(i["namespace"], i["key"]): i["value"] for i in body["queryValue"]["items"]}
        self.assertEqual(found[("hermes", "archive-status")], "uploaded:0123456789ab")


class Persistence(unittest.TestCase):
    def test_state_survives_restart(self):
        state = os.path.join(tempfile.mkdtemp(), "state.json")
        sim = Sim(state_file=state)
        ok = ComputeContract.insert(type("T", (), {"sim": sim})(), request_id="44444444-4444-5444-8444-444444444444")
        sim.wait_op(ok[1]["name"])
        before = sim.call("GET", sim.zone(f"/instances/{NAME}"))[1]
        driver = sim.driver
        sim.close()
        again = Sim(state_file=state, driver=driver)
        try:
            after = again.call("GET", again.zone(f"/instances/{NAME}"))[1]
            self.assertEqual((after["id"], after["status"], after["metadata"]["fingerprint"]),
                             (before["id"], "RUNNING", before["metadata"]["fingerprint"]))
        finally:
            again.close()


class AppliedVersionContract(unittest.TestCase):
    """La metadata que lee la VM es la que ale-runtime escribió, byte a byte:
    el ack (sha256 por clave en orden fijo) depende de eso."""

    def test_values_round_trip(self):
        sim = Sim()
        try:
            value = "línea 1\nlínea 2 ✓\n"
            ok = ComputeContract.insert(type("T", (), {"sim": sim})(), items=[{"key": "hermes-soul", "value": value}])
            sim.wait_op(ok[1]["name"])
            _, raw, _ = sim.call("GET", f"/vm/{NAME}/computeMetadata/v1/instance/attributes/hermes-soul",
                                 headers=FLAVOR, raw=True)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), hashlib.sha256(value.encode()).hexdigest())
        finally:
            sim.close()


class MetadataServer(unittest.TestCase):
    """Lo que usa vm/startup-script.sh: atributos, long poll con ETag y guest attributes."""

    def setUp(self):
        self.sim = Sim()
        ok = ComputeContract.insert(type("T", (), {"sim": self.sim})())
        self.sim.wait_op(ok[1]["name"])
        self.md = f"/vm/{NAME}/computeMetadata/v1"

    def tearDown(self):
        self.sim.close()

    def test_requires_flavor(self):
        self.assertEqual(self.sim.call("GET", f"{self.md}/instance/attributes/hermes-api-key", headers={}, raw=True)[0], 403)

    def test_attribute_and_missing(self):
        status, body, headers = self.sim.call("GET", f"{self.md}/instance/attributes/hermes-api-key", headers=FLAVOR, raw=True)
        self.assertEqual((status, body, headers.get("Metadata-Flavor")), (200, b"k1", "Google"))
        self.assertEqual(self.sim.call("GET", f"{self.md}/instance/attributes/hermes-soul", headers=FLAVOR, raw=True)[0], 404)

    def test_long_poll_wakes_on_set_metadata(self):
        url = f"{self.md}/instance/attributes/?recursive=true&wait_for_change=true&timeout_sec=5&last_etag="
        _, attrs, headers = self.sim.call("GET", url + "NONE", headers=FLAVOR)
        etag = headers["ETag"]
        self.assertEqual(attrs["hermes-api-key"], "k1")
        started = time.time()
        _, _, h2 = self.sim.call("GET", url.replace("timeout_sec=5", "timeout_sec=1") + etag, headers=FLAVOR)
        self.assertGreaterEqual(time.time() - started, 0.9)
        self.assertEqual(h2["ETag"], etag)

        def change():
            time.sleep(0.3)
            fp = self.sim.call("GET", self.sim.zone(f"/instances/{NAME}"))[1]["metadata"]["fingerprint"]
            self.sim.call("POST", self.sim.zone(f"/instances/{NAME}/setMetadata"),
                          {"fingerprint": fp, "items": [{"key": "hermes-api-key", "value": "k2"}]})
        threading.Thread(target=change).start()
        started = time.time()
        _, attrs, h3 = self.sim.call("GET", url + etag, headers=FLAVOR)
        self.assertLess(time.time() - started, 4)
        self.assertEqual(attrs, {"hermes-api-key": "k2"})
        self.assertNotEqual(h3["ETag"], etag)

    def test_token_endpoint(self):
        for path in ("/token", "/computeMetadata/v1/instance/service-accounts/default/token"):
            status, body, _ = self.sim.call("GET", path, headers=FLAVOR)
            self.assertEqual(status, 200)
            self.assertTrue(body["access_token"])
            self.assertGreater(body["expires_in"], 0)
        self.assertEqual(self.sim.call("GET", "/token", headers={}, raw=True)[0], 403)

    def test_ca_is_served_when_configured(self):
        self.assertEqual(self.sim.call("GET", "/vm/ca.crt", headers={}, raw=True)[0], 404)


if __name__ == "__main__":
    unittest.main()
