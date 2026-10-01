import { describe, expect, it } from 'vitest';
import { validateEvolutionIdentityDeclarations, validateWahaIdentityDeclarations } from './identity-declarations.js';
const group = '123-456@g.us', pn = '15550003333@s.whatsapp.net', other = '15550004444@s.whatsapp.net', lid = '777@lid';
const evo = (key: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({ event: 'MESSAGES_UPSERT', data: { key: { id: 'A_B', remoteJid: group, fromMe: false, participant: pn, ...key }, ...data } });
const waha = (raw: Record<string, unknown> = {}, payload: Record<string, unknown> = {}, event = 'message.any') => ({ event, payload: { id: `false_${group}_A_B_${pn}`, from: group, fromMe: false, participant: pn, _data: { author: pn, ...raw }, ...payload } });
describe('authenticated identity declarations', () => {
    it.each([
        [{}, { participant: other }], [{ participantAlt: other }, {}], [{}, { participantAlt: other }],
        [{ participantAlt: lid }, { participant: other }], [{ participantAlt: lid }, { participant: lid, participantAlt: other }], [{ participant: lid }, { participant: pn }],
        [{}, { author: other }], [{ participant: 'malformed' }, { participant: pn }],
        [{ fromMe: true }, { fromMe: false }], [{ remoteJidAlt: '999-888@g.us' }, {}],
    ])('rejects all contradictory Evolution declarations %j %j', (key, data) => expect(validateEvolutionIdentityDeclarations(evo(key, data))).not.toBeNull());
    it('permits explicit PN/LID evidence and equivalent PN spelling, never display names', () => {
        expect(validateEvolutionIdentityDeclarations(evo({ participantAlt: lid }, { participant: lid, participantAlt: pn, pushName: other }))).toBeNull();
        expect(validateEvolutionIdentityDeclarations(evo({ participant: undefined, participantAlt: lid }, { participant: pn }))).toBeNull();
        expect(validateEvolutionIdentityDeclarations(evo({}, { participant: pn.replace('@s.whatsapp.net', '@c.us') }))).toBeNull();
    });
    it.each([
        [{ author: other }, {}], [{ author: { _serialized: pn, user: '15550004444', server: 'c.us' } }, {}], [{ participant: other }, {}], [{}, { author: other }], [{}, { participant: other }],
        [{ id: { id: 'A_B', remote: group, fromMe: false, participant: other } }, {}],
        [{ id: { id: 'A_B', remote: group, fromMe: false, participant: pn, _serialized: `false_${group}_A_B_${other}` } }, {}],
        [{ id: { id: 'OTHER', remote: group, fromMe: false, participant: pn } }, {}],
        [{ id: { id: 'A_B', remote: '999-888@g.us', fromMe: false, participant: pn } }, {}],
        [{ fromMe: true }, {}], [{}, { fromMe: true }], [{}, { from: '999-888@g.us' }],
        [{ author: lid }, {}], [{ id: { id: 'A_B', remote: group, fromMe: false, participant: lid, participantAlt: pn } }, {}], [{}, { participant: 'malformed' }],
    ])('rejects WAHA native, structured and envelope conflicts %j %j', (raw, payload) => expect(validateWahaIdentityDeclarations(waha(raw, payload))).not.toBeNull());
    it('allows verified WAHA PN/LID proof only, never webhook metadata', () => {
        const input = waha({ author: lid }, { metadata: { lid, pn } });
        expect(validateWahaIdentityDeclarations(input)).not.toBeNull();
        expect(validateWahaIdentityDeclarations(input, [{ role: 'sender', lid, pn, source: 'waha.lid_lookup' }])).toBeNull();
        expect(validateWahaIdentityDeclarations(input, [{ role: 'sender', lid, pn, source: 'waha.lid_lookup' }, { role: 'sender', lid, pn: other, source: 'waha.lid_lookup' }])).not.toBeNull();
    });
    it.each(['message.ack.group', 'message.revoked', 'message.edited'])('validates signal author contradictions: %s', event => {
        const input = waha({ author: other }, {}, event);
        expect(validateWahaIdentityDeclarations(input)).not.toBeNull();
    });
    it.each(['after', 'before'])('checks sender declarations in lossy revoke %s keys without truncating native stanza', field => {
        const short = { id: field === 'after' ? 'R' : 'A', remoteJid: group, fromMe: false, participant: other };
        const input = { event: 'message.revoked', payload: { id: `false_${group}_R_A_${pn}`, participant: pn, _data: { id: `false_${group}_R_A_${pn}`, author: pn, refId: { id: 'A_B', remote: group, fromMe: false, participant: pn } }, [field]: short } };
        expect(validateWahaIdentityDeclarations(input)).toBe('contradictory_sender_declarations');
        short.participant = pn;
        expect(validateWahaIdentityDeclarations(input)).toBeNull();
    });
    it.each(['msg', 'message', 'tuple'].flatMap(shape => ['author', 'participant', 'participantAlt'].map(field => ({ shape, field }))))('checks every WPP edit sender declaration in $shape / $field', ({ shape, field }) => {
        const target = { id: 'A_B', remote: group, fromMe: false, participant: pn };
        const msg = { body: 'changed', author: pn, [field]: other, latestEditMsgKey: { id: 'EDIT', remote: group, fromMe: false, participant: pn } };
        const input = { event: 'message.edited', payload: { id: `false_${group}_EDIT_${pn}`, participant: pn, _data: shape === 'tuple' ? [group, target, msg] : { id: target, author: pn, [shape]: msg } } };
        expect(validateWahaIdentityDeclarations(input)).toBe('contradictory_sender_declarations');
    });
    it('checks simultaneous WPP msg/message sender variants, preserving their original facts', () => {
        const target = { id: 'A_B', remote: group, fromMe: false, participant: pn };
        const msg = { body: 'changed', author: pn, latestEditMsgKey: { id: 'EDIT', remote: group, fromMe: false, participant: pn } };
        const input = { event: 'message.edited', payload: { id: `false_${group}_EDIT_${pn}`, participant: pn, _data: { id: target, msg, message: { ...msg, participantAlt: other } } } };
        expect(validateWahaIdentityDeclarations(input)).toBe('contradictory_sender_declarations');
    });
    it('requires persisted verified proof for a nested WAHA PN/LID alternate and rejects two PN proof', () => {
        const msg = { body: 'changed', author: pn, participantAlt: lid, latestEditMsgKey: { id: 'EDIT', remote: group, fromMe: false, participant: pn } };
        const input = { event: 'message.edited', payload: { id: `false_${group}_EDIT_${pn}`, participant: pn, _data: { id: { id: 'A_B', remote: group, fromMe: false, participant: pn }, msg } } };
        expect(validateWahaIdentityDeclarations(input)).toBe('contradictory_sender_declarations');
        const proof = { role: 'sender' as const, lid, pn, source: 'waha.lid_lookup' as const };
        expect(validateWahaIdentityDeclarations(input, [proof])).toBeNull();
        expect(validateWahaIdentityDeclarations(input, [proof, { ...proof, pn: other }])).toBe('contradictory_sender_declarations');
    });
    it.each(['protocol-key', 'encrypted-target'].flatMap(container => ['author', 'participant', 'participantAlt'].map(field => ({ container, field }))))('checks the recognized Evolution $container / $field declarations', ({ container, field }) => {
        const key = { id: 'TARGET', remoteJid: group, fromMe: false, author: pn, participant: pn, [field]: other };
        const message = container === 'protocol-key' ? { protocolMessage: { type: 0, key } } : { secretEncryptedMessage: { targetMessageKey: key } };
        expect(validateEvolutionIdentityDeclarations(evo({}, { message }))).toBe('contradictory_sender_declarations');
    });
    it.each(['upsert', 'edit-action', 'edit-target', 'revoke-action', 'revoke-target', 'ack-target'])('checks alternate contradictions in recognized WAHA %s native keys', container => {
        const good = { id: 'A_B', remote: group, fromMe: false, participant: pn }, bad = { ...good, participantAlt: other };
        const input = container === 'upsert' ? waha({ id: bad }) : container === 'ack-target' ? { event: 'message.ack.group', payload: { id: `false_${group}_A_B_${pn}`, participant: pn, _data: [{ id: bad, author: pn, sender: other }, 3] } }
            : container.startsWith('edit') ? { event: 'message.edited', payload: { id: `false_${group}_A_B_${pn}`, participant: pn, _data: { id: container === 'edit-target' ? bad : good, author: pn, msg: { body: 'changed', latestEditMsgKey: container === 'edit-action' ? bad : good } } } }
                : { event: 'message.revoked', payload: { id: `false_${group}_A_B_${pn}`, participant: pn, _data: { id: container === 'revoke-action' ? bad : good, author: pn, refId: container === 'revoke-target' ? bad : good } } };
        expect(validateWahaIdentityDeclarations(input)).toBe('contradictory_sender_declarations');
    });
    it('keeps ACK recipient and quoted/mentioned/card/contact names outside author identity', () => {
        const input = waha({}, {}, 'message.ack.group');
        input.payload._data = [{ id: { id: 'A_B', remote: group, fromMe: false, participant: pn }, author: pn, sender: other, quotedParticipant: other }] as never;
        expect(validateWahaIdentityDeclarations(input)).toBeNull();
    });
    it('keeps revoke target author distinct from action author', () => {
        expect(validateWahaIdentityDeclarations({ event: 'message.revoked', payload: { id: `true_${group}_R_${pn}`, participant: pn, _data: { author: pn, id: { id: 'R', remote: group, fromMe: true, participant: pn }, refId: { id: 'A', remote: group, fromMe: false, participant: other } } } })).toBeNull();
    });
    it('validates nested Evolution target declarations separately from action', () => {
        const input = evo({}, { message: { protocolMessage: { type: 0, key: { id: 'TARGET', remoteJid: group, fromMe: true, participant: other, participantAlt: pn } } } });
        expect(validateEvolutionIdentityDeclarations(input)).not.toBeNull();
    });
});
