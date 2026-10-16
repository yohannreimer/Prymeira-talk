from datetime import datetime, timezone
from dataclasses import replace
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import unittest
from support import CONFIG, PRIVATE
from test_diagnostics import technical_payload
from xing_alerts.native import select_snapshot, send_diagnostics, native_send_issue_as_webhook, SNAPSHOT_TAGS
from xing_alerts.privacy import normalize


def issue(project_id=3):
    return SimpleNamespace(pk=42, title=PRIVATE, culprit=PRIVATE, project=SimpleNamespace(
        pk=project_id, name='prymeira-talk', organization_id=1, organization=SimpleNamespace(slug='prymeira-digital')))


class NativeDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_queries_only_allowed_tag_projections_from_one_event(self):
        values = [None] * len(SNAPSHOT_TAGS) + [datetime(2026, 10, 15, tzinfo=timezone.utc)]
        query = SimpleNamespace(afirst=AsyncMock(return_value=values))
        columns = []
        query.values_list = lambda *args: (columns.extend(args) or query)
        query.order_by = lambda *args: query
        events = SimpleNamespace(filter=lambda **kwargs: query)
        tags, at = await select_snapshot(issue(), events)
        self.assertEqual(set(columns), {f'tags__{key}' for key in SNAPSHOT_TAGS} | {'timestamp'})
        self.assertNotIn('data', columns)
        self.assertEqual(len(tags), len(SNAPSHOT_TAGS))
        self.assertEqual(at.year, 2026)

    async def test_dedicated_native_emitter_uses_one_coherent_sample_and_no_titles_or_culprits(self):
        fields = technical_payload()['attachments'][0]['fields']
        tags = {key: next((f['value'] for f in fields if f['title'] == key.capitalize()), None) for key in SNAPSHOT_TAGS}
        tags['arbitrary_customer_data'] = PRIVATE
        lookup = AsyncMock(return_value=(tags, datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)))
        send = AsyncMock(return_value='accepted')
        url = CONFIG.base_url + '/xing-alerts/webhook/' + CONFIG.webhook_token
        self.assertEqual(await send_diagnostics(CONFIG, url, [issue()], lookup, send), 'accepted')
        lookup.assert_awaited_once()
        args = send.call_args.args
        self.assertNotIn(PRIVATE, str(args))
        alert = normalize({'attachments': args[2]}, CONFIG, 1000)[0]
        self.assertEqual(alert['context_source'], 'latest_issue_event')
        self.assertEqual(alert['occurred_at'], '2026-10-15T12:00:00Z')
        self.assertEqual(alert['diagnostic']['correlation_id'], 'op_' + 'a' * 32)
        self.assertLessEqual(len(args[2][0]['fields']), 32)

    async def test_scope_mismatch_and_missing_snapshot_fail_before_send(self):
        send = AsyncMock()
        url = CONFIG.base_url + '/xing-alerts/webhook/' + CONFIG.webhook_token
        with self.assertRaisesRegex(RuntimeError, 'project_mismatch'):
            await send_diagnostics(CONFIG, url, [issue(4)], AsyncMock(), send)
        with self.assertRaisesRegex(RuntimeError, 'recipient_mismatch'):
            await send_diagnostics(CONFIG, 'https://other.example/callback', [issue()], AsyncMock(), send)
        send.assert_not_awaited()

    async def test_other_native_recipients_are_unchanged(self):
        original = AsyncMock(return_value='upstream')
        with patch('xing_alerts.native.enabled', return_value=True):
            result = await native_send_issue_as_webhook(original, AsyncMock(), 'existing', [issue()], tags_to_add=['release'])
        self.assertEqual(result, 'upstream')
        original.assert_awaited_once_with('existing', unittest.mock.ANY, issue_count=1, tags_to_add=['release'])

    async def test_large_native_batch_is_split_within_existing_body_limit(self):
        fields = technical_payload()['attachments'][0]['fields']
        tags = {key: next((f['value'] for f in fields if f['title'] == key.capitalize()), None) for key in SNAPSHOT_TAGS}
        lookup = AsyncMock(return_value=(tags, datetime(2026, 10, 15, tzinfo=timezone.utc)))
        send = AsyncMock(return_value=SimpleNamespace(status=202))
        config = replace(CONFIG, max_body=4500)
        await send_diagnostics(config, config.base_url + '/xing-alerts/webhook/' + config.webhook_token, [issue()] * 10, lookup, send)
        self.assertGreater(send.await_count, 1)
        self.assertEqual(sum(len(call.args[2]) for call in send.call_args_list), 10)
        for call in send.call_args_list:
            self.assertLessEqual(len(json.dumps({'text': call.args[1], 'attachments': call.args[2]}).encode()), config.max_body)
