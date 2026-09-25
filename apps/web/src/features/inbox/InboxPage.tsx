import { useTalkAuth } from "../../app/auth";
import type { ChannelDto, ConversationDto, MessageDto, RealtimeEvent, TagDto } from "@prymeira-talk/shared";
import { Bot, CheckCircle2, History, MessageSquare, Plus, RotateCcw, StickyNote, TriangleAlert, UserCheck, UserRound, X } from "lucide-react";
import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiCreateQuickReply,
  apiCreateConversationMessage,
  apiCreateCrmLead,
  apiDeleteQuickReply,
  apiGetConversationContext,
  apiGetConversationMessages,
  apiGetConversations,
  apiGetChannels,
  apiGetCurrentTalkUser,
  apiGetLeadComposerDraft,
  apiGetTags,
  apiGetQuickReplies,
  apiMarkConversationRead,
  apiResetConversation,
  apiRunConversationAction,
  apiUpdateQuickReply,
  apiUpdateContact,
  type ContactContextDto,
  type ConversationActionBody,
  type ConversationActionResultDto,
  type QuickReplyDto
} from "../../app/api";
import {
  contactDisplayName,
  filterConversationsByChannel,
  filterConversationsByQueue,
  getConversationControlBadge,
  type ConversationQueueFilter,
  getChannelFilterOptions
} from "./conversation-display";
import { QuickRepliesPopover } from "./QuickRepliesPopover";
import { useRealtimeEvents } from "./useRealtimeEvents";
import { AssistantPanel } from './AssistantPanel';
import { useHandoffBrief } from './useHandoffBrief';
import { ContactIdentityCard } from './ContactIdentityCard';
import { ContactAvatar, ContactPhotoProvider } from './ContactAvatar';
import { InboxMedia, mediaCaption } from './InboxMedia';
import { RichDraft, type RichDraftHandle } from './RichDraft';
import { VoiceRecorder } from './VoiceRecorder';
import { mergeLeadComposerDraft, takeLeadDraftRequest } from './lead-composer';
import { WhatsappText } from './whatsapp-text';
import { useAssistantConversation } from './useAssistantConversation';
import { canCopySuggestion, draftNeedsReview, suggestionOrigin, type ComposerSuggestionOrigin } from './assistant-composer-state';
import { apiSendAssistantSuggestion } from '../../app/api';
import type { AssistantSuggestionDto } from '@prymeira-talk/shared';

function formatTime(value: string | null) {
  if (!value) return "Sem mensagens";

  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

const CONVERSATION_PAGE_SIZE = 50;

function readConversationIdFromUrl() {
  if (typeof window === "undefined") return null;

  const value = new URLSearchParams(window.location.search).get("conversation");
  return value && value.trim().length > 0 ? value : null;
}

function formatMessageTime(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function statusLabel(status: ConversationDto["status"]) {
  const labels: Record<ConversationDto["status"], string> = {
    open: "Aberta",
    pending: "Pendente",
    closed: "Fechada"
  };

  return labels[status];
}

export function aiControlLabel(
  conversation: Pick<ConversationDto, "aiControlStatus" | "activeAgentName">
) {
  if (conversation.aiControlStatus === "human_controlled") return "Humano no controle";
  if (conversation.activeAgentName) return `IA ativa: ${conversation.activeAgentName}`;
  return "IA liberada";
}

export function aiControlActionLabel(conversation: Pick<ConversationDto, "aiControlStatus">) {
  return conversation.aiControlStatus === "human_controlled" ? "Liberar IA" : "Assumir";
}

export function needsHumanAttention(
  conversation: Pick<ConversationDto, "aiControlStatus" | "activeAgentSessionStatus" | "handoffReason" | "handoffActionCompletedAt">
) {
  if (conversation.handoffActionCompletedAt) return false;
  return (
    conversation.activeAgentSessionStatus === "handoff_requested" ||
    (conversation.aiControlStatus === "human_controlled" && Boolean(conversation.handoffReason))
  );
}

function handoffAnalysisFeedback(analysis: ConversationActionResultDto["improvementAnalysis"]): string {
  if (analysis?.created) return "A resposta gerou um aprimoramento pendente de revisão em Agentes.";
  switch (analysis?.reason) {
    case "already_observed": return "Essa resposta já foi analisada. Confira os aprimoramentos em Agentes.";
    case "analysis_failed": return "A análise falhou. Tente analisar novamente.";
    case "analysis_unavailable":
    case "detector_unavailable": return "A análise está indisponível.";
    case "no_human_reply": return "Ainda não há resposta humana para analisar nesta conversa.";
    case "no_handoff_run": return "Não foi possível localizar o repasse original para analisar a resposta.";
    case "no_customer_request": return "Falta o pedido do cliente no histórico para propor um aprimoramento.";
    default: return "As respostas analisadas não geraram um aprimoramento reutilizável.";
  }
}

export function filterConversationsNeedingHuman(conversations: ConversationDto[], onlyHuman: boolean) {
  if (!onlyHuman) return conversations;
  return conversations.filter((conversation) =>
    conversation.status !== "closed" && needsHumanAttention(conversation)
  );
}

export function canResetConversation(role: "owner" | "manager" | "agent") {
  return role === "owner";
}

function priorityLabel(priority: ConversationDto["priority"]) {
  const labels: Record<ConversationDto["priority"], string> = {
    low: "Baixa",
    normal: "Normal",
    high: "Alta"
  };

  return labels[priority];
}

function formatNoteDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function sortConversationsByRecency(list: ConversationDto[]) {
  return [...list].sort((left, right) => {
    const rightActivity = Date.parse(right.lastMessageAt ?? "") || 0;
    const leftActivity = Date.parse(left.lastMessageAt ?? "") || 0;
    return rightActivity - leftActivity;
  });
}

export function upsertConversation(list: ConversationDto[], conversation: ConversationDto) {
  const index = list.findIndex((item) => item.id === conversation.id);
  if (index === -1) {
    return sortConversationsByRecency([...list, conversation]);
  }

  const next = [...list];
  next[index] = conversation;
  return sortConversationsByRecency(next);
}

export function mergeConversationPage(current: ConversationDto[], page: ConversationDto[]) {
  const seen = new Set(current.map((conversation) => conversation.id));
  return [...current, ...page.filter((conversation) => !seen.has(conversation.id))];
}

export function insertComposerText(value: string, selectionStart: number, selectionEnd: number, text: string) {
  return {
    value: `${value.slice(0, selectionStart)}${text}${value.slice(selectionEnd)}`,
    selectionStart: selectionStart + text.length,
    selectionEnd: selectionStart + text.length
  };
}

export function applyComposerMarker(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  marker: "*" | "_"
) {
  const selectedText = value.slice(selectionStart, selectionEnd);

  if (selectedText.length === 0) {
    return {
      value: `${value.slice(0, selectionStart)}${marker}${marker}${value.slice(selectionEnd)}`,
      selectionStart: selectionStart + marker.length,
      selectionEnd: selectionStart + marker.length
    };
  }

  return {
    value: `${value.slice(0, selectionStart)}${marker}${selectedText}${marker}${value.slice(selectionEnd)}`,
    selectionStart: selectionStart + marker.length,
    selectionEnd: selectionEnd + marker.length
  };
}

const composerEmojis = [
  "😀",
  "😄",
  "😊",
  "😂",
  "😍",
  "😉",
  "😎",
  "🤔",
  "👍",
  "🙏",
  "🙌",
  "👏",
  "✅",
  "🔥",
  "🚀",
  "❤️",
  "💚",
  "⭐",
  "📌",
  "📎",
  "📄",
  "💬",
  "⏰",
  "🎯"
];

function optimisticMessageId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `optimistic-${crypto.randomUUID()}`;
  }

  return `optimistic-${Date.now()}`;
}

function isOptimisticMessage(message: Pick<MessageDto, "id">) {
  return message.id.startsWith("optimistic-");
}

function upsertMessage(list: MessageDto[], message: MessageDto) {
  const existingIndex = list.findIndex((item) => item.id === message.id);

  if (existingIndex >= 0) {
    return list.map((item, index) => (index === existingIndex ? message : item));
  }

  const optimisticIndex = list.findIndex(
    (item) =>
      isOptimisticMessage(item) &&
      item.conversationId === message.conversationId &&
      item.direction === message.direction &&
      item.body === message.body &&
      item.type === message.type &&
      item.status === "pending"
  );

  if (optimisticIndex >= 0) {
    return list.map((item, index) => (index === optimisticIndex ? message : item));
  }

  return [...list, message];
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Não foi possível ler o arquivo."));
    });
    reader.addEventListener("error", () => reject(new Error("Não foi possível ler o arquivo.")));
    reader.readAsDataURL(file);
  });
}

export function messageDisplayText(message: Pick<MessageDto, "body" | "type">) {
  if (message.body?.trim()) {
    return message.body;
  }

  const labels: Record<MessageDto["type"], string> = {
    text: "Mensagem sem texto.",
    image: "Imagem recebida",
    audio: "Áudio recebido",
    file: "Arquivo recebido",
    template: "Template recebido",
    system: "Evento do sistema",
    internal_note: "Nota interna"
  };

  return labels[message.type];
}

export type MessageMediaKind = "image" | "audio" | "file";

function isVideoMediaUrl(mediaUrl: string) {
  return /^data:video\//i.test(mediaUrl) || /\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(mediaUrl);
}

export function outboundStatusLabel(message: Pick<MessageDto, "direction" | "id" | "status">) {
  if (message.direction !== "outbound") return null;
  if (message.status === "pending" && isOptimisticMessage(message)) return "Enviando...";
  if (message.status === "failed") return "Falhou";
  return null;
}

export const metaClosedWindowMessage =
  "A janela de atendimento está fechada. Escolha um template aprovado da Meta para continuar.";

export function metaServiceWindowSendError(
  conversation: Pick<ConversationDto, "channelProvider" | "metaServiceWindowOpen"> | null | undefined
) {
  if (conversation?.channelProvider === "meta_cloud" && conversation.metaServiceWindowOpen === false) {
    return metaClosedWindowMessage;
  }

  return null;
}

export function messageMediaKind(message: Pick<MessageDto, "mediaUrl" | "type">): MessageMediaKind | null {
  if (!message.mediaUrl) {
    return null;
  }

  if (message.type === "image") {
    return "image";
  }

  if (message.type === "audio") {
    return "audio";
  }

  return "file";
}

const audioTranscriptFailure = "Não foi possível transcrever este áudio.";

export function isBrowserPlayableAudio(
  message: Pick<MessageDto, "mediaUrl" | "type">
) {
  if (message.type !== "audio" || !message.mediaUrl) return false;

  return !(
    /^data:audio\/(ogg|opus)(?:[;,])/i.test(message.mediaUrl) ||
    /\.(ogg|opus)(?:\?|#|$)/i.test(message.mediaUrl)
  );
}

export function attachmentReadNotice(message: Pick<MessageDto, 'type' | 'attachmentReadStatus'>) {
  return message.attachmentReadStatus === 'unread' ? 'Anexo não lido pela IA.' : null;
}

export function audioMessageDisplayText(
  message: Pick<MessageDto, "body" | "type" | "attachmentReadStatus">
) {
  const body = message.body?.trim() ?? "";

  if (message.attachmentReadStatus === 'unread') {
    return { kind: 'error' as const, text: 'Áudio não lido pela IA.' };
  }

  if (body === audioTranscriptFailure) {
    return { kind: "error" as const, text: body };
  }

  if (!body || body === "Áudio recebido") {
    return { kind: "processing" as const, text: "Processando áudio..." };
  }

  return { kind: "transcript" as const, text: `Texto do áudio: ${body}` };
}

export function messageMediaLabel(message: Pick<MessageDto, "mediaUrl" | "type">) {
  const kind = messageMediaKind(message);
  const labels: Record<MessageMediaKind, string> = {
    image: "Abrir imagem",
    audio: "Reproduzir áudio",
    file: message.mediaUrl && isVideoMediaUrl(message.mediaUrl) ? "Baixar vídeo" : "Baixar arquivo"
  };

  return kind ? labels[kind] : "Abrir mídia";
}

export function messageMediaFallbackLabel(message: Pick<MessageDto, "mediaUrl" | "type">) {
  const kind = messageMediaKind(message);
  const labels: Record<MessageMediaKind, string> = {
    image: "Abrir imagem",
    audio: "Abrir áudio",
    file: message.mediaUrl && isVideoMediaUrl(message.mediaUrl) ? "Baixar vídeo" : "Baixar arquivo"
  };

  return kind ? labels[kind] : "Abrir mídia";
}

export function InboxPage() {
  const { getToken } = useTalkAuth();
  return <ContactPhotoProvider getToken={getToken}><InboxPageContent /></ContactPhotoProvider>;
}

function InboxPageContent() {
  const { getToken } = useTalkAuth();
  const [token, setToken] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [isLoadingMoreConversations, setIsLoadingMoreConversations] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [messagesConversationId, setMessagesConversationId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [contactContext, setContactContext] = useState<ContactContextDto | null>(null);
  const [isLoadingContext, setIsLoadingContext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [assistantTab, setAssistantTab] = useState<'contact' | 'assistant'>('assistant');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [composerOrigin, setComposerOrigin] = useState<ComposerSuggestionOrigin | null>(null);
  const assistantSendBusy = useRef(false);
  const directSendKeys = useRef(new Map<string, string>());
  const assistantTriggerRef = useRef<HTMLButtonElement | null>(null);
  const assistantCloseRef = useRef<HTMLButtonElement | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [notesHistoryOpen, setNotesHistoryOpen] = useState(false);
  const [tagCatalog, setTagCatalog] = useState<TagDto[]>([]);
  const [selectedTagId, setSelectedTagId] = useState("");
  const [selectedQueueFilter, setSelectedQueueFilter] = useState<ConversationQueueFilter>("active");
  const [selectedChannelFilter, setSelectedChannelFilter] = useState("all");
  const [onlyHumanAttention, setOnlyHumanAttention] = useState(false);
  const [conversationReloadKey, setConversationReloadKey] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const [isRunningAction, setIsRunningAction] = useState(false);
  const [currentRole, setCurrentRole] = useState<"owner" | "manager" | "agent">("agent");
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [crmStatus, setCrmStatus] = useState<string | null>(null);
  const [handoffFeedback, setHandoffFeedback] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReplyDto[]>([]);
  const [isQuickRepliesLoading, setIsQuickRepliesLoading] = useState(false);
  const [quickRepliesError, setQuickRepliesError] = useState<string | null>(null);
  const [newMessagesBelow, setNewMessagesBelow] = useState(0);
  const selectedConversationIdRef = useRef<string | null>(null);
  const selectedQueueFilterRef = useRef<ConversationQueueFilter>("active");
  const conversationsRef = useRef<ConversationDto[]>([]);
  const conversationCursorRef = useRef<string | null>(null);
  const conversationListGenerationRef = useRef(0);
  const loadingMoreConversationsRef = useRef(false);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);
  const pendingThreadScrollRef = useRef<ScrollBehavior | null>(null);
  const userReadingHistoryRef = useRef(false);
  const draftTextAreaRef = useRef<RichDraftHandle | null>(null);
  const [draftFormat, setDraftFormat] = useState({ bold: false, italic: false });
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [acknowledgedHandoffIds, setAcknowledgedHandoffIds] = useState<Set<string>>(() => new Set());
  const getFreshToken = useCallback(async () => {
    const nextToken = await getToken();
    setToken(nextToken);
    return nextToken;
  }, [getToken]);
  const assistant = useAssistantConversation(selectedConversationId, getToken);
  useEffect(() => { setComposerOrigin(null); setDraft(''); setAssistantOpen(false); }, [selectedConversationId]);
  useEffect(() => {
    if (!selectedConversationId) return;
    const cleanUrl = takeLeadDraftRequest(window.location.href, selectedConversationId);
    if (!cleanUrl) return;
    window.history.replaceState(window.history.state, "", cleanUrl);
    let active = true;
    void apiGetLeadComposerDraft(getToken, selectedConversationId)
      .then(result => { if (active) setDraft(current => mergeLeadComposerDraft(current, result?.body)); })
      .catch(err => { if (active) setMessageError(err instanceof Error ? err.message : "Não foi possível carregar o rascunho."); });
    return () => { active = false; };
  }, [getToken, selectedConversationId]);
  useEffect(() => {
    if (!assistantOpen) return;
    assistantCloseRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setAssistantOpen(false); assistantTriggerRef.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [assistantOpen]);

  useEffect(() => {
    let isMounted = true;

    void Promise.all([apiGetTags(getToken), apiGetCurrentTalkUser(getToken)])
      .then(([tags, currentUser]) => {
        if (isMounted) {
          setTagCatalog(tags.filter((tag) => tag.isActive));
          setCurrentRole(currentUser.role);
        }
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  useEffect(() => {
    let isMounted = true;
    void apiGetChannels(getToken)
      .then((nextChannels) => { if (isMounted) setChannels(nextChannels); })
      .catch(() => undefined);
    return () => { isMounted = false; };
  }, [getToken]);

  function isMessageThreadNearBottom() {
    const thread = messageThreadRef.current;

    if (!thread) return true;

    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 96;
  }

  function scrollMessageThreadToBottom(behavior: ScrollBehavior = "smooth") {
    const thread = messageThreadRef.current;

    if (!thread) return;

    thread.scrollTo({ top: thread.scrollHeight, behavior });
    userReadingHistoryRef.current = false;
    setNewMessagesBelow(0);
  }

  function scheduleMessageThreadScroll(behavior: ScrollBehavior = "smooth") {
    pendingThreadScrollRef.current = behavior;
  }

  function applyDraftMarker(marker: "*" | "_") {
    draftTextAreaRef.current?.format(marker === '*' ? 'bold' : 'italic');
  }

  function insertDraftText(text: string) {
    draftTextAreaRef.current?.insertText(text);
  }

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    selectedQueueFilterRef.current = selectedQueueFilter;
  }, [selectedQueueFilter]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    if (!showQuickReplies) return;
    let isMounted = true;
    setIsQuickRepliesLoading(true);
    setQuickRepliesError(null);
    apiGetQuickReplies(getToken)
      .then((nextReplies) => {
        if (isMounted) setQuickReplies(nextReplies);
      })
      .catch((loadError: unknown) => {
        if (isMounted) setQuickRepliesError(loadError instanceof Error ? loadError.message : "Não foi possível carregar mensagens padrão.");
      })
      .finally(() => {
        if (isMounted) setIsQuickRepliesLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, [getToken, showQuickReplies]);

  useEffect(() => {
    let isMounted = true;

    const refreshToken = () => {
      void getToken()
        .then((nextToken) => {
          if (isMounted) {
            setToken(nextToken);
          }
        })
        .catch(() => {
          if (isMounted) {
            setToken(null);
          }
        });
    };

    refreshToken();
    const interval = window.setInterval(refreshToken, 45_000);

    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, [getToken]);

  useEffect(() => {
    let isMounted = true;
    const generation = ++conversationListGenerationRef.current;
    conversationCursorRef.current = null;
    loadingMoreConversationsRef.current = false;
    setConversations([]);
    setHasMoreConversations(false);
    setIsLoadingMoreConversations(false);
    setLoadMoreError(null);

    async function loadConversations() {
      setIsLoading(true);
      setError(null);

      try {
        const nextConversations = await apiGetConversations(getFreshToken, {
          status: selectedQueueFilter === "mine" ? "active" : selectedQueueFilter,
          ...(selectedQueueFilter === "mine" ? { assignee: "me" as const } : {}),
          ...(selectedChannelFilter !== "all" ? { channelId: selectedChannelFilter } : {})
        });

        if (!isMounted || generation !== conversationListGenerationRef.current) return;

        setConversations(nextConversations);
        conversationCursorRef.current = nextConversations.length === CONVERSATION_PAGE_SIZE
          ? nextConversations.at(-1)!.id
          : null;
        setHasMoreConversations(Boolean(conversationCursorRef.current));
        const requestedConversationId = readConversationIdFromUrl();
        setSelectedConversationId((current) =>
          current ??
          (requestedConversationId &&
          nextConversations.some((conversation) => conversation.id === requestedConversationId)
            ? requestedConversationId
            : nextConversations[0]?.id ?? null)
        );
      } catch (loadError) {
        if (!isMounted || generation !== conversationListGenerationRef.current) return;
        setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar conversas.");
      } finally {
        if (isMounted && generation === conversationListGenerationRef.current) {
          setIsLoading(false);
        }
      }
    }

    void loadConversations();

    return () => {
      isMounted = false;
    };
  }, [conversationReloadKey, getFreshToken, selectedQueueFilter, selectedChannelFilter]);

  const loadMoreConversations = useCallback(async () => {
    const cursor = conversationCursorRef.current;
    if (!cursor || loadingMoreConversationsRef.current) return;
    const generation = conversationListGenerationRef.current;
    loadingMoreConversationsRef.current = true;
    setIsLoadingMoreConversations(true);
    setLoadMoreError(null);

    try {
      const page = await apiGetConversations(getFreshToken, {
        status: selectedQueueFilter === "mine" ? "active" : selectedQueueFilter,
        ...(selectedQueueFilter === "mine" ? { assignee: "me" as const } : {}),
        ...(selectedChannelFilter !== "all" ? { channelId: selectedChannelFilter } : {}),
        cursor
      });
      if (generation !== conversationListGenerationRef.current) return;
      setConversations((current) => mergeConversationPage(current, page));
      conversationCursorRef.current = page.length === CONVERSATION_PAGE_SIZE ? page.at(-1)!.id : null;
      setHasMoreConversations(Boolean(conversationCursorRef.current));
    } catch (loadError) {
      if (generation === conversationListGenerationRef.current) {
        setLoadMoreError(loadError instanceof Error ? loadError.message : "Não foi possível carregar mais conversas.");
      }
    } finally {
      if (generation === conversationListGenerationRef.current) {
        loadingMoreConversationsRef.current = false;
        setIsLoadingMoreConversations(false);
      }
    }
  }, [getFreshToken, selectedQueueFilter, selectedChannelFilter]);

  useEffect(() => {
    let isMounted = true;

    async function loadMessages() {
      if (!selectedConversationId) {
        setMessages([]);
        setMessagesConversationId(null);
        return;
      }

      setIsLoadingMessages(true);
      setMessageError(null);

      try {
        const nextMessages = await apiGetConversationMessages(selectedConversationId, getFreshToken);

        if (!isMounted) return;

        setMessages(nextMessages);
        setMessagesConversationId(selectedConversationId);
        setNewMessagesBelow(0);
        userReadingHistoryRef.current = false;
        scheduleMessageThreadScroll("auto");
      } catch (loadError) {
        if (!isMounted) return;
        setMessages([]);
        setMessagesConversationId(selectedConversationId);
        setMessageError(loadError instanceof Error ? loadError.message : "Não foi possível carregar mensagens.");
      } finally {
        if (isMounted) {
          setIsLoadingMessages(false);
        }
      }
    }

    void loadMessages();

    return () => {
      isMounted = false;
    };
  }, [getFreshToken, selectedConversationId]);

  useEffect(() => {
    let isMounted = true;

    async function loadContext() {
      if (!selectedConversationId) {
        setContactContext(null);
        return;
      }

      setIsLoadingContext(true);
      setContextError(null);
      setAiSuggestion(null);
      setCrmStatus(null);

      try {
        const nextContext = await apiGetConversationContext(selectedConversationId, getFreshToken);

        if (!isMounted) return;

        setContactContext(nextContext);
      } catch (loadError) {
        if (!isMounted) return;
        setContextError(loadError instanceof Error ? loadError.message : "Não foi possível carregar contexto.");
      } finally {
        if (isMounted) {
          setIsLoadingContext(false);
        }
      }
    }

    void loadContext();

    return () => {
      isMounted = false;
    };
  }, [getFreshToken, selectedConversationId]);

  const refreshSelectedContext = useCallback((targetConversationId: string) => {
    void apiGetConversationContext(targetConversationId, getFreshToken)
      .then((nextContext) => {
        if (selectedConversationIdRef.current === targetConversationId) {
          setContactContext(nextContext);
        }
      })
      .catch(() => undefined);
  }, [getFreshToken]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type === "message.status_changed") {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.payload.messageId
            ? {
                ...message,
                status: event.payload.status
              }
            : message
        )
      );
      return;
    }

    if (event.type === "message.created") {
      const isSelectedConversation = event.payload.conversationId === selectedConversationIdRef.current;
      const shouldStickToBottom = isMessageThreadNearBottom() || !userReadingHistoryRef.current;

      setMessages((current) => {
        if (!isSelectedConversation) return current;
        return upsertMessage(current, event.payload);
      });

      if (isSelectedConversation) {
        if (shouldStickToBottom || event.payload.direction === "outbound") {
          scheduleMessageThreadScroll("smooth");
        } else if (event.payload.direction === "inbound") {
          setNewMessagesBelow((current) => current + 1);
        }
      }
      return;
    }

    if (event.type === "contact.updated") {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.contactId === event.payload.id
            ? {
                ...conversation,
                contactName: event.payload.name,
                contactPhone: event.payload.phone
              }
            : conversation
        )
      );

      const selectedConversation = conversationsRef.current.find(
        (conversation) => conversation.id === selectedConversationIdRef.current
      );
      if (selectedConversation?.contactId === event.payload.id && selectedConversationIdRef.current) {
        refreshSelectedContext(selectedConversationIdRef.current);
      }
      return;
    }

    if (event.type === "board_membership.updated") {
      const selectedConversation = conversationsRef.current.find(
        (conversation) => conversation.id === selectedConversationIdRef.current
      );
      if (
        selectedConversation?.contactId === event.payload.contactId &&
        selectedConversationIdRef.current
      ) {
        refreshSelectedContext(selectedConversationIdRef.current);
      }
      return;
    }

    if (event.type !== "conversation.updated") return;

    if (selectedQueueFilterRef.current === "mine") {
      setConversationReloadKey((current) => current + 1);
      return;
    }

    setConversations((current) => upsertConversation(current, event.payload));
    if (event.payload.id === selectedConversationIdRef.current) {
      refreshSelectedContext(event.payload.id);
      if (needsHumanAttention(event.payload)) {
        setAcknowledgedHandoffIds((current) => new Set(current).add(event.payload.id));
      }
    } else {
      setAcknowledgedHandoffIds((current) => {
        const next = new Set(current);
        if (!needsHumanAttention(event.payload)) {
          next.delete(event.payload.id);
        }
        return next;
      });
    }

    setSelectedConversationId((current) => current ?? event.payload.id);
  }, [refreshSelectedContext]);

  useRealtimeEvents({
    token,
    onEvent: handleRealtimeEvent
  });

  const queueFilteredConversations = useMemo(
    () => filterConversationsByQueue(conversations, selectedQueueFilter),
    [conversations, selectedQueueFilter]
  );
  const channelFilterOptions = useMemo(
    () => getChannelFilterOptions(queueFilteredConversations, channels),
    [queueFilteredConversations, channels]
  );
  const channelFilteredConversations = useMemo(
    () => filterConversationsByChannel(queueFilteredConversations, selectedChannelFilter),
    [queueFilteredConversations, selectedChannelFilter]
  );
  const humanAttentionCount = useMemo(
    () => filterConversationsNeedingHuman(channelFilteredConversations, true).length,
    [channelFilteredConversations]
  );
  const visibleConversations = useMemo(
    () => filterConversationsNeedingHuman(channelFilteredConversations, onlyHumanAttention),
    [channelFilteredConversations, onlyHumanAttention]
  );

  useEffect(() => {
    if (
      selectedChannelFilter !== "all" &&
      channels.length > 0 &&
      !channels.some((channel) => channel.id === selectedChannelFilter)
    ) {
      setSelectedChannelFilter("all");
    }
  }, [channels, selectedChannelFilter]);

  useEffect(() => {
    setSelectedConversationId((current) => {
      if (current && visibleConversations.some((conversation) => conversation.id === current)) {
        return current;
      }

      return visibleConversations[0]?.id ?? null;
    });
  }, [visibleConversations]);

  const selectedConversation = useMemo(
    () => visibleConversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [visibleConversations, selectedConversationId]
  );
  const visibleMessages = messagesConversationId === selectedConversationId ? messages : [];
  const handoffEnabled = Boolean(selectedConversation && needsHumanAttention(selectedConversation));
  const handoff = useHandoffBrief(selectedConversationId, handoffEnabled, selectedConversation?.lastMessageAt, getToken);
  const handoffBrief = handoffEnabled ? handoff.data ?? {
    status: handoff.error ? 'failed' as const : 'pending' as const,
    nextAction: null, summary: null, contextKey: null, updatedAt: null,
    error: handoff.error
  } : null;
  useEffect(() => { assistant.refresh(); }, [selectedConversation?.lastMessageAt, selectedConversation?.aiControlStatus, selectedConversation?.handoffActionCompletedAt, assistant.refresh]);
  const originNeedsReview = draftNeedsReview(composerOrigin, assistant.data?.currentContextKey);
  function editSuggestion(suggestion: AssistantSuggestionDto, confirmed: boolean) {
    if (suggestion.conversationId !== selectedConversationId || !canCopySuggestion(draft, confirmed)) return;
    setDraft(suggestion.body); setComposerOrigin(suggestionOrigin(suggestion)); setAssistantOpen(false);
    requestAnimationFrame(() => draftTextAreaRef.current?.focus());
  }
  async function sendSuggestion(suggestion: AssistantSuggestionDto, editedBody?: string) {
    if (assistantSendBusy.current || !selectedConversationId) return;
    const targetId = selectedConversationId;
    const keyId = `${targetId}:${suggestion.id}`;
    if (!directSendKeys.current.has(keyId)) directSendKeys.current.set(keyId, crypto.randomUUID());
    const requestKey = editedBody !== undefined && composerOrigin ? composerOrigin.requestKey : directSendKeys.current.get(keyId)!;
    assistantSendBusy.current = true; setIsSending(true);
    try {
      const result = await apiSendAssistantSuggestion(targetId, { suggestionId: suggestion.id, requestKey, body: editedBody ?? suggestion.body, reviewedContextKey: editedBody !== undefined ? composerOrigin?.contextKey ?? suggestion.contextKey : suggestion.contextKey, edited: editedBody !== undefined }, getToken);
      if (result.status === 'uncertain' || result.status === 'pending') throw new Error('Envio ainda sem confirmação. Confira a conversa antes de reenviar.');
      if (selectedConversationIdRef.current === targetId) {
        if (result.message) setMessages(current => upsertMessage(current, result.message!));
        if (editedBody !== undefined) { setDraft(current => current.trim() === editedBody ? '' : current); setComposerOrigin(null); }
        assistant.refresh();
      }
      if (result.conversation) setConversations(current => upsertConversation(current, result.conversation!));
    } finally { assistantSendBusy.current = false; setIsSending(false); }
  }
  const isThreadTransitioning = Boolean(selectedConversationId) && messagesConversationId !== selectedConversationId;
  async function saveContactName(contactId: string, name: string) {
    const saved = await apiUpdateContact(getToken, contactId, { name });
    setConversations(current => current.map(conversation => conversation.contactId === saved.id
      ? { ...conversation, contactName: saved.name, contactPhone: saved.phone } : conversation));
  }
  const contextNotes = contactContext?.notes ?? [];
  const visibleNotes = notesHistoryOpen ? contextNotes : contextNotes.slice(0, 2);
  const hiddenNoteCount = Math.max(0, contextNotes.length - visibleNotes.length);
  const availableTagOptions = useMemo(() => {
    const appliedTagIds = new Set(contactContext?.tags.map((tag) => tag.id) ?? []);

    return tagCatalog.filter((tag) => !appliedTagIds.has(tag.id));
  }, [contactContext?.tags, tagCatalog]);

  useEffect(() => {
    setNotesHistoryOpen(false);
  }, [selectedConversationId]);

  useEffect(() => {
    setSelectedTagId((current) =>
      availableTagOptions.some((tag) => tag.id === current) ? current : ""
    );
  }, [availableTagOptions]);

  useEffect(() => {
    if (!pendingThreadScrollRef.current) return;

    const behavior = pendingThreadScrollRef.current;
    pendingThreadScrollRef.current = null;

    window.requestAnimationFrame(() => scrollMessageThreadToBottom(behavior));
  }, [messages.length, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversation || !needsHumanAttention(selectedConversation)) return;

    setAcknowledgedHandoffIds((current) => new Set(current).add(selectedConversation.id));
  }, [selectedConversation]);

  useEffect(() => {
    if (!selectedConversation || selectedConversation.unreadCount === 0) return;

    const targetConversationId = selectedConversation.id;

    void apiMarkConversationRead(getFreshToken, targetConversationId)
      .then((conversation) => {
        setConversations((current) =>
          current.map((item) => (item.id === conversation.id ? conversation : item))
        );
      })
      .catch(() => undefined);
  }, [getFreshToken, selectedConversation]);

  const openCount = conversations.filter((conversation) => conversation.status === "open").length;
  const closedCount = conversations.filter((conversation) => conversation.status === "closed").length;
  const unreadCount = conversations.reduce((total, conversation) => total + conversation.unreadCount, 0);

  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedConversationId || !draft.trim() || isSending) return;
    if (composerOrigin) {
      if (originNeedsReview) { setMessageError('Chegaram novas informações. Revise o rascunho antes de enviar.'); return; }
      const source = assistant.data?.history.find(s => s.id === composerOrigin.suggestionId);
      if (!source) { setMessageError('A revisão original não está disponível. Abra novamente o apoio.'); return; }
      try { await sendSuggestion(source, draft.trim()); setMessageError(null); }
      catch (e) { setMessageError(e instanceof Error ? e.message : 'Confira o envio na conversa.'); }
      return;
    }

    const targetConversationId = selectedConversationId;
    const messageBody = draft.trim();
    const serviceWindowError = metaServiceWindowSendError(selectedConversation);

    if (serviceWindowError) {
      setMessageError(serviceWindowError);
      return;
    }

    const optimisticMessage: MessageDto = {
      id: optimisticMessageId(),
      workspaceId: selectedConversation?.workspaceId ?? "",
      conversationId: targetConversationId,
      providerMessageId: null,
      direction: "outbound",
      type: "text",
      body: messageBody,
      mediaUrl: null,
      status: "pending",
      sentByUserId: null,
      createdAt: new Date().toISOString()
    };

    setIsSending(true);
    setMessageError(null);
    setDraft("");
    setMessages((current) =>
      selectedConversationIdRef.current === targetConversationId ? [...current, optimisticMessage] : current
    );
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === targetConversationId
          ? {
              ...conversation,
              lastMessageAt: optimisticMessage.createdAt,
              lastMessagePreview: messageBody
            }
          : conversation
      )
    );
    scheduleMessageThreadScroll("smooth");

    try {
      const createdMessage = await apiCreateConversationMessage(
        targetConversationId,
        { body: messageBody },
        getFreshToken
      );

      setMessages((current) => {
        if (
          selectedConversationIdRef.current !== targetConversationId ||
          createdMessage.conversationId !== targetConversationId
        ) {
          return current;
        }
        return upsertMessage(current, createdMessage);
      });
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === targetConversationId
            ? {
                ...conversation,
                lastMessageAt: createdMessage.createdAt,
                lastMessagePreview: createdMessage.body
              }
            : conversation
        )
      );
    } catch (sendError) {
      if (selectedConversationIdRef.current === targetConversationId) {
        setMessageError(sendError instanceof Error ? sendError.message : "Não foi possível enviar a mensagem.");
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticMessage.id
              ? {
                  ...message,
                  status: "failed"
                }
              : message
          )
        );
        setDraft((current) => (current.trim().length === 0 ? messageBody : current));
      }
    } finally {
      setIsSending(false);
    }
  }

  async function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await sendAttachment(file, file.type.startsWith('audio/')).catch(() => {});
  }

  async function sendAttachment(file: File, voice = false) {
    if (!selectedConversationId || isSending) throw new Error('Aguarde o envio atual.');
    if (file.size > 8 * 1024 * 1024) { setMessageError('Envie um arquivo de até 8 MB.'); throw new Error('Arquivo maior que 8 MB.'); }
    if (composerOrigin) { setMessageError('Envie primeiro o texto em revisão. Depois anexe o arquivo em uma nova mensagem.'); throw new Error('Texto em revisão.'); }

    const targetConversationId = selectedConversationId;
    const serviceWindowError = metaServiceWindowSendError(selectedConversation);

    if (serviceWindowError) {
      setMessageError(serviceWindowError);
      throw new Error(serviceWindowError);
    }

    const caption = voice ? '' : draft.trim();
    const mediaUrl = await fileToDataUrl(file).catch((fileError: unknown) => {
      setMessageError(fileError instanceof Error ? fileError.message : "Não foi possível ler o arquivo.");
      return null;
    });

    if (!mediaUrl || selectedConversationIdRef.current !== targetConversationId) throw new Error('A conversa mudou ou o arquivo não pôde ser lido.');

    const messageType: MessageDto["type"] = voice ? 'audio' : file.type.startsWith("image/") ? "image" : "file";
    const body = voice ? 'Áudio enviado' : caption || file.name;
    const optimisticMessage: MessageDto = {
      id: optimisticMessageId(),
      workspaceId: selectedConversation?.workspaceId ?? "",
      conversationId: targetConversationId,
      providerMessageId: null,
      direction: "outbound",
      type: messageType,
      body,
      mediaUrl,
      status: "pending",
      sentByUserId: null,
      createdAt: new Date().toISOString()
    };

    setIsSending(true);
    setMessageError(null);
    if (!voice) setDraft("");
    setMessages((current) =>
      selectedConversationIdRef.current === targetConversationId ? [...current, optimisticMessage] : current
    );
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === targetConversationId
          ? {
              ...conversation,
              lastMessageAt: optimisticMessage.createdAt,
              lastMessagePreview: body
            }
          : conversation
      )
    );
    scheduleMessageThreadScroll("smooth");

    try {
      const createdMessage = await apiCreateConversationMessage(
        targetConversationId,
        {
          body: caption || undefined,
          attachment: {
            fileName: file.name,
            mediaUrl,
            mimetype: file.type || "application/octet-stream"
          }
        },
        getFreshToken
      );

      setMessages((current) =>
        selectedConversationIdRef.current === targetConversationId ? upsertMessage(current, createdMessage) : current
      );
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === targetConversationId
            ? {
                ...conversation,
                lastMessageAt: createdMessage.createdAt,
                lastMessagePreview: createdMessage.body
              }
            : conversation
        )
      );
    } catch (sendError) {
      if (selectedConversationIdRef.current === targetConversationId) {
        setMessageError(sendError instanceof Error ? sendError.message : "Não foi possível enviar o arquivo.");
        setMessages((current) =>
          current.map((message) =>
            message.id === optimisticMessage.id
              ? {
                  ...message,
                  status: "failed"
                }
              : message
          )
        );
      }
      throw sendError;
    } finally {
      setIsSending(false);
    }
  }

  async function runAction(body: ConversationActionBody) {
    if (!selectedConversationId) return null;

    const targetConversationId = selectedConversationId;
    setIsRunningAction(true);
    setContextError(null);

    try {
      const result = await apiRunConversationAction(targetConversationId, body, getFreshToken);
      applyActionResult(result, targetConversationId);
      if (body.action === "complete_handoff_action") setOnlyHumanAttention(false);
      if (["complete_handoff_action", "reanalyze_handoff_reply"].includes(body.action) && selectedConversationIdRef.current === targetConversationId) {
        setHandoffFeedback(handoffAnalysisFeedback(result.improvementAnalysis));
      }
      if (body.action === "reopen_handoff_action") setHandoffFeedback(null);
      return result;
    } catch (actionError) {
      if (selectedConversationIdRef.current === targetConversationId) {
        setContextError(actionError instanceof Error ? actionError.message : "Não foi possível executar a ação.");
      }
      return null;
    } finally {
      setIsRunningAction(false);
    }
  }

  useEffect(() => { setHandoffFeedback(null); }, [selectedConversationId]);

  async function resetSelectedConversation() {
    if (!selectedConversationId || !canResetConversation(currentRole)) return;

    const selected = conversations.find((conversation) => conversation.id === selectedConversationId);
    const confirmed = window.confirm(
      `Reiniciar a conversa com ${selected ? contactDisplayName(selected) : "este contato"}?\n\n` +
      "Isso apagará definitivamente mensagens, tags, notas e toda a memória da IA desta conversa."
    );
    if (!confirmed) return;

    const targetConversationId = selectedConversationId;
    setIsRunningAction(true);
    setContextError(null);

    try {
      const result = await apiResetConversation(targetConversationId, getFreshToken);
      applyActionResult(result, targetConversationId);
      setMessages([]);
      setMessagesConversationId(targetConversationId);
      setNoteDraft("");
      setSelectedTagId("");
      setAiSuggestion(null);
      setCrmStatus("Conversa reiniciada. Envie uma nova mensagem pelo WhatsApp para começar do zero.");
    } catch (resetError) {
      setContextError(resetError instanceof Error ? resetError.message : "Não foi possível reiniciar a conversa.");
    } finally {
      setIsRunningAction(false);
    }
  }

  function applyActionResult(result: ConversationActionResultDto, targetConversationId: string) {
    setConversations((current) => upsertConversation(current, result.conversation));
    if (
      selectedConversationIdRef.current !== targetConversationId ||
      result.conversation.id !== targetConversationId
    ) {
      return;
    }

    setContactContext(result.context);
    if (result.aiSuggestion) {
      setAiSuggestion(result.aiSuggestion);
    }
    if (result.crmAction) {
      setCrmStatus(`Nota registrada no CRM (${result.crmAction.status}).`);
    }
  }

  async function handleAddNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!noteDraft.trim()) return;

    const result = await runAction({ action: "add_note", body: noteDraft.trim() });
    if (result) {
      setNoteDraft("");
    }
  }

  async function handleAddTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const tag = tagCatalog.find((currentTag) => currentTag.id === selectedTagId);
    if (!tag) return;

    const result = await runAction({ action: "add_tag", name: tag.name });
    if (result) {
      setSelectedTagId("");
    }
  }

  async function handleRemoveTag(tagId: string) {
    await runAction({ action: "remove_tag", tagId });
  }

  async function toggleAiControl() {
    if (!selectedConversation) return;

    await runAction({
      action: selectedConversation.aiControlStatus === "human_controlled"
        ? "release_ai_control"
        : "assume_ai_control"
    });
  }

  async function handleCreateLead() {
    if (!selectedConversation) return;

    const targetConversation = selectedConversation;
    setIsRunningAction(true);
    setContextError(null);
    setCrmStatus(null);

    try {
      const action = await apiCreateCrmLead(getFreshToken, {
        contactId: targetConversation.contactId,
        title: `Lead WhatsApp - ${contactDisplayName(targetConversation)}`
      });

      setCrmStatus(
        action.mode === "real"
          ? "Lead enviado ao Vincula CRM."
          : "Lead registrado em modo simulado."
      );
    } catch (leadError) {
      setContextError(
        leadError instanceof Error ? leadError.message : "Não foi possível enviar o lead ao CRM."
      );
    } finally {
      setIsRunningAction(false);
    }
  }

  return (
    <section className={`talk-workspace talk-workspace-atendimento${selectedConversationId ? ' has-selected-conversation' : ''}`} aria-label="Atendimento">
      <section className="conversation-list" aria-label="Atendimento">
        <header className="list-header">
          <div>
            <p className="eyebrow">Prymeira Talk</p>
            <h1>Atendimento</h1>
          </div>
          <span className="live-indicator">{token ? "Online" : "Conectando"}</span>
        </header>

        <div className="queue-summary" aria-label="Resumo da fila">
          <div>
            <span>{openCount}{hasMoreConversations && selectedQueueFilter !== "closed" ? "+" : ""}</span>
            <p>Abertas</p>
          </div>
          <div>
            <span>{unreadCount}{hasMoreConversations && selectedQueueFilter !== "closed" ? "+" : ""}</span>
            <p>Novas</p>
          </div>
          <div>
            <span>{closedCount}{hasMoreConversations && ["closed", "all"].includes(selectedQueueFilter) ? "+" : ""}</span>
            <p>Finalizadas</p>
          </div>
        </div>

        <div className="queue-filter-row" aria-label="Filtrar por status da conversa">
          {[
            { id: "mine" as const, label: "Minhas" },
            { id: "active" as const, label: "Ativas" },
            { id: "closed" as const, label: "Finalizadas" },
            { id: "all" as const, label: "Todas" }
          ].map((option) => (
            <button
              aria-pressed={selectedQueueFilter === option.id}
              className={[
                "queue-filter-chip",
                selectedQueueFilter === option.id ? "is-active" : ""
              ].filter(Boolean).join(" ")}
              key={option.id}
              onClick={() => {
                setOnlyHumanAttention(false);
                setSelectedQueueFilter(option.id);
              }}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="channel-filter-row" aria-label="Filtrar por canal">
          {channelFilterOptions.map((option) => (
            <button
              className={[
                "channel-filter-chip",
                option.id === selectedChannelFilter ? "is-active" : ""
              ].filter(Boolean).join(" ")}
              key={option.id}
              onClick={() => setSelectedChannelFilter(option.id)}
              type="button"
              aria-pressed={option.id === selectedChannelFilter}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="attention-filter-row" role="group" aria-label="Visualização das conversas">
          <button
            aria-pressed={!onlyHumanAttention}
            className={`attention-filter-button${onlyHumanAttention ? "" : " is-active"}`}
            onClick={() => setOnlyHumanAttention(false)}
            type="button"
          >
            Conversas
          </button>
          <button
            aria-label={`Próxima ação: ${humanAttentionCount} conversas com humano necessário`}
            aria-pressed={onlyHumanAttention}
            className={`attention-filter-button attention-filter-button--human${onlyHumanAttention ? " is-active" : ""}`}
            onClick={() => {
              setSelectedQueueFilter("active");
              setOnlyHumanAttention(true);
            }}
            type="button"
          >
            <TriangleAlert size={14} aria-hidden="true" />
            Próxima ação
            <span className={`attention-filter-count${humanAttentionCount > 0 ? " has-items" : ""}`} aria-hidden="true">
              {humanAttentionCount}
            </span>
          </button>
        </div>

        {isLoading ? <p className="list-note">Carregando conversas...</p> : null}
        {error ? <p className="error-note">{error}</p> : null}

        <div className="conversation-items" onScroll={(event) => {
          const list = event.currentTarget;
          if (list.scrollHeight - list.scrollTop - list.clientHeight < 160) {
            void loadMoreConversations();
          }
        }}>
          {!isLoading && !hasMoreConversations && visibleConversations.length === 0 ? (
            <p className="list-note">
              {onlyHumanAttention
                ? "Nenhuma conversa aguardando ação humana neste canal."
                : "Nenhuma conversa encontrada para este canal."}
            </p>
          ) : null}
          {visibleConversations.map((conversation) => {
            const conversationNeedsHuman = needsHumanAttention(conversation);
            const showHumanAttention =
              conversationNeedsHuman &&
              conversation.id !== selectedConversationId &&
              !acknowledgedHandoffIds.has(conversation.id);
            const controlBadge = getConversationControlBadge(conversation, showHumanAttention);
            const conversationAriaLabel = [
              `Abrir conversa com ${contactDisplayName(conversation)}`,
              controlBadge?.label
            ].filter(Boolean).join(". ");

            return (
            <button
              aria-label={conversationAriaLabel}
              className={[
                "conversation-card",
                conversation.id === selectedConversationId ? "is-selected" : "",
                showHumanAttention ? "needs-human-attention" : ""
              ].filter(Boolean).join(" ")}
              key={conversation.id}
              onClick={() => {
                setSelectedConversationId(conversation.id);
                if (conversationNeedsHuman) {
                  setAcknowledgedHandoffIds((current) => new Set(current).add(conversation.id));
                }
              }}
              type="button"
            >
              <div className="conv-avatar-wrap">
                <ContactAvatar conversationId={conversation.id} name={conversation.contactName} className="conversation-avatar" />
                {controlBadge ? (
                  <span
                    aria-hidden="true"
                    className={`conversation-control-badge is-${controlBadge.kind}`}
                    title={controlBadge.label}
                  >
                    {controlBadge.kind === "attention" ? <TriangleAlert size={12} /> : null}
                    {controlBadge.kind === "human" ? <UserRound size={12} /> : null}
                    {controlBadge.kind === "agent" ? <Bot size={12} /> : null}
                  </span>
                ) : null}
              </div>
              <span className="conversation-content">
                <span className="conversation-row">
                  <span className="conv-name-wrap">
                    <strong>{contactDisplayName(conversation)}</strong>
                    {conversation.departmentName ? (
                      <span className="conv-dept-tag">{conversation.departmentName}</span>
                    ) : null}
                    {conversationNeedsHuman ? (
                      <span className="conv-human-tag">Humano necessário</span>
                    ) : null}
                  </span>
                  <span className="conv-meta-right">
                    <time className="conv-time">{formatTime(conversation.lastMessageAt)}</time>
                    {conversation.unreadCount > 0 ? (
                      <span className="conv-unread-badge">
                        {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="conversation-channel-origin">
                  via {conversation.channelName ?? "Canal sem nome"}
                </span>
                <span className="conversation-owner-line">
                  <UserCheck size={11} aria-hidden="true" />
                  <span>{conversation.assignedUserName ?? "Fila geral"}</span>
                </span>
                <span className="conversation-preview">
                  {conversation.lastMessagePreview ?? "Conversa iniciada."}
                </span>
              </span>
            </button>
            );
          })}
          {loadMoreError ? <p className="error-note">{loadMoreError}</p> : null}
          {hasMoreConversations ? (
            <button
              className="conversation-load-more"
              disabled={isLoadingMoreConversations}
              onClick={() => void loadMoreConversations()}
              type="button"
            >
              {isLoadingMoreConversations ? "Carregando conversas..." : "Carregar conversas anteriores"}
            </button>
          ) : null}
        </div>
      </section>

      <section className="chat-panel" aria-label="Area de atendimento">
        <header className="chat-header">
          <button className="assistant-mobile-back" type="button" onClick={() => setSelectedConversationId(null)}>Voltar</button>
          <div>
            <p className="eyebrow">Atendimento</p>
            <h2>
              {selectedConversation
                ? contactDisplayName(selectedConversation)
                : "Selecione uma conversa"}
            </h2>
          </div>
          {selectedConversation ? (
            <div className="conversation-ai-control module-header-actions" aria-label="Controle da IA">
              <span className="status-badge status-badge--bot">
                {aiControlLabel(selectedConversation)}
              </span>
              <button
                className="secondary-button"
                disabled={isRunningAction}
                onClick={() => void toggleAiControl()}
                type="button"
              >
                {aiControlActionLabel(selectedConversation)}
              </button>
              <span className={`status-badge status-badge--${selectedConversation.status}`}>
                {statusLabel(selectedConversation.status)}
              </span>
            </div>
          ) : null}
        </header>

        {selectedConversation ? (
          <div
            className="message-thread"
            aria-label="Histórico da conversa"
            onScroll={() => {
              if (isMessageThreadNearBottom()) {
                userReadingHistoryRef.current = false;
                setNewMessagesBelow(0);
              } else {
                userReadingHistoryRef.current = true;
              }
            }}
            ref={messageThreadRef}
          >
            {visibleMessages.length >= 100 ? <p className="assistant-caption">Na abertura, são carregadas as 100 mensagens mais recentes.</p> : null}
            {isThreadTransitioning ? (
              <div className="message-thread-skeleton" aria-label="Abrindo conversa">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {isLoadingMessages && !isThreadTransitioning ? (
              <p className="thread-note">Atualizando mensagens...</p>
            ) : null}
            {messageError ? <p className="error-note">{messageError}</p> : null}
            {!isLoadingMessages && !isThreadTransitioning && visibleMessages.length === 0 ? (
              <p className="thread-note">Ainda não ha mensagens nesta conversa.</p>
            ) : null}
            {visibleMessages.map((message) => (
              <article
                className={`message-bubble ${message.direction === "outbound" ? "is-outbound" : "is-inbound"}`}
                key={message.id}
              >
                {message.direction === "inbound" ? (
                  <ContactAvatar conversationId={selectedConversation?.id} name={selectedConversation?.contactName} className="msg-avatar" />
                ) : null}
                <div className="msg-bubble-body">
                  {['image', 'audio', 'file'].includes(message.type) ? <>
                    <InboxMedia key={`${message.id}:${message.mediaUrl?.slice(0, 60)}`} message={message} getToken={getToken} />
                    {mediaCaption(message) ? <p><WhatsappText text={mediaCaption(message)!} /></p> : null}
                    {attachmentReadNotice(message) ? <details className="talk-audio-transcript"><summary>Leitura pela IA indisponível</summary><p>Você pode abrir o anexo acima. A leitura pela IA não foi concluída.</p></details> : null}
                  </> : <p><WhatsappText text={messageDisplayText(message)} /></p>}
                  <time>{formatMessageTime(message.createdAt)}</time>
                  {outboundStatusLabel(message) ? (
                    <span className={`message-send-state message-send-state--${message.status}`}>
                      {outboundStatusLabel(message)}
                    </span>
                  ) : null}
                </div>
              </article>
            ))}
            {newMessagesBelow > 0 ? (
              <button
                className="new-messages-pill"
                onClick={() => scrollMessageThreadToBottom("smooth")}
                type="button"
              >
                {newMessagesBelow === 1 ? "1 nova mensagem abaixo" : `${newMessagesBelow} novas mensagens abaixo`}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">
              <MessageSquare size={28} aria-hidden="true" />
            </div>
            <h3>Nenhuma conversa selecionada</h3>
            <p>Escolha uma conversa na fila para acompanhar o atendimento.</p>
          </div>
        )}

        <div className="composer-shell">
          <button ref={assistantTriggerRef} type="button" className="assistant-mobile-trigger" onClick={() => { setAssistantTab('assistant'); setAssistantOpen(true); }} disabled={!selectedConversation}><MessageSquare size={15} /> IA de apoio <span>{handoffBrief ? 'Próxima ação' : assistant.data?.status === 'ready' ? 'Sugestão pronta' : 'Abrir'}</span></button>
          {composerOrigin ? <div className="assistant-composer-origin"><span>{originNeedsReview ? 'A conversa mudou. Confira o rascunho.' : 'Sugestão em edição. O texto enviado ficará registrado.'}</span>{originNeedsReview ? <button type="button" disabled={!assistant.data?.currentContextKey} onClick={() => setComposerOrigin(current => current && assistant.data?.currentContextKey ? { ...current, contextKey: assistant.data.currentContextKey } : current)}>Revisei o contexto</button> : null}</div> : null}
          {showQuickReplies ? (
            <QuickRepliesPopover
              replies={quickReplies}
              isLoading={isQuickRepliesLoading}
              error={quickRepliesError}
              onInsert={(body) => {
                insertDraftText(body);
                setShowQuickReplies(false);
              }}
              onCreate={async (input) => {
                const created = await apiCreateQuickReply(getToken, input);
                setQuickReplies((current) => [created, ...current]);
              }}
              onUpdate={async (id, input) => {
                const updated = await apiUpdateQuickReply(getToken, id, input);
                setQuickReplies((current) => current.map((reply) => (reply.id === id ? updated : reply)));
              }}
              onDelete={async (id) => {
                await apiDeleteQuickReply(getToken, id);
                setQuickReplies((current) => current.filter((reply) => reply.id !== id));
              }}
            />
          ) : null}
          <form
            aria-busy={isSending}
            className="composer"
            aria-label="Compositor de mensagem"
            onSubmit={handleSendMessage}
          >
            <div className="composer-toolbar" aria-label="Ferramentas de formatação">
              <button
                type="button"
                className="composer-tool"
                aria-label="Negrito"
                aria-pressed={draftFormat.bold}
                disabled={!selectedConversation || isSending}
                onMouseDown={event => event.preventDefault()}
                onClick={() => applyDraftMarker("*")}
              >
                <strong>B</strong>
              </button>
              <button
                type="button"
                className="composer-tool"
                aria-label="Itálico"
                aria-pressed={draftFormat.italic}
                disabled={!selectedConversation || isSending}
                onMouseDown={event => event.preventDefault()}
                onClick={() => applyDraftMarker("_")}
              >
                <em>I</em>
              </button>
              <span className="composer-tool-divider" aria-hidden="true" />
              <button
                type="button"
                className="composer-tool"
                aria-label="Emoji"
                disabled={!selectedConversation}
                onClick={() => setShowEmojiPicker((current) => !current)}
              >
                😊
              </button>
              <button
                type="button"
                className="composer-tool"
                aria-label="Anexo"
                disabled={!selectedConversation}
                onClick={() => fileInputRef.current?.click()}
              >
                📎
              </button>
              <input
                className="composer-file-input"
                onChange={handleFileSelected}
                ref={fileInputRef}
                type="file"
              />
              <VoiceRecorder key={selectedConversationId ?? 'no-conversation'} disabled={!selectedConversation || isSending || Boolean(composerOrigin) || selectedConversation.channelProvider !== 'evolution'} onSend={file => sendAttachment(file, true)} />
              <span className="composer-tool-spacer" aria-hidden="true" />
              <button
                type="button"
                className="composer-quick-replies"
                disabled={!selectedConversation}
                onClick={() => setShowQuickReplies((current) => !current)}
              >
                Mensagens padrão
              </button>
            </div>
            {showEmojiPicker ? (
              <div className="composer-emoji-picker" aria-label="Emojis">
                {composerEmojis.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      insertDraftText(emoji);
                      setShowEmojiPicker(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="composer-input-row">
              <RichDraft key={selectedConversationId ?? 'no-conversation'} ref={draftTextAreaRef} value={draft} disabled={!selectedConversation || isSending} onFormatChange={setDraftFormat} onChange={value => { setDraft(value); if (!value) setComposerOrigin(null); }} />
              <button
                className="composer-send"
                disabled={!selectedConversation || !draft.trim() || isSending}
                type="submit"
                aria-label="Enviar mensagem"
              >
                →
              </button>
            </div>
          </form>
        </div>
      </section>

      <aside className={`contact-panel assistant-contact-panel${assistantOpen ? ' assistant-drawer-open' : ''}`} aria-label="Contato e IA de apoio">
        <div className="assistant-tabs"><button type="button" aria-pressed={assistantTab === 'contact'} onClick={() => setAssistantTab('contact')}>Contato</button><button type="button" aria-pressed={assistantTab === 'assistant'} onClick={() => setAssistantTab('assistant')}>IA de apoio{handoffBrief ? <span className="assistant-tab-dot is-handoff" /> : assistant.data?.status === 'ready' ? <span className="assistant-tab-dot" /> : null}</button><button ref={assistantCloseRef} className="assistant-drawer-close" aria-label="Fechar apoio" type="button" onClick={() => { setAssistantOpen(false); assistantTriggerRef.current?.focus(); }}><X size={18} /></button></div>
        {assistantTab === 'assistant' ? <AssistantPanel key={selectedConversationId ?? 'none'} data={assistant.data} error={assistant.error} humanControlled={selectedConversation?.aiControlStatus === 'human_controlled'} handoffBrief={handoffBrief} handoffCompleted={Boolean(selectedConversation?.handoffActionCompletedAt)} handoffFeedback={handoffFeedback} handoffBusy={isRunningAction} onCompleteHandoff={() => { void runAction({ action: 'complete_handoff_action' }); }} onReopenHandoff={() => { void runAction({ action: 'reopen_handoff_action' }); }} onReanalyzeHandoff={() => { void runAction({ action: 'reanalyze_handoff_reply' }); }} draftExists={Boolean(draft.trim())} sending={isSending} onGenerate={assistant.request} onSend={sendSuggestion} onEdit={editSuggestion} /> : <>
        {/* Card identidade */}
        {selectedConversation ? <ContactIdentityCard key={selectedConversation.contactId}
          conversationId={selectedConversation.id}
          contactId={selectedConversation.contactId} name={selectedConversation.contactName ?? null}
          phone={selectedConversation.contactPhone ?? null} channelName={selectedConversation.channelName}
          onSave={saveContactName} /> : <div className="context-card">Nenhuma conversa</div>}

        {/* Card detalhes */}
        <div className="context-card">
          <div className="context-card-title">Detalhes</div>
          <dl className="context-rows">
            <div className="context-row">
              <dt>Status</dt>
              <dd>{selectedConversation ? statusLabel(selectedConversation.status) : "—"}</dd>
            </div>
            <div className="context-row">
              <dt>Prioridade</dt>
              <dd>{selectedConversation ? priorityLabel(selectedConversation.priority) : "—"}</dd>
            </div>
            <div className="context-row">
              <dt>Departamento</dt>
              <dd>{selectedConversation?.departmentName ?? "Não atribuído"}</dd>
            </div>
            <div className="context-row">
              <dt>Responsável</dt>
              <dd>{selectedConversation?.assignedUserName ?? "Fila geral"}</dd>
            </div>
          </dl>
        </div>

        {/* Card tags */}
        <div className="context-card">
          <div className="context-card-title">Tags</div>
          <div className="tag-row">
            {contactContext?.tags.length ? (
              contactContext.tags.map((tag) => (
                <span key={tag.id} className="context-tag" style={{ borderColor: tag.color }}>
                  {tag.name}
                  <button
                    aria-label={`Remover tag ${tag.name}`}
                    disabled={!selectedConversation || isRunningAction}
                    onClick={() => void handleRemoveTag(tag.id)}
                    type="button"
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              ))
            ) : (
              <span className="context-empty-label">Sem tags</span>
            )}
          </div>
          <form className="tag-add-form" onSubmit={handleAddTag}>
            <select
              aria-label="Selecionar tag"
              disabled={!selectedConversation || isRunningAction || availableTagOptions.length === 0}
              onChange={(event) => setSelectedTagId(event.target.value)}
              value={selectedTagId}
            >
              <option value="">
                {availableTagOptions.length > 0 ? "Adicionar tag..." : "Todas as tags aplicadas"}
              </option>
              {availableTagOptions.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
            <button
              disabled={!selectedConversation || !selectedTagId || isRunningAction}
              type="submit"
            >
              Adicionar
            </button>
          </form>
        </div>

        {/* Card notas */}
        <div className="context-card">
          <div className="context-card-title-row">
            <div className="context-card-title">Notas internas</div>
            {contextNotes.length > 2 ? (
              <button
                aria-expanded={notesHistoryOpen}
                className="context-title-action"
                onClick={() => setNotesHistoryOpen((current) => !current)}
                title={notesHistoryOpen ? "Mostrar menos notas" : "Mostrar histórico de notas"}
                type="button"
              >
                <History size={13} aria-hidden="true" />
                <span>{notesHistoryOpen ? "Recentes" : `${contextNotes.length}`}</span>
              </button>
            ) : null}
          </div>
          {contextError ? <p className="error-note compact">{contextError}</p> : null}
          {contextNotes.length ? (
            <div className={`notes-list${notesHistoryOpen ? " notes-list--history" : ""}`}>
              {visibleNotes.map((note) => (
                <article className="context-note" key={note.id}>
                  <p>{note.body}</p>
                  <time>{formatNoteDate(note.createdAt)}</time>
                </article>
              ))}
              {!notesHistoryOpen && hiddenNoteCount > 0 ? (
                <button
                  className="notes-history-button"
                  onClick={() => setNotesHistoryOpen(true)}
                  type="button"
                >
                  Ver mais {hiddenNoteCount} notas
                </button>
              ) : null}
            </div>
          ) : (
            <span className="context-empty-label">Sem notas</span>
          )}
          <form className="quick-note-form" onSubmit={handleAddNote}>
            <input
              aria-label="Nova nota"
              disabled={!selectedConversation || isRunningAction}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="Adicionar nota..."
              value={noteDraft}
            />
            <button
              aria-label="Salvar nota"
              disabled={!selectedConversation || !noteDraft.trim() || isRunningAction}
              type="submit"
            >
              <StickyNote size={15} aria-hidden="true" />
            </button>
          </form>
        </div>

        {/* Card ações */}
        <div className="context-card">
          <div className="context-card-title">Ações rápidas</div>
          <div className="quick-actions">
            <button
              disabled={!selectedConversation || isRunningAction}
              onClick={() => void runAction({ action: "assign_current_user" })}
              type="button"
            >
              <UserCheck size={15} aria-hidden="true" />
              Assumir
            </button>
            <button
              disabled={!selectedConversation || isRunningAction}
              onClick={() => setAssistantTab('assistant')}
              type="button"
            >
              <Bot size={15} aria-hidden="true" />
              IA
            </button>
            <button
              disabled={!selectedConversation || isRunningAction}
              onClick={() => void handleCreateLead()}
              type="button"
            >
              <Plus size={15} aria-hidden="true" />
              Lead
            </button>
            <button
              className="quick-action-danger"
              disabled={!selectedConversation || isRunningAction}
              onClick={() => void runAction({ action: "close_conversation" })}
              type="button"
            >
              <CheckCircle2 size={15} aria-hidden="true" />
              Finalizar
            </button>
            {canResetConversation(currentRole) ? (
              <button
                className="quick-action-danger"
                disabled={!selectedConversation || isRunningAction}
                onClick={() => void resetSelectedConversation()}
                type="button"
              >
                <RotateCcw size={15} aria-hidden="true" />
                Reiniciar conversa
              </button>
            ) : null}
          </div>
          {aiSuggestion ? (
            <div className="ai-suggestion">{aiSuggestion}</div>
          ) : null}
          {crmStatus ? (
            <p className="crm-status">{crmStatus}</p>
          ) : null}
        </div>
        </>}
      </aside>
    </section>
  );
}
