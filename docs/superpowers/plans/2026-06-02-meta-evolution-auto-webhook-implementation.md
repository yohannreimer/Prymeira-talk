# Meta Evolution Auto Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically configure Evolution webhooks when a Meta official via Evolution channel is created.

**Architecture:** The route resolves the workspace Meta runtime, and the channel service receives an optional webhook setup dependency. The service creates the channel first, configures Evolution, and marks the channel failed if Evolution rejects the webhook.

**Tech Stack:** Fastify, TypeScript, Vitest, React.

---

### Task 1: Channel Service

- [x] Add failing tests for Meta Cloud webhook setup success and failure.
- [x] Add optional `metaEvolutionWebhook` dependency to the channel service.
- [x] Call `setWebhook` for `meta_cloud` channel creation when dependency is present.
- [x] Mark the channel `failed` if webhook setup fails.

### Task 2: Channel Route

- [x] Resolve Meta runtime for `meta_cloud` channel creation.
- [x] Pass Evolution webhook setup dependency only for active `evolution_official` mode.
- [x] Add route coverage verifying the Evolution `/webhook/set/{instance}` call.

### Task 3: UI Notice

- [x] Show a success notice when the channel and webhook are configured.
- [x] Show a warning notice when the channel exists but webhook setup failed.
