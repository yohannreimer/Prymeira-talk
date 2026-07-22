# Local Talk + Vincula Integration Demo Design

## Objective

Create a reusable, controlled localhost demonstration in which Prymeira Talk writes real records to a locally running Vincula CRM. The presenter must be able to qualify a lead in Talk, create the corresponding CRM records, and open the resulting Vincula record in a second browser tab without searching manually.

The demonstration is a neutral B2B sales scenario suitable for different clients. It must not depend on internet access or write to production services.

## Success Criteria

The demonstration succeeds when the presenter can:

1. Start Talk, Vincula, and their isolated local databases with documented commands.
2. Simulate and qualify Carlos Mendes in Talk.
3. Create or update Construtora Horizonte, Carlos Mendes, a commercial opportunity, and an AI summary note through the real Vincula HTTP API.
4. See real Vincula identifiers and a completed synchronization status in Talk.
5. Click **Abrir no Vincula** and land directly on the created opportunity or its associated contact in the native Vincula interface.
6. See the opportunity in the Vincula Kanban with its company, contact, source, 75% probability, owner, and AI note.
7. Repeat the synchronization without creating duplicate company, contact, or opportunity records.
8. Restore both applications to the deterministic baseline and repeat the entire presentation.

## Scope

### Prymeira Talk

- Configure the CRM adapter to use the local Vincula API during the reusable demo.
- Support a server-side Vincula integration token so local Talk authentication does not need to forward a browser token.
- Persist the real Vincula company, contact, opportunity, and note identifiers in Talk synchronization history.
- Distinguish a completed real local write from the existing simulated fallback.
- Add a deep-link action that opens the synchronized record in Vincula.
- Extend the restore operation so it coordinates the Vincula demo reset.

### Vincula CRM

- Run the production-shaped PostgreSQL API and native frontend locally instead of the in-browser FakeRest demo provider.
- Add an explicitly gated local demonstration authentication path for the frontend and API.
- Seed a neutral B2B workspace with the minimum data needed for a convincing native CRM experience, including five salespeople and a commercial pipeline.
- Accept Talk writes through the existing records API contract.
- Expose a workspace-scoped reset operation or reset command that affects only the local demo workspace.
- Support a stable deep link to an opportunity or contact.

### Reusable Demo Orchestration

- Provide one documented command to prepare or restore both applications.
- Provide one documented command to start the integrated stack.
- Use fixed localhost ports and isolated database names.
- Preserve the existing Talk-only `demo:reset` and `demo:prymeira` commands unchanged.
- Document startup, reset, presentation flow, health checks, and failure recovery.

## Architecture

The integrated demonstration consists of two native applications and two isolated PostgreSQL databases:

```text
Prymeira Talk web :5176
        |
        v
Prymeira Talk API :3002 ---- real HTTP writes ----> Vincula API :3003
        |                                                |
        v                                                v
prymeira_talk database                         prymeira_vincula_demo database
                                                         ^
                                                         |
                                               Vincula web :5174
```

Talk remains the source of the conversation, qualification, AI summary, ownership, and handoff. Vincula becomes the source of the synchronized company, contact, opportunity, and CRM note. Talk stores the external identifiers and synchronization audit record required to reconnect both sides.

The applications use separate databases even when they share the same local PostgreSQL server. This preserves service boundaries and ensures that the demonstration validates the HTTP integration rather than relying on cross-database writes.

## Local Runtime Configuration

The reusable demo uses these fixed endpoints:

| Service | URL |
| --- | --- |
| Talk web | `http://localhost:5176` |
| Talk API | `http://localhost:3002` |
| Vincula web | `http://localhost:5174` |
| Vincula API | `http://localhost:3003/api` |
| PostgreSQL | `localhost:54329` |

The Talk demo process supplies the Vincula API URL, local integration token, and Vincula web URL through server-only environment variables. The token is never embedded in the Talk browser bundle.

The Vincula frontend uses the real PostgreSQL data provider. Its local demo authentication provider supplies the same local token to the Vincula API and a deterministic owner identity to the CRM shell.

All local bypasses are disabled by default and rejected in production. Enabling them requires an explicit demo flag and a localhost-compatible runtime environment.

## Data Flow

### Create Opportunity

1. The presenter selects Carlos Mendes in Talk and clicks **Criar oportunidade**.
2. The Talk API loads the canonical Talk contact and AI qualification context.
3. Talk queries Vincula for an exact company match using a normalized company name.
4. Talk reuses the company or creates it.
5. Talk queries Vincula for an exact contact match using normalized phone variants.
6. Talk reuses and updates the contact or creates it, linked to the company.
7. Talk reuses the opportunity referenced by its stored Vincula identifier. If no valid identifier exists, it queries by a Talk-origin integration key or creates the opportunity.
8. The opportunity is linked to the company and contact, assigned to the deterministic demo owner, placed in the first active commercial stage, and marked with source `Prymeira Talk` and 75% probability to express hot intent.
9. Talk creates the initial AI qualification note as a Vincula `deal_notes` record when the opportunity is first created.
10. Talk persists the returned identifiers and a completed real-mode synchronization action.

The Vincula opportunity is a native Kanban deal, not merely an in-browser representation. Talk continues to store the deal ID in its existing `atomicCrmLeadId` compatibility field, while new API results and UI text use `vinculaDealId` and opportunity terminology.

### Send AI Note

1. The presenter clicks **Enviar nota da IA**.
2. Talk upserts the company and contact if necessary.
3. Talk writes the trimmed AI summary as a Vincula `deal_notes` record when the contact has a synchronized opportunity. If no opportunity exists, it writes a `contact_notes` record instead.
4. Talk records the Vincula note identifier when the API returns it and a completed synchronization action.
5. The native Vincula record shows the note without recreating the contact or opportunity.

### Open in Vincula

After a successful real local synchronization, Talk renders **Abrir no Vincula**. The target is built from the configured Vincula web URL and the returned record identifier. It opens `http://localhost:5174/deals/{id}/show` when a deal identifier is available and falls back to `http://localhost:5174/contacts/{id}/show`.

The deep link is not rendered for purely simulated synchronization actions because no native Vincula record exists.

## Idempotency and Identity

The integration uses multiple identity layers:

- company: normalized exact company name;
- contact: stored Vincula ID first, then normalized phone match;
- opportunity: stored Vincula deal ID first, then an exact match on company, contact, opportunity name, and source `Prymeira Talk`;
- note: initial opportunity note is created only with a new opportunity; explicitly sent AI notes are individual user actions.

A retry after a partial failure reuses any records already created. Talk records only a completed real synchronization after all required writes for that action succeed.

## Demo Authentication and Isolation

The local integration token is a non-production credential dedicated to the demo. Vincula accepts it only when all local-demo gates pass. It resolves to:

- a fixed UUID workspace dedicated to the demonstration;
- an owner or administrator workspace role;
- a deterministic local presenter identity.

The reset operation always filters by that workspace UUID. It must not accept an arbitrary workspace supplied by the browser. Production builds and production runtime environments reject the local token and reset route.

The local databases use explicit names rather than the default PostgreSQL database. Startup scripts must validate the target database and port before applying schema or reset operations.

## Deterministic Baseline

The Vincula baseline is neutral and complements the Talk scenario without appearing tailored to one industry. It contains:

- a generic B2B workspace;
- the same five salesperson personas used in the Talk demonstration;
- a commercial pipeline with credible stages;
- a small set of unrelated companies, contacts, and opportunities so the CRM looks active;
- no preexisting Carlos Mendes, Construtora Horizonte, or Talk-origin opportunity after reset.

The first Talk synchronization therefore produces a visible new Kanban item. Existing baseline data makes the creation visually obvious without leaving the CRM empty.

## Reset and Orchestration

The reusable model exposes these commands:

```sh
pnpm demo:reset:all
pnpm demo:stack
```

`demo:reset:all` performs these operations in order:

1. Start or validate the isolated local PostgreSQL runtime.
2. Apply the Talk schema and restore the Talk scenario.
3. Create or validate the separate Vincula demo database.
4. Apply the Vincula schema.
5. Remove only records belonging to the fixed Vincula demo workspace.
6. Seed the deterministic Vincula baseline.

The Talk **Restaurar** control invokes a protected orchestration path that resets both demo workspaces. If the Vincula reset fails, Talk reports a partial reset instead of claiming the whole environment was restored.

`demo:stack` starts the four application processes with consistent environment variables and preserves useful process output for troubleshooting. Health checks cover both APIs before the runbook declares the demo ready.

## User Experience

The Talk CRM screen communicates four states clearly:

- ready to synchronize;
- synchronization in progress;
- synchronized to Vincula local with real identifiers;
- Vincula local unavailable or partially failed.

The real-local success state uses discreet wording such as **Sincronizado no Vincula local**. It does not use the existing simulated result language. The deep-link action is visually prominent enough to support the presentation but remains appropriate for future real deployments.

The Vincula frontend shows a discreet **Ambiente de demonstração local** indicator. It otherwise remains the native CRM experience so the presenter can show the real Kanban, contact page, company relationship, and note history.

## Error Handling

- If the Vincula API is offline, Talk returns a clear unavailable error and does not create a simulated success automatically while the integrated demo mode is enabled.
- Authentication failures remain visible and are never downgraded to simulated writes.
- Partial external writes are safe to retry because the upserts are idempotent.
- Invalid or stale stored Vincula identifiers trigger a lookup fallback before a new record is created.
- The open-in-Vincula link is derived only from confirmed real identifiers.
- Reset failures identify which application was restored and which one still needs attention.

The existing Talk-only simulated adapter remains available outside integrated demo mode as an offline fallback, but the integrated demo must fail honestly if its promised real local write cannot be completed.

## Testing and Verification

### Automated Tests

- Talk CRM adapter request and response mapping for companies, contacts, deals, and notes.
- Talk server-side token selection without exposing it to the browser.
- Real-local versus simulated status behavior.
- Deep-link generation and fallback.
- Vincula local-demo authentication gates and production rejection.
- Vincula workspace isolation for reads, writes, and reset.
- Idempotent company, contact, and opportunity synchronization.
- Retry behavior after a partial failure.
- Coordinated reset success and partial-failure reporting.

### Integration Verification

Run both APIs against the isolated local databases and verify:

1. First synchronization creates exactly one company, contact, opportunity, and initial note.
2. A second synchronization updates the same records.
3. Sending an AI note creates a visible additional note.
4. The returned identifiers resolve through the Vincula API.
5. Reset removes the Talk-created records while preserving and reseeding the neutral baseline.

### Browser Verification

Perform the full presenter journey in a clean browser session:

1. Reset and start the integrated stack.
2. Simulate Carlos in Talk.
3. Create the Vincula opportunity.
4. Confirm the real-local success state and identifiers.
5. Open Vincula from Talk in a new tab.
6. Confirm the native opportunity, company, contact, owner, source, probability, and AI note.
7. Return to Talk and send another AI note.
8. Confirm the note in Vincula.
9. Run the coordinated restore.
10. Confirm Carlos and his opportunity no longer appear in either baseline.

## Non-Goals

- Connecting production Vincula or production Talk.
- Depending on Clerk, the Prymeira Account service, Supabase cloud, or internet access during the demo.
- General-purpose multi-tenant demo administration.
- Arbitrary client-specific industry content in this increment.
- Real WhatsApp delivery.
- Synchronizing every Talk board stage bidirectionally with Vincula.

## Deliverables

- Talk integration changes and UI deep link.
- Vincula local real-data demo mode and deterministic seed.
- Coordinated startup and reset commands.
- Automated coverage in both repositories.
- An updated presenter runbook describing the integrated WOW flow and offline recovery.
