import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

// Exports real conversations for error analysis of the agents (read-only: sends nothing, writes
// nothing to the database). Two sets:
// - agent conversations: messages in order, who wrote each one, how the agent session ended and what
//   each agent run decided;
// - conversations answered by the sellers, with no agent: a real customer question next to the real
//   seller answer, the reference the attendant and its reviewer are measured against.
// Phones, e-mails and documents are masked; the contact's name becomes "Cliente". The agents' knowledge
// sources go to a third file, as the company wrote them.
//
//   HARNESS_WORKSPACE="Vendas 03,Vendas 05" (by name)  or  HARNESS_WORKSPACE_ID=<id>[,<id>]
//   CANAIS="Geral Villefer,Vendas 5" (optional: only channels whose name contains one of these)
//   DIAS=30   LIMITE=400 (agent sessions per workspace)   LIMITE_VENDEDORES=400 (per workspace)   SAIDA=conversas
// Output: <SAIDA>.jsonl.gz, <SAIDA>-vendedores.jsonl.gz and <SAIDA>-base.jsonl. It prints the workspaces
// and channels it used, so a wrong name shows up before anyone reads the files.

const prisma = new PrismaClient();
const lista = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const dias = Number(process.env.DIAS ?? 30);
const limite = Number(process.env.LIMITE ?? 400);
const limiteVendedores = Number(process.env.LIMITE_VENDEDORES ?? 400);
const canais = lista(process.env.CANAIS).map((nome) => nome.toLowerCase());
const saida = process.env.SAIDA ?? "conversas";

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

export function mascarar(texto: string, nomes: string[] = []) {
  let result = texto
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[cnpj]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]")
    .replace(/(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[\s-]?\d{4}\b/g, "[telefone]");
  for (const nome of nomes.filter((item) => item.trim().length >= 3)) {
    result = result.replace(new RegExp(`\\b${nome.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "Cliente");
  }
  return result;
}

const autorDe = (message: { type: string; direction: string; metadata: unknown; sentByUserId: string | null }) => {
  if (message.type === "internal_note") return "nota_interna";
  if (message.type === "system") return "sistema";
  if (message.direction === "inbound") return "contato";
  const source = (message.metadata as Record<string, unknown> | null)?.source;
  return source === "ai_agent" ? "agente" : message.sentByUserId ? "vendedor" : "empresa_automatico";
};

async function resolverWorkspaces() {
  const ids = lista(process.env.HARNESS_WORKSPACE_ID);
  const nomes = lista(process.env.HARNESS_WORKSPACE);
  if (!ids.length && !nomes.length) throw new Error("Defina HARNESS_WORKSPACE (nomes) ou HARNESS_WORKSPACE_ID (ids), separados por vírgula.");
  const achados = nomes.length
    ? await prisma.workspaceMirror.findMany({ where: { OR: nomes.map((nome) => ({ name: { contains: nome, mode: "insensitive" as const } })) }, select: { workspaceId: true, name: true } })
    : [];
  const result = [...new Set([...ids, ...achados.map((item) => item.workspaceId)])];
  for (const nome of nomes) if (!achados.some((item) => item.name?.toLowerCase().includes(nome.toLowerCase()))) console.log(`Nenhum workspace com nome parecido com "${nome}".`);
  if (!result.length) throw new Error("Nenhum workspace encontrado.");
  return result;
}

async function main() {
  const workspaces = await resolverWorkspaces();
  const desde = new Date(Date.now() - dias * 86_400_000);
  const canaisPorWorkspace = new Map<string, string[] | null>();
  for (const workspaceId of workspaces) {
    const nome = (await prisma.workspaceMirror.findUnique({ where: { workspaceId }, select: { name: true } }))?.name ?? "(sem nome)";
    const todos = await prisma.channel.findMany({ where: { workspaceId }, select: { id: true, displayName: true, provider: true } });
    const usados = canais.length ? todos.filter((canal) => canais.some((filtro) => (canal.displayName ?? "").toLowerCase().includes(filtro))) : todos;
    canaisPorWorkspace.set(workspaceId, canais.length ? usados.map((canal) => canal.id) : null);
    console.log(`Workspace ${nome} (${hash(workspaceId)}): canais ${todos.map((canal) => `${canal.displayName ?? canal.provider}${usados.includes(canal) ? " ✓" : ""}`).join(", ") || "(nenhum)"}`);
  }
  const linhas: string[] = [];
  const contagem = { conversas: 0, mensagens: 0, comHumano: 0, porMotivo: {} as Record<string, number> };

  for (const workspaceId of workspaces) {
    const sessoes = await prisma.aiAgentSession.findMany({
      where: { workspaceId, updatedAt: { gte: desde } },
      orderBy: { updatedAt: "desc" },
      take: limite,
      include: {
        agent: { select: { type: true, name: true } },
        conversation: { select: { id: true, status: true, aiControlStatus: true, contact: { select: { name: true } } } }
      }
    });
    for (const sessao of sessoes) {
      const conversa = sessao.conversation;
      const nomes = (conversa.contact?.name ?? "").split(/\s+/).filter((parte) => parte.length >= 3);
      const mensagens = await prisma.message.findMany({
        where: { workspaceId, conversationId: conversa.id, hiddenByReset: false },
        orderBy: { createdAt: "asc" },
        select: { direction: true, type: true, body: true, metadata: true, sentByUserId: true, createdAt: true }
      });
      const runs = await prisma.aiAgentRun.findMany({
        where: { workspaceId, sessionId: sessao.id },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, status: true, confidence: true, output: true, knowledgeMatches: true, errorMessage: true }
      });
      const motivo = sessao.handoffReason ?? null;
      if (sessao.status === "handoff_requested" || motivo) {
        contagem.comHumano += 1;
        const chave = motivo ? motivo.slice(0, 60) : "(sem motivo)";
        contagem.porMotivo[chave] = (contagem.porMotivo[chave] ?? 0) + 1;
      }
      contagem.conversas += 1;
      contagem.mensagens += mensagens.length;
      linhas.push(JSON.stringify({
        conversa: hash(conversa.id),
        workspace: hash(workspaceId),
        agente: { tipo: sessao.agent.type, nome: sessao.agent.name },
        sessao: { status: sessao.status, motivoHumano: motivo ? mascarar(motivo, nomes) : null, inicio: sessao.createdAt, mensagensDoAgente: sessao.messageCount },
        conversaStatus: conversa.status,
        controle: conversa.aiControlStatus,
        mensagens: mensagens.map((message) => ({
          autor: autorDe(message),
          tipo: message.type,
          texto: mascarar(message.body ?? "", nomes),
          em: message.createdAt
        })),
        decisoes: runs.map((run) => {
          const output = (run.output ?? {}) as Record<string, unknown>;
          const matches = Array.isArray(run.knowledgeMatches) ? (run.knowledgeMatches as Array<Record<string, unknown>>) : [];
          return {
            em: run.createdAt,
            status: run.status,
            confianca: run.confidence,
            resposta: typeof output.reply === "string" ? mascarar(output.reply, nomes) : null,
            humano: output.handoff ?? null,
            acoes: Array.isArray(output.actions) ? (output.actions as Array<Record<string, unknown>>).map((action) => action.type) : [],
            trechosDaBase: matches.map((match) => match.title ?? match.sourceTitle ?? match.id).filter(Boolean),
            erro: run.errorMessage
          };
        })
      }));
    }
  }

  // Conversations the sellers answered, with no agent session: the customer's question and what a person replied.
  const vendedores: string[] = [];
  for (const workspaceId of workspaces) {
    const canaisUsados = canaisPorWorkspace.get(workspaceId);
    const conversas = await prisma.conversation.findMany({
      where: {
        workspaceId,
        lastMessageAt: { gte: desde },
        retiredIntoConversationId: null,
        aiSessions: { none: {} },
        ...(canaisUsados ? { channelId: { in: canaisUsados } } : {}),
        messages: { some: { sentByUserId: { not: null }, hiddenByReset: false } },
        AND: [{ messages: { some: { direction: "inbound", hiddenByReset: false } } }]
      },
      orderBy: { lastMessageAt: "desc" },
      take: limiteVendedores,
      select: { id: true, status: true, channel: { select: { displayName: true } }, contact: { select: { name: true } } }
    });
    for (const conversa of conversas) {
      const nomes = (conversa.contact?.name ?? "").split(/\s+/).filter((parte) => parte.length >= 3);
      const mensagens = await prisma.message.findMany({
        where: { workspaceId, conversationId: conversa.id, hiddenByReset: false, createdAt: { gte: desde } },
        orderBy: { createdAt: "asc" },
        select: { direction: true, type: true, body: true, metadata: true, sentByUserId: true, createdAt: true }
      });
      vendedores.push(JSON.stringify({
        conversa: hash(conversa.id),
        workspace: hash(workspaceId),
        canal: conversa.channel?.displayName ?? null,
        conversaStatus: conversa.status,
        mensagens: mensagens.map((message) => ({
          autor: autorDe(message),
          vendedor: message.sentByUserId ? hash(message.sentByUserId) : undefined,
          tipo: message.type,
          texto: mascarar(message.body ?? "", nomes),
          em: message.createdAt
        }))
      }));
    }
  }

  const base = await prisma.aiKnowledgeSource.findMany({
    where: { workspaceId: { in: workspaces } },
    select: { workspaceId: true, agentId: true, type: true, title: true, content: true, fileName: true, status: true }
  });
  await writeFile(resolve(`${saida}.jsonl.gz`), gzipSync(linhas.join("\n")));
  await writeFile(resolve(`${saida}-vendedores.jsonl.gz`), gzipSync(vendedores.join("\n")));
  await writeFile(resolve(`${saida}-base.jsonl`), base.map((source) => JSON.stringify({ ...source, workspaceId: hash(source.workspaceId), agentId: hash(source.agentId) })).join("\n"));

  console.log(`Conversas: ${contagem.conversas} · mensagens: ${contagem.mensagens} · foram para humano: ${contagem.comHumano}`);
  for (const [chave, n] of Object.entries(contagem.porMotivo).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(n).padStart(4), chave);
  console.log(`Conversas atendidas por vendedores: ${vendedores.length}`);
  console.log(`Fontes da base: ${base.length}`);
  console.log(`Arquivos: ${saida}.jsonl.gz, ${saida}-vendedores.jsonl.gz e ${saida}-base.jsonl`);
}

if (process.argv[1]?.endsWith("harness-exportar-conversas.ts")) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
