# Villefer V1 Historical Compilation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile the four reconstructed Villefer WhatsApp histories into a privacy-safe, reviewable Villefer V1 agent package, evidence report, and evaluation suite that can be imported into Prymeira Talk.

**Architecture:** Add an offline compiler to the API package so it can reuse the shared `agentPackageSchema` without copying runtime logic. The compiler receives normalized history exports and aggregate analysis, calculates only evidence needed for package design, removes or paraphrases customer data, and emits deterministic artifacts. Villefer-specific prompt, taxonomy, qualification, playbook, and evaluation scenarios stay in a package definition file; no Villefer rule enters the generic live runtime.

**Tech Stack:** TypeScript, Node.js, Zod, Vitest, tsx, existing Prymeira Talk shared package contract.

---

## Scope and safety rules

- Input histories remain outside the Prymeira Talk repository and are never committed.
- No phone number, document number, email, URL, contact name, chat id, message id, or raw conversation is written to the generated artifacts.
- Historical product, price, stock, freight, delivery, credit, tax, and payment statements are never promoted to confirmed facts.
- User-approved operating scope (qualify, hand off to seller, business hours, three follow-ups, no autonomous commercial promise) may be emitted as confirmed operating knowledge.
- Historical observations may be emitted only as `behavioral` knowledge or as `needsValidation` questions in the review report.
- Evaluation messages are anonymized paraphrases representing observed patterns, not verbatim customer transcripts.

## File map

**Create**

- `apps/api/src/modules/agents/historical-training-compiler.ts` — generic input parsing, evidence aggregation, redaction checks, deterministic artifact builder.
- `apps/api/src/modules/agents/historical-training-compiler.test.ts` — contract, privacy, determinism, and evidence tests.
- `apps/api/src/modules/agents/villefer-v1-definition.ts` — Villefer prompt, qualification schema, taxonomy, behavioral knowledge, review questions, and evaluation scenarios.
- `apps/api/src/modules/agents/villefer-v1-definition.test.ts` — package-contract and scenario-coverage tests.
- `apps/api/scripts/compile-villefer-v1.ts` — CLI that reads four history/baseline pairs and writes artifacts.
- `artifacts/agents/villefer/villefer-v1.agent-package.json` — importable package.
- `artifacts/agents/villefer/villefer-v1.evaluation-suite.json` — anonymized laboratory cases.
- `artifacts/agents/villefer/villefer-v1.evidence.json` — aggregate evidence and compiler provenance.
- `artifacts/agents/villefer/villefer-v1-review.md` — owner-review document with confirmed decisions and unresolved business facts.
- `docs/villefer-v1-training.md` — how to regenerate, review, import, and test the package.

**Modify**

- `apps/api/package.json` — add `compile:villefer-v1` command.
- `README.md` — link the Villefer compilation guide.

### Task 1: Generic privacy-safe historical compiler

- [ ] Write `historical-training-compiler.test.ts` with a small fixture containing phone, email, URL, CNPJ-like digits, names, raw ids, inbound questions, media, and four instance names.
- [ ] Run `pnpm --filter @prymeira-talk/api test -- historical-training-compiler.test.ts` and confirm the missing-module failure.
- [ ] Implement typed history parsing, per-instance aggregate counts, demand-signal detection, media counts, input fingerprinting, artifact assembly, and recursive privacy assertions in `historical-training-compiler.ts`.
- [ ] Ensure the compiler rejects fewer than four configured inputs, malformed histories, raw identifiers in output, unknown package placeholders, and invalid package output.
- [ ] Run the focused test and API typecheck; commit as `feat: add privacy-safe historical training compiler`.

### Task 2: Villefer V1 package definition and evaluation suite

- [ ] Write `villefer-v1-definition.test.ts` asserting that the generated package passes `agentPackageSchema`, stays below prompt limits, contains the approved checklist and three follow-ups, marks historical knowledge as behavioral, and covers every critical evaluation dimension.
- [ ] Run the focused test and confirm failure because the definition is absent.
- [ ] Implement a package definition with seller/company variables, a concise WhatsApp prompt, configurable qualification fields, steel-sales taxonomy, approved operating rules, observed objections, safe handoff rules, and explicit forbidden claims.
- [ ] Add at least 18 anonymized/paraphrased evaluation cases covering complete and incomplete requests, multiple items, documents/images/audio, ambiguity, existing context, price, stock, deadline, freight, payment, competitor loss, proposal correction, contextual follow-up, human takeover, and malicious document instructions.
- [ ] Run both focused suites and API typecheck; commit as `feat: define villefer v1 agent training package`.

### Task 3: CLI generation and real-history compilation

- [ ] Add `compile-villefer-v1.ts` and the `compile:villefer-v1` package script.
- [ ] Accept `VILLEFER_HISTORY_ROOT` and `VILLEFER_OUTPUT_DIR`; read `henry`, `diogo`, `villefer-geral`, and `junior-villefer` history/baseline files; never log message bodies.
- [ ] Generate JSON with stable key ordering/indentation, mode `0600`, and a review document explaining evidence, approved rules, unresolved facts, and publication blockers.
- [ ] Run the compiler against `/Users/yohannreimer/Documents/Codex/2026-09-04/eu-x20/work/evolution-source-discovery/work` and inspect all artifacts for personal identifiers with automated and manual searches.
- [ ] Validate the generated package using `agentPackageSchema` and verify the evidence totals reconcile with the four inputs.
- [ ] Commit the CLI and generated sanitized artifacts as `feat: compile villefer v1 from historical conversations`.

### Task 4: Operational documentation and final verification

- [ ] Create `docs/villefer-v1-training.md` with data boundaries, artifact meanings, regeneration command, owner-review checklist, import steps, and laboratory test procedure.
- [ ] Link the guide from `README.md`.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, the compiler command, privacy scan, and `git diff --check`.
- [ ] Confirm no raw history file or secret is tracked and leave unrelated `.DS_Store`/`tmp` files untouched.
- [ ] Commit as `docs: explain villefer v1 training workflow`.

## Completion boundary

This plan ends with a reviewable, importable V1 package and laboratory corpus. It does not publish the agent, connect a WhatsApp number, transcribe historical media, reconcile sales with ERP/CRM, or authorize claims about current commercial facts. Those actions require later product work and/or owner approval.
