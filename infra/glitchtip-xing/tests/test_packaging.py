import hashlib
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import ModuleType
from unittest.mock import AsyncMock
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/install_extension.py"
spec = importlib.util.spec_from_file_location("installer", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PackagingTests(unittest.TestCase):
    def test_image_scripts_import_code_root_without_pythonpath(self):
        for filename in ["smoke_image.py", "integration_image.py"]:
            with self.subTest(script=filename), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                scripts = root / "xing-alerts-scripts"
                scripts.mkdir()
                shutil.copy(SCRIPT.parent / filename, scripts / filename)
                (root / "glitchtip.py").write_text("")
                (root / "django.py").write_text(
                    "def setup():\n"
                    "    import glitchtip\n"
                    '    raise RuntimeError("authoritative_code_root_reached")\n'
                )
                env = dict(os.environ)
                env.pop("PYTHONPATH", None)
                env["XING_INTEGRATION_DISPOSABLE"] = "yes"
                result = subprocess.run(
                    [sys.executable, str(scripts / filename)],
                    cwd=scripts,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                self.assertIn("authoritative_code_root_reached", result.stderr)

    def test_incompatible_base_fails_before_edit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for path in installer.EXPECTED:
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("not the fixed source")
            with self.assertRaises(RuntimeError):
                installer.install(root)
            for path in installer.EXPECTED:
                self.assertEqual((root / path).read_text(), "not the fixed source")

    def test_append_preserves_original_and_removes_broad_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            original = {
                "glitchtip/asgi.py": "original_startup_and_lifespan\n",
                "apps/mcp/server.py": "broad_tools\n",
                "apps/alerts/webhooks.py": "native_alerts\n",
            }
            expected = {}
            for path, body in original.items():
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(body)
                expected[path] = hashlib.sha256(body.encode()).hexdigest()
            with patch.object(installer, "EXPECTED", expected):
                installer.install(root)
            self.assertTrue(
                (root / "glitchtip/asgi.py")
                .read_text()
                .startswith(original["glitchtip/asgi.py"])
            )
            self.assertEqual(
                (root / "apps/mcp/server.py").read_text(),
                "from xing_alerts.mcp_server import mcp\n",
            )

    def test_installed_dispatcher_calls_diagnostic_wrapper_and_preserves_other_handlers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            native_source = (
                "class RecipientType:\n"
                "    GENERAL_WEBHOOK = 'general'\n"
                "    DISCORD = 'discord'\n"
                "async def send_issue_as_webhook(*args, **kwargs): return 'upstream'\n"
                "async def send_webhook(*args, **kwargs): pass\n"
                "async def discord(*args, **kwargs): pass\n"
                "ISSUE_NOTIFICATION_HANDLERS = {RecipientType.GENERAL_WEBHOOK: send_issue_as_webhook, RecipientType.DISCORD: discord}\n"
            )
            original = {"apps/alerts/webhooks.py": native_source,
                        "glitchtip/asgi.py": "original_startup\n",
                        "apps/mcp/server.py": "broad_tools\n"}
            expected = {}
            for path, body in original.items():
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(body)
                expected[path] = hashlib.sha256(body.encode()).hexdigest()
            with patch.object(installer, "EXPECTED", expected):
                installer.install(root)
            fake = ModuleType("xing_alerts.native")
            fake.native_send_issue_as_webhook = AsyncMock(return_value="diagnostic")
            namespace = {}
            with patch.dict(sys.modules, {"xing_alerts.native": fake}):
                exec(compile((root / "apps/alerts/webhooks.py").read_text(), "installed_webhooks.py", "exec"), namespace)
            handlers = namespace["ISSUE_NOTIFICATION_HANDLERS"]
            self.assertIs(handlers["general"], namespace["send_issue_as_webhook"])
            self.assertIsNot(handlers["general"], namespace["_xing_original_send"])
            self.assertIs(handlers["discord"], namespace["discord"])
            import asyncio
            result = asyncio.run(handlers["general"]("owned", [], tags_to_add=["diagnostic_version"]))
            self.assertEqual(result, "diagnostic")
            fake.native_send_issue_as_webhook.assert_awaited_once()
