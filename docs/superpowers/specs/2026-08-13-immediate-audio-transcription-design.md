# Immediate Audio Transcription Hotfix

## Problem

Incoming WhatsApp audio currently remains as `Processando áudio...` until the configured agent reply delay expires. The pending-reply scheduler stores only the latest inbound message, so a later message can replace the audio before it is transcribed. The audio then never reaches the agent as text.

## Decision

Transcription is ingestion work and must not depend on reply timing. When an inbound audio message is persisted, the API will immediately resolve and transcribe it, persist the transcript and browser-playable MP3 on the same message, and publish the updated message through realtime. The configured wait continues to control only when the agent composes and sends its reply.

## Data Flow

1. Evolution webhook persists the inbound audio message.
2. An audio-processing service resolves the media, converts OGG/Opus to MP3 when needed, and transcribes it.
3. The service updates the same message with the transcript and playable media URL, then republishes the message.
4. The existing pending-reply scheduler still debounces customer messages.
5. When the scheduler runs, the agent uses the stored transcript. It must not transcribe the same audio again.

If another customer message arrives during the wait, conversation history still contains the audio transcript, while the latest message remains the reply trigger.

## Failure Handling

If media resolution or transcription fails, the same audio message receives the stable display text `Não foi possível transcrever este áudio.`. The scheduled agent run recognizes this failure and sends the existing customer fallback without calling the chat provider. Processing must always leave the visible pending state.

## Scope

- Keep the configurable reply delay unchanged.
- Keep the existing audio player and transcript UI unchanged.
- Do not change agent prompts, automation-loop rules, or conversation reset behavior.
- Do not process historical audio automatically.

## Verification

- Regression test: audio is processed during webhook ingestion before the reply delay.
- Regression test: a following text message does not prevent the audio transcript from being stored.
- Regression test: the agent reuses a stored transcript without retranscribing.
- Regression test: a transcription failure leaves a terminal display state and produces the customer fallback.
- Run API tests, typecheck, build, publish the exact commit SHA, deploy API, and verify production health.
