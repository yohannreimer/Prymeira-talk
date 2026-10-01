import { explicitAddressMatch, parseExactWahaResponse } from './provider-exact.js';
import type { AddressMappingEvidence, TrustedMessagingContext } from './normalized-event.js';
import { normalizeChatAddress, parseWahaMessageKey, record, serialized, string, type WhatsAppMessageKey } from './whatsapp-identity.js';
export interface SendEvidence {
    transport: 'http' | 'timeout' | 'transport_error' | 'local_validation';
    status: number | null;
    bodyState: 'json' | 'empty' | 'invalid_json' | 'unavailable';
    raw: unknown;
    ack?: string | number | null;
    errorCode?: string;
    /** Only an adapter that has not invoked transport may issue this certificate. */
    preIo?: {
        code: 'invalid_destination' | 'invalid_prepared_media' | 'unsupported_operation';
        frontierCrossed: false;
    };
}
export type SendOutcome = 'accepted' | 'definitively_rejected' | 'uncertain';
export function classifySendEvidence(value: SendEvidence): SendOutcome {
    if (value.transport === 'http' && Number.isInteger(value.status) && value.status! >= 200 && value.status! < 300)
        return 'accepted';
    if (value.transport === 'local_validation' && value.status === null && value.preIo?.frontierCrossed === false
        && ['invalid_destination', 'invalid_prepared_media', 'unsupported_operation'].includes(value.preIo.code))
        return 'definitively_rejected';
    // A status, timeout, malformed body or generic error is never a nonacceptance certificate.
    return 'uncertain';
}
const sensitiveField = /(?:token|secret|password|authorization|api.?key|credential|base64|buffer|binary|^audio$|^data$|^media$)/i;
function exceedsEvidencePolicy(value: unknown, depth = 0): boolean {
    if (depth > 16)
        return true;
    if (typeof value === 'string')
        return value.length > 65536;
    if (Array.isArray(value))
        return value.length > 128 || value.some(v => exceedsEvidencePolicy(v, depth + 1));
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value).filter(([k]) => !sensitiveField.test(k));
        return entries.length > 128 || entries.some(([, v]) => exceedsEvidencePolicy(v, depth + 1));
    }
    return false;
}
function clean(value: unknown, depth = 0): unknown {
    if (depth > 16 || value instanceof Uint8Array || value instanceof ArrayBuffer || record(value).type === 'Buffer')
        return null;
    if (typeof value === 'string') {
        if (value.length > 65536 || /^data:/.test(value))
            return null;
        if (/^https?:\/\//.test(value)) {
            try {
                const url = new URL(value);
                url.username = '';
                url.password = '';
                url.search = '';
                url.hash = '';
                return url.toString();
            }
            catch {
                return '[invalid_url]';
            }
        }
        return value;
    }
    if (Array.isArray(value))
        return value.map(v => clean(v, depth + 1));
    if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).filter(([k]) => !sensitiveField.test(k)).map(([k, v]) => [k, clean(v, depth + 1)]));
    return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null;
}
/** Private evidence only. This object must not be copied to queue/UI DTOs. */
export function sanitizeSendEvidence(value: SendEvidence): SendEvidence {
    const incomplete = exceedsEvidencePolicy(value.raw);
    return {
        transport: value.transport, status: value.status, bodyState: value.bodyState, raw: incomplete ? { _evidenceIncomplete: true } : clean(value.raw),
        ...(value.ack === undefined ? {} : { ack: typeof value.ack === 'string' ? value.ack.slice(0, 128) : value.ack }),
        ...(value.errorCode ? { errorCode: value.errorCode.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 128) } : {}),
        ...(incomplete ? { errorCode: 'identity_evidence_incomplete' } : {}),
        ...(value.preIo?.frontierCrossed === false ? { preIo: { code: value.preIo.code, frontierCrossed: false } } : {})
    };
}
/** I/O helper lives outside transactional foundation. Legacy send methods remain unchanged.
 * The HTTP status survives body-read/parse failures; no exception text or headers persist. */
export async function captureSendEvidence(input: {
    url: string;
    init: RequestInit;
    fetch?: typeof fetch;
    timeoutMs?: number;
}): Promise<SendEvidence> {
    let response: Response;
    try {
        response = await (input.fetch ?? fetch)(input.url, {
            ...input.init, redirect: 'error', signal: input.init.signal ?? AbortSignal.timeout(input.timeoutMs ?? 60000)
        });
    }
    catch (error) {
        return {
            transport: record(error).name === 'TimeoutError' || record(error).name === 'AbortError' ? 'timeout' : 'transport_error', status: null, raw: null, bodyState: 'unavailable'
        };
    }
    let text: string;
    try {
        text = await response.text();
    }
    catch {
        return {
            transport: 'http', status: response.status, raw: null, bodyState: 'unavailable', errorCode: 'body_read_failed'
        };
    }
    if (!text.trim())
        return { transport: 'http', status: response.status, raw: null, bodyState: 'empty' };
    try {
        return sanitizeSendEvidence({ transport: 'http', status: response.status, raw: JSON.parse(text), bodyState: 'json' });
    }
    catch {
        return {
            transport: 'http', status: response.status, raw: null, bodyState: 'invalid_json', errorCode: 'invalid_json'
        };
    }
}
function same(a: WhatsAppMessageKey, b: WhatsAppMessageKey) {
    return [
        'identityFormat', 'nativeId', 'nativeChatAddress', 'nativeSenderParticipant', 'rawId', 'chatAddress', 'direction', 'senderParticipant'
    ].every(k => a[k as keyof WhatsAppMessageKey] === b[k as keyof WhatsAppMessageKey]);
}
/** Full native identity comes only from the captured authenticated endpoint response.
 * Isolated IDs, verified own phone numbers and text/time are deliberately insufficient. */
export function parseSendIdentity(source: TrustedMessagingContext, destination: string, value: unknown): WhatsAppMessageKey | null {
    const raw = record(value);
    if (raw._evidenceIncomplete === true)
        return null;
    const dest = normalizeChatAddress(destination);
    if (!dest)
        return null;
    let key: WhatsAppMessageKey;
    if (source.provider === 'meta_official') {
        if (source.connectionId !== null || !source.phoneNumberId || dest.endsWith('@g.us') || dest.endsWith('@lid'))
            return null;
        const messages = Array.isArray(raw.messages) ? raw.messages : [], id = messages.length === 1 ? string(record(messages[0]).id) : null;
        if (!id)
            return null;
        const recipients = [
            raw.recipient_id, raw.to, raw.wa_id, ...(Array.isArray(raw.contacts) ? raw.contacts.flatMap(c => [record(c).wa_id, record(c).input]) : [])
        ].filter(v => v !== undefined && v !== null);
        if (recipients.some(r => normalizeChatAddress(String(r).includes('@') ? r : `${r}@s.whatsapp.net`) !== dest))
            return null;
        return {
            identityFormat: 'provider_native', nativeId: id, nativeChatAddress: dest, nativeSenderParticipant: null, rawId: null, chatAddress: dest, direction: 'outbound', senderParticipant: ''
        };
    }
    if (source.provider === 'evolution') {
        const keys = [raw.key, record(raw.message).key].filter(v => Object.keys(record(v)).length);
        if (!keys.length)
            return null;
        const parsed = keys.map(v => {
            const k = record(v), id = string(k.id);
            const native = parseWahaMessageKey({ id: k.id, remote: k.remoteJid, fromMe: k.fromMe, participant: k.participant });
            if (explicitAddressMatch(dest, native.nativeChatAddress, typeof k.remoteJidAlt === 'string' ? k.remoteJidAlt : undefined))
                native.chatAddress = dest;
            return {
                ...native, nativeId: id, ...(id?.startsWith('wamid.') ? { identityFormat: 'provider_native' as const, rawId: null } : {})
            };
        });
        key = parsed[0]!;
        if (parsed.some(k => !same(k, key)))
            return null;
    }
    else {
        const parsed = parseExactWahaResponse(raw);
        if (!parsed)
            return null;
        key = parsed;
    }
    if (!key.nativeId || (key.identityFormat === 'whatsapp_stanza' && !key.rawId) || !key.nativeChatAddress || key.chatAddress !== dest || key.direction !== 'outbound')
        return null;
    if (dest.endsWith('@g.us') && (!key.senderParticipant || !key.nativeSenderParticipant))
        return null;
    if (!dest.endsWith('@g.us') && key.senderParticipant !== '')
        return null;
    return key;
}
export function parseSendProof(source: TrustedMessagingContext, destination: string, raw: unknown): {
    key: WhatsAppMessageKey | null;
    addressMappings: AddressMappingEvidence[];
} {
    const key = parseSendIdentity(source, destination, raw), addressMappings: AddressMappingEvidence[] = [];
    if (!key || source.provider !== 'evolution')
        return { key, addressMappings };
    const value = record(raw), keys = [value.key, record(value.message).key].filter(v => Object.keys(record(v)).length);
    for (const v of keys) {
        const k = record(v);
        for (const [first, second, role] of [[k.remoteJid, k.remoteJidAlt, 'chat'], [k.participant, k.participantAlt, 'sender']] as const) {
            const a = normalizeChatAddress(first), b = normalizeChatAddress(second), lid = a?.endsWith('@lid') ? a : b?.endsWith('@lid') ? b : null, pn = a?.endsWith('@s.whatsapp.net') ? a : b?.endsWith('@s.whatsapp.net') ? b : null;
            if (lid && pn && !addressMappings.some(m => m.lid === lid && m.pn === pn && m.role === role))
                addressMappings.push({ role, lid, pn, source: role === 'chat' ? 'evolution.remoteJidAlt' : 'evolution.participantAlt' });
        }
    }
    return { key, addressMappings };
}
/** A native ID alone cannot bind, but incompatible accepted native IDs remain
 * contradictory acceptance facts even when neither response supplies a full key. */
export function acceptedNativeHints(source: TrustedMessagingContext, value: unknown): string[] {
    const raw = record(value);
    if (raw._evidenceIncomplete === true)
        return [];
    const values = source.provider === 'meta_official'
        ? (Array.isArray(raw.messages) ? raw.messages.map(v => record(v).id) : [])
        : source.provider === 'evolution'
            ? [record(raw.key).id, record(record(raw.message).key).id, raw.id, raw.messageId]
            : [raw.id, record(raw._data).id];
    return [
        ...new Set(values.map(v => serialized(v)).filter((v): v is string => typeof v === 'string' && v.length > 0))
    ];
}
/** Claims survive destination/completeness validation. Missing fields may be
 * complemented; a supplied incompatible native field remains contrary evidence. */
export interface SendIdentityClaim {
    key: Partial<WhatsAppMessageKey>;
    chatAlternate?: string;
}
const nativeFields: (keyof WhatsAppMessageKey)[] = [
    'identityFormat', 'nativeId', 'nativeChatAddress', 'nativeSenderParticipant',
    'rawId', 'chatAddress', 'direction', 'senderParticipant'
];
export function inspectSendIdentityEvidence(source: TrustedMessagingContext, destination: string, value: unknown) {
    const raw = record(value), claims: SendIdentityClaim[] = [];
    let conflicting = false;
    if (raw._evidenceIncomplete === true)
        return { claims, conflicting };
    const present = (v: unknown) => v !== undefined && v !== null;
    function claim(input: {
        id?: unknown;
        rawId?: unknown;
        chat?: unknown;
        direction?: unknown;
        participant?: unknown;
        alternate?: unknown;
        format?: WhatsAppMessageKey['identityFormat'];
    }) {
        const key: Partial<WhatsAppMessageKey> = {};
        if (present(input.id)) {
            const id = serialized(input.id);
            if (!id)
                conflicting = true;
            else {
                key.nativeId = id;
                key.identityFormat = input.format ?? 'whatsapp_stanza';
            }
        }
        if (present(input.rawId)) {
            const id = string(input.rawId);
            if (!id)
                conflicting = true;
            else
                key.rawId = id;
        }
        if (input.format === 'provider_native')
            key.rawId = null;
        if (present(input.chat)) {
            const native = serialized(input.chat), normalized = normalizeChatAddress(input.chat);
            if (!native || !normalized)
                conflicting = true;
            else {
                key.nativeChatAddress = native;
                key.chatAddress = explicitAddressMatch(destination, native, string(input.alternate) ?? undefined) ? destination : normalized;
            }
        }
        if (present(input.direction)) {
            if (typeof input.direction !== 'boolean')
                conflicting = true;
            else
                key.direction = input.direction ? 'outbound' : 'inbound';
        }
        if (present(input.participant)) {
            const native = serialized(input.participant), normalized = normalizeChatAddress(input.participant);
            if (!native || !normalized || normalized.endsWith('@g.us'))
                conflicting = true;
            else {
                key.nativeSenderParticipant = native;
                if ((key.chatAddress ?? destination).endsWith('@g.us'))
                    key.senderParticipant = normalized;
            }
        }
        if (Object.keys(key).length)
            claims.push({ key, ...(string(input.alternate) ? { chatAlternate: string(input.alternate)! } : {}) });
    }
    if (source.provider === 'evolution') {
        for (const value of [raw.key, record(raw.message).key].filter(v => Object.keys(record(v)).length)) {
            const k = record(value), id = string(k.id), format = id?.startsWith('wamid.') ? 'provider_native' : 'whatsapp_stanza';
            claim({
                id: k.id, rawId: format === 'whatsapp_stanza' ? k.id : undefined, chat: k.remoteJid, direction: k.fromMe, participant: k.participant, alternate: k.remoteJidAlt, format
            });
        }
        for (const id of [raw.id, raw.messageId].filter(present))
            claim({ id, format: serialized(id)?.startsWith('wamid.') ? 'provider_native' : 'whatsapp_stanza' });
    }
    else if (source.provider === 'waha') {
        const data = record(raw._data), participants = [
            raw.participant, raw.author, data.participant, data.author, record(raw.id).participant, record(data.id).participant
        ].filter(present);
        for (const value of [raw.id, data.id].filter(present)) {
            const parsed = parseWahaMessageKey(value, participants[0]), k = record(value);
            claim({
                id: serialized(value) ?? undefined, rawId: parsed.rawId ?? k.id, chat: parsed.nativeChatAddress ?? k.remote ?? k.remoteJid, direction: parsed.direction === null ? k.fromMe : parsed.direction === 'outbound', participant: k.participant ?? participants[0]
            });
        }
        for (const participant of participants)
            claim({ participant });
        for (const direction of [raw.fromMe, data.fromMe].filter(present))
            claim({ direction });
        // Envelope chat fields are normalized routing evidence, not another
        // serialized native representation of the provider key.
        for (const chat of [raw.to, raw.chatId, data.chatId].filter(present)) {
            const normalized = normalizeChatAddress(chat);
            if (!normalized)
                conflicting = true;
            else
                claims.push({ key: { chatAddress: normalized } });
        }
    }
    else {
        for (const message of Array.isArray(raw.messages) ? raw.messages : [])
            claim({ id: record(message).id, format: 'provider_native' });
        for (const recipient of [
            raw.recipient_id, raw.to, raw.wa_id, ...(Array.isArray(raw.contacts) ? raw.contacts.flatMap(v => [record(v).wa_id, record(v).input]) : [])
        ].filter(present)) {
            const normalized = normalizeChatAddress(String(recipient).includes('@') ? recipient : `${recipient}@s.whatsapp.net`);
            if (!normalized)
                conflicting = true;
            else
                claim({ chat: normalized });
        }
    }
    for (const c of claims) {
        if ((c.key.chatAddress !== undefined && c.key.chatAddress !== destination) || (c.key.direction !== undefined && c.key.direction !== 'outbound'))
            conflicting = true;
    }
    if (sendIdentityClaimsConflict(claims))
        conflicting = true;
    return { claims, conflicting };
}
export function sendIdentityClaimsConflict(claims: readonly SendIdentityClaim[]): boolean {
    return nativeFields.some(field => new Set(claims.map(c => c.key[field]).filter(v => v !== undefined)).size > 1);
}
export function sendEvidenceCanCompleteKey(source: TrustedMessagingContext, destination: string, value: unknown, key: WhatsAppMessageKey): boolean {
    const inspected = inspectSendIdentityEvidence(source, destination, value);
    return !inspected.conflicting && !sendIdentityClaimsConflict([...inspected.claims, { key }]);
}
