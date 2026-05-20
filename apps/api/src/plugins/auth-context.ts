import fp from "fastify-plugin";
import { requireProductAccess } from "@prymeira/auth";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

const workspaceAccessSchema = z.object({
  allowed: z.boolean(),
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
    };
  }
}

type RequireProductAccess = typeof requireProductAccess;
type Fetch = typeof fetch;

export interface AuthContextPluginOptions {
  accountApiUrl: string;
  productKey: string;
  requireProductAccess?: RequireProductAccess;
  fetch?: Fetch;
}

class AuthBoundaryError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AuthBoundaryError";
    this.statusCode = statusCode;
  }
}

function authError(statusCode: number, message: string) {
  return new AuthBoundaryError(statusCode, message);
}

function readErrorStatusCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return null;
  }

  const statusCode = Number(error.statusCode);
  return Number.isFinite(statusCode) ? statusCode : null;
}

function readPathname(request: FastifyRequest) {
  return new URL(request.url, "http://localhost").pathname;
}

function isPublicPath(pathname: string) {
  return pathname === "/health" || pathname === "/webhooks/evolution" || pathname.startsWith("/webhooks/evolution/");
}

function readBearerToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }

  // Browser WebSocket handshakes cannot send Authorization headers, so query
  // token support remains until websocket routes can scope this fallback.
  return new URL(request.url, "http://localhost").searchParams.get("token");
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
  fetch: Fetch;
}) {
  const response = await input
    .fetch(`${input.accountApiUrl.replace(/\/$/, "")}/me/products`, {
      headers: {
        Authorization: `Bearer ${input.clerkToken}`
      }
    })
    .catch(() => {
      throw authError(502, "Unable to resolve workspace access.");
    });

  if (!response.ok) {
    if (response.status >= 500) {
      throw authError(502, "Unable to resolve workspace access.");
    }

    throw authError(403, "Workspace access denied.");
  }

  const data = await z
    .object({
      workspace: z.object({
        id: z.string().min(1),
        role: z.string().optional()
      }),
      products: z.array(
        z.object({
          product_key: z.string(),
          allowed: z.boolean(),
          workspace_id: z.string().min(1).optional(),
          workspace_role: z.string().optional(),
          product_role: z.string().optional()
        })
      )
    })
    .parseAsync(
      await response.json().catch(() => {
        throw authError(502, "Invalid workspace access response.");
      })
    )
    .catch(() => {
      throw authError(502, "Invalid workspace access response.");
    });

  const product = data.products.find((item) => item.product_key === input.productKey);
  if (!product?.allowed) {
    throw authError(403, "Product access denied.");
  }

  if (!product.workspace_id) {
    throw authError(403, "Workspace access denied.");
  }

  return {
    workspaceId: product.workspace_id,
    role: normalizeRole(product.product_role ?? product.workspace_role ?? data.workspace.role)
  };
}

export const authContextPlugin = fp(
  async (app, options: AuthContextPluginOptions) => {
    app.decorateRequest("talk");
    const requireAccess = options.requireProductAccess ?? requireProductAccess;
    const fetchProducts = options.fetch ?? fetch;

    app.addHook("onRequest", async (request) => {
      const pathname = readPathname(request);
      if (isPublicPath(pathname)) {
        return;
      }

      const clerkToken = readBearerToken(request);
      if (!clerkToken) {
        throw authError(401, "Missing bearer token.");
      }

      const access = await requireAccess(options.productKey, {
        accountApiUrl: options.accountApiUrl,
        clerkToken
      }).catch((error: unknown) => {
        const statusCode = readErrorStatusCode(error);

        if (statusCode === null || statusCode >= 500) {
          throw authError(502, "Unable to validate product access.");
        }

        throw authError(403, "Product access denied.");
      });
      const parsedAccess = await workspaceAccessSchema.parseAsync(access).catch(() => {
        throw authError(502, "Invalid product access response.");
      });
      if (!parsedAccess.allowed || parsedAccess.product_key !== options.productKey) {
        throw authError(403, "Product access denied.");
      }

      const workspaceAccess = await resolveWorkspaceAccess({
        accountApiUrl: options.accountApiUrl,
        productKey: options.productKey,
        clerkToken,
        fetch: fetchProducts
      });

      request.talk = {
        workspaceId: workspaceAccess.workspaceId,
        role: workspaceAccess.role
      };
    });
  }
);
