import type { ContactBoardChannelSummaryDto, ContactBoardStageDto } from "@prymeira-talk/shared";

export function formatBoardChannelLabel(channel: ContactBoardChannelSummaryDto) {
  return channel.displayName ?? channel.phoneNumber ?? channel.provider;
}

export function stageTagIdsByStage(
  stages: Array<Pick<ContactBoardStageDto, "id" | "tagTriggers">>
) {
  return Object.fromEntries(
    stages.map((stage) => [stage.id, stage.tagTriggers.map((tag) => tag.id)])
  );
}

export function findDuplicateStageTag(
  tagIdsByStage: Record<string, string[]>,
  currentStageId: string,
  nextTagIds: string[]
) {
  const nextTagSet = new Set(nextTagIds);

  for (const [stageId, tagIds] of Object.entries(tagIdsByStage)) {
    if (stageId === currentStageId) continue;
    const duplicatedTagId = tagIds.find((tagId) => nextTagSet.has(tagId));

    if (duplicatedTagId) {
      return { tagId: duplicatedTagId, stageId };
    }
  }

  return null;
}
