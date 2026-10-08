"""Disposable-image integration only; never point this at an existing database.

Run after migrations with XING_INTEGRATION_DISPOSABLE=yes and a fresh PostgreSQL
database. No callback, plugin, browser, or production access occurs here.
"""

import asyncio
import hashlib
import json
import os
import secrets
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if os.environ.get("XING_INTEGRATION_DISPOSABLE") != "yes":
    raise RuntimeError("Disposable integration opt-in required")

state_directory = tempfile.TemporaryDirectory(prefix="xing-ci-")
os.environ.update(
    DJANGO_SETTINGS_MODULE="glitchtip.settings",
    GLITCHTIP_ENABLE_MCP="True",
    GLITCHTIP_EMBED_WORKER="true",
    GLITCHTIP_URL="https://glitchtip.prymeiradigital.com.br",
    XING_EVENTS_ENABLED="true",
    XING_ORGANIZATION_SLUG="prymeira-digital",
    XING_PROJECT_ID="3",
    XING_PROJECT_NAME="prymeira-talk",
    XING_WEBHOOK_TOKEN=secrets.token_urlsafe(32),
    XING_STATE_PATH=state_directory.name + "/state.sqlite3",
)

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.core.cache import cache  # noqa: E402
from apps.organizations_ext.models import Organization, OrganizationUser  # noqa: E402
from apps.organizations_ext.constants import OrganizationUserRole  # noqa: E402
from apps.projects.models import Project, ProjectKey  # noqa: E402
from apps.oauth.provider import _access_cache_key, _grant_cache_key  # noqa: E402
from xing_alerts.config import RESOURCE, EVENT_NAME  # noqa: E402
from xing_alerts.asgi import Bridge  # noqa: E402

User = get_user_model()
if User.objects.exists() or Project.objects.exists() or Organization.objects.exists():
    raise RuntimeError("Integration requires a fresh empty disposable database")
user = User.objects.create_user("xing-ci@example.invalid", secrets.token_urlsafe(24))
outsider = User.objects.create_user(
    "xing-ci-outsider@example.invalid", secrets.token_urlsafe(24)
)
organization = Organization.objects.create(
    # Native OrganizationSlugField overwrites an explicit slug on initial save.
    # Its name must therefore produce the exact allowlisted disposable slug.
    name="Prymeira Digital",
    slug="prymeira-digital",
)
assert organization.slug == "prymeira-digital", "Disposable organization slug mismatch"
membership = OrganizationUser.objects.create(
    user=user, organization=organization, role=OrganizationUserRole.MEMBER
)
project = Project.objects.create(id=3, name="prymeira-talk", organization=organization)
Project.objects.create(id=2, name="baase-api", organization=organization)
# Native Project.save creates a key only when pk is initially absent. This
# fixture supplies the allowlisted project ID explicitly, so create its key too.
key = ProjectKey.objects.create(project=project, name="Disposable CI ingest")
bearer = secrets.token_urlsafe(32)
outsider_bearer = secrets.token_urlsafe(32)
for token, owner in [(bearer, user.pk), (outsider_bearer, outsider.pk)]:
    cache.set(
        _access_cache_key(token),
        json.dumps(
            {
                "user_id": owner,
                "client_id": "disposable-fixture-client",
                "scopes": ["event:read"],
                "expires_at": int(time.time()) + 3600,
                "resource": RESOURCE,
            }
        ),
        timeout=3600,
    )

from glitchtip.asgi import application  # noqa: E402

assert isinstance(application, Bridge), (
    "Enabled bridge must wrap the original ASGI application"
)


async def request(
    path, method="GET", data=None, token=None, query=b"", form=None, mcp_headers=()
):
    incoming = asyncio.Queue()
    body = (
        urlencode(form).encode()
        if form is not None
        else data
        if isinstance(data, bytes)
        else json.dumps(data).encode()
        if data is not None
        else b""
    )
    await incoming.put({"type": "http.request", "body": body, "more_body": False})
    headers = [
        (b"host", b"glitchtip.prymeiradigital.com.br"),
        (b"content-length", str(len(body)).encode()),
    ]
    if body:
        headers.append(
            (
                b"content-type",
                b"application/x-www-form-urlencoded"
                if form is not None
                else b"application/json",
            )
        )
    if token:
        headers.append((b"authorization", ("Bearer " + token).encode()))
    headers.extend(mcp_headers)
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query,
        "root_path": "",
        "server": ("glitchtip.prymeiradigital.com.br", 443),
        "client": ("127.0.0.1", 54321),
        "headers": headers,
    }
    output = []

    async def send(message):
        output.append(message)

    async with asyncio.timeout(20):
        await application(scope, incoming.get, send)
    start = next(item for item in output if item["type"] == "http.response.start")
    body = b"".join(
        item.get("body", b"") for item in output if item["type"] == "http.response.body"
    )
    return start["status"], body, dict(start["headers"])


async def rpc(method, params=None, token=bearer, modern=False):
    params = dict(params or {})
    mcp_headers = []
    if modern:
        params["_meta"] = {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
                "name": "DisposableImageIntegration", "version": "1.0.0"
            },
        }
        mcp_headers = [
            (b"mcp-protocol-version", b"2026-07-28"),
            (b"mcp-method", method.encode("ascii")),
        ]
        if method == "tools/call":
            mcp_headers.append((b"mcp-name", params["name"].encode("ascii")))
    status, body, headers = await request(
        "/mcp",
        "POST",
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
        token,
        mcp_headers=mcp_headers,
    )
    return status, json.loads(body), headers


async def modern_catalog(token):
    """Use native OAuth tokens on the installed bridge with official MCP2 shapes."""
    status, body, _ = await rpc("server/discover", token=token, modern=True)
    assert status == 200 and "error" not in body, "Modern discovery failed"
    discovery = body["result"]
    assert discovery["resultType"] == "complete"
    assert discovery["supportedVersions"] == ["2026-07-28"]
    assert set(discovery["capabilities"]) == {"tools", "events"}
    status, body, _ = await rpc("events/list", token=token, modern=True)
    assert status == 200 and "error" not in body, "Modern event catalog failed"
    catalog = body["result"]
    assert catalog["resultType"] == "complete"
    assert [event["name"] for event in catalog["events"]] == [EVENT_NAME]
    assert catalog["events"][0]["inputSchema"]["properties"]["projectId"]["const"] == 3
    status, body, _ = await rpc(
        "tools/call",
        {"name": "get_alert_delivery_status", "arguments": {}},
        token=token,
        modern=True,
    )
    assert status == 200 and "error" not in body, "Modern status call failed"
    result = body["result"]
    assert result["resultType"] == "complete" and result["isError"] is False
    assert result["structuredContent"]["activeSubscriptions"] == 0


async def native_oauth_flow(client, challenge):
    """Exercise the installed native provider through actual SDK HTTP handlers."""
    from django.conf import settings
    from apps.oauth.models import OAuthRefreshToken
    from xing_alerts.mcp_server import ReadOnlyOAuthProvider, ResourceBoundRefreshToken
    from xing_alerts.oauth import RefreshCodec
    from xing_alerts.delivery import Worker

    code = secrets.token_urlsafe(32)
    now = int(time.time())
    # This is the native post-consent grant shape. Browser/consent stays untouched.
    grant_data = {
        "user_id": user.pk,
        "client_id": client["client_id"],
        "scopes": ["event:read"],
        "expires_at": now + 300,
        "code_challenge": challenge,
        "redirect_uri": "https://receiver.example/oauth",
        "redirect_uri_provided_explicitly": True,
        "resource": RESOURCE,
    }
    await cache.aset(_grant_cache_key(code), json.dumps(grant_data), 300)
    status, body, _ = await request(
        "/mcp/token",
        "POST",
        form={
            "client_id": client["client_id"],
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": "https://receiver.example/oauth",
            "code_verifier": "disposable-verifier-abcdefghijklmnopqrstuvwxyz",
            "resource": RESOURCE,
        },
    )
    assert status == 200, "Native authorization-code exchange failed"
    first = json.loads(body)
    assert first["refresh_token"].startswith("xing_rt_")
    loaded = await ReadOnlyOAuthProvider().load_access_token(first["access_token"])
    assert loaded.client_id == client["client_id"] and loaded.user_id == str(user.pk)
    assert (await rpc("events/list", token=first["access_token"]))[0] == 200
    await modern_catalog(first["access_token"])
    client_info = await ReadOnlyOAuthProvider().get_client(client["client_id"])
    codec = RefreshCodec(settings.SECRET_KEY)
    plaintext = codec.unwrap(first["refresh_token"], client["client_id"], time.time())
    native_row = await OAuthRefreshToken.objects.aget(
        application_id=client["client_id"], is_revoked=False
    )
    assert native_row.token_digest == hashlib.sha256(plaintext.encode()).hexdigest()
    assert (
        native_row.token_digest
        != hashlib.sha256(first["refresh_token"].encode()).hexdigest()
    )
    form = {
        "client_id": client["client_id"],
        "grant_type": "refresh_token",
        "resource": RESOURCE,
    }
    assert (
        await request("/mcp/token", "POST", form={**form, "refresh_token": plaintext})
    )[0] == 400
    assert (
        await request(
            "/mcp/token",
            "POST",
            form={
                **form,
                "refresh_token": first["refresh_token"],
                "scope": "event:write",
            },
        )
    )[0] == 400
    assert (
        await ReadOnlyOAuthProvider().load_refresh_token(
            client_info.model_copy(update={"client_id": "other-client"}),
            first["refresh_token"],
        )
        is None
    )
    # The original access cache can expire/disappear before the durable refresh.
    await cache.adelete(_access_cache_key(first["access_token"]))
    rebound = await ReadOnlyOAuthProvider().load_refresh_token(
        client_info, first["refresh_token"]
    )
    assert (
        isinstance(rebound, ResourceBoundRefreshToken) and rebound.resource == RESOURCE
    )
    status, body, _ = await request(
        "/mcp/token", "POST", form={**form, "refresh_token": first["refresh_token"]}
    )
    assert status == 200, "Refresh must survive missing original access cache"
    second = json.loads(body)
    assert second["refresh_token"] != first["refresh_token"]
    assert (
        await ReadOnlyOAuthProvider().load_refresh_token(
            client_info, first["refresh_token"]
        )
        is None
    )
    refreshed = await ReadOnlyOAuthProvider().load_access_token(second["access_token"])
    assert refreshed.resource == RESOURCE and refreshed.scopes == ["event:read"]
    assert (await rpc("events/list", token=second["access_token"]))[0] == 200
    await modern_catalog(second["access_token"])
    # Rotate again with the previous access cache still present; native rotation deletes it.
    status, body, _ = await request(
        "/mcp/token", "POST", form={**form, "refresh_token": second["refresh_token"]}
    )
    assert status == 200
    third = json.loads(body)
    assert await cache.aget(_access_cache_key(second["access_token"])) is None
    assert (await rpc("events/list", token=second["access_token"]))[0] == 401
    assert (await rpc("events/list", token=third["access_token"]))[0] == 200
    other_client = client_info.model_copy(
        update={"client_id": "disposable-other-" + uuid.uuid4().hex}
    )
    await ReadOnlyOAuthProvider().register_client(other_client)
    assert (
        await request(
            "/mcp/revoke",
            "POST",
            form={
                "client_id": other_client.client_id,
                "client_secret": "",
                "token_type_hint": "access_token",
                "token": third["access_token"],
            },
        )
    )[0] == 200
    assert await cache.aget(_access_cache_key(third["access_token"])) is not None

    # Queue work in the future, so the background worker cannot dispatch it.
    delivery_at = time.time() + 300
    sid = "sub_disposable-revocation"
    import base64

    application.store.subscribe(
        sid,
        str(user.pk),
        "https://receiver.example/events",
        "whsec_" + base64.b64encode(b"a" * 32).decode(),
        third["access_token"],
        delivery_at + 300,
        time.time(),
    )
    application.store.enqueue(
        [{"timestamp": "2026-10-08T00:00:00Z", "projectId": 3, "issueId": 123}],
        delivery_at,
    )
    status, _, _ = await request(
        "/mcp/revoke",
        "POST",
        form={
            "client_id": client["client_id"],
            "client_secret": "",
            "token_type_hint": "access_token",
            "token": third["access_token"],
        },
    )
    assert status == 200
    assert await cache.aget(_access_cache_key(third["access_token"])) is None, (
        "SDK access revocation must delete native cache"
    )
    assert (
        await ReadOnlyOAuthProvider().load_refresh_token(
            client_info, third["refresh_token"]
        )
        is None
    )
    assert (await rpc("events/list", token=third["access_token"]))[0] == 401

    class NoNetwork:
        async def post(self, *args):
            raise AssertionError("Revoked subscription must never deliver")

    await Worker(
        application.store, application.protocol.auth, NoNetwork(), lambda: delivery_at
    ).once()
    assert not application.store.get_subscription(sid)["active"]
    assert application.store.status(str(user.pk), delivery_at)["pending"] == 0
    # Wrapped refresh-token revocation also reaches the native database and cache.
    code = secrets.token_urlsafe(32)
    await cache.aset(_grant_cache_key(code), json.dumps(grant_data), 300)
    status, body, _ = await request(
        "/mcp/token",
        "POST",
        form={
            "client_id": client["client_id"],
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": "https://receiver.example/oauth",
            "code_verifier": "disposable-verifier-abcdefghijklmnopqrstuvwxyz",
            "resource": RESOURCE,
        },
    )
    assert status == 200
    fourth = json.loads(body)
    assert (
        await request(
            "/mcp/revoke",
            "POST",
            form={
                "client_id": client["client_id"],
                "client_secret": "",
                "token_type_hint": "refresh_token",
                "token": fourth["refresh_token"],
            },
        )
    )[0] == 200
    assert await cache.aget(_access_cache_key(fourth["access_token"])) is None
    assert (
        await ReadOnlyOAuthProvider().load_refresh_token(
            client_info, fourth["refresh_token"]
        )
        is None
    )
    print(
        "native OAuth code exchange, MCP2 metadata/HTTP discovery/catalog/status, durable refresh/rotation, SDK access revoke and delivery cancellation: passed"
    )


async def main():
    incoming = asyncio.Queue()
    started = asyncio.Event()
    stopped = asyncio.Event()
    lifecycle = []

    async def lifecycle_send(message):
        lifecycle.append(message["type"])
        if message["type"] == "lifespan.startup.complete":
            started.set()
        elif message["type"] == "lifespan.shutdown.complete":
            stopped.set()
        elif message["type"].endswith(".failed"):
            raise RuntimeError("Original lifespan failed")

    task = asyncio.create_task(
        application(
            {"type": "lifespan", "asgi": {"version": "3.0"}},
            incoming.get,
            lifecycle_send,
        )
    )
    try:
        await incoming.put({"type": "lifespan.startup"})
        await asyncio.wait_for(started.wait(), 30)
        assert application.worker_task and not application.worker_task.done()
        status, body, headers = await rpc("events/list", token=None)
        assert status == 401 and "events" not in body and b"www-authenticate" in headers
        assert (await rpc("events/list", token=outsider_bearer))[0] == 401
        status, body, _ = await rpc("server/discover")
        assert status == 200 and body["result"]["supportedVersions"] == [
            "2026-07-28"
        ], f"Disposable discovery failed: status={status}, body={json.dumps(body)}"
        assert set(body["result"]["capabilities"]) == {"tools", "events"}
        status, body, _ = await rpc("events/list")
        assert (
            status == 200
            and body["result"]["events"][0]["inputSchema"]["properties"]["projectId"][
                "const"
            ]
            == 3
        )
        status, body, _ = await rpc("tools/list")
        assert status == 200 and [tool["name"] for tool in body["result"]["tools"]] == [
            "get_alert_delivery_status"
        ]
        status, body, _ = await rpc(
            "tools/call", {"name": "get_alert_delivery_status", "arguments": {}}
        )
        assert (
            status == 200
            and body["result"]["structuredContent"]["activeSubscriptions"] == 0
        )
        assert (await rpc("tools/call", {"name": "delete_issue", "arguments": {}}))[1][
            "error"
        ]["code"] == -32601
        for path in [
            "/.well-known/oauth-authorization-server/mcp",
            "/.well-known/oauth-protected-resource/mcp",
        ]:
            status, body, _ = await request(path)
            metadata = json.loads(body)
            assert status == 200 and metadata["scopes_supported"] == ["event:read"]
        status, body, _ = await request(
            "/mcp/register",
            "POST",
            {
                "redirect_uris": ["https://receiver.example/oauth"],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "scope": "event:read",
            },
        )
        assert status == 201
        client = json.loads(body)
        import base64

        challenge = (
            base64.urlsafe_b64encode(
                hashlib.sha256(
                    b"disposable-verifier-abcdefghijklmnopqrstuvwxyz"
                ).digest()
            )
            .rstrip(b"=")
            .decode()
        )
        query = urlencode(
            {
                "client_id": client["client_id"],
                "redirect_uri": "https://receiver.example/oauth",
                "response_type": "code",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "scope": "event:read",
                "resource": RESOURCE,
                "state": "disposable-ci",
            }
        ).encode()
        status, _, headers = await request("/mcp/authorize", query=query)
        assert (
            status in (302, 303, 307) and b"/oauth/authorize/" in headers[b"location"]
        )
        await native_oauth_flow(client, challenge)
        status, body, _ = await request("/_health/")
        assert status == 200 and body == b"ok"
        status, body, _ = await request("/")
        assert status == 200 and b"<html" in body.lower()
        # Clearly marked disposable synthetic error: native ingest must still accept it.
        event = json.dumps(
            {
                "event_id": uuid.uuid4().hex,
                "timestamp": time.time(),
                "platform": "python",
                "level": "error",
                "message": "DISPOSABLE CI synthetic operational event",
            }
        ).encode()
        envelope = (
            json.dumps({"event_id": json.loads(event)["event_id"]}).encode()
            + b"\n"
            + json.dumps({"type": "event", "length": len(event)}).encode()
            + b"\n"
            + event
        )
        status, _, _ = await request(
            "/api/3/envelope/",
            "POST",
            envelope,
            query=urlencode(
                {"sentry_key": key.public_key.hex, "sentry_version": "7"}
            ).encode(),
        )
        assert status in (200, 202), "Native ingest acceptance failed"
        # Actual database revocation checks, with the same still-valid OAuth token.
        user.is_active = False
        await user.asave(update_fields=["is_active"])
        assert (await rpc("events/list"))[0] == 401
        user.is_active = True
        await user.asave(update_fields=["is_active"])
        await membership.adelete()
        assert (await rpc("events/list"))[0] == 401
        print(
            "disposable Django permissions, scoped OAuth/consent redirect, MCP RPC, frontend/health, native ingest: passed"
        )
    finally:
        await incoming.put({"type": "lifespan.shutdown"})
        await asyncio.wait_for(stopped.wait(), 30)
        await asyncio.wait_for(task, 10)
        assert application.worker_task is None
        assert lifecycle == ["lifespan.startup.complete", "lifespan.shutdown.complete"]
        application.store.close()
        state_directory.cleanup()
    print("original embedded-worker + MCP lifespan and bridge shutdown: passed")


if __name__ == "__main__":
    asyncio.run(main())
