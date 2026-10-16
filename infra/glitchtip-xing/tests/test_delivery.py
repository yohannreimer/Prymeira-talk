import asyncio
import base64
import hashlib
import hmac
import socket
import unittest
from unittest.mock import patch, AsyncMock
from support import SECRET, SECRET2, URL, FakeTransport
from xing_alerts.delivery import (
    sign_headers,
    decode_secret,
    validate_url,
    PublicResolver,
    CallbackError,
    Verifier,
    SafeTransport,
)


class SigningTests(unittest.TestCase):
    def test_signature_matches_independent_hmac_and_rotation(self):
        body = b'{"x":"exact bytes"}'
        headers = sign_headers("evt_1", "sub_1", body, 1000, [SECRET, SECRET2])
        expected = []
        for key in [b"a" * 32, b"b" * 32]:
            expected.append(
                "v1,"
                + base64.b64encode(
                    hmac.new(key, b"evt_1.1000." + body, hashlib.sha256).digest()
                ).decode()
            )
        self.assertEqual(headers["webhook-signature"], " ".join(expected))
        self.assertEqual(headers["webhook-id"], "evt_1")

    def test_secrets_and_urls_strict(self):
        for secret in [
            "wrong",
            "whsec_" + base64.b64encode(b"a" * 23).decode(),
            "whsec_" + base64.b64encode(b"a" * 65).decode(),
            SECRET + "\n",
        ]:
            with self.assertRaises(CallbackError):
                decode_secret(secret)
        for url in [
            "http://receiver.example/x",
            "https://user:pass@receiver.example/x",
            "https://receiver.example/x?auth=secret",
            "https://127.0.0.1/x",
            "https://[::ffff:8.8.8.8]/x",
            "https://receiver.example:444/x",
            "https://receiver.example/x#f",
        ]:
            with self.subTest(url=url), self.assertRaises(CallbackError):
                validate_url(url)


class DeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_transport_pins_dns_tls_no_redirect_proxy_or_decompression(self):
        addresses = [
            {
                "hostname": "receiver.example",
                "host": "8.8.8.8",
                "port": 443,
                "family": socket.AF_INET,
                "proto": 6,
                "flags": socket.AI_NUMERICHOST,
            }
        ]
        connector_options = []
        session_options = []
        post_options = []
        status = [302]
        chunks = [b"{}"]

        class Response:
            @property
            def status(self):
                return status[0]

            @property
            def content(self):
                return self

            async def iter_chunked(self, size):
                for chunk in chunks:
                    yield chunk

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

        class Session:
            def __init__(self, **kwargs):
                session_options.append(kwargs)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            def post(self, url, **kwargs):
                post_options.append((url, kwargs))
                return Response()

        def connector(**kwargs):
            connector_options.append(kwargs)
            return object()

        with (
            patch(
                "xing_alerts.delivery.PublicResolver.resolve",
                new=AsyncMock(return_value=addresses),
            ) as resolver,
            patch("xing_alerts.delivery.aiohttp.TCPConnector", side_effect=connector),
            patch("xing_alerts.delivery.aiohttp.ClientSession", Session),
        ):
            transport = SafeTransport()
            with self.assertRaises(CallbackError) as rejected:
                await transport.post(URL, b"{}", {})
            self.assertEqual(rejected.exception.reason, "redirect_blocked")
            status[0] = 200
            self.assertEqual(await transport.post(URL, b"{}", {}), (200, b"{}"))
            chunks[:] = [b"x" * 40000, b"x" * 30000]
            with self.assertRaises(CallbackError):
                await transport.post(URL, b"{}", {})
            self.assertEqual(resolver.await_count, 3)
        self.assertFalse(connector_options[0]["use_dns_cache"])
        self.assertTrue(connector_options[0]["force_close"])
        self.assertTrue(connector_options[0]["ssl"])
        self.assertFalse(session_options[0]["trust_env"])
        self.assertFalse(session_options[0]["auto_decompress"])
        self.assertFalse(post_options[0][1]["allow_redirects"])
        self.assertEqual(post_options[0][1]["server_hostname"], "receiver.example")
        self.assertEqual(
            await connector_options[0]["resolver"].resolve("receiver.example", 443),
            addresses,
        )

    async def test_dns_all_answers_checked_each_connection(self):
        resolver = PublicResolver()
        loop = asyncio.get_running_loop()

        def records(addresses):
            return [
                (
                    socket.AF_INET6 if ":" in ip else socket.AF_INET,
                    socket.SOCK_STREAM,
                    6,
                    "",
                    (ip, 443),
                )
                for ip in addresses
            ]

        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.1",
            "224.0.0.1",
            "::1",
            "::ffff:8.8.8.8",
            "100.64.0.1",
        ]:
            with patch.object(
                loop, "getaddrinfo", return_value=records(["8.8.8.8", address])
            ):
                with self.subTest(address=address), self.assertRaises(CallbackError):
                    await resolver.resolve("receiver.example", 443)
        with patch.object(
            loop, "getaddrinfo", return_value=records(["8.8.8.8"])
        ) as lookup:
            resolved = await resolver.resolve("receiver.example", 443)
            await resolver.resolve("receiver.example", 443)
            self.assertEqual(lookup.call_count, 2)
            self.assertEqual(resolved[0]["host"], "8.8.8.8")
            self.assertEqual(resolved[0]["hostname"], "receiver.example")

    async def test_challenge_cache_principal_and_secret_rotation(self):
        transport = FakeTransport()
        now = [1000]
        verifier = Verifier(transport, lambda: now[0])
        await verifier.verify("12", "sub", URL, SECRET)
        await verifier.verify("12", "sub", URL, SECRET)
        self.assertEqual(len(transport.calls), 1)
        await verifier.verify("12", "sub", URL, SECRET2)
        self.assertEqual(len(transport.calls), 2)
        await verifier.verify("13", "other-sub", URL, SECRET2)
        self.assertEqual(len(transport.calls), 3)
        now[0] += 301
        await verifier.verify("12", "sub", URL, SECRET2)
        self.assertEqual(len(transport.calls), 4)
        transport.bad_challenge = True
        with self.assertRaises(CallbackError):
            await verifier.verify("14", "sub", URL, SECRET)
        self.assertNotEqual(
            transport.calls[0][2]["webhook-id"], transport.calls[1][2]["webhook-id"]
        )
