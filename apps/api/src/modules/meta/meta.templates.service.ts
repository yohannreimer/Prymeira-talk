import type { Prisma, PrismaClient } from "@prisma/client";
import type { MetaClient } from "./meta.client.js";

type MetaMessageTemplateUpsertArgs = Parameters<PrismaClient["metaMessageTemplate"]["upsert"]>[0];
type MetaMessageTemplateUpdateManyArgs = Parameters<
  PrismaClient["metaMessageTemplate"]["updateMany"]
>[0];
type AuditLogCreateArgs = Parameters<PrismaClient["auditLog"]["create"]>[0];

interface MetaTemplatesPrismaLike {
  metaMessageTemplate: {
    updateMany(args: MetaMessageTemplateUpdateManyArgs): Promise<unknown>;
    upsert(args: MetaMessageTemplateUpsertArgs): Promise<unknown>;
  };
  auditLog: {
    create(args: AuditLogCreateArgs): Promise<unknown>;
  };
}

interface SyncTemplatesInput {
  workspaceId: string;
  wabaId: string;
  client: Pick<MetaClient, "listMessageTemplates">;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

export function createMetaTemplatesService(prisma: MetaTemplatesPrismaLike) {
  return {
    async syncTemplates(input: SyncTemplatesInput): Promise<{ synced: number }> {
      const result = await input.client.listMessageTemplates({ wabaId: input.wabaId });
      const approved = result.templates.filter((template) => template.status === "APPROVED");
      const syncedAt = new Date();

      await prisma.metaMessageTemplate.updateMany({
        where: {
          workspaceId: input.workspaceId,
          wabaId: input.wabaId
        },
        data: {
          status: "STALE",
          syncedAt
        }
      });

      await Promise.all(
        approved.map((template) =>
          prisma.metaMessageTemplate.upsert({
            where: {
              workspaceId_wabaId_name_language: {
                workspaceId: input.workspaceId,
                wabaId: input.wabaId,
                name: template.name,
                language: template.language
              }
            },
            create: {
              workspaceId: input.workspaceId,
              wabaId: input.wabaId,
              templateId: template.id,
              name: template.name,
              language: template.language,
              category: template.category,
              status: template.status,
              components: toInputJson(template.components),
              syncedAt
            },
            update: {
              templateId: template.id,
              category: template.category,
              status: template.status,
              components: toInputJson(template.components),
              syncedAt
            }
          })
        )
      );

      await prisma.auditLog.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: null,
          action: "meta.templates_synced",
          targetType: "integration_config",
          targetId: "meta_cloud",
          metadata: {
            wabaId: input.wabaId,
            synced: approved.length
          }
        }
      });

      return { synced: approved.length };
    }
  };
}
