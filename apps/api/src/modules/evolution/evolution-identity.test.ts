import { describe, expect, it, vi } from 'vitest';
import { createEvolutionClient } from './evolution.client.js';
describe('verified Evolution identity', () => {
  it('retrieves actual owner identity from the named instance, never the first unrelated instance', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify([{ name: 'other', ownerJid: '11111111111@s.whatsapp.net' }, { name: 'talk', ownerJid: '5547999990000@s.whatsapp.net' }])));
    const client = createEvolutionClient({ baseUrl: 'https://evolution.example', apiKey: 'secret', fetch });
    expect(await client.getInstanceIdentity!({ instanceName: 'talk' })).toBe('5547999990000@s.whatsapp.net');
    expect(fetch.mock.calls[0][0]).toBe('https://evolution.example/instance/fetchInstances?instanceName=talk');
  });
  it('refuses missing/mismatched identities and supports legacy nested instances', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify([{ instance: { instanceName: 'talk', owner: '5547999990000@c.us' } }])));
    const client = createEvolutionClient({ baseUrl: 'https://evolution.example', apiKey: 'secret', fetch });
    expect(await client.getInstanceIdentity!({ instanceName: 'talk' })).toBe('5547999990000@c.us');
    expect(await client.getInstanceIdentity!({ instanceName: 'foreign' })).toBeNull();
  });
});
