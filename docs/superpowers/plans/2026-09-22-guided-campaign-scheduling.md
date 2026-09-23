# Guided Campaign Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a three-step, nontechnical campaign flow whose real WhatsApp sends are verified, scheduled, paced, resumable, and auditable.

**Architecture:** Keep draft editing in the existing Campaign model, but make final activation a separate idempotent transaction that creates persistent recipient jobs. A single due-job worker claims one recipient per channel, verifies WhatsApp, sends through Evolution, and stores an unambiguous result. The React editor becomes three guided sections backed by preview, activate, progress, pause, resume, and cancel endpoints.

**Tech Stack:** React 19/Vite, Fastify 5, Prisma 6/PostgreSQL, Evolution client, Vitest, Docker/Portainer.

**Approved spec:** `docs/superpowers/specs/2026-09-22-guided-campaign-scheduling-design.md`.

---

## File map and boundaries

| Unit | Files | Responsibility |
| --- | --- | --- |
| Data and contracts | `apps/api/prisma/schema.prisma`, new additive migration in `apps/api/prisma/migrations/`, `apps/web/src/app/api.ts` | Persist activation, queue state, pacing and DTOs without auto-activating legacy campaigns. |
| Timing | `apps/api/src/modules/followups/business-time.ts`, new `apps/api/src/modules/campaigns/campaign-cadence.ts` and tests | Convert seconds to permitted instants in an IANA timezone; draw and persist independent interval/pause values. |
| Audience safety | New `apps/api/src/modules/campaigns/campaign-audience-preview.ts` and tests, `apps/api/src/modules/leads/lead-conversion.service.ts` | Preview and explain eligibility for Leads, imported CSV, and board contacts. Only Evolution `available` is sendable. |
| Activation | New `apps/api/src/modules/campaigns/campaign-activation.service.ts` and tests, `apps/api/src/modules/campaigns/campaigns.routes.ts` | Revalidate, audit explicit confirmation and atomically create one persisted job per unique phone. |
| Execution | New `apps/api/src/modules/campaigns/campaign-worker.ts`, `campaign-worker.repository.ts` and tests, `apps/api/src/app.ts` | Claim due jobs, serialize by channel, deliver once, pause on ambiguous outcomes, survive restart. |
| Controls | New `apps/api/src/modules/campaigns/campaign-controls.service.ts` and tests, campaign routes | Pause, resume, cancel remaining, and expose progress. Legacy `send-real` cannot bypass the queue. |
| Guided UI | New `apps/web/src/features/campaigns/GuidedCampaignEditor.tsx`, `CampaignReview.tsx`, tests; modify `CampaignsPage.tsx` and `apps/web/src/styles.css` | Show the approved three stages and operational state, retain Meta editor. |

Work in an isolated worktree from the latest committed release. Before any edit, inspect `git status` and other task changes; never include agent files or unrelated changes in commits. Each task below is one reviewable commit. Do not deploy partial tasks.

### Task 1: Add durable queue and activation columns

**Files:** Modify `apps/api/prisma/schema.prisma`; create `apps/api/prisma/migrations/20260923000100_campaign_delivery_queue/migration.sql`; modify `apps/web/src/app/api.ts` and `apps/api/src/modules/campaigns/campaigns.service.ts` status unions.

- [ ] **Step 1: Write a failing contract test.** Add `apps/api/src/modules/campaigns/campaign-queue-schema.test.ts` that reads the Prisma model through generated types and verifies a queued recipient can hold `phoneSnapshot`, `channelId`, `gapSeconds`, `pauseSeconds`, `leaseToken`, `leaseExpiresAt`, `verifiedAt` and `sequenceNumber`. Include this assertion:

```ts
const queued = {
  status: "pending", phoneSnapshot: "5547999999999", sequenceNumber: 1,
  gapSeconds: 150, pauseSeconds: 0, leaseToken: null, leaseExpiresAt: null
} satisfies Pick<Prisma.CampaignRecipientUncheckedCreateInput,
  "status" | "phoneSnapshot" | "sequenceNumber" | "gapSeconds" |
  "pauseSeconds" | "leaseToken" | "leaseExpiresAt">;
expect(queued.gapSeconds).toBe(150);
```

- [ ] **Step 2: Prove it fails.** Run `pnpm --filter @prymeira-talk/api test -- campaign-queue-schema.test.ts` and `pnpm --filter @prymeira-talk/api build`; expect the build to fail on missing generated fields.
- [ ] **Step 3: Add the schema and migration.** Add `paused`, `canceled`, `needs_attention` to `CampaignStatus`. Add nullable `activationKey`, `confirmedBy`, `confirmedAt`, `channelId`, `startMode` and `timeZone @default("America/Sao_Paulo")` to Campaign; add the recipient fields above and indexes on `(status, scheduledAt)` and `(workspaceId, channelId, status)`. Add `CampaignChannelThrottle` with unique `(workspaceId, channelId)`, `nextAvailableAt`, `attemptsSincePause`, and `updatedAt`. The SQL migration must only add nullable/defaulted fields and enum values, for example:

```sql
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'paused';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'canceled';
ALTER TYPE "CampaignStatus" ADD VALUE IF NOT EXISTS 'needs_attention';
ALTER TABLE "campaigns" ADD COLUMN "activation_key" TEXT,
  ADD COLUMN "confirmed_by" TEXT, ADD COLUMN "confirmed_at" TIMESTAMPTZ,
  ADD COLUMN "channel_id" UUID, ADD COLUMN "start_mode" TEXT,
  ADD COLUMN "time_zone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';
ALTER TABLE "campaign_recipients" ADD COLUMN "phone_snapshot" TEXT,
  ADD COLUMN "channel_id" UUID, ADD COLUMN "sequence_number" INTEGER,
  ADD COLUMN "gap_seconds" INTEGER, ADD COLUMN "pause_seconds" INTEGER,
  ADD COLUMN "lease_token" UUID, ADD COLUMN "lease_expires_at" TIMESTAMPTZ,
  ADD COLUMN "verified_at" TIMESTAMPTZ;
CREATE UNIQUE INDEX "campaigns_workspace_activation_key_key"
  ON "campaigns"("workspace_id", "activation_key");
CREATE UNIQUE INDEX "campaign_recipients_workspace_campaign_sequence_key"
  ON "campaign_recipients"("workspace_id", "campaign_id", "sequence_number");
CREATE INDEX "campaign_recipients_due_idx"
  ON "campaign_recipients"("status", "scheduled_at");
CREATE TABLE "campaign_channel_throttles" (
  "workspace_id" TEXT NOT NULL, "channel_id" UUID NOT NULL,
  "next_available_at" TIMESTAMPTZ, "attempts_since_pause" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("workspace_id", "channel_id")
);
```

The Prisma model for the last table is:

```prisma
model CampaignChannelThrottle {
  workspaceId        String    @map("workspace_id")
  channelId          String    @map("channel_id") @db.Uuid
  nextAvailableAt    DateTime? @map("next_available_at")
  attemptsSincePause Int       @default(0) @map("attempts_since_pause")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  @@id([workspaceId, channelId])
  @@map("campaign_channel_throttles")
}
```

- [ ] **Step 4: Generate and verify.** Run `pnpm prisma:generate`, `pnpm --filter @prymeira-talk/api build`, and the new test. On a disposable local DB, run `pnpm --filter @prymeira-talk/api migrate:deploy` twice; expect both runs to succeed and existing campaigns to remain unchanged. Do not run a production migration here.
- [ ] **Step 5: Commit.** `git add apps/api/prisma apps/api/src/modules/campaigns/campaign-queue-schema.test.ts apps/api/src/modules/campaigns/campaigns.service.ts apps/web/src/app/api.ts && git commit -m "feat(campaigns): add durable delivery state"`.

### Task 2: Make timing exact and independently randomized

**Files:** Modify `apps/api/src/modules/followups/business-time.ts`; create `apps/api/src/modules/campaigns/campaign-cadence.ts` and `campaign-cadence.test.ts`; update `apps/web/src/features/campaigns/CampaignsPage.tsx` default values only after the UI task.

- [ ] **Step 1: Write failing tests.** Use an injected integer draw and fixed clock. Assert draws of `150`, `190`, `245` seconds produce distinct gaps in `[120,300]`; the 20th attempted send adds one pause in `[900,1200]`; `19:59:00 + 150s` yields next day `09:01:30` in `America/Sao_Paulo`; `20:00` is outside the window. Test a non-São-Paulo IANA zone too.

```ts
expect(drawGap(DEFAULT_CAMPAIGN_CADENCE, (min, _max) => min + 30)).toBe(150);
expect(drawPause(DEFAULT_CAMPAIGN_CADENCE, (min, _max) => min + 30, 19)).toBe(0);
expect(drawPause(DEFAULT_CAMPAIGN_CADENCE, (min, _max) => min + 30, 20)).toBe(930);
```

- [ ] **Step 2: Run `pnpm --filter @prymeira-talk/api test -- campaign-cadence.test.ts`.** Expect a missing-module failure.
- [ ] **Step 3: Implement the pure boundary.** Keep `addBusinessMinutes` unchanged and export `addBusinessSeconds` beside it, reusing its private calendar helpers. The body mirrors the existing minute function but tracks seconds precisely:

```ts
export function addBusinessSeconds(input: Omit<AddBusinessMinutesInput, "minutes"> & { seconds: number }): Date {
  if (!Number.isSafeInteger(input.seconds) || input.seconds <= 0) {
    throw new RangeError("seconds must be a positive whole number.");
  }
  const calendar = createBusinessCalendar({ ...input, minutes: Math.ceil(input.seconds / 60) });
  let remainingMilliseconds = input.seconds * 1000;
  let current = nextBusinessInstant(input.from, calendar);
  while (remainingMilliseconds > 0) {
    const localDate = getLocalDateTime(current, calendar.formatter);
    const closing = localDateTimeToInstant(localDate, calendar.businessHours.end, calendar);
    const availableMilliseconds = closing.getTime() - current.getTime();
    if (availableMilliseconds <= 0) { current = nextBusinessInstant(closing, calendar); continue; }
    if (remainingMilliseconds <= availableMilliseconds) {
      return new Date(current.getTime() + remainingMilliseconds);
    }
    remainingMilliseconds -= availableMilliseconds;
    current = nextBusinessInstant(closing, calendar);
  }
  return current;
}
```

In the new campaign module, use the following complete default and draw functions, with `afterAttempts` counting actual provider attempts rather than skipped numbers:

```ts
export const DEFAULT_CAMPAIGN_CADENCE = {
  minDelaySeconds: 120, maxDelaySeconds: 300, batchSize: 20,
  pauseMinSeconds: 900, pauseMaxSeconds: 1200,
  windowStart: "09:00", windowEnd: "20:00"
} as const;
export type CampaignCadence = {
  minDelaySeconds: number; maxDelaySeconds: number; batchSize: number;
  pauseMinSeconds: number; pauseMaxSeconds: number;
  windowStart: string; windowEnd: string;
};
type Draw = (minInclusive: number, maxInclusive: number) => number;
export function drawGap(cadence: CampaignCadence, draw: Draw): number {
  return draw(cadence.minDelaySeconds, cadence.maxDelaySeconds);
}
export function drawPause(cadence: CampaignCadence, draw: Draw, afterAttempts: number): number {
  return cadence.batchSize > 0 && afterAttempts > 0 && afterAttempts % cadence.batchSize === 0
    ? draw(cadence.pauseMinSeconds, cadence.pauseMaxSeconds) : 0;
}
```

Use `crypto.randomInt(min, max + 1)` in production, inject deterministic `draw` in tests. Add the sampled seconds with `addBusinessSeconds`; persist draws on jobs, never resample after restart. If a pause or channel conflict shifts a job, move its timestamp forward while preserving its sampled seconds.
- [ ] **Step 4: Verify.** Run the cadence and existing `business-time.test.ts` files plus `pnpm --filter @prymeira-talk/api build`. Expect all pass.
- [ ] **Step 5: Commit.** `git add apps/api/src/modules/followups/business-time.ts apps/api/src/modules/campaigns/campaign-cadence* && git commit -m "feat(campaigns): plan randomized business-hour cadence"`.

### Task 3: Preview audience with verified-only eligibility

**Files:** Create `apps/api/src/modules/campaigns/campaign-audience-preview.ts` and test; modify `campaigns.routes.ts` and `lead-conversion.service.ts`; modify Leads draft request in `packages/shared` and `apps/web/src/features/leads/LeadsPage.tsx`.

- [ ] **Step 1: Write failing tests.** Cover `available`, `unavailable`, `unverified`, temporary Evolution failure, malformed phone, duplicate phone, changed normalized phone, and another workspace's lead. Assert only a current-number `available` response is eligible. For old drafts assert `selectedCount` is `null`, not inferred from imported rows.

```ts
expect(classifyRecipient({ phone: "5547999999999", verification: {
  phone: "5547999999999", status: "available"
}})).toBe("eligible");
expect(classifyRecipient({ phone: "5547999999999", verification: {
  phone: "5547888888888", status: "available"
}})).toBe("unverified");
```

- [ ] **Step 2: Run** `pnpm --filter @prymeira-talk/api test -- campaign-audience-preview.test.ts`; expect missing functions.
- [ ] **Step 3: Implement classification and preview.** `classifyRecipient` returns exactly `eligible | missing_phone | no_whatsapp | unverified | verification_error | duplicate`. Normalize with the existing contact/lead phone helpers; do not accept client-provided `available`. Resolve board/CSV/Leads audience on the server, dedupe by normalized phone, then call `evolution.client.checkWhatsappNumbersAvailability({ instanceName, numbers })`. Return `{ selectedCount: number | null, eligible, excluded, checkedAt, audienceHash }`; include individual excluded reasons. Add `POST /campaigns/:campaignId/preview-audience` with a required `channelId` in its body, under `campaign.manage` and workspace scoping. Compute `audienceHash` from the campaign's `updatedAt`, channel ID, normalized eligible phone IDs, and rendered messages. Only a successful Evolution response creates `available`; timeout or missing instance yields `verification_error`/409. Extend Leads draft creation to persist `{ origin: "leads", listId, selectedCount, exclusions }` in the `audience` JSON; the server computes these from the original selected lead IDs, never trusts a count supplied by the browser.
- [ ] **Step 4: Verify.** Run the new test, `lead-conversion.service.test.ts`, `campaigns.service.test.ts`, `leads.routes.test.ts`, and API build. Expect all pass and no WhatsApp text send calls from preview.
- [ ] **Step 5: Commit.** `git add apps/api/src/modules/campaigns apps/api/src/modules/leads packages/shared apps/web/src/features/leads && git commit -m "feat(campaigns): explain verified audience eligibility"`.

### Task 4: Activate only after explicit server-side review

**Files:** Create `apps/api/src/modules/campaigns/campaign-activation.service.ts` and test; modify `campaigns.routes.ts`, `campaigns.service.ts`, `apps/web/src/app/api.ts`.

- [ ] **Step 1: Write failing tests.** For a draft with two available phones, assert a request with `{ idempotencyKey, channelId, startMode, scheduledAt, timeZone, confirmation: true, expectedAudienceHash }` creates exactly two `pending` jobs and stores `confirmedBy/confirmedAt`. Repeating the key returns the same campaign without new rows. `confirmation: false`, changed preview hash, zero eligible contacts, disconnected channel, past date, or workspace mismatch returns 4xx and no jobs. A mere PATCH of `scheduledAt` remains draft.
- [ ] **Step 2: Run** `pnpm --filter @prymeira-talk/api test -- campaign-activation.service.test.ts`; expect missing service/route failure.
- [ ] **Step 3: Add `POST /campaigns/:campaignId/activate`.** Validate with Zod, call `previewAudience` outside a database transaction and compare its `audienceHash` with the submitted hash. In one transaction, lock the campaign row, require draft and no prior activation, recheck that `updatedAt` still matches the preview's revision, write channel/timezone/startMode/confirmation/activation key, upsert the `(workspaceId,channelId)` throttle row, create one recipient per phone with status `pending`, sampled gap and planned timestamp, then set campaign `scheduled` or `sending`. Pause seconds are sampled only when the channel reaches 20 actual provider attempts, then stored on that completed recipient in the same settlement transaction. Use the existing `(workspaceId,campaignId,audienceKey)` uniqueness and a new unique sequence key. A reused activation key returns the existing state; another key against an active campaign returns 409. Keep an exact sample route body:

```ts
const activateBody = z.object({
  idempotencyKey: z.string().uuid(), channelId: z.string().uuid(),
  startMode: z.enum(["now", "scheduled"]),
  scheduledAt: z.string().datetime().nullable(),
  timeZone: z.string().min(1).max(100),
  confirmation: z.literal(true), expectedAudienceHash: z.string().length(64)
});
```

Change `createCampaign`/`updateCampaign` so `scheduledAt` does not derive `scheduled` status; status transitions to active are only through activation. If `startMode="now"` but the campaign is outside its 09:00–20:00 window, store `scheduled` until the next opening; otherwise use `sending`. Reject edits to message/audience/cadence once active, except through the explicit control routes. Never call Evolution inside the transaction. The legacy `send-real` route must return 409 with a message directing the user to review/activate; it must not invoke the old synchronous loop.
- [ ] **Step 4: Verify.** Run activation tests, campaign route tests, API build, and a disposable-DB test of two concurrent activations. Expect one activation, no duplicate jobs, and no Evolution send call during activation.
- [ ] **Step 5: Commit.** `git add apps/api/src/modules/campaigns apps/web/src/app/api.ts && git commit -m "feat(campaigns): activate reviewed drafts into queue"`.

### Task 5: Execute due recipients durably, one per channel

**Files:** Create `apps/api/src/modules/campaigns/campaign-worker.repository.ts`, `campaign-worker.ts`, both test files; modify `apps/api/src/app.ts`.

- [ ] **Step 1: Write failing tests.** Two workers polling together claim only one job for the same channel. Future jobs, paused/canceled campaigns and jobs outside 09:00–20:00 are not sent. A successful send records provider ID and conversation message once. An unavailable phone is skipped; Evolution outage pauses the campaign; a timeout after entering `in_flight` becomes `needs_attention` and is not retried. A process restart preserves sampled `gapSeconds/pauseSeconds`. Use a fake Evolution client and fake clock; never call a real provider in tests.
- [ ] **Step 2: Run** `pnpm --filter @prymeira-talk/api test -- campaign-worker`; expect missing worker files.
- [ ] **Step 3: Implement repository claim/settlement.** Atomically claim one due `pending` row using `FOR UPDATE SKIP LOCKED`, filtering active campaign status and channel throttle `next_available_at <= now`. Lock the throttle row as part of the same claim, reject another `in_flight` row for that channel, set `lease_token`, `lease_expires_at`, and `status='in_flight'`, and return its snapshot. Recheck the campaign's local 09:00–20:00 window at claim time; if outside, move the job to the next allowed instant instead of sending. Use parameterized `$queryRaw` with only supported result types; never deserialize PostgreSQL `void`. On expired `in_flight`, mark `uncertain`, set campaign `needs_attention`, and do not auto-reclaim. Settlement updates the row only when its lease token still matches, samples/stores the pause if this was the channel's 20th real attempt, then advances the channel throttle using persisted gap and pause seconds.

```sql
SELECT r.id FROM campaign_recipients r
JOIN campaigns c ON c.id = r.campaign_id AND c.workspace_id = r.workspace_id
JOIN campaign_channel_throttles t
  ON t.workspace_id = r.workspace_id AND t.channel_id = r.channel_id
WHERE r.status = 'pending' AND r.scheduled_at <= NOW()
  AND c.status IN ('scheduled', 'sending')
  AND (t.next_available_at IS NULL OR t.next_available_at <= NOW())
  AND NOT EXISTS (
    SELECT 1 FROM campaign_recipients active
    WHERE active.workspace_id = r.workspace_id
      AND active.channel_id = r.channel_id AND active.status = 'in_flight'
  )
ORDER BY r.scheduled_at, r.id
FOR UPDATE OF r, t SKIP LOCKED LIMIT 1;
```

- [ ] **Step 4: Implement the worker loop.** Before each `sendText`, recheck the same normalized phone with Evolution. If unavailable, settle `skipped_no_whatsapp` without incrementing provider attempts; if verification fails transiently, pause and leave the item pending. Set `in_flight` and the ambiguity guard before calling `sendText`. On success, write recipient result and conversation message transactionally and increment the throttle's `attemptsSincePause`. On an ambiguous send error, mark `uncertain`, pause, and require human review. After each settlement, set the campaign to `completed` only when no pending/in-flight rows remain and no uncertain result needs review. Register `start()`/`stop()` in `app.ts`, using the existing Leads scheduler lifecycle pattern. Stop only after in-flight work settles or is marked uncertain.
- [ ] **Step 5: Verify and commit.** Run worker tests with two concurrent instances, `pnpm --filter @prymeira-talk/api test`, and API build. Confirm no real Evolution call occurs in tests. Commit only worker/repository/app files: `git commit -m "feat(campaigns): deliver queued messages with channel pacing"`.

### Task 6: Add pause, resume, cancel and safe legacy handling

**Files:** Create `apps/api/src/modules/campaigns/campaign-controls.service.ts` and test; modify `campaigns.routes.ts`, `campaigns.service.ts`, `apps/web/src/app/api.ts`.

- [ ] **Step 1: Write failing tests.** Pause prevents the next claim; resume keeps saved random draws and moves due times forward; cancel changes only pending rows; sent rows remain immutable; an already in-flight attempt may finish after pause and appears in the UI. Workspace A cannot change workspace B. Legacy `/send-real` cannot call `evolution.client.sendText` synchronously.
- [ ] **Step 2: Run** `pnpm --filter @prymeira-talk/api test -- campaign-controls.service.test.ts campaigns.service.test.ts`; expect new tests to fail.
- [ ] **Step 3: Implement state transitions.** Add `POST /campaigns/:id/pause`, `/resume`, `/cancel-remaining`, and `GET /campaigns/:id/progress`. Use workspace-scoped `updateMany` conditions so a stale UI cannot change an already completed campaign. Cancel all `pending` rows in a transaction; never delete rows or rewrite `sent`. Resume computes the next legal instant from now and stored timezone, shifting future timestamps only forward. The progress response is:

```ts
type CampaignProgress = {
  status: "draft" | "scheduled" | "sending" | "paused" |
    "completed" | "failed" | "canceled" | "needs_attention";
  total: number; sent: number; pending: number; skipped: number;
  failed: number; uncertain: number; nextScheduledAt: string | null;
};
```

Keep `/send-real` as an explicit `409 CAMPAIGN_REVIEW_REQUIRED` for older clients until they use `activate`; do not silently translate an unreviewed click into queued sends. Preserve the Meta template endpoint unchanged.
- [ ] **Step 4: Verify.** Run controls/route/service tests and API build. Test pause/cancel while a fake provider promise is held; expect no second send, and correct count when the first settles.
- [ ] **Step 5: Commit.** `git add apps/api/src/modules/campaigns apps/web/src/app/api.ts && git commit -m "feat(campaigns): control and inspect active queues"`.

### Task 7: Build the guided Evolution editor

**Files:** Create `apps/web/src/features/campaigns/GuidedCampaignEditor.tsx`, `CampaignReview.tsx`, `GuidedCampaignEditor.test.tsx`; modify `CampaignsPage.tsx`, `apps/web/src/styles.css`, and `apps/web/src/app/api.ts`.

- [ ] **Step 1: Write failing UI tests.** Assert three ordered stages; a Leads draft says “Leads”, not “Excel/CSV”; 26 selected versus 2 eligible is visibly distinguished when provenance exists; old drafts say original selection unavailable; no real-send button appears before step 3; zero verified disables activation; unverified/verification failure are distinct; saving a future date keeps “Rascunho”; final button says `Agendar 2 mensagens` or `Iniciar envio para 2 contatos`. Test keyboard focus and alert text, not CSS color alone.
- [ ] **Step 2: Run** `pnpm --filter @prymeira-talk/web test -- GuidedCampaignEditor.test.tsx`; expect the missing component failure.
- [ ] **Step 3: Implement the three stages as focused components.** `GuidedCampaignEditor` owns `{ stage: 1 | 2 | 3, preview, form, validation }`; `CampaignReview` is a pure read-only summary plus an unchecked-by-default confirmation checkbox stating that the operator reviewed the audience and message and has authorization to contact recipients. Route Evolution campaigns to the guided editor, retain the existing Meta-specific UI. Use existing Prymeira Talk colors and component conventions rather than a new design system. Replace the confusing common labels with `Destinatários`, `Mensagem e horário`, `Revisar e enviar`, `Verificar novamente`, `Salvar rascunho`, and `Pausar fila`. The default cadence from Task 2 is loaded for new drafts, not silently substituted into old saved campaigns.

```tsx
const canActivate = stage === 3 && preview.eligible.length > 0 &&
  preview.excluded.every(item => item.reason !== "verification_error") &&
  confirmed && !isSaving && !hasUnresolvedVariables;
<button type="button" disabled={!canActivate} onClick={activateCampaign}>
  {form.startMode === "scheduled"
    ? `Agendar ${preview.eligible.length} mensagens`
    : `Iniciar envio para ${preview.eligible.length} contatos`}
</button>
```

- [ ] **Step 4: Add progress page and verify.** Poll `GET /progress` while active, show next send/counts/reasons and pause/resume/cancel remaining. After a transition, refetch from server instead of assuming success. Run web tests, `pnpm --filter @prymeira-talk/web build`, and responsive keyboard/browser checks at desktop and mobile widths. Expect no button to call the old `/send-real` endpoint.
- [ ] **Step 5: Commit.** `git add apps/web/src/features/campaigns apps/web/src/app/api.ts apps/web/src/styles.css && git commit -m "feat(campaigns): guide review and scheduling"`.

### Task 8: Cross-layer safety and release verification

**Files:** Add `apps/api/src/modules/campaigns/campaign-flow.integration.test.ts`; update deployment notes under `docs/` only if necessary.

- [ ] **Step 1: Write an end-to-end API integration test with disposable PostgreSQL and fake Evolution.** The fixture contains two confirmed phones, one unverified and one duplicate, two workspaces, a future start and deterministic draws. Assert no sends before activation/start, no sends outside the window, two eventual sends, channel pacing, pause/resume, and no duplicates after worker restart or repeated activation. Assert the old `/send-real` returns 409. Do not use production credentials.
- [ ] **Step 2: Run the integration test and full suites.** `pnpm --filter @prymeira-talk/api test`, `pnpm --filter @prymeira-talk/web test`, `pnpm -r build`, `git diff --check`. Expected: all pass; no skipped new safety test.
- [ ] **Step 3: Inspect the diff against every acceptance criterion in the spec.** Verify database migration is additive, old `scheduled` rows have no new queue and do not auto-send, Meta template sending still behaves as before, all new routes filter workspace, no log includes message content/credentials, and no test sends real WhatsApp. Fix discrepancies before commit.
- [ ] **Step 4: Commit.** `git add apps/api/src/modules/campaigns docs && git commit -m "test(campaigns): cover guided queue lifecycle"`.
- [ ] **Step 5: Deploy safely only after review.** Publish images from the exact tested commit. Deploy the additive migration first, then API, then web; keep a rollback image. Verify `/ready`, new draft/preview/activation in a disposable or explicitly approved test workspace using a fake provider, and Portainer worker logs. Never activate the user's production leads or send real WhatsApp as a deployment test. Check for other concurrent Prymeira deployments immediately before each Portainer change.
