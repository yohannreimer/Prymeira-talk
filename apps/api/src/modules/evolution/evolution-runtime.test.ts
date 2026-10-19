import { describe, expect, it } from 'vitest';
import { createEvolutionRuntime, createUnavailableEvolutionClient } from './evolution-runtime.js';
import { classifySendFailure } from '../channels/outbound-routing.js';

const runtimeInput = { mode: 'real' as const, publicTalkUrl: 'https://example.invalid', localTalkUrl: 'http://localhost:3002', webhookSecret: 'fixture' };
describe('real messaging without Evolution configuration', () => {
  it('keeps real mode instead of silently enabling simulation', () => {
    expect(createEvolutionRuntime(runtimeInput)).toMatchObject({ mode: 'real', client: { sendText: expect.any(Function) }, providerConfigured: false });
    expect(createEvolutionRuntime({ ...runtimeInput, mode: 'simulated' })).toMatchObject({ mode: 'simulated', client: null, providerConfigured: false });
  });
  it('activates real WAHA messaging without activating simulated Evolution controls', () => {
    expect(createEvolutionRuntime({ ...runtimeInput, mode: 'simulated', messagingEnabled: true, apiBaseUrl: 'http://provider.invalid', apiKey: 'fixture' })).toMatchObject({ mode: 'real', providerConfigured: false, client: { sendText: expect.any(Function) } });
  });
  it('rejects unavailable Evolution controls and proves that no send was dispatched', async () => {
    const client = createUnavailableEvolutionClient();
    await expect(client.createInstance({ instanceName: 'fixture', webhookUrl: 'https://example.invalid', webhookSecret: 'fixture' })).rejects.toMatchObject({ code: 'EVOLUTION_UNAVAILABLE', statusCode: 503 });
    const error = await client.sendText({ instanceName: 'fixture', number: '15550001111', text: 'synthetic' }).catch(error => error);
    expect(error).toMatchObject({ code: 'EVOLUTION_UNAVAILABLE' });
    expect(classifySendFailure(error, 'evolution')).toBe('not_delivered');
  });
});
