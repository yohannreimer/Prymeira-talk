import { describe, expect, it } from "vitest";
import { canPerform } from "./roles.js";

describe("role permissions", () => {
  it("allows managers to assign conversations", () => {
    expect(canPerform("manager", "conversation.assign")).toBe(true);
  });

  it("blocks agents from managing automations", () => {
    expect(canPerform("agent", "automation.manage")).toBe(false);
  });

  it("allows owners to manage workspace settings", () => {
    expect(canPerform("owner", "workspace.manage")).toBe(true);
  });

  it.each(["owner", "manager", "agent"] as const)("allows %s to manage leads", (role) => {
    expect(canPerform(role, "lead.manage")).toBe(true);
  });

  it("keeps campaign management unavailable to agents", () => {
    expect(canPerform("agent", "campaign.manage")).toBe(false);
  });
});
