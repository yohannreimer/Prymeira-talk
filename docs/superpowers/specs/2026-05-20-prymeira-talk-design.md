# Prymeira Talk Design

Date: 2026-05-20

## Summary

Prymeira Talk is a multi-company SaaS for WhatsApp operations. It provides a shared inbox with a familiar WhatsApp Web structure, plus team routing, tags, simple automations, realtime updates, AI assistance, and a light integration with Atomic CRM.

The product must work as a standalone SaaS and also fit naturally into the Prymeira ecosystem. It uses Clerk for identity, Prymeira Account for product access and workspace authorization, Evolution API as the first WhatsApp provider, and its own backend and database for operational data.

## Product Decisions

- Public name: Prymeira Talk.
- Product key: `talk`.
- Product type: SaaS multiempresa.
- First WhatsApp provider: Evolution API.
- Initial UI model: WhatsApp Web improved for professional operations.
- Visual direction: operational calm, clear, dense, and comfortable for all-day use.
- First automation scope: operational rules plus a small linear flow engine.
- First AI scope: assistant for the human attendant, not autonomous customer handling.
- Atomic CRM integration: light integration from the beginning, with separate products and data ownership.

## MVP Scope

The MVP includes:

- Clerk login.
- Prymeira Account authorization through `@prymeira/auth`.
- `workspace_id` as the tenant boundary.
- Roles: owner, manager, agent.
- Evolution channel connection and status.
- Shared inbox with conversations, messages, contact panel, tags, departments, assignees, and notes.
- Realtime message and conversation updates.
- Basic contact management inside Prymeira Talk.
- Tags and department queues.
- Simple automations for greeting, after-hours, keywords, menus, collecting data, tagging, transferring, webhooks, and CRM actions.
- AI assistant actions: summarize, suggest reply, rewrite, detect intent/tag, generate CRM note, suggest next step.
- Atomic CRM actions: create or link contact, create lead, create task, send note or summary, open linked CRM contact.
- Basic reports: conversation volume, response time, conversations by user, department, and tag.

Out of scope for the MVP:

- Autonomous AI customer agent.
- Visual builder similar to Typebot.
- Official WABA provider.
- Native sales pipeline inside Prymeira Talk.
- Advanced analytics.
- Mobile app.

## Architecture

The app will be a dedicated monorepo:

```txt
apps/web
apps/api
packages/shared
```

`apps/web` is a React/Vite frontend. It authenticates with Clerk, talks only to the Talk API, and renders the realtime operational UI.

`apps/api` is a Node/Fastify backend with Prisma and Postgres. It validates Clerk tokens, checks product access through Prymeira Account, resolves workspace context, enforces permissions, and owns all sensitive operations.

`packages/shared` stores shared Zod schemas, TypeScript types, constants, roles, statuses, and API contracts used by both web and API.

External services:

- Clerk: identity and sessions.
- Prymeira Account: authorization, product access, workspace membership, plan, limits.
- Evolution API: initial WhatsApp provider.
- Atomic CRM: optional CRM integration.
- LLM provider: assistant features through an internal abstraction.
- Postgres: operational Prymeira Talk data.
- Redis/BullMQ or equivalent: queues for webhooks, message delivery, automations, CRM sync, and AI work.

The backend is the enforcement boundary. Every tenant-owned read and write filters by `workspace_id`; frontend state never grants access by itself.

## Realtime Model

Realtime is a core product requirement.

Inbound flow:

```txt
Evolution webhook
-> API validates and normalizes the event
-> Postgres stores message, conversation, and status changes
-> internal event bus publishes message/conversation events
-> WebSocket sends updates to connected users in the workspace
-> UI updates chat, conversation list, unread badges, tags, and status
```

Outbound flow:

```txt
Frontend creates pending message
-> API validates workspace and permissions
-> API sends message through Evolution
-> message remains pending or becomes sent
-> Evolution status webhooks update sent/delivered/read/failed
-> WebSocket broadcasts every status change
```

Initial implementation should use a backend WebSocket layer. SSE is acceptable only if it materially reduces complexity during the first prototype, but WebSocket is preferred because typing indicators, assignment state, and multiattendant presence are expected.

Realtime events include:

- message created.
- message status changed.
- conversation updated.
- conversation assigned or transferred.
- tag added or removed.
- internal note created.
- automation state changed.
- attendant typing.
- channel connection state changed.

## Data Model

Core entities:

- `WorkspaceMirror`: cached workspace information from Prymeira Account.
- `UserProfile`: Clerk user mapped into a workspace with role and display state.
- `Channel`: Evolution instance, phone number, display name, status, encrypted credentials.
- `Contact`: local Talk contact with phone, email, company, custom fields, and optional Atomic CRM IDs.
- `Conversation`: contact/channel thread with status, assignee, department, preview, unread count, and priority.
- `Message`: normalized inbound, outbound, system, media, and internal note records.
- `Tag`: workspace-owned labels with color.
- `ConversationTag`: many-to-many relation between conversations and tags.
- `Department`: routing queue or team area.
- `AutomationRule`: trigger, conditions, actions, and enabled state.
- `AutomationRun`: stateful execution for a conversation and rule.
- `Integration`: encrypted configs for Atomic CRM, webhooks, and LLM provider.
- `AuditLog`: important user and system actions.

Every tenant-owned table includes `workspace_id`, either directly or through a parent record. Webhook idempotency uses provider event IDs and provider message IDs so duplicate Evolution events do not create duplicate messages or automation runs.

## UX

The main screen is the Inbox.

Layout:

- compact left navigation for Inbox, Contacts, Automations, Reports, and Settings.
- conversation list with search, filters, channel, department, assignee, unread state, and tags.
- central chat with realtime messages, delivery status, media, internal notes, and composer.
- composer actions for attachment, quick replies, AI assistant, and send.
- right contact panel with profile, tags, custom fields, department, assignee, notes, Atomic CRM link, and recent history.

Secondary MVP screens:

- Contacts.
- Automations.
- Channels.
- Team.
- Settings.
- Atomic CRM integration.
- Basic reports.

Important states:

- no product access.
- Evolution disconnected.
- message pending, sent, delivered, read, or failed.
- conversation assigned to another user.
- automation running.
- send failure.
- contact without CRM link.
- Atomic CRM sync failure.
- AI unavailable.

## Automations

MVP automations are rules plus linear flows, not a canvas builder.

Triggers:

- first message.
- keyword.
- after-hours.
- menu option.
- manual action.

Actions:

- send message.
- apply or remove tag.
- collect contact data.
- update custom field.
- transfer to department or user.
- call webhook.
- create lead, task, or note in Atomic CRM.
- end automation.
- hand off to human.

Each automation execution creates or updates an `AutomationRun`. A single incoming event must not run the same automation twice.

## AI Assistant

The MVP does not let AI reply automatically to customers. AI assists the attendant.

Actions:

- summarize conversation.
- suggest reply.
- rewrite current draft.
- detect intent.
- suggest tags.
- suggest next step.
- generate CRM note.

The AI layer must degrade cleanly. If the provider fails, the chat and message sending flow continue normally.

## Atomic CRM Integration

Prymeira Talk and Atomic CRM remain separate products. Prymeira Talk owns WhatsApp contacts, conversations, messages, tags, and operational state. Atomic CRM owns CRM contacts, leads, deals, tasks, notes, and pipeline.

The integration stores external IDs on Talk contacts and integration logs. MVP actions:

- create or link Atomic CRM contact.
- create Atomic CRM lead.
- create Atomic CRM task or follow-up.
- send conversation note or AI summary to Atomic CRM.
- open linked CRM contact from the Talk panel.

CRM failures should be visible in the UI and logs, but must not block the attendant from continuing the WhatsApp conversation.

## Security And Permissions

Clerk authenticates users. Prymeira Account authorizes product access. Prymeira Talk enforces workspace and role permissions in the backend.

Rules:

- Every protected API route requires a Clerk token.
- Every protected API route checks access for `product_key: talk`.
- Every tenant-owned query filters by `workspace_id`.
- Owner can manage workspace-level Talk settings.
- Manager can manage users, departments, tags, assignments, automations, and reports.
- Agent can handle assigned or visible conversations according to department settings.
- Credentials and integration secrets are encrypted at rest.
- Webhooks validate source and are idempotent.
- Audit logs capture sensitive actions and configuration changes.

## Testing Criteria

Required verification before calling the MVP stable:

- User without `talk` entitlement cannot access web or API.
- User from workspace A cannot read or mutate workspace B records.
- Agent cannot perform manager-only actions.
- Duplicate Evolution webhook does not duplicate messages.
- Incoming message appears in realtime for connected users.
- Outbound message appears as pending and later updates status.
- Tags, notes, assignment, and transfer broadcast realtime updates.
- Automation does not run twice for the same event.
- CRM integration failure does not break chat.
- AI failure shows a clean fallback and does not block sending.

## Future Expansion

Planned later:

- WABA official provider through a provider abstraction.
- Visual automation builder inspired by Typebot, without embedding restricted Typebot editor code in a commercial SaaS unless licensing is resolved.
- Autonomous AI agent with knowledge base, confidence thresholds, and handoff.
- Advanced reports and billing limits.
- Deeper Atomic CRM sync.
- Mobile experience.
