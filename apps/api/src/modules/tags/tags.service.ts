import type { PrismaClient } from "@prisma/client";
import type { TagDto } from "@prymeira-talk/shared";

type DateLike = Date | string;

type TagRecord = {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  useGuide: string;
  isActive: boolean;
  createdAt: DateLike;
  updatedAt: DateLike;
  _count?: {
    allowedAgents?: number;
    conversations?: number;
  };
};

type TagFindManyArgs = Parameters<PrismaClient["tag"]["findMany"]>[0];
type TagCreateArgs = Parameters<PrismaClient["tag"]["create"]>[0];
type TagUpdateArgs = Parameters<PrismaClient["tag"]["update"]>[0];
type TagDeleteArgs = Parameters<PrismaClient["tag"]["delete"]>[0];

export interface TagsPrismaLike {
  tag: {
    findMany(args: TagFindManyArgs): Promise<TagRecord[]>;
    create(args: TagCreateArgs): Promise<TagRecord>;
    update(args: TagUpdateArgs): Promise<TagRecord>;
    delete(args: TagDeleteArgs): Promise<TagRecord>;
  };
}

export class TagsServiceError extends Error {
  constructor(
    public readonly code: "TAG_INVALID_INPUT",
    message: string
  ) {
    super(message);
    this.name = "TagsServiceError";
  }
}

const defaultTagColor = "#24564a";
const hexColorPattern = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const tagCountInclude = {
  _count: {
    select: {
      allowedAgents: true,
      conversations: true
    }
  }
} as const;

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function requiredTrim(value: string | undefined, field: "name" | "useGuide") {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    throw new TagsServiceError(
      "TAG_INVALID_INPUT",
      field === "name" ? "Tag name is required." : "Tag use guide is required."
    );
  }

  return trimmed;
}

function normalizeColor(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return hexColorPattern.test(trimmed) ? trimmed : defaultTagColor;
}

function toTagDto(record: TagRecord): TagDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    color: record.color,
    useGuide: record.useGuide,
    isActive: record.isActive,
    agentCount: record._count?.allowedAgents ?? 0,
    conversationCount: record._count?.conversations ?? 0,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

export function createTagsService(prisma: TagsPrismaLike) {
  return {
    async listTags(input: { workspaceId: string }): Promise<TagDto[]> {
      const tags = await prisma.tag.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
        include: tagCountInclude
      });

      return tags.map(toTagDto);
    },

    async createTag(input: {
      workspaceId: string;
      name: string;
      color: string;
      useGuide: string;
    }): Promise<TagDto> {
      const tag = await prisma.tag.create({
        data: {
          workspaceId: input.workspaceId,
          name: requiredTrim(input.name, "name"),
          color: normalizeColor(input.color),
          useGuide: requiredTrim(input.useGuide, "useGuide"),
          isActive: true
        },
        include: tagCountInclude
      });

      return toTagDto(tag);
    },

    async updateTag(input: {
      workspaceId: string;
      tagId: string;
      data: Partial<{
        name: string;
        color: string;
        useGuide: string;
        isActive: boolean;
      }>;
    }): Promise<TagDto> {
      const tag = await prisma.tag.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.tagId
          }
        },
        data: {
          ...(input.data.name !== undefined
            ? { name: requiredTrim(input.data.name, "name") }
            : {}),
          ...(input.data.color !== undefined
            ? { color: normalizeColor(input.data.color) }
            : {}),
          ...(input.data.useGuide !== undefined
            ? { useGuide: requiredTrim(input.data.useGuide, "useGuide") }
            : {}),
          ...(input.data.isActive !== undefined ? { isActive: input.data.isActive } : {})
        },
        include: tagCountInclude
      });

      return toTagDto(tag);
    },

    async deleteTag(input: {
      workspaceId: string;
      tagId: string;
    }): Promise<TagDto> {
      const tag = await prisma.tag.delete({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.tagId
          }
        },
        include: tagCountInclude
      });

      return toTagDto(tag);
    }
  };
}
