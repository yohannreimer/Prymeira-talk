import type { ChannelDto, MessageDto, MessageLocation } from '@prymeira-talk/shared';
import type { WhatsAppMessageKey } from './whatsapp-identity.js';

/** Constructed by authenticated ingress from DB records, never by webhook metadata.
 * Null physical connection permits the existing Meta-through-Evolution bridge.
 * A lifecycle token is evidence to recheck transactionally, not authorization by itself.
 */
export type TrustedMessagingContext = Readonly<{
  workspaceId: string; channelId: string; sessionName: string; channelProvider: 'evolution' | 'meta';
  lifecycleGeneration: number; mode: 'live' | 'history' | 'recovered_live'; observedAt: string;
} & ({ provider: 'evolution'; connectionId: string | null } | { provider: 'waha'; connectionId: string })>;

export interface NormalizedContent {
  type: MessageDto['type']; body: string | null; preview: string | null; mediaUrl: string | null;
  contactCards?: Array<{ fullName: string; phoneNumber: string | null }>;
  location?: MessageLocation;
}
export interface AttachmentPresentation {
  fileName?: string; caption?: string; mimeType?: string; durationSeconds?: number;
  width?: number; height?: number; sizeBytes?: number; pageCount?: number; isGif?: boolean;
}
export interface MediaSourceDescriptor {
  kind: 'audio' | 'image' | 'sticker' | 'video' | 'document' | 'unknown';
  hasMedia: boolean; url: string | null;
  state: 'available' | 'pending' | 'failed'; errorCode?: 'provider_media_unavailable';
}
export interface AddressMappingEvidence {
  role: 'chat' | 'sender'; lid: string; pn: string;
  source: 'evolution.remoteJidAlt' | 'evolution.participantAlt' | 'waha.lid_lookup';
}
/** Apply only the named field to an existing message. Caption removal is an empty string.
 * A caption patch preserves type, media URL, file metadata and prepared results; the
 * writer recomputes presentation from the existing media kind instead of replacing content.
 */
export type MessageEditPatch = { field: 'body'; body: string } | { field: 'caption'; caption: string };
/** Timestamp/sequence can be absent. Absence must hold conflicting edits for reconciliation. */
export interface SourceOrder { timestampMs: number | null; sequence: string | null }
interface BaseEvent {
  context: TrustedMessagingContext;
  providerEventId: string | null;
  providerEventType: string;
  addressMappings: AddressMappingEvidence[];
}
export type NormalizedMessagingEvent = BaseEvent & (
  | { kind: 'message'; key: WhatsAppMessageKey; content: NormalizedContent; attachment: AttachmentPresentation;
      media: MediaSourceDescriptor | null; currentRevision: WhatsAppMessageKey | null; pushName: string | null; source: string | null; order: SourceOrder }
  | { kind: 'edit'; target: WhatsAppMessageKey; action: WhatsAppMessageKey; patch: MessageEditPatch; order: SourceOrder }
  | { kind: 'encrypted_edit'; target: WhatsAppMessageKey; action: WhatsAppMessageKey;
      encrypted: { ivBase64: string; payloadBase64: string; senderJids: string[] }; order: SourceOrder }
  | { kind: 'revoke'; target: WhatsAppMessageKey; action: WhatsAppMessageKey; order: SourceOrder }
  | { kind: 'receipt'; target: WhatsAppMessageKey; status: MessageDto['status']; providerStatus: string | number; recipient: string | null; order: SourceOrder }
  | { kind: 'control'; control: 'connection'; status: ChannelDto['status'] }
  | { kind: 'control'; control: 'qr'; qrCode: string }
);
export type NormalizationResult = { kind: 'accepted'; event: NormalizedMessagingEvent }
  | { kind: 'invalid' | 'ignored'; reason: string };
