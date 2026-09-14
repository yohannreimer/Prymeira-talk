# Assisted History Implementation Plan

> **For agentic workers:** Use executing-plans inline. The user explicitly chose sequential execution; do not delegate.

**Goal:** Import 30 days of matching Evolution history without replaying it, then use it for private suggestions.

**Architecture:** Read-only source adapter; transactional importer; optional pre-generation hook. Reuse message normalization and existing media readers. Opt-in per channel, never global enablement.

**Tech Stack:** TypeScript, Prisma/PostgreSQL, Vitest, Evolution 2.4, existing private assistant scheduler.

---

### 1. Source contract and normalization

- [ ] Add `apps/api/src/modules/evolution/evolution-history.test.ts`: fixtures contain `key.id`, `key.remoteJid`, `key.fromMe`, `messageTimestamp` and message content. Assert exact contact isolation, 30-day bounds, chronological order, duplicate IDs, two equal pagination passes, timeout/shape/size failures.
- [ ] Run `pnpm --filter @prymeira-talk/api exec vitest run src/modules/evolution/evolution-history.test.ts`; verify failure before implementation.
- [ ] Add `evolution-history.ts`: `createEvolutionHistorySource({baseUrl,apiKey,fetch})` exposes only `load({instanceName,anchorId,from,to})` and `media({instanceName,id})`. Requests only `/chat/findMessages/` and `/chat/getBase64FromMediaMessage/`, 15-second timeout, 100 records/page, at most 50 pages and three convergence passes; validate all records before returning.
- [ ] Export existing `extractMessageContent` from `evolution.routes.ts` for reuse without a separate divergent parser. Unsupported content gets an explicit placeholder.
- [ ] Run source tests and typecheck.

### 2. Transactional importer

- [ ] Add `assistant-history.ts` and tests. Source/clock/media processing are dependencies; no send/action dependencies.
- [ ] Resolve opted-in channel and earliest live message. Use the source record ID to obtain exact JID/confirmed alternate identity. Window ends at that live message, starts 30 days earlier. Store original timestamps, provider IDs, direction and import provenance; check conflicts before `createMany({skipDuplicates:true})`.
- [ ] Lock conversation, reread completion marker and metadata; preserve live changes. Write a source-bound completion marker on the anchor only after all inserts succeed. Do not modify conversation summary/unread/control or schedule per imported message.
- [ ] Test a second run inserts zero; assert no conversation mutation API is called. Missing source or conflict raises a sanitized assistant error. Document unavailable media distinctly.

### 3. Preparation hook and opt-in

- [ ] Add optional `prepareContext(workspaceId,conversationId)` to assistant scheduler, invoked after lease acquisition and before loading current context. Error stops generation and appears via existing `AssistantError` handling.
- [ ] Wire in `app.ts` only for real Evolution. `channel.encryptedConfig.assistantHistory.days === 30` enables the importer; all other channels remain unchanged. Preserve human-control behavior and stale-context checks.
- [ ] Add tests proving preparation precedes model invocation and failure never calls the model; retain existing scheduler tests.

### 4. Real import and publication

- [ ] Run targeted tests, full API suite, typecheck and diff-check. Save scoped source/test commit; exclude dirty prompt candidates and unrelated fixes.
- [ ] Execute a dry-run of the same importer against Diogo's current conversations. Verify identities/counts and available attachments before writes. Preserve a private manifest and before-state.
- [ ] Import current conversations and regenerate only private drafts where the latest real message is inbound and human control is released. Compare before/after counts, source IDs, and no-send audit; verify visible history in Talk.
- [ ] Publish tested code through existing image workflow and update only API service to immutable tag. Enable channel opt-in after verifying version; do not claim automatic import before this step is confirmed. Keep pending items explicitly recorded if deployment cannot proceed.

## Review

Scope is approved 30-day context import, not global history ingestion, automatic sends, broader media conversion or agent prompt changes. Source grouping comes from provider IDs rather than guessed phone identities. Existing context limits stay explicit. Missing provider history does not justify fabricated continuity.
