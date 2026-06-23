import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsPage } from "./AgentsPage";

vi.mock("../../app/auth", () => ({
  useTalkAuth: () => ({
    getToken: vi.fn(async () => "test-token")
  })
}));

vi.mock("../../app/api", () => ({
  apiCreateAgent: vi.fn(),
  apiCreateAgentKnowledge: vi.fn(),
  apiGetAgentKnowledge: vi.fn(),
  apiGetAgents: vi.fn(async () => []),
  apiUpdateAgent: vi.fn()
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentsPage", () => {
  it("renders the agents management controls", () => {
    const html = renderToStaticMarkup(<AgentsPage />);

    expect(html).toContain("Agentes");
    expect(html).toContain("Novo agente");
    expect(html).toContain("Prompt do sistema");
    expect(html).toContain("Conhecimento");
    expect(html).toContain("FAQ");
    expect(html).toContain("Texto");
  });
});
