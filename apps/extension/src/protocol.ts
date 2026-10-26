import { z } from 'zod';
import type { ExtensionSession, ExtensionRead, ExtensionCommand, ExtensionChat } from '@prymeira-talk/shared';
export const selectionSchema = z.object({
  key: z.string().uuid(), selfAddress: z.string().max(100).nullable(), peerAddress: z.string().max(100).nullable(),
  label: z.string().max(160).nullable(), phase: z.enum(['ready', 'unidentified', 'switching', 'signed_out', 'unsupported']),
  lastMessageId: z.string().max(250).nullable(),
}).strict();
export type WaSelection = z.infer<typeof selectionSchema>;
export type PanelState = { windowId: number; tabId: number | null; selection: WaSelection | null; connected: boolean; session: ExtensionSession | null };
export type SelectedContext = { windowId: number; tabId: number; key: string; scope: string };
export type PanelRequest = { type: 'STATUS'; windowId?: number } | { type: 'CONNECT'; windowId?: number } | { type: 'DISCONNECT' }
  | { type: 'COMMAND'; context: SelectedContext; command: ExtensionCommand }
  | { type: 'INSERT'; context: SelectedContext; chat: ExtensionChat; suggestionId: string; contextKey: string; body: string };
export type RuntimeReply<T> = { ok: true; data: T } | { ok: false; error: string };
export async function runtimeRequest<T>(request: PanelRequest): Promise<T> {
  if (request.type === 'STATUS' || request.type === 'CONNECT') {
    const window = await chrome.windows.getCurrent();
    if (typeof window.id !== 'number') throw new Error('Janela do Chrome indisponível.');
    request = { ...request, windowId: window.id };
  }
  const result = await chrome.runtime.sendMessage(request) as RuntimeReply<T>;
  if (!result?.ok) throw new Error(result?.error ?? 'A conexão com a extensão foi interrompida.');
  return result.data;
}
export type ReadReply = ExtensionRead;
