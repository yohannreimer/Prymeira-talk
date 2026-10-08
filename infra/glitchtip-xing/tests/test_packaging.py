import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/install_extension.py"
spec = importlib.util.spec_from_file_location("installer", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PackagingTests(unittest.TestCase):
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
