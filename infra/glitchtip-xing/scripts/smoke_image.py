"""Run in the built image with dummy Django settings and a disposable database."""

import asyncio
import os
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "glitchtip.settings")
import django

django.setup()
from apps.mcp.server import mcp  # noqa: E402
from xing_alerts.config import RESOURCE  # noqa: E402


async def main():
    tools = await mcp.list_tools()
    assert [tool.name for tool in tools] == ["get_alert_delivery_status"]
    auth = mcp.settings.auth
    assert (
        str(auth.issuer_url) == RESOURCE and str(auth.resource_server_url) == RESOURCE
    )
    assert auth.client_registration_options.valid_scopes == ["event:read"]
    assert auth.client_registration_options.default_scopes == ["event:read"]
    assert auth.required_scopes == ["event:read"]
    import glitchtip.asgi

    assert callable(glitchtip.asgi.application)
    assert (
        "application = _xing_wrap_application(application)"
        in Path("/code/glitchtip/asgi.py").read_text()
    )
    print("restricted catalog, OAuth settings and original ASGI import: passed")


if __name__ == "__main__":
    asyncio.run(main())
