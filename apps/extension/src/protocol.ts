import { z } from 'zod';
import type { ExtensionSession, ExtensionRead, ExtensionCommand, ExtensionChat, ExtensionAccount, ExtensionQueueKind, ExtensionNavigationTarget } from '@prymeira-talk/shared';
export const selectionSchema = z.object({
  key: z.string().uuid(), selfAddress: z.string().max(100).nullable(), peerAddress: z.string().max(100).nullable(),
  label: z.string().max(160).nullable(), phase: z.enum(['ready', 'unidentified', 'switching', 'signed_out', 'unsupported']),
  lastMessageId: z.string().max(250).nullable(),
}).strict();
export type WaSelection = z.infer<typeof selectionSchema>;
export type PanelState = { windowId: number; tabId: number | null; selection: WaSelection | null; connected: boolean; connectionError?:string|null; session: ExtensionSession | null };
export type SelectedContext = { windowId: number; tabId: number; key: string; scope: string };
export type AccountContext = { windowId: number; tabId: number; scope: string; selfAddress: string };
export type OpenChatResult = { token: string | null; target: ExtensionNavigationTarget };
export type PanelRequest = { type: 'STATUS'; windowId?: number } | { type: 'CONNECT'; windowId?: number } | { type: 'DISCONNECT' }
  | { type: 'QUEUE'; context: AccountContext; account: ExtensionAccount; kind: ExtensionQueueKind; cursor?: string }
  | { type: 'OPEN_CHAT'; context: AccountContext; account: ExtensionAccount; kind: ExtensionQueueKind; id: string; expectedUpdatedAt?: string }
  | { type: 'PREPARE_FOLLOWUP'; context: SelectedContext; chat: ExtensionChat; token: string }
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
