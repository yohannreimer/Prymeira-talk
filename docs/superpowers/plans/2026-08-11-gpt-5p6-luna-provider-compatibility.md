# GPT-5.6 Luna Provider Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GPT-5.6 Luna the production workspace model for every Prymeira Talk agent while preserving GPT-5.4 compatibility and safe provider diagnostics.

**Architecture:** Keep Chat Completions and introduce a model-aware request builder inside the provider gateway. GPT-5.6 requests explicitly use `reasoning_effort: "none"` and omit `temperature`; other models retain the current payload. Non-2xx responses expose only allowlisted normalized metadata, while the frontend default changes without overwriting persisted workspace settings.

**Tech Stack:** TypeScript, Fastify, React 19, Vitest, pnpm workspaces, Docker/GHCR, Docker Swarm through Portainer.

---

## File Map

- Modify `apps/api/src/modules/agents/provider-gateway.ts`: model-aware payload and safe provider errors.
- Modify `apps/api/src/modules/agents/provider-gateway.test.ts`: Luna, legacy, and error contracts.
- Modify `apps/web/src/features/settings/SettingsPage.tsx`: Luna default and testable form mapper.
- Modify `apps/web/src/features/settings/SettingsPage.test.tsx`: default and persisted-model coverage.
- Reference `docs/superpowers/specs/2026-08-11-gpt-5p6-luna-provider-compatibility-design.md`: approved behavior and release gates.

## Task 0: Create an Isolated Production-Based Worktree

**Files:** No source files change.

- [ ] **Step 1: Refresh and inspect the deployment branch**

```bash
git fetch origin
git rev-list --left-right --count origin/codex/prymeira-talk-foundation...codex/local-integrated-demo
```

Expected: the local demo branch is ahead and the deployment branch is not divergent. Do not merge the local demo branch into production.

- [ ] **Step 2: Create the dedicated implementation worktree**

```bash
git worktree add "../Prymeira Talk Luna" -b codex/gpt-5p6-luna-provider origin/codex/prymeira-talk-foundation
cd "../Prymeira Talk Luna"
git status --short
pnpm install --frozen-lockfile
git status --short
```

Expected: branch `codex/gpt-5p6-luna-provider`, clean status before and after dependency installation.

## Task 1: Add the GPT-5.6 Request Contract

**Files:**

- Modify `apps/api/src/modules/agents/provider-gateway.test.ts:223`
- Modify `apps/api/src/modules/agents/provider-gateway.ts:345-383`

- [ ] **Step 1: Write the failing GPT-5.6 tests**

Add inside `describe("createOpenAiCompatibleAgentProvider", ...)` after the configured-model test:

```ts
  it.each(["gpt-5.6-luna", "gpt-5.6-terra"])(
    "uses the GPT-5.6 reasoning baseline for %s",
    async (chatModel) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                confidence: 0.9,
                reply: "Resposta do modelo.",
                actions: [],
                handoff: { required: false, reason: null }
              })
            }
          }]
        }))
      );
      const provider = createOpenAiCompatibleAgentProvider({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "secret-api-key",
        chatModel,
        fetchImpl: fetchMock
      });

      await provider.generate({
        model: "runtime-model",
        systemPrompt: "Atenda clientes da Prymeira Talk.",
        userPrompt: "Olá",
        context: {}
      });

      const [, init] = fetchMock.mock.calls[0] ?? [];
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual(expect.objectContaining({
        model: chatModel,
        reasoning_effort: "none",
        response_format: { type: "json_object" }
      }));
      expect(body).not.toHaveProperty("temperature");
      expect(body.messages).toHaveLength(2);
    }
  );

  it("keeps the legacy sampling contract outside GPT-5.6", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              confidence: 0.9,
              reply: "Resposta do modelo.",
              actions: [],
              handoff: { required: false, reason: null }
            })
          }
        }]
      }))
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret-api-key",
      chatModel: "gpt-5.4",
      fetchImpl: fetchMock
    });

    await provider.generate({
      model: "runtime-model",
      systemPrompt: "Atenda clientes da Prymeira Talk.",
      userPrompt: "Olá",
      context: {}
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual(expect.objectContaining({
      model: "gpt-5.4",
      temperature: 0.2,
      response_format: { type: "json_object" }
    }));
    expect(body).not.toHaveProperty("reasoning_effort");
  });
```

- [ ] **Step 2: Prove the new cases fail**

```bash
pnpm --filter @prymeira-talk/api test -- provider-gateway.test.ts
```

Expected: GPT-5.6 cases fail because `temperature` is present and `reasoning_effort` is absent; legacy passes.

- [ ] **Step 3: Implement the request builder**

Insert before `createOpenAiCompatibleAgentProvider`:

```ts
function isGpt56Model(model: string) {
  return /^gpt-5\.6(?:-|$)/i.test(model.trim());
}

function buildOpenAiCompatibleRequestBody(input: {
  chatModel: string;
  systemPrompt: string;
  userPrompt: string;
  context: Record<string, unknown>;
}) {
  const sharedBody = {
    model: input.chatModel,
    response_format: { type: "json_object" as const },
    messages: [
      {
        role: "system",
        content: buildOpenAiCompatibleSystemPrompt(input.systemPrompt)
      },
      {
        role: "user",
        content: buildOpenAiCompatibleUserContent(input.userPrompt, input.context)
      }
    ]
  };

  return isGpt56Model(input.chatModel)
    ? { ...sharedBody, reasoning_effort: "none" as const }
    : { ...sharedBody, temperature: 0.2 };
}
```

Replace the inline request body with:

```ts
          body: JSON.stringify(
            buildOpenAiCompatibleRequestBody({
              chatModel: input.chatModel,
              systemPrompt: agentInput.systemPrompt,
              userPrompt: agentInput.userPrompt,
              context: agentInput.context
            })
          )
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @prymeira-talk/api test -- provider-gateway.test.ts
git add apps/api/src/modules/agents/provider-gateway.ts apps/api/src/modules/agents/provider-gateway.test.ts
git commit -m "fix: support GPT-5.6 Luna request parameters"
```

Expected: all focused tests pass; commit contains only request construction and tests.

## Task 2: Surface Safe Provider Error Metadata

**Files:**

- Modify `apps/api/src/modules/agents/provider-gateway.test.ts:652-671`
- Modify `apps/api/src/modules/agents/provider-gateway.ts:345-414`

- [ ] **Step 1: Write the failing structured-error test**

Add immediately before the existing non-OK provider-response test:

```ts
  it("surfaces only allowlisted metadata from structured provider errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: "Request echoed secret-api-key and private customer text.",
            type: "invalid_request_error",
            code: "unsupported_value",
            param: "temperature"
          },
          requestBody: "private prompt"
        }),
        { status: 400 }
      )
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "gpt-5.6-luna",
      fetchImpl: fetchMock
    });

    const error = await provider.generate({
      model: "runtime-model",
      systemPrompt: "Private system prompt.",
      userPrompt: "Private customer text.",
      context: {}
    }).catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "OpenAI-compatible provider request failed with status 400 " +
        "(type invalid_request_error, code unsupported_value, param temperature)."
    );
    expect((error as Error).message).not.toContain("secret-api-key");
    expect((error as Error).message).not.toContain("Private");
    expect((error as Error).message).not.toContain("Request echoed");
  });

  it("rejects unsafe metadata and keeps the status-only fallback", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        error: {
          type: "invalid request with spaces",
          code: "x".repeat(81),
          param: "temperature; secret-api-key"
        }
      }), { status: 400 })
    );
    const provider = createOpenAiCompatibleAgentProvider({
      baseUrl: "https://provider.example",
      apiKey: "secret-api-key",
      chatModel: "gpt-5.6-luna",
      fetchImpl: fetchMock
    });

    await expect(provider.generate({
      model: "runtime-model",
      systemPrompt: "Atenda clientes.",
      userPrompt: "Olá",
      context: {}
    })).rejects.toThrow(
      "OpenAI-compatible provider request failed with status 400."
    );
  });
```

Keep the existing 429 test unchanged. Its non-standard `{ error: string }` body must remain status-only.

- [ ] **Step 2: Prove the structured contract fails**

```bash
pnpm --filter @prymeira-talk/api test -- provider-gateway.test.ts
```

Expected: the allowlisted-metadata test fails because the gateway returns only status 400.

- [ ] **Step 3: Implement strict metadata allowlisting**

Insert after `isRecord` and before the request-builder functions:

```ts
function normalizeProviderErrorDetail(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const normalized = String(value).trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(normalized) ? normalized : null;
}

async function createProviderResponseError(response: Response) {
  const details: string[] = [];

  try {
    const payload = await response.json() as unknown;
    const error = isRecord(payload) && isRecord(payload.error)
      ? payload.error
      : null;

    if (error) {
      for (const key of ["type", "code", "param"] as const) {
        const value = normalizeProviderErrorDetail(error[key]);
        if (value) {
          details.push(`${key} ${value}`);
        }
      }
    }
  } catch {
    // Preserve status-only behavior for malformed or non-JSON responses.
  }

  const metadata = details.length > 0 ? ` (${details.join(", ")})` : "";
  return new Error(
    `OpenAI-compatible provider request failed with status ${response.status}${metadata}.`
  );
}
```

Replace the existing non-OK block with:

```ts
      if (!response.ok) {
        throw await createProviderResponseError(response);
      }
```

- [ ] **Step 4: Verify, typecheck, and commit**

```bash
pnpm --filter @prymeira-talk/api test -- provider-gateway.test.ts
pnpm --filter @prymeira-talk/api typecheck
git add apps/api/src/modules/agents/provider-gateway.ts apps/api/src/modules/agents/provider-gateway.test.ts
git commit -m "fix: expose safe AI provider error metadata"
```

Expected: tests and typecheck pass; no error contains message, key, prompt, raw body, or unsafe metadata.

## Task 3: Make Luna the New-Workspace UI Default

**Files:**

- Modify `apps/web/src/features/settings/SettingsPage.test.tsx:1-41`
- Modify `apps/web/src/features/settings/SettingsPage.tsx:72-80,128-145`

- [ ] **Step 1: Write the failing frontend tests**

Use these imports in `SettingsPage.test.tsx`:

```ts
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsDto } from "../../app/api";
import { getAiProviderForm, SettingsPage } from "./SettingsPage";
```

Add inside `describe("SettingsPage", ...)`:

```ts
  it("defaults an unconfigured AI provider to GPT-5.6 Luna", () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('value="gpt-5.6-luna"');
  });

  it("preserves the model saved for an existing workspace", () => {
    const settings: SettingsDto = {
      workspace: {
        workspaceId: "workspace_a",
        name: "Workspace de teste",
        plan: "Free",
        limits: {},
        createdAt: null,
        updatedAt: null
      },
      integrations: [{
        id: "integration_openai",
        workspaceId: "workspace_a",
        provider: "openai_compatible",
        mode: "real",
        status: "configured",
        settings: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "[redacted]",
          chatModel: "gpt-5.4"
        },
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z"
      }]
    };

    expect(getAiProviderForm(settings).chatModel).toBe("gpt-5.4");
  });
```

- [ ] **Step 2: Prove the tests fail**

```bash
pnpm --filter @prymeira-talk/web test -- SettingsPage.test.tsx
```

Expected: default remains `gpt-4.1-mini`, and the mapper is not exported.

- [ ] **Step 3: Change only the empty default and mapper visibility**

Replace the empty form with:

```ts
const emptyAiProviderForm: AiProviderFormState = {
  enabled: false,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  chatModel: "gpt-5.6-luna",
  storedSecrets: {
    apiKey: false
  }
};
```

Change only the mapper declaration:

```ts
export function getAiProviderForm(settings: SettingsDto): AiProviderFormState {
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @prymeira-talk/web test -- SettingsPage.test.tsx
pnpm --filter @prymeira-talk/web typecheck
git add apps/web/src/features/settings/SettingsPage.tsx apps/web/src/features/settings/SettingsPage.test.tsx
git commit -m "feat: default AI provider setup to GPT-5.6 Luna"
```

Expected: tests and typecheck pass; persisted `gpt-5.4` still wins over the empty default.

## Task 4: Run Full Regression and Build Verification

**Files:** No planned source edits. Return failures to the owning task; do not bundle unrelated cleanup.

- [ ] **Step 1: Run all tests, type checks, and builds**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: every command exits 0 with no failed suites or TypeScript errors, and Vite produces the production web bundle.

- [ ] **Step 2: Build both production Docker images**

```bash
docker build --platform linux/amd64 -f apps/api/Dockerfile -t prymeira-talk-api:luna-verification .
docker build --platform linux/amd64 -f apps/web/Dockerfile -t prymeira-talk-web:luna-verification .
```

Expected: both production Dockerfiles build successfully.

- [ ] **Step 3: Confirm the release is isolated**

```bash
git status --short
git diff --stat origin/codex/prymeira-talk-foundation...HEAD
git log --oneline origin/codex/prymeira-talk-foundation..HEAD
```

Expected: status is empty; the diff contains only the four planned source/test files; the log contains exactly the three Luna commits from Tasks 1-3.

## Task 5: Publish the Verified Images

**Files:** No source files change.

- [ ] **Step 1: Push the isolated feature branch**

```bash
git push -u origin codex/gpt-5p6-luna-provider
```

Expected: the remote feature branch is created.

- [ ] **Step 2: Verify a safe fast-forward and advance the monitored branch**

```bash
git fetch origin
git merge-base --is-ancestor origin/codex/prymeira-talk-foundation HEAD
git diff --stat origin/codex/prymeira-talk-foundation...HEAD
git push origin HEAD:codex/prymeira-talk-foundation
```

Expected: the ancestry command exits 0, the diff remains restricted to four files, and the final push reports a fast-forward. Stop before pushing if either verification is false.

- [ ] **Step 3: Watch the image workflow**

```bash
gh run list --workflow "Publish Docker images" --branch codex/prymeira-talk-foundation --limit 1 --json databaseId,status,conclusion,headSha
gh run list --workflow "Publish Docker images" --branch codex/prymeira-talk-foundation --limit 1 --json databaseId --jq '.[0].databaseId' | xargs gh run watch --exit-status
```

Expected: API and web jobs succeed and publish `latest` plus immutable commit-SHA tags to GHCR.

## Task 6: Redeploy and Validate Production

**Files:** No repository files change.

- [ ] **Step 1: Record rollback references and redeploy**

In Portainer, open **Stacks → prymeira_talk**. Record the current immutable API and web image references. Use the stack update/redeploy action that pulls the newest images, leave every environment value unchanged, and wait for API and web services to become healthy.

Expected: API and web run the new SHA; PostgreSQL is untouched; previous image references are available for rollback.

- [ ] **Step 2: Verify health**

```bash
curl --fail --silent --show-error https://talk.prymeiradigital.com.br/api/health
```

Expected:

```json
{"ok":true,"product":"talk"}
```

- [ ] **Step 3: Prove GPT-5.4 still works before switching**

While the persisted model is still `gpt-5.4`, send `Oi` in the Villefer simulator.

Expected: one valid agent reply with no HTTP error.

- [ ] **Step 4: Change the workspace-wide model**

In **Ajustes → Provider de IA**, change only **Modelo de chat** from `gpt-5.4` to `gpt-5.6-luna` and save. Leave Base URL and the stored API key unchanged.

Expected: settings confirm success. Every agent now resolves Luna through the single workspace provider configuration.

- [ ] **Step 5: Run the Luna simulator smoke matrix**

Use fresh simulator turns:

```text
Oi
Quais produtos a Villefer vende?
Qual é o preço exato de um produto que não está na sua base?
Quero falar com uma pessoa do comercial.
```

Expected:

- natural greeting in the correct company context;
- knowledge-bound answer uses available knowledge;
- missing exact price is not invented;
- human request follows the existing handoff behavior;
- no HTTP 400 occurs;
- any provider failure contains only safe status/type/code/param metadata.

- [ ] **Step 6: Verify a real WhatsApp round trip**

From the already authorized WhatsApp Web self-chat for the Villefer test number, send a fresh greeting different from the simulator message.

Expected: Talk receives one inbound message, the Villefer agent run completes with Luna, and WhatsApp receives exactly one automated reply.

- [ ] **Step 7: Apply the explicit rollback rule if needed**

If Luna fails while GPT-5.4 remains healthy, restore the workspace model to `gpt-5.4`. If the release also regresses GPT-5.4, redeploy the immutable API and web images recorded in Step 1.

Expected: the last known-good combination is restored without replacing or exposing the API key.

## Completion Evidence

The handoff must include:

- focused provider and frontend test pass counts;
- full `pnpm test`, `pnpm typecheck`, and `pnpm build` outcomes;
- both Docker build outcomes;
- the three implementation commit IDs;
- GitHub Actions run URL and conclusion;
- deployed API and web image SHAs;
- `/api/health` response;
- GPT-5.4 simulator result before switching;
- all four Luna simulator results;
- WhatsApp inbound message ID, agent-run status, and outbound delivery result;
- any rollback action and the final active model.
