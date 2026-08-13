# Immediate Audio Transcription Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe inbound WhatsApp audio immediately while keeping the configurable delay only for the agent's reply.

**Architecture:** Add an idempotent `prepareAudioMessage` operation to the existing agent runtime. Evolution ingestion invokes it before automations and reply scheduling; the delayed agent run then reuses the stored transcript or stored failure instead of resolving and transcribing the audio again.

**Tech Stack:** TypeScript, Fastify, Prisma, Vitest, Evolution webhook, OpenAI-compatible transcription, ffmpeg.

---

## File Structure

- Modify `apps/api/src/modules/agents/agent-runtime.ts`: own immediate audio preparation, persistence, realtime publication, and reuse of terminal audio state.
- Modify `apps/api/src/modules/agents/agent-runtime.test.ts`: cover preparation success, preparation failure, and delayed reuse without retranscription.
- Modify `apps/api/src/modules/evolution/evolution.routes.ts`: invoke audio preparation during inbound webhook ingestion before automation and scheduling.
- Modify `apps/api/src/modules/evolution/evolution.routes.test.ts`: prove ordering and confirm a following message cannot cancel preparation already completed.

### Task 1: Make audio preparation idempotent in the agent runtime

**Files:**
- Modify: `apps/api/src/modules/agents/agent-runtime.ts:159-222,557-643`
- Test: `apps/api/src/modules/agents/agent-runtime.test.ts:396-557`

- [ ] **Step 1: Write failing runtime tests**

Add tests that call a new runtime method directly and verify terminal persistence:

```ts
const result = await runtime.prepareAudioMessage({
  workspaceId: ids.workspace,
  messageId: ids.message
});

expect(result).toEqual({
  status: "completed",
  text: "Preciso de 42 chapas lisas.",
  media: { type: "audio", mimeType: "audio/ogg", source: "data_url" }
});
expect(prisma.message.update).toHaveBeenCalledWith({
  where: { workspaceId_id: { workspaceId: ids.workspace, id: ids.message } },
  data: {
    body: "Preciso de 42 chapas lisas.",
    mediaUrl: "data:audio/mpeg;base64,Y29udmVydGVkLW1wMw=="
  }
});
```

Add a failure test expecting `body: "Não foi possível transcrever este áudio."`, and add a delayed-run test whose message already contains a transcript and whose `audioTranscriberFactory` must not be called.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts
```

Expected: FAIL because `prepareAudioMessage` does not exist and the delayed run still retranscribes audio.

- [ ] **Step 3: Add terminal-state helpers and the preparation operation**

In `agent-runtime.ts`, export the stable terminal text and identify unprocessed bodies:

```ts
export const AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK =
  "Não foi possível transcrever este áudio.";

function isPendingAudioBody(body: string | null) {
  return !body || /^(Áudio recebido|Processando áudio\.\.\.)$/i.test(body.trim());
}
```

Inside `createAgentRuntime`, add an internal processor used by both public preparation and the delayed run:

```ts
async function prepareAudioMessageRecord(message: MessageRecord) {
  if (message.type !== "audio") {
    return { status: "skipped" as const };
  }
  if (message.body === AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK) {
    return { status: "failed" as const, errorCode: "TRANSCRIPTION_FAILED" };
  }
  if (!isPendingAudioBody(message.body)) {
    return { status: "completed" as const, text: message.body ?? "" };
  }

  try {
    const providerSettings = await resolveOpenAiCompatibleSettings(prisma, {
      workspaceId: message.workspaceId
    });
    if (!providerSettings.active) {
      throw Object.assign(new Error("Audio provider is unavailable."), {
        code: "TRANSCRIPTION_PROVIDER_UNAVAILABLE"
      });
    }
    const media = await (input.mediaResolver ?? resolveAgentMedia)({
      mediaUrl: message.mediaUrl,
      policy: AUDIO_MEDIA_POLICY
    });
    const transcriber = input.audioTranscriberFactory
      ? input.audioTranscriberFactory(providerSettings)
      : createOpenAiCompatibleAudioTranscriber(providerSettings);
    const transcription = await transcriber.transcribe({
      bytes: media.bytes,
      mimeType: media.mimeType
    });
    const updated = await prisma.message.update({
      where: {
        workspaceId_id: { workspaceId: message.workspaceId, id: message.id }
      },
      data: {
        body: transcription.text,
        ...(transcription.playback
          ? { mediaUrl: toAudioDataUrl(transcription.playback) }
          : {})
      }
    });
    input.realtime?.publish({
      type: "message.created",
      workspaceId: message.workspaceId,
      payload: toMessageDto(updated)
    });
    return {
      status: "completed" as const,
      text: transcription.text,
      media: { type: "audio" as const, mimeType: media.mimeType, source: media.source }
    };
  } catch (error) {
    const errorCode = readStableMediaErrorCode(error);
    const updated = await prisma.message.update({
      where: {
        workspaceId_id: { workspaceId: message.workspaceId, id: message.id }
      },
      data: { body: AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK }
    });
    input.realtime?.publish({
      type: "message.created",
      workspaceId: message.workspaceId,
      payload: toMessageDto(updated)
    });
    return { status: "failed" as const, errorCode };
  }
}
```

Expose a lookup wrapper on the returned runtime:

```ts
async prepareAudioMessage(input: { workspaceId: string; messageId: string }) {
  const message = await prisma.message.findFirst({
    where: { workspaceId: input.workspaceId, id: input.messageId }
  });
  return message
    ? prepareAudioMessageRecord(message)
    : { status: "skipped" as const };
},
```

Replace the duplicated audio block in `runForMessage` with `prepareAudioMessageRecord(message)`. A completed result sets `effectiveText` from the persisted transcript; a failed result sets `mediaFallback = AUDIO_PROCESSING_FALLBACK`. This makes the delayed run reuse terminal state and never retranscribe.

- [ ] **Step 4: Run the focused runtime tests and confirm GREEN**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts
```

Expected: all `agent-runtime.test.ts` tests pass, including immediate preparation, terminal failure, and no retranscription.

- [ ] **Step 5: Commit the runtime unit**

```bash
git add apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts
git commit -m "fix: prepare inbound audio before agent delay"
```

### Task 2: Invoke preparation at Evolution ingestion

**Files:**
- Modify: `apps/api/src/modules/evolution/evolution.routes.ts:24-41,707-723`
- Test: `apps/api/src/modules/evolution/evolution.routes.test.ts`

- [ ] **Step 1: Write failing webhook-order tests**

Extend the route's agent runtime contract with a mocked `prepareAudioMessage`. Post an inbound audio webhook and assert preparation happens before both automation and scheduling:

```ts
expect(prepareAudioMessage).toHaveBeenCalledWith({
  workspaceId: "workspace_a",
  messageId: "msg_1"
});
expect(prepareAudioMessage.mock.invocationCallOrder[0]).toBeLessThan(
  runForInboundMessage.mock.invocationCallOrder[0]
);
expect(prepareAudioMessage.mock.invocationCallOrder[0]).toBeLessThan(
  scheduleActiveSessionForMessage.mock.invocationCallOrder[0]
);
```

Add a text-webhook test asserting `prepareAudioMessage` is not called. The scheduling assertion remains unchanged, proving reply debounce is preserved.

- [ ] **Step 2: Run the focused route tests and confirm RED**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- evolution.routes.test.ts
```

Expected: FAIL because ingestion does not call audio preparation.

- [ ] **Step 3: Wire the preparation call before automation and scheduling**

Add the method to `EvolutionRoutesOptions["agentRuntime"]`, then insert:

```ts
if (message.direction === "inbound") {
  if (message.type === "audio") {
    await options.agentRuntime?.prepareAudioMessage({
      workspaceId,
      messageId: message.id
    }).catch((error: unknown) => {
      request.log.error({ error }, "Failed to prepare inbound audio.");
    });
  }

  await automationRunner.runForInboundMessage({
    workspaceId,
    messageId: message.id,
    eventKey: `message.received:${message.providerMessageId ?? message.id}`
  });
  // Existing scheduling remains after automation.
}
```

The runtime itself converts all expected processing failures into a terminal stored state. The route catch protects webhook ingestion only from unexpected programming or database errors.

- [ ] **Step 4: Run route and runtime tests and confirm GREEN**

Run:

```bash
pnpm --filter @prymeira-talk/api test -- evolution.routes.test.ts agent-runtime.test.ts audio-transcription.test.ts agent-reply-scheduler.test.ts
```

Expected: all focused suites pass.

- [ ] **Step 5: Commit ingestion wiring**

```bash
git add apps/api/src/modules/evolution/evolution.routes.ts apps/api/src/modules/evolution/evolution.routes.test.ts
git commit -m "fix: transcribe WhatsApp audio during ingestion"
```

### Task 3: Verify and deploy the exact hotfix

**Files:**
- No additional source files.

- [ ] **Step 1: Run complete API and workspace verification**

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: zero failing tests, zero type errors, successful API/web/shared builds, and no whitespace errors.

- [ ] **Step 2: Push the working branch and deployment branch**

```bash
git push origin codex/villefer-agent-hardening
git push origin HEAD:codex/prymeira-talk-foundation
```

- [ ] **Step 3: Wait for Docker images for the exact HEAD SHA**

```bash
HOTFIX_IMAGE_SHA=$(git rev-parse HEAD)
HOTFIX_RUN_ID=$(gh run list --workflow publish-images.yml \
  --branch codex/prymeira-talk-foundation --limit 10 \
  --json databaseId,headSha \
  --jq ".[] | select(.headSha == \"$HOTFIX_IMAGE_SHA\") | .databaseId" | head -1)
gh run watch "$HOTFIX_RUN_ID" --exit-status
```

Expected: both API and web image jobs complete successfully for the exact HEAD SHA. Only the API service needs updating if the web bundle is unchanged.

- [ ] **Step 4: Deploy the API image in Portainer**

Set the API service image to:

```text
ghcr.io/yohannreimer/prymeira-talk-api:$HOTFIX_IMAGE_SHA
```

Preserve all existing environment variables and service settings. Apply the container-image section only, then wait for the new task to show `running` and the old task to show `shutdown`.

- [ ] **Step 5: Verify production health and the original symptom**

```bash
curl -fsS https://talk.prymeiradigital.com.br/api/health
curl -fsS https://talk.prymeiradigital.com.br/api/ready
```

Expected: both return `{ "ok": true, "product": "talk" }`. Then send one disposable test audio: its card must leave `Processando áudio...` before the configured reply delay, show the transcript/player, and receive the agent reply only after the configured delay. Send a text immediately after a second audio and confirm that second audio still receives its transcript.
