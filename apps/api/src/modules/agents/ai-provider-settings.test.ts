import { describe, expect, it, vi } from "vitest";
import { resolveOpenAiCompatibleSettings } from "./ai-provider-settings.js";

describe("resolveOpenAiCompatibleSettings", () => {
  it("returns not_configured when config is missing", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue(null)
      }
    };

    const result = await resolveOpenAiCompatibleSettings(prisma, {
      workspaceId: "workspace_a"
    });

    expect(prisma.integrationConfig.findUnique).toHaveBeenCalledWith({
      where: {
        workspaceId_provider: {
          workspaceId: "workspace_a",
          provider: "openai_compatible"
        }
      }
    });
    expect(result).toEqual({ active: false, reason: "not_configured" });
  });

  it("returns active settings when real mode has required settings", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "real",
          settings: {
            baseUrl: " https://api.openai.example/v1/// ",
            apiKey: " provider-secret ",
            chatModel: " gpt-4.1-mini "
          }
        })
      }
    };

    const result = await resolveOpenAiCompatibleSettings(prisma, {
      workspaceId: "workspace_a"
    });

    expect(result).toEqual({
      active: true,
      baseUrl: "https://api.openai.example/v1",
      apiKey: "provider-secret",
      chatModel: "gpt-4.1-mini"
    });
  });

  it("returns simulated when mode is simulated", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "simulated",
          settings: {
            baseUrl: "https://api.openai.example/v1",
            apiKey: "provider-secret",
            chatModel: "gpt-4.1-mini"
          }
        })
      }
    };

    const result = await resolveOpenAiCompatibleSettings(prisma, {
      workspaceId: "workspace_a"
    });

    expect(result).toEqual({ active: false, reason: "simulated" });
  });

  it("returns incomplete when a required setting is missing", async () => {
    const prisma = {
      integrationConfig: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "real",
          settings: {
            baseUrl: "https://api.openai.example/v1",
            apiKey: "provider-secret"
          }
        })
      }
    };

    const result = await resolveOpenAiCompatibleSettings(prisma, {
      workspaceId: "workspace_a"
    });

    expect(result).toEqual({ active: false, reason: "incomplete" });
  });
});
