# Meta Evolution Multi-Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support multiple official Meta numbers via Evolution as separate channels, with campaign and inbox behavior wired to those channels.

**Architecture:** Reuse existing `Channel` records. Settings continues to provide Evolution credentials, while each `meta_cloud` channel provides the instance name. Campaign send, template list, webhook ingest, and inbox replies all resolve through the selected/matched channel.

**Tech Stack:** Fastify, Prisma, React, TypeScript, Vitest.

---

### Task 1: Webhook Ingestion

- [x] Add a failing test for Evolution `messages.upsert` matching a `meta_cloud` channel.
- [x] Update webhook ingestion to fallback from `evolution` channel lookup to `meta_cloud`.
- [x] Set the Meta customer service window for inbound official-channel messages.
- [x] Re-run `evolution.routes.test.ts`.

### Task 2: Campaign Conversation Creation

- [x] Add a failing test that Meta template campaign sends create contact/conversation/message records.
- [x] Create or find contacts by normalized phone.
- [x] Upsert the channel/contact conversation.
- [x] Create outbound template messages only after provider send succeeds.
- [x] Re-run `campaigns.service.test.ts`.

### Task 3: Selected Channel Sending

- [x] Add `channelId` to Meta template campaign send input.
- [x] Resolve selected connected `meta_cloud` channel and send through its provider key.
- [x] Add `channelId` to the HTTP route and web API client.
- [x] Re-run focused campaign tests.

### Task 4: Inbox Replies

- [x] Add a failing test for Meta via Evolution text replies from Atendimento.
- [x] Pass the Evolution official client from the route runtime to the conversation service.
- [x] Send Meta via Evolution text replies with the channel provider key as instance name.
- [x] Re-run `conversations.service.test.ts`.

### Task 5: Campaign UI

- [x] Load connected channels in the Campaigns page.
- [x] Show `Enviar pelo canal` in the Meta Cloud section.
- [x] Use the selected channel for Evolution template loading and sending.
- [x] Smoke test localhost.
