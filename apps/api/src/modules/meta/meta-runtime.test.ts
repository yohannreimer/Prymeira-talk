import { describe, expect, it, vi } from "vitest";
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
      client: null,
      appSecret: null
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
      phoneNumberId: "222",
      appSecret: null
    });
    expect(runtime.client).not.toBeNull();
  });

  it("trims whitespace settings without exposing the access token", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: async () => ({
          mode: "real",
          status: "configured",
          settings: {
            enabled: true,
            wabaId: " 111 ",
            phoneNumberId: " 222 ",
            accessToken: " token ",
            webhookVerifyToken: " verify-token ",
            appSecret: " app-secret "
          }
        })
      }
    };
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));

    const runtime = await resolveMetaRuntime(prisma, {
      workspaceId: "local_workspace",
      graphApiBaseUrl: "https://graph.example.test/v23.0",
      fetch
    });

    expect(runtime).toMatchObject({
      active: true,
      wabaId: "111",
      phoneNumberId: "222",
      webhookVerifyToken: "verify-token",
      appSecret: "app-secret"
    });
    expect(runtime).not.toHaveProperty("accessToken");

    if (runtime.active) {
      await runtime.client.testConnection({ phoneNumberId: runtime.phoneNumberId });
    }

    expect(fetch).toHaveBeenCalledWith(
      "https://graph.example.test/v23.0/222?fields=id,display_phone_number,verified_name",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token"
        })
      })
    );
  });
});
