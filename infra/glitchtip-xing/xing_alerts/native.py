"""Dedicated native recipient: coherent, allowlisted fields from one event.

No polling and no event body, title, request, user, SQL or arbitrary tag reads.
Other native alert recipients keep the upstream implementation.
"""

import hmac
import json
import time
from datetime import timezone
from .config import Config, enabled
from .diagnostics import TAG_NAMES
from .privacy import normalize

BASE_TAGS = ["failure_point", "failure_code", "service", "release"]
SNAPSHOT_TAGS = BASE_TAGS + TAG_NAMES


async def select_snapshot(issue, events=None):
    if events is None:
        from apps.issue_events.models import IssueEvent
        events = IssueEvent.objects
    columns = [f"tags__{key}" for key in SNAPSHOT_TAGS] + ["timestamp"]
    row = await events.filter(issue_id=issue.pk, organization_id=issue.project.organization_id).order_by("-id").values_list(*columns).afirst()
    if row is None:
        raise RuntimeError("talk_diagnostic_snapshot_unavailable")
    return dict(zip(SNAPSHOT_TAGS, row[:-1])), row[-1]


async def send_diagnostics(config, url, issues, lookup, send):
    # This is the GlitchTip -> own bridge hop; Xing callbacks remain exclusively
    # native platform subscription values and are not changed by this extension.
    expected = config.base_url + "/xing-alerts/webhook/" + config.webhook_token
    if not isinstance(url, str) or not hmac.compare_digest(url, expected):
        raise RuntimeError("talk_diagnostic_recipient_mismatch")
    if len(issues) > config.max_attachments:
        raise RuntimeError("talk_diagnostic_batch_limit")
    attachments = []
    for issue in issues:
        project = issue.project
        if (project.pk != config.project_id or project.name != config.project_name
                or project.organization.slug != config.organization):
            raise RuntimeError("talk_diagnostic_project_mismatch")
        tags, occurred_at = await lookup(issue)
        # Reuse the same strict validator as the inbound bridge before creating
        # the native attachment. Titles/culprits never cross this dedicated hop.
        fields = [{"title": "Project", "value": config.project_name, "short": True}]
        fields += [{"title": key.capitalize(), "value": tags.get(key), "short": False}
                   for key in SNAPSHOT_TAGS if tags.get(key) is not None]
        attachment = {"title_link": f"{config.base_url}/{config.organization}/issues/{issue.pk}", "fields": fields}
        clean = normalize({"attachments": [attachment]}, config, time.time())[0]
        # Use only the normalized tags. Unknown values cannot re-enter via this hop.
        safe_tags = {key: clean[key] for key in BASE_TAGS}
        diagnostic = clean.get("diagnostic")
        if diagnostic:
            safe_tags.update({"diagnostic_version": "1", "error_type": diagnostic["type"],
                "technical_cause": diagnostic["technical_cause"], "component": diagnostic["component"],
                "operation": diagnostic["operation"], "diagnostic_location": diagnostic["location"],
                "impact": diagnostic["impact"], "recovery": diagnostic["recovery"]})
            if diagnostic["correlation_id"]:
                safe_tags["correlation_id"] = diagnostic["correlation_id"]
            for i, frame in enumerate(diagnostic["frames"]):
                safe_tags[f"diagnostic_frame_{i}"] = f"{frame['filename']}:{frame.get('lineno', 0)}:{frame.get('colno', 0)}"
            for i, cause in enumerate(diagnostic["causes"]):
                safe_tags[f"cause_type_{i}"] = cause["type"]
                safe_tags[f"cause_code_{i}"] = cause["code"]
        fields = [{"title": "Project", "value": config.project_name, "short": True}]
        fields += [{"title": key.capitalize(), "value": value, "short": False} for key, value in safe_tags.items() if value is not None]
        fields += [{"title": "Diagnostic_source", "value": "latest_issue_event", "short": False},
                   {"title": "Diagnostic_occurred_at", "value": occurred_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), "short": False}]
        attachments.append({"title": "Talk operational diagnostic", "text": "", "title_link": clean["url"], "fields": fields,
                            "image_url": None, "color": None, "mrkdown_in": None})
    # Keep each native request within the existing inbound body budget. Do not
    # silently drop a large native notification or increase the bridge's limits.
    message = "GlitchTip Talk operational alert"
    batch = []
    response = None
    for attachment in attachments:
        candidate = batch + [attachment]
        size = len(json.dumps({"text": message, "attachments": candidate}).encode())
        if batch and size > config.max_body:
            response = await send(url, message, batch)
            if response is None or not 200 <= getattr(response, "status", 200) < 300:
                return response
            batch = []
        batch.append(attachment)
        if len(json.dumps({"text": message, "attachments": batch}).encode()) > config.max_body:
            raise RuntimeError("talk_diagnostic_attachment_limit")
    if batch:
        response = await send(url, message, batch)
    return response


async def native_send_issue_as_webhook(original, native_send, url, issues, issue_count=1, tags_to_add=None, **kwargs):
    if not enabled() or "diagnostic_version" not in (tags_to_add or []):
        return await original(url, issues, issue_count=issue_count, tags_to_add=tags_to_add, **kwargs)
    from apps.alerts.webhooks import WebhookAttachment, WebhookAttachmentField

    async def send(url, message, attachments):
        native = [WebhookAttachment(**{**item, "fields": [WebhookAttachmentField(**field) for field in item["fields"]]}) for item in attachments]
        return await native_send(url, message, native)

    return await send_diagnostics(Config.from_env(), url, issues, select_snapshot, send)
