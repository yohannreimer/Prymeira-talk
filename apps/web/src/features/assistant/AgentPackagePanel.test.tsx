import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentPackagePanel, packageDownloadFileName } from "./AgentPackagePanel";

describe("AgentPackagePanel", () => {
  it("explains the reusable package workflow in plain language", () => {
    const html = renderToStaticMarkup(
      <AgentPackagePanel
        getToken={vi.fn(async () => "token")}
        selectedAgent={null}
        onImported={vi.fn()}
      />
    );

    expect(html).toContain("Modelo reutilizável");
    expect(html).toContain("Importar modelo");
    expect(html).toContain("Exportar agente");
    expect(html).toContain(".json");
    expect(html).toContain("Selecione um agente para exportar");
  });

  it("creates a stable JSON file name from an agent name", () => {
    expect(packageDownloadFileName("Agente Comercial — Açõ Brasil")).toBe(
      "agente-comercial-aco-brasil.agent-package.json"
    );
  });
});
