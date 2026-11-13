import { describe, expect, it, vi } from "vitest";
import { prepareFollowupAudio } from "./followup-audio-context.js";
import type { NormalizedConversationMessage } from "../agents/conversation-context-builder.js";

const message = (id: string, body: string | null, extra: Partial<NormalizedConversationMessage> = {}): NormalizedConversationMessage =>
  ({ id, body, direction: "outbound", type: "audio", label: "atendente", createdAt: "2026-11-10T12:00:00Z", ...extra });

describe("follow-up audio preparation", () => {
  it("does not transcribe cached text, other media or internal messages", async () => {
    const messages = [message("cached", "Não trabalho com tubos."), message("image", "Áudio recebido", { type: "image" }), message("system", null, { direction: null, label: "sistema" })];
    const transcribe = vi.fn();
    expect(await prepareFollowupAudio({ workspaceId: "w", conversationId: "c", messages, transcribe })).toEqual({ messages, unavailableMessageIds: [], pendingMessageIds: [] });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it.each([null, "", "   ", "Áudio recebido", "Áudio enviado", "Processando áudio...", "Não foi possível transcrever este áudio.", "[áudio]", "[áudio sem transcrição]"])("recognizes a missing transcript: %s", async body => {
    const transcribe = vi.fn().mockResolvedValue("Não tenho esse formato.");
    const result = await prepareFollowupAudio({ workspaceId: "w", conversationId: "c", messages: [message("m", body)], transcribe });
    expect(result.messages[0].body).toBe("Não tenho esse formato.");
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it.each([null, " ", "Áudio recebido", "[áudio sem transcrição]"])("does not accept an empty/placeholder provider result: %s", async text => {
    const result = await prepareFollowupAudio({ workspaceId: "w", conversationId: "c", messages: [message("m", null)], transcribe: vi.fn().mockResolvedValue(text) });
    expect(result.unavailableMessageIds).toEqual(["m"]);
  });

  it("finishes a cached backlog on the next claim, without redoing successful work", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(`m${i}`, null));
    const transcribe = vi.fn(async ({ messageId }: { messageId: string }) => {
      messages.find(m => m.id === messageId)!.body = "Vou avaliar esse orçamento.";
      return "Vou avaliar esse orçamento.";
    });
    const first = await prepareFollowupAudio({ workspaceId: "w", conversationId: "c", messages, transcribe });
    expect(first.pendingMessageIds).toEqual(["m0", "m1"]);
    expect(transcribe).toHaveBeenCalledTimes(8);
    const second = await prepareFollowupAudio({ workspaceId: "w", conversationId: "c", messages, transcribe });
    expect(second.pendingMessageIds).toEqual([]);
    expect(second.unavailableMessageIds).toEqual([]);
    expect(transcribe).toHaveBeenCalledTimes(10);
  });
});
