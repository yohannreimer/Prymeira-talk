import type { NormalizedConversationMessage } from "../agents/conversation-context-builder.js";
import { isUntranscribedAudio, type FollowupAudioTranscriber } from "./followup-brain.js";

/** Read both sides before interpreting a sale. The shared job caches each successful transcript. */
export async function prepareFollowupAudio(input: {
  workspaceId: string;
  conversationId: string;
  messages: NormalizedConversationMessage[];
  transcribe?: FollowupAudioTranscriber;
}) {
  const missing = input.messages.filter(message =>
    message.type === "audio" && (message.direction === "inbound" || message.direction === "outbound") && isUntranscribedAudio(message.body));
  const transcripts = new Map<string, string>();
  const unavailableMessageIds: string[] = [];
  // Bound work per claim. Successful batches are persisted by the shared transcription job and
  // the next claim continues; the analyst never sees a partially transcribed conversation.
  const batch = missing.slice(-8);
  for (const message of batch) {
    let text: string | null = null;
    try {
      text = await input.transcribe?.({ workspaceId: input.workspaceId, conversationId: input.conversationId, messageId: message.id }) ?? null;
    } catch { /* Unreadable media must stop the analysis, never become guessed facts. */ }
    if (isUntranscribedAudio(text)) unavailableMessageIds.push(message.id);
    else transcripts.set(message.id, text!.trim());
  }
  return {
    messages: input.messages.map(message => transcripts.has(message.id) ? { ...message, body: transcripts.get(message.id)! } : message),
    unavailableMessageIds,
    pendingMessageIds: missing.slice(0, Math.max(0, missing.length - batch.length)).map(message => message.id)
  };
}
