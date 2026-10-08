import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from xing_alerts.config import Config

CONFIG = Config(
    organization="prymeira-digital", project_id=3, project_name="prymeira-talk"
)
SECRET = "whsec_" + base64.b64encode(b"a" * 32).decode()
SECRET2 = "whsec_" + base64.b64encode(b"b" * 32).decode()
URL = "https://receiver.example/events/callback"
PRIVATE = "customer +5511999999999 token_password_do_not_forward"
MODERN_META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {"name": "ExampleClient", "version": "1.0.0"},
    "progressToken": "test-progress",
    "com.example/requestId": "opaque-test-value",
}


def payload(issue=42):
    return {
        "text": PRIVATE,
        "unknown": PRIVATE,
        "attachments": [
            {
                "title": PRIVATE,
                "text": PRIVATE,
                "image_url": PRIVATE,
                "title_link": f"{CONFIG.base_url}/prymeira-digital/issues/{issue}",
                "fields": [
                    {"title": "Project", "value": "prymeira-talk"},
                    {"title": "Failure_point", "value": "transport_delivery"},
                    {"title": "Failure_code", "value": "ECONNRESET"},
                    {"title": "Service", "value": "api"},
                    {"title": "Release", "value": "abcdef12345"},
                    {"title": "Server Name", "value": PRIVATE},
                    {"title": PRIVATE, "value": PRIVATE},
                ],
            }
        ],
    }


class FakeAuth:
    def __init__(self, now):
        self.now = now
        self.allowed = True
        self.calls = 0

    async def authenticate(self, bearer):
        from xing_alerts.auth import Unauthorized, Principal

        self.calls += 1
        if not self.allowed or bearer != "test-bearer":
            raise Unauthorized()
        return Principal("12", self.now() + 3600)


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.statuses = []
        self.bad_challenge = False

    async def post(self, url, body, headers):
        self.calls.append((url, body, headers))
        status = self.statuses.pop(0) if self.statuses else 200
        data = json.loads(body)
        if data.get("type") == "verification":
            return status, json.dumps(
                {"challenge": "wrong" if self.bad_challenge else data["challenge"]}
            ).encode()
        return status, b"{}"
