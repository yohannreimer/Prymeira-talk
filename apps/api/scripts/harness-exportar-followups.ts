import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { autorDe, hash, lista, mascarar, prisma, resolverWorkspaces } from "./harness-exportar-conversas.js";

// Exports the follow-ups the current engine decided, with the conversation each one is about, for the
// follow-up shadow run (harness-sombra-followup.ts). Read-only: sends nothing, writes nothing to the database.
// Phones, e-mails and documents are masked; the contact's name becomes "Cliente".
//
//   HARNESS_WORKSPACE="Geral Villefer,Vendas 05" (by name)  or  HARNESS_WORKSPACE_ID=<id>[,<id>]
//   CANAIS="..." (optional: only channels whose name contains one of these)
//   DIAS=30   LIMITE=300 (follow-ups per workspace)   SAIDA=followups
// Output: <SAIDA>.jsonl.gz (one line per conversation) and <SAIDA>-base.jsonl (the agents' knowledge sources).

const dias = Number(process.env.DIAS ?? 30);
const limite = Number(process.env.LIMITE ?? 300);
const canais = lista(process.env.CANAIS).map((nome) => nome.toLowerCase());
const saida = process.env.SAIDA ?? "followups";

/** The part of the old decision worth comparing: what the old brain or JEV thought was open, never the prompt. */
function resumoDaDecisao(decision: unknown, nomes: string[]) {
  const value = decision && typeof decision === "object" && !Array.isArray(decision) ? decision as Record<string, unknown> : {};
  const brain = value.brain && typeof value.brain === "object" ? value.brain as Record<string, unknown> : null;
  const texto = (item: unknown) => typeof item === "string" ? mascarar(item, nomes) : null;
  return {
    modo: typeof value.mode === "string" ? value.mode : "jev",
    ...(brain ? {
      situacao: brain.situation ?? null,
      tipo: brain.kind ?? null,
      pendencia: texto(brain.pendingItem),
      proximoPasso: texto(brain.nextStep),
      risco: brain.risk ?? null,
      confianca: brain.confidence ?? null,
      porque: texto(brain.rationale)
    } : {
      resultado: value.outcome ?? null,
      rota: value.route ?? null,
      proposito: value.purpose ?? null,
      risco: value.risk ?? null
    })
  };
}

async function main() {
  const workspaces = await resolverWorkspaces();
  const desde = new Date(Date.now() - dias * 86_400_000);
  const linhas: string[] = [];
  const contagem: Record<string, number> = {};
  const agentes = new Set<string>();

  for (const workspaceId of workspaces) {
    const todos = await prisma.channel.findMany({ where: { workspaceId }, select: { id: true, displayName: true, provider: true } });
    const usados = canais.length ? todos.filter((canal) => canais.some((filtro) => (canal.displayName ?? "").toLowerCase().includes(filtro))) : todos;
    const nome = (await prisma.workspaceMirror.findUnique({ where: { workspaceId }, select: { name: true } }))?.name ?? "(sem nome)";
    console.log(`Workspace ${nome} (${hash(workspaceId)}): canais ${todos.map((canal) => `${canal.displayName ?? canal.provider}${usados.includes(canal) ? " ✓" : ""}`).join(", ") || "(nenhum)"}`);

    const followups = await prisma.conversationFollowup.findMany({
      where: {
        workspaceId,
        createdAt: { gte: desde },
        // Decided ones: cancelled means the contact or a seller wrote first; scheduled has not run yet.
        status: { in: ["sent", "review", "skipped"] },
        ...(canais.length ? { conversation: { channelId: { in: usados.map((canal) => canal.id) } } } : {})
      },
      orderBy: { createdAt: "desc" },
      take: limite
    });
    const porConversa = new Map<string, typeof followups>();
    for (const followup of followups) porConversa.set(followup.conversationId, [...(porConversa.get(followup.conversationId) ?? []), followup]);

    for (const [conversationId, doFollowup] of porConversa) {
      const conversa = await prisma.conversation.findFirst({
        where: { workspaceId, id: conversationId },
        select: { status: true, channel: { select: { displayName: true } }, contact: { select: { name: true } } }
      });
      if (!conversa) continue;
      const nomes = (conversa.contact?.name ?? "").split(/\s+/).filter((parte) => parte.length >= 3);
      const mensagens = await prisma.message.findMany({
        where: { workspaceId, conversationId, hiddenByReset: false },
        orderBy: { createdAt: "asc" },
        select: { direction: true, type: true, body: true, metadata: true, sentByUserId: true, createdAt: true }
      });
      for (const followup of doFollowup) {
        agentes.add(followup.agentId);
        const chave = `${followup.kind}/${followup.status}`;
        contagem[chave] = (contagem[chave] ?? 0) + 1;
      }
      linhas.push(JSON.stringify({
        conversa: hash(conversationId),
        workspace: hash(workspaceId),
        canal: conversa.channel?.displayName ?? null,
        conversaStatus: conversa.status,
        mensagens: mensagens.map((message) => ({
          autor: autorDe(message),
          tipo: message.type,
          texto: mascarar(message.body ?? "", nomes),
          em: message.createdAt
        })),
        followups: [...doFollowup].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((followup) => ({
          id: hash(followup.id),
          agente: hash(followup.agentId),
          tipo: followup.kind,
          etapa: followup.stepIndex,
          status: followup.status,
          motivo: followup.reason,
          ancora: followup.anchorMessageAt,
          agendadoPara: followup.scheduledAt,
          criadoEm: followup.createdAt,
          decididoEm: followup.sentAt ?? followup.updatedAt,
          enviadoPor: followup.status === "sent" ? (followup.sentByUserId ? "vendedor" : "automatico") : null,
          rascunho: followup.draftBody ? mascarar(followup.draftBody, nomes) : null,
          final: followup.finalBody ? mascarar(followup.finalBody, nomes) : null,
          decisao: resumoDaDecisao(followup.decision, nomes)
        }))
      }));
    }
  }

  const base = await prisma.aiKnowledgeSource.findMany({
    where: { workspaceId: { in: workspaces }, agentId: { in: [...agentes] } },
    select: { workspaceId: true, agentId: true, type: true, title: true, content: true, fileName: true, status: true }
  });
  await writeFile(resolve(`${saida}.jsonl.gz`), gzipSync(linhas.join("\n")));
  await writeFile(resolve(`${saida}-base.jsonl`), base.map((source) => JSON.stringify({ ...source, workspaceId: hash(source.workspaceId), agentId: hash(source.agentId) })).join("\n"));
  console.log(`Conversas com follow-up: ${linhas.length}`);
  for (const [chave, n] of Object.entries(contagem).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), chave);
  console.log(`Fontes da base: ${base.length} (dos agentes que fizeram esses follow-ups)`);
  console.log(`Arquivos: ${saida}.jsonl.gz e ${saida}-base.jsonl`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
