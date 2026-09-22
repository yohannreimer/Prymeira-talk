# Leads List Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show three recent lead lists by default, reveal older lists on demand, and safely delete eligible lists with confirmation.

**Architecture:** Keep pagination and selected-list state in `LeadsPage`; keep sidebar expansion and per-row controls in `LeadListSidebar`. Reuse the existing DELETE route, adding transactional guards in the repository. Do not add a database column or migration.

**Tech Stack:** React/TypeScript, Fastify, Prisma/PostgreSQL, Vitest.

---

### Task 1: Guard list deletion in the API

**Files:**
- Modify: `apps/api/src/modules/leads/leads.repository.ts:403`
- Modify: `apps/api/src/modules/leads/leads.repository.test.ts:178`
- Modify: `apps/api/src/modules/leads/leads.routes.test.ts`

- [ ] **Step 1: Write failing repository and route tests.** Add cases with a list owned by the caller, `leadJob.count` returning 1 for `queued`/`running`, and `leadContactProvenance.count` returning 1. Assert each rejects with `LEAD_INVALID_TRANSITION`, does not call `deleteMany`, and the route returns 409. Preserve the foreign-workspace 404 case. Example assertion:

```ts
await expect(repository.deleteList(workspaceId, listId)).rejects.toMatchObject({ code: "LEAD_INVALID_TRANSITION" });
expect(deleteMany).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the failing tests.** Run `pnpm --filter @prymeira-talk/api exec vitest run src/modules/leads/leads.repository.test.ts src/modules/leads/leads.routes.test.ts`; expect the new guard cases to fail.
- [ ] **Step 3: Replace `deleteList` with a serializable transaction.** Within `this.prisma.$transaction`, first `findFirst({ where: { workspaceId, id: listId } })`, then count active jobs with `status: { in: ["queued", "running"] }` and provenance rows with the same workspace/list ID. Throw `LeadsDomainError("LEAD_INVALID_TRANSITION", "Aguarde a busca ou verificação em andamento antes de excluir esta lista.")` for active jobs and `LeadsDomainError("LEAD_INVALID_TRANSITION", "Esta lista já originou contatos e não pode ser excluída.")` for provenances. Only then call `tx.leadList.deleteMany({ where: { workspaceId, id: listId } })`; pass `{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }`. Map a foreign-key violation or serialization conflict to a safe 409, never to a successful deletion.
- [ ] **Step 4: Run the same tests until green.** Confirm the route's existing `domainStatus` maps `LEAD_INVALID_TRANSITION` to 409; no new route is needed.
- [ ] **Step 5: Commit.** `git add apps/api/src/modules/leads/leads.repository.ts apps/api/src/modules/leads/leads.repository.test.ts apps/api/src/modules/leads/leads.routes.test.ts && git commit -m "fix(leads): guard list deletion against active and imported data"`.

### Task 2: Add paginated Web API calls

**Files:**
- Modify: `apps/web/src/app/api.ts:3464`
- Test: `apps/web/src/features/leads/LeadsPage.test.tsx`

- [ ] **Step 1: Add a failing UI test** that mocks `apiGetLeadLists` for page 1 and page 2, expands “Ver todas”, clicks “Carregar mais”, and asserts the list from page 2 is visible.
- [ ] **Step 2: Run the test.** `pnpm --filter @prymeira-talk/web exec vitest run src/features/leads/LeadsPage.test.tsx`; expect failure because the controls do not exist.
- [ ] **Step 3: Add the client functions.** `apiGetLeadLists` has only one current caller (`LeadsPage`), so replace the optional source argument with page/page size. Handle DELETE 204 without `fetchJson` because it always parses JSON:

```ts
export function apiGetLeadLists(getToken: TokenProvider, page = 1, pageSize = 50): Promise<LeadListDto[]> {
  return fetchJson(getToken, `/leads/lists?page=${page}&pageSize=${pageSize}`, {},
    value => leadListSchema.array().parse(value), "Não foi possível carregar listas.");
}

export async function apiDeleteLeadList(getToken: TokenProvider, listId: string): Promise<void> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/leads/lists/${leadPath(listId)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new ApiRequestError(await readApiErrorMessage(response, "Não foi possível excluir a lista."));
}
```

- [ ] **Step 4: Typecheck and commit.** Run `pnpm --filter @prymeira-talk/web typecheck`; then commit `apps/web/src/app/api.ts` with `feat(leads): add paginated lists and delete client`.

### Task 3: Build compact sidebar and confirmation UI

**Files:**
- Modify: `apps/web/src/features/leads/LeadListSidebar.tsx`
- Modify: `apps/web/src/features/leads/LeadsPage.tsx`
- Modify: `apps/web/src/styles.css:7848`
- Test: `apps/web/src/features/leads/LeadsPage.test.tsx`

- [ ] **Step 1: Add failing tests.** Seed four lists and assert three visible by default; expand and assert four; cancel exclusion and assert no API call; confirm exclusion and assert `apiDeleteLeadList(getToken, id)` called once. Cover selected-list replacement, 409 keeping the list, and empty state after last list.
- [ ] **Step 2: Run the test file and observe failures.** Use the command from Task 2.
- [ ] **Step 3: Implement sidebar controls.** Replace each row's single button with a non-nested selection button plus sibling “Excluir lista” button. Pass `expanded`, `hasMore`, `loadingMore`, `onToggleExpanded`, `onLoadMore`, and `onRequestDelete` from `LeadsPage`. Render `lists.slice(0, 3)` when collapsed and all loaded lists when expanded. Label count as `${lists.length}+` while `hasMore`; show “Ver todas”/“Mostrar menos” only when more than three loaded or another page exists.
- [ ] **Step 4: Implement page state.** Add `expanded`, `loadedPages`, `hasMore`, `loadingMore`, `deleteTarget: LeadListDto | null`. `refreshLists` reloads pages 1 through `loadedPages`, de-duplicates IDs, and publishes the merged result atomically so polling never discards an older selected list; `loadMore` reads page `loadedPages + 1` and updates `hasMore` from page length. On successful deletion, reload the same number of pages, remove the old selected ID, clear `items`, `selected`, `jobs`, `verificationJobs`, `similar`, and choose the first remaining list. On error, keep state unchanged and show the API message. Add a confirmation dialog naming the target and explaining permanent removal. Do not enable confirmation while `busy`.
- [ ] **Step 5: Style and verify.** Add focus-visible, hover, disabled, and responsive styles adjacent to `.leads-list-item`. Run Web tests and `pnpm --filter @prymeira-talk/web typecheck`; inspect the desktop and mobile layout in a local preview if available.
- [ ] **Step 6: Commit.** Commit sidebar, page, CSS, and tests as `feat(leads): organize and safely delete lead lists`.

### Task 4: Regression verification

**Files:** No source changes unless tests reveal a defect.

- [ ] Run `pnpm --filter @prymeira-talk/api test` and `pnpm --filter @prymeira-talk/web test`.
- [ ] Run `pnpm --filter @prymeira-talk/api typecheck` and `pnpm --filter @prymeira-talk/web typecheck`.
- [ ] Run `pnpm --filter @prymeira-talk/web build` and inspect `git diff --check` plus `git status --short`.
- [ ] Check the spec line by line, including imported-contact restriction and more-than-50 pagination. Report any unverified production behavior rather than claiming deployment.
