import { supervisionAccessSchema, type SupervisionGrant } from "@prymeira-talk/shared";
import { z } from "zod";

export type SupervisionContext = { kind: "viewer"; grants: SupervisionGrant[] } | { kind: "admin" };

export class SupervisionError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "SupervisionError";
  }
}

export async function validateSupervisionAccess(input: {
  accountApiUrl: string;
  token: string;
  admin: boolean;
  fetch: typeof fetch;
}): Promise<SupervisionContext> {
  const response = await input.fetch(
    `${input.accountApiUrl.replace(/\/$/, "")}${input.admin ? "/admin/session" : "/me/talk-supervision"}`,
    { headers: { Authorization: `Bearer ${input.token}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) }
  ).catch(() => { throw new SupervisionError(502, "Não foi possível validar a supervisão no Hub."); });
  if (!response.ok) {
    throw new SupervisionError(response.status === 401 ? 401 : response.status === 403 ? 403 : 502,
      "Não foi possível validar o acesso de supervisão.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (input.admin) {
    if (!z.object({ admin: z.literal(true) }).safeParse(body).success) {
      throw new SupervisionError(403, "Acesso administrativo necessário.");
    }
    return { kind: "admin" };
  }
  const parsed = supervisionAccessSchema.safeParse(body);
  if (!parsed.success) throw new SupervisionError(502, "Resposta de supervisão inválida do Hub.");
  if (!parsed.data.grants.length) throw new SupervisionError(403, "Nenhum vendedor autorizado para supervisão.");
  // Each source channel has exactly one seller label for this supervisor.
  const scopes = new Set<string>();
  const supervisorId = parsed.data.grants[0].supervisor_customer_id;
  for (const grant of parsed.data.grants) {
    const key = `${grant.workspace_id}:${grant.channel_id}`;
    if (scopes.has(key) || grant.supervisor_customer_id !== supervisorId) {
      throw new SupervisionError(502, "Vínculos de supervisão inconsistentes no Hub.");
    }
    scopes.add(key);
  }
  return { kind: "viewer", grants: parsed.data.grants };
}
