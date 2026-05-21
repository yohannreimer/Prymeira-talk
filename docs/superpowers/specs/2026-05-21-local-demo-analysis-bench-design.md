# Local Demo Analysis Bench Design

## Goal

Create a reliable local analysis bench for Prymeira Talk so the app can be opened, seeded with demo data, and reviewed module by module before deeper production work starts.

This phase is not about connecting every external provider for real. It is about making the current functional foundation easy to run, inspect, and evaluate with realistic local data.

## Success Criteria

- A developer can start the local stack from the repository instructions without guessing missing environment values.
- Postgres, Prisma migrations, seed data, API, and web app run together with local auth bypass.
- The web app opens at `http://localhost:5176` and talks to the API at `http://localhost:3002`.
- Demo data is available for conversations, contacts, boards, channels, automations, campaigns, reports, team, assistant, CRM, settings, and audit logs where applicable.
- Each sidebar module can be opened and smoke-tested.
- The review produces a concise inventory of:
  - working flows;
  - broken flows;
  - simulated flows;
  - visual or usability adjustments that block analysis;
  - candidates for the next production-readiness phase.

## Scope

In scope:

- Verify local environment setup.
- Ensure `.env` guidance supports the local bypass flow.
- Run database migrations and demo seed.
- Start API and web locally.
- Smoke-test the app through the browser.
- Validate the main operational modules:
  - Atendimento;
  - Contatos;
  - Canais;
  - Automacoes;
  - Disparos;
  - Relatorios;
  - Equipe;
  - IA;
  - Atomic CRM;
  - Ajustes.
- Document findings from the local analysis pass.

Out of scope:

- Production deployment.
- Real Clerk and Prymeira Account integration hardening.
- Real Evolution, Atomic CRM, or AI provider credentials.
- Full Playwright regression coverage.
- Large UI redesign.
- Replacing simulated provider behavior with real provider behavior.

## Recommended Approach

Use a complete local bench rather than a quick smoke test. The app already has API modules, Prisma models, seed data, web module pages, realtime events, and controlled simulation paths. The safest next move is to verify the whole local loop before adding deeper production behavior.

The local bench should follow this sequence:

1. Check repository state and package scripts.
2. Confirm local environment variables for API and web bypass.
3. Start local Postgres through Docker Compose.
4. Generate Prisma client.
5. Apply migrations.
6. Run demo seed.
7. Start API and web dev servers.
8. Open the web app locally.
9. Review each module and record findings.

## Local Environment

The local setup should use the existing bypass values:

```sh
PRYMEIRA_LOCAL_AUTH_BYPASS=true
PRYMEIRA_LOCAL_WORKSPACE_ID=local_workspace
PRYMEIRA_LOCAL_ROLE=owner
VITE_LOCAL_AUTH_BYPASS=true
```

The API should accept the local bypass token `local-dev-bypass`. The web app should request that token when Clerk does not provide one and local bypass is enabled.

## Module Review Checklist

Atendimento:

- Conversation list loads from seeded data.
- Selecting a conversation loads messages and contact context.
- Sending a local outbound message persists and updates the list.
- Conversation actions such as priority, department, assignment, note, AI suggestion, CRM note, and board stage update behave predictably.
- Realtime updates do not duplicate messages or break selection.

Contatos:

- Contact list loads.
- Creating and editing contacts persists changes.
- Board view loads stages and cards.
- Moving a contact between stages updates the backend and the UI.

Canais:

- Demo Evolution channel appears or can be created.
- QR generation works in simulated mode.
- Connect, disconnect, reconnect, and test inbound actions update the UI.

Automacoes:

- Existing rules load.
- A draft rule can be created and edited.
- Enable, disable, and manual test actions persist.
- Run history is visible.

Disparos:

- Campaigns load.
- Draft campaign creation and editing work.
- Audience resolution returns demo contacts.
- Simulated sending creates recipients and results.

Relatorios:

- Cards and breakdowns reflect seeded/demo activity.
- Empty states are understandable where data is missing.
- Export behavior works if available.

Equipe:

- Demo users and departments load.
- Role changes persist.
- New departments can be created.

IA:

- Simulated assistant action can be created.
- Action history loads.
- Result payload is visible enough for analysis.

Atomic CRM:

- Simulated sync action can be created.
- Action history loads.
- Result state is clear.

Ajustes:

- Workspace and integration settings load.
- Integration mode/status updates persist.
- Audit log entries appear for relevant actions.

## Error Handling

The bench should make setup failures obvious:

- API health should be checked before browser review.
- Database/migration failures should stop the setup pass.
- Seed failures should be captured with the failing model or constraint.
- Browser review should record console errors and failed network requests.
- Missing local env values should be treated as setup issues, not app behavior issues.

## Testing And Verification

Automated verification for this phase:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @prymeira-talk/api seed:demo
```

Manual/browser verification:

- Open `http://localhost:5176`.
- Use local auth bypass.
- Walk the sidebar from top to bottom.
- Capture issues by module with reproduction notes.

## Deliverable

The deliverable for this phase is a working local app plus a concise analysis report. The report should answer:

- What works now?
- What is simulated but useful for analysis?
- What is broken or blocking?
- What should become production-real first in the next phase?
