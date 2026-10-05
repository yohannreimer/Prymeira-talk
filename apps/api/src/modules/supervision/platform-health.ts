import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * The product owner's view of every customer's WhatsApp numbers: are both connections up and on the right phone,
 * are messages arriving, do sends get their ticks. Read only, every workspace, Hub admins only.
 */
export type HealthLevel = "ok" | "warning" | "critical";
export type ConnectionHealthView = {
  provider: "evolution" | "waha"; status: string; health: string; eligible: boolean; verifiedPhone: string | null;
  lastError: string | null; lastHealthyAt: string | null; lastCheckedAt: string | null; consecutiveFailures: number;
  lastEventAt: string | null; events1h: number;
};
export type ChannelHealthView = {
  workspaceId: string; workspaceName: string | null; channelId: string; name: string; phone: string | null; status: string;
  connections: ConnectionHealthView[];
  traffic: { lastInboundAt: string | null; lastOutboundAt: string | null; inbound1h: number; inbound24h: number; outbound24h: number };
  acks: { pending: number; sent: number; delivered: number; read: number; failed: number };
  history: { status: string | null; completedAt: string | null };
  level: HealthLevel; issues: Array<{ level: Exclude<HealthLevel, "ok">; text: string }>;
};

const HOUR = 3_600_000;
const iso = (value: Date | null | undefined) => value ? value.toISOString() : null;
const ago = (from: string | null, now: number) => {
  if (!from) return "nunca";
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  return minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} dias`;
};
const providerName = (provider: string) => provider === "waha" ? "WAHA" : "Evolution";
const ERRORS: Record<string, string> = {
  PHONE_MISMATCH: "foi lida com outro celular (número diferente do canal)",
  NUMBER_UNPROVEN: "ainda não confirmou o número",
  SESSION_FAILED: "a sessão falhou"
};

/** What is wrong with one number, worst first. Pure: the rules live here, the data comes from collectPlatformHealth. */
export function assessChannel(channel: Omit<ChannelHealthView, "level" | "issues">, now: number): Pick<ChannelHealthView, "level" | "issues"> {
  const issues: ChannelHealthView["issues"] = [];
  if (channel.status !== "connected") issues.push({ level: "critical", text: "Canal desconectado no Talk" });
  const evolution = channel.connections.find(connection => connection.provider === "evolution");
  const waha = channel.connections.find(connection => connection.provider === "waha");
  for (const [provider, connection] of [["evolution", evolution], ["waha", waha]] as const) {
    if (!connection) {
      issues.push({ level: provider === "evolution" ? "critical" : "warning", text: provider === "evolution" ? "Sem conexão Evolution" : "Só uma conexão: falta conectar o WAHA" });
      continue;
    }
    const name = providerName(provider);
    if (connection.status !== "connected") issues.push({ level: provider === "evolution" ? "critical" : "warning", text: `${name} desconectada${connection.lastError ? ` (${ERRORS[connection.lastError] ?? connection.lastError})` : ""}` });
    else if (connection.lastError && ERRORS[connection.lastError]) issues.push({ level: "critical", text: `${name} ${ERRORS[connection.lastError]}` });
    else if (connection.health === "degraded" || connection.health === "unhealthy") issues.push({ level: "warning", text: `${name} instável${connection.lastError ? `: ${connection.lastError}` : ""}` });
    else if (connection.status === "connected" && !connection.eligible) issues.push({ level: "warning", text: `${name} conectada mas fora de uso (não verificada)` });
  }
  if (evolution?.verifiedPhone && waha?.verifiedPhone && evolution.verifiedPhone !== waha.verifiedPhone) {
    issues.push({ level: "critical", text: `Evolution e WAHA estão em celulares diferentes (${evolution.verifiedPhone} × ${waha.verifiedPhone})` });
  }
  // A connection that is up but has sent no event for hours while the other one did is silently deaf.
  for (const connection of [evolution, waha]) {
    const other = connection === evolution ? waha : evolution;
    if (connection?.status === "connected" && other?.lastEventAt && Date.parse(other.lastEventAt) > now - 2 * HOUR
      && (!connection.lastEventAt || Date.parse(connection.lastEventAt) < now - 6 * HOUR)) {
      issues.push({ level: "warning", text: `${providerName(connection.provider)} não entrega eventos há ${ago(connection.lastEventAt, now)}` });
    }
  }
  if (channel.status === "connected" && (!channel.traffic.lastInboundAt || Date.parse(channel.traffic.lastInboundAt) < now - 24 * HOUR)) {
    issues.push({ level: "warning", text: `Nenhuma mensagem recebida há ${ago(channel.traffic.lastInboundAt, now)}` });
  }
  const acked = channel.acks.delivered + channel.acks.read, settled = acked + channel.acks.sent;
  if (settled >= 5 && acked / settled < 0.3) issues.push({ level: "warning", text: `Confirmações de entrega não chegam (${acked} de ${settled} envios com ✓✓ em 24 h)` });
  if (channel.acks.failed > 0) issues.push({ level: channel.acks.failed >= 5 ? "critical" : "warning", text: `${channel.acks.failed} ${channel.acks.failed === 1 ? "envio falhou" : "envios falharam"} em 24 h` });
  if (channel.history.status === "failed") issues.push({ level: "warning", text: "Importação do histórico falhou" });
  issues.sort((a, b) => (a.level === "critical" ? 0 : 1) - (b.level === "critical" ? 0 : 1));
  return { level: issues.some(issue => issue.level === "critical") ? "critical" : issues.length ? "warning" : "ok", issues };
}

type Count = bigint | number | null;
const n = (value: Count) => Number(value ?? 0);

export async function collectPlatformHealth(prisma: PrismaClient, now = new Date()): Promise<{ generatedAt: string; channels: ChannelHealthView[] }> {
  const day = new Date(now.getTime() - 24 * HOUR), hour = new Date(now.getTime() - HOUR);
  const channels = await prisma.channel.findMany({ where: { archivedAt: null, provider: "evolution" }, include: { connections: true }, orderBy: [{ workspaceId: "asc" }, { displayName: "asc" }] });
  const ids = channels.map(channel => channel.id);
  if (!ids.length) return { generatedAt: now.toISOString(), channels: [] };
  const [mirrors, traffic, recent, acks, events] = await Promise.all([
    prisma.workspaceMirror.findMany({ where: { workspaceId: { in: [...new Set(channels.map(channel => channel.workspaceId))] } } }),
    prisma.$queryRaw<Array<{ channel_id: string; last_in: Date | null; last_out: Date | null }>>(Prisma.sql`
      SELECT c.channel_id::text AS channel_id, max(m.created_at) FILTER (WHERE m.direction = 'inbound') AS last_in, max(m.created_at) FILTER (WHERE m.direction = 'outbound') AS last_out
      FROM messages m JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id
      WHERE c.channel_id = ANY(${ids}::uuid[]) AND m.type <> 'system' GROUP BY c.channel_id`),
    prisma.$queryRaw<Array<{ channel_id: string; in_1h: Count; in_24h: Count; out_24h: Count }>>(Prisma.sql`
      SELECT c.channel_id::text AS channel_id, count(*) FILTER (WHERE m.direction = 'inbound' AND m.created_at >= ${hour}) AS in_1h,
        count(*) FILTER (WHERE m.direction = 'inbound') AS in_24h, count(*) FILTER (WHERE m.direction = 'outbound') AS out_24h
      FROM messages m JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id
      WHERE c.channel_id = ANY(${ids}::uuid[]) AND m.created_at >= ${day} AND m.type <> 'system' GROUP BY c.channel_id`),
    prisma.$queryRaw<Array<{ channel_id: string; status: string; total: Count }>>(Prisma.sql`
      SELECT c.channel_id::text AS channel_id, m.status::text AS status, count(*) AS total
      FROM messages m JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id
      JOIN contacts ct ON ct.workspace_id = c.workspace_id AND ct.id = c.contact_id
      WHERE c.channel_id = ANY(${ids}::uuid[]) AND m.created_at >= ${day} AND m.direction = 'outbound' AND m.type <> 'system' AND NOT ct.is_group
      GROUP BY c.channel_id, m.status`),
    prisma.$queryRaw<Array<{ channel_id: string; provider: string; last_at: Date | null; last_1h: Count }>>(Prisma.sql`
      SELECT channel_id::text AS channel_id, provider, max(received_at) AS last_at, count(*) FILTER (WHERE received_at >= ${hour}) AS last_1h
      FROM canonical_observations WHERE channel_id = ANY(${ids}::uuid[]) AND received_at >= ${day} GROUP BY channel_id, provider`)
  ]);
  const names = new Map(mirrors.map(mirror => [mirror.workspaceId, mirror.name]));
  const views = channels.map(channel => {
    const t = traffic.find(row => row.channel_id === channel.id), r = recent.find(row => row.channel_id === channel.id);
    const status = (s: string) => n(acks.find(row => row.channel_id === channel.id && row.status === s)?.total ?? 0);
    const base: Omit<ChannelHealthView, "level" | "issues"> = {
      workspaceId: channel.workspaceId, workspaceName: names.get(channel.workspaceId) ?? null, channelId: channel.id,
      name: channel.displayName ?? "Canal sem nome", phone: channel.connections.find(connection => connection.verifiedPhoneNumber)?.verifiedPhoneNumber ?? channel.phoneNumber,
      status: channel.status,
      connections: channel.connections.filter(connection => connection.provider === "evolution" || connection.provider === "waha")
        .sort((a, b) => a.provider.localeCompare(b.provider)).map(connection => {
          const event = events.find(row => row.channel_id === channel.id && row.provider === connection.provider);
          return { provider: connection.provider as "evolution" | "waha", status: connection.status, health: connection.health, eligible: connection.eligible,
            verifiedPhone: connection.verifiedPhoneNumber, lastError: connection.lastError, lastHealthyAt: iso(connection.lastHealthyAt),
            lastCheckedAt: iso(connection.lastCheckedAt), consecutiveFailures: connection.consecutiveFailures,
            lastEventAt: iso(event?.last_at), events1h: n(event?.last_1h ?? 0) };
        }),
      traffic: { lastInboundAt: iso(t?.last_in), lastOutboundAt: iso(t?.last_out), inbound1h: n(r?.in_1h ?? 0), inbound24h: n(r?.in_24h ?? 0), outbound24h: n(r?.out_24h ?? 0) },
      acks: { pending: status("pending"), sent: status("sent"), delivered: status("delivered"), read: status("read"), failed: status("failed") },
      history: { status: channel.historyImportStatus, completedAt: iso(channel.historyImportCompletedAt) }
    };
    return { ...base, ...assessChannel(base, now.getTime()) };
  });
  const rank = { critical: 0, warning: 1, ok: 2 } as const;
  views.sort((a, b) => rank[a.level] - rank[b.level] || (a.workspaceName ?? a.workspaceId).localeCompare(b.workspaceName ?? b.workspaceId) || a.name.localeCompare(b.name));
  return { generatedAt: now.toISOString(), channels: views };
}
