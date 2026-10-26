import { z } from 'zod';
import type { ExtensionSession, ExtensionRead, ExtensionCommand, ExtensionChat } from '@prymeira-talk/shared';
export const selectionSchema = z.object({
  key: z.string().uuid(), selfAddress: z.string().max(100).nullable(), peerAddress: z.string().max(100).nullable(),
  label: z.string().max(160).nullable(), phase: z.enum(['ready', 'unidentified', 'switching', 'signed_out', 'unsupported']),
  lastMessageId: z.string().max(250).nullable(),
}).strict();
export type WaSelection = z.infer<typeof selectionSchema>;
export type PanelState = { tabId: number | null; selection: WaSelection | null; connected: boolean; session: ExtensionSession | null };
export type SelectedContext = { tabId: number; key: string; scope: string };
export type PanelRequest = { type: 'STATUS' } | { type: 'CONNECT' } | { type: 'DISCONNECT' }
  | { type: 'COMMAND'; context: SelectedContext; command: ExtensionCommand }
  | { type: 'INSERT'; context: SelectedContext; chat: ExtensionChat; suggestionId: string; contextKey: string; body: string };
export type RuntimeReply<T> = { ok: true; data: T } | { ok: false; error: string };
export async function runtimeRequest<T>(request: PanelRequest): Promise<T> {
  const result = await chrome.runtime.sendMessage(request) as RuntimeReply<T>;
  if (!result?.ok) throw new Error(result?.error ?? 'A conexão com a extensão foi interrompida.');
  return result.data;
}
export type ReadReply = ExtensionRead;
