import {
  agentKnowledgeTaxonomyEntrySchema,
  type AgentKnowledgeTaxonomyEntry
} from "@prymeira-talk/shared";

export const DEFAULT_KNOWLEDGE_TAXONOMY: AgentKnowledgeTaxonomyEntry[] = [
  { key: "precos", label: "Preços", aliases: ["preço", "preços", "valor", "valores", "quanto custa", "custa", "custo", "custos", "plano", "planos", "mensalidade", "assinatura", "orçamento", "desconto", "taxa", "pagamento"], requiresSource: true },
  { key: "politicas", label: "Políticas", aliases: ["política", "políticas", "regra", "regras", "termo", "termos", "cancelamento", "cancelar", "reembolso", "devolução", "troca", "garantia", "privacidade", "prazo", "contrato"], requiresSource: true },
  { key: "produto", label: "Produto", aliases: ["produto", "produtos", "serviço", "serviços", "funcionalidade", "funcionalidades", "recurso", "recursos", "integração", "integrações", "oferece", "funciona", "benefício", "benefícios"], requiresSource: false },
  { key: "onboarding", label: "Onboarding", aliases: ["onboarding", "implantação", "implementar", "configurar", "configuração", "começar", "início", "primeiros passos", "treinamento", "cadastro", "acesso", "ativar", "setup"], requiresSource: false },
  { key: "faq", label: "FAQ", aliases: ["dúvida", "pergunta"], requiresSource: false },
  { key: "comercial", label: "Comercial", aliases: ["proposta", "vendedor", "condição"], requiresSource: false },
  { key: "suporte", label: "Suporte", aliases: ["erro", "problema", "ajuda"], requiresSource: false },
  { key: "outro", label: "Outro", aliases: ["informação"], requiresSource: false }
];

export function readKnowledgeTaxonomy(value: unknown): AgentKnowledgeTaxonomyEntry[] {
  if (!isRecord(value) || !Array.isArray(value.knowledgeTaxonomy)) {
    return DEFAULT_KNOWLEDGE_TAXONOMY;
  }

  const parsed = agentKnowledgeTaxonomyEntrySchema.array().safeParse(value.knowledgeTaxonomy);
  return parsed.success && parsed.data.length > 0 ? parsed.data : DEFAULT_KNOWLEDGE_TAXONOMY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
