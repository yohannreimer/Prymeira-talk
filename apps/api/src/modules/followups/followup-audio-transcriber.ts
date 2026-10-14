import type { PrismaClient } from "@prisma/client";
import { resolveOpenAiCompatibleSettings } from "../agents/ai-provider-settings.js";
import { transcribeInboundAudio } from "../agents/inbound-media.js";
import type { MessageTranscriptionService } from "../conversations/message-transcription.js";
import type { FollowupAudioTranscriber } from "./followup-brain.js";

type Media = { bytes: Buffer; mimeType: string };

/**
 * Transcribes an audio for the follow-up with the same job the inbox "ver transcrição" button uses,
 * so the text is saved on the message and shown to the team too, and an audio is never transcribed twice.
 * A failed transcription is not retried here: the button is the way to try again.
 */
export function createFollowupAudioTranscriber(input: {
  prisma: Parameters<typeof resolveOpenAiCompatibleSettings>[0] & Pick<PrismaClient, "message">;
  media: (workspaceId: string, conversationId: string, messageId: string) => Promise<Media>;
  transcriptions?: MessageTranscriptionService;
}): FollowupAudioTranscriber {
  return async ({ workspaceId, conversationId, messageId }) => {
    const work = async () => {
      const media = await input.media(workspaceId, conversationId, messageId);
      const settings = await resolveOpenAiCompatibleSettings(input.prisma, { workspaceId });
      return { text: (await transcribeInboundAudio({ bytes: media.bytes, mimeType: media.mimeType, settings })).text };
    };
    if (input.transcriptions && (input.transcriptions.appliesTo?.(workspaceId) ?? true)) {
      const outcome = await input.transcriptions.run({ workspaceId, conversationId, messageId, retryFailed: false, work });
      return outcome.status === "completed" ? outcome.text : null;
    }
    const { text } = await work();
    await input.prisma.message.updateMany({ where: { id: messageId, workspaceId, conversationId, type: "audio" }, data: { body: text } });
    return text;
  };
}
