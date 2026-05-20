import fp from "fastify-plugin";
import { requireProductAccess } from "@prymeira/auth";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

const workspaceAccessSchema = z.object({
  allowed: z.literal(true),
  product_key: z.string(),
  status: z.string(),
  plan: z.string().optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
  reason: z.string(),
  workspace_id: z.string().min(1).optional(),
  workspace_role: z.string().optional(),
  product_role: z.string().optional()
});

declare module "fastify" {
  interface FastifyRequest {
    talk: {
      workspaceId: string;
      role: "owner" | "manager" | "agent";
      clerkToken: string;
    };
  }
}

function readBearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }

  const query = request.query as { token?: string } | undefined;
  return query?.token ?? null;
}

function normalizeRole(role: string | undefined): "owner" | "manager" | "agent" {
  if (role === "owner" || role === "admin") return "owner";
  if (role === "manager") return "manager";
  return "agent";
}

async function resolveWorkspaceAccess(input: {
  accountApiUrl: string;
  productKey: string;
  clerkToken: string;
}) {
  const response = await fetch(`${input.accountApiUrl.replace(/\/$/, "")}/me/products`, {
    headers: {
      Authorization: `Bearer ${input.clerkToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to resolve workspace access: ${response.status}`);
  }

  const data = z
    .object({
      workspace: z.object({
        id: z.string().min(1),
        role: z.string().optional()
      }),
      products: z.array(
        z.object({
          product_key: z.string(),
          allowed: z.boolean(),
          workspace_id: z.string().min(1),
          workspace_role: z.string().optional(),
          product_role: z.string().optional()
        })
      )
    })
    .parse(await response.json());

  const product = data.products.find((item) => item.product_key === input.productKey);
  if (!product?.allowed) {
    throw new Error("Product access denied.");
  }

  return {
    workspaceId: product.workspace_id,
    role: normalizeRole(product.product_role ?? product.workspace_role ?? data.workspace.role)
  };
}

export const authContextPlugin = fp(
  async (app, options: { accountApiUrl: string; productKey: string }) => {
    app.decorateRequest("talk");

    app.addHook("preHandler", async (request) => {
      if (request.url === "/health" || request.url.startsWith("/webhooks/evolution")) {
        return;
      }

      const clerkToken = readBearerToken(request);
      const access = await requireProductAccess(options.productKey, {
        accountApiUrl: options.accountApiUrl,
        clerkToken
      });
      workspaceAccessSchema.parse(access);
      const workspaceAccess = await resolveWorkspaceAccess({
        accountApiUrl: options.accountApiUrl,
        productKey: options.productKey,
        clerkToken: clerkToken!
      });

      request.talk = {
        workspaceId: workspaceAccess.workspaceId,
        role: workspaceAccess.role,
        clerkToken: clerkToken!
      };
    });
  }
);
