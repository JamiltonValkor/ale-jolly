"""Contract tests for the native Hermes Meta research tool; no network or keys."""
import importlib.util
import io
import json
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("meta_search", Path(__file__).with_name("search.py"))
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)


def stream(*events):
    return io.BytesIO(b"".join(("data: " + json.dumps(e, ensure_ascii=False) + "\r\n\r\n").encode() for e in events))


def completed(text="Evidence for Bogotá", citations=True, searched=True):
    content = {"type": "output_text", "text": text, "annotations": []}
    if citations:
        content["annotations"].append({"type": "url_citation", "url": "https://example.org/research", "title": "Market source"})
    return {"type": "response.completed", "response": {"id": "resp_test", "status": "completed", "output": [
        *([{"type": "web_search_call", "status": "completed"}] if searched else []),
        {"type": "message", "content": [content]},
    ], "usage": {"input_tokens": 12, "output_tokens": 30}}}


class SearchTests(unittest.TestCase):
    def test_official_registration_is_only_available_to_researcher(self):
        import types
        path = Path(__file__).parent
        package_spec = importlib.util.spec_from_file_location("saleads_meta_plugin", path / "__init__.py", submodule_search_locations=[str(path)])
        package = importlib.util.module_from_spec(package_spec)
        sys.modules[package_spec.name] = package
        package_spec.loader.exec_module(package)
        registered = {}
        package.register(types.SimpleNamespace(register_tool=lambda **kwargs: registered.update(kwargs)))
        self.assertEqual(registered["name"], "saleads_web_search")
        self.assertEqual(registered["toolset"], "saleads_research")
        for profile, expected in [("/opt/data", False), ("/opt/data/profiles/estratega", False), ("/opt/data/profiles/investigador", True)]:
            with patch.dict(os.environ, {"MODEL_API_KEY": "private-test-key", "HERMES_HOME": profile}):
                self.assertEqual(registered["check_fn"](), expected)

    def run_tool(self, *events):
        with tempfile.TemporaryDirectory() as home:
            with patch.dict(os.environ, {"MODEL_API_KEY": "private-test-key", "HERMES_HOME": home}):
                with patch.object(search, "urlopen", return_value=stream(*events)) as opened:
                    result = json.loads(search.handle_search({"query": "Find current local market sources with links"}))
                    request = opened.call_args.args[0]
                    receipts = list((Path(home) / "plugin-data/saleads-meta-search/receipts").glob("*.json"))
                    receipt = json.loads(receipts[0].read_text()) if receipts else None
        return result, request, receipt

    def test_exact_spark_hosted_search_request_and_citations(self):
        result, request, receipt = self.run_tool(completed())
        payload = json.loads(request.data)
        self.assertEqual(request.full_url, "https://api.meta.ai/v1/responses")
        self.assertEqual(payload["model"], "muse-spark-1.3-contributor")
        self.assertEqual(payload["tools"], [{"type": "web_search", "search_context_size": "medium"}])
        self.assertEqual(payload["reasoning"], {"effort": "medium"})
        self.assertEqual((payload["stream"], payload["max_output_tokens"], payload["temperature"], payload["top_p"]), (True, 32000, 1, 1))
        self.assertEqual(result["status"], "completed")
        self.assertIn("Bogotá", result["text"])
        self.assertEqual(result["search_calls"], 1)
        self.assertEqual(result["citations"][0]["url"], "https://example.org/research")
        self.assertEqual(receipt["response_id"], "resp_test")
        self.assertNotIn("query", receipt)
        self.assertNotIn("private-test-key", json.dumps(result) + json.dumps(receipt))

    def test_relay_receives_hosted_search_with_same_model_and_own_credential(self):
        with patch.dict(os.environ, {"META_BASE_URL": "https://relay.example/api/meta-assistant-inference/v1/"}):
            result, request, _ = self.run_tool(completed())
        self.assertEqual(request.full_url, "https://relay.example/api/meta-assistant-inference/v1/responses")
        self.assertEqual(request.get_header("Authorization"), "Bearer private-test-key")
        self.assertEqual(json.loads(request.data)["model"], search.MODEL)
        self.assertEqual(json.loads(request.data)["tools"][0]["type"], "web_search")
        self.assertEqual(result["status"], "completed")

    def test_invalid_relay_base_never_sends_the_credential(self):
        for base in ("http://relay.example/v1", "https://user:secret@relay.example/v1",
                     "https://relay.example/v1?key=secret", "https://relay.example/v1#fragment",
                     "https://relay.example/not-responses", ""):
            with self.subTest(base=base), patch.dict(os.environ, {"META_BASE_URL": base,
                    "MODEL_API_KEY": "private-test-key"}), patch.object(search, "urlopen") as opened:
                result = json.loads(search.handle_search({"query": "Current market research"}))
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error"]["code"], "META_BASE_URL_INVALID")
                opened.assert_not_called()

    def test_receipt_uses_native_worker_attempt_identity(self):
        with patch.dict(os.environ, {"HERMES_KANBAN_TASK":"task-real", "HERMES_KANBAN_RUN_ID":"42", "HERMES_TENANT":"11111111-1111-4111-8111-111111111111"}):
            _, _, receipt = self.run_tool(completed())
        self.assertEqual(receipt["native_task_id"], "task-real")
        self.assertEqual(receipt["native_run_id"], "42")
        self.assertEqual(receipt["business_id"], "11111111-1111-4111-8111-111111111111")

    def test_actual_search_and_supported_citations_required(self):
        for event, code in [(completed(searched=False), "SEARCH_NOT_EXECUTED"), (completed(citations=False), "SEARCH_CITATIONS_MISSING")]:
            with self.subTest(code=code):
                result, _, _ = self.run_tool(event)
                self.assertEqual(result["error"]["code"], code)
                self.assertEqual(result["status"], "failed")

    def test_partial_or_provider_error_is_never_success(self):
        for event in [{"type": "response.output_text.delta", "delta": "partial"}, {"type": "error", "error": {"message": "private-test-key"}}, {"type": "response.incomplete"}]:
            result, _, _ = self.run_tool(event)
            self.assertEqual(result["status"], "failed")
            self.assertNotIn("private-test-key", json.dumps(result))

    def test_invalid_query_and_missing_key_do_not_call_provider(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(search, "urlopen") as opened:
            self.assertEqual(json.loads(search.handle_search({"query": ""}))["error"]["code"], "INVALID_QUERY")
            self.assertEqual(json.loads(search.handle_search({"query": "Research"}))["error"]["code"], "META_KEY_MISSING")
            opened.assert_not_called()

    def test_sse_multiline_utf8_and_unsafe_citation_filtered(self):
        event = completed()
        event["response"]["output"][1]["content"][0]["annotations"].append({"type": "url_citation", "url": "file:///etc/passwd"})
        result, _, _ = self.run_tool({"type": "response.web_search_call.completed", "item_id": "ws_1"}, event)
        self.assertEqual(len(result["citations"]), 1)


if __name__ == "__main__":
    unittest.main()
