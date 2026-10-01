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
