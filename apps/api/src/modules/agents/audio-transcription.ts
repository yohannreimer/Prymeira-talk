import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TRANSCRIPTION_TIMEOUT_MS = 45_000;
const TRANSCRIPTION_PROMPT =
  "Atendimento comercial em português do Brasil sobre aço, chapas, barras, cantoneiras, vigas, tubos, perfis, inox, alumínio, medidas, milímetros e polegadas.";

export type AudioTranscriptionErrorCode =
  | "AUDIO_TOO_LARGE"
  | "UNSUPPORTED_AUDIO_TYPE"
  | "AUDIO_CONVERSION_FAILED"
  | "TRANSCRIPTION_FAILED"
  | "TRANSCRIPTION_TIMEOUT"
  | "EMPTY_TRANSCRIPT";

export class AudioTranscriptionError extends Error {
  constructor(public readonly code: AudioTranscriptionErrorCode, message: string) {
    super(message);
    this.name = "AudioTranscriptionError";
  }
}

export type AgentAudioTranscriptionResult = {
  text: string;
  playback: {
    bytes: Buffer;
    mimeType: "audio/mpeg";
  } | null;
};

export type AgentAudioTranscriber = {
  transcribe(input: {
    bytes: Buffer;
    mimeType: string;
  }): Promise<AgentAudioTranscriptionResult>;
};

type RunProcess = (command: string, args: string[]) => Promise<unknown>;

const directAudioTypes = new Map([
  ["audio/mpeg", { extension: "mp3", type: "audio/mpeg" }],
  ["audio/mp3", { extension: "mp3", type: "audio/mpeg" }],
  ["audio/mp4", { extension: "m4a", type: "audio/mp4" }],
  ["audio/x-m4a", { extension: "m4a", type: "audio/mp4" }],
  ["audio/wav", { extension: "wav", type: "audio/wav" }],
  ["audio/x-wav", { extension: "wav", type: "audio/wav" }],
  ["audio/webm", { extension: "webm", type: "audio/webm" }],
  ["video/webm", { extension: "webm", type: "audio/webm" }]
]);

function normalizeMimeType(value: string) {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function assertAudioSize(bytes: Buffer) {
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new AudioTranscriptionError("AUDIO_TOO_LARGE", "Audio exceeds the transcription size limit.");
  }
}

async function defaultRunProcess(command: string, args: string[]) {
  await execFileAsync(command, args, { timeout: TRANSCRIPTION_TIMEOUT_MS });
}

async function normalizeAudio(input: {
  bytes: Buffer;
  mimeType: string;
  ffmpegPath: string;
  runProcess: RunProcess;
  createTemporaryDirectory: () => Promise<string>;
}) {
  assertAudioSize(input.bytes);
  const mimeType = normalizeMimeType(input.mimeType);
  const directType = directAudioTypes.get(mimeType);
  if (directType) {
    return {
      bytes: input.bytes,
      mimeType: directType.type,
      extension: directType.extension,
      playback: null,
      cleanup: async () => {}
    };
  }

  if (mimeType !== "audio/ogg" && mimeType !== "audio/opus") {
    throw new AudioTranscriptionError("UNSUPPORTED_AUDIO_TYPE", "Audio type is unsupported.");
  }

  const directory = await input.createTemporaryDirectory();
  const sourcePath = join(directory, "input.ogg");
  const outputPath = join(directory, "output.mp3");
  try {
    await writeFile(sourcePath, input.bytes);
    try {
      await input.runProcess(input.ffmpegPath, [
        "-v", "error", "-y", "-i", sourcePath,
        "-vn", "-c:a", "libmp3lame", "-b:a", "64k", outputPath
      ]);
    } catch {
      throw new AudioTranscriptionError(
        "AUDIO_CONVERSION_FAILED",
        "Audio could not be converted for transcription."
      );
    }
    const bytes = await readFile(outputPath);
    assertAudioSize(bytes);
    return {
      bytes,
      mimeType: "audio/mpeg",
      extension: "mp3",
      playback: { bytes, mimeType: "audio/mpeg" as const },
      cleanup: () => rm(directory, { recursive: true, force: true })
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function createOpenAiCompatibleAudioTranscriber(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  ffmpegPath?: string;
  runProcess?: RunProcess;
  createTemporaryDirectory?: () => Promise<string>;
}): AgentAudioTranscriber {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const ffmpegPath = input.ffmpegPath ?? "ffmpeg";
  const runProcess = input.runProcess ?? defaultRunProcess;
  const createTemporaryDirectory = input.createTemporaryDirectory ??
    (() => mkdtemp(join(tmpdir(), "prymeira-talk-audio-")));

  return {
    async transcribe(audio) {
      const normalized = await normalizeAudio({
        ...audio,
        ffmpegPath,
        runProcess,
        createTemporaryDirectory
      });
      try {
        const form = new FormData();
        form.append("model", "gpt-transcribe");
        form.append("language", "pt");
        form.append("prompt", TRANSCRIPTION_PROMPT);
        form.append(
          "file",
          new File(
            [Uint8Array.from(normalized.bytes)],
            `audio.${normalized.extension}`,
            { type: normalized.mimeType }
          )
        );

        let response: Response;
        try {
          response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${input.apiKey}` },
            body: form,
            signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS)
          });
        } catch (error) {
          const name = error instanceof Error ? error.name : "";
          if (name === "AbortError" || name === "TimeoutError") {
            throw new AudioTranscriptionError(
              "TRANSCRIPTION_TIMEOUT",
              "Audio transcription timed out."
            );
          }
          throw new AudioTranscriptionError("TRANSCRIPTION_FAILED", "Audio transcription failed.");
        }

        if (!response.ok) {
          throw new AudioTranscriptionError("TRANSCRIPTION_FAILED", "Audio transcription failed.");
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new AudioTranscriptionError("TRANSCRIPTION_FAILED", "Audio transcription failed.");
        }
        const text = payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as { text?: unknown }).text
          : null;
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new AudioTranscriptionError("EMPTY_TRANSCRIPT", "Audio transcription was empty.");
        }
        return {
          text: text.trim(),
          playback: normalized.playback
        };
      } finally {
        await normalized.cleanup();
      }
    }
  };
}
