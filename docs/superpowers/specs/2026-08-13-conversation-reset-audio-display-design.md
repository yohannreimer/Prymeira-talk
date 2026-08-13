# Conversation Reset and Audio Display Design

**Date:** 2026-08-13

**Status:** Approved in conversation; awaiting review of this written specification.

## Evidence and root causes

The contact panel loads internal notes by `workspaceId` and `contactId`, including notes created in earlier conversations. The temporary reset deletes notes only by `workspaceId` and the selected `conversationId`. The reset therefore succeeds but the same contact-level history remains visible.

Evolution stores WhatsApp voice messages as their original OGG/Opus data URL. Safari can show a native player error for that source. The agent runtime transcribes the audio into a temporary `effectiveText`, uses the text for generation, and then discards it instead of updating the inbound message. The UI consequently shows `Áudio recebido` rather than the transcript.

## Approved behavior

### Reset

When the workspace owner confirms `Reiniciar conversa`, delete every internal note displayed for that contact in the current workspace, including contact-level notes and notes attached to prior conversation records. Preserve the contact, phone number, channel, and agent configuration. Keep the existing permanent-deletion confirmation and audit event.

### Audio

For inbound WhatsApp audio:

1. Keep the original message immediately visible.
2. Do not render a native OGG/Opus player that Safari will display as `Erro`; show `Processando áudio...` while compatibility processing is pending.
3. Convert OGG/Opus sources to MP3 with the FFmpeg binary already installed in the API image.
4. Transcribe the browser-compatible audio with the configured transcription provider.
5. Persist the MP3 data URL and transcript on the same inbound message.
6. Publish the refreshed message through the existing realtime upsert path so the selected conversation updates without a reload.
7. Render a normal clickable audio player followed by `Texto do áudio: <transcrição>`.

MP3, MP4/M4A, and WAV sources that are already browser-compatible do not need conversion. The 25 MB input limit and the existing transcription timeout remain in force.

If compatibility conversion or transcription fails, the UI must not show the browser's `Erro` bar. It shows a stable fallback link for the original audio and `Não foi possível transcrever este áudio.` The failure must not prevent message ingestion or duplicate an automated reply.

## Implementation boundaries

- Extend the existing audio normalization/transcription path; do not introduce a separate media service.
- Update the existing message record rather than creating a second transcript message.
- Reuse `message.created` with the same message ID because the inbox already upserts repeated IDs.
- Do not expose provider errors, credentials, temporary file paths, or raw transcription diagnostics to the browser.
- Clean up every temporary conversion directory on success and failure.
- Existing stored audio is not destructively migrated. The corrected path applies to newly received audio used in the demo; the UI fallback removes the visible native error from older incompatible messages.

## Verification

Automated tests must cover:

- reset deletes notes by contact scope and not only conversation scope;
- reset response returns an empty notes list for that contact;
- OGG/Opus conversion produces an MP3 source and cleans temporary files;
- compatible audio avoids unnecessary conversion;
- successful transcription updates message body and media URL;
- realtime republishes the same message ID with transcript and MP3;
- Safari-incompatible sources render processing/fallback UI instead of the native error player;
- successful messages render `Texto do áudio:` below the clickable player;
- conversion/transcription failures retain a stable, non-sensitive fallback;
- existing conversation, agent, media, safety, timing, and loop-guard tests continue passing.

Production acceptance uses a freshly reset test conversation and a new WhatsApp voice message. Pass criteria: notes are gone immediately after reset; no `Erro` bar appears; the audio is playable; the transcript appears below it; and the agent receives the same transcript for its response.

## Rollout and rollback

Publish API and web images under one commit tag, update only the Prymeira Talk API and web services, confirm one running replica for each, and verify `/api/health` and `/api/ready`. Do not delete production conversation data during validation. If audio ingestion or playback regresses, restore the previous API and web images; existing messages remain intact.
