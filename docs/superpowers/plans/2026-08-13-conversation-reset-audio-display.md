# Conversation Reset and Audio Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the temporary owner reset remove every note shown for the selected contact, and make newly received WhatsApp voice messages playable in Safari with their persisted transcript shown below the player.

**Architecture:** Keep reset behavior inside the existing conversations service, but scope note deletion to the selected conversation's contact. Extend the existing audio transcription unit to return both transcript text and optional MP3 playback bytes, then let the agent runtime update and republish the original inbound message before continuing its existing safety and reply flow. Keep display logic in focused inbox helpers so incompatible legacy OGG/Opus messages never mount Safari's failing native player.

**Tech Stack:** TypeScript, Fastify, Prisma, React, Vitest, FFmpeg, Docker Swarm/Portainer, Evolution API, OpenAI-compatible audio transcription.

---

## File map

- `apps/api/src/modules/conversations/conversations.service.ts`: resolve the selected contact and delete notes by contact scope during reset.
- `apps/api/src/modules/conversations/conversations.service.test.ts`: prove contact-wide deletion and an empty reset response.
- `apps/api/src/modules/agents/audio-transcription.ts`: convert OGG/Opus to MP3 and return transcript plus optional browser-playback bytes.
- `apps/api/src/modules/agents/audio-transcription.test.ts`: verify MP3 conversion, compatible passthrough, cleanup, and provider failure behavior.
- `apps/api/src/modules/agents/agent-runtime.ts`: persist transcript/playback URL or stable failure text on the original message and publish the same message ID.
- `apps/api/src/modules/agents/agent-runtime.test.ts`: prove database and realtime updates happen exactly once without duplicating agent replies.
- `apps/web/src/features/inbox/InboxPage.tsx`: avoid the incompatible native player and render processing, failure, and transcript labels.
- `apps/web/src/features/inbox/InboxPage.test.tsx`: verify audio presentation decisions without browser-specific media playback.
- `apps/web/src/styles.css`: style processing/fallback/transcript states consistently with message bubbles.

### Task 1: Reset notes by contact scope

**Files:**
- Modify: `apps/api/src/modules/conversations/conversations.service.test.ts`
- Modify: `apps/api/src/modules/conversations/conversations.service.ts`

- [ ] **Step 1: Write the failing reset regression test**

In `resets all selected conversation context while preserving its identity`, make `contactNote.findMany` return notes before deletion and an empty array when the reset response rebuilds context. Replace the conversation-scoped assertion with:

```ts
expect(prisma.contactNote.deleteMany).toHaveBeenCalledWith({
  where: { workspaceId: "workspace_a", contactId: "contact_1" }
});
expect(result.context.notes).toEqual([]);
```

- [ ] **Step 2: Run the focused test and verify failure**

```bash
pnpm --filter @prymeira-talk/api exec vitest run \
  src/modules/conversations/conversations.service.test.ts \
  -t "resets all selected conversation context"
```

Expected: FAIL because deletion still uses `conversationId`.

- [ ] **Step 3: Implement contact-scoped deletion**

Change the reset lookup and deletion to:

```ts
const existing = await prisma.conversation.findUnique({
  where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.conversationId } },
  select: { id: true, contactId: true }
});

await tx.contactNote.deleteMany({
  where: { workspaceId: input.workspaceId, contactId: existing.contactId }
});
```

Keep the contact itself and every other reset behavior unchanged.

- [ ] **Step 4: Run the conversation suite**

```bash
pnpm --filter @prymeira-talk/api exec vitest run \
  src/modules/conversations/conversations.service.test.ts
```

Expected: all conversation tests PASS, including owner authorization.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/conversations/conversations.service.ts \
  apps/api/src/modules/conversations/conversations.service.test.ts
git commit -m "fix: clear displayed notes on conversation reset"
```

### Task 2: Produce browser-compatible audio and transcript data

**Files:**
- Modify: `apps/api/src/modules/agents/audio-transcription.test.ts`
- Modify: `apps/api/src/modules/agents/audio-transcription.ts`

- [ ] **Step 1: Write failing result-shape and MP3 tests**

Change the direct-audio expectation to:

```ts
await expect(transcriber.transcribe({
  bytes: Buffer.from("webm-audio"),
  mimeType: "audio/webm"
})).resolves.toEqual({
  text: "Preciso de dez chapas de três milímetros.",
  playback: null
});
```

Change the OGG test so its process stub writes `converted-mp3`, then assert:

```ts
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
```

Keep the existing temporary-directory cleanup assertion and failure tests.

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm --filter @prymeira-talk/api exec vitest run \
  src/modules/agents/audio-transcription.test.ts
```

Expected: FAIL because the method returns a string and creates WebM.

- [ ] **Step 3: Define the new contract**

```ts
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
```

Direct compatible types return internal `playback: null`.

- [ ] **Step 4: Convert OGG/Opus to MP3**

Replace the OGG output path and FFmpeg call with:

```ts
const outputPath = join(directory, "output.mp3");
await input.runProcess(input.ffmpegPath, [
  "-v", "error", "-y", "-i", sourcePath,
  "-vn", "-c:a", "libmp3lame", "-b:a", "64k", outputPath
]);
const bytes = await readFile(outputPath);
assertAudioSize(bytes);
return {
  bytes,
  mimeType: "audio/mpeg",
  extension: "mp3",
  playback: { bytes, mimeType: "audio/mpeg" as const },
  cleanup: () => rm(directory, { recursive: true, force: true })
};
```

On conversion failure, throw `AUDIO_CONVERSION_FAILED`; retain the outer cleanup catch.

- [ ] **Step 5: Return text and playback**

At transcription success return:

```ts
return { text: text.trim(), playback: normalized.playback };
```

The existing `finally` must still call `normalized.cleanup()`.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @prymeira-talk/api exec vitest run \
  src/modules/agents/audio-transcription.test.ts
```

Expected: all audio transcription tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/agents/audio-transcription.ts \
  apps/api/src/modules/agents/audio-transcription.test.ts
git commit -m "feat: prepare WhatsApp audio for browser playback"
```

### Task 3: Persist and republish audio processing state

**Files:**
- Modify: `apps/api/src/modules/agents/agent-runtime.test.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`

- [ ] **Step 1: Extend the runtime mock**

Add this `message.update` mock in `buildPrisma`:

```ts
update: overrides.message?.update ?? vi.fn().mockImplementation(
  async (args: { data: Partial<typeof baseMessage> }) => ({
    ...baseMessage,
    ...args.data
  })
),
```

- [ ] **Step 2: Write failing success and failure tests**

Make successful transcription return:

```ts
{
  text: "Tem exatamente 30 chapas em estoque hoje?",
  playback: {
    bytes: Buffer.from("converted-mp3"),
    mimeType: "audio/mpeg"
  }
}
```

Pass `realtime: { publish }` and assert:

```ts
expect(prisma.message.update).toHaveBeenCalledWith({
  where: { workspaceId_id: { workspaceId: ids.workspace, id: ids.message } },
  data: {
    body: "Tem exatamente 30 chapas em estoque hoje?",
    mediaUrl: "data:audio/mpeg;base64,Y29udmVydGVkLW1wMw=="
  }
});
expect(publish).toHaveBeenCalledWith(expect.objectContaining({
  type: "message.created",
  payload: expect.objectContaining({ id: ids.message })
}));
```

For transcription failure, assert update data is:

```ts
{ body: "Não foi possível transcrever este áudio." }
```

and verify the existing customer fallback reply is created only once.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
pnpm --filter @prymeira-talk/api exec vitest run \
  src/modules/agents/agent-runtime.test.ts -t "audio"
```

Expected: FAIL because inbound messages are not updated.

- [ ] **Step 4: Add runtime message update capability**

Extend `AgentRuntimePrismaLike.message` with:

```ts
update(args: unknown): Promise<MessageRecord>;
```

Add:

```ts
const AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK =
  "Não foi possível transcrever este áudio.";

function toAudioDataUrl(playback: { bytes: Buffer; mimeType: string }) {
  return `data:${playback.mimeType};base64,${playback.bytes.toString("base64")}`;
}
```

- [ ] **Step 5: Persist and publish success**

After transcription:

```ts
effectiveText = transcription.text;
const updatedAudioMessage = await prisma.message.update({
  where: { workspaceId_id: { workspaceId: runInput.workspaceId, id: message.id } },
  data: {
    body: transcription.text,
    ...(transcription.playback
      ? { mediaUrl: toAudioDataUrl(transcription.playback) }
      : {})
  }
});
input.realtime?.publish({
  type: "message.created",
  workspaceId: runInput.workspaceId,
  payload: toMessageDto(updatedAudioMessage)
});
```

Keep `effectiveText` free from presentation prefixes.

- [ ] **Step 6: Persist and publish failure**

In the audio catch:

```ts
const failedAudioMessage = await prisma.message.update({
  where: { workspaceId_id: { workspaceId: runInput.workspaceId, id: message.id } },
  data: { body: AUDIO_TRANSCRIPTION_DISPLAY_FALLBACK }
});
input.realtime?.publish({
  type: "message.created",
  workspaceId: runInput.workspaceId,
  payload: toMessageDto(failedAudioMessage)
});
```

Preserve `AUDIO_PROCESSING_FALLBACK` as the single customer reply and do not call the chat provider.

- [ ] **Step 7: Run runtime and media tests**

```bash
pnpm --filter @prymeira-talk/api exec vitest run \
  src/modules/agents/agent-runtime.test.ts \
  src/modules/agents/audio-transcription.test.ts \
  src/modules/agents/agent-media-resolver.test.ts
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/agents/agent-runtime.ts \
  apps/api/src/modules/agents/agent-runtime.test.ts
git commit -m "feat: persist WhatsApp audio transcripts"
```

### Task 4: Render safe audio states in the inbox

**Files:**
- Modify: `apps/web/src/features/inbox/InboxPage.test.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing helper tests**

```ts
expect(isBrowserPlayableAudio({
  type: "audio", mediaUrl: "data:audio/ogg;base64,YQ=="
})).toBe(false);
expect(isBrowserPlayableAudio({
  type: "audio", mediaUrl: "data:audio/mpeg;base64,YQ=="
})).toBe(true);
expect(audioMessageDisplayText({ type: "audio", body: "Áudio recebido" }))
  .toEqual({ kind: "processing", text: "Processando áudio..." });
expect(audioMessageDisplayText({ type: "audio", body: "Preciso de 42 chapas." }))
  .toEqual({ kind: "transcript", text: "Texto do áudio: Preciso de 42 chapas." });
expect(audioMessageDisplayText({
  type: "audio", body: "Não foi possível transcrever este áudio."
})).toEqual({ kind: "error", text: "Não foi possível transcrever este áudio." });
```

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm --filter @prymeira-talk/web exec vitest run \
  src/features/inbox/InboxPage.test.tsx
```

Expected: FAIL because helpers are absent.

- [ ] **Step 3: Add audio display helpers**

```ts
const audioTranscriptFailure = "Não foi possível transcrever este áudio.";

export function isBrowserPlayableAudio(
  message: Pick<MessageDto, "mediaUrl" | "type">
) {
  if (message.type !== "audio" || !message.mediaUrl) return false;
  return !/^data:audio\/(ogg|opus)(?:[;,])/i.test(message.mediaUrl);
}

export function audioMessageDisplayText(
  message: Pick<MessageDto, "body" | "type">
) {
  const body = message.body?.trim() ?? "";
  if (body === audioTranscriptFailure) return { kind: "error" as const, text: body };
  if (!body || body === "Áudio recebido") {
    return { kind: "processing" as const, text: "Processando áudio..." };
  }
  return { kind: "transcript" as const, text: `Texto do áudio: ${body}` };
}
```

- [ ] **Step 4: Avoid the incompatible native player**

Only render `<audio controls>` when `isBrowserPlayableAudio(message)` is true. Otherwise render:

```tsx
<div className="message-audio-preview is-processing">
  <a className="message-media-fallback" href={message.mediaUrl}
    rel="noreferrer" target="_blank">
    <Download size={14} aria-hidden="true" />
    Abrir áudio original
  </a>
</div>
```

- [ ] **Step 5: Render text below the player**

```tsx
{message.type === "audio" ? (
  <p className={`message-audio-text is-${audioMessageDisplayText(message).kind}`}>
    {audioMessageDisplayText(message).text}
  </p>
) : message.body || !message.mediaUrl ? (
  <p>{messageDisplayText(message)}</p>
) : null}
```

- [ ] **Step 6: Style states**

```css
.message-audio-preview.is-processing {
  min-height: 34px;
  align-content: center;
}
.message-audio-text { margin-top: 8px !important; }
.message-audio-text.is-processing,
.message-audio-text.is-error {
  opacity: 0.72;
  font-size: 12px;
}
```

- [ ] **Step 7: Verify web**

```bash
pnpm --filter @prymeira-talk/web exec vitest run \
  src/features/inbox/InboxPage.test.tsx
pnpm --filter @prymeira-talk/web typecheck
```

Expected: tests and typecheck PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/features/inbox/InboxPage.tsx \
  apps/web/src/features/inbox/InboxPage.test.tsx apps/web/src/styles.css
git commit -m "fix: display playable audio with transcript"
```

### Task 5: Full verification and rollout

**Files:**
- Verify only; no planned source modifications.

- [ ] **Step 1: Run full verification**

```bash
pnpm test && pnpm typecheck && pnpm build && git diff --check
```

Expected: all tests, typechecks, and builds PASS; diff check is silent.

- [ ] **Step 2: Record release identity**

```bash
git status --short
git rev-parse HEAD
```

Expected: clean worktree; record the full SHA.

- [ ] **Step 3: Push and publish**

```bash
git push origin codex/villefer-agent-hardening
git push origin HEAD:codex/prymeira-talk-foundation
gh run list --workflow publish-images.yml \
  --branch codex/prymeira-talk-foundation --limit 3
gh run watch <RUN_ID_FOR_RELEASE_SHA> --exit-status
```

Expected: API and web image jobs succeed for the exact release SHA.

- [ ] **Step 4: Deploy through Portainer**

Update only:

```text
prymeiratalk_prymeira_talk_api -> ghcr.io/yohannreimer/prymeira-talk-api:<RELEASE_SHA>
prymeiratalk_prymeira_talk_web -> ghcr.io/yohannreimer/prymeira-talk-web:<RELEASE_SHA>
```

Preserve environment, network, mount, placement, and replica settings. Expected: one running replica each.

- [ ] **Step 5: Verify health**

```bash
curl --fail --silent --show-error https://talk.prymeiradigital.com.br/api/health
curl --fail --silent --show-error https://talk.prymeiradigital.com.br/api/ready
```

Expected from both: `{"ok":true,"product":"talk"}`.

- [ ] **Step 6: Verify production safely**

Without resetting real data, confirm old OGG/Opus messages no longer render the native `Erro` player and the owner reset remains visible.

- [ ] **Step 7: Run the authorized demo smoke test**

Only after the user explicitly selects and confirms the disposable test conversation: reset it, confirm notes/tags disappear, send one fresh voice message with product/dimension/quantity, observe `Processando áudio...`, then confirm playable audio, `Texto do áudio:`, and one agent reply using that transcript.

---

## Plan self-review

- Spec coverage: contact-wide notes, MP3 conversion, transcript persistence, realtime refresh, Safari fallback, cleanup, regression tests, deployment, and acceptance are mapped to tasks.
- Placeholder scan: angle-bracket release values are operational identifiers resolved from the actual commit/workflow, not missing code.
- Type consistency: `AgentAudioTranscriptionResult.playback` is nullable, checked before serialization, and emitted as `audio/mpeg`, which the UI classifies as playable.
