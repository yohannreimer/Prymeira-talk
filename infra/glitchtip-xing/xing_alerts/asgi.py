"""Append-only ASGI wrapper. The original application's lifespan remains owner."""

import asyncio
import base64
import binascii
import hmac
import json
import logging
import time
from .auth import Unauthorized
from .config import RESOURCE, enabled
from .privacy import InvalidPayload, normalize
from .protocol import RPCError, MODERN_VERSION, LEGACY_VERSION, VERSION_KEY

logger = logging.getLogger("xing_alerts")


class BodyLimit(ValueError):
    pass


async def read_body(receive, maximum):
    body = bytearray()
    async with asyncio.timeout(10):
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                raise ValueError("disconnected")
            if message["type"] != "http.request":
                raise ValueError("invalid_message")
            body.extend(message.get("body", b""))
            if len(body) > maximum:
                raise BodyLimit()
            if not message.get("more_body", False):
                return bytes(body)


def parse_json(body):
    def object_pairs(pairs):
        output = {}
        for key, value in pairs:
            if key in output:
                raise ValueError("duplicate_key")
            output[key] = value
        return output

    def invalid_constant(value):
        raise ValueError("invalid_constant")

    return json.loads(
        body, object_pairs_hook=object_pairs, parse_constant=invalid_constant
    )


def validate_modern_headers(data, headers):
    """MCP 2.0 body metadata is authoritative; mirrors must agree."""
    params = data.get("params")
    meta = params.get("_meta") if isinstance(params, dict) else None
    version = meta.get(VERSION_KEY) if isinstance(meta, dict) else None
    versions = [value for key, value in headers if key.lower() == b"mcp-protocol-version"]
    if versions:
        try:
            if len(versions) != 1:
                raise ValueError()
            declared = versions[0].decode("ascii")
            if not declared or any(ord(char) < 33 or ord(char) > 126 for char in declared):
                raise ValueError()
        except (ValueError, UnicodeError):
            raise RPCError(-32020, "Header mismatch") from None
        if declared not in (MODERN_VERSION, LEGACY_VERSION):
            # An explicit unsupported HTTP version must not execute as legacy
            # just because the caller omitted the corresponding body metadata.
            raise RPCError(-32022, "Unsupported protocol version", {
                "supported": [MODERN_VERSION, LEGACY_VERSION], "requested": declared,
            })
    modern = version is not None and version != LEGACY_VERSION or MODERN_VERSION.encode() in versions
    if not modern:
        return False

    def value(name, encoded=False):
        values = [value for key, value in headers if key.lower() == name]
        try:
            if len(values) != 1:
                raise ValueError()
            raw = values[0].decode("ascii")
            if not raw or raw.strip() != raw or any(ord(char) < 32 or ord(char) > 126 for char in raw):
                raise ValueError()
            if encoded and raw.startswith("=?base64?") and raw.endswith("?="):
                raw = base64.b64decode(raw[9:-2], validate=True).decode("utf-8")
            return raw
        except (ValueError, UnicodeError, binascii.Error):
            raise RPCError(-32020, "Header mismatch") from None

    if value(b"mcp-protocol-version") != version or value(b"mcp-method") != data["method"]:
        raise RPCError(-32020, "Header mismatch")
    if data["method"] == "tools/call" and value(b"mcp-name", encoded=True) != params.get("name"):
        raise RPCError(-32020, "Header mismatch")
    return True


async def reply(send, status, value, headers=()):
    body = (
        json.dumps(value, separators=(",", ":"), allow_nan=False).encode()
        if value is not None
        else b""
    )
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"cache-control", b"no-store"),
                *headers,
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def unauthorized(send):
    metadata = (
        RESOURCE.removesuffix("/mcp") + "/.well-known/oauth-protected-resource/mcp"
    )
    await reply(
        send,
        401,
        {"error": "unauthorized"},
        [
            (
                b"www-authenticate",
                (
                    'Bearer resource_metadata="' + metadata + '", scope="event:read"'
                ).encode(),
            )
        ],
    )


class Bridge:
    def __init__(self, original, config, protocol, store, worker, now=time.time):
        self.original = original
        self.config = config
        self.protocol = protocol
        self.store = store
        self.worker = worker
        self.now = now
        self.worker_task = None

    async def lifespan_send(self, message, send):
        if message["type"] == "lifespan.startup.complete":
            self.worker_task = asyncio.create_task(
                self.worker.run(), name="xing-alert-delivery"
            )
        if message["type"] in (
            "lifespan.shutdown.complete",
            "lifespan.shutdown.failed",
            "lifespan.startup.failed",
        ):
            await self.stop()
        await send(message)

    async def stop(self):
        if self.worker_task:
            self.worker_task.cancel()
            await asyncio.gather(self.worker_task, return_exceptions=True)
            self.worker_task = None

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            try:
                await self.original(
                    scope, receive, lambda message: self.lifespan_send(message, send)
                )
            finally:
                await self.stop()
            return
        if scope["type"] != "http":
            await self.original(scope, receive, send)
            return
        path = scope["path"]
        is_webhook = path.startswith("/xing-alerts/")
        if path not in ("/mcp", "/mcp/") and not is_webhook:
            await self.original(scope, receive, send)
            return
        if is_webhook:
            expected = "/xing-alerts/webhook/" + self.config.webhook_token
            if not hmac.compare_digest(path.encode(), expected.encode()):
                await reply(send, 404, {"error": "not_found"})
                return
        headers = scope.get("headers", [])
        auth_values = [v for k, v in headers if k.lower() == b"authorization"]
        bearer = ""
        if len(auth_values) == 1:
            try:
                value = auth_values[0].decode("ascii")
                if value.startswith("Bearer "):
                    bearer = value[7:]
            except UnicodeError:
                pass
        if not is_webhook:
            try:
                await self.protocol.auth.authenticate(bearer)
            except Unauthorized:
                await unauthorized(send)
                return
            except Exception:
                logger.warning("xing_bridge_auth_unavailable")
                await reply(send, 503, {"error": "temporarily_unavailable"})
                return
        if scope.get("method") != "POST":
            await reply(
                send, 405, {"error": "method_not_allowed"}, [(b"allow", b"POST")]
            )
            return
        try:
            body = await read_body(receive, self.config.max_body)
            data = parse_json(body)
        except BodyLimit:
            await reply(send, 413, {"error": "body_too_large"})
            return
        except (ValueError, UnicodeError, RecursionError, TimeoutError):
            await reply(
                send,
                400,
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": "Parse error"},
                },
            )
            return
        if is_webhook:
            try:
                alerts = normalize(data, self.config, self.now())
                accepted = self.store.enqueue(alerts, self.now())
            except InvalidPayload:
                logger.info("xing_bridge_alert_rejected")
                await reply(send, 400, {"error": "invalid_alert_payload"})
                return
            except Exception:
                # SQLite/I/O failures must never be acknowledged as persisted.
                logger.warning("xing_bridge_persistence_unavailable")
                await reply(send, 503, {"error": "temporarily_unavailable"})
                return
            self.worker.wake.set()
            await reply(send, 202, {"accepted": accepted})
            return
        request_id = None
        modern = False
        try:
            if (
                not isinstance(data, dict)
                or set(data) - {"jsonrpc", "id", "method", "params"}
                or data.get("jsonrpc") != "2.0"
                or not isinstance(data.get("method"), str)
            ):
                raise RPCError(-32600, "Invalid Request")
            request_id = data.get("id")
            if isinstance(request_id, (dict, list, bool)) or (
                request_id is not None and not isinstance(request_id, (str, int))
            ):
                raise RPCError(-32600, "Invalid Request")
            self.protocol.diagnose(data["method"], data.get("params", {}))
            modern = validate_modern_headers(data, headers)
            result = await self.protocol.dispatch(
                data["method"], data.get("params", {}), bearer
            )
            if "id" not in data:
                await reply(send, 202, None)
                return
            await reply(
                send, 200, {"jsonrpc": "2.0", "id": request_id, "result": result}
            )
        except Unauthorized:
            await unauthorized(send)
        except RPCError as error:
            value = {"code": error.code, "message": error.message}
            if error.data is not None:
                value["data"] = error.data
            status = 400 if error.code in (-32020, -32022) else 404 if modern and error.code == -32601 else 200
            await reply(send, status, {"jsonrpc": "2.0", "id": request_id, "error": value})
        except Exception:
            logger.warning("xing_bridge_rpc_failure")
            await reply(
                send,
                503,
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32603, "message": "Internal error"},
                },
            )


def wrap_application(original):
    if not enabled():
        return original
    from django.conf import settings

    if not settings.GLITCHTIP_ENABLE_MCP:
        logger.warning("xing_bridge_mcp_required")
        return original
    try:
        from .mcp_server import runtime

        state = runtime()
        return Bridge(original, state.config, state.protocol, state.store, state.worker)
    except Exception:
        # Invalid bridge setup leaves Django/native ingest running; event requests unavailable.
        logger.warning("xing_bridge_configuration_rejected")
        return original
