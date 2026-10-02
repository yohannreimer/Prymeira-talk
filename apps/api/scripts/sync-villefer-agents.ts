// Syncs the Villefer "Pré-atendimento" agent from the master workspace (vendas5 / Geral Villefer)
// to the other seller workspaces, keeping each seller's own name.
//
//   tsx scripts/sync-villefer-agents.ts              dry run (default): prints what would change, writes nothing
//   tsx scripts/sync-villefer-agents.ts --apply      backs up the old values in ai_action_logs, then applies
//   tsx scripts/sync-villefer-agents.ts --rollback   restores the latest applied sync from its backup
//
// Requires DATABASE_URL. Only ai_agents, ai_knowledge_sources and ai_action_logs are touched.
import { Prisma, PrismaClient } from "@prisma/client";
import {
  lineDiff,
  planFleetSync,
  planHasChanges,
  planHasErrors,
  type FleetAgent,
  type NewKnowledgeEntry,
  type TextFix
} from "../src/modules/agents/agent-fleet-sync.js";

const SOURCE = { label: "vendas5", workspaceId: "42e336e1-4ba8-4299-ba6d-8e2a01eef6cb" };
const OTHER_TARGETS = [
  { label: "vendas2", workspaceId: "8e9af9a2-242f-4d52-be0e-e9d1365f0e22" },
  { label: "vendas3", workspaceId: "5f772c65-c0e3-42c7-b46d-0609f5c185cf" },
  { label: "vendas6", workspaceId: "433c54c3-a408-417a-9b6d-57f9fc74761a" }
];
const AGENT_NAME_PREFIX = "Pré-atendimento Villefer";
const BACKUP_ACTION = "agent_fleet_sync_backup";
const APPROVED_BY = "Yohann Reimer — triagem das sugestões da IA";
const APPROVED_AT = "2026-10-01T00:00:00.000Z";
const KNOWLEDGE_SOURCE = "Triagem das sugestões da IA — aprovada pelo responsável em 01/10/2026";

const FIXES: TextFix[] = [
  { from: /\bJuniorr\b/g, to: "Junior", label: "erro de digitação 'Juniorr'" },
  { from: /\{\{seller_name\}\}r( preparar)/g, to: "{{seller_name}}$1", label: "'r' sobrando depois do nome" }
];

const NEW_KNOWLEDGE: NewKnowledgeEntry[] = [
  {
    key: "balcao_cpf_endereco",
    type: "text",
    title: "Venda no balcão e endereço da loja",
    content:
      "A Villefer vende no balcão para pessoa física (CPF), apenas itens em estoque. Endereço: R. Landmann, 464 — Costa e Silva, Joinville/SC, 89217-420.",
    category: "stock_and_availability",
    aliases: ["balcão", "balcao", "retirada", "endereço", "endereco", "onde fica", "loja", "CPF", "pessoa física", "pessoa fisica"],
    source: KNOWLEDGE_SOURCE
  },
  {
    key: "nao_fornecemos_fora_de_linha",
    type: "text",
    title: "O que a Villefer não fornece",
    content:
      "Foco atual: chapas de ferro/aço carbono e laminados. Não fornecemos: telhas, flanges, buchas de ferro fundido e componentes para portão (guia, roldana). Não atendemos linha de construção civil. Responda de forma curta e cordial; não é necessário chamar um vendedor.",
    category: "product_and_specification",
    aliases: ["telha", "telhas", "flange", "flanges", "bucha", "ferro fundido", "portão", "portao", "guia", "roldana", "construção civil", "construcao civil", "não fornecemos", "nao fornecemos"],
    source: KNOWLEDGE_SOURCE
  },
  {
    key: "chapa_piso_aluminio",
    type: "text",
    title: "Chapa de piso de alumínio",
    content: "Chapa de piso de alumínio: sob encomenda, prazo de 5 a 10 dias úteis, tamanho padrão 1250x3000.",
    category: "product_and_specification",
    aliases: ["chapa de piso", "piso de alumínio", "piso de aluminio", "chapa xadrez", "alumínio", "aluminio", "1250x3000"],
    source: KNOWLEDGE_SOURCE
  }
];

const prisma = new PrismaClient();
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const rollback = args.has("--rollback");

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function loadAgent(workspaceId: string, label: string): Promise<FleetAgent> {
  const agents = await prisma.aiAgent.findMany({
    where: { workspaceId, name: { startsWith: AGENT_NAME_PREFIX } }
  });
  if (agents.length !== 1) throw new Error(`${label}: expected exactly 1 "${AGENT_NAME_PREFIX}" agent, found ${agents.length}.`);
  const agent = agents[0];
  const knowledge = await prisma.aiKnowledgeSource.findMany({ where: { workspaceId, agentId: agent.id }, orderBy: { createdAt: "asc" } });
  return {
    workspaceId,
    id: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    behaviorConfig: asRecord(agent.behaviorConfig),
    knowledge: knowledge.map((item) => ({
      id: item.id,
      type: String(item.type),
      title: item.title,
      content: item.content,
      metadata: asRecord(item.metadata)
    }))
  };
}

function short(value: string, max = 140) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function runSync() {
  const source = await loadAgent(SOURCE.workspaceId, SOURCE.label);
  const others = await Promise.all(OTHER_TARGETS.map((target) => loadAgent(target.workspaceId, target.label)));
  // The master is also a target: it receives the typo fix and the new approved knowledge.
  const plan = planFleetSync({
    source,
    targets: [source, ...others],
    newKnowledge: NEW_KNOWLEDGE,
    fixes: FIXES,
    approvedBy: APPROVED_BY,
    approvedAt: APPROVED_AT
  });

  const labels = new Map([[SOURCE.workspaceId, SOURCE.label], ...OTHER_TARGETS.map((target) => [target.workspaceId, target.label] as const)]);
  console.log(`\nMODO: ${apply ? "APLICAR" : "ENSAIO (nada será gravado)"}   origem: ${SOURCE.label}\n`);
  for (const message of plan.errors) console.log(`ERRO (origem): ${message}`);
  for (const target of plan.targets) {
    const label = labels.get(target.workspaceId) ?? target.workspaceId;
    console.log(`── ${label} — ${target.agentName}`);
    for (const message of target.errors) console.log(`   ERRO: ${message}`);
    const diff = lineDiff(target.prompt.before, target.prompt.after);
    console.log(`   prompt: ${target.prompt.changed ? `muda (+${diff.added.length} / -${diff.removed.length} linhas)` : "sem mudança"}`);
    for (const line of diff.added) console.log(`     + ${short(line)}`);
    for (const line of diff.removed) console.log(`     - ${short(line)}`);
    console.log(`   modelo do prompt (packagePromptTemplate): ${target.template.changed ? "muda" : "sem mudança"}`);
    for (const update of target.knowledgeUpdates) {
      const changes = lineDiff(update.before, update.after);
      console.log(`   conhecimento ATUALIZA "${update.title}" (+${changes.added.length} / -${changes.removed.length} linhas)`);
      for (const line of changes.added) console.log(`     + ${short(line)}`);
      for (const line of changes.removed) console.log(`     - ${short(line)}`);
    }
    for (const create of target.knowledgeCreates) console.log(`   conhecimento CRIA "${create.title}"`);
  }

  if (planHasErrors(plan)) {
    console.log("\nHá erros acima. Nada foi gravado.");
    process.exitCode = 1;
    return;
  }
  if (!planHasChanges(plan)) {
    console.log("\nTudo já está sincronizado. Nada a fazer.");
    return;
  }
  if (!apply) {
    console.log("\nEnsaio concluído. Para gravar, rode de novo com --apply.");
    return;
  }

  for (const target of plan.targets) {
    if (!target.prompt.changed && !target.template.changed && target.knowledgeUpdates.length === 0 && target.knowledgeCreates.length === 0) continue;
    await prisma.$transaction(async (tx) => {
      const agent = await tx.aiAgent.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId: target.workspaceId, id: target.agentId } } });
      const previousKnowledge = await tx.aiKnowledgeSource.findMany({
        where: { workspaceId: target.workspaceId, id: { in: target.knowledgeUpdates.map((update) => update.id) } }
      });
      const log = await tx.aiActionLog.create({
        data: {
          workspaceId: target.workspaceId,
          actionType: BACKUP_ACTION,
          status: "applied",
          input: {
            agentId: target.agentId,
            systemPrompt: agent.systemPrompt,
            packagePromptTemplate: asRecord(agent.behaviorConfig).packagePromptTemplate ?? null,
            knowledge: previousKnowledge.map((item) => ({ id: item.id, content: item.content, metadata: item.metadata }))
          } as Prisma.InputJsonValue
        }
      });

      if (target.prompt.changed || target.template.changed) {
        await tx.aiAgent.update({
          where: { workspaceId_id: { workspaceId: target.workspaceId, id: target.agentId } },
          data: {
            systemPrompt: target.prompt.after,
            behaviorConfig: { ...asRecord(agent.behaviorConfig), packagePromptTemplate: target.template.after } as Prisma.InputJsonValue
          }
        });
      }
      for (const update of target.knowledgeUpdates) {
        await tx.aiKnowledgeSource.update({
          where: { workspaceId_id: { workspaceId: target.workspaceId, id: update.id } },
          data: { content: update.after, metadata: update.metadata as Prisma.InputJsonValue }
        });
      }
      const createdIds: string[] = [];
      for (const create of target.knowledgeCreates) {
        const created = await tx.aiKnowledgeSource.create({
          data: {
            workspaceId: target.workspaceId,
            agentId: target.agentId,
            type: create.type as "text" | "faq" | "file",
            title: create.title,
            content: create.content,
            status: "ready",
            metadata: create.metadata as Prisma.InputJsonValue
          }
        });
        createdIds.push(created.id);
      }
      await tx.aiActionLog.update({
        where: { workspaceId_id: { workspaceId: target.workspaceId, id: log.id } },
        data: { result: { createdKnowledgeIds: createdIds } as Prisma.InputJsonValue }
      });
      console.log(`APLICADO em ${labels.get(target.workspaceId)}: backup ${log.id}`);
    });
  }
  console.log("\nSincronização aplicada. Para desfazer: --rollback");
}

async function runRollback() {
  for (const target of [SOURCE, ...OTHER_TARGETS]) {
    const log = await prisma.aiActionLog.findFirst({
      where: { workspaceId: target.workspaceId, actionType: BACKUP_ACTION, status: "applied" },
      orderBy: { createdAt: "desc" }
    });
    if (!log) {
      console.log(`${target.label}: nenhum backup aplicado para desfazer.`);
      continue;
    }
    const backup = asRecord(log.input);
    const created = asRecord(log.result).createdKnowledgeIds;
    console.log(`${target.label}: ${apply ? "restaurando" : "[ensaio] restauraria"} backup ${log.id}`);
    if (!apply) continue;
    await prisma.$transaction(async (tx) => {
      const agentId = String(backup.agentId);
      const agent = await tx.aiAgent.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId: target.workspaceId, id: agentId } } });
      await tx.aiAgent.update({
        where: { workspaceId_id: { workspaceId: target.workspaceId, id: agentId } },
        data: {
          systemPrompt: String(backup.systemPrompt),
          behaviorConfig: { ...asRecord(agent.behaviorConfig), packagePromptTemplate: backup.packagePromptTemplate ?? null } as Prisma.InputJsonValue
        }
      });
      for (const item of (Array.isArray(backup.knowledge) ? backup.knowledge : []) as Record<string, unknown>[]) {
        await tx.aiKnowledgeSource.update({
          where: { workspaceId_id: { workspaceId: target.workspaceId, id: String(item.id) } },
          data: { content: (item.content as string | null) ?? null, metadata: (item.metadata ?? {}) as Prisma.InputJsonValue }
        });
      }
      if (Array.isArray(created) && created.length > 0) {
        await tx.aiKnowledgeSource.deleteMany({ where: { workspaceId: target.workspaceId, id: { in: created.map(String) } } });
      }
      await tx.aiActionLog.update({ where: { workspaceId_id: { workspaceId: target.workspaceId, id: log.id } }, data: { status: "rolled_back" } });
    });
  }
  if (!apply) console.log("\nEnsaio da reversão. Para restaurar de fato, rode: --rollback --apply");
}

try {
  if (rollback) await runRollback();
  else await runSync();
} finally {
  await prisma.$disconnect();
}
