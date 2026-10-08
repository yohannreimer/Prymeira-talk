import asyncio
import json
import tempfile
import unittest
from unittest.mock import patch
from dataclasses import replace
from pathlib import Path
from support import CONFIG, PRIVATE, MODERN_META, payload, FakeAuth, FakeTransport
from xing_alerts.asgi import Bridge
from xing_alerts.delivery import Verifier, Worker
from xing_alerts.outbox import Store
from xing_alerts.protocol import Protocol


class ASGITests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "state.db", "key")
        self.config = replace(CONFIG, webhook_token="a" * 43)
        self.auth = FakeAuth(lambda: 1000)
        self.transport = FakeTransport()
        self.protocol = Protocol(
            self.config,
            self.store,
            self.auth,
            Verifier(self.transport, lambda: 1000),
            lambda: 1000,
        )
        self.original_calls = []

        async def original(scope, receive, send):
            self.original_calls.append(
                scope["path"] if scope["type"] == "http" else "lifespan"
            )
            if scope["type"] == "lifespan":
                self.assertEqual((await receive())["type"], "lifespan.startup")
                await send({"type": "lifespan.startup.complete"})
                self.assertEqual((await receive())["type"], "lifespan.shutdown")
                await send({"type": "lifespan.shutdown.complete"})
            else:
                await send(
                    {"type": "http.response.start", "status": 201, "headers": []}
                )
                await send({"type": "http.response.body", "body": b"original"})

        self.worker = Worker(self.store, self.auth, self.transport, lambda: 1000)
        self.bridge = Bridge(
            original, self.config, self.protocol, self.store, self.worker, lambda: 1000
        )

    async def asyncTearDown(self):
        self.store.close()
        self.tmp.cleanup()

    async def request(self, path, body=b"", headers=None, method="POST"):
        output = []
        messages = asyncio.Queue()
        await messages.put({"type": "http.request", "body": body, "more_body": False})
        await self.bridge(
            {"type": "http", "path": path, "method": method, "headers": headers or []},
            messages.get,
            self.sender(output),
        )
        return (
            output[0]["status"],
            json.loads(output[-1]["body"])
            if output[-1]["body"].startswith(b"{")
            else output[-1]["body"],
            output,
        )

    def sender(self, output):
        async def send(msg):
            output.append(msg)

        return send

    async def test_auth_401_metadata_and_no_private_definitions(self):
        status, data, output = await self.request(
            "/mcp",
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "events/list"}).encode(),
        )
        self.assertEqual(status, 401)
        self.assertNotIn("events", data)
        self.assertIn(
            "resource_metadata",
            dict(output[0]["headers"])[b"www-authenticate"].decode(),
        )

    async def test_webhook_auth_size_privacy_and_unrelated_paths(self):
        body = json.dumps(payload()).encode()
        self.assertEqual(
            (await self.request("/xing-alerts/webhook/wrong", body))[0], 404
        )
        self.assertEqual(
            (await self.request("/xing-alerts/webhook/" + "a" * 43, b"x" * 65537))[0],
            413,
        )
        self.assertEqual(
            (await self.request("/xing-alerts/webhook/" + "a" * 43, body))[0], 202
        )
        self.assertNotIn(
            PRIVATE, self.store.db.execute("SELECT body FROM events").fetchone()[0]
        )
        self.assertEqual((await self.request("/api/0/ingest", b"anything"))[0], 201)
        self.assertEqual((await self.request("/mcp/authorize", b""))[0], 201)

    async def test_lifespan_preserves_original_and_stops_bridge_worker(self):
        incoming = asyncio.Queue()
        out = []
        await incoming.put({"type": "lifespan.startup"})
        await incoming.put({"type": "lifespan.shutdown"})
        await self.bridge({"type": "lifespan"}, incoming.get, self.sender(out))
        self.assertEqual(
            out,
            [
                {"type": "lifespan.startup.complete"},
                {"type": "lifespan.shutdown.complete"},
            ],
        )
        self.assertEqual(self.original_calls, ["lifespan"])
        self.assertIsNone(self.bridge.worker_task)

    async def test_each_rpc_bearer_and_malformed_json(self):
        headers = [(b"authorization", b"Bearer test-bearer")]
        status, data, _ = await self.request(
            "/mcp",
            json.dumps(
                {"jsonrpc": "2.0", "id": 2, "method": "server/discover"}
            ).encode(),
            headers,
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["result"]["resultType"], "complete")
        self.assertEqual(
            (await self.request("/mcp", b"{", headers))[1]["error"]["code"], -32700
        )

    async def test_modern_metadata_discovery_and_status_through_http(self):
        for method, params in [
            ("server/discover", {}), ("events/list", {}),
            ("tools/call", {"name": "get_alert_delivery_status", "arguments": {}}),
        ]:
            headers = [(b"authorization", b"Bearer test-bearer"),
                       (b"MCP-Protocol-Version", b"2026-07-28"),
                       (b"Mcp-Method", method.encode())]
            if method == "tools/call":
                # Standard Base64 sentinel encoding is legal even for ASCII.
                headers.append((b"Mcp-Name", b"=?base64?Z2V0X2FsZXJ0X2RlbGl2ZXJ5X3N0YXR1cw==?="))
            body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                               "params": {**params, "_meta": MODERN_META}}).encode()
            status, data, _ = await self.request("/mcp", body, headers)
            self.assertEqual(status, 200)
            self.assertEqual(data["result"]["resultType"], "complete")

    async def test_modern_http_header_mismatch_and_unsupported_version(self):
        body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "get_alert_delivery_status", "arguments": {}, "_meta": MODERN_META}}
        base = [(b"authorization", b"Bearer test-bearer"),
                (b"mcp-protocol-version", b"2026-07-28"),
                (b"mcp-method", b"tools/call"),
                (b"mcp-name", b"get_alert_delivery_status")]
        for headers in [base[:1], base[:-1], base + [base[1]],
                        [*base[:2], (b"mcp-method", b"events/list"), base[3]],
                        [*base[:3], (b"mcp-name", b"different")],
                        [*base[:3], (b"mcp-name", b"=?base64?invalid!?=")],
                        [base[0], (b"mcp-protocol-version", b"2025-11-25"), *base[2:]]]:
            with self.subTest(headers=headers):
                status, data, _ = await self.request("/mcp", json.dumps(body).encode(), headers)
                self.assertEqual(status, 400)
                self.assertEqual(data["error"]["code"], -32020)
        body["params"]["_meta"] = {**MODERN_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01"}
        headers = [base[0], (b"mcp-protocol-version", b"1900-01-01"), *base[2:]]
        status, data, _ = await self.request("/mcp", json.dumps(body).encode(), headers)
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], -32022)

    async def test_diagnostics_bounded_shapes_only_after_authentication(self):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                           "params": {"name": PRIVATE, "arguments": {"private_key": PRIVATE},
                                      "_meta": {"private_key": PRIVATE}, "unknown_private_key": PRIVATE}}).encode()
        with self.assertLogs("xing_alerts", level="INFO") as captured:
            for _ in range(3):
                await self.request("/mcp", body, [(b"authorization", b"Bearer test-bearer")])
            await self.request("/mcp", body)
        self.assertEqual(len(captured.output), 1)
        self.assertNotIn(PRIVATE, str(captured.output))
        self.assertNotIn("private_key", str(captured.output))
        self.assertIn("unknown_count=1", str(captured.output))
        self.assertEqual(set(self.protocol.diagnostic_at), {"tools/call"})

    async def test_modern_unknown_method_and_missing_metadata_do_not_fall_back(self):
        base = [(b"authorization", b"Bearer test-bearer"),
                (b"mcp-protocol-version", b"2026-07-28"),
                (b"mcp-method", b"unsupported")]
        body = {"jsonrpc": "2.0", "id": 1, "method": "unsupported",
                "params": {"_meta": MODERN_META}}
        status, data, _ = await self.request("/mcp", json.dumps(body).encode(), base)
        self.assertEqual(status, 404)
        self.assertEqual(data["error"]["code"], -32601)
        body["params"] = {}
        status, data, _ = await self.request("/mcp", json.dumps(body).encode(), base)
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], -32020)

    async def test_explicit_unsupported_http_version_cannot_execute_as_legacy(self):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                           "params": {"name": "get_alert_delivery_status", "arguments": {}}}).encode()
        auth = (b"authorization", b"Bearer test-bearer")
        unsupported = (b"mcp-protocol-version", b"1900-01-01")
        with patch.object(self.store, "status", side_effect=AssertionError("Must not execute")):
            status, data, _ = await self.request("/mcp", body, [auth, unsupported])
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], -32022)
        for versions in [[unsupported, unsupported],
                         [(b"mcp-protocol-version", b"2025-11-25")] * 2,
                         [(b"mcp-protocol-version", b"invalid\xff")]]:
            status, data, _ = await self.request("/mcp", body, [auth, *versions])
            self.assertEqual(status, 400)
            self.assertEqual(data["error"]["code"], -32020)
        self.assertEqual((await self.request("/mcp", body, [auth]))[0], 200)
        self.assertEqual((await self.request("/mcp", body, [auth, (b"mcp-protocol-version", b"2025-11-25")]))[0], 200)

    async def test_persistence_failure_not_acknowledged_and_logs_only_category(self):
        with patch.object(self.store, "enqueue", side_effect=OSError(PRIVATE)):
            with self.assertLogs("xing_alerts", level="WARNING") as captured:
                status, data, _ = await self.request(
                    "/xing-alerts/webhook/" + "a" * 43, json.dumps(payload()).encode()
                )
        self.assertEqual(status, 503)
        self.assertNotIn(PRIVATE, json.dumps(data) + str(captured.output))
        self.assertIn("xing_bridge_persistence_unavailable", str(captured.output))
        self.assertEqual((await self.request("/api/0/ingest", b"original"))[0], 201)

    async def test_duplicate_keys_rejected_and_notification_no_response_body(self):
        headers = [(b"authorization", b"Bearer test-bearer")]
        status, data, _ = await self.request(
            "/mcp",
            b'{"jsonrpc":"2.0","id":1,"method":"ping","method":"tools/list"}',
            headers,
        )
        self.assertEqual(status, 400)
        status, data, _ = await self.request(
            "/mcp", b'{"jsonrpc":"2.0","method":"notifications/initialized"}', headers
        )
        self.assertEqual(status, 202)
        self.assertEqual(data, b"")
