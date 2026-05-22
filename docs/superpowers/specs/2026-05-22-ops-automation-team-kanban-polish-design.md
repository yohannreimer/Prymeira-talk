# Ops Automation, Team, and Kanban Polish Design

## Context

The local demo bench is functional enough for analysis, but three areas still slow the operator down:

- Automations can be created, edited, and toggled, but manual testing and run history are not visible in the main workflow.
- Team users render in a table that can constrain role controls at normal desktop widths and collapses awkwardly on small screens.
- Contact board movement works with arrow buttons, but the expected Kanban interaction is drag and drop.

This design keeps the existing visual language: dense operational panels, restrained colors, familiar controls, and no marketing-style layout.

## Goals

1. Make automation testing and execution history obvious from the Automations page.
2. Make the Team users surface readable and usable across desktop and narrow widths.
3. Add high-quality drag and drop to the Contacts board while preserving accessible button movement.
4. Keep all changes local to existing modules and API clients where possible.

## Non-Goals

- No new backend endpoints.
- No workflow builder with multi-step branching.
- No board creation or stage management UI.
- No redesign of the full app shell.
- No real external automation, CRM, or WhatsApp provider integration in this pass.

## Automations Design

The Automations page will add a visible `Teste & histórico` panel next to or below the rule editor depending on viewport width.

The panel will include:

- A `Testar agora` button for the selected automation.
- A small event key input with a sensible default based on the selected trigger.
- A run summary row showing the latest status after a manual test.
- A history list loaded from `apiGetAutomationRuns`.
- Empty, loading, success, and error states that match the existing module panel language.

Manual test flow:

1. User selects an automation.
2. UI loads its run history.
3. User clicks `Testar agora`.
4. UI calls `apiTestAutomation`.
5. The returned run is prepended or merged into the history list.
6. Notice/status copy confirms the local runner completed.

## Team Design

The Team users panel will remain compact on desktop, but the role control must no longer be clipped.

Desktop layout:

- Header row with `Nome`, `Presença`, and `Role`.
- Wider role column with a full-width select.
- Long Clerk IDs truncate cleanly below the display name.

Narrow layout:

- User rows become compact cards.
- Each card shows display name, Clerk ID, presence badge, and role select in a two-row layout.
- The table header is hidden on small screens.

The department form/list stays structurally the same, with only spacing adjustments if needed for the responsive grid.

## Contacts Kanban Design

The Contacts board will use `@dnd-kit/core` and `@dnd-kit/sortable` for drag and drop.

Interaction behavior:

- Contact cards can be dragged between stage columns.
- Dropping on a different stage calls the existing `apiMoveBoardMembership`.
- Dropping in the same stage does nothing.
- While saving, the board disables repeated moves and keeps existing arrow controls disabled.
- If a move fails, the UI shows the existing board error and keeps/reloads a consistent board state.

Accessibility and fallback:

- Existing previous/next buttons remain available.
- Drag handles will expose clear labels where practical.
- Keyboard users still have a reliable path through the arrow buttons.

Visual behavior:

- Dragged cards get a lifted state.
- Active drop columns get a subtle highlight.
- Empty columns remain valid drop targets.
- Mobile/narrow board layout must remain usable with horizontal or single-column scrolling, following the current responsive behavior.

## Data Flow

Automations:

- `apiGetAutomations` loads rules.
- `apiGetAutomationRuns(getToken, selectedAutomation.id)` loads history when selection changes.
- `apiTestAutomation(getToken, selectedAutomation.id, { eventKey, input })` creates or updates a run.

Team:

- Existing `apiGetTeamUsers`, `apiGetTeamDepartments`, `apiUpdateTeamUserRole`, and `apiCreateTeamDepartment` remain unchanged.
- Only rendering and responsive CSS change.

Contacts:

- Existing board data shape stays unchanged.
- A small pure helper will resolve drag targets to a membership/stage move.
- `apiMoveBoardMembership` persists the stage move.
- Local `boardContacts` state updates from the returned membership.

## Testing

Unit or component-adjacent tests will cover pure state/helpers where the current web test setup supports it:

- Automation run merge/default event helpers.
- Team layout helper if extracted for responsive-safe rendering decisions.
- Contacts drag move resolution helper: same-stage no-op, valid cross-stage move, invalid drag target ignored.

Manual/browser verification will cover:

- Automation test button creates a visible run and history updates.
- Team page at desktop and narrow viewport has visible role controls.
- Contacts board drag moves a contact between stages and arrow fallback still works.

Full verification before completion:

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- Browser pass on `?module=automacoes`, `?module=equipe`, and `?module=contatos`

## Dependencies

Add frontend dependencies:

- `@dnd-kit/core`
- `@dnd-kit/sortable`
- `@dnd-kit/utilities`

These are scoped to the web app and used only by the Contacts board in this pass.

## Risks

- Drag and drop can create accidental state drift if optimistic updates are too eager. This pass will update from the API response and avoid complex reordering.
- Installing dependencies changes the lockfile. That is expected and should be reviewed.
- Browser verification may need the existing local API/web servers to be running.
