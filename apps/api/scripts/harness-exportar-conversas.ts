import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

// Exports real agent conversations for error analysis of the agents (read-only: sends nothing, writes
// nothing to the database). Each conversation has its messages in order, who wrote each one (contact,
// agent or a person from the company), how the agent session ended (handoff and reason) and the agent
// runs with what the agent decided. Phones, e-mails and documents are masked; the contact's name
// becomes "Cliente". The agents' knowledge sources go to a second file, as the company wrote them.
//
//   HARNESS_WORKSPACE_ID=<id>[,<id>]  (required)   DIAS=30   LIMITE=400   SAIDA=conversas
// Output: <SAIDA>.jsonl.gz (one conversation per line) and <SAIDA>-base.jsonl (knowledge sources).

const prisma = new PrismaClient();
const workspaces = (process.env.HARNESS_WORKSPACE_ID ?? "").split(",").map((id) => id.trim()).filter(Boolean);
const dias = Number(process.env.DIAS ?? 30);
const limite = Number(process.env.LIMITE ?? 400);
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

async function main() {
  if (!workspaces.length) throw new Error("Defina HARNESS_WORKSPACE_ID (um ou mais, separados por vírgula).");
  const desde = new Date(Date.now() - dias * 86_400_000);
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
      const autor = (message: (typeof mensagens)[number]) => {
        if (message.type === "internal_note") return "nota_interna";
        if (message.type === "system") return "sistema";
        if (message.direction === "inbound") return "contato";
        const source = (message.metadata as Record<string, unknown> | null)?.source;
        return source === "ai_agent" ? "agente" : message.sentByUserId ? "vendedor" : "empresa_automatico";
      };
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
          autor: autor(message),
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

  const base = await prisma.aiKnowledgeSource.findMany({
    where: { workspaceId: { in: workspaces } },
    select: { workspaceId: true, agentId: true, type: true, title: true, content: true, fileName: true, status: true }
  });
  await writeFile(resolve(`${saida}.jsonl.gz`), gzipSync(linhas.join("\n")));
  await writeFile(resolve(`${saida}-base.jsonl`), base.map((source) => JSON.stringify({ ...source, workspaceId: hash(source.workspaceId), agentId: hash(source.agentId) })).join("\n"));

  console.log(`Conversas: ${contagem.conversas} · mensagens: ${contagem.mensagens} · foram para humano: ${contagem.comHumano}`);
  for (const [chave, n] of Object.entries(contagem.porMotivo).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(n).padStart(4), chave);
  console.log(`Fontes da base: ${base.length}`);
  console.log(`Arquivos: ${saida}.jsonl.gz e ${saida}-base.jsonl`);
}

if (process.argv[1]?.endsWith("harness-exportar-conversas.ts")) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
