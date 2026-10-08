import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from support import CONFIG, SECRET, SECRET2, URL, FakeAuth, FakeTransport, payload
from xing_alerts.auth import Authenticator, Unauthorized
from xing_alerts.config import RESOURCE, EVENT_NAME
from xing_alerts.delivery import Verifier, Worker
from xing_alerts.outbox import Store
from xing_alerts.privacy import normalize
from xing_alerts.protocol import Protocol, RPCError


class AuthTests(unittest.IsolatedAsyncioTestCase):
    async def test_token_resource_scope_expiry_and_current_project_required(self):
        provider = SimpleNamespace(load_access_token=AsyncMock())
        allowed = AsyncMock(return_value=True)
        auth = Authenticator(provider, CONFIG, allowed, lambda: 1000)
        token = SimpleNamespace(
            client_id="12", resource=RESOURCE, scopes=["event:read"], expires_at=2000
        )
        provider.load_access_token.return_value = token
        self.assertEqual((await auth.authenticate("test")).owner, "12")
        allowed.assert_awaited_once_with("12", CONFIG)
        for attr, bad in [
            ("resource", None),
            ("resource", "https://other/mcp"),
            ("scopes", ["event:write"]),
            ("scopes", ["event:read", "event:write"]),
            ("expires_at", None),
            ("expires_at", 999),
            ("expires_at", float("nan")),
            ("client_id", "nonnumeric"),
        ]:
            original = getattr(token, attr)
            setattr(token, attr, bad)
            with self.subTest(attr=attr, bad=bad), self.assertRaises(Unauthorized):
                await auth.authenticate("test")
            setattr(token, attr, original)
        allowed.return_value = False
        with self.assertRaises(Unauthorized):
            await auth.authenticate("test")
        provider.load_access_token.return_value = None
        with self.assertRaises(Unauthorized):
            await auth.authenticate("test")


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = [1000]
        self.store = Store(Path(self.tmp.name) / "state.db", "dummy-key")
        self.auth = FakeAuth(lambda: self.now[0])
        self.transport = FakeTransport()
        self.verifier = Verifier(self.transport, lambda: self.now[0])
        self.protocol = Protocol(
            CONFIG, self.store, self.auth, self.verifier, lambda: self.now[0]
        )

    async def asyncTearDown(self):
        self.store.close()
        self.tmp.cleanup()

    async def rpc(self, method, params=None):
        return await self.protocol.dispatch(method, params or {}, "test-bearer")

    def params(self, secret=SECRET, ttl=100000):
        return {
            "name": EVENT_NAME,
            "arguments": {"projectId": 3},
            "delivery": {"mode": "webhook", "url": URL, "secret": secret},
            "ttlMs": ttl,
        }

    async def test_every_method_requires_auth_and_narrow_catalog(self):
        for method in [
            "server/discover",
            "events/list",
            "tools/list",
            "tools/call",
            "initialize",
            "ping",
            "unknown",
        ]:
            self.auth.allowed = False
            with self.subTest(method=method), self.assertRaises(Unauthorized):
                await self.rpc(method)
        self.auth.allowed = True
        discover = await self.rpc("server/discover")
        self.assertEqual(discover["supportedVersions"], ["2026-07-28"])
        tools = await self.rpc("tools/list")
        self.assertEqual(
            [t["name"] for t in tools["tools"]], ["get_alert_delivery_status"]
        )
        with self.assertRaises(RPCError):
            await self.rpc("tools/call", {"name": "delete_issue", "arguments": {}})

    async def test_subscribe_refresh_rotation_expiry_and_unsubscribe_identity(self):
        first = await self.rpc("events/subscribe", self.params())
        self.assertEqual(first["refreshBefore"], "1970-01-01T00:18:20Z")
        await self.rpc("events/subscribe", self.params(SECRET2))
        self.assertEqual(self.store.get_subscription(first["id"])["old_secret"], SECRET)
        self.assertEqual(len(self.transport.calls), 2)
        args = self.params()
        args["delivery"].pop("secret")
        args.pop("ttlMs")
        self.assertEqual(await self.rpc("events/unsubscribe", args), {})
        self.assertFalse(self.store.get_subscription(first["id"])["active"])
        self.assertEqual(await self.rpc("events/unsubscribe", args), {})

    async def test_strict_scope_args_and_finite_token_bounded_ttl(self):
        for changed in [
            {"arguments": {"projectId": 8}},
            {"arguments": {"projectId": 3, "other": "private"}},
            {"arguments": {"projectId": True}},
            {"ttlMs": -1},
            {"ttlMs": "1000"},
            {"ttlMs": float("inf")},
            {"cursor": "history"},
            {"name": "other.event"},
        ]:
            params = self.params()
            params.update(changed)
            with self.subTest(changed=changed), self.assertRaises(RPCError):
                await self.rpc("events/subscribe", params)
        for ttl in [None, 999999999]:
            result = await self.rpc("events/subscribe", self.params(ttl=ttl))
            self.assertEqual(result["refreshBefore"], "1970-01-01T01:16:40Z")
        self.transport.bad_challenge = True
        params = self.params()
        params["delivery"]["url"] = "https://other.example/callback"
        with self.assertRaises(RPCError) as failure:
            await self.rpc("events/subscribe", params)
        self.assertEqual(failure.exception.code, -32015)
        self.assertEqual(failure.exception.data, {"reason": "challenge_failed"})

    async def test_worker_revalidates_revoke_rotation_restart_retries(self):
        result = await self.rpc("events/subscribe", self.params(ttl=None))
        self.store.enqueue(normalize(payload(), CONFIG, self.now[0]), self.now[0])
        worker = Worker(self.store, self.auth, self.transport, lambda: self.now[0])
        self.transport.statuses = [500, 200]
        await worker.once()
        first = self.transport.calls[-1]
        self.assertEqual(json.loads(first[1])["eventId"], first[2]["webhook-id"])
        self.now[0] += 31
        await self.rpc("events/subscribe", self.params(SECRET2, ttl=None))
        await worker.once()
        second = self.transport.calls[-1]
        self.assertEqual(first[2]["webhook-id"], second[2]["webhook-id"])
        self.assertNotEqual(
            first[2]["webhook-timestamp"], second[2]["webhook-timestamp"]
        )
        self.assertEqual(len(second[2]["webhook-signature"].split()), 2)
        self.store.enqueue(normalize(payload(43), CONFIG, self.now[0]), self.now[0])
        self.auth.allowed = False
        count = len(self.transport.calls)
        await worker.once()
        self.assertEqual(len(self.transport.calls), count)
        self.assertFalse(self.store.get_subscription(result["id"])["active"])

    async def test_413_no_retry_and_bounded_transient_attempts(self):
        await self.rpc("events/subscribe", self.params(ttl=None))
        self.store.enqueue(normalize(payload(), CONFIG, self.now[0]), self.now[0])
        worker = Worker(self.store, self.auth, self.transport, lambda: self.now[0])
        self.transport.statuses = [413]
        await worker.once()
        self.assertIsNone(self.store.next_due(self.now[0] + 1000))
        self.store.enqueue(normalize(payload(43), CONFIG, self.now[0]), self.now[0])
        for _ in range(6):
            self.transport.statuses = [503]
            await worker.once()
            self.now[0] += 601
        self.assertIsNone(self.store.next_due(self.now[0]))
