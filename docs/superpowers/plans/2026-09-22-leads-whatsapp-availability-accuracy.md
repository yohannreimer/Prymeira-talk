# Leads WhatsApp Availability Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop false “Indisponível” classifications caused by querying only a shortened Brazilian mobile number.

**Architecture:** Preserve the displayed digits as the primary Evolution lookup; keep canonical digits only as a deduplication key. Store both candidates in new JSON job inputs, derive safe candidates for legacy jobs, and require explicit negative results for every applicable candidate before persisting `unavailable`.

**Tech Stack:** TypeScript, Evolution API client, Prisma JSON jobs, Vitest.

**Implementation finding:** Google Maps also supplies local Brazilian phones without DDI (for example `(19) 99999-0000`). Normalize only recognizable 10/11-digit Brazilian local phones to `55` + DDD + number before querying; keep the displayed value unchanged. Add regression coverage for legacy local jobs, lead status/import matching, and partial retry jobs whose `lookups` must be narrowed to failed numbers.

---

### Task 1: Define safe phone candidates

**Files:**
- Create: `apps/api/src/modules/leads/lead-whatsapp-numbers.ts`
- Create: `apps/api/src/modules/leads/lead-whatsapp-numbers.test.ts`

- [ ] **Step 1: Write failing table tests.** Cover `+55 (47) 99139-6920` → key `554791396920`, primary `5547991396920`, alternate `554791396920`; reduced `554791396920` → alternate full form; fixed `554733334444` and international `14155552671` → no alternate; malformed values → null.
- [ ] **Step 2: Run the failing test.** `pnpm --filter @prymeira-talk/api exec vitest run src/modules/leads/lead-whatsapp-numbers.test.ts`; expect import failure.
- [ ] **Step 3: Implement the pure helper.** Use digits-only input, the existing `canonicalizePhone`, and exactly these conditions:

```ts
export type WhatsappPhoneCandidates = { key: string; primary: string; alternate: string | null };

export function whatsappPhoneCandidates(value: string): WhatsappPhoneCandidates | null {
  const primary = value.replace(/\D/g, "");
  if (!/^\d{8,15}$/.test(primary)) return null;
  const key = canonicalizePhone(primary);
  const full = primary.startsWith("55") && primary.length === 13 && primary[4] === "9";
  const reduced = primary.startsWith("55") && primary.length === 12 && primary[4] === "9";
  const alternate = full ? key : reduced ? `${primary.slice(0, 4)}9${primary.slice(4)}` : null;
  return { key, primary, alternate };
}
```

- [ ] **Step 4: Run the test and commit.** Commit helper and test as `fix(leads): define safe WhatsApp number variants`.

### Task 2: Persist original candidates without duplicate leads

**Files:**
- Modify: `apps/api/src/modules/leads/lead-whatsapp.service.ts:90`
- Modify: `apps/api/src/modules/leads/leads.repository.ts:485`
- Modify: `apps/api/src/modules/leads/lead-whatsapp.service.test.ts`
- Modify: `apps/api/src/modules/leads/leads.repository.test.ts`

- [ ] **Step 1: Write failing service/repository tests.** Use one lead with a full mobile phone and another with its reduced form. Assert a single canonical group; the persisted batch stores `phone: "554791396920"`, `primary: "5547991396920"`, `alternate: "554791396920"`, two lead IDs, and job `numbers` contains the 13-digit primary.
- [ ] **Step 2: Run those two test files and confirm failure.** `pnpm --filter @prymeira-talk/api exec vitest run src/modules/leads/lead-whatsapp.service.test.ts src/modules/leads/leads.repository.test.ts`.
- [ ] **Step 3: Change `createVerification`.** Build one group per `WhatsappPhoneCandidates.key` from `[lead.normalizedPhone, ...lead.phones]`. Prefer the 13-digit original when both forms exist, regardless of input order. Persist `primary` and `alternate` alongside the existing canonical `phone` and lead IDs; continue splitting groups into 25-item batches.
- [ ] **Step 4: Change `createWhatsappVerificationJobs`.** Accept batches of `{ phone, primary, alternate, leadIds }`; persist `numbers: batch.map(item => item.primary)`, a `lookups` array with all three phone fields, and existing `entries` referencing the canonical key. Keep the JSON transaction and idempotency behavior unchanged.
- [ ] **Step 5: Run the tests and typecheck.** Run the two Vitest files from Step 2 and `pnpm --filter @prymeira-talk/api typecheck`. Update every existing `createWhatsappVerificationJobs` test fixture to include `primary` and `alternate` on batch items, then commit as `fix(leads): preserve original numbers in verification jobs`.

### Task 3: Interpret both Evolution answers conservatively

**Files:**
- Modify: `apps/api/src/modules/leads/lead-whatsapp.service.ts:18`
- Modify: `apps/api/src/modules/leads/lead-whatsapp.service.test.ts`
- Read: `apps/api/src/modules/evolution/evolution.client.test.ts` to confirm the response shapes already covered

- [ ] **Step 1: Write failing tests.** For full mobile input, assert these cases: primary true → available with one request; primary false + alternate true → available with two requests; two false → unavailable; primary missing + alternate false → failed; primary false + alternate missing → failed. A 12-digit legacy job must test its safe 13-digit variant. A fixed line must not acquire a mobile variant. Include a 26-number case proving each Evolution call has at most 25 numbers.
- [ ] **Step 2: Run the service tests and confirm failures.** Use the Task 2 Vitest command.
- [ ] **Step 3: Extend `whatsappJobInputSchema`.** Add optional `lookups: z.array(z.object({ phone: z.string(), primary: z.string(), alternate: z.string().nullable() }))`. When absent, derive candidates from legacy `numbers` using the Task 1 helper and align with `entries` by canonical key; reject malformed/unmatched input as `LEAD_INVALID_INPUT`.
- [ ] **Step 4: Refactor processing into primary and alternate passes.** Keep the existing three-attempt transient retry policy for each pass. For each canonical key, treat any explicit positive as `available`, all explicit negatives as `unavailable`, and every other combination as `failed` with an existing or new `LEAD_WHATSAPP_*` error code. Never infer false from a missing record, thrown request, or malformed flag. If the Evolution response returns both forms of a phone in one pass, positive wins within that pass.
- [ ] **Step 5: Run service/client tests and typecheck.** `pnpm --filter @prymeira-talk/api exec vitest run src/modules/leads/lead-whatsapp.service.test.ts src/modules/evolution/evolution.client.test.ts && pnpm --filter @prymeira-talk/api typecheck`; commit as `fix(leads): require explicit negative variant checks`.

### Task 4: End-to-end regression verification

**Files:** No source changes unless a test exposes a defect.

- [ ] Run `pnpm --filter @prymeira-talk/api test`, `pnpm --filter @prymeira-talk/api typecheck`, and `pnpm --filter @prymeira-talk/api build:prod`.
- [ ] Run a job-level integration test with a fake Evolution client to verify no send endpoint is called and old/new JSON jobs are accepted.
- [ ] Compare the implementation to the approved spec, run `git diff --check`, and report what remains untested in production.
- [ ] After deployment, re-run verification on a small sample of “Teste Google Maps v1.18 22-09”; compare at least one known-valid number to Talk's status. Do not claim live accuracy until this is observed.
