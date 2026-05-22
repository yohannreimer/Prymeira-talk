import type { AutomationRunDto } from "../../app/api";
import { describe, expect, it } from "vitest";
import { defaultAutomationEventKey, mergeAutomationRun } from "./AutomationsPage";

const baseRun: AutomationRunDto = {
  id: "run-1",
  workspaceId: "workspace-1",
  ruleId: "rule-1",
  eventKey: "message.received:manual-test:rule-1",
  status: "completed",
  input: { source: "manual_test" },
  result: { mode: "simulated" },
  createdAt: "2026-05-22T12:00:00.000Z",
  updatedAt: "2026-05-22T12:00:00.000Z"
};

describe("automation run helpers", () => {
  it("builds a stable default manual test event key", () => {
    expect(defaultAutomationEventKey("message.received", "rule-1")).toBe(
      "message.received:manual-test:rule-1"
    );
  });

  it("merges a run at the top without duplicating an existing run", () => {
    const updatedRun = {
      ...baseRun,
      status: "completed",
      updatedAt: "2026-05-22T12:05:00.000Z"
    };

    expect(mergeAutomationRun([baseRun], updatedRun)).toEqual([updatedRun]);
  });
});
