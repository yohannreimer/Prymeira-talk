# Prymeira Talk Suite Functional Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved full Prymeira Talk suite: complete sidebar navigation, functional local workflows for every module, contact boards, and controlled simulation for external integrations.

**Architecture:** Keep the existing monorepo shape and treat the API as the tenant and permission boundary. Add focused backend modules for contacts, boards, channels, automations, campaigns, reports, team, AI, CRM sync, and settings. The web app becomes a module shell with Atendimento preserving the WhatsApp-style three-panel layout, while other modules use dense operational screens.

**Tech Stack:** pnpm workspaces, TypeScript, React/Vite, Fastify, Prisma/Postgres, Zod, Vitest, Clerk, Prymeira Account auth, WebSocket realtime, lucide-react.

---

## Scope Split

This is a master implementation plan for the approved suite. Each task should leave the app runnable and testable, and each task should be committed before the next one starts.

The plan intentionally uses controlled simulation for Evolution sending, AI, Atomic CRM, and campaign delivery until real provider credentials are configured. Simulated actions still persist records, emit events where useful, and show their mode clearly in the UI.

## File Structure

Create or modify these files over the full plan:

```txt
packages/shared/src/domain.ts
packages/shared/src/realtime.ts
packages/shared/src/domain.test.ts

apps/api/prisma/schema.prisma
apps/api/prisma/seed-demo.ts
apps/api/src/app.ts
apps/api/src/modules/contacts/contacts.routes.ts
apps/api/src/modules/contacts/contacts.service.ts
apps/api/src/modules/contacts/contacts.service.test.ts
apps/api/src/modules/boards/boards.routes.ts
apps/api/src/modules/boards/boards.service.ts
apps/api/src/modules/boards/boards.service.test.ts
apps/api/src/modules/channels/channels.routes.ts
apps/api/src/modules/channels/channels.service.ts
apps/api/src/modules/channels/channels.service.test.ts
apps/api/src/modules/automations/automations.routes.ts
apps/api/src/modules/automations/automations.service.ts
apps/api/src/modules/automations/automations.service.test.ts
apps/api/src/modules/campaigns/campaigns.routes.ts
apps/api/src/modules/campaigns/campaigns.service.ts
apps/api/src/modules/campaigns/campaigns.service.test.ts
apps/api/src/modules/reports/reports.routes.ts
apps/api/src/modules/reports/reports.service.ts
apps/api/src/modules/reports/reports.service.test.ts
apps/api/src/modules/team/team.routes.ts
apps/api/src/modules/team/team.service.ts
apps/api/src/modules/team/team.service.test.ts
apps/api/src/modules/assistant/assistant.routes.ts
apps/api/src/modules/assistant/assistant.service.ts
apps/api/src/modules/assistant/assistant.service.test.ts
apps/api/src/modules/crm/crm.routes.ts
apps/api/src/modules/crm/crm.service.ts
apps/api/src/modules/crm/crm.service.test.ts
apps/api/src/modules/settings/settings.routes.ts
apps/api/src/modules/settings/settings.service.ts
apps/api/src/modules/settings/settings.service.test.ts

apps/web/src/app/api.ts
apps/web/src/app/App.tsx
apps/web/src/features/inbox/InboxPage.tsx
apps/web/src/features/shell/moduleRegistry.ts
apps/web/src/features/shell/TalkSuiteShell.tsx
apps/web/src/features/contacts/ContactsPage.tsx
apps/web/src/features/channels/ChannelsPage.tsx
apps/web/src/features/automations/AutomationsPage.tsx
apps/web/src/features/campaigns/CampaignsPage.tsx
apps/web/src/features/reports/ReportsPage.tsx
apps/web/src/features/team/TeamPage.tsx
apps/web/src/features/assistant/AssistantPage.tsx
apps/web/src/features/crm/CrmPage.tsx
apps/web/src/features/settings/SettingsPage.tsx
apps/web/src/styles.css
```

Keep `InboxPage.tsx` as the Atendimento surface during the first implementation. Split it only when a task needs a cleaner boundary.

## Task 1: Shared Contracts For Suite Modules

**Files:**
- Modify: `packages/shared/src/domain.ts`
- Modify: `packages/shared/src/domain.test.ts`

- [ ] **Step 1: Add failing tests for new schemas**

Add tests that validate module keys, integration modes, contacts, boards, and campaigns:

```ts
import {
  contactBoardMembershipSchema,
  contactBoardSchema,
  contactBoardStageSchema,
  contactSchema,
  integrationModeSchema,
  suiteModuleSchema
} from "./domain.js";

it("validates suite module keys", () => {
  expect(suiteModuleSchema.parse("atendimento")).toBe("atendimento");
  expect(() => suiteModuleSchema.parse("pipeline")).toThrow();
});

it("validates contact board membership with primary flag", () => {
  expect(contactBoardMembershipSchema.parse({
    id: "membership_1",
    workspaceId: "workspace_1",
    contactId: "contact_1",
    boardId: "board_1",
    stageId: "stage_1",
    isPrimary: true,
    updatedAt: "2026-05-21T00:00:00.000Z"
  }).isPrimary).toBe(true);
});

it("validates contact board and stages", () => {
  expect(contactBoardSchema.parse({
    id: "board_1",
    workspaceId: "workspace_1",
    name: "Pre-vendas",
    description: null,
    createdAt: "2026-05-21T00:00:00.000Z"
  }).name).toBe("Pre-vendas");

  expect(contactBoardStageSchema.parse({
    id: "stage_1",
    workspaceId: "workspace_1",
    boardId: "board_1",
    name: "Proposta enviada",
    color: "#DFF3EA",
    order: 2
  }).order).toBe(2);
});

it("validates contacts and integration mode", () => {
  expect(contactSchema.parse({
    id: "contact_1",
    workspaceId: "workspace_1",
    name: "Joao Martins",
    phone: "+5551999999999",
    email: null,
    company: null,
    atomicCrmContactId: null,
    atomicCrmLeadId: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z"
  }).phone).toBe("+5551999999999");

  expect(integrationModeSchema.parse("simulated")).toBe("simulated");
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```sh
pnpm --filter @prymeira-talk/shared test
```

Expected: tests fail because the new schemas are not exported yet.

- [ ] **Step 3: Add shared schemas and types**

Add these schemas to `packages/shared/src/domain.ts`:

```ts
export const suiteModuleSchema = z.enum([
  "atendimento",
  "contatos",
  "canais",
  "automacoes",
  "disparos",
  "relatorios",
  "equipe",
  "ia",
  "atomic_crm",
  "ajustes"
]);
export type SuiteModule = z.infer<typeof suiteModuleSchema>;

export const integrationModeSchema = z.enum(["simulated", "real"]);
export type IntegrationMode = z.infer<typeof integrationModeSchema>;

export const contactSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().nullable(),
  phone: z.string().min(1),
  email: z.string().email().nullable(),
  company: z.string().nullable(),
  atomicCrmContactId: z.string().nullable(),
  atomicCrmLeadId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ContactDto = z.infer<typeof contactSchema>;

export const contactBoardSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  createdAt: z.string().datetime()
});
export type ContactBoardDto = z.infer<typeof contactBoardSchema>;

export const contactBoardStageSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  boardId: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  order: z.number().int().min(0)
});
export type ContactBoardStageDto = z.infer<typeof contactBoardStageSchema>;

export const contactBoardMembershipSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  contactId: z.string().min(1),
  boardId: z.string().min(1),
  stageId: z.string().min(1),
  isPrimary: z.boolean(),
  updatedAt: z.string().datetime()
});
export type ContactBoardMembershipDto = z.infer<typeof contactBoardMembershipSchema>;
```

- [ ] **Step 4: Run tests and commit**

Run:

```sh
pnpm --filter @prymeira-talk/shared test
pnpm typecheck
```

Expected: shared tests and typecheck pass.

Commit:

```sh
git add packages/shared/src/domain.ts packages/shared/src/domain.test.ts
git commit -m "feat: add Talk suite shared contracts"
```

## Task 2: Database Schema For Functional Suite

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/prisma/seed-demo.ts`

- [ ] **Step 1: Add Prisma models**

Add bounded models for boards, notes, automations, campaigns, assistant logs, CRM sync, integration config, and audit logs. Use `Json @default("{}")` for rule conditions/actions so the first runner can stay simple while still persisting real state.

```prisma
enum IntegrationMode {
  simulated
  real
}

enum AutomationStatus {
  enabled
  disabled
}

enum CampaignStatus {
  draft
  scheduled
  sending
  completed
  failed
}

model ContactBoard {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String   @map("workspace_id")
  name        String
  description String?
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  stages      ContactBoardStage[]
  memberships ContactBoardMembership[]

  @@unique([workspaceId, id])
  @@unique([workspaceId, name])
  @@map("contact_boards")
}

model ContactBoardStage {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String   @map("workspace_id")
  boardId     String   @map("board_id") @db.Uuid
  name        String
  color       String
  order       Int      @default(0) @map("sort_order")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  board       ContactBoard @relation(fields: [workspaceId, boardId], references: [workspaceId, id], onDelete: Cascade)
  memberships ContactBoardMembership[]

  @@unique([workspaceId, id])
  @@unique([workspaceId, boardId, name])
  @@index([workspaceId, boardId, order])
  @@map("contact_board_stages")
}

model ContactBoardMembership {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String   @map("workspace_id")
  contactId   String   @map("contact_id") @db.Uuid
  boardId     String   @map("board_id") @db.Uuid
  stageId     String   @map("stage_id") @db.Uuid
  isPrimary   Boolean  @default(false) @map("is_primary")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  contact Contact           @relation(fields: [workspaceId, contactId], references: [workspaceId, id], onDelete: Cascade)
  board   ContactBoard      @relation(fields: [workspaceId, boardId], references: [workspaceId, id], onDelete: Cascade)
  stage   ContactBoardStage @relation(fields: [workspaceId, stageId], references: [workspaceId, id], onDelete: Restrict)

  @@unique([workspaceId, id])
  @@unique([workspaceId, contactId, boardId])
  @@index([workspaceId, contactId, isPrimary])
  @@index([workspaceId, boardId, stageId])
  @@map("contact_board_memberships")
}

model ContactNote {
  id             String   @id @default(uuid()) @db.Uuid
  workspaceId    String   @map("workspace_id")
  contactId      String   @map("contact_id") @db.Uuid
  conversationId String?  @map("conversation_id") @db.Uuid
  body           String
  createdById    String?  @map("created_by_id") @db.Uuid
  createdAt      DateTime @default(now()) @map("created_at")

  contact Contact @relation(fields: [workspaceId, contactId], references: [workspaceId, id], onDelete: Cascade)

  @@unique([workspaceId, id])
  @@index([workspaceId, contactId, createdAt])
  @@map("contact_notes")
}
```

Also add these models:

```prisma
model AutomationRule {
  id          String           @id @default(uuid()) @db.Uuid
  workspaceId String           @map("workspace_id")
  name        String
  status      AutomationStatus @default(disabled)
  trigger     String
  conditions  Json             @default("{}")
  actions     Json             @default("[]")
  createdAt   DateTime         @default(now()) @map("created_at")
  updatedAt   DateTime         @updatedAt @map("updated_at")

  runs AutomationRun[]

  @@unique([workspaceId, id])
  @@index([workspaceId, status])
  @@map("automation_rules")
}

model AutomationRun {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String   @map("workspace_id")
  ruleId      String   @map("rule_id") @db.Uuid
  eventKey    String   @map("event_key")
  status      String
  input       Json     @default("{}")
  result      Json     @default("{}")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  rule AutomationRule @relation(fields: [workspaceId, ruleId], references: [workspaceId, id], onDelete: Cascade)

  @@unique([workspaceId, id])
  @@unique([workspaceId, ruleId, eventKey])
  @@index([workspaceId, createdAt])
  @@map("automation_runs")
}

model Campaign {
  id          String         @id @default(uuid()) @db.Uuid
  workspaceId String         @map("workspace_id")
  name        String
  status      CampaignStatus @default(draft)
  audience    Json           @default("{}")
  messageBody String         @map("message_body")
  scheduledAt DateTime?      @map("scheduled_at")
  mode        IntegrationMode @default(simulated)
  createdAt   DateTime       @default(now()) @map("created_at")
  updatedAt   DateTime       @updatedAt @map("updated_at")

  recipients CampaignRecipient[]

  @@unique([workspaceId, id])
  @@index([workspaceId, status])
  @@map("campaigns")
}

model CampaignRecipient {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String   @map("workspace_id")
  campaignId  String   @map("campaign_id") @db.Uuid
  contactId   String   @map("contact_id") @db.Uuid
  status      String
  result      Json     @default("{}")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  campaign Campaign @relation(fields: [workspaceId, campaignId], references: [workspaceId, id], onDelete: Cascade)
  contact  Contact  @relation(fields: [workspaceId, contactId], references: [workspaceId, id], onDelete: Cascade)

  @@unique([workspaceId, id])
  @@unique([workspaceId, campaignId, contactId])
  @@index([workspaceId, campaignId, status])
  @@map("campaign_recipients")
}

model AiActionLog {
  id             String          @id @default(uuid()) @db.Uuid
  workspaceId    String          @map("workspace_id")
  conversationId String?         @map("conversation_id") @db.Uuid
  contactId      String?         @map("contact_id") @db.Uuid
  userId         String?         @map("user_id") @db.Uuid
  actionType     String          @map("action_type")
  mode           IntegrationMode @default(simulated)
  input          Json            @default("{}")
  result         Json            @default("{}")
  status         String
  createdAt      DateTime        @default(now()) @map("created_at")

  @@unique([workspaceId, id])
  @@index([workspaceId, createdAt])
  @@map("ai_action_logs")
}

model CrmSyncAction {
  id          String          @id @default(uuid()) @db.Uuid
  workspaceId String          @map("workspace_id")
  contactId   String?         @map("contact_id") @db.Uuid
  actionType  String          @map("action_type")
  mode        IntegrationMode @default(simulated)
  status      String
  payload     Json            @default("{}")
  result      Json            @default("{}")
  createdAt   DateTime        @default(now()) @map("created_at")
  updatedAt   DateTime        @updatedAt @map("updated_at")

  @@unique([workspaceId, id])
  @@index([workspaceId, contactId])
  @@index([workspaceId, createdAt])
  @@map("crm_sync_actions")
}

model IntegrationConfig {
  id          String          @id @default(uuid()) @db.Uuid
  workspaceId String          @map("workspace_id")
  provider    String
  mode        IntegrationMode @default(simulated)
  status      String
  settings    Json            @default("{}")
  createdAt   DateTime        @default(now()) @map("created_at")
  updatedAt   DateTime        @updatedAt @map("updated_at")

  @@unique([workspaceId, id])
  @@unique([workspaceId, provider])
  @@map("integration_configs")
}

model AuditLog {
  id          String   @id @default(uuid()) @db.Uuid
  workspaceId String   @map("workspace_id")
  actorUserId String?  @map("actor_user_id") @db.Uuid
  action      String
  targetType  String   @map("target_type")
  targetId    String?  @map("target_id")
  metadata    Json     @default("{}")
  createdAt   DateTime @default(now()) @map("created_at")

  @@unique([workspaceId, id])
  @@index([workspaceId, createdAt])
  @@map("audit_logs")
}
```

Add relation fields to `Contact`:

```prisma
boardMemberships ContactBoardMembership[]
notes            ContactNote[]
campaignRecipients CampaignRecipient[]
```

- [ ] **Step 2: Create migration and generate client**

Run:

```sh
pnpm --filter @prymeira-talk/api prisma migrate dev --name suite_modules
pnpm prisma:generate
```

Expected: Prisma creates a migration and TypeScript client generation succeeds.

- [ ] **Step 3: Seed demo boards and module data**

Extend `apps/api/prisma/seed-demo.ts` to create:

```ts
const preSalesBoard = await prisma.contactBoard.upsert({
  where: { workspaceId_name: { workspaceId, name: "Pre-vendas" } },
  update: {},
  create: {
    workspaceId,
    name: "Pre-vendas",
    description: "Board principal para contatos comerciais."
  }
});
```

Create stages `Novo`, `Qualificado`, `Proposta enviada`, `Follow-up`, and `Ganho`; attach existing demo contacts to stages with one `isPrimary: true` membership each.

- [ ] **Step 4: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/api seed:demo
pnpm --filter @prymeira-talk/api test
pnpm typecheck
```

Expected: seed completes, API tests pass, typecheck passes.

Commit:

```sh
git add apps/api/prisma apps/api/prisma/seed-demo.ts
git commit -m "feat: add Talk suite database models"
```

## Task 3: Full Sidebar Shell And Module Routing

**Files:**
- Create: `apps/web/src/features/shell/moduleRegistry.ts`
- Create: `apps/web/src/features/shell/TalkSuiteShell.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Create module page files under `apps/web/src/features/*`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Create the module registry**

Create `moduleRegistry.ts`:

```ts
import {
  BarChart3,
  Bot,
  Brain,
  ContactRound,
  Megaphone,
  MessageSquareText,
  Network,
  PlugZap,
  Settings,
  Users
} from "lucide-react";
import type { ComponentType } from "react";

export type TalkModuleKey =
  | "atendimento"
  | "contatos"
  | "canais"
  | "automacoes"
  | "disparos"
  | "relatorios"
  | "equipe"
  | "ia"
  | "atomic_crm"
  | "ajustes";

export interface TalkModuleDefinition {
  key: TalkModuleKey;
  label: string;
  shortLabel: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}

export const talkModules: TalkModuleDefinition[] = [
  { key: "atendimento", label: "Atendimento", shortLabel: "Inbox", icon: MessageSquareText },
  { key: "contatos", label: "Contatos", shortLabel: "Contatos", icon: ContactRound },
  { key: "canais", label: "Canais", shortLabel: "Canais", icon: PlugZap },
  { key: "automacoes", label: "Automacoes", shortLabel: "Auto", icon: Bot },
  { key: "disparos", label: "Disparos", shortLabel: "Disparos", icon: Megaphone },
  { key: "relatorios", label: "Relatorios", shortLabel: "Rel", icon: BarChart3 },
  { key: "equipe", label: "Equipe", shortLabel: "Equipe", icon: Users },
  { key: "ia", label: "IA", shortLabel: "IA", icon: Brain },
  { key: "atomic_crm", label: "Atomic CRM", shortLabel: "CRM", icon: Network },
  { key: "ajustes", label: "Ajustes", shortLabel: "Ajustes", icon: Settings }
];
```

- [ ] **Step 2: Create shell component**

Create `TalkSuiteShell.tsx` so it owns the left rail and renders the active module:

```tsx
import { useState, type ReactNode } from "react";
import { talkModules, type TalkModuleKey } from "./moduleRegistry";

interface TalkSuiteShellProps {
  renderModule: (activeModule: TalkModuleKey) => ReactNode;
}

export function TalkSuiteShell({ renderModule }: TalkSuiteShellProps) {
  const [activeModule, setActiveModule] = useState<TalkModuleKey>("atendimento");

  return (
    <main className="talk-suite-shell">
      <aside className="app-rail" aria-label="Navegacao principal">
        <div className="rail-logo">PT</div>
        <nav className="rail-nav" aria-label="Modulos">
          {talkModules.slice(0, 9).map((module) => {
            const Icon = module.icon;
            return (
              <button
                aria-label={module.label}
                aria-pressed={activeModule === module.key}
                className={activeModule === module.key ? "rail-button is-active" : "rail-button"}
                key={module.key}
                onClick={() => setActiveModule(module.key)}
                title={module.label}
                type="button"
              >
                <Icon size={20} aria-hidden="true" />
              </button>
            );
          })}
        </nav>
        <button
          aria-label="Ajustes"
          aria-pressed={activeModule === "ajustes"}
          className={activeModule === "ajustes" ? "rail-button rail-settings is-active" : "rail-button rail-settings"}
          onClick={() => setActiveModule("ajustes")}
          title="Ajustes"
          type="button"
        >
          {(() => {
            const Icon = talkModules.find((module) => module.key === "ajustes")!.icon;
            return <Icon size={20} aria-hidden="true" />;
          })()}
        </button>
      </aside>
      {renderModule(activeModule)}
    </main>
  );
}
```

- [ ] **Step 3: Move rail out of Atendimento**

Modify `InboxPage.tsx` so it no longer renders the global `<aside className="app-rail">`. It should render the three-panel Atendimento content inside a wrapper such as:

```tsx
return (
  <section className="talk-workspace talk-workspace-atendimento" aria-label="Atendimento">
    {/* existing conversation list, chat panel, and contact panel */}
  </section>
);
```

- [ ] **Step 4: Create initial module screens**

Each page should be a real screen with mode labels and one primary action. Use this pattern:

```tsx
export function ChannelsPage() {
  return (
    <section className="module-page" aria-label="Canais">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Canais</h1>
        </div>
        <span className="mode-pill">Modo simulado</span>
      </header>
      <div className="module-grid">
        <article className="module-panel">
          <h2>Evolution Comercial</h2>
          <p>Instancia pronta para conectar por QR Code.</p>
          <button type="button">Ver QR Code</button>
        </article>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Wire modules in App**

Render the shell from `App.tsx`:

```tsx
<TalkSuiteShell
  renderModule={(activeModule) => {
    if (activeModule === "atendimento") return <InboxPage />;
    if (activeModule === "contatos") return <ContactsPage />;
    if (activeModule === "canais") return <ChannelsPage />;
    if (activeModule === "automacoes") return <AutomationsPage />;
    if (activeModule === "disparos") return <CampaignsPage />;
    if (activeModule === "relatorios") return <ReportsPage />;
    if (activeModule === "equipe") return <TeamPage />;
    if (activeModule === "ia") return <AssistantPage />;
    if (activeModule === "atomic_crm") return <CrmPage />;
    return <SettingsPage />;
  }}
/>
```

- [ ] **Step 6: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/web typecheck
pnpm --filter @prymeira-talk/web build
```

Open `http://localhost:5176` and click every sidebar icon. Expected: every module opens, and Atendimento keeps list/chat/contact.

Commit:

```sh
git add apps/web/src
git commit -m "feat: add Talk suite module shell"
```

## Task 4: Contacts API And Contacts Module

**Files:**
- Create: `apps/api/src/modules/contacts/contacts.service.ts`
- Create: `apps/api/src/modules/contacts/contacts.routes.ts`
- Create: `apps/api/src/modules/contacts/contacts.service.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/contacts/ContactsPage.tsx`

- [ ] **Step 1: Write service tests**

Add tests for tenant-safe contact listing and creation:

```ts
it("lists contacts inside the caller workspace", async () => {
  const prisma = {
    contact: {
      findMany: vi.fn(async () => [{
        id: "contact_1",
        workspaceId: "workspace_1",
        name: "Joao Martins",
        phone: "+5551999999999",
        email: null,
        company: null,
        atomicCrmContactId: null,
        atomicCrmLeadId: null,
        createdAt: new Date("2026-05-21T00:00:00.000Z"),
        updatedAt: new Date("2026-05-21T00:00:00.000Z")
      }])
    }
  };

  const service = createContactsService(prisma);
  const contacts = await service.listContacts({ workspaceId: "workspace_1" });

  expect(prisma.contact.findMany).toHaveBeenCalledWith({
    where: { workspaceId: "workspace_1" },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
    take: 100
  });
  expect(contacts[0]?.name).toBe("Joao Martins");
});
```

- [ ] **Step 2: Implement contacts service**

Create `createContactsService` with `listContacts`, `createContact`, and `updateContact`. Map Prisma records to `ContactDto` from shared schemas.

- [ ] **Step 3: Add routes**

Register:

```ts
app.get("/contacts", async (request) =>
  service.listContacts({ workspaceId: request.talk.workspaceId })
);

app.post("/contacts", async (request, reply) => {
  const body = createContactBodySchema.safeParse(request.body);
  if (!body.success) return reply.code(400).send({ error: "Invalid contact request." });
  const contact = await service.createContact({ workspaceId: request.talk.workspaceId, ...body.data });
  return reply.code(201).send(contact);
});
```

- [ ] **Step 4: Add frontend API functions and UI**

Add `apiGetContacts`, `apiCreateContact`, and `apiUpdateContact` in `apps/web/src/app/api.ts`. Update `ContactsPage.tsx` with:

- Lista and Board segmented control;
- search input;
- create contact form;
- contact table/cards;
- visible empty and error states.

- [ ] **Step 5: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm typecheck
pnpm build
```

Commit:

```sh
git add apps/api/src/modules/contacts apps/api/src/app.ts apps/web/src/app/api.ts apps/web/src/features/contacts apps/web/src/styles.css
git commit -m "feat: add functional contacts module"
```

## Task 5: Contact Boards API And Board View

**Files:**
- Create: `apps/api/src/modules/boards/boards.service.ts`
- Create: `apps/api/src/modules/boards/boards.routes.ts`
- Create: `apps/api/src/modules/boards/boards.service.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/contacts/ContactsPage.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Test board listing and stage movement**

Write tests for:

- `listBoards({ workspaceId })`;
- `listBoardContacts({ workspaceId, boardId })`;
- `moveContactToStage({ workspaceId, membershipId, stageId })`;
- primary membership uniqueness for a contact.

Expected movement assertion:

```ts
expect(prisma.contactBoardMembership.update).toHaveBeenCalledWith({
  where: { workspaceId_id: { workspaceId: "workspace_1", id: "membership_1" } },
  data: { stageId: "stage_2", isPrimary: true }
});
```

- [ ] **Step 2: Implement board routes**

Expose:

```txt
GET /boards
POST /boards
GET /boards/:boardId/contacts
POST /boards/:boardId/stages
POST /boards/:boardId/memberships
PATCH /board-memberships/:membershipId
```

All handlers read `request.talk.workspaceId` and never accept workspace from the body.

- [ ] **Step 3: Add board UI**

In `ContactsPage.tsx`, when Board view is active:

- show board selector;
- show ordered stage columns;
- show contact cards in each stage;
- allow move through column action buttons first: `Mover para proxima etapa` and `Mover para etapa anterior`;
- add pointer drag only after the button flow passes tests.

- [ ] **Step 4: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm typecheck
pnpm build
```

Commit:

```sh
git add apps/api/src/modules/boards apps/api/src/app.ts apps/web/src/app/api.ts apps/web/src/features/contacts apps/web/src/styles.css
git commit -m "feat: add contact boards"
```

## Task 6: Channels With Evolution And Demo QR Flow

**Files:**
- Create: `apps/api/src/modules/channels/channels.service.ts`
- Create: `apps/api/src/modules/channels/channels.routes.ts`
- Create: `apps/api/src/modules/channels/channels.service.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/channels/ChannelsPage.tsx`

- [ ] **Step 1: Test channel state transitions**

Test that demo QR starts a connecting session and returns a deterministic QR payload:

```ts
expect(result.mode).toBe("simulated");
expect(result.qrCode).toContain("prymeira-talk-demo");
expect(result.channel.status).toBe("connecting");
```

- [ ] **Step 2: Implement routes**

Expose:

```txt
GET /channels
POST /channels
POST /channels/:channelId/qr
POST /channels/:channelId/reconnect
POST /channels/:channelId/disconnect
POST /channels/:channelId/test-inbound
```

When real Evolution config is absent, return `mode: "simulated"` and persist the status change.

- [ ] **Step 3: Implement Channels page**

Show:

- channel cards;
- status pill;
- QR Code panel using text payload first;
- connect/reconnect/disconnect/test buttons;
- setup checklist;
- `Modo simulado` label when demo adapter is active.

- [ ] **Step 4: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm typecheck
pnpm build
```

Commit:

```sh
git add apps/api/src/modules/channels apps/api/src/app.ts apps/web/src/app/api.ts apps/web/src/features/channels apps/web/src/styles.css
git commit -m "feat: add channel management"
```

## Task 7: Atendimento Enhancements

**Files:**
- Modify: `apps/api/src/modules/conversations/conversations.service.ts`
- Modify: `apps/api/src/modules/conversations/conversations.routes.ts`
- Modify: `apps/api/src/modules/conversations/conversations.service.test.ts`
- Modify: `apps/web/src/features/inbox/InboxPage.tsx`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Add tests for message sending and contact context**

Test that sending a message creates a pending outbound message and updates the conversation preview. Add a contact context endpoint returning primary board stage, tags, and notes.

- [ ] **Step 2: Enable composer**

In `InboxPage.tsx`, add local `draft` state and submit flow:

```tsx
const [draft, setDraft] = useState("");

async function handleSendMessage(event: FormEvent) {
  event.preventDefault();
  if (!selectedConversationId || !draft.trim() || !token) return;
  const message = await apiSendMessage(selectedConversationId, draft.trim(), async () => token);
  setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
  setDraft("");
}
```

- [ ] **Step 3: Add quick actions**

Add panel actions for:

- add note;
- assign to current user;
- change department;
- change priority;
- change primary board stage;
- request AI suggestion;
- create simulated CRM note.

Each action calls an API endpoint and updates local UI from the response.

- [ ] **Step 4: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm typecheck
pnpm build
```

Commit:

```sh
git add apps/api/src/modules/conversations apps/web/src/app/api.ts apps/web/src/features/inbox apps/web/src/styles.css
git commit -m "feat: enhance atendimento workflow"
```

## Task 8: Automations Local Runner

**Files:**
- Create: `apps/api/src/modules/automations/automations.service.ts`
- Create: `apps/api/src/modules/automations/automations.routes.ts`
- Create: `apps/api/src/modules/automations/automations.service.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/automations/AutomationsPage.tsx`

- [ ] **Step 1: Test idempotent rule execution**

Create a test where the same trigger event runs twice and produces one `AutomationRun`:

```ts
expect(prisma.automationRun.upsert).toHaveBeenCalledWith(expect.objectContaining({
  where: {
    workspaceId_ruleId_eventKey: {
      workspaceId: "workspace_1",
      ruleId: "rule_1",
      eventKey: "message.created:provider_event_1"
    }
  }
}));
```

- [ ] **Step 2: Implement rule CRUD and test execution**

Expose:

```txt
GET /automations
POST /automations
PATCH /automations/:automationId
POST /automations/:automationId/test
GET /automations/:automationId/runs
```

The test action should create an `AutomationRun` with `status: "completed"` and action results in JSON.

- [ ] **Step 3: Build Automations page**

Create rule list, rule editor, trigger selector, condition summary, action list, enable toggle, and execution history.

- [ ] **Step 4: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm typecheck
pnpm build
```

Commit:

```sh
git add apps/api/src/modules/automations apps/api/src/app.ts apps/web/src/app/api.ts apps/web/src/features/automations apps/web/src/styles.css
git commit -m "feat: add local automation runner"
```

## Task 9: Disparos Campaign Module

**Files:**
- Create: `apps/api/src/modules/campaigns/campaigns.service.ts`
- Create: `apps/api/src/modules/campaigns/campaigns.routes.ts`
- Create: `apps/api/src/modules/campaigns/campaigns.service.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/campaigns/CampaignsPage.tsx`

- [ ] **Step 1: Test simulated campaign send**

Test that audience resolution from a board creates campaign recipients with `mode: "simulated"` and result `sent_simulated`.

- [ ] **Step 2: Implement campaign routes**

Expose:

```txt
GET /campaigns
POST /campaigns
PATCH /campaigns/:campaignId
POST /campaigns/:campaignId/resolve-audience
POST /campaigns/:campaignId/send-simulated
GET /campaigns/:campaignId/recipients
```

- [ ] **Step 3: Build Disparos page**

Add campaign list, draft form, audience selector, message preview, scheduling fields, send simulation button, and recipient result table.

- [ ] **Step 4: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm typecheck
pnpm build
```

Commit:

```sh
git add apps/api/src/modules/campaigns apps/api/src/app.ts apps/web/src/app/api.ts apps/web/src/features/campaigns apps/web/src/styles.css
git commit -m "feat: add simulated campaign module"
```

## Task 10: Reports Over Local Data

**Files:**
- Create: `apps/api/src/modules/reports/reports.service.ts`
- Create: `apps/api/src/modules/reports/reports.routes.ts`
- Create: `apps/api/src/modules/reports/reports.service.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/reports/ReportsPage.tsx`

- [ ] **Step 1: Test metric aggregation**

Test that report service returns:

- conversation totals by status;
- message totals by direction;
- campaign result totals;
- automation run totals.

- [ ] **Step 2: Implement route**

Expose:

```txt
GET /reports/overview
```

Return a typed DTO with cards, time series, and breakdown tables.

- [ ] **Step 3: Build reports UI**

Show compact cards, simple bar sections using CSS, tables by department/tag/channel, and export-ready data tables.

- [ ] **Step 4: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm typecheck
pnpm build
```

Commit:

```sh
git add apps/api/src/modules/reports apps/api/src/app.ts apps/web/src/app/api.ts apps/web/src/features/reports apps/web/src/styles.css
git commit -m "feat: add Talk reports"
```

## Task 11: Team, Assistant, CRM, And Settings Modules

**Files:**
- Create service, route, and test files for `team`, `assistant`, `crm`, and `settings`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/app/api.ts`
- Modify page files under `apps/web/src/features/team`, `assistant`, `crm`, and `settings`

- [ ] **Step 1: Add API tests per module**

Team tests:

- list users scoped by workspace;
- create department;
- update user role only when caller role is owner or manager.

Assistant tests:

- create simulated action log for summary and suggested reply;
- return visible `mode: "simulated"`.

CRM tests:

- create simulated link action;
- create simulated lead action;
- list sync actions by contact.

Settings tests:

- get workspace settings;
- update integration mode;
- write audit log entry.

- [ ] **Step 2: Implement routes**

Expose:

```txt
GET /team/users
GET /team/departments
POST /team/departments
PATCH /team/users/:userId

POST /assistant/actions
GET /assistant/actions

GET /crm/sync-actions
POST /crm/link-contact
POST /crm/create-lead
POST /crm/create-note

GET /settings
PATCH /settings
GET /settings/audit-log
```

- [ ] **Step 3: Build module pages**

Each page must include:

- functional list/table;
- create or action form;
- visible simulated mode where applicable;
- success and error state;
- empty state.

- [ ] **Step 4: Verify and commit**

Run:

```sh
pnpm --filter @prymeira-talk/api test
pnpm typecheck
pnpm build
```

Commit:

```sh
git add apps/api/src/modules/team apps/api/src/modules/assistant apps/api/src/modules/crm apps/api/src/modules/settings apps/api/src/app.ts apps/web/src/app/api.ts apps/web/src/features/team apps/web/src/features/assistant apps/web/src/features/crm apps/web/src/features/settings apps/web/src/styles.css
git commit -m "feat: add team assistant crm and settings modules"
```

## Task 12: Realtime Events And Final Verification

**Files:**
- Modify: `packages/shared/src/realtime.ts`
- Modify: API services that mutate module data
- Modify: `apps/web/src/features/inbox/useRealtimeEvents.ts`
- Modify module pages that should respond to realtime updates
- Modify: `README.md`

- [ ] **Step 1: Extend realtime contracts**

Add events:

```ts
export const realtimeEventSchema = z.discriminatedUnion("type", [
  messageCreatedEventSchema,
  conversationUpdatedEventSchema,
  contactUpdatedEventSchema,
  boardMembershipUpdatedEventSchema,
  channelUpdatedEventSchema,
  automationRunCreatedEventSchema,
  campaignUpdatedEventSchema
]);
```

- [ ] **Step 2: Publish mutation events**

For each module mutation, call `app.realtime.publish` with the caller workspace. Events must include no cross-workspace data.

- [ ] **Step 3: Update UI subscriptions**

Atendimento must update contact panel board stage when a membership event arrives. Contacts board must update cards when a membership event arrives. Channels page must update status when channel event arrives.

- [ ] **Step 4: Full verification**

Run:

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @prymeira-talk/api seed:demo
```

Manual browser verification at `http://localhost:5176`:

- every sidebar icon opens a module;
- Atendimento keeps the three-panel WhatsApp-style layout;
- contact create/edit works;
- board stage move works;
- channel QR simulated flow works;
- automation test run creates history;
- campaign simulated send creates recipients;
- reports reflect local data;
- assistant action creates simulated result;
- CRM action creates sync history;
- settings show audit log.

- [ ] **Step 5: Commit**

```sh
git add packages/shared/src/realtime.ts apps/api/src apps/web/src README.md
git commit -m "feat: wire Talk suite realtime updates"
```

## Self-Review

Spec coverage:

- Sidebar modules are implemented by Task 3.
- Controlled simulation is implemented by Tasks 6, 8, 9, and 11.
- Contact boards are implemented by Tasks 2 and 5.
- Atendimento remains the WhatsApp-style cockpit in Tasks 3 and 7.
- Tenant safety is enforced by each API module using `request.talk.workspaceId`.
- Realtime expansion is handled in Task 12.

Execution rule:

- Do not combine tasks into a single commit.
- Run verification commands at the end of each task.
- Keep demo data useful after every database change.
