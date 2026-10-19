import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { prymeiraWhatsappBehavior, prymeiraWhatsappPrompt, prymeiraWhatsappFlow } from "../src/modules/agents/prymeira-whatsapp-definition.js";

const workspaceId = "59cb6863-84d2-44e9-82f0-3db35cd724ec";
const sourceId = "f0b46711-1e18-4151-bf4b-765051dae25f";
const channelId = "cc9311b4-abbe-43b4-813e-72d02f09d753";
const name = "Maria (WhatsApp dos anúncios)";
const flowName = "Prymeira | Entrada direta do WhatsApp";

/** Creates an inactive agent only. It never changes routing, messages, sessions or the source agent. */
async function main() {
  const prisma = new PrismaClient();
  try {
    if (!process.argv.includes("--create") && !process.argv.includes("--update-draft")) throw new Error("Use --create or --update-draft. Only inactive drafts can be changed.");
    const result = await prisma.$transaction(async tx => {
      const source = await tx.aiAgent.findFirstOrThrow({ where: { workspaceId, id: sourceId, type: "attendance" } });
      const channel = await tx.channel.findFirstOrThrow({ where: { workspaceId, id: channelId, archivedAt: null } });
      if (channel.displayName !== "Prymeira") throw new Error("Unexpected channel.");
      const existing = await tx.aiAgent.findFirst({ where: { workspaceId, name } });
      if (existing && !process.argv.includes("--update-draft")) return { created: false, id: existing.id, status: existing.status };
      const sources = await tx.aiKnowledgeSource.findMany({ where: { workspaceId, agentId: sourceId, status: "ready" }, orderBy: { id: "asc" } });
      const approved = sources.filter(s => s.metadata && typeof s.metadata === "object" && !Array.isArray(s.metadata) && ["confirmed", "behavioral"].includes(String(s.metadata.approvalStatus)));
      if (approved.length !== 12) throw new Error(`Expected the 12 reviewed sources; got ${approved.length}. Recheck the source before creating.`);
      const fingerprint = createHash("sha256").update(JSON.stringify(approved.map(s => ({ id: s.id, title: s.title, content: s.content, metadata: s.metadata })))).digest("hex");
      const behavior = source.behaviorConfig && typeof source.behaviorConfig === "object" && !Array.isArray(source.behaviorConfig) ? source.behaviorConfig : {};
      if (existing) {
        const old = existing.behaviorConfig as Record<string, unknown>;
        if (existing.status !== "inactive" || old.sourceAgentId !== sourceId || old.sourceKnowledgeSha256 !== fingerprint) throw new Error("Draft changed or source knowledge changed; review before updating.");
        await tx.aiAgent.update({ where: { id: existing.id }, data: { systemPrompt: prymeiraWhatsappPrompt, behaviorConfig: { ...prymeiraWhatsappBehavior(channelId, behavior), sourceAgentId: sourceId, sourceKnowledgeSha256: fingerprint } } });
        const flow = await tx.automationRule.findFirst({ where: { workspaceId, name: flowName } }) ?? await tx.automationRule.create({ data: {
          workspaceId, name: flowName, status: "disabled", trigger: "message.received", conditions: { summary: "Primeira mensagem direta ao canal Prymeira, sem origem do site" }, actions: prymeiraWhatsappFlow(channelId, existing.id)
        } });
        return { updated: true, id: existing.id, status: existing.status, flowId: flow.id, flowStatus: flow.status, sources: approved.length, sourceKnowledgeSha256: fingerprint };
      }
      const agent = await tx.aiAgent.create({ data: {
        workspaceId, name, description: "Atendimento de quem chega direto do anúncio: dúvidas sobre agentes de IA e agendamento do Raio-X.", type: "attendance", status: "inactive",
        providerMode: source.providerMode, provider: source.provider, model: source.model, systemPrompt: prymeiraWhatsappPrompt,
        behaviorConfig: { ...prymeiraWhatsappBehavior(channelId, behavior), sourceAgentId: sourceId, sourceKnowledgeSha256: fingerprint },
        handoffConfig: { pauseAgent: true, confidenceThreshold: 0.5, createInternalSummary: true }, limitsConfig: { maxMessagesPerSession: 50 },
        allowedActions: ["send_message", "create_internal_note", "request_handoff", "schedule_meeting"]
      } });
      for (const s of approved) await tx.aiKnowledgeSource.create({ data: {
        workspaceId, agentId: agent.id, type: s.type, title: s.title, content: s.content, fileUrl: s.fileUrl, fileName: s.fileName, mimeType: s.mimeType,
        status: "ready", metadata: { ...(s.metadata as Record<string, never>), copiedFromSourceId: s.id, copiedFromAgentId: sourceId }
      } });
      const flow = await tx.automationRule.create({ data: { workspaceId, name: flowName, status: "disabled", trigger: "message.received", conditions: { summary: "Primeira mensagem direta ao canal Prymeira, sem origem do site" }, actions: prymeiraWhatsappFlow(channelId, agent.id) } });
      return { created: true, id: agent.id, status: agent.status, flowId: flow.id, flowStatus: flow.status, sources: approved.length, sourceKnowledgeSha256: fingerprint };
    });
    console.log(JSON.stringify(result));
  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Setup failed"); process.exitCode = 1; });
