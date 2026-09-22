import type { ConversationFollowupRecord } from "../followups/conversation-followups.service.js";

const qualificationInstruction =
  "Retome somente a qualificação técnica ou cadastral explicitamente pendente. Peça apenas os dados que faltam, sem inferir medida, espessura, especificação, disponibilidade ou condição comercial. Esta etapa não é acompanhamento de proposta.";

export function resolveFollowupStepInstruction(input: {
  kind: ConversationFollowupRecord["kind"];
  configuredInstruction: string;
}) {
  return input.kind === "qualification"
    ? qualificationInstruction
    : input.configuredInstruction;
}
