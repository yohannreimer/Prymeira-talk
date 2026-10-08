"""Restricted catalog with the existing GlitchTip authority and consent UI."""

import json
from functools import lru_cache
from types import SimpleNamespace
from django.conf import settings
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AuthorizeError, RegistrationError, TokenError
from mcp.server.auth.settings import (
    AuthSettings,
    ClientRegistrationOptions,
    RevocationOptions,
)
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from apps.oauth.provider import GlitchTipOAuthProvider
from .auth import Authenticator
from .config import RESOURCE, Config, enabled
from .delivery import SafeTransport, Verifier, Worker
from .outbox import Store
from .protocol import Protocol


def only_read(scopes):
    return isinstance(scopes, list) and set(scopes) == {"event:read"}


class ReadOnlyOAuthProvider(GlitchTipOAuthProvider):
    async def register_client(self, client_info):
        if client_info.scope and set(client_info.scope.split()) != {"event:read"}:
            raise RegistrationError(
                "invalid_client_metadata", "Only event:read is supported"
            )
        await super().register_client(
            client_info.model_copy(update={"scope": "event:read"})
        )

    async def authorize(self, client, params):
        scopes = params.scopes or ["event:read"]
        if not only_read(scopes):
            raise AuthorizeError("invalid_scope", "Only event:read is supported")
        if params.resource != RESOURCE:
            raise AuthorizeError("invalid_request", "Resource is required")
        return await super().authorize(
            client, params.model_copy(update={"scopes": ["event:read"]})
        )

    async def exchange_authorization_code(self, client, authorization_code):
        if (
            not only_read(authorization_code.scopes)
            or authorization_code.resource != RESOURCE
        ):
            raise TokenError(
                "invalid_scope", "Only event:read for this resource is supported"
            )
        return await super().exchange_authorization_code(client, authorization_code)

    async def exchange_refresh_token(self, client, refresh_token, scopes):
        if not only_read(scopes or refresh_token.scopes):
            raise TokenError("invalid_scope", "Only event:read is supported")
        return await super().exchange_refresh_token(
            client, refresh_token, ["event:read"]
        )

    async def load_access_token(self, bearer):
        token = await super().load_access_token(bearer)
        if (
            token is None
            or not only_read(token.scopes)
            or token.resource != RESOURCE
            or token.expires_at is None
        ):
            return None
        return token


provider = ReadOnlyOAuthProvider()
mcp = FastMCP(
    "glitchtip-xing",
    stateless_http=True,
    auth_server_provider=provider,
    auth=AuthSettings(
        issuer_url=RESOURCE,
        resource_server_url=RESOURCE,
        required_scopes=["event:read"],
        client_registration_options=ClientRegistrationOptions(
            enabled=True, valid_scopes=["event:read"], default_scopes=["event:read"]
        ),
        revocation_options=RevocationOptions(enabled=True),
    ),
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


@lru_cache(maxsize=1)
def runtime():
    if not enabled():
        raise RuntimeError("bridge_disabled")
    if settings.GLITCHTIP_URL.geturl().rstrip("/") != RESOURCE.removesuffix("/mcp"):
        raise RuntimeError("invalid_resource_configuration")
    config = Config.from_env()
    store = Store(config.state_path, settings.SECRET_KEY)
    auth = Authenticator(provider, config)
    transport = SafeTransport()
    verifier = Verifier(transport)
    protocol = Protocol(config, store, auth, verifier)
    worker = Worker(store, auth, transport)
    return SimpleNamespace(
        config=config, store=store, auth=auth, protocol=protocol, worker=worker
    )


@mcp.tool(
    annotations={"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}
)
async def get_alert_delivery_status() -> str:
    """Return aggregate Talk delivery counts for this account. Accepted is HTTP receipt."""
    token = get_access_token()
    if token is None:
        raise ValueError("unauthorized")
    state = runtime()
    principal = await state.auth.authenticate(token.token)
    return json.dumps(
        state.store.status(principal.owner, state.protocol.now()), sort_keys=True
    )
