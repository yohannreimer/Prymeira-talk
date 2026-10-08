import math
import logging
import time
from .config import EVENT_NAME
from .delivery import CallbackError, decode_secret, validate_url
from .outbox import CapacityError, subscription_id
from .privacy import POINTS, SERVICES, iso_time

logger = logging.getLogger("xing_alerts")
MODERN_VERSION = "2026-07-28"
LEGACY_VERSION = "2025-11-25"
VERSION_KEY = "io.modelcontextprotocol/protocolVersion"
CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities"
CLIENT_KEY = "io.modelcontextprotocol/clientInfo"
METHOD_FIELDS = {
    "server/discover": {"protocolVersion", "capabilities", "clientInfo"},
    "initialize": {"protocolVersion", "capabilities", "clientInfo"},
    "notifications/initialized": set(), "ping": set(),
    "events/list": {"cursor"}, "tools/list": {"cursor"},
    "tools/call": {"name", "arguments"},
    "events/subscribe": {"name", "arguments", "delivery", "cursor", "ttlMs"},
    "events/unsubscribe": {"name", "arguments", "delivery"},
}


def request_metadata(params):
    """Validate common protocol metadata, never application arguments/delivery."""
    if not isinstance(params, dict):
        raise RPCError()
    if "_meta" not in params:
        return None
    meta = params["_meta"]
    if not isinstance(meta, dict):
        raise RPCError()
    if "progressToken" in meta and (
        type(meta["progressToken"]) not in (str, int, float)
        or isinstance(meta["progressToken"], float) and not math.isfinite(meta["progressToken"])
    ):
        raise RPCError()
    if VERSION_KEY not in meta:
        # Legacy request metadata has no per-request protocol version.
        return None
    version = meta[VERSION_KEY]
    if not isinstance(version, str):
        raise RPCError()
    if version not in (MODERN_VERSION, LEGACY_VERSION):
        raise RPCError(-32022, "Unsupported protocol version", {
            "supported": [MODERN_VERSION, LEGACY_VERSION], "requested": version,
        })
    if version == MODERN_VERSION and not isinstance(meta.get(CAPABILITIES_KEY), dict):
        raise RPCError()
    if CLIENT_KEY in meta:
        client = meta[CLIENT_KEY]
        if not isinstance(client, dict) or not all(isinstance(client.get(k), str) for k in ("name", "version")):
            raise RPCError()
    return version


def shape(value):
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if value is None:
        return "null"
    if isinstance(value, str):
        return "string"
    return "scalar"


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
        self.diagnostic_at = {}

    def diagnose(self, method, params):
        # Fixed method inventory and one record per method/minute. No raw keys,
        # metadata values, identities, tool arguments, callback URLs or secrets.
        if method not in METHOD_FIELDS:
            return
        at = time.monotonic()
        if at - self.diagnostic_at.get(method, float("-inf")) < 60:
            return
        self.diagnostic_at[method] = at
        fields = params if isinstance(params, dict) else {}
        meta = fields.get("_meta")
        common = meta if isinstance(meta, dict) else {}
        version = common.get(VERSION_KEY)
        label = "modern" if version == MODERN_VERSION else "legacy" if version == LEGACY_VERSION else "unknown" if VERSION_KEY in common else "absent"
        logger.info(
            "xing_bridge_rpc_shape method=%s params=%s meta_present=%s meta=%s version=%s capabilities=%s client=%s arguments=%s unknown_count=%d",
            method, shape(params), "_meta" in fields, shape(meta), label,
            shape(common.get(CAPABILITIES_KEY)), shape(common.get(CLIENT_KEY)),
            shape(fields.get("arguments")), len(set(fields) - METHOD_FIELDS[method] - {"_meta"}),
        )

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
        self.diagnose(method, params)
        version = request_metadata(params)
        functional = {key: value for key, value in params.items() if key != "_meta"}
        result = await self._dispatch_functional(method, functional, bearer, principal)
        if version == MODERN_VERSION:
            result = {"resultType": "complete", **result}
        return result

    async def _dispatch_functional(self, method, params, bearer, principal):
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
