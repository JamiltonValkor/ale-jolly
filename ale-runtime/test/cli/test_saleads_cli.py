"""Pruebas del CLI de SaleADS (AAB-005). Solo stdlib: servidor HTTP falso y HERMES_HOME temporal.

python3 -I -m unittest discover -s test/cli -p 'test_*.py'
SALEADS_CLI_BUNDLE=1.4.0 corre las mismas pruebas sobre el script de 1.4.0 (por omisión, 1.5.10).
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUNDLE = os.environ.get("SALEADS_CLI_BUNDLE", "1.5.10")
ENGLISH_BUNDLES = ("1.5.11", "1.5.12", "1.5.13")
CLI = ROOT / f"distribution/saleads-sales-agent/{BUNDLE}/skills/saleads-cli/scripts/saleads.py"
BEFORE_1_5_10 = ("1.4.0", "1.5.0", "1.5.1", "1.5.2", "1.5.3", "1.5.4", "1.5.5", "1.5.6", "1.5.7", "1.5.8", "1.5.9")
TOKEN = "tok-SECRETO-1234567890" # gitleaks:allow -- synthetic test credential
BUSINESS = "11111111-2222-4333-8444-555555555555"
CATALOG = [
    {"name": "saleads_list_offerings", "title": "Ofertas", "summary": "Lista las ofertas.", "required_scope": "saleads:read", "async": False, "read_only": True},
    {"name": "saleads_agent_publish", "title": "Publicar", "summary": "Publica en pausa.", "required_scope": "saleads:campaigns", "async": True, "read_only": False},
    {"name": "saleads_list_campaigns", "title": "Campañas", "summary": "Lista campañas.", "required_scope": "saleads:read", "async": False, "read_only": True},
    {"name": "saleads_agent_bet_state", "title": "Estado apuesta", "summary": "Cambia el estado.", "required_scope": "saleads:strategy", "async": False, "read_only": False},
    {"name": "saleads_get_operation", "title": "Operación", "summary": "Estado de una operación.", "required_scope": "saleads:read", "async": False, "read_only": True},
    {"name": "saleads_get_help", "title": "Guía", "summary": "Guía.", "required_scope": "saleads:read", "async": False, "read_only": True},
    {"name": "saleads_get_campaign_health", "title": "Salud", "summary": "Salud de una campaña.", "required_scope": "saleads:read", "async": False, "read_only": True},
    {"name": "saleads_agent_quote_pieces", "title": "Cotizar", "summary": "Cotiza piezas.", "required_scope": "saleads:campaigns", "async": False, "read_only": False},
    {"name": "saleads_agent_generate_pieces", "title": "Generar", "summary": "Genera piezas.", "required_scope": "saleads:campaigns", "async": False, "read_only": False},
    {"name": "saleads_agent_register_bets", "title": "Apuestas", "summary": "Registra apuestas.", "required_scope": "saleads:campaigns", "async": False, "read_only": False},
]


class Fake(BaseHTTPRequestHandler):
    calls: list[dict] = []
    plan: dict[str, list[tuple[int, dict]]] = {}
    schemas: dict[str, list[str]] = {}
    responders: dict = {}

    def log_message(self, *_):  # noqa: D401
        return

    def _reply(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        Fake.calls.append({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"), "body": body,
                           "version": self.headers.get("x-saleads-cli-version")})
        queue = Fake.plan.get(self.path) if self.command == "POST" or self.path == "/agent/v1/commands" else None
        name = self.path.rsplit("/", 1)[-1]
        if self.command == "GET" and self.path.startswith("/agent/v1/commands/"):
            props = Fake.schemas.get(name)
            schema = props if isinstance(props, dict) else {"type": "object", "properties": {k: {} for k in props or []}}
            status, payload = (200, {"ok": True, "data": {"name": name, "input_schema": schema}}
                               ) if props is not None else (404, {"ok": False, "code": "MCP-E-UNKNOWN-COMMAND", "message": "no"})
        elif self.command == "POST" and self.path in Fake.responders:
            status, payload = Fake.responders[self.path](body)
        elif queue:
            status, payload = queue.pop(0) if len(queue) > 1 else queue[0]
        elif self.path == "/agent/v1/commands":
            status, payload = 200, {"ok": True, "data": {"commands": CATALOG}}
        else:
            status, payload = 404, {"ok": False, "code": "MCP-E-UNKNOWN-COMMAND", "message": "no", "retryable": False}
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    do_GET = _reply
    do_POST = _reply


class CliFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Fake.calls, Fake.plan, Fake.schemas, Fake.responders = [], {}, {}, {}
        self.home = tempfile.mkdtemp()
        os.makedirs(f"{self.home}/mcp-tokens")
        os.makedirs(f"{self.home}/skills/saleads-cli")
        Path(f"{self.home}/mcp-tokens/saleads.json").write_text(json.dumps({"access_token": TOKEN, "refresh_token": "r-SECRETO"}))
        Path(f"{self.home}/skills/saleads-cli/config.json").write_text(json.dumps({"url": self.url + "/ignorado", "client_id": "c"}))

    def run_cli(self, *args):
        env = {"HERMES_HOME": self.home, "PATH": os.environ.get("PATH", "")}
        proc = subprocess.run([sys.executable, "-I", str(CLI), *args], capture_output=True, text=True, env=env, timeout=60)
        out = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else None
        return proc.returncode, out, proc.stdout, proc.stderr

    def files_text(self):
        text = ""
        for path in Path(self.home).rglob("*"):
            if path.is_file() and "mcp-tokens" not in path.parts:
                text += path.read_text(errors="replace")
        return text


class CliTest(CliFixture):
    def test_token_never_printed_nor_cached(self):
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": True, "data": {"offerings": []}})]
        outputs = [self.run_cli("ayuda"), self.run_cli("ayuda", "ofertas"), self.run_cli("ofertas", "--campo", "business_id", BUSINESS),
                   self.run_cli("esquema", "ofertas"), self.run_cli("version"), self.run_cli("no-existe")]
        for _, _, stdout, stderr in outputs:
            self.assertNotIn(TOKEN, stdout + stderr)
            self.assertNotIn("r-SECRETO", stdout + stderr)
        self.assertNotIn(TOKEN, self.files_text())
        self.assertTrue(all(c["auth"] == "Bearer " + TOKEN for c in Fake.calls))

    def test_host_comes_from_the_service_config_and_there_is_no_url_flag(self):
        code, out, _, _ = self.run_cli("ayuda", "--url", "https://evil.example")
        self.assertEqual(code, 2)
        self.assertEqual(out["code"], "CLI-USAGE")
        self.assertEqual(Fake.calls, [])
        code, _, _, _ = self.run_cli("ayuda")
        self.assertEqual(code, 0)
        self.assertEqual(Fake.calls[0]["path"], "/agent/v1/commands")  # origen fijo, sin la ruta del config

    def test_read_is_retried_once_write_never(self):
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(502, {}), (200, {"ok": True, "data": {"offerings": [1]}})]
        code, out, _, _ = self.run_cli("ofertas", "--campo", "business_id", BUSINESS)
        self.assertEqual((code, out["ok"]), (0, True))
        self.assertEqual(sum(c["path"].endswith("saleads_list_offerings") and c["method"] == "POST" for c in Fake.calls), 2)
        Fake.plan["/agent/v1/commands/saleads_agent_publish"] = [(502, {}), (200, {"ok": True, "data": {}})]
        code, out, _, _ = self.run_cli("saleads_agent_publish", "--campo", "business_id", BUSINESS)
        self.assertEqual(code, 4)
        self.assertEqual(sum(c["path"].endswith("saleads_agent_publish") and c["method"] == "POST" for c in Fake.calls), 1)
        self.assertIn("--id", out["next_action"])

    @unittest.skipIf(BUNDLE == "1.4.0", "alias del agente desde 1.5.0 (AAB-023)")
    def test_two_word_alias_reaches_the_agent_command(self):
        Fake.plan["/agent/v1/commands/saleads_agent_register_bets"] = [(200, {"ok": True, "data": {"version_id": "v1"}})]
        code, out, _, _ = self.run_cli("apuestas", "registrar", "--campo", "business_id", BUSINESS)
        self.assertEqual((code, out["ok"]), (0, True))
        self.assertTrue(Fake.calls[-1]["path"].endswith("/saleads_agent_register_bets"))
        self.assertIn("client_request_id", Fake.calls[-1]["body"])
        code, out, _, _ = self.run_cli("ayuda")
        aliases = {c["name"]: c.get("alias") for c in out["data"]["commands"]}
        self.assertEqual(aliases["saleads_agent_register_bets"], "apuestas registrar")

    def test_writes_carry_a_client_request_id_and_reuse_it_with_id(self):
        Fake.plan["/agent/v1/commands/saleads_agent_publish"] = [(200, {"ok": True, "data": {"publication_id": "p1"}})]
        code, out, _, _ = self.run_cli("saleads_agent_publish", "--campo", "business_id", BUSINESS)
        self.assertEqual(code, 0)
        generated = out["client_request_id"]
        self.assertEqual(Fake.calls[-1]["body"]["client_request_id"], generated)
        self.run_cli("saleads_agent_publish", "--campo", "business_id", BUSINESS, "--id", generated)
        self.assertEqual(Fake.calls[-1]["body"]["client_request_id"], generated)
        reads = [c for c in Fake.calls if c["path"].endswith("saleads_list_offerings")]
        self.assertTrue(all("client_request_id" not in (c["body"] or {}) for c in reads))

    def test_foreign_business_exits_3_and_401_exits_5_without_touching_the_token(self):
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": False, "code": "MCP-E-BUSINESS-NOT-FOUND", "message": "No encontré ese negocio.", "next_action": "Usa cuenta.", "retryable": False})]
        code, out, _, _ = self.run_cli("ofertas", "--campo", "business_id", BUSINESS)
        self.assertEqual((code, out["code"], out["next_action"]), (3, "MCP-E-BUSINESS-NOT-FOUND", "Usa cuenta."))
        token_file = Path(f"{self.home}/mcp-tokens/saleads.json")
        before = (token_file.stat().st_mtime_ns, hashlib.sha256(token_file.read_bytes()).hexdigest())
        Fake.plan["/agent/v1/commands"] = [(401, {"error": "invalid_token"})]
        os.remove(f"{self.home}/cache/saleads-cli/commands.json")
        code, out, _, _ = self.run_cli("ofertas", "--campo", "business_id", BUSINESS)
        self.assertEqual((code, out["code"]), (5, "AUTH-EXPIRED"))
        self.assertEqual(before, (token_file.stat().st_mtime_ns, hashlib.sha256(token_file.read_bytes()).hexdigest()))

    def test_falls_back_to_saleads_cli_in_hermes_config_during_transition(self):
        os.remove(f"{self.home}/skills/saleads-cli/config.json")
        Path(f"{self.home}/config.yaml").write_text(json.dumps({"saleads_cli": {"url": self.url, "client_id": "c"}}))
        code, _, _, _ = self.run_cli("ayuda")
        self.assertEqual(code, 0)
        Path(f"{self.home}/config.yaml").write_text("no: es json")
        os.remove(f"{self.home}/cache/saleads-cli/commands.json")
        code, out, _, _ = self.run_cli("ayuda")
        self.assertEqual((code, out["code"]), (2, "CLI-CONFIG"))

    def test_compact_output_and_fields(self):
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": True, "data": {"offerings": list(range(30)), "note": "x" * 500, "next_action": "sigue"}})]
        code, out, _, _ = self.run_cli("ofertas", "--campo", "business_id", BUSINESS)
        self.assertEqual(code, 0)
        self.assertEqual(out["data"]["offerings"][-1], {"_mas": 10})
        self.assertLessEqual(len(out["data"]["note"]), 280)
        self.assertEqual(out["next"], "sigue")
        code, out, _, _ = self.run_cli("ofertas", "--campo", "business_id", BUSINESS, "--campos", "note", "--completo")
        self.assertEqual(list(out["data"].keys()), ["note"])
        self.assertEqual(len(out["data"]["note"]), 500)

    def test_upstream_errors_are_transient(self):
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": False, "code": "MCP-E-UPSTREAM-UNAVAILABLE", "message": "x", "retryable": False})]
        code, out, _, _ = self.run_cli("ofertas", "--campo", "business_id", BUSINESS)
        self.assertEqual((code, out["code"]), (4, "MCP-E-UPSTREAM-UNAVAILABLE"))

    def test_big_payloads_fit_the_budget_and_mark_what_was_cut(self):
        big = {"business": {"sections": [{"name": f"s{i}", "items": [{"k": "v" * 300, "deep": {"a": {"b": {"c": i}}}} for _ in range(30)]} for i in range(30)]}}
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": True, "data": big})]
        code, out, stdout, _ = self.run_cli("ofertas", "--campo", "business_id", BUSINESS)
        self.assertEqual(code, 0)
        self.assertLess(len(stdout), 7000)
        self.assertRegex(stdout, r'"_(mas|lista|campos)"')


if __name__ == "__main__":
    unittest.main()


@unittest.skipIf(BUNDLE in ("1.4.0", "1.5.0", "1.5.1"), "business_id según el esquema desde 1.5.2")
class BusinessFitTest(CliFixture):
    """1.5.2: 3 de cada 4 errores del laboratorio eran `business_id` que faltaba o sobraba."""

    def posted(self, name):
        return [c["body"] for c in Fake.calls if c["method"] == "POST" and c["path"].endswith("/" + name)]

    def test_remembers_the_business_and_fills_it_when_the_command_requires_it(self):
        Fake.schemas = {"saleads_list_offerings": ["business_id"], "saleads_agent_register_bets": ["business_id", "bets"]}
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": True, "data": {"offerings": []}})]
        Fake.plan["/agent/v1/commands/saleads_agent_register_bets"] = [(200, {"ok": True, "data": {}})]
        self.assertEqual(self.run_cli("ofertas", "--campo", "business_id", BUSINESS)[0], 0)
        self.assertEqual(self.run_cli("apuestas", "registrar", "--campo", "bets", "[]")[0], 0)
        self.assertEqual(self.posted("saleads_agent_register_bets")[-1]["business_id"], BUSINESS)

    def test_drops_business_id_when_the_command_does_not_accept_it(self):
        Fake.schemas = {"saleads_get_campaign_health": ["campaign_id"]}
        Fake.plan["/agent/v1/commands/saleads_get_campaign_health"] = [(200, {"ok": True, "data": {}})]
        self.assertEqual(self.run_cli("salud", "--campo", "business_id", BUSINESS, "--campo", "campaign_id", "c1")[0], 0)
        self.assertEqual(self.posted("saleads_get_campaign_health")[-1], {"campaign_id": "c1"})

    def test_without_a_remembered_business_or_schema_nothing_changes(self):
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": True, "data": {}})]
        self.assertEqual(self.run_cli("ofertas")[0], 0)  # sin esquema: no se toca
        self.assertEqual(self.posted("saleads_list_offerings")[-1], {})
        Fake.schemas = {"saleads_list_offerings": ["business_id"]}
        self.run_cli("ofertas")  # con esquema pero sin negocio recordado: lo decide el servidor
        self.assertNotIn("business_id", self.posted("saleads_list_offerings")[-1])

    def test_a_failed_call_does_not_change_the_remembered_business(self):
        Fake.schemas = {"saleads_list_offerings": ["business_id"]}
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": True, "data": {}}), (200, {"ok": False, "code": "MCP-E-BUSINESS-NOT-FOUND", "message": "no"}), (200, {"ok": True, "data": {}})]
        self.run_cli("ofertas", "--campo", "business_id", BUSINESS)
        self.run_cli("ofertas", "--campo", "business_id", "99999999-2222-4333-8444-555555555555")
        self.run_cli("ofertas")
        self.assertEqual(self.posted("saleads_list_offerings")[-1]["business_id"], BUSINESS)


@unittest.skipIf(BUNDLE in ("1.4.0", "1.5.0", "1.5.1", "1.5.2", "1.5.3"), "cotización atada a su id desde 1.5.4")
class QuoteIdTest(CliFixture):
    """1.5.4: SaleADS ata la cotización al client_request_id; generar con otro da QUOTE_CONTENT_MISMATCH."""

    def posted(self, name):
        return [c["body"] for c in Fake.calls if c["method"] == "POST" and c["path"].endswith("/" + name)]

    def test_generate_reuses_the_quote_request_id(self):
        Fake.plan["/agent/v1/commands/saleads_agent_quote_pieces"] = [(200, {"ok": True, "data": {"quote_token": "aq1.x", "credits": 10}})]
        Fake.plan["/agent/v1/commands/saleads_agent_generate_pieces"] = [(200, {"ok": True, "data": {"jobId": "j1"}})]
        code, out, _, _ = self.run_cli("piezas", "cotizar", "--campo", "business_id", BUSINESS)
        self.assertEqual(code, 0)
        quoted = out["client_request_id"]
        code, out, _, _ = self.run_cli("piezas", "generar", "--campo", "quote_token", "aq1.x", "--campo", "accepted_credits", "10")
        self.assertEqual(code, 0)
        self.assertEqual(self.posted("saleads_agent_generate_pieces")[-1]["client_request_id"], quoted)

    def test_explicit_id_wins_and_unknown_quote_gets_a_new_id(self):
        Fake.plan["/agent/v1/commands/saleads_agent_generate_pieces"] = [(200, {"ok": True, "data": {}})]
        self.run_cli("piezas", "generar", "--campo", "quote_token", "aq1.otro", "--id", "mi-id-000001")
        self.assertEqual(self.posted("saleads_agent_generate_pieces")[-1]["client_request_id"], "mi-id-000001")
        self.run_cli("piezas", "generar", "--campo", "quote_token", "aq1.desconocido")
        self.assertNotEqual(self.posted("saleads_agent_generate_pieces")[-1]["client_request_id"], "mi-id-000001")


def closed(props, required=(), enums=None):
    return {"type": "object", "additionalProperties": False, "required": list(required),
            "properties": {k: ({"enum": enums[k]} if enums and k in enums else {}) for k in props}}


@unittest.skipIf(BUNDLE in ("1.4.0", "1.5.0", "1.5.1", "1.5.2", "1.5.3", "1.5.4"), "argumentos según el esquema desde 1.5.5")
class SchemaFitTest(CliFixture):
    """1.5.5 (corrida corta 1 con usuarios simulados): lo que el esquema ya sabe no debe llegar mal al servidor."""

    def posted(self, name):
        return [c["body"] for c in Fake.calls if c["method"] == "POST" and c["path"].endswith("/" + name)]

    def test_quote_is_read_only_in_dev_but_still_gets_its_client_request_id(self):
        catalog = [dict(c, read_only=True) if c["name"] == "saleads_agent_quote_pieces" else c for c in CATALOG]
        Fake.plan["/agent/v1/commands"] = [(200, {"ok": True, "data": {"commands": catalog}})]
        Fake.schemas = {"saleads_agent_quote_pieces": closed(["business_id", "client_request_id", "piece"], ["business_id", "client_request_id", "piece"])}
        Fake.plan["/agent/v1/commands/saleads_agent_quote_pieces"] = [(200, {"ok": True, "data": {"quote_token": "aq1.q", "credits": 5}})]
        code, out, _, _ = self.run_cli("piezas", "cotizar", "--campo", "business_id", BUSINESS, "--campo", "piece", "{}")
        self.assertEqual(code, 0)
        self.assertEqual(self.posted("saleads_agent_quote_pieces")[-1]["client_request_id"], out["client_request_id"])

    def test_generate_uses_the_quote_id_even_with_another_id(self):
        Fake.plan["/agent/v1/commands/saleads_agent_quote_pieces"] = [(200, {"ok": True, "data": {"quote_token": "aq1.q", "credits": 5}})]
        Fake.plan["/agent/v1/commands/saleads_agent_generate_pieces"] = [(200, {"ok": True, "data": {"jobId": "j"}})]
        _, quoted, _, _ = self.run_cli("piezas", "cotizar", "--campo", "business_id", BUSINESS)
        code, out, _, _ = self.run_cli("piezas", "generar", "--campo", "quote_token", "aq1.q", "--id", "generar-cierre-20261102")
        self.assertEqual(code, 0)
        self.assertEqual(self.posted("saleads_agent_generate_pieces")[-1]["client_request_id"], quoted["client_request_id"])
        self.assertIn("client_request_id", out["avisos"])

    def test_without_a_remembered_business_it_takes_the_selected_one(self):
        Fake.schemas = {"saleads_list_campaigns": ["business_id"]}
        Fake.plan["/agent/v1/commands/saleads_get_account_overview"] = [(200, {"ok": True, "data": {"businesses": [], "selected_business_id": BUSINESS}})]
        Fake.plan["/agent/v1/commands/saleads_list_campaigns"] = [(200, {"ok": True, "data": {}})]
        self.assertEqual(self.run_cli("campanas")[0], 0)
        self.assertEqual(self.posted("saleads_list_campaigns")[-1], {"business_id": BUSINESS})

    def test_a_loose_value_fills_the_only_missing_required_field(self):
        Fake.schemas = {"saleads_get_operation": closed(["operation_id"], ["operation_id"])}
        Fake.plan["/agent/v1/commands/saleads_get_operation"] = [(200, {"ok": True, "data": {"status": "succeeded"}})]
        self.assertEqual(self.run_cli("op", "op-123")[0], 0)
        self.assertEqual(self.posted("saleads_get_operation")[-1], {"operation_id": "op-123"})

    def test_unknown_fields_are_dropped_on_reads_and_refused_on_writes(self):
        Fake.schemas = {"saleads_list_campaigns": closed(["business_id"], ["business_id"]),
                        "saleads_agent_register_bets": closed(["business_id", "client_request_id", "bets"], ["business_id", "client_request_id", "bets"])}
        Fake.plan["/agent/v1/commands/saleads_list_campaigns"] = [(200, {"ok": True, "data": {}})]
        code, out, _, _ = self.run_cli("campanas", "--campo", "business_id", BUSINESS, "--campo", "detail", "full")
        self.assertEqual((code, out["avisos"]["ignorados"]), (0, ["detail"]))
        self.assertEqual(self.posted("saleads_list_campaigns")[-1], {"business_id": BUSINESS})
        code, out, _, _ = self.run_cli("apuestas", "registrar", "--campo", "business_id", BUSINESS, "--campo", "bets", "[]", "--campo", "negocio", "x")
        self.assertEqual((code, out["code"]), (2, "CLI-USAGE"))
        self.assertIn("negocio", out["message"])
        self.assertEqual(self.posted("saleads_agent_register_bets"), [])

    def test_missing_required_and_values_outside_the_list_are_explained_before_calling(self):
        Fake.schemas = {"saleads_get_help": closed(["topic"], [], {"topic": ["primeros_pasos", "creditos"]}),
                        "saleads_agent_bet_state": closed(["business_id", "client_request_id", "bet_id", "state"], ["business_id", "client_request_id", "bet_id", "state"])}
        code, out, _, _ = self.run_cli("guia", "--campo", "topic", "lanzamiento")
        self.assertEqual((code, out["code"]), (2, "CLI-USAGE"))
        self.assertIn("primeros_pasos", out["next_action"])
        code, out, _, _ = self.run_cli("apuestas", "estado", "--campo", "business_id", BUSINESS, "--campo", "state", "retired")
        self.assertEqual((code, out["code"]), (2, "CLI-USAGE"))
        self.assertIn("bet_id", out["message"])
        self.assertEqual([c for c in Fake.calls if c["method"] == "POST"], [])


@unittest.skipIf(BUNDLE in ("1.4.0", "1.5.0", "1.5.1", "1.5.2", "1.5.3", "1.5.4", "1.5.5", "1.5.6", "1.5.7", "1.5.8"), "recorte avisado y web desde 1.5.9")
class TruncationAndWebTest(CliFixture):
    """1.5.9 (corrida completa 1): Paola sumó 20 filas visibles de 28; Hernán recibió una URL inventada."""

    def test_a_cut_list_comes_with_the_warning_and_totals_stay_whole(self):
        rows = [{"ad_set_id": f"a{i}", "spend": 100} for i in range(28)]
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": True, "data": {"rows": rows, "totals": {"spend": 2800, "rows": rows}}})]
        code, out, _, _ = self.run_cli("ofertas", "--campo", "business_id", BUSINESS)
        self.assertEqual(code, 0)
        self.assertIn("recortado", out)
        self.assertIn("do not sum" if BUNDLE in ENGLISH_BUNDLES else "no sumes", out["recortado"]["aviso"])
        self.assertEqual(out["data"]["totals"]["spend"], 2800)
        self.assertEqual(len(out["data"]["totals"]["rows"]), 28)
        code, out, _, _ = self.run_cli("ofertas", "--campo", "business_id", BUSINESS, "--completo")
        self.assertNotIn("recortado", out)

    def test_web_gives_the_real_addresses_or_refuses_to_invent(self):
        code, out, _, _ = self.run_cli("web")
        self.assertEqual((code, out["code"]), (2, "CLI-CONFIG"))
        Path(f"{self.home}/skills/saleads-cli/config.json").write_text(json.dumps({"url": self.url, "client_id": "c", "web_url": "https://dev.saleads.ai/x"}))
        code, out, _, _ = self.run_cli("web")
        self.assertEqual(code, 0)
        self.assertEqual(out["data"]["limites"], "https://dev.saleads.ai/es/dashboard/assistant?tab=limits")
        if BUNDLE not in BEFORE_1_5_10:  # MCB-013: un caso por idioma
            code, out, _, _ = self.run_cli("web", "--idioma", "en")
            self.assertEqual((code, out["data"]["limites"]), (0, "https://dev.saleads.ai/en/dashboard/assistant?tab=limits"))




@unittest.skipIf(BUNDLE in BEFORE_1_5_10, "CLI usable desde 1.5.10 (MCB-011)")
class UsableCliTest(CliFixture):
    """MCB-011: en luna/paola el tick recibió `saleads: command not found` y el CLI rechazaba `--business_id` y `--help`."""

    def posted(self, name):
        return [c["body"] for c in Fake.calls if c["method"] == "POST" and c["path"].endswith("/" + name)]

    def install_script(self):
        script = Path(f"{self.home}/skills/saleads-cli/scripts/saleads.py")
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(CLI.read_text())
        return script

    def test_the_first_long_call_leaves_the_short_saleads_ready(self):
        """La vuelta automática ejecuta lo que dice (MCN-004): después de la ruta larga, `saleads …` corre."""
        script = self.install_script()
        wrapper = Path(f"{self.home}/.local/bin/saleads")
        self.assertEqual(self.run_cli("version")[0], 0)
        self.assertTrue(wrapper.is_file())
        self.assertEqual(wrapper.stat().st_mode & 0o777, 0o755)
        self.assertEqual(wrapper.read_text(), f'#!/bin/sh\nexec python3 {script} "$@"\n')
        before = wrapper.stat().st_mtime_ns
        self.assertEqual(self.run_cli("version")[0], 0)
        self.assertEqual(wrapper.stat().st_mtime_ns, before)  # idempotente
        env = {"HERMES_HOME": self.home, "PATH": f"{self.home}/.local/bin:" + os.environ.get("PATH", "")}
        proc = subprocess.run(["sh", "-c", "saleads version"], capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout)["data"]["version"], "1.5.1")

    def test_an_unwritable_bin_never_changes_the_command_output(self):
        """Un detalle de la VM nunca bloquea una acción: sin escritura en .local/bin el comando sale igual."""
        self.install_script()
        Path(f"{self.home}/.local").write_text("no es un directorio")
        code, out, stdout, stderr = self.run_cli("version")
        self.assertEqual((code, out), (0, {"ok": True, "data": {"version": "1.5.1"}}))
        self.assertEqual((len(stdout.splitlines()), stderr), (1, ""))
        Fake.plan["/agent/v1/commands/saleads_list_offerings"] = [(200, {"ok": True, "data": {"offerings": []}})]
        self.assertEqual(self.run_cli("ofertas", "--campo", "business_id", BUSINESS)[1], {"ok": True, "data": {"offerings": []}})

    def test_business_id_and_schema_fields_as_options_work_like_campo(self):
        """El dueño no hace soporte técnico (problema 6): Ale no se traba en la sintaxis de las opciones."""
        Fake.schemas = {"saleads_agent_bet_state": closed(["business_id", "client_request_id", "bet_id", "state"], ["business_id", "client_request_id", "bet_id", "state"])}
        Fake.plan["/agent/v1/commands/saleads_agent_bet_state"] = [(200, {"ok": True, "data": {}})]
        self.assertEqual(self.run_cli("apuestas", "estado", "--business_id", BUSINESS, "--bet_id", "b1", "--state", "active", "--id", "estado-0000001")[0], 0)
        self.assertEqual(self.run_cli("apuestas", "estado", "--campo", "business_id", BUSINESS, "--campo", "bet_id", "b1", "--campo", "state", "active", "--id", "estado-0000001")[0], 0)
        self.assertEqual(self.run_cli("apuestas", "estado", "--business-id", BUSINESS, "--bet-id", "b1", "--state", "active", "--id", "estado-0000001")[0], 0)
        bodies = self.posted("saleads_agent_bet_state")
        self.assertEqual(len(bodies), 3)
        self.assertTrue(all(body == bodies[0] for body in bodies))
        self.assertEqual(bodies[0], {"business_id": BUSINESS, "bet_id": "b1", "state": "active", "client_request_id": "estado-0000001"})

    def test_business_id_is_dropped_when_the_command_does_not_take_it(self):
        """Igual que con --campo: el negocio lo pone o lo quita el CLI según el esquema."""
        Fake.schemas = {"saleads_get_campaign_health": ["campaign_id"]}
        Fake.plan["/agent/v1/commands/saleads_get_campaign_health"] = [(200, {"ok": True, "data": {}})]
        self.assertEqual(self.run_cli("salud", "--business-id", BUSINESS, "--campaign_id", "c1")[0], 0)
        self.assertEqual(self.posted("saleads_get_campaign_health")[-1], {"campaign_id": "c1"})

    def test_help_after_a_command_shows_that_command(self):
        """`--help` después del comando no gasta un turno en «Opción no reconocida»."""
        Fake.schemas = {"saleads_agent_bet_state": closed(["business_id", "client_request_id", "bet_id", "state"], ["business_id", "client_request_id", "bet_id", "state"], {"state": ["active", "paused", "retired"]})}
        code, out, _, _ = self.run_cli("apuestas", "estado", "--campo", "bet_id", "b1", "--help")
        self.assertEqual(code, 0)
        self.assertEqual(out["data"]["name"], "saleads_agent_bet_state")
        self.assertEqual(out["data"]["obligatorios"], ["bet_id", "state"])
        self.assertEqual(out["data"]["valores"], {"state": ["active", "paused", "retired"]})
        self.assertEqual([c for c in Fake.calls if c["method"] == "POST"], [])
        code, out, _, _ = self.run_cli("web", "-h")
        self.assertEqual((code, out["data"]["name"]), (0, "web"))

    def test_unknown_options_stay_refused_with_the_valid_fields(self):
        """Las opciones amables no abren campos que el servidor no espera, ni el host ni el token."""
        Fake.schemas = {"saleads_agent_register_bets": closed(["business_id", "client_request_id", "bets"], ["business_id", "client_request_id", "bets"]),
                        "saleads_list_campaigns": closed(["business_id", "status"], ["business_id"])}
        Fake.plan["/agent/v1/commands/saleads_list_campaigns"] = [(200, {"ok": True, "data": {}})]
        code, out, _, _ = self.run_cli("apuestas", "registrar", "--business_id", BUSINESS, "--campo", "bets", "[]", "--inventado", "3")
        self.assertEqual((code, out["code"]), (2, "CLI-USAGE"))
        self.assertIn("inventado", out["message"])
        self.assertIn("bets", out["next_action"])
        self.assertEqual(self.posted("saleads_agent_register_bets"), [])
        code, out, _, _ = self.run_cli("campanas", "--business_id", BUSINESS, "--inventado", "3", "--status", "active")
        self.assertEqual((code, out["avisos"]["ignorados"]), (0, ["inventado"]))
        self.assertEqual(self.posted("saleads_list_campaigns")[-1], {"business_id": BUSINESS, "status": "active"})
        code, out, _, _ = self.run_cli("guia", "--topic")
        self.assertEqual((code, out["code"]), (2, "CLI-USAGE"))
        self.assertIn("Unrecognized option" if BUNDLE in ENGLISH_BUNDLES else "Opción no reconocida", out["message"])
        self.assertIn("saleads ayuda guia", out["next_action"])
        calls = len(Fake.calls)
        for flag in ("--url", "--token", "--host"):
            code, out, _, _ = self.run_cli("campanas", flag, "https://evil.example")
            self.assertEqual((code, out["code"]), (2, "CLI-USAGE"))
        self.assertEqual(len(Fake.calls), calls)


@unittest.skipIf(BUNDLE in BEFORE_1_5_10, "saleads limites desde 1.5.10 (MCB-004)")
class LimitsTest(CliFixture):
    """MCB-004: Ale siempre sabe el presupuesto límite (P-C) y no suma filas para obtenerlo."""

    def test_limites_reads_the_month_whole(self):
        """Las cifras de plata y del tope nunca se recortan: Ale las cita tal cual."""
        catalog = CATALOG + [{"name": "saleads_agent_limits", "title": "Límites", "summary": "Presupuesto y tope.", "required_scope": "saleads:strategy", "async": False, "read_only": True}]
        Fake.plan["/agent/v1/commands"] = [(200, {"ok": True, "data": {"commands": catalog}})]
        rows = [{"day": i, "spend_minor": 1000} for i in range(30)]
        data = {"budget": {"decision": "within", "approved_monthly_minor": 400000, "left_minor": 190000, "rows": rows},
                "credits": {"cap": 60, "used_this_period": 10, "remaining": 50, "history": rows},
                "limits_url": "https://dev.saleads.ai/es/dashboard/assistant?tab=limits"}
        Fake.plan["/agent/v1/commands/saleads_agent_limits"] = [(200, {"ok": True, "data": data})]
        code, out, _, _ = self.run_cli("limites", "--business_id", BUSINESS)
        self.assertEqual(code, 0)
        self.assertEqual(Fake.calls[-1]["path"], "/agent/v1/commands/saleads_agent_limits")
        self.assertEqual(out["data"]["budget"], data["budget"])
        self.assertEqual(out["data"]["credits"], data["credits"])

    def test_without_the_server_command_it_fails_cleanly(self):
        """Si el MCP todavía no tiene el comando, la salida es la de siempre (3, MCP-E-UNKNOWN-COMMAND): Ale sigue."""
        code, out, stdout, stderr = self.run_cli("limites", "--business_id", BUSINESS)
        self.assertEqual((code, out["ok"], out["code"]), (3, False, "MCP-E-UNKNOWN-COMMAND"))
        self.assertIn("saleads ayuda", out["next_action"])
        self.assertEqual((len(stdout.splitlines()), stderr), (1, ""))
        self.assertFalse(any(c["path"].endswith("saleads_agent_limits") for c in Fake.calls))


@unittest.skipIf(BUNDLE in BEFORE_1_5_10, "tope de créditos con enlace desde 1.5.10 (MCB-005)")
class CreditCapTest(CliFixture):
    """MCB-005: el dueño recibe un enlace que abre Límites, sin códigos; Ale no pierde el dato al pasar por el CLI."""

    def test_the_cap_error_keeps_its_link_and_the_quote_keeps_its_cap_status(self):
        cap_error = {"ok": False, "code": "MCP-E-AGENT-CREDIT-CAP", "message": "El dueño no fijó el tope.",
                     "action_url": "https://dev.saleads.ai/es/dashboard/assistant?tab=limits&cap=12",
                     "next_action": "Pídele al dueño que fije (o suba) el tope mensual de créditos de su asistente en Mi asistente → Límites.",
                     "details": {"cap": None, "used": 0, "requested": 12}, "retryable": False}
        Fake.plan["/agent/v1/commands/saleads_agent_generate_pieces"] = [(409, cap_error)]
        code, out, _, _ = self.run_cli("piezas", "generar", "--campo", "quote_token", "aq1.x", "--campo", "accepted_credits", "12")
        self.assertEqual((code, out["code"]), (3, "MCP-E-AGENT-CREDIT-CAP"))
        self.assertEqual(out["action_url"], cap_error["action_url"])
        self.assertEqual(out["details"], cap_error["details"])
        self.assertNotIn("Ajustes", out["next_action"])
        quote = {"quote_token": "aq1.q", "credits": 12, "cap": None, "used_this_period": 0, "cap_status": "not_set", "min_cap_needed": 12,
                 "limits_url": "https://dev.saleads.ai/es/dashboard/assistant?tab=limits&cap=12", "next_action": "Pídele al dueño que fije el tope."}
        Fake.plan["/agent/v1/commands/saleads_agent_quote_pieces"] = [(200, {"ok": True, "data": quote})]
        code, out, _, _ = self.run_cli("piezas", "cotizar", "--business_id", BUSINESS)
        self.assertEqual(code, 0)
        self.assertEqual({k: out["data"][k] for k in ("cap_status", "min_cap_needed", "limits_url")},
                         {"cap_status": "not_set", "min_cap_needed": 12, "limits_url": quote["limits_url"]})
        self.assertEqual(out["next"], quote["next_action"])


PIECES_CATALOG = CATALOG + [
    {"name": "saleads_agent_pieces", "title": "Ver pieza", "summary": "Estado de una pieza.", "required_scope": "saleads:campaigns", "async": False, "read_only": True},
    {"name": "saleads_agent_upload_media", "title": "Subir", "summary": "Sube un medio.", "required_scope": "saleads:campaigns", "async": False, "read_only": False},
]
PIECE = {"business_id": BUSINESS, "piece": {"offering": {"item_id": "o1", "item_kind": "product"}, "bet_id": "b1"}}


@unittest.skipIf(BUNDLE in BEFORE_1_5_10, "piezas preparar desde 1.5.10 (MCB-007)")
class PrepareTest(CliFixture):
    """MCB-007 (D14): la imagen queda lista en un paso cuando cabe en el tope que el dueño fijó."""

    def setUp(self):
        super().setUp()
        Fake.plan["/agent/v1/commands"] = [(200, {"ok": True, "data": {"commands": PIECES_CATALOG}})]
        self.piece = Path(f"{self.home}/pieza.json")
        self.piece.write_text(json.dumps(PIECE))
        self.status = "completed"
        Fake.responders["/agent/v1/commands/saleads_agent_pieces"] = lambda body: (200, {"ok": True, "data": {
            "job": {"id": body["job_id"], "status": self.status},
            "images": [{"id": f"img-{body['job_id']}", "gcsPath": f"gs://saleads-dev-gen-images/{body['job_id']}.png"}] if self.status == "completed" else [],
            "judge": [{"product_fidelity": {"severity": "low"}}]}})
        Fake.responders["/agent/v1/commands/saleads_agent_upload_media"] = lambda body: (200, {"ok": True, "data": {
            "image_hash": "h-" + body["source"]["variationId"], "media_ref": {"gcs_path": f"meta-uploads/{BUSINESS}/agent/{body['source']['variationId']}.png"}}})

    def posted(self, name):
        return [c["body"] for c in Fake.calls if c["method"] == "POST" and c["path"].endswith("/" + name)]

    def quote(self, **extra):
        Fake.plan["/agent/v1/commands/saleads_agent_quote_pieces"] = [(200, {"ok": True, "data": {"quote_token": "aq1.q", "credits": 12, **extra}})]

    def test_with_the_cap_set_the_image_is_ready_in_one_call(self):
        """Terminada = con su imagen real (MCN-006): image_hash y media_ref salen de la misma respuesta, sin mostrar la cotización."""
        self.quote(cap=60, used_this_period=10, remaining_cap=50, cap_status="ok")
        Fake.plan["/agent/v1/commands/saleads_agent_generate_pieces"] = [(200, {"ok": True, "data": {"jobId": "j1"}})]
        code, out, _, _ = self.run_cli("piezas", "preparar", "--archivo", str(self.piece))
        self.assertEqual(code, 0)
        self.assertEqual(out["data"]["estado"], "lista")
        self.assertEqual(out["data"]["images"], [{"job_id": "j1", "variation_id": "img-j1", "image_hash": "h-img-j1",
                                                  "media_ref": {"gcs_path": f"meta-uploads/{BUSINESS}/agent/img-j1.png"}}])
        self.assertEqual(out["data"]["judge"], {"j1": [{"product_fidelity": {"severity": "low"}}]})
        generated = self.posted("saleads_agent_generate_pieces")[-1]
        self.assertEqual((generated["quote_token"], generated["accepted_credits"]), ("aq1.q", 12))
        self.assertEqual(generated["client_request_id"], self.posted("saleads_agent_quote_pieces")[-1]["client_request_id"])
        upload = self.posted("saleads_agent_upload_media")[-1]
        self.assertEqual(upload["source"], {"kind": "gen_image", "jobId": "j1", "variationId": "img-j1"})
        self.assertEqual(upload["action"], "image")

    def test_without_the_cap_it_does_not_generate_and_gives_the_link(self):
        """No se gasta sin tope: Ale recibe el costo y el enlace de Límites para el dueño, y nada se debita."""
        self.quote(cap=None, used_this_period=0, cap_status="not_set", min_cap_needed=12,
                   limits_url="https://dev.saleads.ai/es/dashboard/assistant?tab=limits&cap=12", next_action="Pídele el tope.")
        code, out, _, _ = self.run_cli("piezas", "preparar", "--archivo", str(self.piece))
        self.assertEqual((code, out["data"]["estado"]), (0, "sin_tope"))
        self.assertEqual(out["data"]["cotizacion"]["limits_url"], "https://dev.saleads.ai/es/dashboard/assistant?tab=limits&cap=12")
        self.assertEqual(out["next"], "Pídele el tope.")
        self.assertEqual(self.posted("saleads_agent_generate_pieces"), [])
        self.quote(cap=None, used_this_period=0)  # un MCP sin cap_status: la misma regla con cap y used_this_period
        self.assertEqual(self.run_cli("piezas", "preparar", "--archivo", str(self.piece))[1]["data"]["estado"], "sin_tope")
        self.quote(cap=20, used_this_period=15, remaining_cap=5)
        self.assertEqual(self.run_cli("piezas", "preparar", "--archivo", str(self.piece))[1]["data"]["estado"], "tope_corto")
        self.assertEqual(self.posted("saleads_agent_generate_pieces"), [])

    def test_max_credits_stops_before_generating(self):
        """Ale puede ponerse su propio techo por pieza; el comando no decide por él."""
        self.quote(cap_status="ok")
        code, out, _, _ = self.run_cli("piezas", "preparar", "--archivo", str(self.piece), "--max-creditos", "5")
        self.assertEqual((code, out["data"]["estado"], out["data"]["cotizacion"]["credits"]), (0, "supera_maximo", 12))
        self.assertEqual(self.posted("saleads_agent_generate_pieces"), [])

    def test_a_timed_out_wait_resumes_with_the_same_id_without_paying_twice(self):
        """Idempotencia: el dueño no paga dos veces si gen-image tarda más que la espera."""
        self.quote(cap_status="ok")
        Fake.plan["/agent/v1/commands/saleads_agent_generate_pieces"] = [(200, {"ok": True, "data": {"jobId": "j1"}})]
        self.status = "running"
        code, out, _, _ = self.run_cli("piezas", "preparar", "--archivo", str(self.piece), "--esperar", "1", "--id", "preparar-0000001")
        self.assertEqual((code, out["data"]["estado"], out["data"]["job_ids"]), (0, "generando", ["j1"]))
        self.assertIn("--id preparar-0000001", out["next"])
        self.assertEqual(self.posted("saleads_agent_upload_media"), [])
        self.status = "completed"
        code, out, _, _ = self.run_cli("piezas", "preparar", "--archivo", str(self.piece), "--id", "preparar-0000001")
        self.assertEqual((code, out["data"]["estado"]), (0, "lista"))
        ids = {body["client_request_id"] for body in self.posted("saleads_agent_quote_pieces") + self.posted("saleads_agent_generate_pieces")}
        self.assertEqual(ids, {"preparar-0000001"})  # cotizar y generar repiten la misma operación
        _, again, _, _ = self.run_cli("piezas", "preparar", "--archivo", str(self.piece), "--id", "preparar-0000001")
        uploads = self.posted("saleads_agent_upload_media")
        self.assertEqual(len({u["client_request_id"] for u in uploads}), 1)  # la subida repetida usa el mismo id
        self.assertEqual(again["data"]["images"], out["data"]["images"])

    def test_two_variations_give_two_images_and_ale_chooses(self):
        """SaleADS no elige por Ale (invariante 1): devuelve cada imagen con su hash."""
        self.quote(cap_status="ok")
        Fake.plan["/agent/v1/commands/saleads_agent_generate_pieces"] = [(200, {"ok": True, "data": {"variations": [{"job_id": "v1"}, {"job_id": "v2"}]}})]
        code, out, _, _ = self.run_cli("piezas", "preparar", "--archivo", str(self.piece))
        self.assertEqual((code, out["data"]["estado"]), (0, "lista"))
        self.assertEqual([i["image_hash"] for i in out["data"]["images"]], ["h-img-v1", "h-img-v2"])
        self.assertEqual(len({u["client_request_id"] for u in self.posted("saleads_agent_upload_media")}), 2)

    def test_an_expired_quote_is_quoted_again_with_a_new_fixed_id(self):
        """Si se cortó antes de generar y la cotización venció, se vuelve a cotizar y se dice en avisos."""
        self.quote(cap_status="ok")
        stale = {"ok": False, "code": "MCP-E-AGENT-QUOTE-STALE", "message": "vencida", "details": {"downstream_code": "QUOTE_EXPIRED"}}
        Fake.plan["/agent/v1/commands/saleads_agent_generate_pieces"] = [(409, stale), (200, {"ok": True, "data": {"jobId": "j1"}})]
        code, out, _, _ = self.run_cli("piezas", "preparar", "--archivo", str(self.piece), "--id", "preparar-0000002")
        self.assertEqual((code, out["data"]["estado"]), (0, "lista"))
        self.assertIn("cotizacion", out["avisos"])
        quotes = [b["client_request_id"] for b in self.posted("saleads_agent_quote_pieces")]
        self.assertEqual(quotes[0], "preparar-0000002")
        self.assertNotEqual(quotes[1], "preparar-0000002")
        self.assertEqual(self.posted("saleads_agent_generate_pieces")[-1]["client_request_id"], quotes[1])

    def test_help_and_listing_name_the_composite(self):
        code, out, _, _ = self.run_cli("piezas", "preparar", "--help")
        self.assertEqual((code, out["data"]["name"]), (0, "piezas preparar"))
        code, out, _, _ = self.run_cli("ayuda")
        self.assertIn("piezas preparar", [c["name"] for c in out["data"]["commands"]])


@unittest.skipIf(BUNDLE in BEFORE_1_5_10, "idioma del dueño desde 1.5.10 (MCB-013)")
class LanguageTest(CliFixture):
    """MCB-014/MCB-013: Mike escribe en inglés y recibió el enlace de Límites en /es/."""

    def setUp(self):
        super().setUp()
        Path(f"{self.home}/skills/saleads-cli/config.json").write_text(json.dumps({"url": self.url, "client_id": "c", "web_url": "https://dev.saleads.ai"}))

    def posted(self, name):
        return [c["body"] for c in Fake.calls if c["method"] == "POST" and c["path"].endswith("/" + name)]

    def test_web_links_follow_the_owner_language_and_remember_it(self):
        """Ale le habla al dueño en su idioma, también en los enlaces (MCN-014)."""
        self.assertEqual(self.run_cli("web")[1]["data"]["limites"], "https://dev.saleads.ai/es/dashboard/assistant?tab=limits")
        code, out, _, _ = self.run_cli("web", "--idioma", "en")
        self.assertEqual((code, out["data"]["idioma"], out["data"]["asistente"]), (0, "en", "https://dev.saleads.ai/en/dashboard/assistant"))
        self.assertEqual(self.run_cli("web")[1]["data"]["limites"], "https://dev.saleads.ai/en/dashboard/assistant?tab=limits")
        code, out, _, _ = self.run_cli("web", "--idioma", "de")
        self.assertEqual((code, out["code"]), (2, "CLI-USAGE"))
        self.assertIn("es, en", out["next_action"])
        self.assertEqual(self.run_cli("web")[1]["data"]["idioma"], "en")  # un idioma inválido no cambia el recordado

    def test_locale_goes_only_to_the_commands_that_build_owner_links(self):
        """El dueño entiende lo que aprueba (el enlace de aprobación abre en su idioma) y las apuestas no cambian de idioma."""
        activation = closed(["business_id", "client_request_id", "publication_id", "locale"], ["business_id", "client_request_id", "publication_id"])
        Fake.schemas = {"saleads_agent_request_activation": activation,
                        "saleads_agent_register_bets": closed(["business_id", "client_request_id", "bets", "locale"], ["business_id", "client_request_id", "bets"]),
                        "saleads_agent_bet_state": closed(["business_id", "client_request_id", "bet_id", "state"], ["business_id", "client_request_id", "bet_id", "state"])}
        for name in ("saleads_agent_request_activation", "saleads_agent_register_bets", "saleads_agent_bet_state"):
            Fake.plan[f"/agent/v1/commands/{name}"] = [(200, {"ok": True, "data": {}})]
        catalog = CATALOG + [{"name": "saleads_agent_request_activation", "title": "Encender", "summary": "Pide el encendido.", "required_scope": "saleads:campaigns", "async": False, "read_only": False}]
        Fake.plan["/agent/v1/commands"] = [(200, {"ok": True, "data": {"commands": catalog}})]
        self.run_cli("encendido", "pedir", "--business_id", BUSINESS, "--publication_id", "p1")
        self.assertNotIn("locale", self.posted("saleads_agent_request_activation")[-1])  # sin idioma: igual que hoy
        self.run_cli("web", "--idioma", "en")
        self.run_cli("encendido", "pedir", "--business_id", BUSINESS, "--publication_id", "p1")
        self.assertEqual(self.posted("saleads_agent_request_activation")[-1]["locale"], "en")
        self.run_cli("apuestas", "registrar", "--business_id", BUSINESS, "--campo", "bets", "[]", "--campo", "locale", "es-CO")
        self.assertEqual(self.posted("saleads_agent_register_bets")[-1]["locale"], "es-CO")
        self.run_cli("apuestas", "registrar", "--business_id", BUSINESS, "--campo", "bets", "[]")
        self.assertNotIn("locale", self.posted("saleads_agent_register_bets")[-1])
        self.run_cli("apuestas", "estado", "--business_id", BUSINESS, "--bet_id", "b1", "--state", "paused", "--idioma", "es")
        self.assertNotIn("locale", self.posted("saleads_agent_bet_state")[-1])
        self.run_cli("encendido", "pedir", "--business_id", BUSINESS, "--publication_id", "p1")
        self.assertEqual(self.posted("saleads_agent_request_activation")[-1]["locale"], "es")  # el último --idioma usado
        Fake.schemas["saleads_agent_request_activation"] = closed(["business_id", "client_request_id", "publication_id"], ["business_id", "client_request_id", "publication_id"])
        os.remove(f"{self.home}/cache/saleads-cli/schemas-v2.json")
        code, _, _, _ = self.run_cli("encendido", "pedir", "--business_id", BUSINESS, "--publication_id", "p1")
        self.assertEqual(code, 0)  # un MCP sin `locale` en el esquema: no se manda
        self.assertNotIn("locale", self.posted("saleads_agent_request_activation")[-1])
