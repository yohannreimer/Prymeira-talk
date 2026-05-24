# Automation UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Automacoes open on a flow hub, then enter a dedicated editor, with an optional focus mode for the canvas.

**Architecture:** Keep the existing API and automation payload model unchanged. Refactor `AutomationsPage` into a view-state controller (`hub`, `editor`, `focus`) and make `AutomationCanvas` support compact/focus layouts while preserving node/edge behavior. CSS owns the viewport layout so React Flow does not live inside a long scrolling page.

**Tech Stack:** React, TypeScript, Vite, Vitest, Testing Library, `@xyflow/react`, existing Prymeira Talk CSS tokens.

---

## File Structure

- Modify `apps/web/src/features/automations/AutomationsPage.tsx`
  - Owns view mode, hub cards, editor shell, focus toggle, status actions, save/test flows.
- Modify `apps/web/src/features/automations/AutomationCanvas.tsx`
  - Adds `variant`, `isLibraryCollapsed`, `onToggleLibrary`, and `onRequestFocus` props.
  - Keeps all graph state and serialization behavior intact.
- Modify `apps/web/src/features/automations/AutomationBlockLibrary.tsx`
  - Adds compact presentation hooks and a small search field if not already present.
- Modify `apps/web/src/styles.css`
  - Replaces the three-column automation layout with hub/editor/focus viewport layouts.
- Modify `apps/web/src/features/automations/AutomationsPage.test.tsx`
  - Adds tests for hub-first navigation, editor opening, returning, focus mode, and save payload continuity.

## Task 1: Hub-First State Model

**Files:**
- Modify: `apps/web/src/features/automations/AutomationsPage.tsx`
- Test: `apps/web/src/features/automations/AutomationsPage.test.tsx`

- [ ] **Step 1: Add a failing unit test for hub-first navigation**

Append this test block to `AutomationsPage.test.tsx`. Mock the auth hook and API calls in the same style as existing API tests if a render helper already exists; if not, add local mocks in this file.

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../app/auth", () => ({
  useTalkAuth: () => ({ getToken: async () => "token" })
}));

vi.mock("../../app/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../app/api")>();
  return {
    ...original,
    apiGetAutomations: vi.fn(),
    apiGetAutomationRuns: vi.fn().mockResolvedValue([])
  };
});

describe("AutomationsPage navigation", () => {
  it("opens on the hub and enters the editor when a flow is selected", async () => {
    vi.mocked(apiGetAutomations).mockResolvedValue([baseAutomation]);

    render(<AutomationsPage />);

    expect(await screen.findByRole("heading", { name: "Automações" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Boas-vindas/i })).toBeInTheDocument();
    expect(screen.queryByText("Gatilho do canvas")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Boas-vindas/i }));

    expect(await screen.findByRole("heading", { name: /Editar fluxo/i })).toBeInTheDocument();
    expect(screen.getByText("Gatilho do canvas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Voltar para automações/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "opens on the hub"
```

Expected: fails because `AutomationsPage` currently renders the editor immediately.

- [ ] **Step 3: Add view mode state and hub entry points**

In `AutomationsPage.tsx`, add:

```ts
type AutomationViewMode = "hub" | "editor" | "focus";
```

Inside `AutomationsPage`, add:

```ts
const [viewMode, setViewMode] = useState<AutomationViewMode>("hub");
const isEditingAutomation = viewMode === "editor" || viewMode === "focus";
```

Update automation selection so loading no longer auto-opens the editor:

```ts
setSelectedAutomationId((current) =>
  nextAutomations.some((automation) => automation.id === current)
    ? current
    : nextAutomations[0]?.id ?? null
);
setViewMode("hub");
```

Add handlers:

```ts
function openAutomation(automationId: string) {
  setSelectedAutomationId(automationId);
  setViewMode("editor");
}

function closeEditor() {
  setViewMode("hub");
}

function enterFocusMode() {
  setViewMode("focus");
}

function exitFocusMode() {
  setViewMode("editor");
}
```

Change `createDraft` so it opens the editor:

```ts
async function createDraft() {
  setSelectedAutomationId(null);
  setForm(emptyForm);
  setFlowPayload(null);
  setDraftVersion((current) => current + 1);
  setViewMode("editor");
  setNotice("Rascunho local pronto para edicao.");
}
```

- [ ] **Step 4: Split render into hub and editor sections**

In the returned JSX, replace the always-visible `.automations-layout` with conditional rendering:

```tsx
{isEditingAutomation ? (
  <AutomationEditorView
    canvasTriggerLabel={canvasTriggerLabel}
    draftVersion={draftVersion}
    enterFocusMode={enterFocusMode}
    exitFocusMode={exitFocusMode}
    form={form}
    isFocusMode={viewMode === "focus"}
    isSaving={isSaving}
    isTesting={isTesting}
    onBack={closeEditor}
    onCanvasChange={handleCanvasChange}
    onFormChange={setForm}
    onSave={saveAutomation}
    onTest={testSelectedAutomation}
    onToggleAutomation={toggleAutomation}
    runs={runs}
    selectedAutomation={selectedAutomation}
  />
) : (
  <AutomationHubView
    automations={automations}
    isLoading={isLoading}
    onCreate={createDraft}
    onOpen={openAutomation}
    runs={runs}
  />
)}
```

For this task, these can be local functions in the same file. Do not create new files until the component grows beyond what is comfortable to review.

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "opens on the hub"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/automations/AutomationsPage.tsx apps/web/src/features/automations/AutomationsPage.test.tsx
git commit -m "Refactor automations into hub and editor views"
```

## Task 2: Hub Cards and Empty State

**Files:**
- Modify: `apps/web/src/features/automations/AutomationsPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/features/automations/AutomationsPage.test.tsx`

- [ ] **Step 1: Add tests for hub cards and creating a draft**

Add:

```tsx
it("creates a draft from the hub and opens the editor", async () => {
  vi.mocked(apiGetAutomations).mockResolvedValue([]);

  render(<AutomationsPage />);

  expect(await screen.findByText("Nenhum fluxo criado")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /Criar fluxo/i }));

  expect(await screen.findByRole("heading", { name: /Novo fluxo/i })).toBeInTheDocument();
  expect(screen.getByDisplayValue("Boas-vindas local")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "creates a draft"
```

Expected: FAIL until hub empty state and draft open are wired.

- [ ] **Step 3: Implement `AutomationHubView` local component**

Add below helper functions in `AutomationsPage.tsx`:

```tsx
function automationStatusLabel(status: AutomationRuleDto["status"]) {
  return status === "enabled" ? "Ativo" : "Pausado";
}

function AutomationHubView({
  automations,
  isLoading,
  onCreate,
  onOpen
}: {
  automations: AutomationRuleDto[];
  isLoading: boolean;
  onCreate: () => void;
  onOpen: (automationId: string) => void;
}) {
  if (!isLoading && automations.length === 0) {
    return (
      <div className="automation-hub-empty">
        <div className="empty-state-icon">
          <Zap size={28} aria-hidden="true" />
        </div>
        <h2>Nenhum fluxo criado</h2>
        <p>Crie o primeiro fluxo para organizar boas-vindas, retornos e automacoes de atendimento.</p>
        <button className="primary-button" type="button" onClick={onCreate}>
          <Plus size={16} aria-hidden="true" />
          Criar fluxo
        </button>
      </div>
    );
  }

  return (
    <div className="automation-hub">
      <div className="automation-hub-toolbar">
        <div>
          <h2>Fluxos</h2>
          <p>{isLoading ? "Carregando automacoes" : `${automations.length} fluxo${automations.length === 1 ? "" : "s"}`}</p>
        </div>
      </div>
      <div className="automation-flow-grid">
        {automations.map((automation) => (
          <button
            className="automation-flow-card"
            key={automation.id}
            onClick={() => onOpen(automation.id)}
            type="button"
          >
            <span className={`status-badge status-badge--${automation.status === "enabled" ? "open" : "closed"}`}>
              {automationStatusLabel(automation.status)}
            </span>
            <strong>{automation.name}</strong>
            <small>{triggerOptions.find((option) => option.value === automation.trigger)?.label ?? automation.trigger}</small>
            <em>Abrir editor</em>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add hub CSS**

Append near automation styles:

```css
.automation-hub {
  display: grid;
  gap: 16px;
  padding: 0 18px 18px;
  min-height: 0;
}

.automation-hub-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.automation-hub-toolbar h2,
.automation-hub-empty h2 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 1.12rem;
}

.automation-hub-toolbar p,
.automation-hub-empty p {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: 0.9rem;
}

.automation-flow-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}

.automation-flow-card {
  display: grid;
  gap: 10px;
  min-height: 150px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface-card);
  padding: 16px;
  text-align: left;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast);
}

.automation-flow-card:hover {
  border-color: var(--color-brand-100);
  box-shadow: var(--shadow-card-hover);
  transform: translateY(-1px);
}

.automation-flow-card strong {
  color: var(--color-text-primary);
  font-size: 1rem;
}

.automation-flow-card small,
.automation-flow-card em {
  color: var(--color-text-secondary);
  font-size: 0.82rem;
  font-style: normal;
}

.automation-hub-empty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  min-height: calc(100vh - 160px);
  padding: 32px;
  text-align: center;
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "creates a draft|opens on the hub"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/automations/AutomationsPage.tsx apps/web/src/features/automations/AutomationsPage.test.tsx apps/web/src/styles.css
git commit -m "Add automation hub cards"
```

## Task 3: Dedicated Editor Shell and Status Language

**Files:**
- Modify: `apps/web/src/features/automations/AutomationsPage.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/features/automations/AutomationsPage.test.tsx`

- [ ] **Step 1: Add tests for back navigation and status copy**

Add:

```tsx
it("returns from editor to hub and labels status as flow state", async () => {
  vi.mocked(apiGetAutomations).mockResolvedValue([baseAutomation]);

  render(<AutomationsPage />);

  await userEvent.click(await screen.findByRole("button", { name: /Boas-vindas/i }));

  expect(screen.getByRole("button", { name: /Fluxo pausado/i })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /Voltar para automações/i }));

  expect(await screen.findByRole("button", { name: /Boas-vindas/i })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /Editar fluxo/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "returns from editor"
```

Expected: FAIL until editor shell and status copy exist.

- [ ] **Step 3: Implement `AutomationEditorView` local component**

Add this local component in `AutomationsPage.tsx` and move the existing form/canvas content into it:

```tsx
function AutomationEditorView({
  canvasTriggerLabel,
  draftVersion,
  enterFocusMode,
  exitFocusMode,
  form,
  isFocusMode,
  isSaving,
  isTesting,
  onBack,
  onCanvasChange,
  onFormChange,
  onSave,
  onTest,
  onToggleAutomation,
  selectedAutomation
}: {
  canvasTriggerLabel: string;
  draftVersion: number;
  enterFocusMode: () => void;
  exitFocusMode: () => void;
  form: AutomationFormState;
  isFocusMode: boolean;
  isSaving: boolean;
  isTesting: boolean;
  onBack: () => void;
  onCanvasChange: (payload: AutomationFlowDefinition) => void;
  onFormChange: React.Dispatch<React.SetStateAction<AutomationFormState>>;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onTest: () => void;
  onToggleAutomation: (automation: AutomationRuleDto) => void;
  selectedAutomation: AutomationRuleDto | null;
}) {
  const statusText = selectedAutomation
    ? selectedAutomation.status === "enabled"
      ? "Fluxo ativo"
      : "Fluxo pausado"
    : "Rascunho";

  return (
    <form className={`automation-editor-shell ${isFocusMode ? "is-focus-mode" : ""}`} onSubmit={onSave}>
      <div className="automation-editor-topbar">
        <button className="secondary-button" type="button" onClick={onBack}>
          Voltar para automações
        </button>
        <label className="automation-title-field">
          <span>Nome do fluxo</span>
          <input
            onChange={(event) => onFormChange((current) => ({ ...current, name: event.target.value }))}
            required
            value={form.name}
          />
        </label>
        {selectedAutomation ? (
          <button
            className="secondary-button"
            type="button"
            onClick={() => onToggleAutomation(selectedAutomation)}
            disabled={isSaving}
          >
            {statusText}
          </button>
        ) : (
          <span className="status-badge status-badge--closed">{statusText}</span>
        )}
        <button className="secondary-button" disabled={!selectedAutomation || isTesting} onClick={onTest} type="button">
          <Zap size={15} aria-hidden="true" />
          {isTesting ? "Testando" : "Testar"}
        </button>
        <button className="secondary-button" type="button" onClick={isFocusMode ? exitFocusMode : enterFocusMode}>
          {isFocusMode ? "Sair do foco" : "Modo foco"}
        </button>
        <button className="primary-button" disabled={isSaving} type="submit">
          <Save size={15} aria-hidden="true" />
          Salvar
        </button>
      </div>

      {!isFocusMode ? (
        <div className="automation-editor-meta">
          <label className="form-field">
            <span>Resumo das condições</span>
            <input
              onChange={(event) => onFormChange((current) => ({ ...current, conditionSummary: event.target.value }))}
              required
              value={form.conditionSummary}
            />
          </label>
          <div className="automation-flow-summary" aria-label="Resumo do fluxo">
            <span>Gatilho do canvas</span>
            <strong>{canvasTriggerLabel}</strong>
          </div>
        </div>
      ) : null}

      <AutomationCanvas
        key={selectedAutomation?.id ?? `new-automation-${draftVersion}`}
        onChange={onCanvasChange}
        value={selectedAutomation?.actions}
        variant={isFocusMode ? "focus" : "editor"}
      />
    </form>
  );
}
```

- [ ] **Step 4: Add editor shell CSS**

```css
.automation-editor-shell {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 10px;
  height: calc(100vh - 84px);
  min-height: 0;
  padding: 0 12px 12px;
}

.automation-editor-shell.is-focus-mode {
  grid-template-rows: auto minmax(0, 1fr);
}

.automation-editor-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface-card);
  padding: 10px;
}

.automation-title-field {
  display: grid;
  gap: 2px;
  min-width: 240px;
  flex: 1;
}

.automation-title-field span {
  color: var(--color-text-muted);
  font-size: 0.68rem;
  font-weight: 900;
  text-transform: uppercase;
}

.automation-title-field input {
  border: 0;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 1rem;
  font-weight: 800;
  outline: 0;
}

.automation-editor-meta {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(220px, 0.45fr);
  gap: 10px;
}
```

- [ ] **Step 5: Run the focused test**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "returns from editor"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/automations/AutomationsPage.tsx apps/web/src/features/automations/AutomationsPage.test.tsx apps/web/src/styles.css
git commit -m "Add dedicated automation editor shell"
```

## Task 4: Canvas Layout Variants and Visible Controls

**Files:**
- Modify: `apps/web/src/features/automations/AutomationCanvas.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/features/automations/AutomationsPage.test.tsx`

- [ ] **Step 1: Add test for focus mode toggle**

Add:

```tsx
it("toggles the automation editor into focus mode", async () => {
  vi.mocked(apiGetAutomations).mockResolvedValue([baseAutomation]);

  render(<AutomationsPage />);

  await userEvent.click(await screen.findByRole("button", { name: /Boas-vindas/i }));
  await userEvent.click(screen.getByRole("button", { name: /Modo foco/i }));

  expect(screen.getByRole("button", { name: /Sair do foco/i })).toBeInTheDocument();
  expect(screen.getByLabelText("Canvas da automacao")).toHaveClass("is-focus-mode");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "focus mode"
```

Expected: FAIL until `AutomationCanvas` exposes focus class.

- [ ] **Step 3: Add `variant` prop to `AutomationCanvas`**

Change props:

```ts
interface AutomationCanvasProps {
  value?: unknown;
  onChange: (payload: AutomationFlowDefinition) => void;
  variant?: "editor" | "focus";
}
```

Change signature:

```ts
export function AutomationCanvas({ value, onChange, variant = "editor" }: AutomationCanvasProps) {
```

Change shell:

```tsx
<div className={`automation-canvas-shell automation-canvas-shell--${variant}`}>
```

Change surface:

```tsx
<div
  className={`automation-canvas-surface ${variant === "focus" ? "is-focus-mode" : ""}`}
  aria-label="Canvas da automacao"
>
```

In focus mode, keep the inspector out of the grid:

```tsx
{variant === "editor" ? (
  <AutomationNodeInspector node={selectedNode} onConfigChange={updateConfig} />
) : null}
```

- [ ] **Step 4: Make canvas height viewport-bound**

Replace automation canvas CSS with:

```css
.automation-canvas-shell {
  display: grid;
  grid-template-columns: minmax(190px, 260px) minmax(420px, 1fr) minmax(220px, 300px);
  gap: 8px;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.automation-canvas-shell--focus {
  grid-template-columns: minmax(0, 1fr);
}

.automation-canvas-shell--focus .automation-block-library {
  display: none;
}

.automation-canvas-surface {
  position: relative;
  min-height: 0;
  height: 100%;
  background: #f8faf8;
}

.automation-canvas-surface .react-flow {
  width: 100%;
  height: 100%;
}

.automation-block-library,
.automation-node-inspector {
  min-height: 0;
  height: 100%;
}
```

- [ ] **Step 5: Run focus test**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "focus mode"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/automations/AutomationCanvas.tsx apps/web/src/features/automations/AutomationsPage.test.tsx apps/web/src/styles.css
git commit -m "Support automation canvas focus mode"
```

## Task 5: Compact Block Library and History Drawer

**Files:**
- Modify: `apps/web/src/features/automations/AutomationsPage.tsx`
- Modify: `apps/web/src/features/automations/AutomationBlockLibrary.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/features/automations/AutomationsPage.test.tsx`

- [ ] **Step 1: Add test that history is not permanently visible**

Add:

```tsx
it("keeps test history collapsed until requested", async () => {
  vi.mocked(apiGetAutomations).mockResolvedValue([baseAutomation]);

  render(<AutomationsPage />);

  await userEvent.click(await screen.findByRole("button", { name: /Boas-vindas/i }));

  expect(screen.queryByRole("heading", { name: /Teste & histórico/i })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /Histórico/i }));

  expect(screen.getByRole("heading", { name: /Teste & histórico/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "history"
```

Expected: FAIL until history drawer state exists.

- [ ] **Step 3: Add history drawer state and button**

Inside `AutomationsPage`:

```ts
const [isHistoryOpen, setIsHistoryOpen] = useState(false);
```

Pass it to `AutomationEditorView`, and add a topbar button:

```tsx
<button className="secondary-button" type="button" onClick={() => setIsHistoryOpen((current) => !current)}>
  Histórico
</button>
```

Render drawer only when open:

```tsx
{isHistoryOpen ? (
  <aside className="automation-history-drawer">
    <div className="panel-title-row">
      <h2>Teste & histórico</h2>
      <span>{runs.length} runs</span>
    </div>
    <button className="secondary-button" disabled={!selectedAutomation || isTesting} onClick={onTest} type="button">
      <Zap size={15} aria-hidden="true" />
      {isTesting ? "Testando" : "Testar agora"}
    </button>
    <div className="automation-run-list">
      {runs.length === 0 ? <p className="list-note">Nenhum teste executado.</p> : null}
      {runs.map((run) => (
        <article className="automation-run-card" key={run.id}>
          <strong>{run.status}</strong>
          <small>{formatAutomationRunDate(run.createdAt)}</small>
        </article>
      ))}
    </div>
  </aside>
) : null}
```

- [ ] **Step 4: Add drawer CSS**

```css
.automation-history-drawer {
  position: fixed;
  top: 86px;
  right: 16px;
  z-index: 20;
  display: grid;
  gap: 12px;
  width: min(340px, calc(100vw - 32px));
  max-height: calc(100vh - 108px);
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface-card);
  box-shadow: var(--shadow-drawer);
  padding: 14px;
}
```

- [ ] **Step 5: Run history test**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx -t "history"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/automations/AutomationsPage.tsx apps/web/src/features/automations/AutomationBlockLibrary.tsx apps/web/src/styles.css apps/web/src/features/automations/AutomationsPage.test.tsx
git commit -m "Collapse automation test history"
```

## Task 6: Full Verification and Browser Check

**Files:**
- Verify only unless a visual defect is found.

- [ ] **Step 1: Run automation tests**

Run:

```bash
pnpm --filter @prymeira-talk/web test -- AutomationsPage.test.tsx
```

Expected: all tests in the file pass.

- [ ] **Step 2: Run web test suite**

Run:

```bash
pnpm --filter @prymeira-talk/web test
```

Expected: all web tests pass.

- [ ] **Step 3: Build web app**

Run:

```bash
pnpm --filter @prymeira-talk/web build
```

Expected: Vite build succeeds. Existing chunk-size warnings are acceptable.

- [ ] **Step 4: Start local dev server**

Run:

```bash
pnpm --filter @prymeira-talk/web dev -- --host 127.0.0.1
```

Expected: Vite serves a localhost URL.

- [ ] **Step 5: Browser verify**

Open the local app and verify:

- Automacoes opens on the hub.
- Clicking a card opens the editor.
- Back returns to hub.
- Modo foco expands the canvas.
- Sair do foco returns to the normal editor.
- Historico opens as a drawer.
- Adding a block places it visibly inside the canvas.

- [ ] **Step 6: Final status**

Run:

```bash
git status --short
git diff --check
```

Expected: only intended files changed and no whitespace errors.

- [ ] **Step 7: Commit fixes if visual verification required adjustments**

```bash
git add apps/web/src/features/automations apps/web/src/styles.css
git commit -m "Polish automation builder layout"
```
