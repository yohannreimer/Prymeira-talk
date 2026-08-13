import { useTalkAuth } from "../../app/auth";
import type { ConversationDto, MessageDto, RealtimeEvent, TagDto } from "@prymeira-talk/shared";
import { Bot, CheckCircle2, Download, History, MessageSquare, Plus, RotateCcw, StickyNote, UserCheck, X } from "lucide-react";
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
  apiGetCurrentTalkUser,
  apiGetTags,
  apiGetQuickReplies,
  apiMarkConversationRead,
  apiResetConversation,
  apiRunConversationAction,
  apiUpdateQuickReply,
  type ContactContextDto,
  type ConversationActionBody,
  type ConversationActionResultDto,
  type QuickReplyDto
} from "../../app/api";
import {
  contactDisplayName,
  filterConversationsByChannel,
  filterConversationsByQueue,
  type ConversationQueueFilter,
  getChannelFilterOptions
} from "./conversation-display";
import { QuickRepliesPopover } from "./QuickRepliesPopover";
import { useRealtimeEvents } from "./useRealtimeEvents";

function formatTime(value: string | null) {
  if (!value) return "Sem mensagens";

  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

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
  conversation: Pick<ConversationDto, "aiControlStatus" | "activeAgentSessionStatus" | "handoffReason">
) {
  return (
    conversation.activeAgentSessionStatus === "handoff_requested" ||
    (conversation.aiControlStatus === "human_controlled" && Boolean(conversation.handoffReason))
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

function upsertConversation(list: ConversationDto[], conversation: ConversationDto) {
  const withoutUpdated = list.filter((item) => item.id !== conversation.id);
  return [conversation, ...withoutUpdated];
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

function MessageMediaPreview(props: { message: MessageDto }) {
  const { message } = props;
  const kind = messageMediaKind(message);

  if (!message.mediaUrl || !kind) {
    return null;
  }

  if (kind === "image") {
    return (
      <a
        className="message-media-frame"
        href={message.mediaUrl}
        rel="noreferrer"
        target="_blank"
      >
        <img alt={messageDisplayText(message)} src={message.mediaUrl} />
      </a>
    );
  }

  if (kind === "audio") {
    return (
      <div className="message-audio-preview">
        <audio
          className="message-audio-player"
          controls
          preload="metadata"
          src={message.mediaUrl}
        />
        <a
          className="message-media-fallback"
          href={message.mediaUrl}
          rel="noreferrer"
          target="_blank"
        >
          <Download size={14} aria-hidden="true" />
          {messageMediaFallbackLabel(message)}
        </a>
      </div>
    );
  }

  return (
    <a
      className="message-file-card"
      download
      href={message.mediaUrl}
      rel="noreferrer"
      target="_blank"
    >
      <Download size={16} aria-hidden="true" />
      <span>
        <strong>{messageDisplayText(message)}</strong>
        <small>{messageMediaFallbackLabel(message)}</small>
      </span>
    </a>
  );
}

export function InboxPage() {
  const { getToken } = useTalkAuth();
  const [token, setToken] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
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
  const [noteDraft, setNoteDraft] = useState("");
  const [notesHistoryOpen, setNotesHistoryOpen] = useState(false);
  const [tagCatalog, setTagCatalog] = useState<TagDto[]>([]);
  const [selectedTagId, setSelectedTagId] = useState("");
  const [selectedQueueFilter, setSelectedQueueFilter] = useState<ConversationQueueFilter>("active");
  const [selectedChannelFilter, setSelectedChannelFilter] = useState("all");
  const [conversationReloadKey, setConversationReloadKey] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const [isRunningAction, setIsRunningAction] = useState(false);
  const [currentRole, setCurrentRole] = useState<"owner" | "manager" | "agent">("agent");
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [crmStatus, setCrmStatus] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReplyDto[]>([]);
  const [isQuickRepliesLoading, setIsQuickRepliesLoading] = useState(false);
  const [quickRepliesError, setQuickRepliesError] = useState<string | null>(null);
  const [newMessagesBelow, setNewMessagesBelow] = useState(0);
  const selectedConversationIdRef = useRef<string | null>(null);
  const selectedQueueFilterRef = useRef<ConversationQueueFilter>("active");
  const conversationsRef = useRef<ConversationDto[]>([]);
  const messageThreadRef = useRef<HTMLDivElement | null>(null);
  const pendingThreadScrollRef = useRef<ScrollBehavior | null>(null);
  const userReadingHistoryRef = useRef(false);
  const draftTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [acknowledgedHandoffIds, setAcknowledgedHandoffIds] = useState<Set<string>>(() => new Set());
  const getFreshToken = useCallback(async () => {
    const nextToken = await getToken();
    setToken(nextToken);
    return nextToken;
  }, [getToken]);

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

  function setDraftSelection(selectionStart: number, selectionEnd: number) {
    window.requestAnimationFrame(() => {
      draftTextAreaRef.current?.focus();
      draftTextAreaRef.current?.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  function applyDraftMarker(marker: "*" | "_") {
    const textarea = draftTextAreaRef.current;
    const selectionStart = textarea?.selectionStart ?? draft.length;
    const selectionEnd = textarea?.selectionEnd ?? draft.length;
    const nextDraft = applyComposerMarker(draft, selectionStart, selectionEnd, marker);

    setDraft(nextDraft.value);
    setDraftSelection(nextDraft.selectionStart, nextDraft.selectionEnd);
  }

  function insertDraftText(text: string) {
    const textarea = draftTextAreaRef.current;
    const selectionStart = textarea?.selectionStart ?? draft.length;
    const selectionEnd = textarea?.selectionEnd ?? draft.length;
    const nextDraft = insertComposerText(draft, selectionStart, selectionEnd, text);

    setDraft(nextDraft.value);
    setDraftSelection(nextDraft.selectionStart, nextDraft.selectionEnd);
  }

  function resizeDraftTextArea() {
    const textarea = draftTextAreaRef.current;

    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
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
    resizeDraftTextArea();
  }, [draft]);

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

    async function loadConversations() {
      setIsLoading(true);
      setError(null);

      try {
        const nextConversations = await apiGetConversations(getFreshToken, {
          status: selectedQueueFilter === "mine" ? "active" : selectedQueueFilter,
          ...(selectedQueueFilter === "mine" ? { assignee: "me" as const } : {})
        });

        if (!isMounted) return;

        setConversations(nextConversations);
        const requestedConversationId = readConversationIdFromUrl();
        setSelectedConversationId((current) =>
          current ??
          (requestedConversationId &&
          nextConversations.some((conversation) => conversation.id === requestedConversationId)
            ? requestedConversationId
            : nextConversations[0]?.id ?? null)
        );
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar conversas.");
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadConversations();

    return () => {
      isMounted = false;
    };
  }, [conversationReloadKey, getFreshToken, selectedQueueFilter]);

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
    () => getChannelFilterOptions(queueFilteredConversations),
    [queueFilteredConversations]
  );
  const visibleConversations = useMemo(
    () => filterConversationsByChannel(queueFilteredConversations, selectedChannelFilter),
    [queueFilteredConversations, selectedChannelFilter]
  );

  useEffect(() => {
    if (
      selectedChannelFilter !== "all" &&
      !channelFilterOptions.some((option) => option.id === selectedChannelFilter)
    ) {
      setSelectedChannelFilter("all");
    }
  }, [channelFilterOptions, selectedChannelFilter]);

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
  const isThreadTransitioning = Boolean(selectedConversationId) && messagesConversationId !== selectedConversationId;
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

    if (!selectedConversationId || !draft.trim()) return;

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

    if (!file || !selectedConversationId) return;

    const targetConversationId = selectedConversationId;
    const serviceWindowError = metaServiceWindowSendError(selectedConversation);

    if (serviceWindowError) {
      setMessageError(serviceWindowError);
      return;
    }

    const caption = draft.trim();
    const mediaUrl = await fileToDataUrl(file).catch((fileError: unknown) => {
      setMessageError(fileError instanceof Error ? fileError.message : "Não foi possível ler o arquivo.");
      return null;
    });

    if (!mediaUrl) return;

    const messageType: MessageDto["type"] = file.type.startsWith("image/") ? "image" : "file";
    const body = caption || file.name;
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
    <section className="talk-workspace talk-workspace-atendimento" aria-label="Atendimento">
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
            <span>{openCount}</span>
            <p>Abertas</p>
          </div>
          <div>
            <span>{unreadCount}</span>
            <p>Novas</p>
          </div>
          <div>
            <span>{closedCount}</span>
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
              onClick={() => setSelectedQueueFilter(option.id)}
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

        {isLoading ? <p className="list-note">Carregando conversas...</p> : null}
        {error ? <p className="error-note">{error}</p> : null}

        <div className="conversation-items">
          {!isLoading && visibleConversations.length === 0 ? (
            <p className="list-note">Nenhuma conversa encontrada para este canal.</p>
          ) : null}
          {visibleConversations.map((conversation) => {
            const conversationNeedsHuman = needsHumanAttention(conversation);
            const showHumanAttention =
              conversationNeedsHuman &&
              conversation.id !== selectedConversationId &&
              !acknowledgedHandoffIds.has(conversation.id);

            return (
            <button
              aria-label={`Abrir conversa com ${contactDisplayName(conversation)}`}
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
                <span className="conversation-avatar" aria-hidden="true">
                  {conversation.contactId.slice(0, 2).toUpperCase()}
                </span>
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
        </div>
      </section>

      <section className="chat-panel" aria-label="Area de atendimento">
        <header className="chat-header">
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
                  <span className="msg-avatar" aria-hidden="true">
                    {selectedConversation?.contactId.slice(0, 2).toUpperCase() ?? "??"}
                  </span>
                ) : null}
                <div className="msg-bubble-body">
                  <MessageMediaPreview message={message} />
                  {message.body || !message.mediaUrl ? (
                    <p>{messageDisplayText(message)}</p>
                  ) : null}
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
                disabled={!selectedConversation}
                onClick={() => applyDraftMarker("*")}
              >
                <strong>B</strong>
              </button>
              <button
                type="button"
                className="composer-tool"
                aria-label="Itálico"
                disabled={!selectedConversation}
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
              <textarea
                aria-label="Mensagem"
                className="composer-textarea"
                disabled={!selectedConversation}
                onChange={(event) => {
                  setDraft(event.target.value);
                  resizeDraftTextArea();
                }}
                onInput={resizeDraftTextArea}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Escreva uma mensagem..."
                ref={draftTextAreaRef}
                rows={1}
                value={draft}
              />
              <button
                className="composer-send"
                disabled={!selectedConversation || !draft.trim()}
                type="submit"
                aria-label="Enviar mensagem"
              >
                →
              </button>
            </div>
          </form>
        </div>
      </section>

      <aside className="contact-panel" aria-label="Detalhes do contato">
        {/* Card identidade */}
        <div className="context-card context-card--identity">
          <div className="context-identity-avatar" aria-hidden="true">
            {selectedConversation
              ? selectedConversation.contactId.slice(0, 2).toUpperCase()
              : "?"}
          </div>
          <div>
            <div className="context-identity-name">
              {selectedConversation
                ? contactDisplayName(selectedConversation)
                : "Nenhuma conversa"}
            </div>
            {selectedConversation?.channelName ? (
              <div className="context-identity-sub">{selectedConversation.channelName}</div>
            ) : null}
          </div>
        </div>

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
              onClick={() => void runAction({ action: "request_ai_suggestion" })}
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
      </aside>
    </section>
  );
}
