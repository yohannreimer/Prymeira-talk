import copy
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from support import CONFIG, SECRET, URL, PRIVATE, payload, FakeAuth, FakeTransport
from xing_alerts.diagnostics import CONTRACT, TAG_NAMES, schema
from xing_alerts.privacy import normalize
from xing_alerts.outbox import Store
from xing_alerts.delivery import Worker


def technical_payload():
    data = payload()
    tags = {"diagnostic_version": "1", "error_type": "TypeError", "technical_cause": "prisma_proxy_invariant",
            "component": "agents", "operation": "run_for_message", "diagnostic_location": "modules/agents/agent-runtime.ts",
            "diagnostic_frame_0": "modules/agents/agent-runtime.ts:1539:27", "cause_type_0": "WahaClientError",
            "cause_code_0": "WAHA_HTTP_500", "correlation_id": "op_" + "a" * 32,
            "impact": "operation_failed", "recovery": "unknown"}
    for field in data["attachments"][0]["fields"]:
        if field["title"] == "Failure_point":
            field["value"] = "agent_runtime"
        if field["title"] == "Failure_code":
            field["value"] = "PRISMA_PROXY_OWN_KEYS"
    data["attachments"][0]["fields"].extend({"title": k.capitalize(), "value": v} for k, v in tags.items())
    return data


class DiagnosticTests(unittest.IsolatedAsyncioTestCase):
    def test_native_diagnostic_is_rebuilt_and_legacy_is_unchanged(self):
        self.assertNotIn("diagnostic", normalize(payload(), CONFIG, 1000)[0])
        alert = normalize(technical_payload(), CONFIG, 1000)[0]
        self.assertEqual(alert["diagnostic"], {
            "version": 1, "type": "TypeError", "code": "PRISMA_PROXY_OWN_KEYS", "technical_cause": "prisma_proxy_invariant",
            "technical_summary": CONTRACT["causeDescriptions"]["prisma_proxy_invariant"],
            "component": "agents", "operation": "run_for_message", "location": "modules/agents/agent-runtime.ts",
            "frames": [{"filename": "modules/agents/agent-runtime.ts", "lineno": 1539, "colno": 27}],
            "causes": [{"type": "WahaClientError", "code": "WAHA_HTTP_500", "technical_cause": "provider_http_failure", "technical_summary": CONTRACT["causeDescriptions"]["provider_http_failure"]}],
            "correlation_id": "op_" + "a" * 32, "impact": "operation_failed", "recovery": "unknown",
        })
        self.assertNotIn(PRIVATE, json.dumps(alert))
        self.assertLessEqual(len(technical_payload()["attachments"][0]["fields"]), 32)
        self.assertEqual(set(schema()["required"]), set(alert["diagnostic"]))

    def test_hostile_diagnostics_do_not_reintroduce_customer_data_or_claim_recovery(self):
        for name in TAG_NAMES:
            data = technical_payload()
            for field in data["attachments"][0]["fields"]:
                if field["title"] == name.capitalize() and name != "diagnostic_version":
                    field["value"] = PRIVATE
            self.assertNotIn(PRIVATE, json.dumps(normalize(data, CONFIG, 1000)))
        data = technical_payload()
        data["attachments"][0]["fields"].extend([
            {"title": "Diagnostic_frame_1", "value": "/private/customer/app.ts:4:2"},
            {"title": "Diagnostic_frame_2", "value": "../app.ts:1:2"},
            {"title": "Diagnostic_frame_3", "value": "app.ts?token=private:1:2"},
        ])
        diagnostic = normalize(data, CONFIG, 1000)[0]["diagnostic"]
        self.assertEqual(len(diagnostic["frames"]), 1)
        self.assertEqual(diagnostic["recovery"], "unknown")

    async def test_diagnostic_survives_persistence_signed_fake_callback_and_dedup(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "state.sqlite3", "dummy-key")
            try:
                store.subscribe("sub-test", "12", URL, SECRET, "test-bearer", 2000, 1000)
                alert = normalize(technical_payload(), CONFIG, 1000)
                self.assertEqual(store.enqueue(alert, 1000), 1)
                changed_correlation = copy.deepcopy(alert)
                changed_correlation[0]["diagnostic"]["correlation_id"] = "op_" + "b" * 32
                self.assertEqual(store.enqueue(changed_correlation, 1001), 0)
                changed_code = copy.deepcopy(alert)
                changed_code[0]["diagnostic"]["causes"][0]["code"] = "WAHA_HTTP_503"
                self.assertEqual(store.enqueue(changed_code, 1001), 1)
                transport = FakeTransport()
                worker = Worker(store, FakeAuth(lambda: 1000), transport, lambda: 1000)
                await worker.once()
                sent = json.loads(transport.calls[0][1])
                self.assertEqual(sent["data"]["diagnostic"], alert[0]["diagnostic"])
                self.assertIn("webhook-signature", transport.calls[0][2])
                self.assertEqual(store.status("12", 1000)["accepted"], 1)
                self.assertNotIn(PRIVATE, json.dumps(sent))
            finally:
                store.close()

    def test_status_is_select_only_even_with_expired_work_and_old_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "state.sqlite3", "dummy-key")
            try:
                store.subscribe("sub-test", "12", URL, SECRET, "test-bearer", 1001, 1000)
                store.enqueue(normalize(payload(), CONFIG, 1000), 1000)
                before = list(store.db.iterdump())
                # SQLite enforces the read-only contract instead of trusting a mock.
                store.db.execute("PRAGMA query_only=ON")
                queries = []
                store.db.set_trace_callback(queries.append)
                self.assertEqual(store.status("12", 1002), {"pending": 0, "accepted": 0, "failed": 0, "cancelled": 1, "activeSubscriptions": 0})
                self.assertEqual(store.status("12", 1000 + 8 * 86400)["cancelled"], 0)
                store.db.set_trace_callback(None)
                self.assertTrue(all(q.lstrip().upper().startswith("SELECT") for q in queries))
                self.assertEqual(list(store.db.iterdump()), before)
            finally:
                store.close()
