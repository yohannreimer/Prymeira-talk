export type KnowledgeRetrievalMetadata = {
  category?: string | null;
  keywords?: string[] | string | null;
};

export type KnowledgeRetrievalSource = {
  id: string;
  title: string;
  content: string | null;
  metadata?: KnowledgeRetrievalMetadata | Record<string, unknown> | null;
};

export type SelectedKnowledgeSource = {
  id: string;
  title: string;
  content: string;
  category: string | null;
  score: number;
  reasons: KnowledgeRetrievalReason[];
  includedAs: "full_document" | "snippet";
};

export type KnowledgeRetrievalReason =
  | "category_match"
  | "keyword_match"
  | "title_match"
  | "content_overlap";

export type KnowledgeRetrievalResult = {
  selected: SelectedKnowledgeSource[];
  total: number;
};

const MAX_SELECTED_SOURCES = 4;
const MAX_FULL_DOCUMENT_LENGTH = 18_000;

const CATEGORY_ALIASES: Record<string, string[]> = {
  precos: [
    "preco",
    "precos",
    "valor",
    "valores",
    "quanto custa",
    "custa",
    "custo",
    "custos",
    "plano",
    "planos",
    "mensalidade",
    "assinatura",
    "orcamento",
    "desconto",
    "taxa",
    "pagamento"
  ],
  politicas: [
    "politica",
    "politicas",
    "regra",
    "regras",
    "termo",
    "termos",
    "cancelamento",
    "cancelar",
    "reembolso",
    "devolucao",
    "troca",
    "garantia",
    "privacidade",
    "prazo",
    "contrato"
  ],
  produto: [
    "produto",
    "produtos",
    "servico",
    "servicos",
    "funcionalidade",
    "funcionalidades",
    "recurso",
    "recursos",
    "integracao",
    "integracoes",
    "oferece",
    "funciona",
    "beneficio",
    "beneficios"
  ],
  onboarding: [
    "onboarding",
    "implantacao",
    "implementar",
    "configurar",
    "configuracao",
    "comecar",
    "inicio",
    "primeiros",
    "passos",
    "treinamento",
    "cadastro",
    "acesso",
    "ativar",
    "setup"
  ]
};

const STOP_WORDS = new Set([
  "ainda",
  "agora",
  "aqui",
  "aquela",
  "aquele",
  "aquilo",
  "assim",
  "atendente",
  "boa",
  "cada",
  "cliente",
  "como",
  "com",
  "daquele",
  "dessa",
  "desse",
  "deste",
  "data",
  "dele",
  "dela",
  "eles",
  "elas",
  "esta",
  "este",
  "essa",
  "esse",
  "fala",
  "favor",
  "hoje",
  "isso",
  "mais",
  "mesmo",
  "minha",
  "muito",
  "nota",
  "obrigado",
  "para",
  "pela",
  "pelo",
  "pode",
  "pois",
  "qual",
  "quando",
  "queria",
  "sem",
  "sobre",
  "sua",
  "tarde",
  "tudo",
  "voce",
  "voces"
]);

export function selectRelevantKnowledge(input: {
  latestMessage: string | null | undefined;
  conversationHistory: string | null | undefined;
  instruction: string | null | undefined;
  sources: KnowledgeRetrievalSource[];
}): KnowledgeRetrievalResult {
  const query = normalize(
    [input.instruction, input.conversationHistory, input.latestMessage].filter(Boolean).join("\n")
  );
  const queryTokens = toTokenSet(query);
  const detectedCategories = detectCategories(query);

  const rankedSources = input.sources
    .map((source, index) => scoreSource(source, index, query, queryTokens, detectedCategories))
    .filter((source): source is ScoredKnowledgeSource => source !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_SELECTED_SOURCES)
    .map(({ index: _index, ...source }) => source);

  return {
    selected: rankedSources,
    total: input.sources.length
  };
}

type ScoredKnowledgeSource = SelectedKnowledgeSource & {
  index: number;
};

function scoreSource(
  source: KnowledgeRetrievalSource,
  index: number,
  query: string,
  queryTokens: Set<string>,
  detectedCategories: Set<string>
): ScoredKnowledgeSource | null {
  const metadata = readMetadata(source.metadata);
  const category = normalizeCategory(metadata.category);
  const keywords = metadata.keywords.map(normalize).filter(Boolean);
  const title = normalize(source.title);
  const content = source.content ?? "";
  const normalizedContent = normalize(content);
  const reasons = new Set<KnowledgeRetrievalReason>();
  let score = 0;

  if (category && detectedCategories.has(category)) {
    score += 50;
    reasons.add("category_match");
  }

  const keywordMatches = keywords.filter((keyword) => query.includes(keyword));
  if (keywordMatches.length > 0) {
    score += Math.min(30, keywordMatches.length * 15);
    reasons.add("keyword_match");
  }

  if (hasTitleMatch(title, queryTokens, detectedCategories)) {
    score += 18;
    reasons.add("title_match");
  }

  const overlapCount = countContentOverlap(normalizedContent, queryTokens);
  if (overlapCount >= 2) {
    score += Math.min(20, overlapCount * 4);
    reasons.add("content_overlap");
  }

  if (reasons.size === 0) {
    return null;
  }

  const includedAs =
    content.length <= MAX_FULL_DOCUMENT_LENGTH ? "full_document" : ("snippet" as const);

  return {
    id: source.id,
    title: source.title,
    content:
      includedAs === "full_document" ? content : content.slice(0, MAX_FULL_DOCUMENT_LENGTH),
    category,
    score,
    reasons: Array.from(reasons),
    includedAs,
    index
  };
}

function detectCategories(query: string) {
  const categories = new Set<string>();

  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.some((alias) => query.includes(alias))) {
      categories.add(category);
    }
  }

  return categories;
}

function hasTitleMatch(title: string, queryTokens: Set<string>, detectedCategories: Set<string>) {
  const titleTokens = toTokenSet(title);
  const hasTokenMatch = Array.from(titleTokens).some((token) => queryTokens.has(token));
  const hasCategoryTitleMatch = Array.from(detectedCategories).some((category) =>
    CATEGORY_ALIASES[category]?.some((alias) => title.includes(alias))
  );

  return hasTokenMatch || hasCategoryTitleMatch;
}

function countContentOverlap(content: string, queryTokens: Set<string>) {
  const contentTokens = toTokenSet(content);
  let count = 0;

  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      count += 1;
    }
  }

  return count;
}

function toTokenSet(value: string) {
  return new Set(
    value
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 4)
      .filter((token) => !/\d/.test(token))
      .filter((token) => !STOP_WORDS.has(token))
  );
}

function readMetadata(value: KnowledgeRetrievalSource["metadata"]): {
  category: string | null;
  keywords: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { category: null, keywords: [] };
  }

  const category = typeof value.category === "string" ? value.category : null;
  const keywords = Array.isArray(value.keywords)
    ? value.keywords.filter((keyword): keyword is string => typeof keyword === "string")
    : typeof value.keywords === "string"
      ? value.keywords.split(",")
      : [];

  return { category, keywords };
}

function normalizeCategory(value: string | null) {
  const normalized = normalize(value ?? "");

  if (normalized in CATEGORY_ALIASES) {
    return normalized;
  }

  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.includes(normalized)) {
      return category;
    }
  }

  return normalized || null;
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}
