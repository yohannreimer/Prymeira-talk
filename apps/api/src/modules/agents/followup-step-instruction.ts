import type { ConversationFollowupRecord } from "../followups/conversation-followups.service.js";

const qualificationInstruction =
  "Retome somente a qualificação técnica ou cadastral explicitamente pendente ou uma avaliação do cliente ainda aguardada após explicação ou catálogo que ele pediu e recebeu. Neste último caso, confirme de forma breve se conseguiu consultar o catálogo e se deseja seguir com o pedido; não cobre um dado técnico que ele ainda não escolheu. Sem inferir medida, espessura, especificação, disponibilidade ou condição comercial. Esta etapa não é acompanhamento de proposta.";

export function resolveFollowupStepInstruction(input: {
  kind: ConversationFollowupRecord["kind"];
  configuredInstruction: string;
}) {
  return input.kind === "qualification"
    ? qualificationInstruction
    : input.configuredInstruction;
}
