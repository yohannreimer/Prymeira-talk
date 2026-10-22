export const workspaceUnitCommand = ['-r', 'run', 'test', '--maxWorkers=2'];
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const integrationDatabases = ['messaging_test', 'campaign_test', 'connections_test', 'assistant_pilot_test', 'supervision_test', 'automation_webhook_test', 'leads_task2_test', 'purchasing_test', 'talk_rehearsal'];
export const databaseVariables = {
  CTWA_TEST_DATABASE_URL: 'messaging_test',
  MESSAGING_TEST_DATABASE_URL: 'messaging_test', CAMPAIGN_INTEGRATION_DATABASE_URL: 'campaign_test', CONNECTIONS_TEST_DATABASE_URL: 'connections_test',
  ASSISTANT_TEST_DATABASE_URL: 'assistant_pilot_test', SUPERVISION_TEST_DATABASE_URL: 'supervision_test',
  AUTOMATION_WEBHOOK_TEST_DATABASE_URL: 'automation_webhook_test', LEADS_TEST_DATABASE_URL: 'leads_task2_test', PURCHASING_TEST_DATABASE_URL: 'purchasing_test', REHEARSAL_DATABASE_URL: 'talk_rehearsal'
};

export function validateInfrastructure({ adminUrl, brokerUrl, postgresPort = '55439', amqpPort = '56739' }) {
  const pg = new URL(adminUrl), broker = new URL(brokerUrl);
  for (const value of [postgresPort, amqpPort]) if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('Explicit valid fixture ports required');
  if (!['postgres:', 'postgresql:'].includes(pg.protocol) || pg.hostname !== '127.0.0.1' || pg.port !== postgresPort || pg.pathname !== '/postgres')
    throw new Error('Owned loopback PostgreSQL admin URL on the explicit fixture port required');
  if (broker.protocol !== 'amqp:' || broker.hostname !== '127.0.0.1' || broker.port !== amqpPort || decodeURIComponent(broker.pathname) !== '/talk_test')
    throw new Error('Owned loopback RabbitMQ talk_test vhost on the explicit fixture port required');
  const urls = Object.fromEntries(integrationDatabases.map(name => { const url = new URL(pg); url.pathname = `/${name}`; return [name, url.toString()]; }));
  return { databases: [...integrationDatabases], urls, adminUrl, brokerUrl };
}

export async function findIntegrationTests(root) {
  const files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.test.ts') && /process\.env\.(?:[A-Z_]*TEST_DATABASE_URL|CAMPAIGN_INTEGRATION_DATABASE_URL|REHEARSAL_DATABASE_URL|INGRESS_TEST_AMQP_URL)/.test(await readFile(path, 'utf8'))) files.push(path);
    }
  }
  await visit(root); return files.sort();
}

export async function runSerialIntegration(files, run) {
  if (!files.length) throw new Error('No opted-in integration tests discovered');
  for (const file of files) await run(file);
}

export function releaseManifest({ sha, validatedSha, apiDigest, webDigest, imageOwner, registry = 'ghcr.io' }) {
  if (!/^[a-f0-9]{40}$/.test(sha) || sha !== validatedSha) throw new Error('Published SHA must equal the successfully validated SHA');
  if (![apiDigest, webDigest].every(value => /^sha256:[a-f0-9]{64}$/.test(value))) throw new Error('Both immutable image digests required');
  const image = name => imageOwner ? `${registry}/${imageOwner.toLowerCase()}/${name}` : name;
  return { schemaVersion: 1, sha, validatedSha,
    components: { api: { image: image('prymeira-talk-api'), digest: apiDigest }, web: { image: image('prymeira-talk-web'), digest: webDigest },
      ingress: { image: image('prymeira-talk-api'), digest: apiDigest, command: 'node dist/ingress.js' }, worker: { image: image('prymeira-talk-api'), digest: apiDigest, command: 'node dist/ingress-worker.js' } },
    deploymentVerificationRequired: ['deployed service digest/revision', 'applied migration state', 'OUTBOUND_ROUTER_ENABLED', 'WAHA_ROLLOUT_WORKSPACES', 'INGRESS_TRANSPORT_STAGE', 'INGRESS_NAMESPACE', 'INGRESS_WORKSPACE_ALLOWLIST', 'INGRESS_RECOVERY_ENABLED', 'WAHA_ENABLED', 'WAHA_HISTORY_IMPORT_ENABLED', 'CHANNEL_HEALTH_MONITOR_ENABLED', 'EFFECTS_ENABLED', 'REALTIME_BRIDGE_ENABLED', 'CANONICAL_HISTORY_IMPORT_ENABLED', 'LEGACY_WEBHOOK_DELEGATED_WORKSPACES'],
    rollback: 'Retain the prior release manifest and redeploy its exact component digests. Check schema compatibility before rollback; additive migrations are not automatically reversed.' };
}
