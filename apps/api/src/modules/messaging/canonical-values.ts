import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TrustedMessagingContext } from './normalized-event.js';
import type { WhatsAppMessageKey } from './whatsapp-identity.js';
type Scope = { workspaceId: string; channelId: string };
export const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
// Object key order is not identity. Arrays deliberately retain their order.
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
export const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const scopeOf = (context: TrustedMessagingContext): Scope => ({ workspaceId: context.workspaceId, channelId: context.channelId });

export const nativeLookupTuple = (context: TrustedMessagingContext, key: WhatsAppMessageKey) => [context.provider, context.connectionId, context.sessionName, key.nativeId];
