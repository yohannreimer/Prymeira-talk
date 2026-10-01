import { describe, expect, it } from 'vitest';
import { record } from './whatsapp-identity.js';
import { captureSendEvidence, classifySendEvidence, parseSendIdentity, parseSendProof, sanitizeSendEvidence, inspectSendIdentityEvidence, sendIdentityClaimsConflict } from './outbound-evidence.js';
const source: any = { provider: 'evolution', connectionId: 'physical', sessionName: 's', channelProvider: 'evolution' };
const PN = '15550001111@s.whatsapp.net';
describe('send evidence contracts', () => {
    it('HTTP acceptance survives missing IDs or invalid JSON; generic errors cannot prove nonacceptance', () => {
        expect(classifySendEvidence({ transport: 'http', status: 200, raw: {}, bodyState: 'json' })).toBe('accepted');
        expect(classifySendEvidence({ transport: 'http', status: 202, raw: null, bodyState: 'invalid_json' })).toBe('accepted');
        expect(classifySendEvidence({ transport: 'http', status: 400, raw: { error: 'bad request' }, bodyState: 'json' })).toBe('uncertain');
        expect(classifySendEvidence({ transport: 'timeout', status: null, raw: null, bodyState: 'unavailable' })).toBe('uncertain');
        expect(classifySendEvidence({
            transport: 'local_validation', status: null, raw: null, bodyState: 'unavailable', preIo: { code: 'invalid_destination', frontierCrossed: false }
        })).toBe('definitively_rejected');
    });
    it('Evolution requires complete response key and correct destination/direction/participant', () => {
        expect(parseSendIdentity(source, PN, { key: { id: 'A', remoteJid: PN, fromMe: true } })).toMatchObject({ rawId: 'A', nativeId: 'A', chatAddress: PN, direction: 'outbound', senderParticipant: '' });
        for (const raw of [
            { id: 'A' }, { key: { id: 'A', remoteJid: PN } }, { key: { id: 'A', remoteJid: PN, fromMe: false } }, { key: { id: 'A', remoteJid: '15550002222@s.whatsapp.net', fromMe: true } }
        ])
            expect(parseSendIdentity(source, PN, raw)).toBeNull();
        expect(parseSendIdentity(source, '120000-100@g.us', {
            key: { id: 'G', remoteJid: '120000-100@g.us', fromMe: true }, verifiedPhoneNumber: '15550001111'
        })).toBeNull();
    });
    it('WAHA checks serialized and envelope keys consistently and Meta has its authenticated native namespace', () => { const w = { ...source, provider: 'waha' }; expect(parseSendIdentity(w, PN, { id: 'true_15550001111@c.us_A', to: '15550001111@c.us', fromMe: true })).toMatchObject({ rawId: 'A', chatAddress: PN }); expect(parseSendIdentity(w, PN, { id: 'true_15550001111@c.us_A', fromMe: false })).toBeNull(); expect(parseSendIdentity({ ...source, provider: 'meta_official', connectionId: null, phoneNumberId: 'AUTH' }, PN, { messages: [{ id: 'wamid.A' }], contacts: [{ wa_id: '15550001111' }] })).toMatchObject({ identityFormat: 'provider_native', nativeId: 'wamid.A', rawId: null }); expect(parseSendIdentity({ ...source, provider: 'meta_official', connectionId: null, phoneNumberId: 'AUTH' }, PN, { messages: [{ id: 'wamid.A' }], contacts: [{ wa_id: '15550002222' }] })).toBeNull(); });
    it('preserves status when parsing or body reading fails after a response', async () => {
        for (const response of [
            new Response('not json', { status: 200 }), { status: 202, headers: new Headers(), text: async () => { throw Error('socket'); } }
        ]) {
            const e = await captureSendEvidence({
                url: 'https://fixture.invalid/send', init: { method: 'POST' }, fetch: async () => response as Response
            });
            expect(e.status).toBe(response.status);
            expect(classifySendEvidence(e)).toBe('accepted');
        }
    });
    it('captures thrown transport errors as uncertain evidence without exception details', async () => {
        const e = await captureSendEvidence({
            url: 'https://fixture.invalid/send', init: { method: 'POST' }, fetch: async () => { throw Error('secret-token'); }
        });
        expect(e).toMatchObject({ transport: 'transport_error', status: null, bodyState: 'unavailable' });
        expect(JSON.stringify(e)).not.toContain('secret-token');
    });
    it('retains sanitized raw proof while stripping secrets and binary data', () => {
        const e = sanitizeSendEvidence({
            transport: 'http', status: 200, bodyState: 'json', raw: {
                key: { id: 'A', fromMe: true, remoteJid: PN }, accessToken: 'secret', apikey: 'secret', audio: 'base64', data: Buffer.from('binary'), url: 'https://fixture.invalid/f?token=secret', ack: 1
            }
        });
        expect(record(record(e.raw).key).id).toBe('A');
        expect(record(e.raw).ack).toBe(1);
        expect(JSON.stringify(e)).not.toContain('secret');
        expect(JSON.stringify(e)).not.toContain('binary');
    });
    it('does not truncate native identity into a usable fake key', () => { const raw = { key: { id: 'X'.repeat(70000), remoteJid: PN, fromMe: true } }; const evidence = sanitizeSendEvidence({ transport: 'http', status: 200, bodyState: 'json', raw }); expect(parseSendIdentity(source, PN, evidence.raw)).toBeNull(); });
    it('rejects contradictory WAHA full native fields and participant evidence', () => {
        const w = { ...source, provider: 'waha' };
        for (const raw of [
            { id: 'true_15550001111@c.us_A', _data: { id: 'true_15550001111@s.whatsapp.net_A' } }, {
                id: 'true_120000-100@g.us_G_15550001111@c.us', participant: '15550001111@c.us', _data: { author: '15550002222@c.us' }
            }
        ])
            expect(parseSendIdentity(w, raw.id.includes('@g.us') ? '120000-100@g.us' : PN, raw)).toBeNull();
    });
    it('preserves explicit Evolution PN/LID proof while keeping native key fields intact and bridge wamid in its own namespace', () => { const p = parseSendProof(source, PN, { key: { id: 'A', remoteJid: '700001@lid', remoteJidAlt: PN, fromMe: true } }); expect(p.key).toMatchObject({ nativeChatAddress: '700001@lid', chatAddress: PN }); expect(p.addressMappings).toEqual([{ role: 'chat', lid: '700001@lid', pn: PN, source: 'evolution.remoteJidAlt' }]); expect(parseSendIdentity({ ...source, channelProvider: 'meta', connectionId: null }, PN, { key: { id: 'wamid.B', remoteJid: PN, fromMe: true } })).toMatchObject({ identityFormat: 'provider_native', nativeId: 'wamid.B', rawId: null }); });
    it('oversized discarded evidence cannot hide a contradictory native representation', () => {
        const e = sanitizeSendEvidence({
            transport: 'http', status: 200, bodyState: 'json', raw: {
                key: { id: 'A', remoteJid: PN, fromMe: true }, message: { key: { id: 'X'.repeat(70000), remoteJid: PN, fromMe: true } }
            }
        });
        expect(e.errorCode).toBe('identity_evidence_incomplete');
        expect(parseSendIdentity(source, PN, e.raw)).toBeNull();
    });
    it('sanitization cannot turn a crossed I/O frontier into a local nonacceptance proof', () => {
        const input: any = {
            transport: 'local_validation', status: null, bodyState: 'unavailable', raw: null, preIo: { code: 'invalid_destination', frontierCrossed: true }
        };
        expect(classifySendEvidence(sanitizeSendEvidence(input))).toBe('uncertain');
    });
    it('retains incompatible WAHA structured full native fields and format for comparison', () => {
        const w = { ...source, provider: 'waha' }, id = 'true_15550001111@c.us_A';
        for (const change of [{ remote: PN }, { id: 'B' }, { fromMe: false }]) {
            const raw = {
                id, to: '15550001111@c.us', fromMe: true, _data: { id: { _serialized: id, id: 'A', remote: '15550001111@c.us', fromMe: true, ...change } }
            };
            expect(inspectSendIdentityEvidence(w, PN, raw).conflicting).toBe(true);
        }
        const native = { identityFormat: 'provider_native' as const, nativeId: 'A' };
        const stanza = { identityFormat: 'whatsapp_stanza' as const, nativeId: 'A' };
        expect(sendIdentityClaimsConflict([{ key: native }, { key: stanza }])).toBe(true);
        const inspected = inspectSendIdentityEvidence(source, PN, { key: { id: 'A', remoteJid: '15550002222@s.whatsapp.net', fromMe: true } });
        expect(inspected.claims[0]!.key).toMatchObject({ nativeId: 'A', nativeChatAddress: '15550002222@s.whatsapp.net' });
        expect(inspected.conflicting).toBe(true);
    });
    it('normalized WAHA envelopes do not replace the native chat representation', () => {
        const w = { ...source, provider: 'waha' }, id = 'true_15550001111@c.us_A';
        const raw = { id, to: PN, fromMe: true, _data: { id } };
        const key = parseSendIdentity(w, PN, raw)!;
        expect(key).not.toBeNull();
        expect(inspectSendIdentityEvidence(w, PN, raw).conflicting).toBe(false);
    });
});
