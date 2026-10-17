// Turns the new attendance agent (modules/harness) on for every Villefer sales workspace: each one's
// "Pré-atendimento Villefer" agent gets behaviorConfig.harness with all the workspace's numbers, marked as
// the customer "Villefer" so the weekly evaluation and its rules cover the four together.
//
//   tsx scripts/harness-ligar-villefer.ts              dry run (default): prints what would change, writes nothing
//   tsx scripts/harness-ligar-villefer.ts --apply      backs up the old harness value in ai_action_logs, then applies
//   tsx scripts/harness-ligar-villefer.ts --rollback   restores the latest applied backup (add --apply to write)
//
// Requires DATABASE_URL. Only ai_agents.behavior_config.harness and ai_action_logs are touched. The rules
// already approved in the weekly evaluation (regrasDoFollowup) are kept.
import { Prisma, PrismaClient } from "@prisma/client";

const WORKSPACES = [
  { label: "vendas5", workspaceId: "42e336e1-4ba8-4299-ba6d-8e2a01eef6cb" },
  { label: "vendas2", workspaceId: "8e9af9a2-242f-4d52-be0e-e9d1365f0e22" },
  { label: "vendas3", workspaceId: "5f772c65-c0e3-42c7-b46d-0609f5c185cf" },
  { label: "vendas6", workspaceId: "433c54c3-a408-417a-9b6d-57f9fc74761a" }
];
const AGENT_NAME_PREFIX = "Pré-atendimento Villefer";
const BACKUP_ACTION = "harness_rollout_backup";

const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const rollback = args.has("--rollback");

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The harness value for one workspace: its numbers, the Villefer catalogue and minimums, the customer mark. */
function harnessDaVillefer(atual: unknown, canais: string[]) {
  const anterior = asRecord(atual);
  return {
    ...anterior,
    agente: "atendimento",
    canais,
    cliente: "Villefer",
    catalogo: "villefer",
    propostaVillefer: true
  };
}

async function loadTarget(workspaceId: string, label: string) {
  const agents = await prisma.aiAgent.findMany({ where: { workspaceId, name: { startsWith: AGENT_NAME_PREFIX } } });
  if (agents.length !== 1) throw new Error(`${label}: esperava 1 agente "${AGENT_NAME_PREFIX}…", achei ${agents.length}.`);
  const channels = await prisma.channel.findMany({ where: { workspaceId, archivedAt: null }, orderBy: { createdAt: "asc" } });
  if (!channels.length) throw new Error(`${label}: nenhum número ativo no workspace.`);
  return { agent: agents[0]!, channels };
}

async function runRollout() {
  const targets = [];
  for (const workspace of WORKSPACES) {
    const { agent, channels } = await loadTarget(workspace.workspaceId, workspace.label);
    const before = asRecord(agent.behaviorConfig).harness ?? null;
    const after = harnessDaVillefer(before, channels.map((channel) => channel.id));
    console.log(`\n${workspace.label} — agente "${agent.name}" (${agent.id}), status ${agent.status}`);
    for (const channel of channels) console.log(`  número: ${channel.displayName ?? "(sem nome)"} · ${channel.provider} · ${channel.id}`);
    console.log(`  antes:  ${JSON.stringify(before)}`);
    console.log(`  depois: ${JSON.stringify(after)}`);
    targets.push({ workspace, agent, before, after });
  }
  if (!apply) {
    console.log("\nEnsaio: nada foi gravado. Para aplicar: --apply");
    return;
  }
  for (const { workspace, agent, before, after } of targets) {
    await prisma.$transaction(async (tx) => {
      const log = await tx.aiActionLog.create({
        data: {
          workspaceId: workspace.workspaceId,
          actionType: BACKUP_ACTION,
          status: "applied",
          input: { agentId: agent.id, harness: before } as Prisma.InputJsonValue
        }
      });
      await tx.aiAgent.update({
        where: { workspaceId_id: { workspaceId: workspace.workspaceId, id: agent.id } },
        data: { behaviorConfig: { ...asRecord(agent.behaviorConfig), harness: after } as Prisma.InputJsonValue }
      });
      console.log(`APLICADO em ${workspace.label}: backup ${log.id}`);
    });
  }
  console.log("\nAgente novo ligado nos workspaces da Villefer. Para desfazer: --rollback --apply");
}

async function runRollback() {
  for (const workspace of WORKSPACES) {
    const log = await prisma.aiActionLog.findFirst({
      where: { workspaceId: workspace.workspaceId, actionType: BACKUP_ACTION, status: "applied" },
      orderBy: { createdAt: "desc" }
    });
    if (!log) {
      console.log(`${workspace.label}: nenhum backup aplicado para desfazer.`);
      continue;
    }
    const backup = asRecord(log.input);
    const agentId = String(backup.agentId);
    console.log(`${workspace.label}: ${apply ? "restaurando" : "[ensaio] restauraria"} harness = ${JSON.stringify(backup.harness ?? null)} (backup ${log.id})`);
    if (!apply) continue;
    await prisma.$transaction(async (tx) => {
      const agent = await tx.aiAgent.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId: workspace.workspaceId, id: agentId } } });
      const { harness: _atual, ...resto } = asRecord(agent.behaviorConfig);
      await tx.aiAgent.update({
        where: { workspaceId_id: { workspaceId: workspace.workspaceId, id: agentId } },
        data: { behaviorConfig: (backup.harness ? { ...resto, harness: backup.harness } : resto) as Prisma.InputJsonValue }
      });
      await tx.aiActionLog.update({ where: { workspaceId_id: { workspaceId: workspace.workspaceId, id: log.id } }, data: { status: "rolled_back" } });
    });
  }
  if (!apply) console.log("\nEnsaio da reversão. Para restaurar de fato: --rollback --apply");
}

try {
  if (rollback) await runRollback();
  else await runRollout();
} finally {
  await prisma.$disconnect();
}
