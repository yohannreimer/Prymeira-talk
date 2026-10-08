# GlitchTip → Dot Xing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver sanitized Talk error alerts to an authenticated Dot subscription.

**Architecture:** Extend fixed GlitchTip 6.1.8 in its existing ASGI process and
OAuth authority. Native project alert webhook enters a bounded durable outbox;
MCP Events verifies and delivers to the actual callback supplied by the Dot.

**Tech Stack:** Python 3.14, Django/GlitchTip, ASGI, aiohttp, cryptography, SQLite,
Standard Webhooks HMAC and MCP 2.0.

---

### Task 1: Implement and review the bounded event extension

Files: `infra/glitchtip-xing/xing_alerts/{privacy,outbox,delivery,mcp_server,asgi}.py`,
`infra/glitchtip-xing/tests/`, `infra/glitchtip-xing/Dockerfile` and `README.md`.

- [ ] Test-first privacy reconstruction, own-project filtering and envelope limits.
  Tests must inject customer text/phone/token into every ignored webhook field;
  none may appear in normalized JSON or logs. Only approved point/code enums,
  service and hexadecimal release survive.
- [ ] Implement encrypted subscription state and bounded persistent outbox.
  Validate duplicate receipt, stable retry event IDs, finite expiry, unsubscribe,
  restart persistence, retention and limits with temporary SQLite files.
- [ ] Implement Standard Webhooks signing and callback verification.
  Independently recompute HMAC in tests, reject bad challenge, all non-public DNS
  answers and redirects; verify connection uses pinned public addresses and TLS
  hostname. Test bounded retries and permanent 410/413.
- [ ] Implement authenticated MCP 2.0 dispatch and GlitchTip OAuth integration.
  Each RPC validates token/resource/scope, active user and project access.
  Expose only delivery status tool; no native all-project or mutation tools.
  Test subscribe/refresh/unsubscribe/rotation and revoked access on delivery.
- [ ] Package fixed-version GlitchTip extension preserving existing ASGI lifespan
  and embedded worker, startup and static handling. Default extension disabled.
- [ ] Run `python3 -m unittest discover -s infra/glitchtip-xing/tests -v`;
  install only official-registry dependencies in an isolated venv when needed.
- [ ] Review spec compliance, then security/code quality; repair all findings.

### Task 2: Build, stage and validate

- [ ] Build image locally or existing image CI without changing Talk image tags.
- [ ] Test installed fixed-version integration with disposable PostgreSQL and
  dummy credentials, including ingest, OAuth consent and all-in-one startup.
- [ ] Prepare exact stack changes preserving secrets, volumes and resource limits;
  add extension state volume and secret, only one replica. Review access expansion
  before applying the production OAuth connection.
- [ ] Configure native Talk project alert, webhook recipient and permitted tags.
  Compare rule with installed 6.1.8 behavior; do not mutate historical issues.
- [ ] Connect plugin through authenticated OAuth; authorize actual Dot subscription.
- [ ] Deliver clearly labeled synthetic test and observe both callback acceptance
  and visible Dot notification. Measure CPU before/after and explain limits.
- [ ] Save factual task report locally; no shared-brain publication without
  authorization. Record real completed/pending steps, never claim delivery from
  an HTTP acceptance alone.
