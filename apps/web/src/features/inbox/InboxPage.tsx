import { abortable, withReadDeadline } from '../../app/read-request';
import { useTalkPerformance, TalkPerformancePanel } from './talk-performance';
import { useQuery } from '@tanstack/react-query';
import { useSessionState, useTalkSession } from '../../app/session/TalkSessionProvider';
import { CATALOG_STALE_MS, MAX_MESSAGES, receiptStatus } from '../../app/session/talk-session';
import { LocationMessage } from './LocationMessage';
import { needsHumanAttention } from "@prymeira-talk/shared";
import type { ChannelDto, ConversationDto, InboxView, MessageDto, RealtimeEvent, TagDto } from "@prymeira-talk/shared";
import { Bookmark, Bot, CheckCircle2, ContactRound, FileText, History, MessageCircleX, MessageSquare, MessageSquarePlus, Paperclip, Plus, Reply, Search, RotateCcw, Send, StickyNote, Trash2, TriangleAlert, UploadCloud, UserCheck, UserRound, Users, X } from "lucide-react";
import { quotedPreview, threadWithReactions } from "./message-threading.js";
import { MessageTicks } from "./MessageTicks";
import { ConversationPreview } from "./ConversationPreview";
import type { ChangeEvent, DragEvent, FormEvent, SetStateAction } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  apiCreateQuickReply,
  apiCreateConversationMessage,
  apiDeleteMessageForEveryone,
  apiCreateCrmLead,
  apiDeleteQuickReply,
  apiGetConversationContext,
  apiGetConversationMessages,
  apiRecognizeContactMessage,
  apiGetConversations,
  apiGetAttentionCount,
  apiSetManualMark,
  apiDismissReply,
  apiUndoReply,
  apiGetChannels,
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
  getConversationControlBadge,
  getChannelFilterOptions
} from "./conversation-display";
import { InboxQuickFilters } from "./InboxQuickFilters";
import { ShareContactDialog } from "./ShareContactDialog";
import { NewConversationDialog } from "./NewConversationDialog";
import { ContactCardDialog, ContactCardMessage } from './ContactCardDialog';
import { QuickSendDialog } from "./QuickSendDialog";
import { QuickRepliesPopover } from "./QuickRepliesPopover";
import { useRealtimeEvents } from "./useRealtimeEvents";
import { AssistantPanel } from './AssistantPanel';
import { useHandoffBrief } from './useHandoffBrief';
import { ContactIdentityCard } from './ContactIdentityCard';
import { ContactAvatar } from './ContactAvatar';
import { InboxMedia, mediaCaption } from './InboxMedia';
import { RichDraft, type RichDraftHandle } from './RichDraft';
import { VoiceRecorder } from './VoiceRecorder';
import { mergeLeadComposerDraft, takeLeadDraftRequest } from './lead-composer';
import { WhatsappText } from './whatsapp-text';
import { useAssistantConversation } from './useAssistantConversation';
import { canCopySuggestion, draftNeedsReview, suggestionOrigin, type ComposerSuggestionOrigin } from './assistant-composer-state';
import { apiSendAssistantSuggestion } from '../../app/api';
import type { AssistantSuggestionDto } from '@prymeira-talk/shared';
import { formatConversationCardDate } from './conversation-card-date';

function ConversationCardTime({ value }: { value: string | null }) {
  if (!value) return <time className="conv-time">Sem mensagens</time>;
  const { day, time } = formatConversationCardDate(value);
  return <time className="conv-time" dateTime={value}><span>{day}</span><span>{time}</span></time>;
}

const CONVERSATION_PAGE_SIZE = 50;
const EMPTY_CONVERSATIONS: ConversationDto[] = [];
const EMPTY_MESSAGES: MessageDto[] = [];
const EMPTY_CHANNELS: ChannelDto[] = [];
const EMPTY_TAGS: TagDto[] = [];
const EMPTY_QUICK_REPLIES: QuickReplyDto[] = [];
const EMPTY_NOTES: ContactContextDto["notes"] = [];

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

/** Clicking a quote brings the quoted message into view and flashes it, like WhatsApp. */
function revealMessage(messageId: string) {
  const element = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!element) return;
  element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  element.classList.remove('is-highlighted');
  void element.offsetWidth; // restart the flash when the same quote is clicked twice
  element.classList.add('is-highlighted');
  window.setTimeout(() => element.classList.remove('is-highlighted'), 1600);
}

function statusLabel(status: ConversationDto["status"]) {
  const labels: Record<ConversationDto["status"], string> = {
    open: "Aberta",
    pending: "Pendente",
    closed: "Fechada"
  };

  return labels[status];
}

export function ConversationCampaignSource({ conversation }: { conversation: Pick<ConversationDto, "sourceCampaign"> }) {
  return conversation.sourceCampaign ? <a className="status-badge conversation-campaign-source"
    href={`?module=disparos&campaign=${encodeURIComponent(conversation.sourceCampaign.id)}`}>
    Campanha: {conversation.sourceCampaign.name}
  </a> : null;
}

export function aiControlLabel(
  conversation: Pick<ConversationDto, "aiControlStatus" | "activeAgentName">,
  assistantMode?: 'disabled' | 'automatic' | 'on_demand' | 'automatic_with_agent'
) {
  if (conversation.aiControlStatus === "human_controlled") return "Humano no controle";
  if (conversation.activeAgentName) return `IA ativa: ${conversation.activeAgentName}`;
  if (assistantMode === 'automatic' || assistantMode === 'on_demand') return "Apoio com revisão";
  if (assistantMode === 'automatic_with_agent') return "Agente liberado";
  return "IA liberada";
}

export function aiControlActionLabel(conversation: Pick<ConversationDto, "aiControlStatus">) {
  return conversation.aiControlStatus === "human_controlled" ? "Liberar IA" : "Assumir";
}

export { needsHumanAttention } from "@prymeira-talk/shared";

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
  next[index] = { ...next[index], ...conversation };
  return sortConversationsByRecency(next);
}

export function conversationPreviewTime(conversation: Pick<ConversationDto, 'lastMessageAt' | 'lastMessagePreviewAt'>) {
  return conversation.lastMessagePreviewAt &&
    (!conversation.lastMessageAt || Date.parse(conversation.lastMessagePreviewAt) > Date.parse(conversation.lastMessageAt))
    ? conversation.lastMessagePreviewAt : conversation.lastMessageAt;
}

export function mergeConversationPage(current: ConversationDto[], page: ConversationDto[]) {
  const seen = new Set(current.map((conversation) => conversation.id));
  return [...current, ...page.filter((conversation) => !seen.has(conversation.id))];
}

export function resolveSelectedConversation(
  list: ConversationDto[], selectedId: string | null, snapshot: ConversationDto | null
) {
  if (!selectedId) return null;
  return list.find((conversation) => conversation.id === selectedId) ??
    (snapshot?.id === selectedId ? snapshot : null);
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

function upsertMessage(list: MessageDto[], message: MessageDto, optimisticId?: string) {
  const existingIndex = list.findIndex((item) => item.id === message.id);

  if (existingIndex >= 0) {
    return list.flatMap((item, index) => {
      if (item.id === optimisticId && index !== existingIndex) return [];
      return [index === existingIndex ? { ...message, status: receiptStatus(item.status, message.status) } : item];
    });
  }

  // A POST acknowledgement knows its exact attempt; identical manual sends
  // must stay distinct. Realtime frames match content in the session cache.
  const optimisticIndex = optimisticId ? list.findIndex(item => item.id === optimisticId) : -1;

  if (optimisticIndex >= 0) {
    return list.map((item, index) => (index === optimisticIndex ? { ...message, status: receiptStatus(item.status, message.status) } : item));
  }

  // A late arrival (recovered after a disconnection) goes where its WhatsApp time puts it, as in WhatsApp.
  const at = Date.parse(message.createdAt);
  const after = Number.isFinite(at) ? list.findIndex(item => Date.parse(item.createdAt) > at) : -1;
  return after < 0 ? [...list, message] : [...list.slice(0, after), message, ...list.slice(after)];
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
  return <InboxPageContent />;
}

function InboxPageContent() {
  const { session, getToken, currentUser } = useTalkSession();
  const [actionError, setError] = useState<string | null>(null);
  const [contextActionError, setContextError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [isLoadingMoreConversations, setIsLoadingMoreConversations] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useSessionState<string | null>('selectedConversation', null);
  const [selectedConversationSnapshot, setSelectedConversationSnapshot] = useSessionState<ConversationDto | null>('selectedSnapshot', null);
  const [messageActionError, setMessageError] = useState<string | null>(null);
  const [sendFailure] = useSessionState<{ generation: string; message: string } | null>(`sendFailure:${selectedConversationId ?? 'none'}`, null);
  const messageError = messageActionError ?? sendFailure?.message;
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [draft, setDraft] = useSessionState(`draft:${selectedConversationId ?? 'none'}`, '');
  const [assistantTab, setAssistantTab] = useState<'contact' | 'assistant'>('assistant');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [composerOrigin, setComposerOrigin] = useSessionState<ComposerSuggestionOrigin | null>(`draftOrigin:${selectedConversationId ?? 'none'}`, null);
  const assistantSendBusy = useRef(false);
  const directSendKeys = useRef(new Map<string, string>());
  const assistantTriggerRef = useRef<HTMLButtonElement | null>(null);
  const assistantCloseRef = useRef<HTMLButtonElement | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [notesHistoryOpen, setNotesHistoryOpen] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState("");
  const [activeView, setActiveView] = useSessionState<InboxView>('view', 'all');
  const [selectedChannelFilter, setSelectedChannelFilter] = useSessionState('channelFilter', 'all');
  const [searchOpen, setSearchOpen] = useSessionState('searchOpen', false);
  const [searchDraft, setSearchDraft] = useSessionState('searchDraft', '');
  const [searchQuery, setSearchQuery] = useSessionState('searchQuery', '');
  const [shareContactOpen, setShareContactOpen] = useState(false);
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [selectedContactCard, setSelectedContactCard] = useState<NonNullable<MessageDto['contactCards']>[number] | null>(null);
  const [quickSendOpen, setQuickSendOpen] = useState(false);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [attentionCountReloadKey, setAttentionCountReloadKey] = useState(0);
  const [actionBusyConversationId, setActionBusyConversationId] = useState<string | null>(null);
  const [dismissUndo, setDismissUndo] = useState<{ conversationId: string; anchorMessageId: string } | null>(null);
  const [conversationReloadKey, setConversationReloadKey] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const textSendQueue = useRef(new Map<string, Promise<unknown>>());
  /** The message being replied to (WhatsApp quote); only for messages that have a WhatsApp id. */
  const [replyTarget, setReplyTarget] = useState<MessageDto | null>(null);
  const [pendingFile, setPendingFile] = useSessionState<File | null>(`draftFile:${selectedConversationId ?? 'none'}`, null);
  const [pendingFilePreview, setPendingFilePreview] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragDepthRef = useRef(0);
  const [isRunningAction, setIsRunningAction] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [crmStatus, setCrmStatus] = useState<string | null>(null);
  const [handoffFeedback, setHandoffFeedback] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [newMessagesBelow, setNewMessagesBelow] = useState(0);
  const selectedConversationIdRef = useRef<string | null>(null);
  const conversationCursorRef = useRef<string | null>(null);
  const conversationListGenerationRef = useRef(0);
  const loadingMoreConversationsRef = useRef(false);
  const paginationCompletionRef = useRef<Promise<void> | null>(null);
  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const openedThreadRef = useRef<string | null>(null);
  const lastThreadScrollTopRef = useRef(0);
  const threadFollowFrameRef = useRef<number | null>(null);
  const pendingThreadRestoreRef = useRef<number | null>(null);
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
  useEffect(() => { setContextError(null); setError(null); setAiSuggestion(null); setCrmStatus(null); setAssistantOpen(false); setShareContactOpen(false); setSelectedContactCard(null); setIsDraggingFile(false); dragDepthRef.current = 0; }, [selectedConversationId]);
  useEffect(() => {
    if (!pendingFile?.type.startsWith('image/')) { setPendingFilePreview(null); return; }
    const url = URL.createObjectURL(pendingFile);
    setPendingFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setSearchQuery(searchDraft.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [searchDraft]);
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

  function isMessageThreadNearBottom() {
    const thread = messageThreadRef.current;

    if (!thread) return true;

    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 96;
  }

  function scrollMessageThreadToBottom(behavior: ScrollBehavior = "smooth", targetId = selectedConversationIdRef.current) {
    const thread = messageThreadRef.current;

    if (!thread) return;

    const bottom = Math.max(0, thread.scrollHeight - thread.clientHeight);
    thread.scrollTo({ top: bottom, behavior });
    if (behavior === 'auto') thread.scrollTop = bottom;
    lastThreadScrollTopRef.current = thread.scrollTop;
    pendingThreadRestoreRef.current = null;
    if (targetId) {
      session.writeUI(`scroll:${targetId}`, thread.scrollTop, 0);
      session.writeUI(`scrollFollow:${targetId}`, true, true);
    }
    userReadingHistoryRef.current = false;
    setNewMessagesBelow(0);
  }

  function scheduleMessageThreadScroll(behavior: ScrollBehavior = "smooth") {
    pendingThreadRestoreRef.current = null;
    userReadingHistoryRef.current = false;
    pendingThreadScrollRef.current = behavior;
  }

  function followThreadContent() {
    if ((userReadingHistoryRef.current && pendingThreadRestoreRef.current === null) || threadFollowFrameRef.current !== null) return;
    const targetId = selectedConversationIdRef.current;
    threadFollowFrameRef.current = window.requestAnimationFrame(() => {
      threadFollowFrameRef.current = null;
      if (!targetId || targetId !== selectedConversationIdRef.current) return;
      const restore = pendingThreadRestoreRef.current; const thread = messageThreadRef.current;
      if (restore !== null && thread) {
        const bottom = Math.max(0, thread.scrollHeight - thread.clientHeight);
        thread.scrollTop = Math.min(restore, bottom); lastThreadScrollTopRef.current = thread.scrollTop;
        if (bottom - restore > 1) pendingThreadRestoreRef.current = null;
      } else if (!userReadingHistoryRef.current) scrollMessageThreadToBottom('auto');
    });
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



  const listKey = useMemo(() => session.key('conversations', activeView, selectedChannelFilter, searchQuery), [session, activeView, selectedChannelFilter, searchQuery]);
  const messagesKey = useMemo(() => session.key('messages', selectedConversationId), [session, selectedConversationId]);
  const contextKey = useMemo(() => session.key('context', selectedConversationId), [session, selectedConversationId]);
  const listFilters = useMemo(() => ({ status: 'all' as const, view: activeView,
    ...(searchQuery ? { search: searchQuery } : {}),
    ...(selectedChannelFilter !== 'all' ? { channelId: selectedChannelFilter } : {})
  }), [activeView, selectedChannelFilter, searchQuery]);
  const paginationKey = `pagination:${JSON.stringify(listKey)}`;
  const pagesKey = `pages:${JSON.stringify(listKey)}`;
  const listQuery = useQuery({ queryKey: listKey,
    queryFn: ({ signal }) => session.readConversations(() => withReadDeadline(signal, async deadline => {
      // A reconciliation includes every page committed by an already-running pagination.
      if (paginationCompletionRef.current) await abortable(paginationCompletionRef.current, deadline);
      const pageCount = session.readUI(pagesKey, 1);
      const rows = new Map<string, ConversationDto>();
      let cursor: string | undefined;
      let nextCursor: string | null = null;
      let loadedPages = 0;
      for (let page = 0; page < pageCount; page++) {
        const raw = await apiGetConversations(getFreshToken, { ...listFilters, ...(cursor ? { cursor } : {}) }, deadline);
        deadline.throwIfAborted(); loadedPages++;
        for (const row of raw) rows.set(row.id, row);
        nextCursor = raw.length === CONVERSATION_PAGE_SIZE ? raw.at(-1)!.id : null;
        if (!nextCursor) break;
        cursor = nextCursor;
      }
      session.writeUI(paginationKey, nextCursor, null);
      session.writeUI(pagesKey, loadedPages, 1);
      return [...rows.values()];
    }), listFilters, { signal }) });
  const messagesQuery = useQuery({ queryKey: messagesKey, enabled: Boolean(selectedConversationId),
    queryFn: ({ signal }) => session.readMessages(selectedConversationId!, () => apiGetConversationMessages(selectedConversationId!, getFreshToken, signal), signal) });
  const contextQuery = useQuery({ queryKey: contextKey, enabled: Boolean(selectedConversationId && !selectedConversationSnapshot?.isGroup),
    queryFn: ({ signal }) => session.readContext(selectedConversationId!, () => apiGetConversationContext(selectedConversationId!, getFreshToken, signal)) });
  const channelsQuery = useQuery({ queryKey: session.key('channels'), staleTime: CATALOG_STALE_MS,
    queryFn: ({ signal }) => apiGetChannels(getFreshToken, signal) });
  const tagsQuery = useQuery({ queryKey: session.key('tags'), staleTime: CATALOG_STALE_MS,
    queryFn: ({ signal }) => apiGetTags(getFreshToken, signal) });
  const quickRepliesKey = useMemo(() => session.key('quickReplies'), [session]);
  const quickRepliesQuery = useQuery({ queryKey: quickRepliesKey, enabled: showQuickReplies, staleTime: CATALOG_STALE_MS,
    queryFn: ({ signal }) => apiGetQuickReplies(getFreshToken, signal) });
  const attentionQuery = useQuery({ queryKey: session.key('attention', selectedChannelFilter),
    queryFn: ({ signal }) => session.readAttention(selectedChannelFilter, () => apiGetAttentionCount(getFreshToken, selectedChannelFilter === 'all' ? undefined : selectedChannelFilter, signal)) });
  const conversations = listQuery.data ?? EMPTY_CONVERSATIONS;
  const messages = messagesQuery.data ?? EMPTY_MESSAGES;
  const messagesConversationId = messagesQuery.data ? selectedConversationId : null;
  const contactContext = contextQuery.data ?? null;
  const channels = channelsQuery.data ?? EMPTY_CHANNELS;
  const showChannelOrigin = channels.length > 1;
  const tagCatalog = useMemo(() => (tagsQuery.data ?? EMPTY_TAGS).filter(tag => tag.isActive), [tagsQuery.data]);
  const quickReplies = quickRepliesQuery.data ?? EMPTY_QUICK_REPLIES;
  const isLoading = listQuery.isFetching;
  const isLoadingMessages = messagesQuery.isFetching;
  const isLoadingContext = contextQuery.isFetching;
  const isQuickRepliesLoading = quickRepliesQuery.isFetching;
  const quickRepliesError = quickRepliesQuery.error?.message ?? null;
  const contextError = contextActionError ?? contextQuery.error?.message ?? null;
  const error = actionError ?? listQuery.error?.message ?? null;
  const humanAttentionCount = attentionQuery.data ?? 0;
  const currentRole = currentUser.role;
  const setConversations = useCallback((next: SetStateAction<ConversationDto[]>) => {
    if (!session.isLive) return;
    session.client.setQueryData<ConversationDto[]>(listKey, current => typeof next === 'function' ? next(current ?? []) : next);
  }, [session, listKey]);
  const setMessages = useCallback((next: SetStateAction<MessageDto[]>) => {
    const id = messagesKey[3]; if (typeof id !== 'string') return;
    session.updateMessages(id, current => typeof next === 'function' ? next(current) : next);
  }, [session, messagesKey]);
  const setContactContext = useCallback((next: ContactContextDto | null) => {
    if (!session.isLive) return;
    session.client.setQueryData(contextKey, next);
  }, [session, contextKey]);
  const setQuickReplies = useCallback((next: SetStateAction<QuickReplyDto[]>) => {
    if (!session.isLive) return;
    session.client.setQueryData<QuickReplyDto[]>(quickRepliesKey, current => typeof next === 'function' ? next(current ?? []) : next);
  }, [session, quickRepliesKey]);
  useEffect(() => {
    session.setActive(selectedConversationId);
    return () => session.setActive(null);
  }, [session, selectedConversationId]);
  useEffect(() => {
    ++conversationListGenerationRef.current;
    loadingMoreConversationsRef.current = false;
    setIsLoadingMoreConversations(false); setLoadMoreError(null);
  }, [listKey]);
  useEffect(() => {
    if (!listQuery.data) return;
    conversationCursorRef.current = session.readUI<string | null>(paginationKey, null);
    setHasMoreConversations(Boolean(conversationCursorRef.current));
    const requestedId = readConversationIdFromUrl();
    setSelectedConversationId(current => current ?? (requestedId && listQuery.data.some(row => row.id === requestedId) ? requestedId : listQuery.data[0]?.id ?? null));
  }, [listQuery.data, setSelectedConversationId, session, paginationKey]);
  useEffect(() => {
    if (conversationReloadKey) void session.client.invalidateQueries({ queryKey: session.key('conversations') });
  }, [session, conversationReloadKey]);
  useEffect(() => {
    if (attentionCountReloadKey) void session.client.invalidateQueries({ queryKey: session.key('attention') });
  }, [session, attentionCountReloadKey]);
  useEffect(() => {
    setMessageError(messagesQuery.error?.message ?? null);
  }, [messagesQuery.error, selectedConversationId]);
  const recognizedMessages = useRef(new Set<string>());
  const listScrollKey = `scroll:list:${activeView}:${selectedChannelFilter}:${searchQuery}`;
  useLayoutEffect(() => {
    if (conversationListRef.current && listQuery.data) conversationListRef.current.scrollTop = session.readUI(listScrollKey, 0);
  }, [session, listScrollKey, Boolean(listQuery.data)]);
  useEffect(() => {
    if (!selectedConversationId || !messagesQuery.data) return;
    let active = true;
    for (const unknown of messagesQuery.data.filter(message => message.type === 'system' && message.body === 'Mensagem não reconhecida' && message.providerMessageId && !recognizedMessages.current.has(message.id)).slice(0, 3)) {
      recognizedMessages.current.add(unknown.id);
      void apiRecognizeContactMessage(selectedConversationId, unknown.id, getFreshToken).then(recognized => {
        if (!active) return;
        if ('removedMessageId' in recognized) {
          setMessages(current => current.filter(message => message.id !== recognized.removedMessageId));
          setConversationReloadKey(current => current + 1);
        } else setMessages(current => current.map(message => message.id === recognized.id ? recognized : message));
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [messagesQuery.data, selectedConversationId, getFreshToken, setMessages]);

  const paginationController = useRef<AbortController | null>(null);
  useEffect(() => () => paginationController.current?.abort(), [listKey]);

  const loadMoreConversations = useCallback(async () => {
    const cursor = conversationCursorRef.current;
    if (!cursor || loadingMoreConversationsRef.current || session.client.getQueryState(listKey)?.fetchStatus === 'fetching') return;
    const generation = conversationListGenerationRef.current;
    loadingMoreConversationsRef.current = true;
    setIsLoadingMoreConversations(true);
    setLoadMoreError(null);
    let finishPagination!: () => void;
    const completion = new Promise<void>(resolve => { finishPagination = resolve; });
    paginationCompletionRef.current = completion;

    try {
      paginationController.current?.abort();
      const controller = new AbortController(); paginationController.current = controller;
      let nextCursor: string | null = null;
      const page = await session.readConversations(async () => {
        const raw = await apiGetConversations(getFreshToken, { ...listFilters, cursor }, controller.signal);
        controller.signal.throwIfAborted();
        nextCursor = raw.length === CONVERSATION_PAGE_SIZE ? raw.at(-1)!.id : null;
        return raw;
      }, listFilters, { signal: controller.signal, manualCommit: true });
      controller.signal.throwIfAborted();
      if (generation !== conversationListGenerationRef.current) return;
      session.writeUI(paginationKey, nextCursor, null);
      session.writeUI(pagesKey, session.readUI(pagesKey, 1) + 1, 1);
      session.commitConversationPage(listKey, page, mergeConversationPage);
      conversationCursorRef.current = nextCursor;
      setHasMoreConversations(Boolean(conversationCursorRef.current));
    } catch (loadError) {
      if (generation === conversationListGenerationRef.current) {
        setLoadMoreError(loadError instanceof Error ? loadError.message : "Não foi possível carregar mais conversas.");
      }
    } finally {
      finishPagination();
      if (paginationCompletionRef.current === completion) paginationCompletionRef.current = null;
      if (generation === conversationListGenerationRef.current) {
        loadingMoreConversationsRef.current = false;
        setIsLoadingMoreConversations(false);
      }
    }
  }, [getFreshToken, activeView, selectedChannelFilter, searchQuery, session, listFilters, listKey, paginationKey, pagesKey]);

  useEffect(() => {
    if (!dismissUndo) return;
    const timer = window.setTimeout(() => setDismissUndo(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [dismissUndo]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.workspaceId !== session.workspaceId) return;
    if (event.type === 'message.created' && event.payload.conversationId === selectedConversationIdRef.current) {
      if (!userReadingHistoryRef.current) scheduleMessageThreadScroll('smooth');
      else setNewMessagesBelow(current => current + 1);
    }
    if (event.type === 'conversation.updated' && event.payload.id === selectedConversationIdRef.current) {
      setSelectedConversationSnapshot(event.payload);
    }
  }, [session, setSelectedConversationSnapshot]);
  useRealtimeEvents({ token, onEvent: handleRealtimeEvent });

  const channelFilterOptions = useMemo(
    () => getChannelFilterOptions(conversations, channels),
    [conversations, channels]
  );
  const visibleConversations = conversations;

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
    const current = conversations.find((conversation) => conversation.id === selectedConversationId);
    if (current) setSelectedConversationSnapshot(current);
  }, [conversations, selectedConversationId]);

  const selectedConversation = useMemo(
    () => resolveSelectedConversation(visibleConversations, selectedConversationId, selectedConversationSnapshot),
    [visibleConversations, selectedConversationId, selectedConversationSnapshot]
  );
  const assistant = useAssistantConversation(selectedConversation?.isGroup ? null : selectedConversationId, getToken, `${selectedConversation?.lastMessageAt ?? ''}:${selectedConversation?.aiControlStatus ?? ''}:${selectedConversation?.handoffActionCompletedAt ?? ''}`);
  const beginPerformance = useTalkPerformance(selectedConversationId, selectedConversation?.id ?? null, messagesQuery.data);
  const visibleMessages = messagesConversationId === selectedConversationId ? messages : EMPTY_MESSAGES;
  const thread = useMemo(() => threadWithReactions(visibleMessages), [visibleMessages]);
  useEffect(() => { setReplyTarget(current => current && current.conversationId !== selectedConversationId ? null : current); }, [selectedConversationId]);
  const handoffEnabled = Boolean(selectedConversation && !selectedConversation.isGroup && needsHumanAttention(selectedConversation));
  const handoff = useHandoffBrief(selectedConversationId, handoffEnabled, selectedConversation?.lastMessageAt, getToken);
  const handoffBrief = useMemo(() => handoffEnabled ? handoff.data ?? {
    status: handoff.error ? 'failed' as const : 'pending' as const,
    nextAction: null, summary: null, contextKey: null, updatedAt: null,
    error: handoff.error
  } : null, [handoffEnabled, handoff.data, handoff.error]);
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
  const isThreadTransitioning = Boolean(selectedConversationId) && messagesConversationId !== selectedConversationId && isLoadingMessages;
  async function saveContactName(contactId: string, name: string) {
    const saved = await apiUpdateContact(getToken, contactId, { name });
    setConversations(current => current.map(conversation => conversation.contactId === saved.id
      ? { ...conversation, contactName: saved.name, contactPhone: saved.phone } : conversation));
  }
  const contextNotes = contactContext?.notes ?? EMPTY_NOTES;
  const visibleNotes = useMemo(() => notesHistoryOpen ? contextNotes : contextNotes.slice(0, 2), [notesHistoryOpen, contextNotes]);
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

  useLayoutEffect(() => {
    pendingThreadRestoreRef.current = null;
    if (!selectedConversationId || !messagesQuery.data || !messageThreadRef.current) return;
    const saved = openedThreadRef.current === null ? session.readUI<number | null>(`scroll:${selectedConversationId}`, null) : null;
    const following = session.readUI<boolean | null>(`scrollFollow:${selectedConversationId}`, null);
    openedThreadRef.current = selectedConversationId;
    if (saved !== null && following !== true) {
      messageThreadRef.current.scrollTop = saved;
      lastThreadScrollTopRef.current = messageThreadRef.current.scrollTop;
      userReadingHistoryRef.current = following === false || !isMessageThreadNearBottom();
      if (userReadingHistoryRef.current && messageThreadRef.current.scrollHeight - messageThreadRef.current.clientHeight - saved <= 1) pendingThreadRestoreRef.current = saved;
    } else scrollMessageThreadToBottom('auto', selectedConversationId);
  }, [selectedConversationId, Boolean(messagesQuery.data), session]);
  useLayoutEffect(() => {
    const content = messageContentRef.current;
    if (!content || !selectedConversationId || !messagesQuery.data) return;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(followThreadContent) : null;
    observer?.observe(content);
    return () => {
      observer?.disconnect();
      if (threadFollowFrameRef.current !== null) window.cancelAnimationFrame(threadFollowFrameRef.current);
      threadFollowFrameRef.current = null;
    };
  }, [selectedConversationId, Boolean(messagesQuery.data)]);
  useEffect(() => {
    if (!pendingThreadScrollRef.current) return;

    const behavior = pendingThreadScrollRef.current;
    pendingThreadScrollRef.current = null;

    const targetId = selectedConversationId;
    const frame = window.requestAnimationFrame(() => {
      if (targetId === selectedConversationIdRef.current && !userReadingHistoryRef.current) scrollMessageThreadToBottom(behavior);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversation || !needsHumanAttention(selectedConversation)) return;

    setAcknowledgedHandoffIds((current) => new Set(current).add(selectedConversation.id));
  }, [selectedConversation]);

  const markingRead = useRef(new Set<string>());
  useEffect(() => {
    if (!selectedConversation || selectedConversation.unreadCount === 0 || markingRead.current.has(selectedConversation.id)) return;

    const targetConversationId = selectedConversation.id;
    markingRead.current.add(targetConversationId);

    void apiMarkConversationRead(getFreshToken, targetConversationId)
      .then((conversation) => {
        setConversations((current) =>
          current.map((item) => item.id === conversation.id && item.lastMessageAt === conversation.lastMessageAt
            ? { ...item, unreadCount: conversation.unreadCount } : item)
        );
        if (selectedConversationIdRef.current === conversation.id) {
          setSelectedConversationSnapshot(current => current?.id === conversation.id && current.lastMessageAt === conversation.lastMessageAt
            ? { ...current, unreadCount: conversation.unreadCount } : current);
        }
      })
      .catch(() => undefined)
      .finally(() => markingRead.current.delete(targetConversationId));
  }, [getFreshToken, selectedConversation?.id, selectedConversation?.unreadCount, setConversations, setSelectedConversationSnapshot]);


  async function handleSendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pendingFile) {
      const file = pendingFile;
      const targetId = selectedConversationId;
      try { await sendAttachment(file); session.writeUI<File | null>(`draftFile:${targetId}`, current => current === file ? null : current, null); }
      catch { /* sendAttachment displays the error beside the composer. */ }
      return;
    }

    if (!selectedConversationId || !draft.trim()) return;
    if (composerOrigin) {
      if (isSending) return;
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
      ...(replyTarget?.whatsappId ? { quoted: { whatsappId: replyTarget.whatsappId, participant: replyTarget.senderJid ?? null, body: replyTarget.body } } : {}),
      createdAt: new Date().toISOString()
    };

    // Like WhatsApp: the composer is free again at once. Texts of one conversation still reach the server one after
    // another, in the order they were typed, through a per-conversation queue.
    setMessageError(null);
    session.writeUI(`sendFailure:${targetConversationId}`, null, null);
    setDraft("");
    session.updateMessages(targetConversationId, current => [...current, optimisticMessage]);
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

    const previous = textSendQueue.current.get(targetConversationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => apiCreateConversationMessage(
      targetConversationId,
      { body: messageBody, ...(replyTarget ? { replyToMessageId: replyTarget.id } : {}) },
      getFreshToken
    ));
    textSendQueue.current.set(targetConversationId, current);
    setReplyTarget(null);
    try {
      const createdMessage = await current;

      session.updateMessages(targetConversationId, current => upsertMessage(current, createdMessage, optimisticMessage.id));
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
      recordSendFailure(targetConversationId, optimisticMessage.id, sendError, 'Não foi possível enviar a mensagem.', messageBody);
    } finally {
      if (textSendQueue.current.get(targetConversationId) === current) textSendQueue.current.delete(targetConversationId);
    }
  }

  function recordSendFailure(targetId: string, optimisticId: string, failure: unknown, fallback: string, text: string, file?: File) {
    if (!session.isLive) return;
    session.updateMessages(targetId, current => current.map(message =>
      message.id === optimisticId && message.status === 'pending' ? { ...message, status: 'failed' } : message));
    const error = failure instanceof Error ? failure.message : fallback;
    session.writeUI(`sendFailure:${targetId}`, { generation: optimisticId, message: `${error} Confira o histórico antes de reenviar.` }, null);
    const hasNewText = session.readUI(`draft:${targetId}`, '').trim().length > 0;
    const hasNewOrigin = Boolean(session.readUI(`draftOrigin:${targetId}`, null));
    const currentFile = session.readUI<File | null>(`draftFile:${targetId}`, null);
    const hasNewFile = Boolean(currentFile && currentFile !== file);
    if (!hasNewText && !hasNewOrigin && !hasNewFile) {
      session.writeUI(`draft:${targetId}`, text, '');
      if (file) session.writeUI<File | null>(`draftFile:${targetId}`, current => current ?? file, null);
    }
  }

  function stageAttachment(file: File) {
    if (!selectedConversationId) return;
    if (file.size > 8 * 1024 * 1024) { setMessageError('Envie um arquivo de até 8 MB.'); return; }
    if (composerOrigin) { setMessageError('Envie primeiro o texto em revisão. Depois anexe o arquivo em uma nova mensagem.'); return; }
    const serviceWindowError = metaServiceWindowSendError(selectedConversation);
    if (serviceWindowError) { setMessageError(serviceWindowError); return; }
    setMessageError(null);
    setPendingFile(file);
  }

  function hasDraggedFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function handleChatDragEnter(event: DragEvent<HTMLElement>) {
    if (!selectedConversationId || !hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFile(true);
  }

  function handleChatDragLeave(event: DragEvent<HTMLElement>) {
    if (!isDraggingFile) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFile(false);
  }

  function handleChatDrop(event: DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFile(false);
    const file = event.dataTransfer.files[0];
    if (file) stageAttachment(file);
  }

  function handleFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) stageAttachment(file);
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
    session.writeUI(`sendFailure:${targetConversationId}`, null, null);
    if (!voice) setDraft("");
    session.updateMessages(targetConversationId, current => [...current, optimisticMessage]);
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

      session.updateMessages(targetConversationId, current => upsertMessage(current, createdMessage, optimisticMessage.id));
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
      recordSendFailure(targetConversationId, optimisticMessage.id, sendError, 'Não foi possível enviar o arquivo.', caption, file);
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
      if (body.action === "complete_handoff_action" && activeView === "handoff") setActiveView("all");
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

  async function deleteMessageForEveryone(message: MessageDto) {
    if (!selectedConversationId || deletingMessageId ||
      !window.confirm('Apagar esta mensagem para todos no WhatsApp?')) return;
    const targetConversationId = selectedConversationId;
    setDeletingMessageId(message.id);
    setMessageError(null);
    try {
      const updated = await apiDeleteMessageForEveryone(targetConversationId, message.id, getFreshToken);
      setMessages((current) => current.map((item) => item.id === updated.id ? updated : item));
      setConversations((current) => current.map((item) => item.id === targetConversationId &&
        item.lastMessageAt === message.createdAt ? { ...item, lastMessagePreview: updated.body } : item));
    } catch (error) {
      setMessageError(error instanceof Error ? error.message : 'Não foi possível apagar a mensagem para todos.');
    } finally {
      setDeletingMessageId(null);
    }
  }

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
    if (!session.isLive) return;
    session.event({ type: 'conversation.updated', workspaceId: session.workspaceId, payload: result.conversation });
    session.client.setQueryData(session.key('context', targetConversationId), result.context);
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

  async function handleManualMark(conversation: ConversationDto) {
    if (actionBusyConversationId) return;
    setActionBusyConversationId(conversation.id);
    setError(null);
    try {
      const updated = await apiSetManualMark(getFreshToken, conversation.id, !conversation.manualMarked);
      if (selectedConversationIdRef.current === conversation.id) setSelectedConversationSnapshot(updated);
      if (activeView === "all") setConversations((current) => upsertConversation(current, updated));
      else setConversationReloadKey((current) => current + 1);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Não foi possível atualizar a marcação.");
    } finally {
      setActionBusyConversationId(null);
    }
  }

  async function handleDismissReply(conversation: ConversationDto) {
    const anchorMessageId = conversation.replyTriageAnchorMessageId;
    if (!anchorMessageId || actionBusyConversationId) return;
    setActionBusyConversationId(conversation.id);
    setError(null);
    try {
      const updated = await apiDismissReply(getFreshToken, conversation.id, anchorMessageId);
      if (selectedConversationIdRef.current === conversation.id) setSelectedConversationSnapshot(updated);
      setDismissUndo({ conversationId: conversation.id, anchorMessageId });
      setConversationReloadKey((current) => current + 1);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Não foi possível dispensar a resposta.");
    } finally {
      setActionBusyConversationId(null);
    }
  }

  async function handleUndoDismiss() {
    if (!dismissUndo || actionBusyConversationId) return;
    setActionBusyConversationId(dismissUndo.conversationId);
    setError(null);
    try {
      const updated = await apiUndoReply(getFreshToken, dismissUndo.conversationId, dismissUndo.anchorMessageId);
      if (selectedConversationIdRef.current === updated.id) setSelectedConversationSnapshot(updated);
      setDismissUndo(null);
      setConversationReloadKey((current) => current + 1);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Não foi possível desfazer.");
    } finally {
      setActionBusyConversationId(null);
    }
  }

  // Actions read the current composer/context; memoized sections never capture an old draft.
  const actionsRef = useRef({ handleManualMark, handleDismissReply, handleUndoDismiss, deleteMessageForEveryone,
    runAction, handleCreateLead, resetSelectedConversation, handleRemoveTag, saveContactName, handleAddTag, handleAddNote, sendSuggestion, editSuggestion });
  actionsRef.current = { handleManualMark, handleDismissReply, handleUndoDismiss, deleteMessageForEveryone,
    runAction, handleCreateLead, resetSelectedConversation, handleRemoveTag, saveContactName, handleAddTag, handleAddNote, sendSuggestion, editSuggestion };
  const conversationListView = useMemo(() => (
<section className="conversation-list" aria-label="Atendimento">
        <header className="list-header">
          <div>
            <p className="eyebrow">Prymeira Talk</p>
            <h1>Atendimento</h1>
          </div>
          <div className="inbox-list-header-actions"><button type="button" className="inbox-header-icon" aria-label="Nova conversa por número" title="Nova conversa por número" onClick={() => setNewConversationOpen(true)}><MessageSquarePlus size={18} /></button><button type="button" className="inbox-header-icon" aria-label="Enviar mensagem para várias pessoas" title="Enviar para várias pessoas" onClick={() => setQuickSendOpen(true)}><Users size={18} /></button><span className="live-indicator">{token ? "Online" : "Conectando"}</span></div>
        </header>

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

        <div className="inbox-search-filters">
          <InboxQuickFilters value={activeView} onChange={setActiveView} />
          <button type="button" className={`inbox-search-toggle${searchOpen ? " is-active" : ""}`}
            aria-label="Buscar conversa" title="Buscar conversa" aria-expanded={searchOpen}
            onClick={() => { setSearchOpen((current) => !current); if (searchOpen) { setSearchDraft(""); setSearchQuery(""); } }}>
            <Search size={18} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
        {searchOpen ? <div className="inbox-search-field">
          <Search size={16} aria-hidden="true" />
          <input autoFocus aria-label="Nome ou telefone" placeholder="Nome ou telefone" value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)} />
          {searchDraft ? <button type="button" aria-label="Limpar busca" onClick={() => setSearchDraft("")}><X size={16} /></button> : null}
        </div> : null}

        <div className="attention-filter-row" role="group" aria-label="Visualização das conversas">
          <button
            aria-pressed={activeView !== "handoff"}
            className={`attention-filter-button${activeView !== "handoff" ? " is-active" : ""}`}
            onClick={() => setActiveView("all")}
            type="button"
          >
            Conversas
          </button>
          <button
            aria-label={`Próxima ação: ${humanAttentionCount} conversas com humano necessário`}
            aria-pressed={activeView === "handoff"}
            className={`attention-filter-button attention-filter-button--human${activeView === "handoff" ? " is-active" : ""}`}
            onClick={() => setActiveView("handoff")}
            type="button"
          >
            <TriangleAlert size={14} aria-hidden="true" />
            Próxima ação
            <span className={`attention-filter-count${humanAttentionCount > 0 ? " has-items" : ""}`} aria-hidden="true">
              {humanAttentionCount}
            </span>
          </button>
        </div>

        {/* Background refreshes stay silent; the note is only for an empty list that is still loading. */}
        {isLoading && visibleConversations.length === 0 ? <p className="list-note">Carregando conversas...</p> : null}
        {error ? <p className="error-note" role="status">{error} <button type="button" onClick={() => void listQuery.refetch()}>Tentar novamente</button></p> : null}
        {sendNotice ? <div className="inbox-send-notice" role="status">{sendNotice}<button type="button" aria-label="Fechar aviso" onClick={() => setSendNotice(null)}><X size={14} /></button></div> : null}
        {dismissUndo ? <div className="inbox-undo-toast" role="status">
          Indicação dispensada.
          <button type="button" onClick={() => void actionsRef.current.handleUndoDismiss()}>Desfazer</button>
        </div> : null}

        <div className="conversation-items" ref={conversationListRef} onScroll={(event) => {
          const list = event.currentTarget;
          session.writeUI(listScrollKey, list.scrollTop, 0);
          if (list.scrollHeight - list.scrollTop - list.clientHeight < 160) {
            void loadMoreConversations();
          }
        }}>
          {!isLoading && !hasMoreConversations && visibleConversations.length === 0 ? (
            <p className="list-note">
              {activeView === "handoff"
                ? "Nenhuma conversa aguardando ação humana neste canal."
                : searchQuery ? "Nenhuma conversa encontrada para esta busca." : "Nenhuma conversa encontrada para este canal."}
            </p>
          ) : null}
          {visibleConversations.map((conversation) => {
            const conversationNeedsHuman = needsHumanAttention(conversation);
            const showHumanAttention =
              conversationNeedsHuman &&
              conversation.id !== selectedConversationId &&
              !acknowledgedHandoffIds.has(conversation.id);
            const controlBadge = conversation.isGroup ? null : getConversationControlBadge(conversation, showHumanAttention);
            const conversationAriaLabel = [
              `Abrir conversa com ${contactDisplayName(conversation)}`,
              controlBadge?.label
            ].filter(Boolean).join(". ");
            const showSemanticDismiss = activeView === "reply" && !conversationNeedsHuman &&
              (conversation.replyTriageDecision === "needs_reply" || conversation.replyTriageDecision === "uncertain") &&
              Boolean(conversation.replyTriageAnchorMessageId) && !conversation.replyDismissed;

            return (
            <div
              className={[
                "conversation-card",
                conversation.id === selectedConversationId ? "is-selected" : "",
                showHumanAttention ? "needs-human-attention" : ""
              ].filter(Boolean).join(" ")}
              key={conversation.id}
            >
              <button
                type="button"
                className="conversation-card-main"
                aria-label={conversationAriaLabel}
                onPointerEnter={() => session.prefetch(conversation.id, signal => apiGetConversationMessages(conversation.id, getFreshToken, signal))}
                onFocus={() => session.prefetch(conversation.id, signal => apiGetConversationMessages(conversation.id, getFreshToken, signal))}
                onPointerLeave={() => session.cancelPrefetch(conversation.id)}
                onBlur={() => session.cancelPrefetch(conversation.id)}
                onClick={() => {
                  beginPerformance(conversation.id, session.client.getQueryData(session.key('messages', conversation.id)) !== undefined);
                  setSelectedConversationId(conversation.id);
                  setSelectedConversationSnapshot(conversation);
                  if (conversationNeedsHuman) {
                    setAcknowledgedHandoffIds((current) => new Set(current).add(conversation.id));
                  }
                }}
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
                  <span className="conv-title-col">
                  <span className="conv-name-wrap">
                    <strong>{contactDisplayName(conversation)}</strong>
                    {conversation.isGroup ? <span className="conv-dept-tag"><Users size={12} aria-hidden="true" /> Grupo</span> : null}
                    {conversation.departmentName ? (
                      <span className="conv-dept-tag">{conversation.departmentName}</span>
                    ) : null}
                    {conversationNeedsHuman ? (
                      <span className="conv-human-tag">Humano necessário</span>
                    ) : null}
                    {activeView === "reply" && conversation.replyTriageDecision === "uncertain" && !conversationNeedsHuman ? (
                      <span className="conv-review-tag">Revisar</span>
                    ) : null}
                  </span>
                  {/* Only workspaces with more than one number need to know which one the conversation came through. */}
                  {showChannelOrigin ? <span className="conversation-channel-origin">via {conversation.channelName ?? "Canal sem nome"}</span> : null}
                  </span>
                  <span className="conv-meta-right">
                    <ConversationCardTime value={conversationPreviewTime(conversation)} />
                    {conversation.unreadCount > 0 ? (
                      <span className="conv-unread-badge">
                        {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                      </span>
                    ) : null}
                  </span>
                </span>
                <ConversationPreview conversation={conversation} />
              </span>
              </button>
              <div className="conversation-card-actions">
                <button
                  type="button"
                  className={`conversation-card-icon${conversation.manualMarked ? " is-marked" : ""}`}
                  aria-label={conversation.manualMarked ? "Remover marcação" : "Marcar para cuidar depois"}
                  aria-pressed={Boolean(conversation.manualMarked)}
                  title={conversation.manualMarked ? "Remover marcação" : "Marcar para cuidar depois"}
                  disabled={actionBusyConversationId === conversation.id}
                  onClick={() => void actionsRef.current.handleManualMark(conversation)}
                ><Bookmark size={17} fill={conversation.manualMarked ? "currentColor" : "none"} aria-hidden="true" /></button>
                {showSemanticDismiss ? <button
                  type="button"
                  className="conversation-card-icon"
                  aria-label="Não precisa responder"
                  title="Não precisa responder"
                  disabled={actionBusyConversationId === conversation.id}
                  onClick={() => void actionsRef.current.handleDismissReply(conversation)}
                ><MessageCircleX size={17} aria-hidden="true" /></button> : null}
              </div>
            </div>
            );
          })}
          {loadMoreError ? <p className="error-note">{loadMoreError}</p> : null}
          {hasMoreConversations ? (
            <button
              className="conversation-load-more"
              disabled={isLoadingMoreConversations || isLoading}
              onClick={() => void loadMoreConversations()}
              type="button"
            >
              {isLoadingMoreConversations ? "Carregando conversas..." : "Carregar conversas anteriores"}
            </button>
          ) : null}
        </div>
      </section>
  ), [token, channelFilterOptions, selectedChannelFilter, activeView, searchOpen, searchDraft, searchQuery,
    humanAttentionCount, isLoading, error, sendNotice, dismissUndo, hasMoreConversations, visibleConversations,
    selectedConversationId, acknowledgedHandoffIds, actionBusyConversationId, loadMoreError, isLoadingMoreConversations,
    loadMoreConversations, session, getFreshToken, setSelectedConversationId, setSelectedConversationSnapshot,
    setActiveView, setSelectedChannelFilter, setSearchDraft, setSearchQuery, setSearchOpen, listQuery.refetch, beginPerformance, listScrollKey]);
  const historyView = useMemo(() => (
selectedConversation ? (
          <div
            className="message-thread"
            aria-label="Histórico da conversa"
            onScroll={() => {
              const thread = messageThreadRef.current;
              if (!thread || !selectedConversationId || messagesConversationId !== selectedConversationId) return;
              const restore = pendingThreadRestoreRef.current;
              if (restore !== null && thread.scrollTop >= lastThreadScrollTopRef.current) {
                lastThreadScrollTopRef.current = thread.scrollTop; followThreadContent(); return;
              }
              pendingThreadRestoreRef.current = null;
              session.writeUI(`scroll:${selectedConversationId}`, thread.scrollTop, 0);
              const distanceFromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
              if (thread.scrollTop < lastThreadScrollTopRef.current && distanceFromBottom > 1) {
                userReadingHistoryRef.current = true;
              } else if (distanceFromBottom <= 1) {
                userReadingHistoryRef.current = false;
                setNewMessagesBelow(0);
              }
              lastThreadScrollTopRef.current = thread.scrollTop;
              session.writeUI(`scrollFollow:${selectedConversationId}`, !userReadingHistoryRef.current, true);
            }}
            onLoadCapture={followThreadContent}
            ref={messageThreadRef}
          >
            <div className="message-thread-content" ref={messageContentRef}>
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
            {messageError ? <p className="error-note" role="status">{messageError} <button type="button" onClick={() => {
              const targetId = selectedConversationId!; const consultedGeneration = sendFailure?.generation;
              void session.refetchMessages(targetId, signal => apiGetConversationMessages(targetId, getFreshToken, signal)).then(() => {
                session.writeUI<{ generation: string; message: string } | null>(`sendFailure:${targetId}`,
                  current => current?.generation === consultedGeneration ? null : current, null);
              }).catch(() => {});
            }}>{sendFailure ? 'Conferir histórico' : 'Tentar novamente'}</button></p> : null}
            {!messageError && !isLoadingMessages && !isThreadTransitioning && visibleMessages.length === 0 ? (
              <p className="thread-note">Ainda não ha mensagens nesta conversa.</p>
            ) : null}
            {thread.visible.map((message) => {
              const isInbound = message.direction === "inbound";
              const isMedia = ['image', 'audio', 'file'].includes(message.type);
              // Plain text keeps its time on the last line, like WhatsApp; media, maps and cards keep it below.
              const inlineMeta = !isMedia && !message.location && !message.contactCards?.length;
              const meta = <>
                {message.editedAt ? <span className="message-edited-label">Editada</span> : null}
                <time>{formatMessageTime(message.createdAt)}</time>
                {!isInbound && ['sent', 'delivered', 'read'].includes(message.status) ? <MessageTicks status={message.status} /> : null}
              </>;
              const canReply = selectedConversation.channelProvider === 'evolution' && Boolean(message.whatsappId) && !message.deletedAt && message.type !== 'system';
              const canDelete = selectedConversation.channelProvider === 'evolution' && !selectedConversation.isGroup && message.direction === 'outbound' &&
                Boolean(message.providerMessageId || message.whatsappId) && !message.deletedAt && ['sent', 'delivered', 'read'].includes(message.status);
              const senderName = selectedConversation.isGroup ? message.senderName ?? message.senderJid : selectedConversation.contactName;
              return (
              <article
                className={`message-bubble ${isInbound ? "is-inbound" : "is-outbound"}`}
                data-message-id={message.id}
                key={message.id}
              >
                {isInbound ? (
                  <ContactAvatar conversationId={selectedConversation?.id} name={senderName} className="msg-avatar" />
                ) : null}
                <div className={`msg-bubble-body${inlineMeta ? ' has-inline-meta' : ''}`}>
                  {selectedConversation.isGroup && isInbound ? <strong className="group-message-sender">{message.senderName?.trim() || message.senderJid?.split('@')[0] || 'Participante'}</strong> : null}
                  {message.quoted ? (() => { const quote = quotedPreview(message.quoted, visibleMessages, selectedConversation.contactName ?? null); return (
                    <button type="button" className={`message-quote${quote.author === 'Você' ? ' is-mine' : ''}`} disabled={!quote.targetId}
                      aria-label={`Mensagem respondida de ${quote.author}`} onClick={() => quote.targetId && revealMessage(quote.targetId)}>
                      <strong>{quote.author}</strong><span>{quote.text}</span>
                    </button>); })() : null}
                  {isMedia ? <>
                    <InboxMedia key={message.id} message={message} getToken={getToken}
                      avatarConversationId={isInbound && message.type === 'audio' && !selectedConversation.isGroup ? selectedConversation.id : undefined}
                      avatarChannelId={!isInbound && message.type === 'audio' ? selectedConversation.channelId : undefined}
                      avatarName={message.type !== 'audio' ? undefined : isInbound ? senderName : selectedConversation.channelName ?? 'Você'} />
                    {mediaCaption(message) ? <p><WhatsappText text={mediaCaption(message)!} /></p> : null}
                    {attachmentReadNotice(message) && !message.attachment?.isGif ? <details className="talk-audio-transcript"><summary>Leitura pela IA indisponível</summary><p>Você pode abrir o anexo acima. A leitura pela IA não foi concluída.</p></details> : null}
                  </> : message.location ? <LocationMessage location={message.location} /> : message.contactCards?.length ? <ContactCardMessage cards={message.contactCards} onSelect={setSelectedContactCard} /> : (
                    <p className="message-text"><WhatsappText text={messageDisplayText(message)} /><span className="message-meta-spacer" aria-hidden="true">{meta}</span>
                      <span className="message-bubble-meta">{meta}</span></p>
                  )}
                  {inlineMeta ? null : <div className="message-bubble-meta">{meta}</div>}
                  {outboundStatusLabel(message) ? (
                    <span className={`message-send-state message-send-state--${message.status}`}>
                      {outboundStatusLabel(message)}
                    </span>
                  ) : null}
                  {message.whatsappId && thread.chips.get(message.whatsappId) ? (
                    <div className="message-reactions" aria-label="Reações">
                      {thread.chips.get(message.whatsappId)!.map(chip => <span key={chip.emoji} className={chip.mine ? 'is-mine' : undefined}>{chip.emoji}{chip.count > 1 ? <small>{chip.count}</small> : null}</span>)}
                    </div>
                  ) : null}
                </div>
                {canReply || canDelete ? (
                  <div className="message-actions">
                    {canReply ? (
                      <button type="button" className="message-action" title="Responder" aria-label="Responder esta mensagem"
                        onClick={() => { setReplyTarget(message); draftTextAreaRef.current?.focus(); }}>
                        <Reply size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                    {canDelete ? (
                      <button type="button" className="message-action" title="Apagar para todos"
                        aria-label="Apagar mensagem para todos" disabled={Boolean(deletingMessageId)}
                        onClick={() => { void actionsRef.current.deleteMessageForEveryone(message); }}>
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
              );
            })}
            </div>
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
        )
  ), [selectedConversation, selectedConversationId, visibleMessages, thread, isThreadTransitioning, isLoadingMessages,
    messageError, sendFailure, newMessagesBelow, deletingMessageId, getToken, getFreshToken, session]);
  const sidebarView = useMemo(() => (
<aside className={`contact-panel assistant-contact-panel${assistantOpen ? ' assistant-drawer-open' : ''}`} aria-label="Contato e IA de apoio">
        {selectedConversation?.isGroup ? <>
          <div className="context-card"><div className="context-card-title">Grupo do WhatsApp</div><strong>{contactDisplayName(selectedConversation)}</strong><p>As respostas neste grupo são enviadas manualmente.</p></div>
          <div className="context-card"><div className="context-card-title">Atendimento</div><p>{selectedConversation.assignedUserName ?? 'Fila geral'} · {statusLabel(selectedConversation.status)}</p><div className="quick-actions"><button type="button" disabled={isRunningAction} onClick={() => void actionsRef.current.runAction({ action: 'assign_current_user' })}>Assumir</button><button type="button" disabled={isRunningAction} onClick={() => void actionsRef.current.runAction({ action: 'close_conversation' })}>Finalizar</button></div></div>
        </> : <>
        <div className="assistant-tabs"><button type="button" aria-pressed={assistantTab === 'contact'} onClick={() => setAssistantTab('contact')}>Contato</button><button type="button" aria-pressed={assistantTab === 'assistant'} onClick={() => setAssistantTab('assistant')}>IA de apoio{handoffBrief ? <span className="assistant-tab-dot is-handoff" /> : assistant.data?.status === 'ready' ? <span className="assistant-tab-dot" /> : null}</button><button ref={assistantCloseRef} className="assistant-drawer-close" aria-label="Fechar apoio" type="button" onClick={() => { setAssistantOpen(false); assistantTriggerRef.current?.focus(); }}><X size={18} /></button></div>
        {handoff.error ? <p className="error-note" role="status">{handoff.error} <button type="button" onClick={handoff.refresh}>Tentar novamente</button></p> : null}
        {assistantTab === 'assistant' ? <AssistantPanel key={selectedConversationId ?? 'none'} data={assistant.data} error={assistant.error} humanControlled={selectedConversation?.aiControlStatus === 'human_controlled'} handoffBrief={handoffBrief} handoffCompleted={Boolean(selectedConversation?.handoffActionCompletedAt)} handoffFeedback={handoffFeedback} handoffBusy={isRunningAction} onCompleteHandoff={() => { void actionsRef.current.runAction({ action: 'complete_handoff_action' }); }} onReopenHandoff={() => { void actionsRef.current.runAction({ action: 'reopen_handoff_action' }); }} onReanalyzeHandoff={() => { void actionsRef.current.runAction({ action: 'reanalyze_handoff_reply' }); }} draftExists={Boolean(draft.trim())} sending={isSending} onGenerate={assistant.request} onSend={(...args) => actionsRef.current.sendSuggestion(...args)} onEdit={(...args) => actionsRef.current.editSuggestion(...args)} /> : <>
        {isLoadingContext ? <p className="thread-note" role="status">Atualizando contato…</p> : null}
        {/* Card identidade */}
        {selectedConversation ? <ContactIdentityCard key={selectedConversation.contactId}
          conversationId={selectedConversation.id}
          contactId={selectedConversation.contactId} name={selectedConversation.contactName ?? null}
          phone={selectedConversation.contactPhone ?? null} channelName={selectedConversation.channelName}
          onSave={(...args) => actionsRef.current.saveContactName(...args)} /> : <div className="context-card">Nenhuma conversa</div>}

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
                    onClick={() => void actionsRef.current.handleRemoveTag(tag.id)}
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
          <form className="tag-add-form" onSubmit={event => actionsRef.current.handleAddTag(event)}>
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
          {contextError ? <p className="error-note compact" role="status">{contextError} <button type="button" onClick={() => void contextQuery.refetch()}>Tentar novamente</button></p> : null}
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
          <form className="quick-note-form" onSubmit={event => actionsRef.current.handleAddNote(event)}>
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
              onClick={() => void actionsRef.current.runAction({ action: "assign_current_user" })}
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
              onClick={() => void actionsRef.current.handleCreateLead()}
              type="button"
            >
              <Plus size={15} aria-hidden="true" />
              Lead
            </button>
            <button
              className="quick-action-danger"
              disabled={!selectedConversation || isRunningAction}
              onClick={() => void actionsRef.current.runAction({ action: "close_conversation" })}
              type="button"
            >
              <CheckCircle2 size={15} aria-hidden="true" />
              Finalizar
            </button>
            {canResetConversation(currentRole) ? (
              <button
                className="quick-action-danger"
                disabled={!selectedConversation || isRunningAction}
                onClick={() => void actionsRef.current.resetSelectedConversation()}
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
        </>}
      </aside>
  ), [selectedConversation, selectedConversationId, assistantOpen, assistantTab, assistant.data, assistant.error,
    assistant.request, handoffBrief, handoff.error, handoff.refresh, handoffFeedback, isRunningAction, Boolean(draft.trim()), isSending, currentRole,
    contactContext, availableTagOptions, selectedTagId, notesHistoryOpen, visibleNotes, hiddenNoteCount, noteDraft,
    contextError, aiSuggestion, crmStatus, contextQuery.refetch, isLoadingContext]);

  return (
    <section className={`talk-workspace talk-workspace-atendimento${selectedConversationId ? ' has-selected-conversation' : ''}`} aria-label="Atendimento">
      <TalkPerformancePanel />
      {conversationListView}

      <section className={`chat-panel${isDraggingFile ? ' is-dragging-file' : ''}`} aria-label="Area de atendimento"
        onDragEnter={handleChatDragEnter} onDragLeave={handleChatDragLeave}
        onDragOver={(event) => { if (selectedConversationId && hasDraggedFiles(event)) event.preventDefault(); }}
        onDrop={handleChatDrop}>
        {isDraggingFile ? <div className="chat-drop-overlay" aria-hidden="true"><UploadCloud size={34} />Solte para anexar à conversa</div> : null}
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
            <div className="conversation-ai-control module-header-actions" aria-label={selectedConversation.isGroup ? "Atendimento do grupo" : "Controle da IA"}>
              {!selectedConversation.isGroup && selectedConversation.channelProvider === 'evolution' && selectedConversation.contactPhone ? <button type="button" className="inbox-share-trigger" title="Enviar contato para outra pessoa" aria-label="Enviar contato para outra pessoa" onClick={() => setShareContactOpen(true)}><ContactRound size={17} /><Send size={12} /></button> : null}
              {selectedConversation.isGroup ? <span className="status-badge">Grupo</span> : <>
              <span className="status-badge status-badge--bot">
                {aiControlLabel(selectedConversation, assistant.data?.settings.mode)}
              </span>
              <button
                className="secondary-button"
                disabled={isRunningAction}
                onClick={() => void toggleAiControl()}
                type="button"
              >
                {aiControlActionLabel(selectedConversation)}
              </button>
              </>}
              <ConversationCampaignSource conversation={selectedConversation} />
              <span className={`status-badge status-badge--${selectedConversation.status}`}>
                {statusLabel(selectedConversation.status)}
              </span>
            </div>
          ) : null}
        </header>

        {historyView}

        <div className="composer-shell">
          {pendingFile ? <div className="composer-attachment-preview" aria-label="Anexo pronto para enviar">
            <span className="composer-attachment-icon">{pendingFilePreview ? <img src={pendingFilePreview} alt="Prévia do anexo" /> : <FileText size={22} aria-hidden="true" />}</span>
            <span className="composer-attachment-details"><strong>{pendingFile.name}</strong><small>{(pendingFile.size / 1024 / 1024).toFixed(1)} MB · Pronto para enviar</small></span>
            <button type="button" aria-label="Remover anexo" title="Remover anexo" onClick={() => setPendingFile(null)}><X size={18} /></button>
          </div> : null}
          {!selectedConversation?.isGroup ? <button ref={assistantTriggerRef} type="button" className="assistant-mobile-trigger" onClick={() => { setAssistantTab('assistant'); setAssistantOpen(true); }} disabled={!selectedConversation}><MessageSquare size={15} /> IA de apoio <span>{handoffBrief ? 'Próxima ação' : assistant.data?.status === 'ready' ? 'Sugestão pronta' : 'Abrir'}</span></button> : null}
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
                <Paperclip size={16} aria-hidden="true" />
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
            {replyTarget && replyTarget.conversationId === selectedConversationId ? (() => {
              const quote = quotedPreview({ whatsappId: replyTarget.whatsappId ?? '', participant: replyTarget.senderJid ?? null, body: replyTarget.body }, visibleMessages, selectedConversation?.contactName ?? null);
              return <div className="composer-reply" role="status">
                <div className="message-quote"><strong>{quote.author}</strong><span>{quote.text}</span></div>
                <button type="button" aria-label="Cancelar resposta" onClick={() => setReplyTarget(null)}><X size={14} aria-hidden="true" /></button>
              </div>;
            })() : null}
            <div className="composer-input-row">
              <RichDraft key={selectedConversationId ?? 'no-conversation'} ref={draftTextAreaRef} value={draft} disabled={!selectedConversation || isSending} onFormatChange={setDraftFormat} onChange={value => { setDraft(value); if (!value) setComposerOrigin(null); }} onPasteImage={stageAttachment} />
              <button
                className="composer-send"
                disabled={!selectedConversation || (!draft.trim() && !pendingFile) || isSending}
                type="submit"
                aria-label={pendingFile ? "Enviar anexo" : "Enviar mensagem"}
              >
                →
              </button>
            </div>
          </form>
        </div>
      </section>

      {sidebarView}

      {shareContactOpen && selectedConversation ? <ShareContactDialog source={selectedConversation} getToken={getToken} onClose={() => setShareContactOpen(false)} onSent={(name, contextImages) => { setShareContactOpen(false); setSendNotice(contextImages ? `Contato e histórico enviados para ${name}.` : `Contato enviado para ${name}; a conversa ainda não tem mensagens para compartilhar.`); setConversationReloadKey((current) => current + 1); }} /> : null}
      {newConversationOpen ? <NewConversationDialog channels={channels} getToken={getToken} onClose={() => setNewConversationOpen(false)} onOpened={(conversation) => {
        setNewConversationOpen(false);
        setActiveView('all');
        setSelectedChannelFilter('all');
        setSearchOpen(false);
        setSearchDraft('');
        setSearchQuery('');
        setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
        setSelectedConversationSnapshot(conversation);
        setSelectedConversationId(conversation.id);
        window.requestAnimationFrame(() => draftTextAreaRef.current?.focus());
      }} /> : null}
      {selectedContactCard ? <ContactCardDialog card={selectedContactCard} channels={channels} currentChannelId={selectedConversation?.channelId} getToken={getToken} onClose={() => setSelectedContactCard(null)} onOpened={(conversation) => {
        setSelectedContactCard(null);
        setActiveView('all');
        setSelectedChannelFilter('all');
        setSearchOpen(false);
        setSearchDraft('');
        setSearchQuery('');
        setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
        setSelectedConversationSnapshot(conversation);
        setSelectedConversationId(conversation.id);
        window.requestAnimationFrame(() => draftTextAreaRef.current?.focus());
      }} /> : null}
      {quickSendOpen ? <QuickSendDialog channels={channels} initialChannelId={selectedConversation?.channelId} getToken={getToken} onClose={() => setQuickSendOpen(false)} onSent={() => setConversationReloadKey((current) => current + 1)} /> : null}
    </section>
  );
}
