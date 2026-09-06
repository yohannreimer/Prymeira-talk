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

## 16h checkpoint (2026-09-06, São Paulo)

- Release `40b01c39a43eeb56da576938a1d757225c28d3cb`: 715 API tests passed; API typecheck/build and web production build passed. Web previously passed 100 tests on the same frontend change. Independent quality re-review reported no P1/P2.
- API and web image build workflow `34053304577` succeeded; exact Portainer services updated and running. Public health and readiness returned `ok: true` after cutover.
- First real-provider file run on `4e5a4fc` read native PDF >1MiB, scan PDF, PNG and OGG, but repeated supplied information in three responses. Baseline saved separately in analysis `outputs/real-battery/media-baseline.json`.
- Added an explicit per-agent careful-reply setting; all existing agents default to `none`. Only the inactive Villefer test agent opted into `low`, saved and verified in the UI. Active Villefer configuration was not edited. Truncated provider completions now fail before customer-facing parsing.
- Paired native/scan PDF replay with the same prompt and inputs now proposed complete notes and handoff without redundant city questions. Remaining media and text regression replay is ongoing; this is not a production accuracy claim.
- Evolution provisioning already requests base64 webhooks. Actual phone transport, assignment and human takeover still require the user's supervised pilot; no real customer messages have been sent by these tests.

## Final code verification checkpoint

- `d096027`: injection recovery acknowledges supplied content and asks for a clean copy; deterministic block still avoids provider invocation and actions.
- `2efa247`: qualification-only handoffs no longer end in a contradictory permission question; when omitted, a minimum note records only the supplied reason, not an invented full briefing. Existing detailed notes and legacy agents are preserved.
- Fresh combined API suite: **725 passing tests**, typecheck and production build passed. Fresh web suite: **100 passing tests**. Both fixes still require post-deploy F09/N11 replay.
- Paired low-mode tests have now verified native/scanned PDF, PNG, OGG, MP3, two-page PDF and retained PDF corrections. Invalid/six-page PDFs failed safely. Text replays verified kg orders, missing attachments, qualification continuity, urgency and protected-fact handoffs. Evidence is being consolidated separately from frozen previous reports.

## Published handoff — 2026-09-06 16:25 São Paulo

- API `7c900533d27d14485bfda447fb94708289326f47` built in successful workflow `34054412068`, deployed to the same exact Portainer service; running task `c9g062c872xiwflusnfoino8t`. Web remains on compatible `40b01c3` (no further frontend changes). Health and readiness passed.
- Final fresh verification: **726 API tests**, **100 web tests**, typechecks and production builds passed. Independent reviews covered injection recovery and qualification-only handoff normalization.
- Definition/package prompt fits 8,000 characters; rendered live test prompt is 7,964 characters, FNV `ae294cf0`. Only inactive `Pré-atendimento Villefer — Teste` uses the explicit `low` mode. Saved and refreshed in UI. Active legacy agent unchanged.
- Post-deploy actual uploads repeated PDF, PNG, OGG and hostile-instruction PDF. Normal files preserved both line items/units and corrected audio quantity; hostile content received safe clean-copy recovery. N11 repeat produced an explicit finish limitation, committed-transfer wording and minimum note; detailed continuation produced a complete seller note.
- N16 prompt replay retained all eight items, global carbon-steel material, 6m lengths and original 4' clarified as 4 polegadas. It corrected the obvious 'tudo' typo to 'tubo'. It still asked for previously unspecified chapa/perfil types; gathering them earlier would make the flow shorter.
- **Residual variability:** identical N11 initial input sometimes asks measures/quantity before transfer and sometimes transfers immediately, both without promising white finish. This is visible as a review item, not hidden behind a success percentage. A prompt/model test is not a guarantee of production perfection.
- Browser-verified report: analysis workspace `outputs/real-battery/teste-arquivos.html`, served at `http://127.0.0.1:57107/teste-arquivos.html`. It contains 32 selected observations across before/after runs, not 32 independent conversations or an accuracy denominator. Compact observations, fixture hashes and original files are linked. Earlier report is preserved with a link to this update.
- No WhatsApp customer messages or seller transfers were executed. Phone/channel association, actual media transport and human takeover remain the supervised pilot gate owned by the user. Agent remains inactive.
