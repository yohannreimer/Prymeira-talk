import { describe, expect, it, vi } from "vitest";
import { createFollowupAudioTranscriber } from "./followup-audio-transcriber.js";

describe("follow-up audio transcriber", () => {
  it("uses the shared transcription job without retrying a failed audio", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ status: "completed", text: "Vou ver e te aviso", message: null })
      .mockResolvedValueOnce({ status: "failed", errorCode: "MEDIA_UNREADABLE", message: null });
    const transcribe = createFollowupAudioTranscriber({
      prisma: {} as never,
      media: vi.fn(),
      transcriptions: { run }
    });
    const target = { workspaceId: "w", conversationId: "c", messageId: "m" };

    expect(await transcribe(target)).toBe("Vou ver e te aviso");
    expect(await transcribe(target)).toBeNull();
    expect(run.mock.calls[0]?.[0]).toMatchObject({ ...target, retryFailed: false });
  });
});
