import { describe, expect, it, vi } from "vitest";
import { createMetaTemplatesService } from "./meta.templates.service.js";

describe("meta templates service", () => {
  it("syncs only approved Meta templates into the local cache", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) =>
      Promise.resolve({
        id: "template_1",
        ...create,
        createdAt: new Date("2026-06-02T12:00:00.000Z"),
        updatedAt: new Date("2026-06-02T12:00:00.000Z")
      })
    );
    const service = createMetaTemplatesService({
      metaMessageTemplate: { upsert },
      auditLog: { create: vi.fn().mockResolvedValue({}) }
    });

    const result = await service.syncTemplates({
      workspaceId: "local_workspace",
      wabaId: "111",
      client: {
        listMessageTemplates: vi.fn().mockResolvedValue({
          templates: [
            {
              id: "tpl_1",
              name: "approved",
              language: "pt_BR",
              category: "UTILITY",
              status: "APPROVED",
              components: []
            },
            {
              id: "tpl_2",
              name: "rejected",
              language: "pt_BR",
              category: "MARKETING",
              status: "REJECTED",
              components: []
            }
          ],
          raw: []
        })
      }
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(result.synced).toBe(1);
  });
});
