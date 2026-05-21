# Local Demo Analysis Report

## Environment

- Date: 2026-05-21
- API URL: http://localhost:3002
- Web URL: http://localhost:5176
- Workspace: local_workspace
- Auth mode: local bypass
- Database: local Docker Postgres on port 54329

## Automated Verification

- `pnpm test`: passed before browser review.
- `pnpm typecheck`: passed before browser review.
- `pnpm build`: passed before browser review.
- `pnpm --filter @prymeira-talk/api seed:demo`: passed with `Seeded 5 demo conversations for local_workspace.`

## Setup Fix Applied During Review

- The local UI initially stopped at `Configure VITE_CLERK_PUBLISHABLE_KEY.`
- Root cause: `AuthProvider` required Clerk configuration before local bypass could render the app.
- A second issue appeared after that: feature pages imported Clerk `useAuth` directly, which fails outside `<ClerkProvider>`.
- Final fix: feature pages now use `useTalkAuth`, which delegates to Clerk in normal mode and returns a demo JWT-like local token during bypass.
- Added `apps/web/src/app/auth.test.tsx` to cover local bypass rendering and token behavior.

## Module Findings

### Atendimento

- Status: passed_with_notes
- Working:
  - Conversation list loads seeded conversations.
  - Selecting Ana Beatriz loads message history and contact context after the local auth fix.
  - Outbound message `Teste local da bancada` persisted and updated the list preview.
  - Realtime status changed from `Conectando` to `Online` after the token fix.
- Simulated:
  - AI suggestion action is simulated by the API.
- Broken:
  - Before the JWT-like local token fix, note/assignment-style actions returned `Failed to run conversation action: 409` because the backend could not resolve a current user.
- Notes:
  - API note creation works with the new local token and user `demo_agent_marina`.
  - Browser wait for the note text was flaky during review, so note persistence was also verified through the API.

### Contatos

- Status: passed_with_notes
- Working:
  - Contact list loads seeded contacts.
  - Creating `Teste Bancada` through the UI succeeded and updated totals.
  - Opening the contact drawer works.
- Simulated:
  - Board movement uses local persisted board membership state, not an external provider.
- Broken:
  - Board view loaded all stages but showed zero cards, so the UI move action could not be completed from the board.
  - The edit form showed `Contato atualizado.`, but the updated company value did not visibly replace `Prymeira Local` in the list during the browser pass.
- Notes:
  - This module is useful for analysis, but board membership display needs attention before relying on visual stage movement.

### Canais

- Status: passed_with_notes
- Working:
  - Channel list loads the demo Evolution channel in the UI.
  - API QR generation returns `mode=simulated`.
  - API reconnect, disconnect, and test inbound endpoints execute.
- Simulated:
  - QR flow and inbound message creation are controlled Evolution simulations.
- Broken:
  - The browser UI became stuck on `Carregando canais...` after attempting the reconnect flow, while the API remained healthy.
- Notes:
  - Treat the backend channel simulation as usable, but review the UI loading state around channel actions.

### Automacoes

- Status: passed_with_notes
- Working:
  - Existing rule `Boas-vindas local` loads.
  - UI enable action changed the rule to active and updated the active count.
  - API manual test completed and run history increased to 2 runs.
- Simulated:
  - Automation runner persists simulated run results.
- Broken:
  - The UI did not expose a visible manual test/run history area in the first viewport; API verification was required.
- Notes:
  - The module has a functional backend loop, but the UI should make test execution and run history easier to inspect.

### Disparos

- Status: passed_with_notes
- Working:
  - Campaign list endpoint loads existing campaigns.
  - API campaign creation succeeded for a local bench campaign.
  - Audience resolution returned 6 contacts.
  - Simulated send created 6 recipients with `sent_simulated`.
  - UI route opens and renders the campaign editor, preview, scheduling control, and action buttons.
- Simulated:
  - Delivery mode is `simulated`.
- Broken:
  - UI showed `0` campaigns and a persistent `CARREGANDO` state even though the API returned campaigns.
  - Audience board select appeared empty, leaving save/simulate/resolve controls disabled in the visual pass.
- Notes:
  - Backend campaign workflow is ready for analysis, but the Disparos UI data-loading path needs debugging before visual analysis is reliable.

### Relatorios

- Status: passed_with_notes
- Working:
  - Reports overview endpoint returned cards, status breakdowns, message direction breakdowns, campaign results, automation runs, time series, departments, tags, and channels.
  - Metrics reflected bench activity: 6 conversations, 18 messages, 12 campaign recipients, and 2 automation runs after the API smoke pass.
  - UI rendered the same metrics, including department/tag/channel tables and export buttons.
- Simulated:
  - Campaign and automation report data includes simulated delivery/run results.
- Broken:
  - The header still displayed `Carregando` while report data was already visible.
- Notes:
  - Backend aggregation is useful for local analysis.

### Equipe

- Status: passed_with_notes
- Working:
  - Team users endpoint returned 3 demo users.
  - Department list endpoint returned seeded departments.
  - Creating a `Bancada Local ...` department succeeded through the API.
  - UI rendered users, presence, role selectors, department creation form, and the newly created department.
- Simulated:
  - Presence values are seeded/demo state.
- Broken:
  - The user table is horizontally constrained; role controls are present in the accessibility tree but partially hidden visually at the default Chrome window width.
- Notes:
  - Backend team management is operational for local owner role.

### IA

- Status: passed_with_notes
- Working:
  - Assistant action creation completed through the API.
  - Action history endpoint returned 6 total actions after the smoke pass.
  - UI rendered the simulated action form and visible IA logs with result text.
- Simulated:
  - Assistant mode is `simulated`.
- Broken:
  - No blocker found in the visual pass.
- Notes:
  - The simulated action log is enough for analysis of UI copy and history structure.

### Atomic CRM

- Status: passed_with_notes
- Working:
  - Link contact, create lead, and create note all completed through the API.
  - Sync history for the tested contact returned 3 actions.
  - UI rendered CRM actions and sync action rows.
- Simulated:
  - CRM actions run in simulated mode.
- Broken:
  - UI displayed `Carregando` in the status column for sync actions even when the API returned completed simulated actions.
  - Lead and note buttons are disabled until a valid contact id is supplied manually.
- Notes:
  - Backend CRM simulation is functional enough for the next UI analysis pass.

### Ajustes

- Status: passed_with_notes
- Working:
  - Settings endpoint returned workspace/integration settings.
  - Updating Evolution integration mode to `simulated` succeeded through the API.
  - Audit log returned 2 entries after settings actions.
  - UI rendered workspace data, integration form, and audit log entries.
- Simulated:
  - Integration config remains in simulated mode.
- Broken:
  - Header still displayed `Carregando` while settings and audit data were already visible.
- Notes:
  - Settings and audit trail are available for local analysis.

## Console And Network Issues

- Initial UI console errors came from Clerk `useAuth` outside `<ClerkProvider>` during local bypass; fixed by `useTalkAuth`.
- Browser plugin automation timed out repeatedly when opening `Disparos`; Chrome/Computer Use fallback completed the remaining visual pass.
- Canais UI showed a persistent loading state after a reconnect attempt, while channel API actions continued to succeed.
- Several modules show stale `Carregando` labels even after data renders.

## Production-Readiness Candidates

1. Local auth bypass hardening: keep `useTalkAuth` as the app auth boundary and add coverage for modules that need current-user actions.
2. Contact board reliability: investigate why board view shows zero cards after seeded/demo contact data exists.
3. Channel UI loading states: ensure reconnect/QR/disconnect actions always settle visually and expose errors.
4. Campaign UI data loading: fix the Disparos screen so campaign counts, campaign list, board select, and enabled actions reflect API data.
5. Manual test surfaces: make automation run history and manual test controls obvious in the Automacoes UI.
6. Loading-state cleanup: remove stale `Carregando` badges/labels once module data has rendered.
