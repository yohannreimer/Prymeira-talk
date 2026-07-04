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

const MAX_SELECTED_SOURCES = 3;
const MAX_FULL_DOCUMENT_LENGTH = 8_000;

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
  const primaryQuery = normalize([input.instruction, input.latestMessage].filter(Boolean).join("\n"));
  const historyQuery = normalize(input.conversationHistory ?? "");
  const primaryCategories = detectCategories(primaryQuery);
  const historyCategories = detectCategories(historyQuery);
  const retrievalQuery: RetrievalQuery = {
    primary: primaryQuery,
    history: historyQuery,
    primaryTokens: toTokenSet(primaryQuery),
    historyTokens: toTokenSet(historyQuery),
    primaryCategories,
    activeCategories: primaryCategories.size > 0 ? primaryCategories : historyCategories
  };

  const rankedSources = input.sources
    .map((source, index) => scoreSource(source, index, retrievalQuery))
    .filter((source): source is ScoredKnowledgeSource => source !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_SELECTED_SOURCES)
    .map(({ index: _index, ...source }) => source);

  return {
    selected: rankedSources,
    total: input.sources.length
  };
}

export function isDocumentDependentQuestion(value: string | null | undefined) {
  const categories = detectCategories(normalize(value ?? ""));
  return Array.from(categories).some((category) => category === "precos" || category === "politicas");
}

type ScoredKnowledgeSource = SelectedKnowledgeSource & {
  index: number;
};

type RetrievalQuery = {
  primary: string;
  history: string;
  primaryTokens: Set<string>;
  historyTokens: Set<string>;
  primaryCategories: Set<string>;
  activeCategories: Set<string>;
};

function scoreSource(
  source: KnowledgeRetrievalSource,
  index: number,
  query: RetrievalQuery
): ScoredKnowledgeSource | null {
  const metadata = readMetadata(source.metadata);
  const category = normalizeCategory(metadata.category);
  const keywords = metadata.keywords.map(normalize).filter(Boolean);
  const title = normalize(source.title);
  const content = source.content ?? "";
  const normalizedContent = normalize(content);
  const reasons = new Set<KnowledgeRetrievalReason>();
  const evidenceTerms = new Set<string>();
  const allowHistorySignal =
    query.primaryCategories.size === 0 || Boolean(category && query.activeCategories.has(category));
  let score = 0;

  if (category && query.activeCategories.has(category)) {
    score += 50;
    reasons.add("category_match");
    for (const alias of CATEGORY_ALIASES[category] ?? []) {
      evidenceTerms.add(alias);
    }
  }

  const primaryKeywordMatches = keywords.filter((keyword) => query.primary.includes(keyword));
  const historyKeywordMatches = allowHistorySignal
    ? keywords.filter((keyword) => query.history.includes(keyword))
    : [];
  const keywordMatches = Array.from(new Set([...primaryKeywordMatches, ...historyKeywordMatches]));
  if (keywordMatches.length > 0) {
    score += Math.min(
      30,
      primaryKeywordMatches.length * 15 + historyKeywordMatches.length * 4
    );
    reasons.add("keyword_match");
    for (const keyword of keywordMatches) {
      evidenceTerms.add(keyword);
    }
  }

  if (hasTitleMatch(title, query.primaryTokens, query.activeCategories)) {
    score += 18;
    reasons.add("title_match");
  }

  const primaryOverlapCount = countContentOverlap(normalizedContent, query.primaryTokens);
  const historyOverlapCount = allowHistorySignal
    ? countContentOverlap(normalizedContent, query.historyTokens)
    : 0;
  const overlapCount = primaryOverlapCount + Math.min(2, historyOverlapCount);
  if (overlapCount >= 2) {
    score += Math.min(20, overlapCount * 4);
    reasons.add("content_overlap");
    for (const token of query.primaryTokens) {
      if (normalizedContent.includes(token)) {
        evidenceTerms.add(token);
      }
    }
    if (allowHistorySignal) {
      for (const token of query.historyTokens) {
        if (normalizedContent.includes(token)) {
          evidenceTerms.add(token);
        }
      }
    }
  }

  if (reasons.size === 0) {
    return null;
  }

  const includedAs =
    content.length <= MAX_FULL_DOCUMENT_LENGTH ? "full_document" : ("snippet" as const);

  return {
    id: source.id,
    title: source.title,
    content: selectContentForProvider(content, includedAs, Array.from(evidenceTerms)),
    category,
    score,
    reasons: Array.from(reasons),
    includedAs,
    index
  };
}

function selectContentForProvider(
  content: string,
  includedAs: SelectedKnowledgeSource["includedAs"],
  evidenceTerms: string[]
) {
  if (includedAs === "full_document") {
    return content;
  }

  const start = findSnippetStart(content, evidenceTerms);
  return content.slice(start, start + MAX_FULL_DOCUMENT_LENGTH);
}

function findSnippetStart(content: string, evidenceTerms: string[]) {
  const normalizedContent = normalize(content);
  const terms = evidenceTerms
    .map(normalize)
    .filter((term) => term.length >= 4)
    .sort((left, right) => right.length - left.length);

  for (const term of terms) {
    const index = normalizedContent.indexOf(term);
    if (index >= 0) {
      return Math.max(0, index - 600);
    }
  }

  return 0;
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
