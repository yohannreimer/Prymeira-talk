import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { describeFailure, diagnosticTags, diagnosticContract } from './operational-diagnostic.js';
import { privateEvent } from './glitchtip.js';

// Run against the independently versioned bridge checkout, never a live service.
describe.skipIf(!process.env.TALK_ALERT_BRIDGE_SOURCE || !process.env.TALK_ALERT_PYTHON)('Talk to native webhook to MCP contract', () => {
  it('roundtrips the real Talk sanitizer through Python persistence and a signed fake callback', () => {
    const error = new TypeError("ownKeys trap did not include '$on' PRIVATE_ROUNDTRIP_FIXTURE");
    error.stack = 'TypeError: PRIVATE_ROUNDTRIP_FIXTURE\n at privateFunction (/private/operator/apps/api/src/modules/agents/agent-runtime.ts:1539:27)';
    Object.assign(error, { cause: { name: 'WahaClientError', statusCode: 500, message: 'PRIVATE_ROUNDTRIP_FIXTURE' } });
    const d = describeFailure('agent_runtime', error, { impact: 'operation_failed' });
    const event = privateEvent({ release: 'a'.repeat(40), tags: { service: 'api', failure_point: 'agent_runtime', failure_code: d.code, ...diagnosticTags(d) } })!;
    const fields = [{ title: 'Project', value: 'prymeira-talk' }, ...Object.entries({ ...event.tags, Release: event.release }).map(([key, value]) => ({ title: key[0]!.toUpperCase() + key.slice(1), value }))];
    const payload = { text: 'PRIVATE_ROUNDTRIP_FIXTURE', attachments: [{ title_link: 'https://glitchtip.prymeiradigital.com.br/prymeira-digital/issues/42', fields }] };
    const code = `import asyncio,json,sys,tempfile
from pathlib import Path
from datetime import datetime,timezone
from types import SimpleNamespace
from support import CONFIG,SECRET,URL,FakeAuth,FakeTransport
from xing_alerts.privacy import normalize
from xing_alerts.outbox import Store
from xing_alerts.delivery import Worker
from xing_alerts.diagnostics import CONTRACT
from xing_alerts.native import send_diagnostics,SNAPSHOT_TAGS
async def run():
 with tempfile.TemporaryDirectory() as tmp:
  store=Store(Path(tmp)/'state.db','dummy-key')
  try:
   store.subscribe('sub-test','12',URL,SECRET,'test-bearer',2000,1000)
   source=json.load(sys.stdin)
   original_fields=source['attachments'][0]['fields']
   tags={key:next((f['value'] for f in original_fields if f['title']==key.capitalize()),None) for key in SNAPSHOT_TAGS}
   issue=SimpleNamespace(pk=42,project=SimpleNamespace(pk=3,name='prymeira-talk',organization_id=1,organization=SimpleNamespace(slug='prymeira-digital')))
   native_payload={}
   async def lookup(issue): return tags,datetime(2026,10,15,12,0,tzinfo=timezone.utc)
   async def native_send(url,message,attachments): native_payload['attachments']=attachments
   await send_diagnostics(CONFIG,CONFIG.base_url+'/xing-alerts/webhook/'+CONFIG.webhook_token,[issue],lookup,native_send)
   alert=normalize(native_payload,CONFIG,1000)
   store.enqueue(alert,1000)
   transport=FakeTransport()
   await Worker(store,FakeAuth(lambda:1000),transport,lambda:1000).once()
   print(json.dumps({'event':json.loads(transport.calls[0][1]),'signed':'webhook-signature' in transport.calls[0][2], 'contract':CONTRACT}))
  finally: store.close()
asyncio.run(run())`;
    const result = JSON.parse(execFileSync(process.env.TALK_ALERT_PYTHON!, ['-c', code], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000,
      env: { PATH: process.env.PATH, PYTHONPATH: `${process.env.TALK_ALERT_BRIDGE_SOURCE}/tests:${process.env.TALK_ALERT_BRIDGE_SOURCE}`, PYTHONDONTWRITEBYTECODE: '1' },
    }));
    expect(result.signed).toBe(true);
    expect(result.contract).toEqual(diagnosticContract);
    expect(result.event.data.context_source).toBe('latest_issue_event');
    expect(result.event.data.occurred_at).toBe('2026-10-15T12:00:00Z');
    expect(result.event.data.diagnostic).toEqual(d);
    expect(result.event.data.release).toBe('a'.repeat(40));
    expect(JSON.stringify(result.event)).not.toMatch(/PRIVATE_|private\/operator|privateFunction/);
    expect(fields.length).toBeLessThanOrEqual(32);
  });
});
