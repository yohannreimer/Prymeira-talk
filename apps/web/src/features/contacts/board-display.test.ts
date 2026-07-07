import { describe, expect, it } from "vitest";
import {
  findDuplicateStageTag,
  formatBoardChannelLabel,
  stageTagIdsByStage
} from "./board-display";

describe("board display helpers", () => {
  it("formats channel labels for board chips", () => {
    expect(
      formatBoardChannelLabel({
        id: "channel_1",
        displayName: "WhatsApp Vendas",
        provider: "evolution",
        phoneNumber: "+5511999990000"
      })
    ).toBe("WhatsApp Vendas");
  });

  it("detects duplicate stage tags inside one board", () => {
    const duplicate = findDuplicateStageTag(
      {
        stage_a: ["tag_hot"],
        stage_b: ["tag_warm"]
      },
      "stage_b",
      ["tag_hot", "tag_warm"]
    );

    expect(duplicate).toEqual({ tagId: "tag_hot", stageId: "stage_a" });
  });

  it("indexes tag ids by stage", () => {
    expect(
      stageTagIdsByStage([
        {
          id: "stage_a",
          tagTriggers: [{ id: "tag_hot", name: "Lead quente", color: "#24564a", isActive: true }]
        },
        { id: "stage_b", tagTriggers: [] }
      ])
    ).toEqual({ stage_a: ["tag_hot"], stage_b: [] });
  });
});
