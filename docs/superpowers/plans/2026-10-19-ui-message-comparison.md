# Isolated message visibility comparison

> Execution stays in the current conversation, without delegation, as explicitly requested by the user. This is diagnostic tooling, with no production rollout.

**Goal:** Compare synthetic webhook offer to actual visible message bubble in Chromium, using the current deployed per-role revisions and a candidate preserving the currently deployed API features.

**Architecture:** A single Linux amd64 CI job runs serial paired slots against an owned disposable PostgreSQL database and RabbitMQ vhost. Production API, ingress, worker and web builds run with the observed CPU/memory limits. Real API queries, durable effects and PostgreSQL realtime bridge feed the real frontend. Only external identity/provider boundaries use synthetic loopback fixtures.

**Stack:** Existing pnpm/Vitest/Prisma and Docker harness; native Python Playwright browser observer. The with_server helper was inspected via --help; custom lifecycle management is necessary for per-role immutable images and database migrations between slots.

## Fixed comparison

A: ingress 99f65ed, worker 51b1fdd, API c9d49c8, web 1d7aa19. N: messaging fixes composed with current API c9d49c8 (merge f2ff103), web rebuilt from N as well (apps/web unchanged; the additive contextual-followup export in packages/shared must also pass the actual frontend build).
API rate limit: 300 requests per minute, observed in the live service; the earlier 3000/min control is retained separately and is not the final matched configuration.

Limits: ingress 0.5 CPU/512 MiB; worker 0.75 CPU/768 MiB; API 2 CPU/2048 MiB; web 1 CPU/1024 MiB. These quotas do not reproduce physical 2-CPU VPS contention from unrelated services.

- [ ] Record allowlisted live metadata and immutable source/image fingerprints; never copy credentials or customer content.
- [ ] Typecheck and targeted safety/contextual-followup tests after composition; reject unresolved merges.
- [ ] Add a browser observer: rendered DOM reconnaissance before actions, active synthetic chat, MutationObserver plus two animation frames, clipping/visibility checks, unique markers, WS observations, screenshots and browser errors. Do not force scroll or reload during measurement. Timestamp uncertainty is measured against a loopback clock endpoint.
- [ ] Add actual compiled ingress/worker/API/web lifecycle; production NODE_ENV and API auth plugin enabled, external Hub replaced by owned synthetic access fixture. Abort external browser requests. Providers are loopback fixtures; no messages are sent to WhatsApp.
- [ ] Seed equal datasets: 20 synthetic conversations, 100 prior messages each, redundant Evolution/WAHA on one synthetic number, background aliases. No real pending state.
- [ ] Before offers, assert two compiled-provider receipts applied to one ready identity with exact body/association; validate generated GOWS native Message + Info against source contract. Malformed earlier controls are not normal-traffic qualification.
- [ ] First run a small pilot to validate rendered UI, actual websocket updates, and observation coverage. Preserve pilot failures; do not treat them as product performance results.
- [ ] Verify equal initial viewport at latest warmup message before offers. Initial wheel is setup only; no forced scroll during measurement. Preserve 009017c/07 as a history-reading observation (all 60 targets persisted, WS and DOM; scrollTop=0), not comparable hot-viewport latency. Repeat the full busy A,N,N,A cohort on one fresh runner, retaining all results.
- [ ] Freeze profiles before paired runs: sustained 1 unique message/s for 60 seconds, busy 4/s for 60 seconds; two provider envelopes per identity (WAHA copy delayed by a deterministic assumed 40–159 ms), 25% addressed to the open chat, deterministic short/long Unicode text mix. These are plausible test profiles, not a measured production traffic distribution. Recovery stays enabled against empty synthetic history. Execute each profile A,N,N,A with fresh DB/broker namespace per slot.
- [ ] Preserve offer timestamps/statuses, durable/apply oracles, RT effect state, WS/DOM/viewport timestamps, missing/duplicates, resource samples and screenshots. Report p50/p95/max only alongside denominators and misses; no silent exclusion of rejected offers.
- [ ] Download and inspect actual screenshots; analyze paired results and separate server latency from browser latency. Verify checksums and deliver local evidence/report. No deploy proposal until evidence is reviewed.

Limitations to state: source reconstruction is not original complete OCI/OS identity; loopback is not internet/mobile performance; text-only traffic and disabled AI/campaign actions do not qualify those workloads; two short repetitions do not characterize long-term tail behavior or certify complete delivery integrity.
