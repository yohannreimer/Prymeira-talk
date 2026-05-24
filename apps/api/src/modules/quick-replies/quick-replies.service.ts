type DateLike = Date | string;

interface QuickReplyRecord {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  category: string | null;
  createdAt: DateLike;
  updatedAt: DateLike;
}

export interface QuickReplyDto {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrismaLike {
  quickReply: {
    findMany(args: {
      where: { workspaceId: string };
      orderBy: Array<{ updatedAt: "desc" }>;
    }): Promise<QuickReplyRecord[]>;
    create(args: {
      data: {
        workspaceId: string;
        title: string;
        body: string;
        category?: string | null;
      };
    }): Promise<QuickReplyRecord>;
    update(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      data: Partial<{ title: string; body: string; category: string | null }>;
    }): Promise<QuickReplyRecord>;
    delete(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
    }): Promise<QuickReplyRecord>;
  };
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toDto(record: QuickReplyRecord): QuickReplyDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    body: record.body,
    category: record.category ?? null,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

export function createQuickRepliesService(prisma: PrismaLike) {
  return {
    async list(input: { workspaceId: string }) {
      const records = await prisma.quickReply.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ updatedAt: "desc" }]
      });
      return records.map(toDto);
    },

    async create(input: {
      workspaceId: string;
      title: string;
      body: string;
      category?: string | null;
    }) {
      const record = await prisma.quickReply.create({
        data: {
          workspaceId: input.workspaceId,
          title: input.title.trim(),
          body: input.body.trim(),
          category: input.category?.trim() || null
        }
      });
      return toDto(record);
    },

    async update(input: {
      workspaceId: string;
      id: string;
      data: Partial<{ title: string; body: string; category: string | null }>;
    }) {
      const data = Object.fromEntries(
        Object.entries(input.data).map(([key, value]) => [
          key,
          typeof value === "string"
            ? value.trim() || (key === "category" ? null : value.trim())
            : value
        ])
      );
      const record = await prisma.quickReply.update({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.id } },
        data
      });
      return toDto(record);
    },

    async delete(input: { workspaceId: string; id: string }) {
      await prisma.quickReply.delete({
        where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.id } }
      });
    }
  };
}
