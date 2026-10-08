import os
import re
from dataclasses import dataclass
from pathlib import Path

RESOURCE = "https://glitchtip.prymeiradigital.com.br/mcp"
EVENT_NAME = "talk.operational_alert"


@dataclass(frozen=True)
class Config:
    organization: str
    project_id: int
    project_name: str
    base_url: str = "https://glitchtip.prymeiradigital.com.br"
    state_path: str = "/var/lib/xing-alerts/state.sqlite3"
    webhook_token: str = ""
    max_body: int = 65536
    max_attachments: int = 100

    def __post_init__(self):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,49}", self.organization):
            raise ValueError("invalid organization configuration")
        if type(self.project_id) is not int or self.project_id <= 0:
            raise ValueError("invalid project configuration")
        if self.project_name != "pra-talk" or self.base_url != RESOURCE.removesuffix(
            "/mcp"
        ):
            raise ValueError("Talk-only configuration required")

    @classmethod
    def from_env(cls):
        token_file = os.environ.get("XING_WEBHOOK_TOKEN_FILE")
        token = (
            Path(token_file).read_text().strip()
            if token_file
            else os.environ.get("XING_WEBHOOK_TOKEN", "")
        )
        if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token):
            raise ValueError(
                "webhook secret must be a random URL-safe token of at least 32 bytes"
            )
        return cls(
            organization=os.environ["XING_ORGANIZATION_SLUG"],
            project_id=int(os.environ["XING_PROJECT_ID"]),
            project_name=os.environ.get("XING_PROJECT_NAME", "pra-talk"),
            state_path=os.environ.get(
                "XING_STATE_PATH", "/var/lib/xing-alerts/state.sqlite3"
            ),
            webhook_token=token,
        )


def enabled():
    return os.environ.get("XING_EVENTS_ENABLED", "false").lower() == "true"
