# Prymeira Talk Professional Agent Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a professional autonomous agent harness that uses a real OpenAI-compatible model, full conversation history, and short business documents such as PDFs and text sources to answer accurately.

**Architecture:** Reuse `IntegrationConfig` for workspace-level AI provider settings, extend the agent runtime with a conversation history builder and deterministic short-document retrieval, add PDF/text ingestion into `AiKnowledgeSource`, and replace the simulated-only provider path with an OpenAI-compatible provider that returns strict structured output. The first retrieval version intentionally avoids vector-only search because the expected documents are short and should often be injected whole.

**Tech Stack:** TypeScript, Fastify, Prisma/Postgres, Zod, React/Vite, Vitest, `pdf-parse`, existing Prymeira Talk settings/agents/automation/runtime modules.

---

## Scope Check

This plan implements the approved MVP only:

- workspace-level OpenAI-compatible provider settings;
- real chat-completions provider with structured JSON output;
- full conversation history in agent context;
- deterministic short-document retrieval;
- PDF/text upload and extraction for short documents;
- document category metadata;
- richer run source logging;
- UI for AI provider settings and document upload.

It does not implement embeddings, pgvector, OCR, large manuals, web browsing, arbitrary tools, or per-agent provider overrides.

## File Map

Create:

- `apps/api/src/modules/agents/ai-provider-settings.ts` - Resolves and validates workspace OpenAI-compatible settings.
- `apps/api/src/modules/agents/conversation-context-builder.ts` - Loads and formats full conversation history.
- `apps/api/src/modules/agents/knowledge-retrieval.ts` - Classifies query intent and scores short documents.
- `apps/api/src/modules/agents/knowledge-ingestion.ts` - Decodes text/PDF uploads and extracts normalized text.
- `apps/api/src/modules/agents/ai-provider-settings.test.ts`
- `apps/api/src/modules/agents/conversation-context-builder.test.ts`
- `apps/api/src/modules/agents/knowledge-retrieval.test.ts`
- `apps/api/src/modules/agents/knowledge-ingestion.test.ts`

Modify:

- `apps/api/package.json` - Add `pdf-parse`.
- `apps/api/src/modules/settings/settings.service.ts` - Mask/preserve AI provider API key.
- `apps/api/src/modules/settings/settings.routes.ts` - Validate `openai_compatible` settings.
- `apps/api/src/modules/settings/settings.service.test.ts` - Cover AI secret masking/preservation.
- `apps/web/src/features/settings/SettingsPage.tsx` - Add AI provider form.
- `apps/web/src/app/api.ts` - Add upload knowledge API helper and AI settings typing helpers if needed.
- `apps/web/src/features/assistant/AgentsPage.tsx` - Add document upload/category UI.
- `apps/web/src/features/assistant/AgentsPage.test.tsx` - Cover document upload controls.
- `apps/api/src/modules/agents/agents.routes.ts` - Add JSON upload endpoint for PDF/text knowledge.
- `apps/api/src/modules/agents/agents.service.ts` - Persist metadata for category/source kind.
- `apps/api/src/modules/agents/agents.service.test.ts` - Cover metadata persistence.
- `apps/api/src/modules/agents/provider-gateway.ts` - Add OpenAI-compatible provider.
- `apps/api/src/modules/agents/provider-gateway.test.ts` - Cover provider request/parse/fail-safe.
- `apps/api/src/modules/agents/agent-runtime.ts` - Use provider settings, conversation history, retrieval harness.
- `apps/api/src/modules/agents/agent-runtime.test.ts` - Cover history, documents, handoff, real provider flow.
- `apps/api/prisma/seed-demo.ts` - Optionally seed a price text source for local demo.
- `README.md` - Add provider/doc harness verification notes.

---

### Task 1: Add AI Provider Settings Backend

**Files:**

- Modify: `apps/api/src/modules/settings/settings.service.ts`
- Modify: `apps/api/src/modules/settings/settings.routes.ts`
- Modify: `apps/api/src/modules/settings/settings.service.test.ts`
- Create: `apps/api/src/modules/agents/ai-provider-settings.ts`
- Create: `apps/api/src/modules/agents/ai-provider-settings.test.ts`

- [ ] **Step 1: Write failing settings service tests**

Add tests to `apps/api/src/modules/settings/settings.service.test.ts` covering:

```ts
it("masks OpenAI-compatible provider API keys", async () => {
  const service = createSettingsService(buildPrisma({
    integrations: [{
      ...baseIntegration,
      provider: "openai_compatible",
      mode: "real",
      settings: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-secret",
        chatModel: "gpt-4.1-mini"
      }
    }]
  }));

  const settings = await service.getSettings({ workspaceId: "workspace_1" });

  expect(settings.integrations[0]?.settings).toMatchObject({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "[redacted]",
    chatModel: "gpt-4.1-mini"
  });
});

it("preserves an existing AI provider API key when saving a redacted key", async () => {
  const prisma = buildPrisma({
    integrations: [{
      ...baseIntegration,
      provider: "openai_compatible",
      settings: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-existing",
        chatModel: "gpt-4.1-mini"
      }
    }]
  });
  const service = createSettingsService(prisma);

  await service.updateIntegrationMode({
    workspaceId: "workspace_1",
    provider: "openai_compatible",
    mode: "real",
    settings: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "[redacted]",
      chatModel: "openai/gpt-4.1-mini"
    }
  });

  expect(prisma.integrationConfig.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      update: expect.objectContaining({
        settings: expect.objectContaining({
          apiKey: "sk-existing",
          baseUrl: "https://openrouter.ai/api/v1",
          chatModel: "openai/gpt-4.1-mini"
        })
      })
    })
  );
});
```

If the existing test helpers use different names, adapt only the fixture names and keep the same assertions.

- [ ] **Step 2: Run the settings tests and verify they fail**

```bash
pnpm --filter @prymeira-talk/api test -- settings.service.test.ts
```

Expected: FAIL because `apiKey` is not in the secret-key set and `openai_compatible` is not validated.

- [ ] **Step 3: Mask and preserve AI provider secrets**

In `apps/api/src/modules/settings/settings.service.ts`, update `SECRET_SETTING_KEYS`:

```ts
const SECRET_SETTING_KEYS = new Set([
  "accessToken",
  "webhookVerifyToken",
  "appSecret",
  "evolutionApiKey",
  "apiKey",
  "token",
  "secret"
]);
```

Update `mergeIntegrationSettings` so `openai_compatible` behaves like `meta_cloud` for preserving secrets:

```ts
const shouldMergeWithPrevious = provider === "meta_cloud" || provider === "openai_compatible";
const merged = shouldMergeWithPrevious
  ? { ...previous, ...incoming }
  : { ...incoming };
```

- [ ] **Step 4: Add AI provider validation**

In `apps/api/src/modules/settings/settings.service.ts`, add:

```ts
function assertOpenAiCompatibleSettingsConfigured(
  provider: string,
  mode: IntegrationMode,
  settings: Prisma.InputJsonValue | undefined
) {
  if (provider !== "openai_compatible" || mode !== "real" || !isSettingsRecord(settings)) {
    return;
  }

  const record = settings as Record<string, unknown>;
  const missingKey = ["baseUrl", "apiKey", "chatModel"].find((key) => !getStringSetting(record, key));

  if (missingKey) {
    throw new SettingsValidationError(
      "SETTINGS_AI_PROVIDER_INCOMPLETE",
      `AI provider setting ${missingKey} is required when the integration is active.`
    );
  }
}
```

Call it inside `updateIntegrationMode` after `assertMetaCloudSettingsConfigured`:

```ts
assertMetaCloudSettingsConfigured(input.provider, input.mode, settings);
assertOpenAiCompatibleSettingsConfigured(input.provider, input.mode, settings);
```

- [ ] **Step 5: Add route schema for AI provider settings**

In `apps/api/src/modules/settings/settings.routes.ts`, add:

```ts
const openAiCompatibleSettingsSchema = z.object({
  baseUrl: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  chatModel: z.string().trim().min(1).optional()
});
```

Extend `updateSettingsBodySchema` before the generic provider branch:

```ts
z.object({
  provider: z.literal("openai_compatible"),
  mode: integrationModeSchema,
  settings: openAiCompatibleSettingsSchema
})
```

- [ ] **Step 6: Create AI provider settings resolver tests**

Create `apps/api/src/modules/agents/ai-provider-settings.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { resolveOpenAiCompatibleSettings } from "./ai-provider-settings.js";

describe("resolveOpenAiCompatibleSettings", () => {
  it("returns inactive when no provider config exists", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue(null)
      }
    };

    await expect(resolveOpenAiCompatibleSettings(prisma, { workspaceId: "workspace_1" }))
      .resolves.toEqual({ active: false, reason: "not_configured" });
  });

  it("returns active settings when mode is real and required fields exist", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "real",
          settings: {
            baseUrl: "https://api.openai.com/v1/",
            apiKey: "sk-test",
            chatModel: "gpt-4.1-mini"
          }
        })
      }
    };

    await expect(resolveOpenAiCompatibleSettings(prisma, { workspaceId: "workspace_1" }))
      .resolves.toEqual({
        active: true,
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        chatModel: "gpt-4.1-mini"
      });
  });
});
```

- [ ] **Step 7: Implement AI provider settings resolver**

Create `apps/api/src/modules/agents/ai-provider-settings.ts`:

```ts
type IntegrationConfigRecord = {
  mode: "simulated" | "real";
  settings: unknown;
};

export type OpenAiCompatibleSettings =
  | { active: false; reason: "not_configured" | "simulated" | "incomplete" }
  | { active: true; baseUrl: string; apiKey: string; chatModel: string };

export interface AiProviderSettingsPrismaLike {
  integrationConfig: {
    findUnique(args: unknown): Promise<IntegrationConfigRecord | null>;
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveOpenAiCompatibleSettings(
  prisma: AiProviderSettingsPrismaLike,
  input: { workspaceId: string }
): Promise<OpenAiCompatibleSettings> {
  const config = await prisma.integrationConfig.findUnique({
    where: {
      workspaceId_provider: {
        workspaceId: input.workspaceId,
        provider: "openai_compatible"
      }
    }
  });

  if (!config) return { active: false, reason: "not_configured" };
  if (config.mode !== "real") return { active: false, reason: "simulated" };

  const settings = readRecord(config.settings);
  const baseUrl = readString(settings, "baseUrl")?.replace(/\/+$/, "");
  const apiKey = readString(settings, "apiKey");
  const chatModel = readString(settings, "chatModel");

  if (!baseUrl || !apiKey || !chatModel) {
    return { active: false, reason: "incomplete" };
  }

  return { active: true, baseUrl, apiKey, chatModel };
}
```

- [ ] **Step 8: Run tests**

```bash
pnpm --filter @prymeira-talk/api test -- settings.service.test.ts ai-provider-settings.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/settings/settings.service.ts apps/api/src/modules/settings/settings.routes.ts apps/api/src/modules/settings/settings.service.test.ts apps/api/src/modules/agents/ai-provider-settings.ts apps/api/src/modules/agents/ai-provider-settings.test.ts
git commit -m "feat: add AI provider settings"
```

---

### Task 2: Add Settings UI For OpenAI-Compatible Provider

**Files:**

- Modify: `apps/web/src/features/settings/SettingsPage.tsx`
- Modify: `apps/web/src/app/api.ts`

- [ ] **Step 1: Add UI helper tests if a settings test file exists**

If `apps/web/src/features/settings/SettingsPage.test.tsx` exists, add helper tests for:

```ts
expect(getAiProviderForm(settingsWithRedactedKey).storedSecrets.apiKey).toBe(true);
expect(buildAiProviderSettingsPayload(form)).toMatchObject({
  baseUrl: "https://api.openai.com/v1",
  chatModel: "gpt-4.1-mini"
});
```

If no settings test file exists, keep this task covered by `pnpm --filter @prymeira-talk/web typecheck` and the manual verification in Task 10.

- [ ] **Step 2: Add form state**

In `SettingsPage.tsx`, add:

```ts
interface AiProviderFormState {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  storedSecrets: {
    apiKey: boolean;
  };
}

const emptyAiProviderForm: AiProviderFormState = {
  enabled: false,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  chatModel: "gpt-4.1-mini",
  storedSecrets: {
    apiKey: false
  }
};
```

Add a reader:

```ts
function getAiProviderForm(settings: SettingsDto): AiProviderFormState {
  const integration = settings.integrations.find((config) => config.provider === "openai_compatible");
  const integrationSettings = asSettingsRecord(integration?.settings);

  return {
    enabled: integration?.mode === "real",
    baseUrl: typeof integrationSettings.baseUrl === "string"
      ? integrationSettings.baseUrl
      : "https://api.openai.com/v1",
    apiKey: "",
    chatModel: typeof integrationSettings.chatModel === "string"
      ? integrationSettings.chatModel
      : "gpt-4.1-mini",
    storedSecrets: {
      apiKey: hasStoredSecret(integrationSettings.apiKey)
    }
  };
}
```

- [ ] **Step 3: Load and update form state**

Inside `SettingsPage`, add:

```ts
const [aiProviderForm, setAiProviderForm] = useState<AiProviderFormState>(emptyAiProviderForm);
```

In `loadSettings`, after `setMetaForm(getMetaCloudForm(nextSettings));`, add:

```ts
setAiProviderForm(getAiProviderForm(nextSettings));
```

Add:

```ts
function updateAiProviderForm(partial: Partial<AiProviderFormState>) {
  setAiProviderForm((current) => ({ ...current, ...partial }));
}

function buildAiProviderSettingsPayload() {
  const nextSettings: Record<string, unknown> = {};
  setTrimmedValue(nextSettings, "baseUrl", aiProviderForm.baseUrl);
  setTrimmedValue(nextSettings, "apiKey", aiProviderForm.apiKey);
  setTrimmedValue(nextSettings, "chatModel", aiProviderForm.chatModel);
  return nextSettings;
}

function validateAiProviderSettings() {
  if (!aiProviderForm.enabled) return null;
  if (!aiProviderForm.baseUrl.trim()) return "Informe a Base URL da IA.";
  if (!aiProviderForm.chatModel.trim()) return "Informe o modelo de chat da IA.";
  if (!aiProviderForm.apiKey.trim() && !aiProviderForm.storedSecrets.apiKey) {
    return "Informe a API key da IA.";
  }
  return null;
}
```

- [ ] **Step 4: Save AI settings separately**

Add:

```ts
async function saveAiProviderSettings(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  setError(null);
  setNotice(null);

  const validationError = validateAiProviderSettings();
  if (validationError) {
    setError(validationError);
    return;
  }

  setIsSaving(true);

  try {
    const nextSettings = await apiUpdateSettings(getToken, {
      provider: "openai_compatible",
      mode: aiProviderForm.enabled ? "real" : "simulated",
      settings: buildAiProviderSettingsPayload()
    });
    setSettings(nextSettings);
    setMetaForm(getMetaCloudForm(nextSettings));
    setAiProviderForm(getAiProviderForm(nextSettings));
    setAuditLog(await apiGetAuditLog(getToken));
    setNotice(aiProviderForm.enabled ? "Provider de IA ativado." : "Provider de IA desativado.");
  } catch (saveError) {
    setError(saveError instanceof Error ? saveError.message : "Não foi possível salvar provider de IA.");
  } finally {
    setIsSaving(false);
  }
}
```

- [ ] **Step 5: Render the AI provider panel**

Inside the existing `ops-grid`, add a `module-panel` with:

```tsx
<form className="module-panel module-form" onSubmit={(event) => void saveAiProviderSettings(event)}>
  <div className="panel-title-row">
    <h2>Provider de IA</h2>
    <span className={`status-badge status-badge--${aiProviderForm.enabled ? "open" : "closed"}`}>
      {aiProviderForm.enabled ? "Ativo" : "Simulado"}
    </span>
  </div>
  <label className="form-field">
    Ativar provider real
    <select
      value={aiProviderForm.enabled ? "real" : "simulated"}
      onChange={(event) => updateAiProviderForm({ enabled: event.target.value === "real" })}
    >
      <option value="simulated">Simulado</option>
      <option value="real">Real</option>
    </select>
  </label>
  <label className="form-field">
    Base URL
    <input
      value={aiProviderForm.baseUrl}
      onChange={(event) => updateAiProviderForm({ baseUrl: event.target.value })}
      placeholder="https://api.openai.com/v1"
    />
  </label>
  <label className="form-field">
    API Key
    <input
      value={aiProviderForm.apiKey}
      onChange={(event) => updateAiProviderForm({ apiKey: event.target.value })}
      placeholder={aiProviderForm.storedSecrets.apiKey ? "Chave salva" : "sk-..."}
      type="password"
    />
  </label>
  <label className="form-field">
    Modelo de chat
    <input
      value={aiProviderForm.chatModel}
      onChange={(event) => updateAiProviderForm({ chatModel: event.target.value })}
      placeholder="gpt-4.1-mini"
    />
  </label>
  <button className="primary-button" disabled={isSaving} type="submit">
    <Save size={15} />
    Salvar IA
  </button>
</form>
```

- [ ] **Step 6: Run verification**

```bash
pnpm --filter @prymeira-talk/web typecheck
pnpm --filter @prymeira-talk/web build
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/features/settings/SettingsPage.tsx apps/web/src/app/api.ts
git commit -m "feat: add AI provider settings UI"
```

---

### Task 3: Add OpenAI-Compatible Provider Gateway

**Files:**

- Modify: `apps/api/src/modules/agents/provider-gateway.ts`
- Modify: `apps/api/src/modules/agents/provider-gateway.test.ts`

- [ ] **Step 1: Write failing provider tests**

Add to `provider-gateway.test.ts`:

```ts
it("calls an OpenAI-compatible chat completions endpoint and parses JSON output", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            reply: "O plano para 3 atendentes custa R$ 299.",
            confidence: 0.91,
            actions: [{ type: "send_message" }],
            handoff: { required: false, reason: null },
            sources: [{ id: "source_1", title: "Precos", category: "precos" }]
          })
        }
      }]
    })
  });

  const provider = createOpenAiCompatibleAgentProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    chatModel: "gpt-4.1-mini",
    fetchImpl: fetchMock
  });

  const output = await provider.generate({
    model: "ignored-runtime-model",
    systemPrompt: "Atenda.",
    userPrompt: "Quanto custa?",
    context: {
      conversationHistory: "cliente: quanto custa?",
      selectedKnowledge: [{ id: "source_1", title: "Precos", content: "R$ 299" }]
    }
  });

  expect(output.reply).toContain("R$ 299");
  expect(fetchMock).toHaveBeenCalledWith(
    "https://api.openai.com/v1/chat/completions",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json"
      })
    })
  );
});

it("throws when OpenAI-compatible output is not valid structured JSON", async () => {
  const provider = createOpenAiCompatibleAgentProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    chatModel: "gpt-4.1-mini",
    fetchImpl: vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] })
    })
  });

  await expect(provider.generate({
    model: "ignored",
    systemPrompt: "Atenda.",
    userPrompt: "Oi",
    context: {}
  })).rejects.toThrow("Invalid agent output");
});
```

- [ ] **Step 2: Run provider tests and verify they fail**

```bash
pnpm --filter @prymeira-talk/api test -- provider-gateway.test.ts
```

Expected: FAIL because `createOpenAiCompatibleAgentProvider` does not exist.

- [ ] **Step 3: Implement provider**

In `provider-gateway.ts`, add:

```ts
type FetchLike = typeof fetch;

export function createOpenAiCompatibleAgentProvider(input: {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  fetchImpl?: FetchLike;
}): AgentProvider {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/+$/, "");

  return {
    async generate(providerInput) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: input.chatModel,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: buildAgentSystemPrompt(providerInput.systemPrompt) },
            { role: "user", content: JSON.stringify({
              userPrompt: providerInput.userPrompt,
              context: providerInput.context
            }) }
          ]
        })
      });

      if (!response.ok) {
        throw new Error(`AI provider request failed: ${response.status}`);
      }

      const data = await response.json() as unknown;
      const content = readOpenAiContent(data);
      return parseAgentOutput(JSON.parse(content));
    }
  };
}

function buildAgentSystemPrompt(systemPrompt: string) {
  return [
    systemPrompt,
    "Responda somente em JSON valido.",
    "Use o historico completo da conversa antes de responder.",
    "Use documentos selecionados quando relevantes.",
    "Nao invente precos, politicas, prazos, garantias ou termos legais.",
    "Se nao houver base suficiente, solicite handoff humano.",
    "Formato obrigatorio: {\"confidence\":number,\"reply\":string|null,\"actions\":[],\"handoff\":{\"required\":boolean,\"reason\":string|null},\"sources\":[]}"
  ].join("\n");
}

function readOpenAiContent(data: unknown) {
  if (!data || typeof data !== "object" || !("choices" in data) || !Array.isArray(data.choices)) {
    throw new Error("AI provider returned an invalid response.");
  }

  const firstChoice = data.choices[0] as unknown;
  if (!firstChoice || typeof firstChoice !== "object" || !("message" in firstChoice)) {
    throw new Error("AI provider returned no message.");
  }

  const message = firstChoice.message as { content?: unknown };
  if (typeof message.content !== "string" || message.content.trim().length === 0) {
    throw new Error("AI provider returned empty content.");
  }

  return message.content;
}
```

- [ ] **Step 4: Run provider tests**

```bash
pnpm --filter @prymeira-talk/api test -- provider-gateway.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/agents/provider-gateway.ts apps/api/src/modules/agents/provider-gateway.test.ts
git commit -m "feat: add OpenAI-compatible agent provider"
```

---

### Task 4: Add Conversation Memory Builder

**Files:**

- Create: `apps/api/src/modules/agents/conversation-context-builder.ts`
- Create: `apps/api/src/modules/agents/conversation-context-builder.test.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.test.ts`

- [ ] **Step 1: Write builder tests**

Create `conversation-context-builder.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildConversationHistoryContext } from "./conversation-context-builder.js";

describe("buildConversationHistoryContext", () => {
  it("loads and formats full conversation history chronologically", async () => {
    const prisma = {
      message: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "msg_1",
            direction: "inbound",
            type: "text",
            body: "Quero saber os planos.",
            createdAt: new Date("2026-06-26T12:00:00.000Z")
          },
          {
            id: "msg_2",
            direction: "outbound",
            type: "text",
            body: "Temos plano para operacao pequena.",
            createdAt: new Date("2026-06-26T12:01:00.000Z")
          }
        ])
      }
    };

    const context = await buildConversationHistoryContext(prisma, {
      workspaceId: "workspace_1",
      conversationId: "conversation_1"
    });

    expect(context.messages).toHaveLength(2);
    expect(context.formatted).toContain("cliente: Quero saber os planos.");
    expect(context.formatted).toContain("atendente: Temos plano para operacao pequena.");
  });
});
```

- [ ] **Step 2: Implement builder**

Create `conversation-context-builder.ts`:

```ts
type MessageRecord = {
  id: string;
  direction: string;
  type: string;
  body: string | null;
  createdAt: Date | string;
};

export interface ConversationHistoryPrismaLike {
  message: {
    findMany(args: unknown): Promise<MessageRecord[]>;
  };
}

function speakerLabel(direction: string, type: string) {
  if (type === "internal_note") return "nota interna";
  if (direction === "inbound") return "cliente";
  if (direction === "outbound") return "atendente";
  return "sistema";
}

function formatDate(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export async function buildConversationHistoryContext(
  prisma: ConversationHistoryPrismaLike,
  input: { workspaceId: string; conversationId: string }
) {
  const messages = await prisma.message.findMany({
    where: {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId
    },
    orderBy: [{ createdAt: "asc" }],
    take: 80
  });

  const normalized = messages.map((message) => ({
    id: message.id,
    direction: message.direction,
    type: message.type,
    body: message.body ?? "",
    createdAt: formatDate(message.createdAt),
    speaker: speakerLabel(message.direction, message.type)
  }));

  return {
    messages: normalized,
    formatted: normalized
      .filter((message) => message.body.trim().length > 0)
      .map((message) => `[${message.createdAt}] ${message.speaker}: ${message.body}`)
      .join("\n")
  };
}
```

- [ ] **Step 3: Update runtime type and context**

In `agent-runtime.ts`, extend the `message` prisma type:

```ts
findMany(args: unknown): Promise<MessageRecord[]>;
```

Import and call:

```ts
import { buildConversationHistoryContext } from "./conversation-context-builder.js";
```

Before `buildContext`, add:

```ts
const conversationHistory = await buildConversationHistoryContext(prisma, {
  workspaceId: runInput.workspaceId,
  conversationId: conversation.id
});
```

Pass it to `buildContext` and add to returned context:

```ts
conversationHistory: conversationHistory.formatted,
conversationMessages: conversationHistory.messages,
```

- [ ] **Step 4: Update runtime tests**

In `agent-runtime.test.ts`, add `message.findMany` to the fake prisma builder and assert:

```ts
expect(provider.generate).toHaveBeenCalledWith(
  expect.objectContaining({
    context: expect.objectContaining({
      conversationHistory: expect.stringContaining("cliente: Quero saber")
    })
  })
);
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @prymeira-talk/api test -- conversation-context-builder.test.ts agent-runtime.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/agents/conversation-context-builder.ts apps/api/src/modules/agents/conversation-context-builder.test.ts apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts
git commit -m "feat: add agent conversation memory"
```

---

### Task 5: Add Short-Document Retrieval Harness

**Files:**

- Create: `apps/api/src/modules/agents/knowledge-retrieval.ts`
- Create: `apps/api/src/modules/agents/knowledge-retrieval.test.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.test.ts`

- [ ] **Step 1: Write retrieval tests**

Create `knowledge-retrieval.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectRelevantKnowledge } from "./knowledge-retrieval.js";

const priceSource = {
  id: "source_price",
  title: "Tabela de precos",
  content: "Plano Operacao: R$ 299 para ate 3 atendentes.",
  metadata: { category: "precos", keywords: ["preco", "plano", "atendentes"] }
};

const policySource = {
  id: "source_policy",
  title: "Politica de cancelamento",
  content: "Cancelamentos devem ser solicitados com 30 dias.",
  metadata: { category: "politicas", keywords: ["cancelamento"] }
};

describe("selectRelevantKnowledge", () => {
  it("selects the price document for price questions", () => {
    const result = selectRelevantKnowledge({
      latestMessage: "quanto custa para 3 atendentes?",
      conversationHistory: "cliente: quero saber os planos",
      instruction: null,
      sources: [policySource, priceSource]
    });

    expect(result.selected[0]?.id).toBe("source_price");
    expect(result.selected[0]?.reasons).toContain("category_match");
  });

  it("does not select unrelated documents when there is no match", () => {
    const result = selectRelevantKnowledge({
      latestMessage: "voces fazem implantacao presencial em Curitiba?",
      conversationHistory: "",
      instruction: null,
      sources: [policySource]
    });

    expect(result.selected).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement retrieval**

Create `knowledge-retrieval.ts`:

```ts
export type KnowledgeRetrievalSource = {
  id: string;
  title: string;
  content: string | null;
  metadata?: unknown;
};

export type SelectedKnowledgeSource = KnowledgeRetrievalSource & {
  category: string | null;
  score: number;
  reasons: string[];
  includedAs: "full_document" | "snippet";
};

const categoryTerms: Record<string, string[]> = {
  precos: ["preco", "precos", "valor", "valores", "plano", "mensalidade", "quanto custa", "custa"],
  politicas: ["politica", "cancelar", "cancelamento", "reembolso", "contrato"],
  produto: ["funciona", "recurso", "integracao", "produto", "ferramenta"],
  onboarding: ["comecar", "configurar", "primeiro acesso", "implantacao"]
};

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");
}

function readMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readCategory(source: KnowledgeRetrievalSource) {
  const metadata = readMetadata(source.metadata);
  return typeof metadata.category === "string" ? metadata.category : null;
}

function readKeywords(source: KnowledgeRetrievalSource) {
  const metadata = readMetadata(source.metadata);
  return Array.isArray(metadata.keywords)
    ? metadata.keywords.filter((keyword): keyword is string => typeof keyword === "string")
    : [];
}

function detectCategories(query: string) {
  const normalized = normalizeText(query);
  return Object.entries(categoryTerms)
    .filter(([, terms]) => terms.some((term) => normalized.includes(normalizeText(term))))
    .map(([category]) => category);
}

export function selectRelevantKnowledge(input: {
  latestMessage: string;
  conversationHistory: string;
  instruction: string | null;
  sources: KnowledgeRetrievalSource[];
}) {
  const query = [input.latestMessage, input.conversationHistory, input.instruction ?? ""].join("\n");
  const normalizedQuery = normalizeText(query);
  const detectedCategories = detectCategories(query);

  const scored = input.sources
    .filter((source) => source.content && source.content.trim().length > 0)
    .map((source) => {
      const category = readCategory(source);
      const keywords = readKeywords(source);
      const normalizedTitle = normalizeText(source.title);
      const normalizedContent = normalizeText(source.content ?? "");
      const reasons: string[] = [];
      let score = 0;

      if (category && detectedCategories.includes(category)) {
        score += 8;
        reasons.push("category_match");
      }

      if (normalizedQuery.includes(normalizedTitle) || normalizedTitle.split(/\s+/).some((term) => term.length > 3 && normalizedQuery.includes(term))) {
        score += 3;
        reasons.push("title_match");
      }

      const keywordMatches = keywords.filter((keyword) => normalizedQuery.includes(normalizeText(keyword)));
      if (keywordMatches.length > 0) {
        score += keywordMatches.length * 2;
        reasons.push("keyword_match");
      }

      const contentTerms = normalizedQuery
        .split(/\W+/)
        .filter((term) => term.length > 4);
      const contentMatches = contentTerms.filter((term) => normalizedContent.includes(term)).slice(0, 5);
      if (contentMatches.length > 0) {
        score += contentMatches.length;
        reasons.push("content_overlap");
      }

      return {
        ...source,
        category,
        score,
        reasons: Array.from(new Set(reasons)),
        includedAs: (source.content?.length ?? 0) <= 18_000 ? "full_document" as const : "snippet" as const
      };
    })
    .filter((source) => source.score >= 3)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);

  return {
    detectedCategories,
    selected: scored
  };
}
```

- [ ] **Step 3: Integrate retrieval into runtime**

Update `KnowledgeSourceRecord` in `agent-runtime.ts`:

```ts
type KnowledgeSourceRecord = {
  id: string;
  title: string;
  content: string | null;
  metadata?: JsonValue;
};
```

Import:

```ts
import { selectRelevantKnowledge } from "./knowledge-retrieval.js";
```

After loading `knowledge`, call:

```ts
const retrieval = selectRelevantKnowledge({
  latestMessage: message.body ?? "",
  conversationHistory: conversationHistory.formatted,
  instruction: runInput.instruction ?? null,
  sources: knowledge
});
```

Pass only `retrieval.selected` to `buildContext`, and set:

```ts
knowledgeMatches = retrieval.selected.map((source) => ({
  id: source.id,
  title: source.title,
  category: source.category,
  score: source.score,
  reasons: source.reasons,
  includedAs: source.includedAs
}));
```

- [ ] **Step 4: Update runtime tests**

Add an expectation that price questions select the price source:

```ts
expect(prisma.aiAgentRun.create).toHaveBeenCalledWith(
  expect.objectContaining({
    data: expect.objectContaining({
      knowledgeMatches: [
        expect.objectContaining({
          id: "knowledge_price",
          category: "precos",
          reasons: expect.arrayContaining(["category_match"])
        })
      ]
    })
  })
);
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @prymeira-talk/api test -- knowledge-retrieval.test.ts agent-runtime.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/agents/knowledge-retrieval.ts apps/api/src/modules/agents/knowledge-retrieval.test.ts apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts
git commit -m "feat: add short document retrieval harness"
```

---

### Task 6: Add PDF/Text Knowledge Ingestion

**Files:**

- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/api/src/modules/agents/knowledge-ingestion.ts`
- Create: `apps/api/src/modules/agents/knowledge-ingestion.test.ts`
- Modify: `apps/api/src/modules/agents/agents.routes.ts`
- Modify: `apps/api/src/modules/agents/agents.service.ts`
- Modify: `apps/api/src/modules/agents/agents.service.test.ts`

- [ ] **Step 1: Add PDF extraction dependency**

```bash
pnpm --filter @prymeira-talk/api add pdf-parse
```

Expected: `apps/api/package.json` and `pnpm-lock.yaml` update.

- [ ] **Step 2: Write ingestion tests**

Create `knowledge-ingestion.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ingestKnowledgeUpload } from "./knowledge-ingestion.js";

describe("ingestKnowledgeUpload", () => {
  it("normalizes plain text uploads", async () => {
    const result = await ingestKnowledgeUpload({
      fileName: "precos.txt",
      mimeType: "text/plain",
      base64Content: Buffer.from("Plano  Operacao\\nR$ 299").toString("base64"),
      category: "precos"
    });

    expect(result.content).toBe("Plano Operacao R$ 299");
    expect(result.metadata).toMatchObject({
      category: "precos",
      sourceKind: "text",
      textCharCount: 22
    });
  });

  it("rejects unsupported file types", async () => {
    await expect(ingestKnowledgeUpload({
      fileName: "imagem.png",
      mimeType: "image/png",
      base64Content: Buffer.from("x").toString("base64"),
      category: "produto"
    })).rejects.toThrow("Unsupported knowledge file type.");
  });
});
```

- [ ] **Step 3: Implement ingestion**

Create `knowledge-ingestion.ts`:

```ts
import pdfParse from "pdf-parse";

export type KnowledgeCategory =
  | "precos"
  | "produto"
  | "faq"
  | "politicas"
  | "onboarding"
  | "comercial"
  | "suporte"
  | "outro";

function normalizeExtractedText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function deriveKeywords(text: string) {
  return Array.from(new Set(
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase("pt-BR")
      .split(/\W+/)
      .filter((term) => term.length >= 5)
  )).slice(0, 24);
}

export async function ingestKnowledgeUpload(input: {
  fileName: string;
  mimeType: string;
  base64Content: string;
  category: KnowledgeCategory;
}) {
  const buffer = Buffer.from(input.base64Content, "base64");
  const lowerFileName = input.fileName.toLocaleLowerCase("pt-BR");
  const isPdf = input.mimeType === "application/pdf" || lowerFileName.endsWith(".pdf");
  const isText = input.mimeType.startsWith("text/") || lowerFileName.endsWith(".txt");

  if (!isPdf && !isText) {
    throw new Error("Unsupported knowledge file type.");
  }

  const rawText = isPdf
    ? (await pdfParse(buffer)).text
    : buffer.toString("utf8");
  const content = normalizeExtractedText(rawText);

  if (!content) {
    throw new Error("Knowledge file did not contain readable text.");
  }

  return {
    content,
    metadata: {
      category: input.category,
      sourceKind: isPdf ? "pdf" : "text",
      extractionMethod: isPdf ? "pdf-parse" : "plain-text",
      extractedAt: new Date().toISOString(),
      keywords: deriveKeywords(content),
      textCharCount: content.length
    }
  };
}
```

- [ ] **Step 4: Extend service create knowledge metadata**

In `agents.service.ts`, update `createKnowledgeSource` input:

```ts
metadata?: Record<string, unknown>;
```

Set:

```ts
metadata: input.metadata ?? {}
```

- [ ] **Step 5: Add upload route**

In `agents.routes.ts`, add:

```ts
const knowledgeCategorySchema = z.enum([
  "precos",
  "produto",
  "faq",
  "politicas",
  "onboarding",
  "comercial",
  "suporte",
  "outro"
]);

const uploadKnowledgeBodySchema = z.object({
  title: z.string().trim().min(1).max(160),
  category: knowledgeCategorySchema,
  fileName: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(160),
  base64Content: z.string().trim().min(1)
});
```

Import:

```ts
import { ingestKnowledgeUpload } from "./knowledge-ingestion.js";
```

Add route:

```ts
app.post("/agents/:agentId/knowledge/upload", async (request, reply) => {
  if (!requireAgentManage(request.talk.role, reply)) {
    return reply;
  }

  const params = agentParamsSchema.safeParse(request.params);
  const body = uploadKnowledgeBodySchema.safeParse(request.body);
  if (!params.success || !body.success) {
    return reply.code(400).send({ error: "Invalid knowledge upload request." });
  }

  try {
    const ingestion = await ingestKnowledgeUpload(body.data);
    const source = await service.createKnowledgeSource({
      workspaceId: request.talk.workspaceId,
      agentId: params.data.agentId,
      type: body.data.mimeType === "application/pdf" ? "file" : "text",
      title: body.data.title,
      content: ingestion.content,
      fileName: body.data.fileName,
      mimeType: body.data.mimeType,
      metadata: ingestion.metadata
    });

    return reply.code(201).send(source);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Knowledge file")) {
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof Error && error.message.includes("Unsupported knowledge file")) {
      return reply.code(400).send({ error: error.message });
    }
    return handleAgentsError(reply, error);
  }
});
```

- [ ] **Step 6: Update tests**

In `agents.service.test.ts`, assert metadata is passed:

```ts
expect(prisma.aiKnowledgeSource.create).toHaveBeenCalledWith(
  expect.objectContaining({
    data: expect.objectContaining({
      metadata: expect.objectContaining({ category: "precos" })
    })
  })
);
```

- [ ] **Step 7: Run tests**

```bash
pnpm --filter @prymeira-talk/api test -- knowledge-ingestion.test.ts agents.service.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/modules/agents/knowledge-ingestion.ts apps/api/src/modules/agents/knowledge-ingestion.test.ts apps/api/src/modules/agents/agents.routes.ts apps/api/src/modules/agents/agents.service.ts apps/api/src/modules/agents/agents.service.test.ts
git commit -m "feat: add agent document ingestion"
```

---

### Task 7: Wire Real Provider And Harness Into Agent Runtime

**Files:**

- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.ts`
- Modify: `apps/api/src/modules/agents/agent-runtime.test.ts`
- Modify: `apps/api/src/modules/agents/provider-gateway.ts`

- [ ] **Step 1: Write runtime tests for real provider selection**

In `agent-runtime.test.ts`, add:

```ts
it("uses the real OpenAI-compatible provider when workspace settings are active", async () => {
  const provider = buildProvider({
    reply: "O plano para 3 atendentes custa R$ 299.",
    confidence: 0.92,
    actions: [],
    handoff: { required: false, reason: null }
  });
  const prisma = buildPrisma({
    integrationConfig: {
      findUnique: vi.fn().mockResolvedValue({
        mode: "real",
        settings: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          chatModel: "gpt-4.1-mini"
        }
      })
    }
  });
  const runtime = createAgentRuntime({
    prisma,
    provider,
    providerFactory: () => provider
  });

  await runtime.runForMessage({
    workspaceId: "workspace_1",
    agentId: baseAgent.id,
    conversationId: baseConversation.id,
    messageId: baseMessage.id,
    trigger: "automation"
  });

  expect(provider.generate).toHaveBeenCalled();
});
```

Adapt fake helpers to the existing test harness.

- [ ] **Step 2: Extend runtime constructor**

In `agent-runtime.ts`, change constructor input to:

```ts
export function createAgentRuntime(input: {
  prisma: AgentRuntimePrismaLike;
  provider: AgentProvider;
  providerFactory?: (settings: {
    baseUrl: string;
    apiKey: string;
    chatModel: string;
  }) => AgentProvider;
}) {
```

Extend `AgentRuntimePrismaLike`:

```ts
integrationConfig: AiProviderSettingsPrismaLike["integrationConfig"];
```

- [ ] **Step 3: Resolve provider per run**

Import:

```ts
import { resolveOpenAiCompatibleSettings } from "./ai-provider-settings.js";
import { createOpenAiCompatibleAgentProvider } from "./provider-gateway.js";
```

Before `provider.generate`, resolve:

```ts
const providerSettings = await resolveOpenAiCompatibleSettings(prisma, {
  workspaceId: runInput.workspaceId
});
const runProvider = providerSettings.active
  ? (input.providerFactory ?? createOpenAiCompatibleAgentProvider)(providerSettings)
  : provider;
```

Call:

```ts
providerOutput = await runProvider.generate({
  model: providerSettings.active ? providerSettings.chatModel : agent.model,
  systemPrompt: agent.systemPrompt,
  userPrompt: buildUserPrompt(message.body, runInput.instruction),
  context
});
```

- [ ] **Step 4: Add document-dependent handoff guard**

In `knowledge-retrieval.ts`, export:

```ts
export function isDocumentDependentQuestion(value: string) {
  return detectCategories(value).some((category) => ["precos", "politicas"].includes(category));
}
```

In runtime, before model call:

```ts
if (isDocumentDependentQuestion(`${message.body ?? ""}\n${conversationHistory.formatted}`) && retrieval.selected.length === 0) {
  providerOutput = {
    confidence: 0.2,
    reply: "Vou chamar uma pessoa do time para confirmar essa informacao com seguranca.",
    actions: [{ type: "request_handoff", reason: "No relevant document found for a document-dependent question." }],
    handoff: {
      required: true,
      reason: "No relevant document found for a document-dependent question."
    }
  };
} else {
  providerOutput = await runProvider.generate({
    model: providerSettings.active ? providerSettings.chatModel : agent.model,
    systemPrompt: agent.systemPrompt,
    userPrompt: buildUserPrompt(message.body, runInput.instruction),
    context
  });
}
```

- [ ] **Step 5: Update app runtime wiring**

In `apps/api/src/app.ts`, wherever `createAgentRuntime` is called, keep the simulated fallback:

```ts
const agentRuntime = createAgentRuntime({
  prisma,
  provider: createSimulatedAgentProvider()
});
```

No app-level change is needed if the runtime creates the real provider internally from settings.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @prymeira-talk/api test -- agent-runtime.test.ts provider-gateway.test.ts ai-provider-settings.test.ts knowledge-retrieval.test.ts
pnpm --filter @prymeira-talk/api typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/modules/agents/agent-runtime.ts apps/api/src/modules/agents/agent-runtime.test.ts apps/api/src/modules/agents/provider-gateway.ts apps/api/src/modules/agents/knowledge-retrieval.ts
git commit -m "feat: run agents with professional harness"
```

---

### Task 8: Add Agent Document Upload UI

**Files:**

- Modify: `apps/web/src/app/api.ts`
- Modify: `apps/web/src/features/assistant/AgentsPage.tsx`
- Modify: `apps/web/src/features/assistant/AgentsPage.test.tsx`

- [ ] **Step 1: Add API helper**

In `api.ts`, export:

```ts
export async function apiUploadAgentKnowledge(
  getToken: () => Promise<string | null>,
  agentId: string,
  body: {
    title: string;
    category: string;
    fileName: string;
    mimeType: string;
    base64Content: string;
  }
): Promise<AiKnowledgeSourceDto> {
  return fetchJson(
    getToken,
    `/agents/${agentId}/knowledge/upload`,
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    parseKnowledgeSource,
    "Failed to upload agent knowledge"
  );
}
```

Reuse existing `fileToBase64Payload` if it is not exported; keep it private and call it from a new API helper that accepts `File` only if that fits local style. Prefer the JSON-body helper above and convert the file in `AgentsPage.tsx`.

- [ ] **Step 2: Add UI state**

In `AgentsPage.tsx`, add:

```ts
type KnowledgeUploadFormState = {
  title: string;
  category: "precos" | "produto" | "faq" | "politicas" | "onboarding" | "comercial" | "suporte" | "outro";
  file: File | null;
};
```

Add state:

```ts
const [knowledgeUploadForm, setKnowledgeUploadForm] = useState<KnowledgeUploadFormState>({
  title: "",
  category: "precos",
  file: null
});
const [isUploadingKnowledge, setIsUploadingKnowledge] = useState(false);
```

- [ ] **Step 3: Add local base64 helper**

In `AgentsPage.tsx`, add:

```ts
async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}
```

- [ ] **Step 4: Add upload handler**

Add:

```ts
async function uploadKnowledge(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();

  if (!selectedAgent || !knowledgeUploadForm.file) {
    setError("Selecione um agente e um arquivo.");
    return;
  }

  setIsUploadingKnowledge(true);
  setError(null);
  setNotice(null);

  try {
    const file = knowledgeUploadForm.file;
    const createdSource = await apiUploadAgentKnowledge(getToken, selectedAgent.id, {
      title: knowledgeUploadForm.title || file.name,
      category: knowledgeUploadForm.category,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      base64Content: await fileToBase64(file)
    });

    setKnowledge((current) => [createdSource, ...current]);
    setKnowledgeUploadForm({ title: "", category: "precos", file: null });
    setNotice("Documento adicionado ao agente.");
  } catch (uploadError) {
    setError(uploadError instanceof Error ? uploadError.message : "Nao foi possivel enviar o documento.");
  } finally {
    setIsUploadingKnowledge(false);
  }
}
```

- [ ] **Step 5: Render upload form**

Inside the `Conhecimento` panel, before the manual FAQ/text form, add:

```tsx
<form className="module-form" onSubmit={(event) => void uploadKnowledge(event)}>
  <label className="form-field">
    Categoria
    <select
      value={knowledgeUploadForm.category}
      onChange={(event) => setKnowledgeUploadForm((current) => ({
        ...current,
        category: event.target.value as KnowledgeUploadFormState["category"]
      }))}
      disabled={!selectedAgent}
    >
      <option value="precos">Precos</option>
      <option value="produto">Produto</option>
      <option value="faq">FAQ</option>
      <option value="politicas">Politicas</option>
      <option value="onboarding">Onboarding</option>
      <option value="comercial">Comercial</option>
      <option value="suporte">Suporte</option>
      <option value="outro">Outro</option>
    </select>
  </label>
  <label className="form-field">
    Titulo do documento
    <input
      value={knowledgeUploadForm.title}
      onChange={(event) => setKnowledgeUploadForm((current) => ({ ...current, title: event.target.value }))}
      placeholder="Tabela de precos"
      disabled={!selectedAgent}
    />
  </label>
  <label className="form-field">
    Arquivo PDF ou texto
    <input
      accept="application/pdf,text/plain,.txt"
      disabled={!selectedAgent}
      onChange={(event) => setKnowledgeUploadForm((current) => ({
        ...current,
        file: event.target.files?.[0] ?? null
      }))}
      type="file"
    />
  </label>
  <button className="secondary-button" type="submit" disabled={!selectedAgent || !knowledgeUploadForm.file || isUploadingKnowledge}>
    <Plus size={15} />
    {isUploadingKnowledge ? "Enviando" : "Adicionar documento"}
  </button>
</form>
```

- [ ] **Step 6: Show category metadata in list**

When rendering `knowledge.map`, read metadata safely:

```ts
const metadata = source.metadata && typeof source.metadata === "object" && !Array.isArray(source.metadata)
  ? source.metadata as Record<string, unknown>
  : {};
const category = typeof metadata.category === "string" ? metadata.category : null;
```

Add a badge:

```tsx
{category ? <span className="status-badge status-badge--bot">{category}</span> : null}
```

- [ ] **Step 7: Update rendering test**

In `AgentsPage.test.tsx`, assert:

```ts
expect(html).toContain("Arquivo PDF ou texto");
expect(html).toContain("Adicionar documento");
expect(html).toContain("Precos");
```

- [ ] **Step 8: Run tests**

```bash
pnpm --filter @prymeira-talk/web test -- AgentsPage.test.tsx
pnpm --filter @prymeira-talk/web typecheck
pnpm --filter @prymeira-talk/web build
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/app/api.ts apps/web/src/features/assistant/AgentsPage.tsx apps/web/src/features/assistant/AgentsPage.test.tsx
git commit -m "feat: upload agent knowledge documents"
```

---

### Task 9: Demo Seed And Docs

**Files:**

- Modify: `apps/api/prisma/seed-demo.ts`
- Modify: `README.md`

- [ ] **Step 1: Seed a price knowledge source**

In `seed-demo.ts`, update the existing `aiKnowledgeSource.upsert` for `Secretaria IA` to include metadata:

```ts
metadata: {
  category: "precos",
  sourceKind: "text",
  extractionMethod: "seed-demo",
  keywords: ["preco", "plano", "mensalidade", "atendentes"],
  textCharCount: 128
}
```

Change content to something directly testable:

```ts
content: "Plano Operacao: R$ 299 por mes para ate 3 atendentes. Inclui atendimento WhatsApp, automacoes basicas e historico de conversas."
```

- [ ] **Step 2: Update README verification**

In the Suite Verification Checklist, add:

```md
- Ajustes can save an OpenAI-compatible AI provider with a redacted API key;
- Agentes can upload a short price PDF/text source and tag it as Precos;
- Secretaria IA answers price questions using the selected price source and full conversation history;
```

- [ ] **Step 3: Run seed and focused checks**

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm --filter @prymeira-talk/api prisma db push
pnpm --filter @prymeira-talk/api seed:demo
curl -fsS -H "Authorization: Bearer local-dev-bypass" http://localhost:3002/agents
```

Expected: `Secretaria IA` exists and has a ready price source.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/seed-demo.ts README.md
git commit -m "docs: add professional agent harness demo"
```

---

### Task 10: Final Verification And Manual Demo

**Files:** None unless verification finds a defect.

- [ ] **Step 1: Run full automated verification**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected:

- shared tests pass;
- API tests pass;
- web tests pass;
- typecheck passes;
- build passes, allowing the existing Vite chunk-size warning.

- [ ] **Step 2: Run database/demo verification**

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm --filter @prymeira-talk/api prisma db push
pnpm --filter @prymeira-talk/api seed:demo
```

Expected: seed completes with `Seeded 5 demo conversations for local_workspace.`

- [ ] **Step 3: Start local app**

```bash
PRYMEIRA_LOCAL_AUTH_BYPASS=true PRYMEIRA_LOCAL_WORKSPACE_ID=local_workspace PRYMEIRA_LOCAL_ROLE=owner pnpm --filter @prymeira-talk/api dev
VITE_LOCAL_AUTH_BYPASS=true VITE_API_URL=http://localhost:3002 pnpm --filter @prymeira-talk/web dev
```

Expected:

- API listens on `http://localhost:3002`;
- Web listens on `http://localhost:5176` or an explicitly chosen port.

- [ ] **Step 4: Manual UI verification**

Open the web app and verify:

- Ajustes shows Provider de IA;
- saving simulated mode works with no key;
- saving real mode requires base URL, key, and model;
- saved key returns as redacted after refresh;
- Agentes shows Secretaria IA;
- Agentes accepts a short text/PDF document under category `Precos`;
- Automacoes can select Secretaria IA in `Executar agente`;
- an inbound/manual simulation asking "quanto custa para 3 atendentes?" produces an agent run that selected the price source;
- Atendimento shows the agent reply or handoff state;
- clicking `Assumir` causes future agent runs for that conversation to be skipped;
- clicking `Liberar IA` allows future runs again.

- [ ] **Step 5: Inspect final git state**

```bash
git status --short
git log --oneline -10
```

Expected:

- only expected `tmp/` remains untracked;
- recent commits match the task commits.
