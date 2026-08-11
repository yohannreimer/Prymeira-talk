import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsDto } from "../../app/api";
import { getAiProviderForm, SettingsPage } from "./SettingsPage";

vi.mock("../../app/auth", () => ({
  useTalkAuth: () => ({
    getToken: vi.fn(async () => "test-token")
  })
}));

vi.mock("../../app/api", () => ({
  apiCreateTag: vi.fn(),
  apiDeleteTag: vi.fn(),
  apiGetAuditLog: vi.fn(async () => []),
  apiGetSettings: vi.fn(async () => ({
    workspace: {
      workspaceId: "workspace_a",
      name: "Workspace de teste",
      plan: "Free"
    },
    integrations: []
  })),
  apiGetTags: vi.fn(async () => []),
  apiSyncMetaTemplates: vi.fn(),
  apiUpdateSettings: vi.fn(),
  apiUpdateTag: vi.fn()
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("SettingsPage", () => {
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

  it("renders the global AI tag controls", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain("Tags da IA");
    expect(html).toContain("Nome da tag");
    expect(html).toContain("Cor");
    expect(html).toContain("Quando usar");
    expect(html).toContain("Criar tag");
  });
});
