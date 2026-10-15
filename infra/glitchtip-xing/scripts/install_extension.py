"""Build-only install: reject incompatible upstream files before editing any upstream file."""

import hashlib
from pathlib import Path

EXPECTED = {
    "apps/alerts/webhooks.py": "02f9036bdcd3303ee0ca40dd5d986e0e79a2f262931e87da5a4316010752c1ac",
    "glitchtip/asgi.py": "1766a2516a9a9c659008f9f304fee974892a008ce8063ed5aeaab07da5ef1b4d",
    "apps/mcp/server.py": "803bed1b36ee8bf1b494f7f25f2bd7792eb392d7da98e34e47dfebb6a10d5c52",
}


def install(root):
    root = Path(root)
    for relative, expected in EXPECTED.items():
        actual = hashlib.sha256((root / relative).read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(
                "GlitchTip 6.1.8 source compatibility check failed: " + relative
            )
    with (root / "apps/alerts/webhooks.py").open("a") as handle:
        handle.write(
            "\n# Dedicated Talk diagnostic recipient; other native recipients stay upstream.\n"
            "from xing_alerts.native import native_send_issue_as_webhook as _xing_native_send\n"
            "_xing_original_send = send_issue_as_webhook\n"
            "async def send_issue_as_webhook(url, issues, issue_count=1, tags_to_add=None, **kwargs):\n"
            "    return await _xing_native_send(_xing_original_send, send_webhook, url, issues, issue_count, tags_to_add, **kwargs)\n"
        )
    (root / "apps/mcp/server.py").write_text("from xing_alerts.mcp_server import mcp\n")
    with (root / "glitchtip/asgi.py").open("a") as handle:
        handle.write(
            "\n# Bounded Talk events; original startup, dispatcher and lifespan remain intact.\n"
            "from xing_alerts.asgi import wrap_application as _xing_wrap_application\n"
            "application = _xing_wrap_application(application)\n"
        )


if __name__ == "__main__":
    install("/code")
