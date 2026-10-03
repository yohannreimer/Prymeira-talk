import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const load = () => import('./waha.client.js');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('WAHA HTTP contracts', () => {
  it('rejects non-origin base URLs and unsupported URL schemes', async () => {
    const { createWahaClient } = await load();
    for (const baseUrl of ['https://waha.example/api', 'file:///tmp/waha', 'https://secret@waha.example', 'https://waha.example?secret=x']) expect(() => createWahaClient({ baseUrl, apiKey: 'secret' })).toThrow('Invalid WAHA');
  });
  it('never forwards credentials through a real redirect to another origin', async () => {
    const received = vi.fn();
    const destination = createServer((request, response) => { received(request.headers); response.end('private'); });
    destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
    const destinationUrl = `http://127.0.0.1:${(destination.address() as AddressInfo).port}/private`;
    const provider = createServer((request, response) => {
      expect(request.headers['x-api-key']).toBe('test-secret');
      response.writeHead(302, { location: destinationUrl }); response.end();
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
    try {
      const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
      const client = (await load()).createWahaClient({ baseUrl, apiKey: 'test-secret' });
      await expect(client.getMediaBytes({ url: `${baseUrl}/api/files/a` })).rejects.toThrow();
      expect(received).not.toHaveBeenCalled();
    } finally {
      await Promise.all([new Promise<void>((resolve) => provider.close(() => resolve())), new Promise<void>((resolve) => destination.close(() => resolve()))]);
    }
  });
  it('limits declared and streamed media size and cancels an oversized body', async () => {
    const cancelled = vi.fn();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('huge', { headers: { 'content-length': '20' } }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); }, cancel: cancelled })));
    const client = (await load()).createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'secret', fetch, maxMediaBytes: 10 });
    await expect(client.getMediaBytes({ url: '/api/files/a' })).rejects.toThrow('size limit');
    await expect(client.getMediaBytes({ url: '/api/files/b' })).rejects.toThrow('size limit');
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it('provides a real authenticated session client', async () => {
    expect((await load()).createWahaClient).toBeTypeOf('function');
  });
  it('reads the server engine/version using the documented endpoint', async () => {
    const fetch = vi.fn(async () => json({ version: '2026.9.1', engine: 'WPP' }));
    const client = (await load()).createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'secret', fetch });
    expect(await client.getVersion()).toMatchObject({ version: '2026.9.1', engine: 'WPP' });
  });

  it('asks WAHA to deliver every event Talk understands to the ingress, signed with the shared HMAC key and retried', async () => {
    const fetch = vi.fn().mockImplementation(async () => json({ name: 'talk-a', status: 'STOPPED' }));
    const { createWahaClient, WAHA_WEBHOOK_EVENTS } = await load();
    const client = createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'test-secret', fetch });
    await client.createSession({ session: 'talk-a', workspaceId: 'ws', channelId: 'ch', webhook: { url: 'http://ingress:4011/webhooks/waha/ws/conn', hmacKey: 'shared-hmac-key-1234567' } });
    expect(JSON.parse(fetch.mock.calls[0][1].body).config).toEqual({ metadata: { workspaceId: 'ws', channelId: 'ch' },
      webhooks: [{ url: 'http://ingress:4011/webhooks/waha/ws/conn', events: WAHA_WEBHOOK_EVENTS, hmac: { key: 'shared-hmac-key-1234567' }, retries: { policy: 'exponential', delaySeconds: 2, attempts: 15 } }] });
    expect(WAHA_WEBHOOK_EVENTS).toEqual(expect.arrayContaining(['message.any', 'message.edited', 'message.revoked', 'message.ack', 'message.ack.group', 'session.status']));
  });

  it('provisions a stopped named session and uses independent start, raw QR, state, me and stop endpoints', async () => {
    const fetch = vi.fn().mockImplementation(async () => json({ name: 'talk-a', status: 'STOPPED' }));
    const client = (await load()).createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'test-secret', fetch });
    await client.createSession({ session: 'talk-a', workspaceId: 'ws', channelId: 'ch' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: 'talk-a', start: false, config: { metadata: { workspaceId: 'ws', channelId: 'ch' } } });
    await client.startSession({ session: 'talk-a' });
    fetch.mockResolvedValueOnce(json({ value: 'raw-qr' }));
    expect(await client.getQr({ session: 'talk-a' })).toBe('raw-qr');
    await client.getSession({ session: 'talk-a' });
    await client.getMe({ session: 'talk-a' });
    await client.stopSession({ session: 'talk-a' });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://waha.example/api/sessions', 'https://waha.example/api/sessions/talk-a/start',
      'https://waha.example/api/talk-a/auth/qr?format=raw', 'https://waha.example/api/sessions/talk-a',
      'https://waha.example/api/sessions/talk-a/me', 'https://waha.example/api/sessions/talk-a/stop'
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init.headers).get('X-Api-Key')).toBe('test-secret');
      expect(init.redirect).toBe('error');
    }
  });

  it('sends bytes inline for media and voice, text and contact using documented contracts', async () => {
    const fetch = vi.fn().mockImplementation(async () => json({ id: 'msg-id' }));
    const client = (await load()).createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'secret', fetch });
    const target = { session: 'talk', chatId: '5547999990000@c.us' };
    expect((await client.sendText({ ...target, text: 'hello' })).providerMessageId).toBe('msg-id');
    await client.sendMedia({ ...target, kind: 'image', data: 'aGVsbG8=', mimetype: 'image/png', filename: 'hello.png', caption: 'Caption' });
    await client.sendVoice({ ...target, data: 'aGVsbG8=', mimetype: 'audio/ogg; codecs=opus', filename: 'voice.ogg' });
    await client.sendContact({ ...target, contacts: [{ fullName: 'Ana', phoneNumber: '+5547999990000', whatsappId: '5547999990000' }] });
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/sendText', '/api/sendImage', '/api/sendVoice', '/api/sendContactVcard']);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ ...target, file: { data: 'aGVsbG8=', mimetype: 'image/png', filename: 'hello.png' }, caption: 'Caption' });
    expect(JSON.parse(fetch.mock.calls[2][1].body).convert).toBe(true);
  });

  it('retrieves history/message, groups, contacts, profile and availability using encoded identities', async () => {
    const fetch = vi.fn().mockImplementation(async () => json([]));
    const client = (await load()).createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'secret', fetch });
    const target = { session: 'talk', chatId: 'group@g.us' };
    await client.getChats({ session: 'talk', limit: 30, offset: 5 });
    await client.getMessages({ ...target, limit: 50, offset: 0 });
    await client.getMessage({ ...target, messageId: 'false_group@g.us_A/B' });
    await client.deleteMessage({ ...target, messageId: 'false_group@g.us_A/B' });
    await client.getGroups({ session: 'talk' });
    await client.getGroup({ session: 'talk', groupId: 'group@g.us' });
    await client.getGroupParticipants({ session: 'talk', groupId: 'group@g.us' });
    await client.getContacts({ session: 'talk' });
    await client.getContact({ session: 'talk', contactId: '123@c.us' });
    await client.getContactProfilePicture({ session: 'talk', contactId: '123@c.us' });
    await client.getProfile({ session: 'talk' });
    await client.checkNumber({ session: 'talk', phone: '123' });
    expect(fetch.mock.calls[1][0]).toBe('https://waha.example/api/talk/chats/group%40g.us/messages?limit=50&offset=0&downloadMedia=false');
    expect(fetch.mock.calls[2][0]).toContain('/messages/false_group%40g.us_A%2FB');
    expect(fetch.mock.calls[3][1].method).toBe('DELETE');
    expect(fetch.mock.calls[11][0]).toBe('https://waha.example/api/contacts/check-exists?session=talk&phone=123');
  });

  it('reads a GOWS file published under WAHA\'s own localhost base from the configured WAHA origin, with the key', async () => {
    const { createWahaClient } = await load();
    const { parseWahaMessageKey } = await import('../messaging/whatsapp-identity.js');
    const id = 'false_5547999990000@c.us_3EB0IMG';
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/messages/')) return json({ id, from: '5547999990000@c.us', fromMe: false, hasMedia: true,
        media: { url: 'http://localhost:3000/api/files/s1/3EB0IMG.jpeg', mimetype: 'image/jpeg' },
        _data: { Info: { Chat: '5547999990000@s.whatsapp.net', Sender: '5547999990000@s.whatsapp.net', IsFromMe: false, IsGroup: false, ID: '3EB0IMG' }, Message: { imageMessage: {} } } });
      expect(url).toBe('http://waha:3000/api/files/s1/3EB0IMG.jpeg');
      expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('k');
      return new Response('jpeg-bytes');
    });
    const client = createWahaClient({ baseUrl: 'http://waha:3000', apiKey: 'k', fetch: fetch as never });
    const found = await client.mediaExact({ session: 's1', key: parseWahaMessageKey(id), purpose: 'serve' });
    expect(found.kind).toBe('resolved');
    if (found.kind === 'resolved') expect(Buffer.from(found.bytes).toString()).toBe('jpeg-bytes');
  });
  it('only downloads provider media from its configured origin without following redirects or URL credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('media'));
    const client = (await load()).createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'secret', fetch });
    for (const url of ['http://127.0.0.1/private', 'https://other.example/api/files/a', 'https://user:pass@waha.example/api/files/a', '//other.example/a', 'https://waha.example/admin']) {
      await expect(client.getMediaBytes({ url })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(Buffer.from(await client.getMediaBytes({ url: 'https://waha.example/api/files/a' })).toString()).toBe('media');
    expect(fetch.mock.calls[0][1].redirect).toBe('error');
  });

  it('does not retain provider error bodies or secrets and aborts timed out HTTP calls', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ apiKey: 'secret', detail: 'private' }, 503));
    const client = (await load()).createWahaClient({ baseUrl: 'https://waha.example', apiKey: 'secret', fetch });
    await expect(client.getSession({ session: 'talk' })).rejects.toMatchObject({ statusCode: 503, message: 'WAHA request failed (503)' });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
