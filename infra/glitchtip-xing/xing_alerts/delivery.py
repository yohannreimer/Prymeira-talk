"""Standard Webhooks transport. DNS is checked and pinned on every attempt."""

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import socket
import time
import uuid
from urllib.parse import urlsplit
import aiohttp
from aiohttp.abc import AbstractResolver
from .outbox import canonical


class CallbackError(ValueError):
    def __init__(self, reason="invalid_destination"):
        self.reason = reason
        super().__init__(reason)


def decode_secret(secret):
    if not isinstance(secret, str) or not re.fullmatch(
        r"whsec_[A-Za-z0-9+/]+={0,2}", secret
    ):
        raise CallbackError("invalid_secret")
    try:
        decoded = base64.b64decode(secret[6:], validate=True)
    except ValueError:
        raise CallbackError("invalid_secret") from None
    if not 24 <= len(decoded) <= 64:
        raise CallbackError("invalid_secret")
    return decoded


def public_ip(address):
    try:
        ip = ipaddress.ip_address(address)
        return (
            ip.is_global
            and not ip.is_multicast
            and not ip.is_reserved
            and not ip.is_unspecified
            and not ip.is_loopback
            and not ip.is_link_local
            and not (
                isinstance(ip, ipaddress.IPv6Address)
                and (ip.ipv4_mapped or ip.sixtofour or ip.teredo)
            )
        )
    except ValueError:
        return False


def validate_url(url):
    if (
        not isinstance(url, str)
        or len(url) > 2048
        or any(ord(c) <= 32 or ord(c) > 126 for c in url)
        or "\\" in url
    ):
        raise CallbackError()
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise CallbackError() from None
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.query
        or parts.fragment
        or port not in (None, 443)
    ):
        raise CallbackError()
    host = parts.hostname
    # Hostnames or public literals only. Local hostnames fail before any network.
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if (
            not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?", host)
            or "." not in host
            or ".." in host
            or host.endswith((".localhost", ".local", ".internal", ".home", ".invalid"))
        ):
            raise CallbackError()
    else:
        if not public_ip(host):
            raise CallbackError("non_public_address")
    return host


class PublicResolver(AbstractResolver):
    async def resolve(self, host, port=443, family=socket.AF_UNSPEC):
        try:
            records = await asyncio.get_running_loop().getaddrinfo(
                host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM
            )
        except OSError:
            raise CallbackError("dns_failed") from None
        if not records or len(records) > 64:
            raise CallbackError("non_public_address")
        if any(not public_ip(record[4][0]) for record in records):
            raise CallbackError("non_public_address")
        unique = {}
        for af, _, proto, _, address in records:
            ip = address[0]
            unique[ip] = {
                "hostname": host,
                "host": ip,
                "port": port,
                "family": af,
                "proto": proto,
                "flags": socket.AI_NUMERICHOST,
            }
        return list(unique.values())

    async def close(self):
        pass


def sign_headers(eid, sid, body, timestamp, keys):
    signed = eid.encode() + b"." + str(int(timestamp)).encode() + b"." + body
    signatures = [
        "v1,"
        + base64.b64encode(
            hmac.new(decode_secret(key), signed, hashlib.sha256).digest()
        ).decode()
        for key in keys
    ]
    return {
        "Content-Type": "application/json",
        "webhook-id": eid,
        "webhook-timestamp": str(int(timestamp)),
        "webhook-signature": " ".join(signatures),
        "X-MCP-Subscription-Id": sid,
    }


class SafeTransport:
    async def post(self, url, body, headers):
        host = validate_url(url)
        # Pre-resolve even literals (aiohttp otherwise bypasses resolver for them).
        resolved = await PublicResolver().resolve(host, 443)

        class PinnedResolver(AbstractResolver):
            async def resolve(self, hostname, port=443, family=socket.AF_UNSPEC):
                if hostname != host or port != 443:
                    raise CallbackError()
                return resolved

            async def close(self):
                pass

        connector = aiohttp.TCPConnector(
            resolver=PinnedResolver(),
            use_dns_cache=False,
            force_close=True,
            limit=1,
            ssl=True,
        )
        try:
            async with aiohttp.ClientSession(
                connector=connector,
                trust_env=False,
                auto_decompress=False,
                skip_auto_headers={"Accept-Encoding"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as session:
                # URL hostname is retained for certificate/SNI, resolved addresses are pinned.
                async with session.post(
                    url,
                    data=body,
                    headers=headers,
                    allow_redirects=False,
                    server_hostname=host,
                ) as response:
                    data = bytearray()
                    async for chunk in response.content.iter_chunked(8192):
                        data.extend(chunk)
                        if len(data) > 65536:
                            raise CallbackError("response_too_large")
                    if 300 <= response.status < 400:
                        raise CallbackError("redirect_blocked")
                    return response.status, bytes(data)
        except CallbackError:
            raise
        except TimeoutError:
            raise CallbackError("timeout") from None
        except (aiohttp.ClientError, OSError):
            raise CallbackError("transport_failed") from None


class Verifier:
    def __init__(self, transport, now=time.time):
        self.transport = transport
        self.now = now
        self.cache = {}

    async def verify(self, owner, sid, url, secret):
        validate_url(url)
        decode_secret(secret)
        # Secret included so a key rotation always challenges again.
        key = hashlib.sha256(canonical([owner, url, secret]).encode()).hexdigest()
        at = self.now()
        self.cache = {k: v for k, v in self.cache.items() if v > at}
        if self.cache.get(key, 0) > at:
            return
        challenge = secrets.token_urlsafe(32)
        body = canonical({"type": "verification", "challenge": challenge}).encode()
        eid = "msg_verification_" + uuid.uuid4().hex
        try:
            async with asyncio.timeout(10):
                status, response = await self.transport.post(
                    url, body, sign_headers(eid, sid, body, at, [secret])
                )
        except TimeoutError:
            raise CallbackError("timeout") from None
        if len(response) > 65536:
            raise CallbackError("response_too_large")
        try:
            returned = json.loads(response).get("challenge")
        except (ValueError, AttributeError):
            returned = None
        if (
            not 200 <= status < 300
            or not isinstance(returned, str)
            or not hmac.compare_digest(returned.encode(), challenge.encode())
        ):
            raise CallbackError("challenge_failed")
        if len(self.cache) >= 100:
            self.cache.pop(next(iter(self.cache)))
        self.cache[key] = self.now() + 300


class Worker:
    def __init__(self, store, auth, transport, now=time.time):
        self.store = store
        self.auth = auth
        self.transport = transport
        self.now = now
        self.wake = asyncio.Event()

    async def once(self):
        from .auth import Unauthorized

        item = self.store.next_due(self.now())
        if not item:
            return False
        sub = self.store.get_subscription(item["subscription_id"])
        if not sub or not sub["active"] or sub["expires"] <= self.now():
            return True
        try:
            principal = await self.auth.authenticate(sub["bearer"])
            if principal.owner != sub["owner"]:
                raise Unauthorized()
        except Unauthorized:
            self.store.deactivate(sub["id"], sub["owner"])
            return True
        # Authentication awaited: unsubscribe/refresh might have run in the meantime.
        current = self.store.get_subscription(sub["id"])
        if not current or not current["active"] or current["expires"] <= self.now():
            return True
        if current["bearer"] != sub["bearer"]:
            return True
        body = canonical(item["event"]).encode()
        keys = [current["secret"]]
        if current["old_secret"] and current["old_until"] > self.now():
            keys.append(current["old_secret"])
        if not self.store.begin_attempt(item, self.now()):
            return True
        try:
            async with asyncio.timeout(10):
                status, _ = await self.transport.post(
                    current["url"],
                    body,
                    sign_headers(item["event_id"], sub["id"], body, self.now(), keys),
                )
        except (CallbackError, TimeoutError):
            status = 0
        self.store.finish(item, status, self.now())
        return True

    async def run(self):
        import logging

        logger = logging.getLogger("xing_alerts")
        while True:
            try:
                if await self.once():
                    await asyncio.sleep(
                        0.1
                    )  # At most one delivery in flight; burst CPU bounded.
                    continue
            except asyncio.CancelledError:
                raise
            except Exception:
                # Never log exception text (libraries may embed destination or bearer).
                logger.warning("xing_bridge_worker_failure")
            self.wake.clear()
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=30)
            except TimeoutError:
                pass
