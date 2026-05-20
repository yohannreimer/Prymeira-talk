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
});
