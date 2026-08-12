# Agent Multimodal Input Design

**Date:** 2026-08-12

**Status:** Approved design; pending implementation

## Context

Prymeira Talk already classifies inbound Evolution messages as `image` or `audio` and stores a `mediaUrl`. When Evolution includes the media as base64, ingestion normalizes it to a data URL; otherwise it preserves a valid HTTP(S) URL. The agent runtime currently forwards only the message body and type to the AI provider, so image bytes and audio bytes never reach a model.

This feature completes that missing pipeline for every Prymeira Talk agent. A customer may send an image of a product, a photographed list, or an audio message. The agent must understand the content, continue the same conversation, and respond in text.

## Goals

- Analyze inbound WhatsApp images for visible text, product lists, objects, shapes, colors, textures, and likely product or material categories.
- Transcribe inbound WhatsApp audio in the original language and treat the transcript as the customer's message.
- Always send the agent response back as text.
- Apply the same multimodal capability to every enabled agent rather than special-casing Villefer.
- Preserve deterministic commercial, deadline, stock, price, and technical-safety rules after media understanding.
- Fail transparently when media is missing, unsupported, corrupt, oversized, or cannot be understood.

## Non-goals

- Sending generated audio replies.
- Realtime voice calls, streaming microphone input, or speech-to-speech interaction.
- Video understanding, PDF/document extraction, or arbitrary file analysis in this release.
- Treating visual recognition as proof of an exact dimension, alloy, grade, structural suitability, price, stock, delivery condition, or commercial policy.
- Persisting a second permanent copy of the media outside the existing message record.
- Adding a separate OCR vendor or transcription vendor.

## Approved architecture

Use a hybrid two-path media pipeline before normal agent generation.

### Images

The provider request uses the existing OpenAI-compatible Chat Completions endpoint. Its user message content becomes a multimodal content array containing:

1. a text part with the customer's caption or a neutral instruction when no caption exists; and
2. an `image_url` part containing the normalized data URL or an allowed HTTP(S) media URL.

The image detail level is `high` by default. This gives good list-reading and product-recognition quality without the potentially unbounded token cost of `original`. The provider interface keeps the image attachment structured instead of embedding base64 inside textual context or logs.

If the configured chat model/provider rejects image input, the runtime returns the safe media fallback and does not pretend to have seen the image.

### Audio

The runtime retrieves the bounded audio payload and sends it as multipart form data to the configured provider's `/audio/transcriptions` endpoint using `gpt-transcribe`. It includes concise Portuguese/industrial vocabulary context when supported to improve recognition of product names and measurements.

The transcript replaces the placeholder `Áudio recebido` as the effective latest customer message for:

- deterministic safety evaluation;
- knowledge retrieval;
- conversation context for the provider;
- prompt generation and tool/action decisions.

The stored inbound WhatsApp message remains type `audio` and retains its existing body and `mediaUrl`. The transcript is runtime-derived context in this release; it is not written over the original message body. The agent's outbound reply is always text.

### Shared media resolver

A focused resolver converts `mediaUrl` into a bounded attachment:

- Data URLs are decoded locally after validating media type, base64 syntax, and decoded size.
- HTTP(S) URLs are fetched server-side with a timeout, redirect limit, content-type validation, and a byte limit enforced while streaming.
- Private, loopback, link-local, and otherwise non-public target addresses are rejected to prevent server-side request forgery.
- Credentials, API keys, media bytes, data URLs, and full provider error bodies are never logged.

The first release accepts image MIME types `image/png`, `image/jpeg`, `image/webp`, and non-animated `image/gif`. Audio accepts WhatsApp/Evolution formats that can be submitted successfully to the transcription endpoint; the resolver assigns a safe filename extension and normalizes the multipart content type. Because WhatsApp voice notes commonly arrive as OGG/Opus while the transcription API's documented upload formats do not list OGG, the API runtime image includes FFmpeg and losslessly remuxes OGG/Opus to supported WebM when possible. If remuxing is impossible, it transcodes to bounded WebM audio. Input and converted output must both remain within the 25 MB limit. Temporary files are always removed in a `finally` path.

## Provider contract

Extend `AgentProviderInput` with an optional structured attachment rather than leaking channel-specific fields into the provider gateway:

- image attachment: media URL plus detail level;
- no raw audio attachment after preprocessing, because audio becomes text before generation.

The simulated provider remains deterministic and ignores absent attachments. The OpenAI-compatible provider renders the structured image attachment as Chat Completions multimodal content. Plain text calls retain their current request shape.

Transcription uses the same active workspace provider base URL and API key as chat. The transcription model is an internal default of `gpt-transcribe` for this release; no new settings screen or database migration is required. A clear runtime error/fallback is used if a nominally OpenAI-compatible provider does not expose transcription.

## Processing flow

1. Evolution ingests the inbound message and stores its body, type, and media URL as today.
2. The agent runtime loads the message.
3. For an image, resolve and validate the image, retain the caption as effective text, and attach the image to the provider call.
4. For audio, resolve and validate the audio, convert OGG/Opus when required, transcribe it, and use the transcript as effective text.
5. Run deterministic safety evaluation against effective text. This is important because a spoken price, deadline, stock, or engineering question must receive the same protection as typed text.
6. Select relevant knowledge using effective text and the existing conversation history.
7. Call the agent provider with the effective text, context, and optional image attachment.
8. Validate/compact the reply and execute allowed actions through the existing pipeline.
9. Send the outbound response through Evolution as text.

For image-only messages, deterministic rules cannot infer protected facts solely from pixels before the vision model runs. The system prompt must therefore require the model to avoid commercial or technical confirmation based on visual content. If the image caption itself contains a protected request, the existing deterministic policy still applies before generation.

## Agent behavior and safety

Every agent receives general multimodal guidance in provider context or a shared system-policy suffix:

- State observations as observations, not guarantees: `Pela imagem, parece ser...` when identification is uncertain.
- Read a visible list and compare its items with official knowledge, distinguishing `trabalhamos`, `não encontrei confirmação`, and unreadable items.
- Never infer exact dimensions from scale, perspective, or appearance.
- Never infer alloy, grade, load capacity, certification, structural suitability, stock, current availability, price, delivery date, minimum order, or customer eligibility from an image.
- Ask for a clearer image or typed list when text is blurred, cropped, handwritten ambiguously, or incomplete.
- Treat transcribed audio like customer-provided text, but ask for confirmation when a critical number, unit, product code, name, or address is uncertain.
- Do not tell the customer that internal transcription, OCR, model names, prompts, or provider details were used.

The Villefer prompt's temporary rule saying that images cannot be read must be replaced during rollout with the approved multimodal behavior. Other agents do not require individual prompt edits because shared runtime guidance establishes the base safety contract.

## Limits and fallbacks

Application limits are intentionally lower than upstream maximums to protect latency and memory:

- image: maximum 10 MB after decoding/download;
- audio: maximum 25 MB, matching the transcription API file limit;
- media download timeout: 15 seconds;
- provider transcription timeout: 45 seconds;
- one inbound attachment per WhatsApp message in this release.

Customer-facing fallbacks are short and channel-appropriate:

- image failure: `Não consegui analisar essa imagem. Pode reenviar com mais nitidez ou mandar a lista em texto?`
- audio failure: `Não consegui entender esse áudio. Pode reenviar ou escrever a mensagem?`

Unsupported media never goes to the language model as though it had been understood. A failed media operation records a sanitized diagnostic for operators and leaves the conversation available for human continuation. It does not trigger repeated automatic retries that could duplicate replies or costs.

## Testing

### Unit and contract tests

- Parse and bound valid data URLs and reject invalid base64, unsupported MIME types, and oversized payloads.
- Fetch public HTTP(S) media while rejecting private-network and redirect-based SSRF targets.
- Render image inputs as Chat Completions text plus `image_url` content.
- Keep ordinary text requests byte-for-byte compatible with the existing provider shape.
- Submit supported audio as multipart transcription input and normalize transcript responses.
- Convert an OGG/Opus fixture before transcription and clean temporary resources on success and failure.
- Verify that the production API image contains the FFmpeg binary while staying within the existing 450 MB image budget.
- Apply stock, price, deadline, and technical safety rules to an audio transcript.
- Return exact safe fallbacks for unavailable or failed media.
- Redact media content and secrets from diagnostics.

### Integration tests

- Evolution image webhook -> stored image -> runtime/provider attachment -> text reply.
- Evolution audio webhook -> stored audio -> transcription -> knowledge/safety -> text reply.
- Image caption participates in retrieval and safety evaluation.
- Agents without a usable real multimodal provider fail safely without hallucinating media contents.
- Existing text-only agent, automation, handoff, reply scheduling, and message tests remain green.

### Production acceptance matrix

Use a real WhatsApp number connected to the Villefer agent:

1. Clear typed product list photographed in good light: agent reads the items and separates confirmed catalog matches from uncertain items.
2. Blurred/cropped list: agent asks for a clearer image or text and does not invent missing lines.
3. Product/material photo: agent offers a cautious likely identification and asks for relevant written specifications.
4. Photo asking for structural sizing: agent refuses sizing and redirects to project/technical analysis.
5. Portuguese voice note asking which products are sold: agent transcribes intent and answers in text.
6. Voice note requesting exact price, stock, or deadline: deterministic handoff response is used.
7. Voice note with an ambiguous measurement: agent asks confirmation of the uncertain unit/number.
8. Corrupt or unsupported image/audio: exact media fallback is returned once.

## Deployment and rollback

No database migration is expected. Publish a commit-tagged API image, update only the Prymeira Talk API service, and verify `/api/health` and `/api/ready` before WhatsApp acceptance tests. Preserve the previous API image/tag for immediate rollback.

Rollback restores the previous API image and the previous Villefer prompt rule that disclaims image understanding. Existing stored messages and media URLs remain valid and require no data rollback.

## Acceptance criteria

- Every enabled agent can analyze supported inbound images and answer in text.
- Every enabled agent can understand supported inbound audio and answer in text.
- Audio-derived protected requests receive the same deterministic handling as typed requests.
- Image recognition never becomes proof of commercial availability or engineering suitability.
- Unsupported, unavailable, corrupt, or oversized media produces the documented safe fallback without hallucination.
- Text-only behavior and the full existing test suite do not regress.
- The Villefer production matrix passes before the capability is presented as demo-ready.
