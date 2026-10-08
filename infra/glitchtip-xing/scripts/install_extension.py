"""Build-only install: reject incompatible upstream files before editing either."""

import hashlib
from pathlib import Path

EXPECTED = {
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
    (root / "apps/mcp/server.py").write_text("from xing_alerts.mcp_server import mcp\n")
    with (root / "glitchtip/asgi.py").open("a") as handle:
        handle.write(
            "\n# Bounded Talk events; original startup, dispatcher and lifespan remain intact.\n"
            "from xing_alerts.asgi import wrap_application as _xing_wrap_application\n"
            "application = _xing_wrap_application(application)\n"
        )


if __name__ == "__main__":
    install("/code")
