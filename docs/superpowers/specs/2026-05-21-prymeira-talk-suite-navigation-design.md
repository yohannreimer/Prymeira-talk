# Prymeira Talk Suite Navigation And Functional Modules Design

Date: 2026-05-21

## Summary

Prymeira Talk will become a complete WhatsApp operations suite, while preserving a WhatsApp Web-like main work surface for daily attendance. The product should feel complete and navigable from the beginning, with all major modules visible in the left rail.

The approved direction is a full sidebar with every module exposed, backed by functional local workflows. External integrations can start in controlled simulation mode when credentials or production APIs are not available, but the product flow must still save data, show status, and create useful history.

## Approved Navigation

The fixed left sidebar contains these modules in this order:

1. Atendimento
2. Contatos
3. Canais
4. Automacoes
5. Disparos
6. Relatorios
7. Equipe
8. IA
9. Atomic CRM
10. Ajustes

Each module has a stable icon, tooltip, active state, and a dedicated screen. The sidebar should remain icon-only to preserve density. Module screens may use secondary navigation, tabs, segmented controls, or local filters when needed.

## Primary UX Rule

Atendimento remains the main cockpit and must continue to resemble a professional WhatsApp Web interface:

- conversation list on the left;
- chat history and composer in the center;
- contact and operational context on the right.

The attendance screen must not become a dashboard or admin panel. Extra functionality appears only when it helps the current conversation, such as quick tag changes, board stage changes, AI suggestions, CRM link status, notes, assignment, or department transfer.

## Functional Strategy

The first complete suite should use controlled simulation where external systems are not ready.

Rules:

- Product workflows must be usable and persist data in Prymeira Talk.
- If an external integration is not configured, actions run in demo/simulated mode with clear UI status.
- Simulated actions still create local records, logs, timestamps, result states, and testable UI feedback.
- The app should be able to switch from simulation to real adapters without changing the user-facing workflow.

This applies to Evolution, AI providers, Atomic CRM, and campaign sending.

## Module Scope

### Atendimento

Atendimento is the live operations surface.

Required capabilities:

- conversation list with unread counts, status, priority, assignee, department, tags, and search;
- selected chat with message history, realtime updates, and composer;
- send message flow, initially local/simulated when provider sending is not configured;
- contact panel with phone, channel, tags, priority, department, assignee, notes, board stage, and Atomic CRM status;
- quick actions for assignment, transfer, tag, note, board stage, AI suggestion, CRM note, and CRM link;
- visible states for loading, empty, disconnected channel, send failure, and assigned-to-other-user.

### Contatos

Contatos is the local Talk contact base, not the full CRM.

Required capabilities:

- list, create, edit, search, and archive contacts;
- phone, name, email, company, origin, tags, custom fields, and recent conversation history;
- open conversation from contact;
- show Atomic CRM link status;
- switch between Lista and Board views.

### Canais

Canais owns WhatsApp provider configuration.

Required capabilities:

- create and edit Evolution instances or numbers;
- show provider, phone number, display name, status, last sync, and health;
- connect by QR Code, using real Evolution when configured or demo QR state otherwise;
- reconnect, disconnect, test webhook, and test inbound event;
- show setup checklist and configuration errors.

### Automacoes

Automacoes starts as rules and linear flows, not a visual canvas.

Required capabilities:

- create, edit, enable, disable, and duplicate automation rules;
- triggers: first message, keyword, after-hours, menu option, manual action, board stage change;
- conditions: channel, department, tag, status, contact field, business hours, board stage;
- actions: send message, apply or remove tag, update contact field, move board stage, transfer department, assign user, call webhook, create local CRM action, end flow;
- execution log with status, timestamps, input event, and result;
- idempotency so the same inbound event does not run the same rule twice.

### Disparos

Disparos handles campaign-like WhatsApp sends separately from the live inbox.

Required capabilities:

- create campaign draft;
- choose audience by contacts, tags, board stage, channel, or imported list;
- write message content;
- schedule or simulate send;
- show pending, sent, failed, skipped, and replied counts;
- keep compliance warnings and avoid hiding the difference between simulated and real sends.

### Relatorios

Relatorios uses local Talk data first.

Required capabilities:

- dashboard for open conversations, new conversations, unread messages, response time, resolution time, and volume by day;
- breakdown by channel, department, user, tag, board, and status;
- campaign results from Disparos;
- automation execution counts and failures;
- export-ready tables where useful.

### Equipe

Equipe controls people and operating structure.

Required capabilities:

- list users and their roles;
- invite or register users in local/simulated mode until Prymeira Account integration handles invitations;
- roles: owner, manager, agent;
- departments, queues, routing order, and visibility rules;
- assignment settings and workload visibility.

### IA

IA is a configuration and audit center for assistant features.

Required capabilities:

- enable or disable assistant actions;
- configure tone, brand context, fallback instructions, and allowed actions;
- actions: summarize conversation, suggest reply, rewrite draft, suggest tag, detect intent, generate CRM note, suggest next step;
- simulated provider output when no AI key is configured;
- action history with user, conversation, prompt type, result, and status.

The AI does not autonomously answer customers in this phase.

### Atomic CRM

Atomic CRM integration is a bridge, not a replacement for Talk data.

Required capabilities:

- connection status and configuration;
- local mapping for contact, lead, task, note, and custom fields;
- link or create CRM contact in simulated mode;
- create lead, task, or note in simulated mode;
- send conversation summary or AI note to local sync log;
- show sync history, failures, and pending actions.

Prymeira Talk and Atomic CRM remain separately sellable products.

### Ajustes

Ajustes contains workspace-level configuration.

Required capabilities:

- company/workspace profile;
- plan and limits display;
- security and session notes;
- webhook settings;
- integration mode toggles;
- audit log;
- defaults for atendimento, channels, automation, and campaigns.

## Contact Boards

Contact boards are approved as part of Contatos.

Concepts:

- Board: a process or workflow owned by the workspace, such as Pre-vendas, Onboarding, Suporte, or Cobranca.
- Etapa: an ordered column inside a board, such as Novo, Qualificado, Proposta, Follow-up, or Ganho.
- Tag: a free label that remains independent from boards and stages.

Rules:

- Contatos has Lista and Board views.
- A contact can belong to multiple boards.
- One board participation can be marked as the primary board for that contact.
- Atendimento shows only the primary board and stage by default in the right contact panel.
- The contact detail screen shows all board participations.
- Dragging a contact card between columns updates its stage.
- Adding a contact to a stage creates a board participation, not a tag.
- Board stage changes can trigger automations.

Example:

- Contact: Joao Martins
- Primary board: Pre-vendas
- Stage: Proposta enviada
- Other board: Onboarding > Aguardando documentos
- Tags: VIP, WhatsApp Comercial, Alta prioridade

## Data Model Additions

The existing foundation already has conversations, messages, contacts, channels, departments, tags, users, and conversation tags. The suite expansion should add bounded entities for each module.

Recommended additions:

- `ContactBoard`: workspace board definition.
- `ContactBoardStage`: ordered stage definition.
- `ContactBoardMembership`: contact placement in a board, including current stage and primary flag.
- `ContactNote`: notes on contacts or conversations.
- `AutomationRule`: trigger, conditions, actions, enabled state.
- `AutomationRun`: execution state and idempotency keys.
- `Campaign`: campaign draft, audience, schedule, and status.
- `CampaignRecipient`: per-contact campaign result.
- `AiActionLog`: assistant action history and result.
- `CrmSyncAction`: local/simulated CRM action log.
- `IntegrationConfig`: provider mode, status, and non-secret settings.
- `AuditLog`: sensitive or administrative actions.

Every tenant-owned entity must include `workspace_id` directly or through a parent, and backend queries must enforce workspace boundaries.

## Data Flow

Atendimento:

```txt
User selects conversation
-> Web loads conversation and messages
-> Web subscribes to workspace realtime events
-> Message or conversation update arrives
-> API stores state
-> Realtime event updates list, chat, contact panel, and metrics
```

Canais:

```txt
User creates channel
-> API stores provider config in local mode
-> QR flow starts real adapter if configured, otherwise demo session
-> Channel status updates persist
-> Realtime event updates sidebar/status surfaces
```

Automacoes:

```txt
Trigger event occurs
-> API evaluates enabled rules for workspace
-> Run is created with idempotency key
-> Actions execute locally or through adapters
-> Results are logged
-> Relevant UI surfaces update through realtime
```

Disparos:

```txt
Campaign is created
-> Audience is resolved from local contacts/tags/boards
-> Sending is simulated or delegated to provider adapter
-> Recipient results are stored
-> Reports update from campaign results
```

## Error Handling

Each module must have clear states for:

- loading;
- empty data;
- validation errors;
- permission denial;
- integration not configured;
- simulated mode active;
- external adapter failure;
- partial success;
- retry available;
- audit/log link available.

Simulated mode should never pretend to be real delivery. Labels such as `Modo simulado`, `Nao enviado ao provedor`, or `Acao registrada localmente` should be visible where user trust matters.

## Permissions

Initial permission shape:

- owner: all workspace configuration, billing/limits, integrations, users, automations, reports, and data;
- manager: atendimento, contacts, boards, automations, campaigns, reports, team operations, and channel operations except destructive workspace settings;
- agent: atendimento, assigned or visible conversations, contact updates allowed by policy, notes, tags, board stage changes, and AI assistance.

Permissions should be enforced in the API. Frontend visibility is only convenience.

## Testing Criteria

Navigation:

- every sidebar icon opens the correct module;
- active state and tooltip are correct;
- Atendimento keeps the WhatsApp-style three-panel layout.

Functional simulation:

- actions in simulated integrations persist local records;
- simulated mode is visible to the user;
- switching adapters does not change the web workflow.

Contact boards:

- user can create a board and stages;
- user can add a contact to a board stage;
- user can drag a contact between stages;
- one primary board is shown in Atendimento;
- tags remain independent from board stages.

Tenant safety:

- every new API route filters by workspace;
- users cannot access another workspace's contacts, boards, campaigns, automation rules, or logs.

Realtime:

- message, assignment, tag, board stage, automation, campaign, and channel status changes broadcast to the workspace where relevant.

## Implementation Notes

This design is too large for a single implementation step. It should be implemented through staged plans while keeping the final suite shape visible:

1. navigation shell and module routing;
2. contacts CRUD and boards;
3. channels with Evolution/demo adapter;
4. atendimento enhancements: composer, notes, tags, board stage, assignment;
5. automations local runner;
6. campaigns/disparos local runner;
7. reports over local data;
8. team and permission management;
9. AI action center with simulated/real adapter;
10. Atomic CRM local sync bridge.

Each stage should leave the app runnable and testable.
