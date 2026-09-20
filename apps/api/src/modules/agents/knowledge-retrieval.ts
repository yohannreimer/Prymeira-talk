import type { AgentKnowledgeTaxonomyEntry } from "@prymeira-talk/shared";
import { DEFAULT_KNOWLEDGE_TAXONOMY } from "./knowledge-taxonomy.js";

export type KnowledgeRetrievalMetadata = {
  category?: string | null;
  keywords?: string[] | string | null;
  aliases?: string[] | string | null;
};

export type KnowledgeRetrievalSource = {
  id: string;
  title: string;
  content: string | null;
  metadata?: KnowledgeRetrievalMetadata | Record<string, unknown> | null;
  fileUrl?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
};

export type SelectedKnowledgeSource = {
  id: string;
  title: string;
  content: string;
  category: string | null;
  score: number;
  reasons: KnowledgeRetrievalReason[];
  includedAs: "full_document" | "snippet";
  fileUrl: string | null;
  fileName: string | null;
  mimeType: string | null;
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

const STOP_WORDS = new Set([
  "ainda", "agora", "aqui", "aquela", "aquele", "aquilo", "assim", "atendente",
  "boa", "cada", "cliente", "como", "com", "daquele", "dessa", "desse", "deste",
  "data", "dele", "dela", "eles", "elas", "esta", "este", "essa", "esse", "fala",
  "favor", "hoje", "isso", "mais", "mesmo", "minha", "muito", "nota", "obrigado",
  "para", "pela", "pelo", "pode", "pois", "qual", "quando", "queria", "sem", "sobre",
  "sua", "tarde", "tudo", "voce", "voces"
]);

export function selectRelevantKnowledge(input: {
  latestMessage: string | null | undefined;
  conversationHistory: string | null | undefined;
  instruction: string | null | undefined;
  taxonomy?: AgentKnowledgeTaxonomyEntry[];
  sources: KnowledgeRetrievalSource[];
}): KnowledgeRetrievalResult {
  const taxonomy = input.taxonomy ?? DEFAULT_KNOWLEDGE_TAXONOMY;
  const primaryQuery = normalize([input.instruction, input.latestMessage].filter(Boolean).join("\n"));
  const historyQuery = normalize(input.conversationHistory ?? "");
  const primaryCategories = detectCategories(primaryQuery, taxonomy);
  const historyCategories = detectCategories(historyQuery, taxonomy);
  const retrievalQuery: RetrievalQuery = {
    primary: primaryQuery,
    history: historyQuery,
    primaryTokens: toTokenSet(primaryQuery),
    historyTokens: toTokenSet(historyQuery),
    primaryCategories,
    activeCategories: primaryCategories.size > 0 ? primaryCategories : historyCategories,
    taxonomy
  };

  const rankedSources = input.sources
    .map((source, index) => scoreSource(source, index, retrievalQuery))
    .filter((source): source is ScoredKnowledgeSource => source !== null)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_SELECTED_SOURCES)
    .map(({ index: _index, ...source }) => source);

  return { selected: rankedSources, total: input.sources.length };
}

export function isDocumentDependentQuestion(
  value: string | null | undefined,
  taxonomy: AgentKnowledgeTaxonomyEntry[] = DEFAULT_KNOWLEDGE_TAXONOMY
) {
  const categories = detectCategories(normalize(value ?? ""), taxonomy);
  return taxonomy.some((entry) => entry.requiresSource && categories.has(entry.key));
}

type ScoredKnowledgeSource = SelectedKnowledgeSource & { index: number };

type RetrievalQuery = {
  primary: string;
  history: string;
  primaryTokens: Set<string>;
  historyTokens: Set<string>;
  primaryCategories: Set<string>;
  activeCategories: Set<string>;
  taxonomy: AgentKnowledgeTaxonomyEntry[];
};

function scoreSource(
  source: KnowledgeRetrievalSource,
  index: number,
  query: RetrievalQuery
): ScoredKnowledgeSource | null {
  const metadata = readMetadata(source.metadata);
  const category = normalizeCategory(metadata.category, query.taxonomy);
  const keywords = [...metadata.keywords, ...metadata.aliases].map(normalize).filter(Boolean);
  const title = normalize(source.title);
  const content = source.content ?? "";
  const normalizedContent = normalize(content);
  const reasons = new Set<KnowledgeRetrievalReason>();
  const evidenceTerms = new Set<string>();
  const allowHistorySignal =
    query.primaryCategories.size === 0 || Boolean(category && query.activeCategories.has(category));
  let score = 0;

  const taxonomyEntry = category
    ? query.taxonomy.find((entry) => entry.key === category)
    : undefined;

  if (category && query.activeCategories.has(category)) {
    score += 50;
    reasons.add("category_match");
    for (const alias of taxonomyEntry?.aliases ?? []) {
      evidenceTerms.add(normalize(alias));
    }
  }

  const primaryKeywordMatches = keywords.filter((keyword) => query.primary.includes(keyword));
  const historyKeywordMatches = allowHistorySignal
    ? keywords.filter((keyword) => query.history.includes(keyword))
    : [];
  const keywordMatches = Array.from(new Set([...primaryKeywordMatches, ...historyKeywordMatches]));
  if (keywordMatches.length > 0) {
    score += Math.min(30, primaryKeywordMatches.length * 15 + historyKeywordMatches.length * 4);
    reasons.add("keyword_match");
    for (const keyword of keywordMatches) evidenceTerms.add(keyword);
  }

  if (hasTitleMatch(title, query.primaryTokens, query.activeCategories, query.taxonomy)) {
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
      if (normalizedContent.includes(token)) evidenceTerms.add(token);
    }
    if (allowHistorySignal) {
      for (const token of query.historyTokens) {
        if (normalizedContent.includes(token)) evidenceTerms.add(token);
      }
    }
  }

  if (reasons.size === 0) return null;

  const includedAs = content.length <= MAX_FULL_DOCUMENT_LENGTH ? "full_document" : ("snippet" as const);
  return {
    id: source.id,
    title: source.title,
    content: selectContentForProvider(content, includedAs, Array.from(evidenceTerms)),
    category,
    score,
    reasons: Array.from(reasons),
    includedAs,
    fileUrl: source.fileUrl?.trim() || null,
    fileName: source.fileName?.trim() || null,
    mimeType: source.mimeType?.trim() || null,
    index
  };
}

function selectContentForProvider(
  content: string,
  includedAs: SelectedKnowledgeSource["includedAs"],
  evidenceTerms: string[]
) {
  if (includedAs === "full_document") return content;
  const start = findSnippetStart(content, evidenceTerms);
  return content.slice(start, start + MAX_FULL_DOCUMENT_LENGTH);
}

function findSnippetStart(content: string, evidenceTerms: string[]) {
  const normalizedContent = normalize(content);
  const terms = evidenceTerms.map(normalize).filter((term) => term.length >= 4).sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const index = normalizedContent.indexOf(term);
    if (index >= 0) return Math.max(0, index - 600);
  }
  return 0;
}

function detectCategories(query: string, taxonomy: AgentKnowledgeTaxonomyEntry[]) {
  const categories = new Set<string>();
  for (const entry of taxonomy) {
    if (entry.aliases.map(normalize).some((alias) => query.includes(alias))) categories.add(entry.key);
  }
  return categories;
}

function hasTitleMatch(
  title: string,
  queryTokens: Set<string>,
  detectedCategories: Set<string>,
  taxonomy: AgentKnowledgeTaxonomyEntry[]
) {
  const titleTokens = toTokenSet(title);
  const hasTokenMatch = Array.from(titleTokens).some((token) => queryTokens.has(token));
  const hasCategoryTitleMatch = taxonomy
    .filter((entry) => detectedCategories.has(entry.key))
    .some((entry) => entry.aliases.map(normalize).some((alias) => title.includes(alias)));
  return hasTokenMatch || hasCategoryTitleMatch;
}

function countContentOverlap(content: string, queryTokens: Set<string>) {
  const contentTokens = toTokenSet(content);
  let count = 0;
  for (const token of queryTokens) if (contentTokens.has(token)) count += 1;
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
  aliases: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { category: null, keywords: [], aliases: [] };
  }
  return {
    category: typeof value.category === "string" ? value.category : null,
    keywords: readStringList(value.keywords),
    aliases: readStringList(value.aliases)
  };
}

function readStringList(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? value.split(",") : [];
}

function normalizeCategory(value: string | null, taxonomy: AgentKnowledgeTaxonomyEntry[]) {
  const normalizedValue = normalize(value ?? "");
  const normalizedKey = normalizedValue.replace(/[^a-z0-9]+/g, "_");
  const direct = taxonomy.find((entry) => entry.key === normalizedKey);
  if (direct) return direct.key;
  const byAlias = taxonomy.find((entry) => entry.aliases.map(normalize).includes(normalizedValue));
  return byAlias?.key ?? (normalizedKey || null);
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}
