import unittest
import json
from xing_alerts.config import RESOURCE
from xing_alerts.oauth import RefreshCodec, InvalidRefresh, read_access_data


class AccessDataTests(unittest.TestCase):
    def test_distinct_client_and_owner_and_fail_closed_native_cache(self):
        data = {
            "client_id": "oauth-client-abc",
            "user_id": 12,
            "resource": RESOURCE,
            "scopes": ["event:read"],
            "expires_at": 2000,
        }
        loaded = read_access_data(json.dumps(data), 1000)
        self.assertEqual(loaded["client_id"], "oauth-client-abc")
        self.assertEqual(loaded["user_id"], "12")
        for field, bad in [
            ("client_id", None),
            ("client_id", ""),
            ("user_id", True),
            ("user_id", 0),
            ("user_id", "not-a-user"),
            ("resource", None),
            ("resource", RESOURCE + "/other"),
            ("scopes", ["event:write"]),
            ("expires_at", True),
            ("expires_at", float("nan")),
            ("expires_at", 1000),
        ]:
            with self.subTest(field=field, bad=bad):
                self.assertIsNone(
                    read_access_data(json.dumps({**data, field: bad}), 1000)
                )
        for raw in [None, "{", "[]", "null"]:
            self.assertIsNone(read_access_data(raw, 1000))


class RefreshCodecTests(unittest.TestCase):
    def test_resource_client_expiry_encrypted_binding_survives_restart(self):
        codec = RefreshCodec("dummy-secret")
        wire = codec.wrap("native-refresh-secret", "client-one", 2000)
        self.assertNotIn("native-refresh-secret", wire)
        self.assertEqual(
            RefreshCodec("dummy-secret").unwrap(wire, "client-one", 1000),
            "native-refresh-secret",
        )
        for value, client, at in [
            (wire, "client-two", 1000),
            (wire, "client-one", 2000),
            ("native-refresh-secret", "client-one", 1000),
            (wire[:-4] + "abcd", "client-one", 1000),
        ]:
            with self.subTest(client=client, at=at), self.assertRaises(InvalidRefresh):
                codec.unwrap(value, client, at)
        with self.assertRaises(InvalidRefresh):
            RefreshCodec("different-secret").unwrap(wire, "client-one", 1000)

    def test_other_resource_cannot_be_rebound(self):
        codec = RefreshCodec("dummy-secret")
        from xing_alerts.outbox import canonical

        hostile = (
            "xing_rt_"
            + codec.cipher.encrypt(
                canonical(
                    {
                        "token": "native",
                        "client": "client-one",
                        "resource": "https://other/mcp",
                        "expires": 2000,
                    }
                ).encode()
            ).decode()
        )
        with self.assertRaises(InvalidRefresh):
            codec.unwrap(hostile, "client-one", 1000)
