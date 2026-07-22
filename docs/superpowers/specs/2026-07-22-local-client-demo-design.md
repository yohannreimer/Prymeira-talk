# Prymeira Talk Local Client Demo Design

## Goal

Prepare a deterministic localhost demonstration of Prymeira Talk for a client with a five-person sales team. The demonstration must show how conversations, AI agents, team ownership, contact stages, internal notes, and Vincula CRM work as one connected flow.

The scenario must feel relevant to a B2B materials seller without appearing custom-built for a single prospect. The live meeting should not depend on internet access, WhatsApp delivery, AI provider availability, or CRM credentials.

## Presentation Format

Use a hybrid presentation:

1. Run one connected 10–12 minute story from inbound message through CRM synchronization.
2. Use an optional five-minute tour for Team, Automations, Campaigns, and Reports when the client asks for broader coverage.

The connected story is the primary artifact. A module-by-module tour must not replace it.

## Demo Scenario

The demo workspace represents **Nova Base Suprimentos**, a neutral B2B distributor of materials and equipment.

The workspace contains:

- one manager and four salespeople;
- presence states and round-robin queue distribution;
- ten conversations covering quotes, delivery dates, negotiation, follow-up, post-sale, and support;
- one connected commercial WhatsApp channel;
- one active AI sales agent;
- a sales board with `Novo`, `Qualificado`, `Proposta enviada`, `Follow-up`, and `Ganho` stages;
- CRM synchronization history with realistic local identifiers.

The main story follows **Carlos Mendes**, from **Construtora Horizonte**, who requests a quote for materials needed at a new job site. The names and content are fictional and remain generic enough for reuse.

## Primary Journey

1. The presenter opens Atendimento and clicks **Simular novo lead**.
2. A deterministic inbound WhatsApp-style message from Carlos appears in the conversation list.
3. **Assistente Comercial IA** asks for city, quantity, required date, and payment preference.
4. The AI adds the `Orçamento quente` tag and creates an internal summary containing the qualified details.
5. The AI requests handoff with a visible reason.
6. One of the five salespeople assumes the conversation and sends a prepared quick reply.
7. The contact moves from `Novo` to `Qualificado` and then to `Proposta enviada`.
8. The presenter creates a Vincula opportunity and sends the AI summary as a CRM note.
9. The Vincula module shows the contact, company, opportunity, assigned salesperson, AI note, identifiers, status, and synchronization history.
10. Reports confirm that the conversation and operational actions left persistent records.

The optional real WhatsApp flow may replace step 1 when internet and channel health permit. It must never be required to complete the story.

## UI Changes

### Demo controls

When local demo mode is active, Atendimento shows a compact `Demo local` control group:

- **Simular novo lead** creates or restores the Carlos conversation at its starting point;
- **Restaurar demo** resets the entire demo workspace to its documented baseline after confirmation.

These controls are hidden outside local demo mode. They must not become normal production actions.

### Conversation intelligence

The contact context panel visibly groups AI-derived information:

- concise AI summary;
- qualification tag;
- AI status;
- handoff reason;
- internal notes.

Existing human-control actions remain available. The presentation must make the transition from AI control to human control obvious.

### CRM ergonomics

CRM actions operate on a selected contact instead of requiring the presenter to paste a UUID. When opened from Atendimento, Vincula receives the current contact as navigation context.

The action surface provides:

- **Criar oportunidade**;
- **Enviar nota da IA**;
- the active adapter state (`Local`, `Real`, or `Sem conexão`);
- the latest synchronization result and identifiers.

Technical payloads may remain available in secondary details, but must not dominate the presentation surface.

## Architecture

All modules use the existing API and PostgreSQL database as the source of truth. The demo must not fake state solely in React components.

The implementation adds three bounded units:

1. **Demo scenario service** — resets the demo workspace and creates the deterministic inbound story. It is enabled only by explicit local-demo environment configuration.
2. **Demo controls** — small frontend controls that invoke scenario actions and refresh normal module data.
3. **CRM adapter boundary** — preserves the same application contract for simulated and real Vincula operations. Local mode returns deterministic external-style identifiers and persists the same synchronization records used by real mode.

The existing conversation, AI agent, team, contacts, board, CRM, and reports services remain responsible for their own records. The scenario service orchestrates them or seeds their expected state; it does not duplicate their business logic.

## Data Flow

The local generator persists an inbound message and emits the normal conversation realtime event. AI actions persist through the existing agent session/run path. Tags and internal notes use their normal APIs. Human ownership updates the conversation record. Board movement updates the contact's primary membership. CRM actions write synchronization history regardless of adapter mode. Reports aggregate those persisted records.

This shared persistence is what allows the presenter to move between modules and show the same contact without inconsistent counters or manually staged screens.

## Real and Simulated Integrations

Local simulation is the default presentation mode. Real WhatsApp and Vincula adapters remain optional and are activated only with valid runtime configuration.

Both Vincula modes use the same request and result shapes. Simulated mode returns stable, credible IDs and completed timestamps. Real mode performs the external request and persists its result. The UI labels the current environment discreetly and never represents simulated execution as an actual external write.

If a real integration fails, Prymeira Talk preserves local work, displays a concise error, and lets the presenter retry or switch to the simulated adapter. Switching mode must not require restarting the presentation flow.

## Reset and Safety

**Restaurar demo** affects only the configured demo workspace. It must never delete data from another workspace. The API validates that local demo mode is enabled and that the target workspace matches the configured demo workspace before changing data.

Reset produces the same users, conversations, timestamps relative to reset time, board positions, tags, notes, agent configuration, and CRM history every time. It returns a summary of the restored record counts so the UI can confirm readiness.

The existing seed script is the shared source for baseline demo data and is refactored or extended as needed instead of maintaining two divergent scenarios.

## Failure Handling

- Duplicate clicks on **Simular novo lead** must be idempotent and focus the existing Carlos conversation.
- A reset in progress disables both demo controls.
- Reset failure leaves an actionable error and does not claim success.
- Realtime failure falls back to an explicit data refresh.
- AI simulation produces deterministic qualification output so the presenter never waits for a provider.
- Real CRM failure preserves the local opportunity intent and offers simulation as a retry path.
- Empty CRM history, offline channels, and unavailable optional integrations have presentable empty or warning states.

## Verification

Automated coverage must include:

- demo routes rejected when local demo mode is disabled;
- demo routes rejected for a non-demo workspace;
- reset idempotency and expected record counts;
- simulated inbound creation and duplicate-click behavior;
- five team members and the expected seeded scenario;
- deterministic AI summary, tag, note, and handoff state;
- CRM adapter parity for the application-facing result shape;
- contact-context navigation into CRM without manual UUID entry;
- visibility of demo controls only in local demo mode.

Before handoff, run the repository test, typecheck, and build commands. Then complete a browser smoke test of the entire primary journey, restore the demo, and repeat the first two steps to prove recoverability.

## Presenter Runbook

Provide concise commands that:

1. start PostgreSQL;
2. reset and seed the demo workspace;
3. start API and web apps in local bypass mode;
4. verify API and web health;
5. open the correct localhost URL.

Also provide a one-page checklist containing the primary story, optional module tour, real-integration prerequisites, fallback instructions, and reset procedure.

## Non-goals

- Redesigning the entire Prymeira Talk interface.
- Replacing existing domain services with demo-only logic.
- Requiring a real WhatsApp message or real CRM mutation during the meeting.
- Building new campaign or automation capabilities unrelated to the main story.
- Making the fictional scenario specific to the prospect's exact catalog or company name.

## Acceptance Criteria

The work is ready when the presenter can start from a clean local environment, complete the primary journey without copying identifiers or editing database records, show consistent state across Atendimento, Agentes, Equipe, Contatos, Vincula CRM, and Relatórios, restore the baseline with one action, and repeat the journey without external services.
