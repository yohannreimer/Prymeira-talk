import type { AgentMediaPolicy } from '../agents/agent-media-resolver.js';

/** Shared by the inbox media endpoint and the durable media store, so both accept the same files. */
export const MAX_SERVE_MEDIA_BYTES = 25 * 1024 * 1024;
export const imageMimeTypes: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const audioMimeTypes: ReadonlySet<string> = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/opus', 'audio/webm', 'video/webm']);
export const documentMimeTypes: ReadonlySet<string> = new Set(['application/pdf', 'video/mp4', 'video/webm', 'video/quicktime', 'application/octet-stream', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain']);

export type AttachmentMessageType = 'audio' | 'image' | 'file';
export function isAttachmentType(type: string): type is AttachmentMessageType {
  return type === 'audio' || type === 'image' || type === 'file';
}
export function servePolicy(type: AttachmentMessageType): AgentMediaPolicy {
  return { kind: type === 'audio' ? 'audio' : type === 'image' ? 'image' : 'document', maxBytes: MAX_SERVE_MEDIA_BYTES,
    allowedMimeTypes: type === 'audio' ? audioMimeTypes : type === 'image' ? imageMimeTypes : documentMimeTypes };
}
