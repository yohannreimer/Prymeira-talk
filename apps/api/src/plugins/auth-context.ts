import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

const workspaceAccessSchema = z.object({
  allowed: z.boolean(),
  product_key: z.string(),
  status: z.string(),
  plan: z.string().optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
  reason: z.string(),
  workspace_id: z.string().optional(),
  workspace_role: z.string().optional(),
  product_role: z.string().optional()
});

const realtimeAuthProtocol = "prymeira-talk-auth";

declare module "fastify" {
  interface FastifyRequest {
    talk: {
      workspaceId: string;
      role: "owner" | "manager" | "agent";
      clerkToken?: string;
      clerkUserId?: string | null;
    };
  }
}

type RequireProductAccess = (
  productKey: string,
  options: { accountApiUrl: string; clerkToken: string }
) => Promise<unknown>;
type Fetch = typeof fetch;

export interface AuthContextPluginOptions {
  accountApiUrl: string;
  productKey: string;
  localAuthBypass?: {
    workspaceId: string;
    role: "owner" | "manager" | "agent";
  };
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
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const statusCode = "statusCode" in error ? Number(error.statusCode) : "status" in error ? Number(error.status) : null;
  return Number.isFinite(statusCode) ? statusCode : null;
}

function readPathname(request: FastifyRequest) {
  return new URL(request.url, "http://localhost").pathname;
}

function isPublicPath(pathname: string) {
  return (
    pathname === "/health" ||
    pathname === "/webhooks/evolution" ||
    pathname.startsWith("/webhooks/evolution/") ||
    pathname.startsWith("/uploads/automations/") ||
    pathname.includes("/uploads/automations/")
  );
}

function normalizeHeaderValue(header: string | string[] | undefined) {
  if (Array.isArray(header)) {
    return header.join(",");
  }

  return header;
}

function readRealtimeProtocolToken(header: string | string[] | undefined) {
  const value = normalizeHeaderValue(header);
  if (!value) {
    return null;
  }

  const protocols = value
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  const authProtocolIndex = protocols.indexOf(realtimeAuthProtocol);
  const token = authProtocolIndex >= 0 ? protocols[authProtocolIndex + 1] : null;

  return token && token.length > 0 ? token : null;
}

function readBearerToken(request: FastifyRequest, pathname: string) {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }

  if (pathname !== "/realtime") {
    return null;
  }

  return readRealtimeProtocolToken(request.headers["sec-websocket-protocol"]);
}

function normalizeRole(role: string | undefined): "owner" | "manager" | "agent" {
  if (role === "owner" || role === "admin") return "owner";
  if (role === "manager") return "manager";
  return "agent";
}

function readClerkUserIdFromToken(clerkToken: string) {
  const [, payload] = clerkToken.split(".");
  if (!payload) return null;

  try {
    const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(Buffer.from(normalizedPayload, "base64").toString("utf8")) as {
      sub?: unknown;
    };

    return typeof decoded.sub === "string" ? decoded.sub : null;
  } catch {
    return null;
  }
}

async function defaultRequireProductAccess(
  productKey: string,
  options: { accountApiUrl: string; clerkToken: string },
  fetchAccess: Fetch = fetch
) {
  const response = await fetchAccess(
    `${options.accountApiUrl.replace(/\/$/, "")}/access-check?product_key=${encodeURIComponent(productKey)}`,
    {
      headers: {
        Authorization: `Bearer ${options.clerkToken}`
      }
    }
  ).catch(() => {
    throw authError(502, "Unable to validate product access.");
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw authError(401, "Missing or invalid bearer token.");
    }

    throw authError(502, "Unable to validate product access.");
  }

  return response.json().catch(() => {
    throw authError(502, "Invalid product access response.");
  });
}

export const authContextPlugin = fp(
  async (app, options: AuthContextPluginOptions) => {
    app.decorateRequest("talk");
    const fetchAccess = options.fetch ?? fetch;
    const requireAccess =
      options.requireProductAccess ??
      ((productKey: string, input: { accountApiUrl: string; clerkToken: string }) =>
        defaultRequireProductAccess(productKey, input, fetchAccess));

    app.addHook("onRequest", async (request) => {
      const pathname = readPathname(request);
      if (isPublicPath(pathname)) {
        return;
      }

      const clerkToken = readBearerToken(request, pathname);
      if (!clerkToken) {
        throw authError(401, "Missing bearer token.");
      }

      if (options.localAuthBypass) {
        request.talk = {
          workspaceId: options.localAuthBypass.workspaceId,
          role: options.localAuthBypass.role,
          clerkToken,
          clerkUserId: readClerkUserIdFromToken(clerkToken)
        };
        return;
      }

      const access = await requireAccess(options.productKey, {
        accountApiUrl: options.accountApiUrl,
        clerkToken
      }).catch((error: unknown) => {
        const statusCode = readErrorStatusCode(error);

        if (statusCode === null || statusCode >= 500) {
          throw authError(502, "Unable to validate product access.");
        }

        if (statusCode === 401) {
          throw authError(401, "Missing or invalid bearer token.");
        }

        throw authError(403, "Product access denied.");
      });
      const parsedAccess = await workspaceAccessSchema.parseAsync(access).catch(() => {
        throw authError(502, "Invalid product access response.");
      });
      if (!parsedAccess.allowed || parsedAccess.product_key !== options.productKey) {
        throw authError(403, "Product access denied.");
      }

      if (!parsedAccess.workspace_id) {
        throw authError(403, "Workspace access denied.");
      }

      request.talk = {
        workspaceId: parsedAccess.workspace_id,
        role: normalizeRole(parsedAccess.product_role ?? parsedAccess.workspace_role),
        clerkToken,
        clerkUserId: readClerkUserIdFromToken(clerkToken)
      };
    });
  }
);
