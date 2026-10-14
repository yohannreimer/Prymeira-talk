import { describe, expect, it } from 'vitest';
import { ALL_WORKSPACES, readIngressEnvironment, stageAppliesReceipts } from './runtime.js';

const isolated = {
  INGRESS_TRANSPORT_STAGE: 'isolated-1b', DATABASE_URL: 'postgresql://talk@127.0.0.1:55439/messaging_test', INGRESS_AMQP_URL: 'amqp://guest:guest@127.0.0.1:56739/talk_test',
  INGRESS_NAMESPACE: 'talk.isolated.test', INGRESS_PRIVATE_ROOT: '/private/tmp/x', INGRESS_WORKSPACE_ALLOWLIST: 'ws1'
};
const production = {
  INGRESS_TRANSPORT_STAGE: 'production', DATABASE_URL: 'postgresql://postgres:secret@postgres:5432/prymeira_talk', INGRESS_AMQP_URL: 'amqp://talk:s3cret@rabbitmq:5672/talk',
  INGRESS_NAMESPACE: 'talk.prod.main', INGRESS_PRIVATE_ROOT: '/var/lib/talk/ingress', INGRESS_WORKSPACE_ALLOWLIST: 'ws1,ws2',
  INGRESS_EVOLUTION_SECRET: 'evolution-secret-123456', INGRESS_WAHA_SECRET: 'waha-secret-1234567890'
};
const read = (over: Record<string, string | undefined> = {}) => readIngressEnvironment({ ...production, ...over } as NodeJS.ProcessEnv);

describe('ingress environment', () => {
  it('keeps the isolated stages locked to the owned loopback test infrastructure', () => {
    expect(readIngressEnvironment(isolated as never)).toMatchObject({ stage: 'isolated-1b', allowAllWorkspaces: false });
    expect(() => readIngressEnvironment({ ...isolated, DATABASE_URL: 'postgresql://postgres:x@postgres:5432/prymeira_talk' } as never)).toThrow(/Owned isolated PostgreSQL/);
    expect(() => readIngressEnvironment({ ...isolated, INGRESS_AMQP_URL: 'amqp://talk:x@rabbitmq:5672/talk' } as never)).toThrow(/Owned isolated RabbitMQ/);
    expect(() => readIngressEnvironment({ ...isolated, INGRESS_WORKSPACE_ALLOWLIST: '*' } as never)).toThrow(/Only the production stage/);
    expect(() => readIngressEnvironment({ ...isolated, INGRESS_TRANSPORT_STAGE: 'staging' } as never)).toThrow(/explicit stage/);
  });

  it('accepts the real database and a dedicated Talk vhost in production, applying receipts', () => {
    const config = read();
    expect(config).toMatchObject({ stage: 'production', allowAllWorkspaces: false, privateRoot: '/var/lib/talk/ingress' });
    expect([...config.workspaceAllowlist]).toEqual(['ws1', 'ws2']);
    expect(stageAppliesReceipts('production')).toBe(true);
    expect(stageAppliesReceipts('isolated-1a')).toBe(false);
  });

  it('never lets Talk use the shared default vhost or somebody else’s vhost', () => {
    for (const url of ['amqp://talk:s3cret@rabbitmq:5672/', 'amqp://talk:s3cret@rabbitmq:5672', 'amqp://talk:s3cret@rabbitmq:5672/operis', 'amqp://talk:s3cret@rabbitmq:5672/%2F']) {
      expect(() => read({ INGRESS_AMQP_URL: url }), url).toThrow(/dedicated Talk RabbitMQ vhost/);
    }
    expect(read({ INGRESS_AMQP_URL: 'amqps://talk:s3cret@rabbitmq:5671/talk_prod' }).amqpUrl).toContain('/talk_prod');
    expect(() => read({ INGRESS_AMQP_URL: 'amqp://rabbitmq:5672/talk' })).toThrow(/dedicated RabbitMQ user/);
  });

  it('refuses a test database, relative paths, missing or short webhook secrets and an empty scope', () => {
    expect(() => read({ DATABASE_URL: 'postgresql://talk@postgres:5432/messaging_test' })).toThrow(/test database/);
    expect(() => read({ INGRESS_PRIVATE_ROOT: 'relative/path' })).toThrow(/absolute INGRESS_PRIVATE_ROOT/);
    expect(() => read({ INGRESS_EVOLUTION_SECRET: undefined })).toThrow(/INGRESS_EVOLUTION_SECRET/);
    expect(() => read({ INGRESS_WAHA_SECRET: 'short' })).toThrow(/INGRESS_WAHA_SECRET/);
    expect(() => read({ INGRESS_WORKSPACE_ALLOWLIST: '' })).toThrow(/INGRESS_WORKSPACE_ALLOWLIST/);
    expect(() => read({ TALK_MEDIA_STORE_PATH: 'media' })).toThrow(/TALK_MEDIA_STORE_PATH/);
    expect(() => read({ INGRESS_NAMESPACE: 'talk.isolated.main' })).toThrow(/talk\.prod\./);
    expect(() => readIngressEnvironment({ ...isolated, INGRESS_NAMESPACE: 'talk.prod.main' } as never)).toThrow(/talk\.isolated\./);
  });

  it('accepts every workspace only when production asks for it explicitly with a lone *', () => {
    expect(read({ INGRESS_WORKSPACE_ALLOWLIST: '*' })).toMatchObject({ allowAllWorkspaces: true });
    expect(read({ INGRESS_WORKSPACE_ALLOWLIST: '*' }).workspaceAllowlist.size).toBe(0);
    expect(read({ INGRESS_WORKSPACE_ALLOWLIST: 'ws1,*' }).allowAllWorkspaces).toBe(false);
    expect(ALL_WORKSPACES.has('anything')).toBe(true);
  });
  it('keeps gap recovery and the WAHA history complement off unless explicitly enabled', () => {
    expect(read()).toMatchObject({ gapRecovery: false, wahaHistoryImport: false });
    expect(read({ INGRESS_RECOVERY_ENABLED: 'true', WAHA_HISTORY_IMPORT_ENABLED: 'true' })).toMatchObject({ gapRecovery: true, wahaHistoryImport: true });
    expect(read({ INGRESS_RECOVERY_ENABLED: 'yes' })).toMatchObject({ gapRecovery: false });
  });
});
