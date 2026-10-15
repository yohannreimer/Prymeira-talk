"""Run in manage.py shell ONLY during an approved deployment. Defaults to dry run.

Appends one opt-in tag to the owned recipient; no subscription, URL, secret,
threshold, issue or delivery writes. Never emits a notification or callback.
"""
import hmac
import os
from django.db import transaction
from apps.projects.models import Project
from apps.alerts.models import ProjectAlert, AlertRecipient
from apps.alerts.constants import RecipientType
from xing_alerts.config import Config


def run():
    apply = os.environ.get('XING_DIAGNOSTICS_APPLY') == 'yes'
    if apply and os.environ.get('XING_DIAGNOSTICS_AUTHORIZED') != 'yes':
        raise RuntimeError('explicit_deployment_authorization_required')
    config = Config.from_env()
    expected = config.base_url + '/xing-alerts/webhook/' + config.webhook_token
    with transaction.atomic():
        project = Project.undeleted_objects.get(pk=config.project_id, name=config.project_name, organization__slug=config.organization)
        alert = ProjectAlert.objects.get(project=project, name='Xing Talk operational events')
        if alert.quantity != 1 or alert.timespan_minutes != 1 or alert.uptime:
            raise RuntimeError('dedicated_alert_preconditions_changed')
        query = AlertRecipient.objects.filter(alert=alert)
        if apply:
            query = query.select_for_update()
        recipients = list(query)
        if len(recipients) != 1:
            raise RuntimeError('dedicated_recipient_preconditions_changed')
        recipient = recipients[0]
        if recipient.recipient_type != RecipientType.GENERAL_WEBHOOK or not hmac.compare_digest(recipient.url, expected):
            raise RuntimeError('dedicated_recipient_preconditions_changed')
        before = list(recipient.tags_to_add or [])
        if not {'failure_point', 'failure_code', 'service', 'release'}.issubset(before):
            raise RuntimeError('dedicated_tags_preconditions_changed')
        after = list(dict.fromkeys(before + ['diagnostic_version']))
        if apply and after != before:
            recipient.tags_to_add = after
            recipient.save(update_fields=['tags_to_add'])
        print({'mode': 'applied' if apply else 'dry_run', 'changed': after != before, 'added': ['diagnostic_version'] if after != before else []})


run()
