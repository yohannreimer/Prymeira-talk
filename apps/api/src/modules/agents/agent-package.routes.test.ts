import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  agentPackageRoutes,
  type AgentPackageRoutesService
} from "./agent-package.routes.js";
import { AgentPackageServiceError } from "./agent-package.service.js";

const agentId = "00000000-0000-4000-8000-000000000101";
const packageFixture = {
  schemaVersion: 1,
  kind: "prymeira.agent-package"
};

async function buildApp(input: {
  role?: "owner" | "manager" | "agent";
  service?: Partial<AgentPackageRoutesService>;
} = {}) {
  const app = Fastify({ logger: false });
  const service = {
    validatePackage: vi.fn().mockReturnValue(packageFixture),
    importPackage: vi.fn().mockResolvedValue({
      agent: { id: agentId, name: "Agente de Henry" },
      knowledgeCount: 4
    }),
    exportPackage: vi.fn().mockResolvedValue(packageFixture),
    ...input.service
  } as unknown as AgentPackageRoutesService;

  app.addHook("preHandler", async (request) => {
    request.talk = {
      workspaceId: "workspace_a",
      role: input.role ?? "owner"
    };
  });
  await app.register(agentPackageRoutes, { service });

  return { app, service };
}

describe("agentPackageRoutes", () => {
  it("validates a package without importing it", async () => {
    const { app, service } = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/agent-packages/validate",
      payload: { package: packageFixture }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: true, package: packageFixture });
    expect(service.validatePackage).toHaveBeenCalledWith(packageFixture);
    expect(service.importPackage).not.toHaveBeenCalled();
    await app.close();
  });

  it("imports a package into the authenticated workspace", async () => {
    const { app, service } = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/agent-packages/import",
      payload: {
        package: packageFixture,
        variableValues: { seller_name: "Henry" }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(service.importPackage).toHaveBeenCalledWith({
      workspaceId: "workspace_a",
      package: packageFixture,
      variableValues: { seller_name: "Henry" }
    });
    await app.close();
  });

  it("exports only from the authenticated workspace", async () => {
    const { app, service } = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: `/agents/${agentId}/package`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(packageFixture);
    expect(service.exportPackage).toHaveBeenCalledWith({
      workspaceId: "workspace_a",
      agentId
    });
    await app.close();
  });

  it("requires agent management permission", async () => {
    const { app, service } = await buildApp({ role: "agent" });

    const response = await app.inject({
      method: "POST",
      url: "/agent-packages/import",
      payload: { package: packageFixture, variableValues: {} }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "AGENT_PACKAGE_MANAGE_FORBIDDEN" });
    expect(service.importPackage).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps package and not-found errors to client responses", async () => {
    const invalid = await buildApp({
      service: {
        validatePackage: vi.fn(() => {
          throw new AgentPackageServiceError("PACKAGE_INVALID", "Invalid agent package.");
        })
      }
    });
    const invalidResponse = await invalid.app.inject({
      method: "POST",
      url: "/agent-packages/validate",
      payload: { package: {} }
    });
    expect(invalidResponse.statusCode).toBe(400);
    await invalid.app.close();

    const missing = await buildApp({
      service: {
        exportPackage: vi.fn().mockRejectedValue(
          new AgentPackageServiceError("AGENT_NOT_FOUND", "Agent not found.")
        )
      }
    });
    const missingResponse = await missing.app.inject({
      method: "GET",
      url: `/agents/${agentId}/package`
    });
    expect(missingResponse.statusCode).toBe(404);
    await missing.app.close();
  });
});
