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
    XING_PROJECT_NAME="pra-talk",
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
from apps.oauth.provider import _access_cache_key  # noqa: E402
from xing_alerts.config import RESOURCE  # noqa: E402
from xing_alerts.asgi import Bridge  # noqa: E402

User = get_user_model()
if User.objects.exists() or Project.objects.exists() or Organization.objects.exists():
    raise RuntimeError("Integration requires a fresh empty disposable database")
user = User.objects.create_user("xing-ci@example.invalid", secrets.token_urlsafe(24))
outsider = User.objects.create_user(
    "xing-ci-outsider@example.invalid", secrets.token_urlsafe(24)
)
organization = Organization.objects.create(
    name="Disposable Talk integration", slug="prymeira-digital"
)
membership = OrganizationUser.objects.create(
    user=user, organization=organization, role=OrganizationUserRole.MEMBER
)
project = Project.objects.create(id=3, name="pra-talk", organization=organization)
Project.objects.create(id=2, name="baase-api", organization=organization)
key = ProjectKey.objects.filter(project=project).first()
assert key is not None
bearer = secrets.token_urlsafe(32)
outsider_bearer = secrets.token_urlsafe(32)
for token, owner in [(bearer, user.pk), (outsider_bearer, outsider.pk)]:
    cache.set(
        _access_cache_key(token),
        json.dumps(
            {
                "user_id": owner,
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


async def request(path, method="GET", data=None, token=None, query=b""):
    incoming = asyncio.Queue()
    body = (
        data
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
        headers.append((b"content-type", b"application/json"))
    if token:
        headers.append((b"authorization", ("Bearer " + token).encode()))
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


async def rpc(method, params=None, token=bearer):
    status, body, headers = await request(
        "/mcp",
        "POST",
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        token,
    )
    return status, json.loads(body), headers


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
        assert status == 200 and body["result"]["supportedVersions"] == ["2026-07-28"]
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
