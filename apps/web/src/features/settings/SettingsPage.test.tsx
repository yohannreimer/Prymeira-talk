import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

vi.mock("../../app/auth", () => ({
  useTalkAuth: () => ({
    getToken: vi.fn(async () => "test-token")
  })
}));

vi.mock("../../app/api", () => ({
  apiCreateTag: vi.fn(),
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
  it("renders the global AI tag controls", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain("Tags da IA");
    expect(html).toContain("Nome da tag");
    expect(html).toContain("Cor");
    expect(html).toContain("Quando usar");
    expect(html).toContain("Criar tag");
  });
});
