import { z } from "zod";

export const automationBlockSupportSchema = z.enum(["supported", "visual_only", "coming_soon"]);
export type AutomationBlockSupport = z.infer<typeof automationBlockSupportSchema>;

export const automationBlockCategorySchema = z.enum([
  "trigger",
  "communication",
  "decision",
  "time",
  "crm",
  "integration",
  "control"
]);
export type AutomationBlockCategory = z.infer<typeof automationBlockCategorySchema>;

export const automationBlockTypeSchema = z.enum([
  "trigger_first_message",
  "trigger_reengagement",
  "trigger_keyword",
  "trigger_tag_added",
  "trigger_board_stage_changed",
  "trigger_conversation_closed",
  "trigger_schedule",
  "trigger_webhook",
  "send_message",
  "send_quick_reply",
  "send_image",
  "send_file",
  "send_audio",
  "ask_open_reply",
  "ask_options",
  "send_template",
  "notify_team",
  "condition_tag",
  "condition_channel",
  "condition_time",
  "condition_text",
  "condition_board_stage",
  "condition_assignee",
  "condition_source",
  "condition_status",
  "wait_time",
  "wait_until",
  "wait_reply",
  "limit_repetition",
  "business_hours",
  "add_tag",
  "remove_tag",
  "move_board_stage",
  "assign_user",
  "change_priority",
  "create_internal_note",
  "close_conversation",
  "upsert_contact",
  "create_task",
  "http_request",
  "ai_classify_message",
  "ai_generate_summary",
  "ai_suggest_reply",
  "enrich_contact",
  "external_system",
  "end_flow",
  "skip_step",
  "dedupe_guard",
  "mark_error",
  "log_event"
]);
export type AutomationBlockType = z.infer<typeof automationBlockTypeSchema>;

export interface AutomationBlockDefinition {
  type: AutomationBlockType;
  category: AutomationBlockCategory;
  label: string;
  description: string;
  support: AutomationBlockSupport;
}

export const automationBlockCatalog: AutomationBlockDefinition[] = [
  { type: "trigger_first_message", category: "trigger", label: "Primeira mensagem", description: "Dispara quando o contato nunca falou antes.", support: "supported" },
  { type: "trigger_reengagement", category: "trigger", label: "Retorno apos pausa", description: "Dispara quando o contato volta apos X dias sem mensagem.", support: "supported" },
  { type: "trigger_keyword", category: "trigger", label: "Palavra-chave", description: "Dispara por texto recebido.", support: "visual_only" },
  { type: "trigger_tag_added", category: "trigger", label: "Tag adicionada", description: "Dispara quando uma tag entra no contato.", support: "visual_only" },
  { type: "trigger_board_stage_changed", category: "trigger", label: "Etapa alterada", description: "Dispara quando o contato muda de etapa.", support: "supported" },
  { type: "trigger_conversation_closed", category: "trigger", label: "Conversa encerrada", description: "Dispara quando atendimento fecha.", support: "supported" },
  { type: "trigger_schedule", category: "trigger", label: "Horario/agendamento", description: "Dispara por horario configurado.", support: "visual_only" },
  { type: "trigger_webhook", category: "trigger", label: "Webhook externo", description: "Dispara por evento externo.", support: "coming_soon" },
  { type: "send_message", category: "communication", label: "Enviar mensagem", description: "Envia texto pelo WhatsApp.", support: "supported" },
  { type: "send_quick_reply", category: "communication", label: "Enviar mensagem padrao", description: "Usa uma mensagem padrao salva.", support: "supported" },
  { type: "send_image", category: "communication", label: "Enviar imagem", description: "Envia imagem.", support: "supported" },
  { type: "send_file", category: "communication", label: "Enviar arquivo", description: "Envia documento/arquivo.", support: "supported" },
  { type: "send_audio", category: "communication", label: "Enviar audio", description: "Envia audio gravado.", support: "visual_only" },
  { type: "ask_open_reply", category: "communication", label: "Pedir resposta", description: "Pede uma resposta aberta.", support: "supported" },
  { type: "ask_options", category: "communication", label: "Pedir escolha", description: "Mostra opcoes para o contato.", support: "visual_only" },
  { type: "send_template", category: "communication", label: "Enviar template", description: "Envia template aprovado.", support: "coming_soon" },
  { type: "notify_team", category: "communication", label: "Notificar equipe", description: "Cria alerta interno.", support: "visual_only" },
  { type: "condition_tag", category: "decision", label: "Condicao por tag", description: "Ramifica por tag.", support: "supported" },
  { type: "condition_channel", category: "decision", label: "Condicao por canal", description: "Ramifica por canal.", support: "supported" },
  { type: "condition_time", category: "decision", label: "Condicao por horario", description: "Ramifica por horario.", support: "supported" },
  { type: "condition_text", category: "decision", label: "Condicao por texto", description: "Ramifica por texto recebido.", support: "supported" },
  { type: "condition_board_stage", category: "decision", label: "Condicao por etapa", description: "Ramifica por etapa do CRM.", support: "supported" },
  { type: "condition_assignee", category: "decision", label: "Condicao por responsavel", description: "Ramifica por responsavel.", support: "visual_only" },
  { type: "condition_source", category: "decision", label: "Condicao por origem", description: "Ramifica por origem.", support: "visual_only" },
  { type: "condition_status", category: "decision", label: "Condicao por status", description: "Ramifica por status da conversa.", support: "visual_only" },
  { type: "wait_time", category: "time", label: "Aguardar tempo", description: "Espera minutos/horas/dias.", support: "supported" },
  { type: "wait_until", category: "time", label: "Aguardar ate horario", description: "Espera horario especifico.", support: "visual_only" },
  { type: "wait_reply", category: "time", label: "Aguardar resposta", description: "Espera resposta do contato.", support: "supported" },
  { type: "limit_repetition", category: "time", label: "Limitar repeticao", description: "Evita repeticao em janela.", support: "visual_only" },
  { type: "business_hours", category: "time", label: "Horario comercial", description: "Respeita janela de atendimento.", support: "visual_only" },
  { type: "add_tag", category: "crm", label: "Adicionar tag", description: "Adiciona tag.", support: "supported" },
  { type: "remove_tag", category: "crm", label: "Remover tag", description: "Remove tag.", support: "supported" },
  { type: "move_board_stage", category: "crm", label: "Mover no CRM", description: "Move contato para etapa.", support: "supported" },
  { type: "assign_user", category: "crm", label: "Atribuir responsavel", description: "Define responsavel.", support: "supported" },
  { type: "change_priority", category: "crm", label: "Alterar prioridade", description: "Altera prioridade.", support: "supported" },
  { type: "create_internal_note", category: "crm", label: "Criar nota interna", description: "Cria nota no contato.", support: "supported" },
  { type: "close_conversation", category: "crm", label: "Fechar conversa", description: "Fecha atendimento.", support: "supported" },
  { type: "upsert_contact", category: "crm", label: "Criar/atualizar contato", description: "Atualiza cadastro.", support: "visual_only" },
  { type: "create_task", category: "crm", label: "Criar tarefa", description: "Cria tarefa no CRM.", support: "visual_only" },
  { type: "http_request", category: "integration", label: "HTTP request", description: "Chama endpoint externo.", support: "coming_soon" },
  { type: "ai_classify_message", category: "integration", label: "Classificar mensagem", description: "Classifica com IA.", support: "coming_soon" },
  { type: "ai_generate_summary", category: "integration", label: "Gerar resumo", description: "Resume conversa com IA.", support: "coming_soon" },
  { type: "ai_suggest_reply", category: "integration", label: "Sugerir resposta", description: "Sugere resposta com IA.", support: "coming_soon" },
  { type: "enrich_contact", category: "integration", label: "Enriquecer contato", description: "Busca dados externos.", support: "coming_soon" },
  { type: "external_system", category: "integration", label: "Sistema externo", description: "Envia para sistema externo.", support: "coming_soon" },
  { type: "end_flow", category: "control", label: "Finalizar fluxo", description: "Encerra automacao.", support: "supported" },
  { type: "skip_step", category: "control", label: "Pular etapa", description: "Pula proximo passo.", support: "visual_only" },
  { type: "dedupe_guard", category: "control", label: "Evitar duplicidade", description: "Bloqueia duplicidade.", support: "visual_only" },
  { type: "mark_error", category: "control", label: "Marcar erro", description: "Registra falha.", support: "visual_only" },
  { type: "log_event", category: "control", label: "Registrar evento", description: "Registra evento no run.", support: "supported" }
];

export const automationNodeSchema = z.object({
  id: z.string().min(1),
  type: automationBlockTypeSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.object({
    title: z.string().min(1),
    config: z.record(z.string(), z.unknown()).default({})
  })
});
export type AutomationNodeDefinition = z.infer<typeof automationNodeSchema>;

export const automationEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullable().optional(),
  targetHandle: z.string().nullable().optional()
});
export type AutomationEdgeDefinition = z.infer<typeof automationEdgeSchema>;

export const automationFlowSchema = z.object({
  version: z.literal(1),
  nodes: z.array(automationNodeSchema),
  edges: z.array(automationEdgeSchema)
});
export type AutomationFlowDefinition = z.infer<typeof automationFlowSchema>;

export function getAutomationBlock(type: string) {
  return automationBlockCatalog.find((block) => block.type === type);
}

function hasTrigger(flow: AutomationFlowDefinition) {
  return flow.nodes.some((node) => getAutomationBlock(node.type)?.category === "trigger");
}

export function validateAutomationFlowForStatus(
  flow: AutomationFlowDefinition,
  status: "enabled" | "disabled"
): { success: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const node of flow.nodes) {
    if (ids.has(node.id)) {
      errors.push(`O bloco ${node.id} esta duplicado.`);
    }
    ids.add(node.id);

    const block = getAutomationBlock(node.type);
    if (!block) {
      errors.push(`O bloco ${node.type} nao existe.`);
      continue;
    }

    if (status === "enabled" && block.support !== "supported") {
      errors.push(`O bloco ${block.label} ainda nao pode ser usado em fluxos ativos.`);
    }
  }

  if (!hasTrigger(flow)) {
    errors.push("O fluxo precisa ter pelo menos um gatilho.");
  }

  const edgeIds = new Set<string>();

  for (const edge of flow.edges) {
    if (edgeIds.has(edge.id)) {
      errors.push(`A conexao ${edge.id} esta duplicada.`);
    }
    edgeIds.add(edge.id);

    if (!ids.has(edge.source)) {
      errors.push(`A conexao ${edge.id} sai de um bloco inexistente.`);
    }
    if (!ids.has(edge.target)) {
      errors.push(`A conexao ${edge.id} aponta para um bloco inexistente.`);
    }
  }

  return { success: errors.length === 0, errors };
}
