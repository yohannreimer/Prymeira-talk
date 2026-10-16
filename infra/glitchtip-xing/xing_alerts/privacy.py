"""Reconstruct only known operational fields; never persist the input webhook."""

import re
from datetime import datetime, timezone
from .diagnostics import CONTRACT, TAG_NAMES, normalize_diagnostic

POINTS = frozenset(CONTRACT["points"])
NAMED_CODES = frozenset(CONTRACT["namedCodes"])
BROKER_CODES = frozenset(CONTRACT["brokerCodes"])
CODE_RE = re.compile(
    r"(?:P\d{4}|HISTORY_HTTP_[1-5]\d{2}|EVOLUTION_HTTP_[1-5]\d{2}|WAHA_HTTP_[1-5]\d{2}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|HANDLER_THREW)",
    re.ASCII,
)
SERVICES = frozenset(["api", "ingress", "ingress_worker", "unknown"])
# Native gather_issue_tags uses key.capitalize(), and Release has a standard label.
FIELD_NAMES = {
    "Project": "project",
    "Failure_point": "failure_point",
    "Failure_code": "failure_code",
    "Service": "service",
    "Release": "release",
}
FIELD_NAMES.update({name.capitalize(): name for name in TAG_NAMES + ["diagnostic_source", "diagnostic_occurred_at"]})


class InvalidPayload(ValueError):
    def __init__(self):
        super().__init__("invalid_alert_payload")


def safe_code(value):
    return isinstance(value, str) and (
        value in NAMED_CODES
        or bool(CODE_RE.fullmatch(value))
        or (value.startswith("INGRESS_") and value[8:].lower() in BROKER_CODES)
    )


def iso_time(at):
    return (
        datetime.fromtimestamp(at, timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def normalize(payload, config, received_at):
    if not isinstance(payload, dict):
        raise InvalidPayload()
    attachments = payload.get("attachments")
    if (
        not isinstance(attachments, list)
        or not 1 <= len(attachments) <= config.max_attachments
    ):
        raise InvalidPayload()
    output = []
    for attachment in attachments:
        if not isinstance(attachment, dict):
            raise InvalidPayload()
        fields = attachment.get("fields")
        if not isinstance(fields, list) or len(fields) > 32:
            raise InvalidPayload()
        tags = {}
        for field in fields:
            if not isinstance(field, dict):
                raise InvalidPayload()
            name = (
                FIELD_NAMES.get(field.get("title"))
                if isinstance(field.get("title"), str)
                else None
            )
            if name:
                if name in tags:
                    raise InvalidPayload()
                tags[name] = field.get("value")
        if tags.get("project") != config.project_name:
            raise InvalidPayload()
        url = attachment.get("title_link")
        # Exact native path, fixed origin, no queries/fragments/auth/encoding allowed.
        pattern = (
            re.escape(config.base_url + "/" + config.organization + "/issues/")
            + r"([1-9][0-9]{0,18})"
        )
        match = re.fullmatch(pattern, url, re.ASCII) if isinstance(url, str) else None
        if not match:
            raise InvalidPayload()
        point = tags.get("failure_point")
        code = tags.get("failure_code")
        service = tags.get("service")
        release = tags.get("release")
        output.append(
            {
                "projectId": config.project_id,
                "failure_point": point
                if isinstance(point, str) and point in POINTS
                else "fatal",
                "failure_code": code if safe_code(code) else "UNEXPECTED_ERROR",
                "service": service
                if isinstance(service, str) and service in SERVICES
                else "unknown",
                "release": release
                if isinstance(release, str) and re.fullmatch("[a-f0-9]{7,40}", release)
                else None,
                # Native general webhook carries no occurrence time; this is the receipt time.
                "timestamp": iso_time(received_at),
                "url": config.base_url
                + "/"
                + config.organization
                + "/issues/"
                + match[1],
            }
        )
    for alert, attachment in zip(output, attachments):
        tags = {FIELD_NAMES[f["title"]]: f.get("value") for f in attachment["fields"]
                if isinstance(f.get("title"), str) and f["title"] in FIELD_NAMES}
        diagnostic = normalize_diagnostic(tags, alert["failure_point"], alert["failure_code"], safe_code)
        if diagnostic is not None:
            alert["diagnostic"] = diagnostic
        if tags.get("diagnostic_source") == "latest_issue_event":
            at = tags.get("diagnostic_occurred_at")
            if isinstance(at, str) and re.fullmatch(r"20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z", at, re.ASCII):
                try:
                    alert["occurred_at"] = datetime.fromisoformat(at.replace("Z", "+00:00")).isoformat().replace("+00:00", "Z")
                    alert["context_source"] = "latest_issue_event"
                except ValueError:
                    pass
    return output
