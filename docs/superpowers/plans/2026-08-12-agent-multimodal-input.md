# Agent Multimodal Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable every Prymeira Talk agent to understand inbound WhatsApp images and audio while always replying in text and preserving existing deterministic safety policies.

**Architecture:** Resolve inbound message media through a bounded, SSRF-safe media layer. Pass images as structured Chat Completions image content; convert/transcribe WhatsApp audio before retrieval and safety evaluation, then run the existing agent pipeline with the derived text. Keep all text-only request shapes compatible and isolate FFmpeg/audio concerns from the agent runtime.

**Tech Stack:** TypeScript, Fastify, Vitest, OpenAI-compatible Chat Completions and Audio Transcriptions APIs, Evolution API webhooks, FFmpeg, Docker/Alpine, pnpm.

---

## File structure

- Create `apps/api/src/modules/agents/agent-media-resolver.ts`: validate/decode/fetch bounded inbound media and block non-public HTTP targets.
- Create `apps/api/src/modules/agents/agent-media-resolver.test.ts`: data URL, size, MIME, timeout, redirect, and SSRF coverage.
- Create `apps/api/src/modules/agents/audio-transcription.ts`: normalize audio with FFmpeg when required and call the transcription endpoint.
- Create `apps/api/src/modules/agents/audio-transcription.test.ts`: multipart contract, OGG conversion, timeout, cleanup, and response validation.
- Modify `apps/api/src/modules/agents/provider-gateway.ts`: add the structured image attachment and shared multimodal safety suffix.
- Modify `apps/api/src/modules/agents/provider-gateway.test.ts`: verify image request content and text-only compatibility.
- Modify `apps/api/src/modules/agents/agent-runtime.ts`: preprocess inbound media before retrieval/safety and apply exact fallbacks.
- Modify `apps/api/src/modules/agents/agent-runtime.test.ts`: cover image, audio, protected transcripts, and failures.
- Modify `apps/api/Dockerfile`: install FFmpeg in the production runtime.
- Modify `docs/superpowers/specs/2026-08-12-villefer-exploratory-boundaries-design.md`: supersede the temporary image limitation with the shipped multimodal contract.
- Modify the production Villefer prompt through Prymeira Talk after the API rollout: replace the temporary image disclaimer.

## Task 1: Resolve bounded media safely

**Files:**
- Create: `apps/api/src/modules/agents/agent-media-resolver.ts`
- Create: `apps/api/src/modules/agents/agent-media-resolver.test.ts`

- [ ] **Step 1: Write failing data URL and validation tests**

Create the test file with concrete cases:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  AgentMediaError,
  resolveAgentMedia,
  type AgentMediaPolicy
} from "./agent-media-resolver.js";

const imagePolicy: AgentMediaPolicy = {
  kind: "image",
  maxBytes: 10 * 1024 * 1024,
  allowedMimeTypes: new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
};

describe("resolveAgentMedia", () => {
  it("decodes a valid base64 image data URL", async () => {
    await expect(resolveAgentMedia({
      mediaUrl: "data:image/jpeg;base64,aW1hZ2Vt",
      policy: imagePolicy
    })).resolves.toEqual({
      bytes: Buffer.from("imagem"),
      mimeType: "image/jpeg",
      source: "data_url"
    });
  });

  it.each([
    ["data:image/jpeg;base64,%%%", "INVALID_BASE64"],
    ["data:text/plain;base64,b2k=", "UNSUPPORTED_MEDIA_TYPE"]
  ])("rejects invalid media %s", async (mediaUrl, code) => {
    await expect(resolveAgentMedia({ mediaUrl, policy: imagePolicy }))
      .rejects.toMatchObject({ code });
  });

  it("rejects decoded data over the application limit", async () => {
    await expect(resolveAgentMedia({
      mediaUrl: `data:image/jpeg;base64,${Buffer.alloc(9).toString("base64")}`,
      policy: { ...imagePolicy, maxBytes: 8 }
    })).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
  });
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
pnpm --filter @prymeira-talk/api exec vitest run src/modules/agents/agent-media-resolver.test.ts
```

Expected: FAIL because `agent-media-resolver.ts` does not exist.

- [ ] **Step 3: Implement data URL decoding and stable errors**

Create the public contract and data URL path:

```ts
export type AgentMediaPolicy = {
  kind: "image" | "audio";
  maxBytes: number;
  allowedMimeTypes: ReadonlySet<string>;
};

export class AgentMediaError extends Error {
  constructor(
    public readonly code:
      | "MEDIA_UNAVAILABLE"
      | "INVALID_MEDIA_URL"
      | "INVALID_BASE64"
      | "UNSUPPORTED_MEDIA_TYPE"
      | "MEDIA_TOO_LARGE"
      | "MEDIA_TIMEOUT"
      | "MEDIA_NETWORK_BLOCKED",
    message: string
  ) {
    super(message);
    this.name = "AgentMediaError";
  }
}

export type ResolvedAgentMedia = {
  bytes: Buffer;
  mimeType: string;
  source: "data_url" | "remote";
};

export async function resolveAgentMedia(input: {
  mediaUrl: string | null | undefined;
  policy: AgentMediaPolicy;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ResolvedAgentMedia> {
  if (!input.mediaUrl) {
    throw new AgentMediaError("MEDIA_UNAVAILABLE", "Inbound media is unavailable.");
  }

  if (input.mediaUrl.startsWith("data:")) {
    return decodeDataUrl(input.mediaUrl, input.policy);
  }

  return await fetchRemoteMedia(input);
}
```

Implement `decodeDataUrl` with the exact `data:<mime>;base64,<payload>` grammar, whitespace removal, canonical base64 round-trip validation, MIME normalization before policy comparison, and decoded-byte enforcement.

- [ ] **Step 4: Add failing public HTTP, timeout, redirect, and SSRF tests**

Add tests that inject `fetchImpl` and DNS resolution seams. Cover:

```ts
it.each([
  "http://127.0.0.1/media.jpg",
  "http://169.254.169.254/latest/meta-data",
  "http://[::1]/media.jpg",
  "http://10.0.0.2/media.jpg"
])("blocks non-public targets: %s", async (mediaUrl) => {
  await expect(resolveAgentMedia({ mediaUrl, policy: imagePolicy }))
    .rejects.toMatchObject({ code: "MEDIA_NETWORK_BLOCKED" });
});

it("stops reading when content exceeds maxBytes", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(
    Buffer.alloc(9),
    { headers: { "content-type": "image/jpeg" } }
  ));
  await expect(resolveAgentMedia({
    mediaUrl: "https://media.example.com/image.jpg",
    policy: { ...imagePolicy, maxBytes: 8 },
    fetchImpl
  })).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
});
```

Use an injected `resolveHost` option in tests so `media.example.com` resolves to `203.0.113.10` without real DNS.

- [ ] **Step 5: Implement bounded remote fetching**

Implement manual redirects (maximum three), `AbortSignal.timeout(input.timeoutMs ?? 15_000)`, `Content-Length` preflight checks, streamed byte counting, and content-type validation. Resolve every redirect hostname before fetching and reject IPv4/IPv6 loopback, private, link-local, multicast, and unspecified ranges. Allow only `http:` and `https:` URLs.

Do not include the URL, response body, bytes, or authorization data in thrown messages.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
pnpm --filter @prymeira-talk/api exec vitest run src/modules/agents/agent-media-resolver.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all resolver tests PASS and typecheck exits 0.

Commit:

```bash
git add apps/api/src/modules/agents/agent-media-resolver.ts apps/api/src/modules/agents/agent-media-resolver.test.ts
git commit -m "feat: resolve inbound agent media safely"
```

## Task 2: Add bounded audio transcription

**Files:**
- Create: `apps/api/src/modules/agents/audio-transcription.ts`
- Create: `apps/api/src/modules/agents/audio-transcription.test.ts`

- [ ] **Step 1: Write failing direct transcription contract tests**

Create tests for a supported WebM input:

```ts
import { describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleAudioTranscriber } from "./audio-transcription.js";

describe("createOpenAiCompatibleAudioTranscriber", () => {
  it("posts bounded audio as multipart form data", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: "Preciso de dez chapas de três milímetros." }), {
        headers: { "content-type": "application/json" }
      })
    );
    const transcriber = createOpenAiCompatibleAudioTranscriber({
      baseUrl: "https://provider.example/v1/",
      apiKey: "secret",
      fetchImpl
    });

    await expect(transcriber.transcribe({
      bytes: Buffer.from("webm-audio"),
      mimeType: "audio/webm"
    })).resolves.toBe("Preciso de dez chapas de três milímetros.");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://provider.example/v1/audio/transcriptions");
    expect(init?.headers).toEqual({ Authorization: "Bearer secret" });
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("file")).toBeInstanceOf(File);
  });
});
```

Add cases for empty/invalid JSON responses, non-2xx responses, and a request exceeding 45 seconds through an injected signal/timeout seam.

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
pnpm --filter @prymeira-talk/api exec vitest run src/modules/agents/audio-transcription.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement direct transcription**

Expose:

```ts
export type AgentAudioTranscriber = {
  transcribe(input: { bytes: Buffer; mimeType: string }): Promise<string>;
};

export function createOpenAiCompatibleAudioTranscriber(input: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  ffmpegPath?: string;
  runProcess?: typeof execFile;
}): AgentAudioTranscriber;
```

For documented formats, construct a `File` with a safe fixed basename and the MIME-specific extension, append `model=gpt-transcribe`, `file`, `language=pt`, and a short product vocabulary prompt. Use only the bearer header; let `fetch` set the multipart boundary. Parse `{ text: string }`, trim it, and reject an empty transcript with `AudioTranscriptionError("EMPTY_TRANSCRIPT")`.

- [ ] **Step 4: Write failing OGG/Opus conversion and cleanup tests**

Inject `runProcess` and verify the first FFmpeg call attempts remux:

```ts
expect(runProcess).toHaveBeenCalledWith(
  "ffmpeg",
  expect.arrayContaining(["-c:a", "copy"]),
  expect.any(Function)
);
```

Make remux fail once and verify a second call uses `libopus`. Verify the file uploaded to transcription is `audio/webm`. Mock both success and provider failure and assert the temporary directory no longer exists afterward.

- [ ] **Step 5: Implement OGG normalization with guaranteed cleanup**

Use `mkdtemp`, `writeFile`, `readFile`, and `rm({ recursive: true, force: true })` from Node built-ins. For `audio/ogg` or `audio/opus`:

1. write bounded input to a temporary `.ogg` file;
2. run `ffmpeg -v error -y -i input.ogg -c:a copy output.webm`;
3. if that exits nonzero, run `ffmpeg -v error -y -i input.ogg -c:a libopus -b:a 32k output.webm`;
4. reject converted output over 25 MB;
5. upload as `audio/webm`;
6. remove the entire temporary directory in `finally`.

Wrap FFmpeg failures in `AudioTranscriptionError("AUDIO_CONVERSION_FAILED")` without including paths or process stderr in customer-facing output.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
pnpm --filter @prymeira-talk/api exec vitest run src/modules/agents/audio-transcription.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all transcription tests PASS and typecheck exits 0.

Commit:

```bash
git add apps/api/src/modules/agents/audio-transcription.ts apps/api/src/modules/agents/audio-transcription.test.ts
git commit -m "feat: transcribe inbound WhatsApp audio"
```

## Task 3: Send image inputs through the provider gateway

**Files:**
- Modify: `apps/api/src/modules/agents/provider-gateway.ts`
- Modify: `apps/api/src/modules/agents/provider-gateway.test.ts`

- [ ] **Step 1: Write a failing multimodal request test**

Add:

```ts
it("sends image attachments as multimodal user content", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(validProviderResponse());
  const provider = createOpenAiCompatibleAgentProvider({
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    chatModel: "gpt-5.6-luna",
    fetchImpl: fetchMock
  });

  await provider.generate({
    model: "ignored",
    systemPrompt: "Atenda com segurança.",
    userPrompt: "Vocês trabalham com estes itens?",
    context: { messageBody: "Vocês trabalham com estes itens?" },
    attachment: {
      type: "image",
      url: "data:image/jpeg;base64,aW1hZ2Vt",
      detail: "high"
    }
  });

  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(body.messages[1].content).toEqual([
    { type: "text", text: expect.stringContaining("Vocês trabalham com estes itens?") },
    {
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,aW1hZ2Vt", detail: "high" }
    }
  ]);
});
```

Retain the existing text test and assert `typeof body.messages[1].content === "string"` for calls without attachments.

- [ ] **Step 2: Run the provider test and verify red**

Run:

```bash
pnpm --filter @prymeira-talk/api exec vitest run src/modules/agents/provider-gateway.test.ts
```

Expected: FAIL because `attachment` is not part of `AgentProviderInput`.

- [ ] **Step 3: Extend the provider contract and renderer**

Add:

```ts
export type AgentImageAttachment = {
  type: "image";
  url: string;
  detail: "high";
};

export interface AgentProviderInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  context: Record<string, unknown>;
  attachment?: AgentImageAttachment;
}
```

Keep `buildOpenAiCompatibleUserContent` unchanged. In `buildOpenAiCompatibleRequestBody`, compute its text once; use the string directly for text-only calls and the two-part content array for image calls.

Append a shared policy to `buildOpenAiCompatibleSystemPrompt` that requires cautious observations, prohibits inferring dimensions/alloy/grade/engineering suitability/commercial facts from pixels, and asks for clarification when visible text or spoken critical values are uncertain.

- [ ] **Step 4: Run provider regression and commit**

Run:

```bash
pnpm --filter @prymeira-talk/api exec vitest run src/modules/agents/provider-gateway.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: provider tests PASS; text-only shape remains unchanged.

Commit:

```bash
git add apps/api/src/modules/agents/provider-gateway.ts apps/api/src/modules/agents/provider-gateway.test.ts
git commit -m "feat: pass images to agent vision models"
```

## Task 4: Integrate preprocessing into the agent runtime

**Files:**
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.test.ts`

- [ ] **Step 1: Write failing image runtime tests**

Create a message override with:

```ts
const imageMessage = {
  ...baseMessage,
  type: "image",
  body: "Vocês trabalham com estes itens?",
  mediaUrl: "data:image/jpeg;base64,aW1hZ2Vt"
};
```

Inject a `mediaResolver` spy and assert provider `generate` receives the caption as `userPrompt` plus an image attachment. Add a missing-media case asserting the exact outbound reply:

```ts
"Não consegui analisar essa imagem. Pode reenviar com mais nitidez ou mandar a lista em texto?"
```

and assert provider `generate` was not called.

- [ ] **Step 2: Write failing audio runtime tests**

Inject `audioTranscriber.transcribe` returning `"Tem exatamente 30 chapas em estoque hoje?"`. Assert:

- knowledge retrieval/provider context use the transcript rather than `Áudio recebido`;
- deterministic safety returns `HANDOFF_ACKNOWLEDGEMENT`;
- provider `generate` is not called for the protected stock request;
- the outbound Evolution reply is text.

Add a transcription failure case with the exact reply:

```ts
"Não consegui entender esse áudio. Pode reenviar ou escrever a mensagem?"
```

- [ ] **Step 3: Run runtime tests and verify red**

Run:

```bash
pnpm --filter @prymeira-talk/api exec vitest run src/modules/agents/agent-runtime.test.ts
```

Expected: FAIL because media dependencies and effective message text do not exist.

- [ ] **Step 4: Add runtime dependencies and effective-message preprocessing**

Extend `createAgentRuntime` inputs:

```ts
mediaResolver?: typeof resolveAgentMedia;
audioTranscriberFactory?: (
  settings: Extract<OpenAiCompatibleSettings, { active: true }>
) => AgentAudioTranscriber;
```

After resolving provider settings and before knowledge selection, derive:

```ts
type PreparedAgentMessage = {
  effectiveText: string;
  attachment?: AgentImageAttachment;
};
```

For images, enforce 10 MB and supported image MIME policy, convert resolved bytes back to a normalized data URL, preserve a real caption, and use a neutral prompt such as `Analise a imagem enviada pelo cliente.` when the stored body is only `Imagem recebida` or `Figurinha recebida`.

For audio, enforce 25 MB and audio MIME policy, instantiate the transcriber only from active real settings, and use the returned transcript as `effectiveText`.

Use `effectiveText` consistently in:

- `selectRelevantKnowledge.latestMessage`;
- `evaluateAgentSafety.message`;
- `buildUserPrompt`;
- `context.messageBody`.

Include only safe media metadata (`type`, `mimeType`, `source`) in context summary; never include bytes or a data URL.

- [ ] **Step 5: Send media fallbacks through the existing outbound path**

Centralize constants:

```ts
export const IMAGE_PROCESSING_FALLBACK =
  "Não consegui analisar essa imagem. Pode reenviar com mais nitidez ou mandar a lista em texto?";
export const AUDIO_PROCESSING_FALLBACK =
  "Não consegui entender esse áudio. Pode reenviar ou escrever a mensagem?";
```

On preprocessing failure, skip provider generation/actions, create a completed run with a sanitized failure code in `contextSummary`, send the fallback through Evolution, persist the outbound text message, and publish the same realtime events as an ordinary agent reply. Do not schedule an automatic retry.

- [ ] **Step 6: Run runtime and adjacent scheduler tests**

Run:

```bash
pnpm --filter @prymeira-talk/api exec vitest run \
  src/modules/agents/agent-runtime.test.ts \
  src/modules/agents/agent-reply-scheduler.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all focused tests PASS.

- [ ] **Step 7: Commit runtime integration**

```bash
git add apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts
git commit -m "feat: process image and audio agent messages"
```

## Task 5: Put FFmpeg in the production image

**Files:**
- Modify: `apps/api/Dockerfile`

- [ ] **Step 1: Write the production-image assertion command**

Build and inspect the image before changing the Dockerfile:

```bash
docker build -f apps/api/Dockerfile -t prymeira-talk-api:multimodal-red .
docker run --rm prymeira-talk-api:multimodal-red ffmpeg -version
```

Expected: the second command FAILS because FFmpeg is absent.

- [ ] **Step 2: Install FFmpeg only in the runtime stage**

Change the runtime stage to:

```dockerfile
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache ffmpeg \
  && corepack enable \
  && corepack prepare pnpm@10.0.0 --activate
COPY --from=builder /runtime ./
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3002
```

- [ ] **Step 3: Build and verify FFmpeg, startup, and size**

Run:

```bash
docker build -f apps/api/Dockerfile -t prymeira-talk-api:multimodal .
docker run --rm prymeira-talk-api:multimodal ffmpeg -version
docker image inspect prymeira-talk-api:multimodal --format '{{.Size}}'
```

Expected: FFmpeg exits 0; image size is no more than `471859200` bytes.

- [ ] **Step 4: Commit the image change**

```bash
git add apps/api/Dockerfile
git commit -m "build: include ffmpeg for agent audio"
```

## Task 6: Full regression and documentation consistency

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-villefer-exploratory-boundaries-design.md`
- Verify: `docs/superpowers/specs/2026-08-12-agent-multimodal-input-design.md`

- [ ] **Step 1: Supersede the temporary image limitation**

Replace the old `Image-list behavior` section with a note that the limitation applied before the multimodal release and link to the new design. Do not rewrite historical verification results.

- [ ] **Step 2: Run complete verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all shared, web, and API tests PASS; typecheck/build exit 0; no whitespace errors.

- [ ] **Step 3: Review diagnostic redaction**

Run:

```bash
rg -n "mediaUrl|base64|bytes|apiKey|Authorization" apps/api/src/modules/agents
```

Inspect every new logging/debug assignment. Expected: no media payload, data URL, API key, authorization header, temporary path, or provider response body is stored in `contextSummary`, errors, or logs.

- [ ] **Step 4: Commit documentation and regression record**

```bash
git add docs/superpowers/specs/2026-08-12-villefer-exploratory-boundaries-design.md
git commit -m "docs: supersede Villefer image limitation"
```

## Task 7: Publish, configure Villefer, and validate production

**Files:**
- Production configuration: Villefer agent prompt in Prymeira Talk
- Production service: `prymeiratalk_prymeira_talk_api` in Portainer

- [ ] **Step 1: Push the feature and release branches**

```bash
git push origin HEAD:codex/villefer-agent-hardening
git push origin HEAD:codex/prymeira-talk-foundation
```

Expected: both pushes succeed and trigger `Publish Docker images` for the release commit.

- [ ] **Step 2: Wait for image publication**

```bash
release_sha=$(git rev-parse HEAD)
run_id=$(gh run list --repo yohannreimer/Prymeira-talk --limit 20 \
  --json databaseId,headSha --jq ".[] | select(.headSha == \"$release_sha\") | .databaseId" | head -1)
test -n "$run_id"
gh run watch "$run_id" --repo yohannreimer/Prymeira-talk --exit-status
```

Expected: API and web publication jobs complete successfully for the exact commit SHA.

- [ ] **Step 3: Update only the API service**

In Portainer, change only the image of `prymeiratalk_prymeira_talk_api` to:

```text
ghcr.io/yohannreimer/prymeira-talk-api:$(git rev-parse HEAD)
```

Preserve environment variables, networks, mounts, replica count, and all other services. Wait for the new task to be `running`.

- [ ] **Step 4: Verify production readiness**

```bash
curl -fsS https://talk.prymeiradigital.com.br/api/health
curl -fsS https://talk.prymeiradigital.com.br/api/ready
```

Expected from both: HTTP 200 with `{"ok":true,"product":"talk"}`.

- [ ] **Step 5: Replace Villefer's temporary image disclaimer**

In the Villefer system prompt, remove the sentence saying the agent does not receive visual content. Add:

```text
IMAGENS E ÁUDIOS: Você pode receber imagens e transcrições de áudios do cliente. Em imagens, descreva apenas o que consegue observar e sinalize incerteza com expressões como “pela imagem, parece ser”. Você pode ler listas visíveis e comparar os itens com a base oficial. Nunca deduza por aparência medidas exatas, liga, norma, capacidade estrutural, adequação de engenharia, estoque, preço, prazo ou condição comercial. Se a imagem estiver borrada, cortada ou ambígua, peça outra imagem ou a lista em texto. Em transcrições de áudio, confirme números, unidades, códigos ou nomes quando houver ambiguidade.
```

Save and reload the agent to verify persistence.

- [ ] **Step 6: Execute the WhatsApp acceptance matrix**

Send the eight cases from the approved spec:

1. clear photographed product list;
2. blurred/cropped list;
3. product/material photo;
4. structural sizing request with photo;
5. Portuguese product voice note;
6. exact stock/price/deadline voice note;
7. ambiguous measurement voice note;
8. corrupt/unsupported media fixture through the integration test path.

Record the exact customer input, agent response, latency, and pass/fail. Expected: all responses are text, useful responses use visible/spoken content, protected facts hand off deterministically, and failures use the exact fallback once.

- [ ] **Step 7: Final repository and service verification**

```bash
git status --short
git log -1 --oneline
curl -fsS https://talk.prymeiradigital.com.br/api/ready
```

Expected: clean worktree, expected release commit, and HTTP 200 readiness. Keep the previous API image tag available for rollback.
