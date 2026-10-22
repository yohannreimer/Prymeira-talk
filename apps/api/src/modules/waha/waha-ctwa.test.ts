import { describe, expect, it } from 'vitest';
import { extractWahaCtwa } from './waha-ctwa.js';
import { normalizeWahaEvent } from './waha-normalizer.js';
import type { TrustedMessagingContext } from '../messaging/normalized-event.js';
const context: TrustedMessagingContext = { workspaceId: 'synthetic', channelId: 'synthetic', provider: 'waha', channelProvider: 'evolution', connectionId: 'synthetic', sessionName: 'synthetic', lifecycleGeneration: 1, mode: 'live', observedAt: '2026-10-19T12:00:00Z' };
const click = 'Synthetic-Opaque_Click+123=';
const native = (message: unknown) => ({ event: 'message.any', payload: { id: 'false_5500000000000@c.us_TEST', from: '5500000000000@c.us', fromMe: false, body: 'synthetic', timestamp: 1792400000, _data: { Info: { IsFromMe: false, IsGroup: false, Chat: '5500000000000@s.whatsapp.net', ID: 'TEST' }, Message: message } } });
const camel = () => ({ extendedTextMessage: { text: 'synthetic', contextInfo: { externalAdReply: { ctwaClid: click, sourceId: '123' } } } });
describe('bounded native WAHA CTWA context', () => {
  it.each([camel(), { ExtendedTextMessage: { Text: 'synthetic', ContextInfo: { ExternalAdReply: { CTWAClid: click, SourceID: '123' } } } }, { EphemeralMessage: { Message: { ViewOnceMessageV2: { Message: camel() } } } }])('preserves exact opaque click through native wrappers', message => {
    expect(extractWahaCtwa(native(message))).toEqual({ ctwaClid: click, adId: '123' });
  });
  it('extracts before GOWS translation without changing existing identity/content', () => {
    const withClick = normalizeWahaEvent(context, native(camel()));
    const absent = normalizeWahaEvent(context, native({ extendedTextMessage: { text: 'synthetic' } }));
    expect(withClick.kind).toBe('accepted'); expect(absent.kind).toBe('accepted');
    if (withClick.kind !== 'accepted' || absent.kind !== 'accepted' || withClick.event.kind !== 'message') throw new Error();
    const { ctwa, ...unchanged } = withClick.event;
    expect(ctwa).toEqual({ ctwaClid: click, adId: '123' }); expect(unchanged).toEqual(absent.event); expect(absent.event).not.toHaveProperty('ctwa');
  });
  it('never traverses quoted context, text, arbitrary metadata, edits or receipts', () => {
    for (const message of [{ conversation: `ctwaClid=${click}` }, { extendedTextMessage: { contextInfo: { quotedMessage: camel() } } }, { metadata: camel() }, { editedMessage: { message: camel() } }]) expect(extractWahaCtwa(native(message))).toBeNull();
    for (const event of ['message.ack', 'message.reaction', 'message.edited', 'message.revoked']) expect(extractWahaCtwa({ ...native(camel()), event })).toBeNull();
  });
  it('refuses outgoing/group/unknown-direction, oversized and conflicting context', () => {
    const outbound = native(camel()); outbound.payload._data.Info.IsFromMe = true;
    expect(extractWahaCtwa(outbound)).toBeNull();
    const group = native(camel()); group.payload._data.Info.Chat = '123@g.us'; expect(extractWahaCtwa(group)).toBeNull();
    const unknown = native(camel()) as any; delete unknown.payload.fromMe; delete unknown.payload._data.Info.IsFromMe; expect(extractWahaCtwa(unknown)).toBeNull();
    for (const ctwaClid of ['', 'x'.repeat(2049), ' has spaces ', 'line\nbreak', 123]) expect(extractWahaCtwa(native({ extendedTextMessage: { contextInfo: { externalAdReply: { ctwaClid } } } }))).toBeNull();
    expect(extractWahaCtwa(native({ ...camel(), imageMessage: { contextInfo: { externalAdReply: { ctwaClid: 'different' } } } }))).toBeNull();
    let deep: unknown = camel(); for (let i = 0; i < 7; i++) deep = { ephemeralMessage: { message: deep } }; expect(extractWahaCtwa(native(deep))).toBeNull();
  });
});
