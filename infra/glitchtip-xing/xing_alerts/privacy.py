"""Reconstruct only known operational fields; never persist the input webhook."""

import re
from datetime import datetime, timezone

POINTS = frozenset(
    [
        "api",
        "ingress_http",
        "transport_setup",
        "transport_delivery",
        "application_retry",
        "application_dead_letter",
        "recertification_event",
        "recertification_sweep",
        "effect_loop",
        "effect_handler",
        "effect_exhausted",
        "waha_history",
        "gap_recovery",
        "lid_resolution",
        "fatal",
    ]
)
NAMED_CODES = frozenset(
    [
        "HISTORY_DUPLICATE_MESSAGE",
        "MEDIA_UNAVAILABLE",
        "MEDIA_TIMEOUT",
        "MEDIA_TOO_LARGE",
        "UNSUPPORTED_MEDIA_TYPE",
        "PROSPECTING_STATE_UNKNOWN",
        "EFFECT_WITHOUT_MESSAGE",
        "NOT_AN_ATTACHMENT",
        "STALE_SOURCE",
        "INVALID_UNICODE",
        "UNEXPECTED_ERROR",
    ]
)
BROKER_CODES = frozenset(
    [
        "publisher_backpressure",
        "publisher_unavailable",
        "publication_in_progress",
        "publish_deadline",
        "publish_nack",
        "publish_error",
        "unroutable",
        "broker_blocked",
        "channel_error",
        "channel_closed",
        "connection_error",
        "connection_closed",
        "publisher_closed",
    ]
)
CODE_RE = re.compile(
    r"(?:P\d{4}|HISTORY_HTTP_\d{3}|EVOLUTION_HTTP_\d{3}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|HANDLER_THREW)",
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
    return output
