import math
import time
from .config import EVENT_NAME
from .delivery import CallbackError, decode_secret, validate_url
from .outbox import CapacityError, subscription_id
from .privacy import POINTS, SERVICES, iso_time


class RPCError(ValueError):
    def __init__(self, code=-32602, message="Invalid params", data=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def exact_object(value, allowed, required=()):
    if (
        not isinstance(value, dict)
        or set(value) - set(allowed)
        or set(required) - set(value)
    ):
        raise RPCError()


class Protocol:
    def __init__(self, config, store, auth, verifier, now=time.time):
        self.config = config
        self.store = store
        self.auth = auth
        self.verifier = verifier
        self.now = now

    def arguments(self, args):
        exact_object(args, {"projectId"}, {"projectId"})
        if (
            type(args["projectId"]) is not int
            or args["projectId"] != self.config.project_id
        ):
            raise RPCError()

    def definition(self):
        return {
            "name": EVENT_NAME,
            "description": "A sanitized native GlitchTip operational alert for prymeira-talk. Includes new and reopened issues; repeated open issues are suppressed by GlitchTip.",
            "delivery": ["webhook"],
            "inputSchema": {
                "type": "object",
                "properties": {
                    "projectId": {"type": "integer", "const": self.config.project_id}
                },
                "required": ["projectId"],
                "additionalProperties": False,
            },
            "payloadSchema": {
                "type": "object",
                "properties": {
                    "projectId": {"type": "integer", "const": self.config.project_id},
                    "failure_point": {"type": "string", "enum": sorted(POINTS)},
                    "failure_code": {"type": "string", "maxLength": 48},
                    "service": {"type": "string", "enum": sorted(SERVICES)},
                    "release": {
                        "type": ["string", "null"],
                        "pattern": "^[a-f0-9]{7,40}$",
                    },
                    "url": {"type": "string", "format": "uri"},
                },
                "required": [
                    "projectId",
                    "failure_point",
                    "failure_code",
                    "service",
                    "release",
                    "url",
                ],
                "additionalProperties": False,
            },
        }

    async def dispatch(self, method, params, bearer):
        # Applies equally to discovery, tools, errors, notifications and legacy calls.
        principal = await self.auth.authenticate(bearer)
        if not isinstance(params, dict):
            raise RPCError()
        if method == "server/discover":
            exact_object(params, {"protocolVersion", "capabilities", "clientInfo"})
            return {
                "resultType": "complete",
                "supportedVersions": ["2026-07-28"],
                "capabilities": {"tools": {}, "events": {}},
            }
        if method == "initialize":
            exact_object(params, {"protocolVersion", "capabilities", "clientInfo"})
            return {
                "protocolVersion": "2025-11-25",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "glitchtip-xing", "version": "1.0.0"},
            }
        if method in ("notifications/initialized", "ping"):
            exact_object(params, set())
            return {}
        if method == "events/list":
            exact_object(params, {"cursor"})
            if params.get("cursor") is not None:
                raise RPCError()
            return {"events": [self.definition()]}
        if method == "tools/list":
            exact_object(params, {"cursor"})
            if params.get("cursor") is not None:
                raise RPCError()
            return {
                "tools": [
                    {
                        "name": "get_alert_delivery_status",
                        "description": "Aggregate event delivery counts for this authenticated Talk account. Accepted means callback receipt; it does not prove Dot processing.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": False,
                        },
                        "annotations": {
                            "readOnlyHint": True,
                            "destructiveHint": False,
                            "openWorldHint": False,
                        },
                    }
                ]
            }
        if method == "tools/call":
            exact_object(params, {"name", "arguments"}, {"name"})
            if params["name"] != "get_alert_delivery_status":
                raise RPCError(-32601, "Method not found")
            exact_object(params.get("arguments", {}), set())
            import json

            data = self.store.status(principal.owner, self.now())
            return {
                "content": [{"type": "text", "text": json.dumps(data, sort_keys=True)}],
                "structuredContent": data,
                "isError": False,
            }
        if method not in ("events/subscribe", "events/unsubscribe"):
            raise RPCError(-32601, "Method not found")
        subscribing = method == "events/subscribe"
        exact_object(
            params,
            {"name", "arguments", "delivery", "cursor", "ttlMs"}
            if subscribing
            else {"name", "arguments", "delivery"},
            {"name", "arguments", "delivery"},
        )
        if params["name"] != EVENT_NAME:
            raise RPCError()
        self.arguments(params["arguments"])
        delivery = params["delivery"]
        exact_object(
            delivery,
            {"mode", "url", "secret"} if subscribing else {"mode", "url"},
            {"mode", "url", "secret"} if subscribing else {"mode", "url"},
        )
        if delivery["mode"] != "webhook":
            raise RPCError()
        try:
            validate_url(delivery["url"])
        except CallbackError as error:
            raise RPCError(data={"reason": error.reason}) from None
        sid = subscription_id(
            principal.owner, EVENT_NAME, params["arguments"], delivery["url"]
        )
        if not subscribing:
            self.store.deactivate(sid, principal.owner)
            return {}
        if params.get("cursor") is not None:
            raise RPCError()
        requested = params.get("ttlMs", 3600000)
        if requested is None:
            requested = 3600000
        if (
            isinstance(requested, bool)
            or not isinstance(requested, (int, float))
            or not math.isfinite(requested)
            or requested <= 0
        ):
            raise RPCError()
        try:
            decode_secret(delivery["secret"])
            await self.verifier.verify(
                principal.owner, sid, delivery["url"], delivery["secret"]
            )
        except CallbackError as error:
            raise RPCError(
                -32015, "CallbackEndpointError", {"reason": error.reason}
            ) from None
        # Verification awaited; the token/project must still be valid at activation.
        principal = await self.auth.authenticate(bearer)
        at = self.now()
        expires = min(principal.expires, at + 3600, at + requested / 1000)
        try:
            self.store.subscribe(
                sid,
                principal.owner,
                delivery["url"],
                delivery["secret"],
                bearer,
                expires,
                at,
            )
        except CapacityError:
            raise RPCError(-32000, "Bridge capacity reached") from None
        return {
            "id": sid,
            "refreshBefore": iso_time(expires),
            "cursor": None,
            "truncated": False,
        }
