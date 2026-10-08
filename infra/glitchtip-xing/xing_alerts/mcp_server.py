"""Restricted catalog with the existing GlitchTip authority and consent UI."""

import json
import time
from functools import lru_cache
from types import SimpleNamespace
from django.conf import settings
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import (
    AuthorizeError,
    RegistrationError,
    TokenError,
    RefreshToken,
    AccessToken,
)
from mcp.server.auth.settings import (
    AuthSettings,
    ClientRegistrationOptions,
    RevocationOptions,
)
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from apps.oauth.provider import (
    GlitchTipOAuthProvider,
    REFRESH_TOKEN_LIFETIME,
    _access_cache_key,
)
from django.core.cache import cache
from .auth import Authenticator
from .config import RESOURCE, Config, enabled
from .delivery import SafeTransport, Verifier, Worker
from .outbox import Store
from .protocol import Protocol
from .oauth import RefreshCodec, InvalidRefresh, read_access_data


def only_read(scopes):
    return isinstance(scopes, list) and set(scopes) == {"event:read"}


class ResourceBoundRefreshToken(RefreshToken):
    resource: str


class UserAccessToken(AccessToken):
    user_id: str


class ReadOnlyOAuthProvider(GlitchTipOAuthProvider):
    def refresh_codec(self):
        return RefreshCodec(settings.SECRET_KEY)

    def bind_refresh(self, result, client):
        if result.refresh_token:
            return result.model_copy(
                update={
                    "refresh_token": self.refresh_codec().wrap(
                        result.refresh_token,
                        client.client_id,
                        int(time.time()) + REFRESH_TOKEN_LIFETIME,
                    )
                }
            )
        return result

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
        result = await super().exchange_authorization_code(client, authorization_code)
        return self.bind_refresh(result, client)

    async def load_refresh_token(self, client, wire):
        try:
            plaintext = self.refresh_codec().unwrap(wire, client.client_id, time.time())
        except InvalidRefresh:
            return None
        native = await super().load_refresh_token(client, plaintext)
        if native is None:
            return None
        return ResourceBoundRefreshToken(**native.model_dump(), resource=RESOURCE)

    async def exchange_refresh_token(self, client, refresh_token, scopes):
        if (
            not isinstance(refresh_token, ResourceBoundRefreshToken)
            or refresh_token.resource != RESOURCE
            or refresh_token.client_id != client.client_id
        ):
            raise TokenError("invalid_grant", "Refresh resource binding required")
        if not only_read(scopes or refresh_token.scopes):
            raise TokenError("invalid_scope", "Only event:read is supported")
        result = await super().exchange_refresh_token(
            client, refresh_token, ["event:read"]
        )
        # Upstream 6.1.8 rotates/revokes correctly but writes resource=None on refresh.
        # The validated encrypted original binding authorizes only this exact resource.
        key = _access_cache_key(result.access_token)
        raw = await cache.aget(key)
        if raw is None:
            raise TokenError("invalid_grant", "Refreshed access token unavailable")
        data = json.loads(raw)
        if data.get("client_id") != client.client_id or not only_read(
            data.get("scopes")
        ):
            raise TokenError("invalid_grant", "Invalid refreshed access token")
        data["resource"] = RESOURCE
        remaining = data["expires_at"] - int(time.time())
        if remaining <= 0:
            raise TokenError("invalid_grant", "Refreshed access token expired")
        await cache.aset(key, json.dumps(data), remaining)
        return self.bind_refresh(result, client)

    async def load_access_token(self, bearer):
        # Native 6.1.8 maps client_id to user_id. The SDK revocation endpoint
        # requires the actual OAuth client ID; permissions require the user ID.
        data = read_access_data(
            await cache.aget(_access_cache_key(bearer)), time.time()
        )
        if data is None:
            return None
        return UserAccessToken(
            token=bearer,
            client_id=data["client_id"],
            user_id=data["user_id"],
            scopes=data["scopes"],
            expires_at=data["expires_at"],
            resource=data["resource"],
        )


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
