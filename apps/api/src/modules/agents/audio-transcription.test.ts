import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleAudioTranscriber } from "./audio-transcription.js";

function successResponse(text = "Preciso de dez chapas de três milímetros.") {
  return new Response(JSON.stringify({ text }), {
    headers: { "content-type": "application/json" }
  });
}

describe("createOpenAiCompatibleAudioTranscriber", () => {
  it("posts bounded audio as multipart form data", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(successResponse());
    const transcriber = createOpenAiCompatibleAudioTranscriber({
      baseUrl: "https://provider.example/v1/",
      apiKey: "secret",
      fetchImpl
    });

    await expect(transcriber.transcribe({
      bytes: Buffer.from("webm-audio"),
      mimeType: "audio/webm"
    })).resolves.toEqual({
      text: "Preciso de dez chapas de três milímetros.",
      playback: null
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://provider.example/v1/audio/transcriptions");
    expect(init?.headers).toEqual({ Authorization: "Bearer secret" });
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("language")).toBe("pt");
    expect(form.get("prompt")).toEqual(expect.stringContaining("chapas"));
    expect(form.get("file")).toBeInstanceOf(File);
    expect((form.get("file") as File).name).toBe("audio.webm");
  });

  it("rejects empty transcripts", async () => {
    const transcriber = createOpenAiCompatibleAudioTranscriber({
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(successResponse("  "))
    });
    await expect(transcriber.transcribe({
      bytes: Buffer.from("audio"),
      mimeType: "audio/wav"
    })).rejects.toMatchObject({ code: "EMPTY_TRANSCRIPT" });
  });

  it("redacts provider failures behind a stable error", async () => {
    const transcriber = createOpenAiCompatibleAudioTranscriber({
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "sensitive provider detail" } }), { status: 400 })
      )
    });
    await expect(transcriber.transcribe({
      bytes: Buffer.from("audio"),
      mimeType: "audio/mpeg"
    })).rejects.toMatchObject({ code: "TRANSCRIPTION_FAILED" });
  });

  it("converts OGG/Opus to MP3 and returns browser playback bytes", async () => {
    let temporaryDirectory: string | null = null;
    const createTemporaryDirectory = async () => {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "talk-audio-test-"));
      return temporaryDirectory;
    };
    const runProcess = vi.fn(async (_command: string, args: string[]) => {
      const outputPath = args.at(-1)!;
      await writeFile(outputPath, Buffer.from("converted-mp3"));
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(successResponse("Áudio convertido."));
    const transcriber = createOpenAiCompatibleAudioTranscriber({
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      fetchImpl,
      runProcess,
      createTemporaryDirectory
    });

    await expect(transcriber.transcribe({
      bytes: Buffer.from("ogg-opus"),
      mimeType: "audio/ogg"
    })).resolves.toEqual({
      text: "Áudio convertido.",
      playback: {
        bytes: Buffer.from("converted-mp3"),
        mimeType: "audio/mpeg"
      }
    });

    expect(runProcess).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-c:a", "libmp3lame", "-b:a", "64k"])
    );
    const file = ((fetchImpl.mock.calls[0][1]?.body as FormData).get("file")) as File;
    expect(file.type).toBe("audio/mpeg");
    expect(file.name).toBe("audio.mp3");
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("converted-mp3");
    await expect(access(temporaryDirectory!)).rejects.toThrow();
  });

  it("cleans up converted MP3 after provider failure", async () => {
    let temporaryDirectory: string | null = null;
    const createTemporaryDirectory = async () => {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "talk-audio-test-"));
      return temporaryDirectory;
    };
    const runProcess = vi.fn(async (_command: string, args: string[]) => {
      await writeFile(args.at(-1)!, Buffer.from("converted-mp3"));
    });
    const transcriber = createOpenAiCompatibleAudioTranscriber({
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response("down", { status: 503 })),
      runProcess,
      createTemporaryDirectory
    });

    await expect(transcriber.transcribe({
      bytes: Buffer.from("ogg-opus"),
      mimeType: "audio/ogg; codecs=opus"
    })).rejects.toMatchObject({ code: "TRANSCRIPTION_FAILED" });
    expect(runProcess).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-c:a", "libmp3lame", "-b:a", "64k"])
    );
    await expect(access(temporaryDirectory!)).rejects.toThrow();
  });

  it("rejects converted audio over 25 MB", async () => {
    const createTemporaryDirectory = () => mkdtemp(join(tmpdir(), "talk-audio-test-"));
    const runProcess = vi.fn(async (_command: string, args: string[]) => {
      await writeFile(args.at(-1)!, Buffer.alloc(25 * 1024 * 1024 + 1));
    });
    const transcriber = createOpenAiCompatibleAudioTranscriber({
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      fetchImpl: vi.fn<typeof fetch>(),
      runProcess,
      createTemporaryDirectory
    });
    await expect(transcriber.transcribe({
      bytes: Buffer.from("ogg"),
      mimeType: "audio/ogg"
    })).rejects.toMatchObject({ code: "AUDIO_TOO_LARGE" });
  });
});
