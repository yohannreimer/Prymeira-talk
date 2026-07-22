import { describe, expect, it, vi } from "vitest";
import { runDemoControlAction } from "./DemoControls";

const leadResult = {
  workspaceId: "demo_workspace",
  conversationId: "50000000-0000-4000-8000-000000000010",
  contactId: "60000000-0000-4000-8000-000000000010",
  created: true
};

describe("runDemoControlAction", () => {
  it("simulates a lead without asking for confirmation", async () => {
    const onSimulateLead = vi.fn().mockResolvedValue(leadResult);
    const confirmReset = vi.fn();

    await expect(
      runDemoControlAction({
        kind: "simulate",
        onSimulateLead,
        onReset: vi.fn(),
        confirmReset
      })
    ).resolves.toEqual({
      conversationId: leadResult.conversationId,
      notice: "Lead qualificado pela IA e pronto para atendimento."
    });
    expect(confirmReset).not.toHaveBeenCalled();
  });

  it("does not reset when confirmation is declined", async () => {
    const onReset = vi.fn();

    await expect(
      runDemoControlAction({
        kind: "reset",
        onSimulateLead: vi.fn(),
        onReset,
        confirmReset: () => false
      })
    ).resolves.toBeNull();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("returns the baseline notice after a confirmed reset", async () => {
    const onReset = vi.fn().mockResolvedValue({
      workspaceId: "demo_workspace",
      users: 5,
      conversations: 10,
      contacts: 10,
      agents: 1
    });

    await expect(
      runDemoControlAction({
        kind: "reset",
        onSimulateLead: vi.fn(),
        onReset,
        confirmReset: () => true
      })
    ).resolves.toEqual({
      conversationId: null,
      notice: "Demonstração restaurada: 5 vendedores e 10 conversas."
    });
  });

  it("confirms both products after an integrated reset", async () => {
    const onReset = vi.fn().mockResolvedValue({
      workspaceId: "demo_workspace",
      users: 5,
      conversations: 10,
      contacts: 10,
      agents: 1,
      vincula: {
        ok: true,
        workspaceId: "70000000-0000-4000-8000-000000000001",
        sales: 5,
        companies: 9,
        contacts: 9,
        deals: 6,
        notes: 6
      }
    });

    await expect(
      runDemoControlAction({
        kind: "reset",
        onSimulateLead: vi.fn(),
        onReset,
        confirmReset: () => true
      })
    ).resolves.toEqual({
      conversationId: null,
      notice: "Demonstração restaurada: Talk e Vincula prontos, com 5 vendedores e 10 conversas."
    });
  });
});
