import { describe, expect, it } from "vitest";
import { resolveMetaRuntime } from "./meta-runtime.js";

describe("resolveMetaRuntime", () => {
  it("returns inactive runtime when integration is disabled", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: async () => ({
          mode: "real",
          status: "configured",
          settings: { enabled: false }
        })
      }
    };

    await expect(
      resolveMetaRuntime(prisma, { workspaceId: "local_workspace" })
    ).resolves.toMatchObject({
      active: false,
      client: null
    });
  });

  it("returns active runtime when required Meta settings exist", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: async () => ({
          mode: "real",
          status: "configured",
          settings: {
            enabled: true,
            wabaId: "111",
            phoneNumberId: "222",
            accessToken: "token"
          }
        })
      }
    };

    const runtime = await resolveMetaRuntime(prisma, {
      workspaceId: "local_workspace",
      fetch: async () => new Response("{}")
    });

    expect(runtime).toMatchObject({
      active: true,
      wabaId: "111",
      phoneNumberId: "222"
    });
    expect(runtime.client).not.toBeNull();
  });
});
