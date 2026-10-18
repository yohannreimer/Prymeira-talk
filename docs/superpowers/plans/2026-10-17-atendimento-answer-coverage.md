# Attendance Answer Coverage Implementation Plan

> Execution: inline in this chat using executing-plans. Yohann explicitly prohibited subagents.

**Goal:** Prevent the observed omission between retrieval, writing and sending in attendance.
**Architecture:** Attendance-specific evidence checks and judge; optional final reader validation in the shared runner. Existing bounded rewrite/handoff flow remains in use.
**Tech Stack:** TypeScript, Vitest, JEV, pnpm.

## Task 1 — Reproduce the production failure
- [x] Add `answer-coverage.test.ts` with the real question and approved public product excerpts, without customer identifiers.
- [x] Assert that generic citation while a more specific passage was seen requests another reading.
- [x] Assert that the exact greeting/catalogue-only reply is blocked.
- [x] Run `pnpm --filter @prymeira-talk/api exec vitest run src/modules/harness/answer-coverage.test.ts`; observe failures before fixes.

## Task 2 — Preserve specific evidence and answer content
- [x] Add `atendimento/cobertura.ts`: meaningful normalized question terms, specificity comparison, reader note and answer omission rule. Never insert source claims automatically.
- [x] Wire the note into `conferirLeitura`; add optional final validation in `core/types.ts` / `core/runner.ts`, enabled by attendance only. An unresolved validation returns a human handoff and preserves the record.
- [x] Update attendance instructions/move to answer the question before the optional catalogue offer.
- [x] Add the omission rule and preserve open questions in `aposEnvio`.

## Task 3 — Review each question
- [x] Add an attendance live judge in `atendimento/juiz.ts`, using the existing JEV client and grounded question/citation context; preserve the follow-up judge.
- [x] Require per-question coverage and stronger live adherence; wire only `responderComHarness` in `producao.ts`.
- [x] Test low scores from production, missing/partial coverage, good paraphrases, rewriting and outage/handoff. Assert questions remain unresolved after rejection.

## Task 4 — Verify and review
- [x] Run focused tests, full harness tests, API typecheck/build and `git diff --check`.
- [x] Inspect final diff for unintended agent changes and secrets; record observed results and outstanding live calibration.
- [x] Do not deploy or send WhatsApp messages as part of local verification.

## Observed validation — 17/10/2026
- Initial regression run: both new reproduction cases failed before the implementation (generic citation accepted; greeting/catalogue-only reply accepted).
- Full API suite after implementation: 223 files passed, 51 skipped; 2,895 tests passed, 798 skipped.
- API typecheck and production bundle passed. `git diff --check` passed.
- Simulator now selects the same live attendance judge as production. Buyer/prospecting/follow-up judges remain unchanged.
- No live model evaluation was run for this change. New semantic thresholds (0.60 adherence, 0.65 response/coverage) are conservative initial policy, not statistically calibrated. Deterministic tests validate enforcement and flow, not model accuracy. An extra JEV call is added for replies with questions requiring coverage.
- The specificity check detects unused passages through lexical overlap; it does not prove semantic completeness or automatically assert that similar product names are equivalent.
- No deployment, database write or WhatsApp send occurred.
