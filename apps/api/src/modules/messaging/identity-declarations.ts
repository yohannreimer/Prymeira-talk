import type { AddressMappingEvidence } from './normalized-event.js';
import { normalizeChatAddress, record, serialized, string } from './whatsapp-identity.js';
import { normalizeEvolutionEvent, unwrapMessage } from '../evolution/evolution-normalizer.js';
type Pair = readonly [
    unknown,
    unknown
];
const supplied = (value: unknown) => value !== undefined && value !== null;
/** Contradiction detection only: absence never completes a key. Each role is checked
 * separately so a receipt recipient or control-action author cannot certify a target.
 * PN/LID equivalence requires the adapter's explicit pair; each family has one PN.
 */
function addressAgreement(values: unknown[], pairs: Pair[], role: 'chat' | 'sender'): boolean {
    const addresses = values.filter(supplied).flatMap(value => {
        const native = record(value);
        // WPP Wid objects may declare both serialized and user/server forms.
        // Neither representation may silently override the other.
        return [value, ...(supplied(native.user) && supplied(native.server) ? [typeof native.user === 'string' && typeof native.server === 'string' ? `${native.user}@${native.server}` : 'invalid_address_declaration'] : [])];
    }).map(normalizeChatAddress);
    if (addresses.some(a => !a || (role === 'sender' && a.endsWith('@g.us'))))
        return false;
    const links = new Map<string, Set<string>>();
    for (const [first, second] of pairs) {
        const a = normalizeChatAddress(first), b = normalizeChatAddress(second);
        if (!a || !b || !((a.endsWith('@lid') && b.endsWith('@s.whatsapp.net')) || (b.endsWith('@lid') && a.endsWith('@s.whatsapp.net'))))
            continue;
        for (const [left, right] of [[a, b], [b, a]]) {
            const edges = links.get(left!) ?? new Set<string>();
            edges.add(right!);
            links.set(left!, edges);
        }
    }
    const family = (start: string) => {
        const seen = new Set([start]), queue = [start];
        for (const next of queue)
            for (const adjacent of links.get(next) ?? [])
                if (!seen.has(adjacent)) {
                    seen.add(adjacent);
                    queue.push(adjacent);
                }
        return seen;
    };
    // Reject contradictory proof even when a convenient supplied field uses only its LID.
    for (const address of addresses)
        if ([...family(address!)].filter(a => a.endsWith('@s.whatsapp.net')).length > 1)
            return false;
    return !addresses.length || addresses.every(a => family(addresses[0]!).has(a!));
}
interface Declarations {
    scopes?: unknown[];
    keys?: unknown[];
    participants?: unknown[];
    chats?: unknown[];
    directions?: unknown[];
    senderPairs?: Pair[];
    chatPairs?: Pair[];
    waha?: boolean;
}
function validate(declarations: Declarations): string | null {
    const participants = [...declarations.participants ?? []], chats = [...declarations.chats ?? []], directions = [...declarations.directions ?? []];
    const senderPairs = [...declarations.senderPairs ?? []], chatPairs = [...declarations.chatPairs ?? []];
    const rawIds: string[] = [], suffixes: string[] = [];
    for (const [value, scopeOnly] of [...(declarations.keys ?? []).map(value => [value, false] as const), ...(declarations.scopes ?? []).map(value => [value, true] as const)]) {
        const key = record(value);
        participants.push(key.participant, key.participantAlt, key.author);
        chats.push(key.remote, key.remoteJid, key.remoteJidAlt);
        directions.push(key.fromMe);
        if (!declarations.waha)
            senderPairs.push([key.participant, key.participantAlt]);
        if (!declarations.waha)
            chatPairs.push([key.remoteJid ?? key.remote, key.remoteJidAlt]);
        if (!scopeOnly && string(key.id))
            rawIds.push(string(key.id)!);
        if (!declarations.waha)
            continue;
        const native = serialized(value), match = native && /^(true|false)_([^_]+)_(.+)$/.exec(native);
        if (!match)
            continue; // Opaque aliases and partial keys remain unresolved, never wildcard proof.
        chats.push(match[2]);
        directions.push(match[1] === 'true');
        let raw = match[3]!;
        const suffix = /_([^_]+@(?:lid|c\.us|s\.whatsapp\.net))$/.exec(raw);
        if (suffix) {
            suffixes.push(suffix[1]!);
            raw = raw.slice(0, -suffix[0].length);
        }
        // A possible sender suffix needs independent evidence before stripping as a stanza.
        if (!scopeOnly && (!suffix || participants.some(v => supplied(v))))
            rawIds.push(raw);
    }
    if (!addressAgreement(participants, senderPairs, 'sender') ||
        (participants.some(supplied) && !addressAgreement([...participants, ...suffixes], senderPairs, 'sender')))
        return 'contradictory_sender_declarations';
    if (!addressAgreement(chats, chatPairs, 'chat'))
        return 'contradictory_chat_declarations';
    const presentDirections = directions.filter(supplied);
    if (presentDirections.some(v => typeof v !== 'boolean' || v !== presentDirections[0]))
        return 'contradictory_direction_declarations';
    if (rawIds.some(v => v !== rawIds[0]))
        return 'contradictory_stanza_declarations';
    return null;
}
export function validateEvolutionIdentityDeclarations(input: unknown): string | null {
    const envelope = record(input), data = record(envelope.data), name = normalizeEvolutionEvent(string(envelope.event) ?? '');
    if (['connection.update', 'qrcode.updated'].includes(name))
        return null;
    const key = data.key ?? (name === 'messages.delete' ? data : undefined), native = record(key);
    const reason = validate({ keys: [key], participants: [data.participant, data.participantAlt, data.author], chats: [data.remoteJid, data.remoteJidAlt], directions: [data.fromMe],
        senderPairs: [[data.participant ?? native.participant, data.participantAlt], [native.participant ?? data.participant, native.participantAlt]], chatPairs: [[data.remoteJid, data.remoteJidAlt]] });
    if (reason)
        return reason;
    const message = record(unwrapMessage(data.message)), protocol = record(message.protocolMessage), secret = record(message.secretEncryptedMessage);
    // Target and action authors can legitimately differ. Validate each native key internally.
    return validate({ keys: [protocol.key] }) ?? validate({ keys: [secret.targetMessageKey] });
}
export function validateWahaIdentityDeclarations(input: unknown, verifiedMappings: ReadonlyArray<AddressMappingEvidence> = []): string | null {
    const envelope = record(input), payload = record(envelope.payload), name = string(envelope.event);
    if (!['message', 'message.any', 'message.edited', 'message.revoked', 'message.ack', 'message.ack.group'].includes(name ?? ''))
        return null;
    const tuple = Array.isArray(payload._data) ? payload._data : null;
    const raw = record(tuple ? tuple[0] : payload._data);
    const senderPairs: Pair[] = verifiedMappings.filter(m => m.source === 'waha.lid_lookup' && m.role === 'sender').map(m => [m.lid, m.pn]);
    const chatPairs: Pair[] = verifiedMappings.filter(m => m.source === 'waha.lid_lookup' && m.role === 'chat').map(m => [m.lid, m.pn]);
    // WAHA has no participantAlt proof contract. Supplied alternates must still agree;
    // only the caller's verified lookup can establish PN/LID equivalence here.
    const declarations = { waha: true, senderPairs, chatPairs, participants: [payload.participant, payload.author, payload.participantAlt, raw.author, raw.participant, raw.participantAlt], directions: [payload.fromMe, raw.fromMe] };
    if (name === 'message.edited') {
        const msg = record(tuple ? tuple[2] : raw.msg ?? raw.message);
        const action = validate({ ...declarations, keys: [payload.id, msg.latestEditMsgKey], participants: [...declarations.participants, msg.author, msg.participant] });
        return action ?? validate({ waha: true, keys: [tuple ? tuple[1] : raw.id], scopes: [msg.id, payload.editedMessageId], chats: [tuple ? tuple[0] : raw.chat], senderPairs, chatPairs });
    }
    if (name === 'message.revoked') {
        return validate({ ...declarations, keys: [raw.id ?? payload.after, payload.id], scopes: [payload.after] }) ?? validate({ waha: true, keys: [raw.refId ?? payload.before ?? payload.revokedMessageId], scopes: [payload.before, payload.revokedMessageId], senderPairs, chatPairs });
    }
    let direction = typeof payload.fromMe === 'boolean' ? payload.fromMe : typeof raw.fromMe === 'boolean' ? raw.fromMe : null;
    if (direction === null) {
        for (const value of [raw.id, payload.id]) {
            const key = record(value), native = serialized(value), match = native && /^(true|false)_/.exec(native);
            if (typeof key.fromMe === 'boolean') {
                direction = key.fromMe;
                break;
            }
            if (match) {
                direction = match[1] === 'true';
                break;
            }
        }
    }
    return validate({ ...declarations, keys: [raw.id, payload.id], chats: [raw.chatId, payload.chatId, direction === true ? payload.to : direction === false ? payload.from : undefined] })
        ?? validate({ waha: true, keys: [raw.latestEditMsgKey], senderPairs, chatPairs });
}
