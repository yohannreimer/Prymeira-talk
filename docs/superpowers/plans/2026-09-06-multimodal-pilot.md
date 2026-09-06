# Multimodal pilot corrections implementation plan

> **For agentic workers:** Use subagent-driven-development for the bounded media implementation; root handles the test interface and evidence. The user has explicitly approved execution without another technical-plan approval round.

**Goal:** Receive and test PDF, images and audio with inspectable extracted content and seller notes, preserving an inactive test agent until the supervised phone pilot.

**Architecture:** Reuse the existing safe media resolver and audio transcriber. Add bounded PDF extraction and image reading, shared by runtime and simulator, with explicit failure replies instead of invented content. Client uploads are conversation data, never reusable knowledge or policy. Test messages retain extracted text for subsequent turns; test results expose proposed actions without executing them.

**Tech stack:** TypeScript, Fastify, existing pdf-parse, React/Vite, Vitest, existing OpenAI-compatible provider, ffmpeg.

## 1. Shared inbound media and backend test contract

Files: agent-media-resolver.ts, new inbound-media.ts and tests, agent-runtime.ts/tests, agent-test-chat.ts/tests, agents.routes.ts/tests as available.

- [ ] Reproduce unsupported document path and text-only test schema with failing tests.
- [ ] Accept one test attachment `{fileName,mimeType,base64Content}` separately from the message history. Bound size and accepted types; never accept arbitrary test URLs.
- [ ] Prepare PDF text, scanned PDF/image visual transcription, and audio transcription using shared helpers. Keep line breaks, units and uncertain text. Refuse corrupt, oversized or unsupported media safely.
- [ ] Preserve media content for later turns and expose `processedMessage`, media diagnostics and proposed actions in the simulator without executing them.
- [ ] Run media/runtime/test service unit tests and typecheck, commit only owned backend files.

## 2. Test interface and evidence

Files: apps/web/src/app/api.ts; apps/web/src/features/assistant/AgentsPage.tsx/tests.

- [ ] Add file selector restricted to PDF, PNG/JPEG/WEBP, MP3/M4A/WAV/OGG/WEBM. Permit attachment without typed caption, enforce size before upload, preserve failed-upload state, reset all file state on agent switch.
- [ ] Send attachment separately; retain backend processed content in later requests. Display original filename, extracted content and proposed note/actions with explicit simulation labels.
- [ ] Test controls/rendering and compile web.

## 3. Qualification and regression evidence

- [ ] Inspect output actions and recovered source before any further prompt edits. Address N01/N09/N11/N13/N16/M02/M03 and H01/H04 based on actual traces, not guessed summaries.
- [ ] Prepare controlled fixtures with expected exact quantities, fractions, corrections and ambiguity. Keep original historical reports unchanged.
- [ ] Run files through the real provider in the inactive test agent, compare extracted content AND final seller briefing.
- [ ] Rerun text failures and safety controls, including contradictory/illegible inputs and document instructions.

## 4. Release and pilot gate

- [ ] Independent specification review then quality review; fix important findings.
- [ ] Run API/web tests, typecheck, production builds, inspect git diff.
- [ ] Publish image SHA via existing release branch and update exact API/web services in Portainer; verify running tasks and health.
- [ ] Verify files in deployed simulator. Report tested formats, observed extraction, proposed handoff evidence and remaining limits separately from actual WhatsApp transport.
- [x] User will choose/link the phone channel and seller themselves ("isso deixa cmg"); leave the test agent inactive and do not send to real customer histories.

## Implementation evidence so far

- Backend shared media implementation committed as `be1724e`; exact runtime PDF type is `file`.
- Specification review found/fixed mapped-IPv6 resolver bypass, enriched-history overflow and simulator retained-attachment availability. Independent recheck passed.
- Quality review found/fixed runtime document follow-up parity and stale response after agent import. PDF allocation preflight is being completed separately.
- Root added visible literal extraction and proposed seller notes, request-generation isolation, 16MiB proxy upload ceiling/180s read timeout, and package-only contextual handoff wording (legacy/manual agents keep acknowledgement).
- Test agent only: rendered prompt 7,938 chars, FNV `9ff4619e`, persisted and still inactive. Package metadata corrected for future imports; existing stored qualification metadata is deliberately not injected into the model because live metadata is older.
- Controlled synthetic fixtures: text PDF (1.2MB to cross old proxy limit), 2-page PDF, scanned PDF, PNG, MP3, OGG, 6-page refusal, document instructions. These are not historical client attachments.
- Fresh pre-resource-preflight checkpoint: API 678 tests, web 99 tests, typechecks and production builds passed. Final rerun and live-provider evidence still required.
