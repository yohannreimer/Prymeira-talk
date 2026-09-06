import { chunkKnowledgeContent, type KnowledgeChunk } from "./knowledge-chunking.js";
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
};

export type SelectedKnowledgeSource = {
  id: string;
  title: string;
  content: string;
  category: string | null;
  score: number;
  reasons: KnowledgeRetrievalReason[];
  includedAs: "full_document" | "chunk";
  chunkIndex: number;
  start: number;
  end: number;
};

export type KnowledgeRetrievalReason =
  | "category_match"
  | "keyword_match"
  | "title_match"
  | "content_overlap";

export type KnowledgeRetrievalResult = {
  selected: SelectedKnowledgeSource[];
  total: number;
  evaluatedChunks: number;
};

const MAX_SELECTED_SOURCES = 3;
const MAX_SELECTED_CHUNKS = 6;
const MAX_SELECTED_KNOWLEDGE_CHARS = 12_000;
const SOURCE_DEPENDENT_REQUEST =
  /\?|^\s*(?:qual|quais|quanto|quando|onde|como|tem|t[eê]m|voc[eê]s?\s+(?:tem|t[eê]m|trabalha|trabalham|vende|vendem|oferece|oferecem)|consegue|conseguem|pode|podem|confirma|confirmam|garante|garantem|informe|informem|me\s+(?:diga|digam|passe|passem)|manda|mandem|preciso\s+saber|gostaria\s+de\s+saber)\b/i;

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

  let evaluatedChunkCount = 0;
  const rankedChunks = input.sources
    .flatMap((source, sourceIndex) => {
      const chunks = chunkKnowledgeContent(source.content ?? "");
      evaluatedChunkCount += chunks.length;
      const scoredChunks = chunks.flatMap((chunk) => {
        const scored = scoreChunk(source, sourceIndex, chunk, chunks.length, retrievalQuery);
        return scored ? [scored] : [];
      });

      const contentMatches = scoredChunks.filter((chunk) =>
        chunk.reasons.includes("content_overlap")
      );
      return contentMatches.length > 0 ? contentMatches : scoredChunks.slice(0, 1);
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.sourceIndex - right.sourceIndex ||
        left.chunkIndex - right.chunkIndex
    );

  const selected: SelectedKnowledgeSource[] = [];
  const sourceIds = new Set<string>();
  let selectedCharacters = 0;

  for (const candidate of rankedChunks) {
    if (selected.length >= MAX_SELECTED_CHUNKS) {
      break;
    }
    if (!sourceIds.has(candidate.id) && sourceIds.size >= MAX_SELECTED_SOURCES) {
      continue;
    }
    if (selectedCharacters + candidate.content.length > MAX_SELECTED_KNOWLEDGE_CHARS) {
      continue;
    }
    if (
      selected.some(
        (item) => item.id === candidate.id && overlapRatio(item, candidate) > 0.65
      )
    ) {
      continue;
    }

    const { sourceIndex: _sourceIndex, ...selectedCandidate } = candidate;
    selected.push(selectedCandidate);
    sourceIds.add(candidate.id);
    selectedCharacters += candidate.content.length;
  }

  return {
    selected,
    total: input.sources.length,
    evaluatedChunks: evaluatedChunkCount
  };
}

export function isDocumentDependentQuestion(
  value: string | null | undefined,
  taxonomy: AgentKnowledgeTaxonomyEntry[] = DEFAULT_KNOWLEDGE_TAXONOMY
) {
  const rawValue = value ?? "";
  if (!SOURCE_DEPENDENT_REQUEST.test(rawValue)) {
    return false;
  }

  const categories = detectCategories(normalize(rawValue), taxonomy);
  return taxonomy.some((entry) => entry.requiresSource && categories.has(entry.key));
}

type ScoredKnowledgeSource = SelectedKnowledgeSource & {
  sourceIndex: number;
};

type RetrievalQuery = {
  primary: string;
  history: string;
  primaryTokens: Set<string>;
  historyTokens: Set<string>;
  primaryCategories: Set<string>;
  activeCategories: Set<string>;
  taxonomy: AgentKnowledgeTaxonomyEntry[];
};

function scoreChunk(
  source: KnowledgeRetrievalSource,
  sourceIndex: number,
  chunk: KnowledgeChunk,
  sourceChunkCount: number,
  query: RetrievalQuery
): ScoredKnowledgeSource | null {
  const metadata = readMetadata(source.metadata);
  const category = normalizeCategory(metadata.category, query.taxonomy);
  const keywords = [...metadata.keywords, ...metadata.aliases].map(normalize).filter(Boolean);
  const title = normalize(source.title);
  const content = chunk.content;
  const normalizedContent = normalize(content);
  const reasons = new Set<KnowledgeRetrievalReason>();
  const allowHistorySignal =
    query.primaryCategories.size === 0 || Boolean(category && query.activeCategories.has(category));
  let score = 0;

  if (category && query.activeCategories.has(category)) {
    score += 50;
    reasons.add("category_match");
  }

  const primaryKeywordMatches = keywords.filter((keyword) =>
    hasKeywordMatch(keyword, query.primary, query.primaryTokens)
  );
  const historyKeywordMatches = allowHistorySignal
    ? keywords.filter((keyword) =>
        hasKeywordMatch(keyword, query.history, query.historyTokens)
      )
    : [];
  const keywordMatches = Array.from(new Set([...primaryKeywordMatches, ...historyKeywordMatches]));
  if (keywordMatches.length > 0) {
    score += Math.min(30, primaryKeywordMatches.length * 15 + historyKeywordMatches.length * 4);
    reasons.add("keyword_match");
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
  }

  if (reasons.size === 0) {
    return null;
  }

  return {
    id: source.id,
    title: source.title,
    content,
    category,
    score,
    reasons: Array.from(reasons),
    includedAs: sourceChunkCount === 1 ? "full_document" : "chunk",
    chunkIndex: chunk.index,
    start: chunk.start,
    end: chunk.end,
    sourceIndex
  };
}

function overlapRatio(
  left: Pick<SelectedKnowledgeSource, "start" | "end">,
  right: Pick<SelectedKnowledgeSource, "start" | "end">
) {
  const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
  const shortest = Math.min(left.end - left.start, right.end - right.start);
  return shortest > 0 ? overlap / shortest : 0;
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

function hasKeywordMatch(keyword: string, query: string, queryTokens: Set<string>) {
  if (query.includes(keyword)) return true;
  const keywordTokens = toTokenSet(keyword);
  return keywordTokens.size > 0 && Array.from(keywordTokens).every((token) => queryTokens.has(token));
}

function toTokenSet(value: string) {
  return new Set(
    value
      .split(/[^a-z0-9]+/g)
      .map(toComparableToken)
      .filter((token) => token.length >= 3)
      .filter((token) => /[a-z]/.test(token))
      .filter((token) => !STOP_WORDS.has(token))
  );
}

function toComparableToken(token: string) {
  if (token.length > 5 && token.endsWith("ais")) return `${token.slice(0, -3)}al`;
  if (token.length > 5 && token.endsWith("eis")) return `${token.slice(0, -3)}el`;
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
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
