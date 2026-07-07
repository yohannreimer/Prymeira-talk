import { useTalkAuth } from "../../app/auth";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type {
  ChannelDto,
  ContactBoardStageDto,
  ContactDto,
  RealtimeEvent,
  TagDto
} from "@prymeira-talk/shared";
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  MessageSquarePlus,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Users
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  apiAddContactToBoard,
  apiCreateBoard,
  apiCreateBoardStage,
  apiCreateContact,
  apiDeleteBoard,
  apiDeleteBoardStage,
  apiGetBoardContacts,
  apiGetBoards,
  apiGetChannels,
  apiGetContacts,
  apiGetTags,
  apiMoveBoardMembership,
  apiRemoveBoardMembership,
  apiReorderBoardStages,
  apiStartContactConversation,
  apiSyncBoardRules,
  apiUpdateBoard,
  apiUpdateBoardStage,
  apiUpdateContact,
  type BoardSyncResultDto,
  type BoardSyncScope,
  type BoardContactCardDto,
  type BoardContactsDto,
  type ContactBoardWithStagesDto
} from "../../app/api";
import { findDuplicateStageTag, formatBoardChannelLabel, stageTagIdsByStage } from "./board-display";
import { useRealtimeEvents } from "../inbox/useRealtimeEvents";

type ViewMode = "list" | "board";
type BoardPanelMode = "create-board" | "edit-board" | "create-stage" | "add-contact" | "sync-rules" | null;

interface ContactFormState {
  name: string;
  phone: string;
  email: string;
  company: string;
}

interface BoardFormState {
  name: string;
  description: string;
  channelIds: string[];
  isPrimaryPipeline: boolean;
}

interface StageFormState {
  name: string;
  color: string;
  tagIds: string[];
}

const emptyForm: ContactFormState = {
  name: "",
  phone: "",
  email: "",
  company: ""
};

const emptyBoardForm: BoardFormState = {
  name: "",
  description: "",
  channelIds: [],
  isPrimaryPipeline: false
};

const emptyStageForm: StageFormState = {
  name: "",
  color: "#24564a",
  tagIds: []
};

const emptyBoardStages: ContactBoardStageDto[] = [];

function mergeContact(contacts: ContactDto[], contact: ContactDto) {
  const withoutContact = contacts.filter((current) => current.id !== contact.id);
  return [contact, ...withoutContact];
}

function contactName(contact: ContactDto) {
  return contact.name ?? contact.phone;
}

function initials(contact: ContactDto) {
  const source = contact.name ?? contact.company ?? contact.phone;
  return source.slice(0, 2).toUpperCase();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short"
  }).format(new Date(value));
}

function toFormState(contact: ContactDto): ContactFormState {
  return {
    name: contact.name ?? "",
    phone: contact.phone,
    email: contact.email ?? "",
    company: contact.company ?? ""
  };
}

export function updateDrawerContactAfterSave(
  drawerContact: ContactDto | null,
  savedContact: ContactDto
) {
  return drawerContact?.id === savedContact.id ? savedContact : drawerContact;
}

export function resolveBoardDragMove(
  membershipId: string,
  targetStageId: string,
  memberships: Array<{ membershipId: string; stageId: string }>
) {
  const membership = memberships.find((entry) => entry.membershipId === membershipId);

  if (!membership || membership.stageId === targetStageId) {
    return null;
  }

  return {
    membershipId,
    stageId: targetStageId
  };
}

function BoardStageDropZone(props: {
  stageId: string;
  children: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: props.stageId });

  return (
    <div ref={setNodeRef} className={`board-card-list ${isOver ? "is-drop-target" : ""}`}>
      {props.children}
    </div>
  );
}

function SortableBoardContact(props: {
  membership: BoardContactCardDto;
  children: ReactNode;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: props.membership.id
  });

  return (
    <article
      ref={setNodeRef}
      className={`board-contact ${isDragging ? "is-dragging" : ""}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition
      }}
      {...attributes}
      {...listeners}
    >
      {props.children}
    </article>
  );
}

export function ContactsPage() {
  const { getToken } = useTalkAuth();
  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [createForm, setCreateForm] = useState<ContactFormState>(emptyForm);
  const [editForm, setEditForm] = useState<ContactFormState>(emptyForm);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [boards, setBoards] = useState<ContactBoardWithStagesDto[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [boardContacts, setBoardContacts] = useState<BoardContactsDto | null>(null);
  const [isBoardLoading, setIsBoardLoading] = useState(false);
  const [isBoardSaving, setIsBoardSaving] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [newBoardForm, setNewBoardForm] = useState<BoardFormState>(emptyBoardForm);
  const [boardEditForm, setBoardEditForm] = useState<BoardFormState>(emptyBoardForm);
  const [newStageForm, setNewStageForm] = useState<StageFormState>(emptyStageForm);
  const [stageEditForms, setStageEditForms] = useState<Record<string, StageFormState>>({});
  const [boardPanelMode, setBoardPanelMode] = useState<BoardPanelMode>(null);
  const [syncScope, setSyncScope] = useState<BoardSyncScope>("active");
  const [syncResult, setSyncResult] = useState<BoardSyncResultDto | null>(null);
  const [addContactId, setAddContactId] = useState("");
  const [addStageId, setAddStageId] = useState("");
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const [drawerContact, setDrawerContact] = useState<ContactDto | null>(null);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [activeBoardMembershipId, setActiveBoardMembershipId] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [startChannelId, setStartChannelId] = useState("");
  const [isStartingConversation, setIsStartingConversation] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function openDrawer(contact: ContactDto) {
    setDrawerContact(contact);
  }

  function closeDrawer() {
    setDrawerContact(null);
  }

  useEffect(() => {
    let isMounted = true;

    void getToken()
      .then((token) => {
        if (isMounted) {
          setRealtimeToken(token);
        }
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  useEffect(() => {
    if (!saveMessage) return;

    const timeoutId = window.setTimeout(() => setSaveMessage(null), 4200);

    return () => window.clearTimeout(timeoutId);
  }, [saveMessage]);

  useEffect(() => {
    let isMounted = true;

    void apiGetChannels(getToken)
      .then((nextChannels) => {
        if (!isMounted) return;
        setChannels(nextChannels);
        setStartChannelId((current) =>
          nextChannels.some((channel) => channel.id === current)
            ? current
            : nextChannels[0]?.id ?? ""
        );
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, [getToken]);

  useEffect(() => {
    let isMounted = true;

    async function loadContacts() {
      setIsLoading(true);
      setError(null);

      try {
        const nextContacts = await apiGetContacts(getToken, search);

        if (!isMounted) return;

        setContacts(nextContacts);
        setSelectedContactId((current) =>
          nextContacts.some((contact) => contact.id === current)
            ? current
            : nextContacts[0]?.id ?? null
        );
      } catch (loadError) {
        if (!isMounted) return;
        setError(loadError instanceof Error ? loadError.message : "Não foi possível carregar contatos.");
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadContacts();

    return () => {
      isMounted = false;
    };
  }, [getToken, search]);

  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.id === selectedContactId) ?? null,
    [contacts, selectedContactId]
  );

  useEffect(() => {
    if (selectedContact) {
      setEditForm(toFormState(selectedContact));
    } else {
      setEditForm(emptyForm);
    }
  }, [selectedContact]);

  useEffect(() => {
    if (viewMode !== "board") return;

    let isMounted = true;

    async function loadBoards() {
      setIsBoardLoading(true);
      setBoardError(null);

      try {
        const nextBoards = await apiGetBoards(getToken);

        if (!isMounted) return;

        setBoards(nextBoards);
        setSelectedBoardId((current) =>
          nextBoards.some((board) => board.id === current)
            ? current
            : nextBoards[0]?.id ?? null
        );
      } catch (loadError) {
        if (!isMounted) return;
        setBoardError(loadError instanceof Error ? loadError.message : "Não foi possível carregar boards.");
      } finally {
        if (isMounted) {
          setIsBoardLoading(false);
        }
      }
    }

    void loadBoards();

    return () => {
      isMounted = false;
    };
  }, [getToken, viewMode]);

  useEffect(() => {
    if (viewMode !== "board") return;

    let isMounted = true;

    void apiGetTags(getToken)
      .then((nextTags) => {
        if (isMounted) {
          setTags(nextTags);
        }
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
    };
  }, [getToken, viewMode]);

  useEffect(() => {
    if (viewMode !== "board" || !selectedBoardId) {
      setBoardContacts(null);
      return;
    }

    let isMounted = true;
    const boardIdToLoad = selectedBoardId;
    setBoardContacts(null);
    setAddContactId("");
    setAddStageId("");

    async function loadBoardContacts() {
      setIsBoardLoading(true);
      setBoardError(null);

      try {
        const nextBoardContacts = await apiGetBoardContacts(getToken, boardIdToLoad);

        if (!isMounted) return;

        setBoardContacts(nextBoardContacts);
      } catch (loadError) {
        if (!isMounted) return;
        setBoardError(loadError instanceof Error ? loadError.message : "Não foi possível carregar o board.");
      } finally {
        if (isMounted) {
          setIsBoardLoading(false);
        }
      }
    }

    void loadBoardContacts();

    return () => {
      isMounted = false;
    };
  }, [getToken, selectedBoardId, viewMode]);

  const refreshContactsFromRealtime = useCallback(() => {
    void apiGetContacts(getToken, search)
      .then((nextContacts) => {
        setContacts(nextContacts);
        setSelectedContactId((current) =>
          nextContacts.some((contact) => contact.id === current)
            ? current
            : nextContacts[0]?.id ?? null
        );
      })
      .catch(() => undefined);
  }, [getToken, search]);

  const refreshBoardFromRealtime = useCallback(
    (boardId: string) => {
      void apiGetBoardContacts(getToken, boardId)
        .then((nextBoardContacts) => {
          setBoardContacts((current) =>
            selectedBoardId === boardId || current?.board.id === boardId
              ? nextBoardContacts
              : current
          );
        })
        .catch(() => undefined);
    },
    [getToken, selectedBoardId]
  );

  const handleRealtimeEvent = useCallback(
    (event: RealtimeEvent) => {
      if (event.type === "contact.updated") {
        setContacts((current) => mergeContact(current, event.payload));
        setDrawerContact((current) => updateDrawerContactAfterSave(current, event.payload));
        refreshContactsFromRealtime();

        if (
          viewMode === "board" &&
          selectedBoardId &&
          boardContacts?.memberships.some((membership) => membership.contactId === event.payload.id)
        ) {
          refreshBoardFromRealtime(selectedBoardId);
        }
        return;
      }

      if (
        event.type === "board_membership.updated" &&
        viewMode === "board" &&
        event.payload.boardId === selectedBoardId
      ) {
        refreshBoardFromRealtime(event.payload.boardId);
      }

      if (
        event.type === "board_membership.deleted" &&
        viewMode === "board" &&
        event.payload.boardId === selectedBoardId
      ) {
        refreshBoardFromRealtime(event.payload.boardId);
      }
    },
    [
      boardContacts?.memberships,
      refreshBoardFromRealtime,
      refreshContactsFromRealtime,
      selectedBoardId,
      viewMode
    ]
  );

  useRealtimeEvents({
    token: realtimeToken,
    onEvent: handleRealtimeEvent
  });

  const contactsWithEmail = contacts.filter((contact) => contact.email).length;
  const contactsWithCompany = contacts.filter((contact) => contact.company).length;
  const recentlyUpdated = contacts.filter((contact) => {
    const updatedAt = new Date(contact.updatedAt).getTime();
    return Date.now() - updatedAt < 7 * 24 * 60 * 60 * 1000;
  }).length;
  const selectedBoard = boards.find((board) => board.id === selectedBoardId) ?? null;
  const loadedBoardContacts =
    boardContacts?.board.id === selectedBoardId ? boardContacts : null;
  const boardStages = loadedBoardContacts?.stages ?? selectedBoard?.stages ?? emptyBoardStages;
  const stageTagIds = useMemo(() => stageTagIdsByStage(boardStages), [boardStages]);
  const loadedBoardStages = loadedBoardContacts?.stages ?? emptyBoardStages;
  const selectedStageBelongsToLoadedBoard = loadedBoardStages.some(
    (stage) => stage.id === addStageId
  );
  const canSubmitBoardAdd =
    Boolean(loadedBoardContacts) &&
    !isBoardLoading &&
    !isBoardSaving &&
    Boolean(addContactId) &&
    selectedStageBelongsToLoadedBoard;
  const boardContactIds = useMemo(
    () =>
      new Set(
        loadedBoardContacts?.memberships.map((membership) => membership.contactId) ?? []
      ),
    [loadedBoardContacts]
  );
  const availableBoardContacts = useMemo(
    () =>
      loadedBoardContacts
        ? contacts.filter((contact) => !boardContactIds.has(contact.id))
        : [],
    [boardContactIds, contacts, loadedBoardContacts]
  );
  const membershipsByStage = useMemo(() => {
    const grouped = new Map<string, BoardContactCardDto[]>();

    for (const stage of boardStages) {
      grouped.set(stage.id, []);
    }

    for (const membership of loadedBoardContacts?.memberships ?? []) {
      const memberships = grouped.get(membership.stageId) ?? [];
      memberships.push(membership);
      grouped.set(membership.stageId, memberships);
    }

    return grouped;
  }, [loadedBoardContacts, boardStages]);
  const activeBoardMembership = useMemo(
    () =>
      loadedBoardContacts?.memberships.find(
        (membership) => membership.id === activeBoardMembershipId
      ) ?? null,
    [activeBoardMembershipId, loadedBoardContacts]
  );

  useEffect(() => {
    setBoardEditForm(
      selectedBoard
        ? {
            name: selectedBoard.name,
            description: selectedBoard.description ?? "",
            channelIds: selectedBoard.channels.map((channel) => channel.id),
            isPrimaryPipeline: selectedBoard.isPrimaryPipeline
          }
        : emptyBoardForm
    );
  }, [selectedBoard]);

  useEffect(() => {
    setStageEditForms(
      Object.fromEntries(
        boardStages.map((stage) => [
          stage.id,
          {
            name: stage.name,
            color: stage.color,
            tagIds: stage.tagTriggers.map((tag) => tag.id)
          }
        ])
      )
    );
  }, [boardStages]);

  useEffect(() => {
    if (viewMode !== "board") {
      setBoardPanelMode(null);
      return;
    }

    if (!isBoardLoading && boards.length === 0) {
      setBoardPanelMode("create-board");
    }

    if (!isBoardLoading && boards.length > 0) {
      setBoardPanelMode((current) => (current === "create-board" ? null : current));
    }
  }, [boards.length, isBoardLoading, viewMode]);

  useEffect(() => {
    setAddContactId((current) =>
      availableBoardContacts.some((contact) => contact.id === current)
        ? current
        : availableBoardContacts[0]?.id ?? ""
    );
  }, [availableBoardContacts]);

  useEffect(() => {
    setAddStageId((current) =>
      boardStages.some((stage) => stage.id === current) ? current : boardStages[0]?.id ?? ""
    );
  }, [boardStages]);

  async function handleCreateContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError(null);
    setSaveMessage(null);

    try {
      const contact = await apiCreateContact(getToken, createForm);
      setContacts((current) => mergeContact(current, contact));
      setSelectedContactId(contact.id);
      setCreateForm(emptyForm);
      setSaveMessage("Contato criado.");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Não foi possível criar o contato.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleUpdateContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedContact) return;

    setIsSaving(true);
    setError(null);
    setSaveMessage(null);

    try {
      const contact = await apiUpdateContact(getToken, selectedContact.id, editForm);
      setContacts((current) => mergeContact(current, contact));
      setDrawerContact((current) => updateDrawerContactAfterSave(current, contact));
      setSelectedContactId(contact.id);
      setSaveMessage("Contato atualizado.");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Não foi possível atualizar o contato.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleStartConversation() {
    if (!drawerContact || !startChannelId) return;

    setIsStartingConversation(true);
    setError(null);
    setSaveMessage(null);

    try {
      const conversation = await apiStartContactConversation(getToken, drawerContact.id, {
        channelId: startChannelId
      });
      const url = new URL(window.location.href);
      url.searchParams.set("module", "atendimento");
      url.searchParams.set("conversation", conversation.id);
      window.history.pushState({ module: "atendimento", conversation: conversation.id }, "", `${url.pathname}${url.search}${url.hash}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Não foi possível iniciar a conversa.");
    } finally {
      setIsStartingConversation(false);
    }
  }

  function replaceBoard(nextBoard: ContactBoardWithStagesDto) {
    setBoards((current) =>
      current.some((board) => board.id === nextBoard.id)
        ? current.map((board) => (board.id === nextBoard.id ? nextBoard : board))
        : [nextBoard, ...current]
    );
  }

  function updateSelectedBoardStages(stages: ContactBoardStageDto[]) {
    if (!selectedBoardId) return;

    setBoards((current) =>
      current.map((board) =>
        board.id === selectedBoardId
          ? {
              ...board,
              stages
            }
          : board
      )
    );
    setBoardContacts((current) =>
      current?.board.id === selectedBoardId
        ? {
            ...current,
            stages
          }
        : current
    );
  }

  function toggleBoardChannel(target: "new" | "edit", channelId: string, checked: boolean) {
    const setForm = target === "new" ? setNewBoardForm : setBoardEditForm;

    setForm((current) => ({
      ...current,
      channelIds: checked
        ? [...current.channelIds, channelId]
        : current.channelIds.filter((currentChannelId) => currentChannelId !== channelId)
    }));
  }

  function toggleStageTag(target: "new" | string, tagId: string, checked: boolean) {
    if (target === "new") {
      setNewStageForm((current) => ({
        ...current,
        tagIds: checked
          ? [...current.tagIds, tagId]
          : current.tagIds.filter((currentTagId) => currentTagId !== tagId)
      }));
      return;
    }

    setStageEditForms((current) => {
      const form = current[target] ?? emptyStageForm;

      return {
        ...current,
        [target]: {
          ...form,
          tagIds: checked
            ? [...form.tagIds, tagId]
            : form.tagIds.filter((currentTagId) => currentTagId !== tagId)
        }
      };
    });
  }

  async function handleCreateBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newBoardForm.name.trim();

    if (!name) return;

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const board = await apiCreateBoard(getToken, {
        name,
        description: newBoardForm.description,
        channelIds: newBoardForm.channelIds,
        isPrimaryPipeline: newBoardForm.isPrimaryPipeline
      });

      replaceBoard(board);
      setSelectedBoardId(board.id);
      setNewBoardForm(emptyBoardForm);
      setBoardPanelMode(null);
      setSaveMessage("Board criado.");
    } catch (createError) {
      setBoardError(createError instanceof Error ? createError.message : "Não foi possível criar o board.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleUpdateBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedBoard) return;

    const name = boardEditForm.name.trim();
    if (!name) return;

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const board = await apiUpdateBoard(getToken, selectedBoard.id, {
        name,
        description: boardEditForm.description,
        channelIds: boardEditForm.channelIds,
        isPrimaryPipeline: boardEditForm.isPrimaryPipeline
      });

      replaceBoard(board);
      setBoardContacts((current) =>
        current?.board.id === board.id
          ? {
              ...current,
              board
            }
          : current
      );
      setBoardPanelMode(null);
      setSaveMessage("Board atualizado.");
    } catch (updateError) {
      setBoardError(updateError instanceof Error ? updateError.message : "Não foi possível atualizar o board.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleDeleteBoard() {
    if (!selectedBoard) return;

    const shouldDelete = window.confirm(`Apagar o board "${selectedBoard.name}" e seus contatos organizados nele?`);
    if (!shouldDelete) return;

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const result = await apiDeleteBoard(getToken, selectedBoard.id);
      const nextBoards = boards.filter((board) => board.id !== result.boardId);

      setBoards(nextBoards);
      setSelectedBoardId(nextBoards[0]?.id ?? null);
      setBoardContacts(null);
      setBoardPanelMode(nextBoards.length > 0 ? null : "create-board");
      setSaveMessage("Board apagado.");
    } catch (deleteError) {
      setBoardError(deleteError instanceof Error ? deleteError.message : "Não foi possível apagar o board.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleCreateStage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedBoardId) return;

    const name = newStageForm.name.trim();
    const color = newStageForm.color.trim();

    if (!name || !color) return;
    if (findDuplicateStageTag(stageTagIds, "__new_stage", newStageForm.tagIds)) {
      setBoardError("Esta tag já está ligada a outra etapa deste board.");
      return;
    }

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const stage = await apiCreateBoardStage(getToken, selectedBoardId, {
        name,
        color,
        order: boardStages.length,
        tagIds: newStageForm.tagIds
      });
      const stages = [...boardStages, stage].sort((left, right) => left.order - right.order);

      updateSelectedBoardStages(stages);
      setAddStageId(stage.id);
      setNewStageForm(emptyStageForm);
      setBoardPanelMode(null);
      setSaveMessage("Etapa criada.");
    } catch (createError) {
      setBoardError(createError instanceof Error ? createError.message : "Não foi possível criar a etapa.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleUpdateStage(stageId: string) {
    if (!selectedBoardId) return;

    const form = stageEditForms[stageId];
    if (!form?.name.trim() || !form.color.trim()) return;
    if (findDuplicateStageTag(stageTagIds, stageId, form.tagIds)) {
      setBoardError("Esta tag já está ligada a outra etapa deste board.");
      return;
    }

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const stage = await apiUpdateBoardStage(getToken, selectedBoardId, stageId, {
        name: form.name,
        color: form.color,
        tagIds: form.tagIds
      });
      const stages = boardStages.map((currentStage) =>
        currentStage.id === stage.id ? stage : currentStage
      );

      updateSelectedBoardStages(stages);
      setSaveMessage("Etapa atualizada.");
    } catch (updateError) {
      setBoardError(updateError instanceof Error ? updateError.message : "Não foi possível atualizar a etapa.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleUpdateAllStages() {
    if (!selectedBoardId || boardStages.length === 0) return;

    const formsByStage = boardStages.reduce<Record<string, StageFormState>>((accumulator, stage) => {
      accumulator[stage.id] = stageEditForms[stage.id] ?? {
        name: stage.name,
        color: stage.color,
        tagIds: stage.tagTriggers.map((tag) => tag.id)
      };

      return accumulator;
    }, {});
    const nextStageTagIds = Object.fromEntries(
      boardStages.map((stage) => [stage.id, formsByStage[stage.id]?.tagIds ?? []])
    );
    const hasInvalidStage = boardStages.some((stage) => {
      const form = formsByStage[stage.id];

      return !form?.name.trim() || !form.color.trim();
    });
    const hasDuplicateTag = boardStages.some((stage) =>
      findDuplicateStageTag(nextStageTagIds, stage.id, formsByStage[stage.id]?.tagIds ?? [])
    );

    if (hasInvalidStage) {
      setBoardError("Revise nome e cor das etapas antes de salvar.");
      return;
    }

    if (hasDuplicateTag) {
      setBoardError("Esta tag já está ligada a outra etapa deste board.");
      return;
    }

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const updatedStages = await Promise.all(
        boardStages.map(async (stage) => {
          const form = formsByStage[stage.id];
          const nextName = form.name.trim();
          const nextColor = form.color.trim();
          const currentTagIds = stage.tagTriggers.map((tag) => tag.id);
          const hasChanges =
            nextName !== stage.name ||
            nextColor !== stage.color ||
            form.tagIds.join("|") !== currentTagIds.join("|");

          if (!hasChanges) return stage;

          return apiUpdateBoardStage(getToken, selectedBoardId, stage.id, {
            name: nextName,
            color: nextColor,
            tagIds: form.tagIds
          });
        })
      );

      updateSelectedBoardStages(updatedStages.sort((left, right) => left.order - right.order));
      setSaveMessage("Etapas atualizadas.");
    } catch (updateError) {
      setBoardError(updateError instanceof Error ? updateError.message : "Não foi possível salvar as etapas.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleSyncBoardRules(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedBoard) return;

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);
    setSyncResult(null);

    try {
      const result = await apiSyncBoardRules(getToken, selectedBoard.id, syncScope);
      setSyncResult(result);
      setSaveMessage(`Sincronização concluída: ${result.added} adicionados, ${result.moved} movidos.`);
      const nextBoardContacts = await apiGetBoardContacts(getToken, selectedBoard.id);
      setBoardContacts(nextBoardContacts);
    } catch (syncError) {
      setBoardError(syncError instanceof Error ? syncError.message : "Não foi possível sincronizar o board.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleDeleteStage(stage: ContactBoardStageDto) {
    if (!selectedBoardId) return;

    const memberships = membershipsByStage.get(stage.id) ?? [];
    if (memberships.length > 0) {
      setBoardError("Mova ou remova os contatos antes de apagar esta etapa.");
      return;
    }

    const shouldDelete = window.confirm(`Apagar a etapa "${stage.name}"?`);
    if (!shouldDelete) return;

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const result = await apiDeleteBoardStage(getToken, selectedBoardId, stage.id);
      updateSelectedBoardStages(boardStages.filter((currentStage) => currentStage.id !== result.stageId));
      setSaveMessage("Etapa apagada.");
    } catch (deleteError) {
      setBoardError(deleteError instanceof Error ? deleteError.message : "Não foi possível apagar a etapa.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleReorderStage(stage: ContactBoardStageDto, direction: -1 | 1) {
    if (!selectedBoardId) return;

    const currentIndex = boardStages.findIndex((currentStage) => currentStage.id === stage.id);
    const nextIndex = currentIndex + direction;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= boardStages.length) return;

    const nextStages = [...boardStages];
    const [movedStage] = nextStages.splice(currentIndex, 1);
    if (!movedStage) return;

    nextStages.splice(nextIndex, 0, movedStage);

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const stages = await apiReorderBoardStages(
        getToken,
        selectedBoardId,
        nextStages.map((currentStage) => currentStage.id)
      );

      updateSelectedBoardStages(stages);
    } catch (reorderError) {
      setBoardError(reorderError instanceof Error ? reorderError.message : "Não foi possível reordenar etapas.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleAddContactToBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loadedBoardContacts || !canSubmitBoardAdd) return;

    const boardIdToUpdate = loadedBoardContacts.board.id;

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const membership = await apiAddContactToBoard(getToken, boardIdToUpdate, {
        contactId: addContactId,
        stageId: addStageId,
        isPrimary: true
      });

      setBoardContacts((current) =>
        current?.board.id === membership.boardId
          ? {
              ...current,
              memberships: [
                membership,
                ...current.memberships.filter((entry) => entry.id !== membership.id)
              ]
            }
          : current
      );
      setSelectedContactId(membership.contactId);
      setBoardPanelMode(null);
      setSaveMessage("Contato adicionado ao board.");
    } catch (addError) {
      setBoardError(addError instanceof Error ? addError.message : "Não foi possível adicionar ao board.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleMoveMembershipToStage(membership: BoardContactCardDto, stageId: string) {
    if (
      !loadedBoardContacts ||
      membership.boardId !== loadedBoardContacts.board.id ||
      membership.stageId === stageId
    ) {
      return;
    }

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const nextMembership = await apiMoveBoardMembership(getToken, membership.id, {
        stageId
      });

      setBoardContacts((current) =>
        current?.board.id === nextMembership.boardId
          ? {
              ...current,
              memberships: current.memberships.map((entry) =>
                entry.id === nextMembership.id ? nextMembership : entry
              )
            }
          : current
      );
      setSelectedContactId(nextMembership.contactId);
    } catch (moveError) {
      setBoardError(moveError instanceof Error ? moveError.message : "Não foi possível mover no board.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  async function handleMoveMembership(membership: BoardContactCardDto, direction: -1 | 1) {
    const currentStageIndex = boardStages.findIndex((stage) => stage.id === membership.stageId);
    const nextStage = boardStages[currentStageIndex + direction];

    if (!nextStage) return;

    await handleMoveMembershipToStage(membership, nextStage.id);
  }

  async function handleRemoveMembership(membership: BoardContactCardDto) {
    const shouldRemove = window.confirm(`Remover "${contactName(membership.contact)}" deste board?`);
    if (!shouldRemove) return;

    setIsBoardSaving(true);
    setBoardError(null);
    setSaveMessage(null);

    try {
      const result = await apiRemoveBoardMembership(getToken, membership.id);
      setBoardContacts((current) =>
        current?.board.id === result.boardId
          ? {
              ...current,
              memberships: current.memberships.filter((entry) => entry.id !== result.membershipId)
            }
          : current
      );
      setSaveMessage("Contato removido do board.");
    } catch (removeError) {
      setBoardError(removeError instanceof Error ? removeError.message : "Não foi possível remover do board.");
    } finally {
      setIsBoardSaving(false);
    }
  }

  function handleBoardDragStart(event: DragStartEvent) {
    setActiveBoardMembershipId(String(event.active.id));
  }

  async function handleBoardDragEnd(event: DragEndEvent) {
    setActiveBoardMembershipId(null);

    if (!loadedBoardContacts || !event.over) return;

    const overId = String(event.over.id);
    const targetStageId = boardStages.some((stage) => stage.id === overId)
      ? overId
      : loadedBoardContacts.memberships.find((membership) => membership.id === overId)?.stageId;

    if (!targetStageId) return;

    const move = resolveBoardDragMove(
      String(event.active.id),
      targetStageId,
      loadedBoardContacts.memberships.map((membership) => ({
        membershipId: membership.id,
        stageId: membership.stageId
      }))
    );

    if (!move) return;

    const membership = loadedBoardContacts.memberships.find(
      (entry) => entry.id === move.membershipId
    );

    if (membership) {
      await handleMoveMembershipToStage(membership, move.stageId);
    }
  }

  return (
    <section className="module-page contacts-page" aria-label="Contatos">
      <header className="module-header">
        <div>
          <p className="eyebrow">Prymeira Talk</p>
          <h1>Contatos</h1>
        </div>
        <button
          className="primary-button"
          onClick={() => setCreateDrawerOpen(true)}
          type="button"
        >
          <Plus size={16} aria-hidden="true" />
          Novo contato
        </button>
      </header>

      <div className="contacts-toolbar">
        <label className="search-field">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label="Buscar contatos"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nome, telefone, email ou empresa"
            type="search"
            value={search}
          />
        </label>
        <div className="segmented-control" aria-label="Visualização de contatos">
          <button
            className={viewMode === "list" ? "is-active" : ""}
            onClick={() => setViewMode("list")}
            type="button"
          >
            <Users size={16} aria-hidden="true" />
            Lista
          </button>
          <button
            className={viewMode === "board" ? "is-active" : ""}
            onClick={() => setViewMode("board")}
            type="button"
          >
            <Columns3 size={16} aria-hidden="true" />
            Board
          </button>
        </div>
      </div>

      <div className="contacts-stats-row" aria-label="Resumo de contatos">
        <span className="contacts-stat">
          <strong>{contacts.length}</strong>
          <span>Total</span>
        </span>
        <span className="contacts-stat">
          <strong>{contactsWithEmail}</strong>
          <span>Com email</span>
        </span>
        <span className="contacts-stat">
          <strong>{recentlyUpdated}</strong>
          <span>Atualizados (7d)</span>
        </span>
      </div>

      <section className="module-panel" style={{ margin: '0 8px 8px', borderRadius: 'var(--radius-lg)' }}>
            <div className="panel-title-row">
              <h2>{viewMode === "list" ? "Lista de contatos" : "Board de contatos"}</h2>
              <span>{contactsWithCompany} com empresa</span>
            </div>

            {isLoading ? <p className="list-note">Carregando contatos...</p> : null}
            {error ? <p className="error-note">{error}</p> : null}
            {boardError && viewMode === "board" ? <p className="error-note">{boardError}</p> : null}
            {saveMessage ? <p className="success-note">{saveMessage}</p> : null}

            {viewMode === "list" && !isLoading && contacts.length === 0 ? (
              <div className="empty-panel">
                <Users size={28} aria-hidden="true" />
                <h3>Nenhum contato encontrado</h3>
                <p>Crie um contato local para iniciar sua base do Talk.</p>
              </div>
            ) : null}

            {viewMode === "list" && contacts.length > 0 ? (
              <div className="contacts-table" role="table" aria-label="Contatos locais">
                <div className="contacts-table-head" role="row">
                  <span role="columnheader">Contato</span>
                  <span role="columnheader">Telefone</span>
                  <span role="columnheader">Empresa</span>
                  <span role="columnheader">Atualizado</span>
                  <span role="columnheader">Acao</span>
                </div>
                {contacts.map((contact) => (
                  <button
                    className={
                      contact.id === selectedContactId
                        ? "contacts-row is-selected"
                        : "contacts-row"
                    }
                    key={contact.id}
                    onClick={() => { setSelectedContactId(contact.id); openDrawer(contact); }}
                    role="row"
                    type="button"
                  >
                    <span className="contacts-person" role="cell">
                      <span className="contact-avatar" aria-hidden="true">{initials(contact)}</span>
                      <span>
                        <strong>{contactName(contact)}</strong>
                        <small>{contact.email ?? "Sem email"}</small>
                      </span>
                    </span>
                    <span role="cell">{contact.phone}</span>
                    <span role="cell">{contact.company ?? "Sem empresa"}</span>
                    <span role="cell">{formatDate(contact.updatedAt)}</span>
                    <span role="cell" className="row-action">
                      <Pencil size={15} aria-hidden="true" />
                    </span>
                  </button>
                ))}
              </div>
            ) : null}

            {viewMode === "board" ? (
              <div className="board-view">
                <div className="board-command-bar">
                  <label className="board-active-select">
                    <span>Board ativo</span>
                    <select
                      disabled={isBoardLoading || boards.length === 0}
                      onChange={(event) => setSelectedBoardId(event.target.value)}
                      value={selectedBoardId ?? ""}
                    >
                      {boards.length === 0 ? <option value="">Sem board</option> : null}
                      {boards.map((board) => (
                        <option key={board.id} value={board.id}>
                          {board.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="board-rule-summary" aria-label="Regras do board selecionado">
                    {selectedBoard?.channels.length ? (
                      selectedBoard.channels.map((channel) => (
                        <span className="board-rule-chip" key={channel.id}>
                          {formatBoardChannelLabel(channel)}
                        </span>
                      ))
                    ) : (
                      <span className="board-rule-chip is-muted">Sem canais</span>
                    )}
                    {selectedBoard?.isPrimaryPipeline ? (
                      <span className="board-rule-chip is-primary">Funil principal</span>
                    ) : null}
                  </div>

                  <div className="board-command-actions" aria-label="Acoes do board">
                    <button
                      className={boardPanelMode === "create-board" ? "is-active" : ""}
                      onClick={() =>
                        setBoardPanelMode((current) =>
                          current === "create-board" ? null : "create-board"
                        )
                      }
                      type="button"
                    >
                      <Plus size={16} aria-hidden="true" />
                      Novo board
                    </button>
                    <button
                      className={boardPanelMode === "edit-board" ? "is-active" : ""}
                      disabled={!selectedBoard}
                      onClick={() =>
                        setBoardPanelMode((current) =>
                          current === "edit-board" ? null : "edit-board"
                        )
                      }
                      type="button"
                    >
                      <Pencil size={16} aria-hidden="true" />
                      Gerenciar
                    </button>
                    <button
                      className={boardPanelMode === "create-stage" ? "is-active" : ""}
                      disabled={!selectedBoard}
                      onClick={() =>
                        setBoardPanelMode((current) =>
                          current === "create-stage" ? null : "create-stage"
                        )
                      }
                      type="button"
                    >
                      <Columns3 size={16} aria-hidden="true" />
                      Nova etapa
                    </button>
                    <button
                      className={boardPanelMode === "add-contact" ? "is-active" : ""}
                      disabled={!selectedBoard || boardStages.length === 0}
                      onClick={() =>
                        setBoardPanelMode((current) =>
                          current === "add-contact" ? null : "add-contact"
                        )
                      }
                      type="button"
                    >
                      <Users size={16} aria-hidden="true" />
                      Adicionar contato
                    </button>
                    <button
                      className={boardPanelMode === "sync-rules" ? "is-active" : ""}
                      disabled={!selectedBoard}
                      onClick={() =>
                        setBoardPanelMode((current) =>
                          current === "sync-rules" ? null : "sync-rules"
                        )
                      }
                      type="button"
                    >
                      <RefreshCw size={16} aria-hidden="true" />
                      Sincronizar
                    </button>
                  </div>
                </div>

                {boardPanelMode ? (
                  <div className="board-panel">
                    <div className="board-panel-heading">
                      <strong>
                        {boardPanelMode === "create-board"
                          ? "Novo board"
                          : boardPanelMode === "edit-board"
                            ? "Gerenciar board"
                            : boardPanelMode === "create-stage"
                              ? "Nova etapa"
                              : boardPanelMode === "sync-rules"
                                ? "Sincronizar regras"
                              : "Adicionar contato"}
                      </strong>
                      {boards.length > 0 ? (
                        <div className="board-panel-heading-actions">
                          {boardPanelMode === "create-stage" && boardStages.length > 0 ? (
                            <button
                              className="panel-save-button"
                              disabled={isBoardSaving}
                              onClick={() => void handleUpdateAllStages()}
                              type="button"
                            >
                              <Save size={15} aria-hidden="true" />
                              Salvar atualizações
                            </button>
                          ) : null}
                          <button
                            aria-label="Fechar painel"
                            onClick={() => setBoardPanelMode(null)}
                            type="button"
                          >
                            Fechar
                          </button>
                        </div>
                      ) : null}
                    </div>

                    {boardPanelMode === "create-board" ? (
                      <form className="board-create-form" onSubmit={handleCreateBoard}>
                        <label>
                          Nome
                          <input
                            disabled={isBoardSaving}
                            onChange={(event) =>
                              setNewBoardForm((current) => ({
                                ...current,
                                name: event.target.value
                              }))
                            }
                            placeholder="Ex: Vendas WhatsApp"
                            value={newBoardForm.name}
                          />
                        </label>
                        <label>
                          Descrição
                          <input
                            disabled={isBoardSaving}
                            onChange={(event) =>
                              setNewBoardForm((current) => ({
                                ...current,
                                description: event.target.value
                              }))
                            }
                            placeholder="Opcional"
                            value={newBoardForm.description}
                          />
                        </label>
                        <fieldset className="board-rules-fieldset">
                          <legend>Regras do board</legend>
                          <label className="board-toggle-row">
                            <input
                              checked={newBoardForm.isPrimaryPipeline}
                              disabled={isBoardSaving}
                              onChange={(event) =>
                                setNewBoardForm((current) => ({
                                  ...current,
                                  isPrimaryPipeline: event.target.checked
                                }))
                              }
                              type="checkbox"
                            />
                            Funil principal
                          </label>
                          <div className="board-checkbox-grid">
                            {channels.length === 0 ? (
                              <span className="board-empty-inline">Sem canais configurados</span>
                            ) : null}
                            {channels.map((channel) => (
                              <label key={channel.id}>
                                <input
                                  checked={newBoardForm.channelIds.includes(channel.id)}
                                  disabled={isBoardSaving}
                                  onChange={(event) =>
                                    toggleBoardChannel("new", channel.id, event.target.checked)
                                  }
                                  type="checkbox"
                                />
                                {channel.displayName ?? channel.phoneNumber ?? channel.provider}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <button
                          className="secondary-button icon-button-label"
                          disabled={isBoardSaving || !newBoardForm.name.trim()}
                          type="submit"
                        >
                          <Plus size={16} aria-hidden="true" />
                          Criar board
                        </button>
                      </form>
                    ) : null}

                    {boardPanelMode === "edit-board" ? (
                      <form className="board-edit-form" onSubmit={handleUpdateBoard}>
                        <label>
                          Nome
                          <input
                            disabled={!selectedBoard || isBoardSaving}
                            onChange={(event) =>
                              setBoardEditForm((current) => ({
                                ...current,
                                name: event.target.value
                              }))
                            }
                            value={boardEditForm.name}
                          />
                        </label>
                        <label>
                          Descrição
                          <input
                            disabled={!selectedBoard || isBoardSaving}
                            onChange={(event) =>
                              setBoardEditForm((current) => ({
                                ...current,
                                description: event.target.value
                              }))
                            }
                            value={boardEditForm.description}
                          />
                        </label>
                        <fieldset className="board-rules-fieldset">
                          <legend>Regras do board</legend>
                          <label className="board-toggle-row">
                            <input
                              checked={boardEditForm.isPrimaryPipeline}
                              disabled={!selectedBoard || isBoardSaving}
                              onChange={(event) =>
                                setBoardEditForm((current) => ({
                                  ...current,
                                  isPrimaryPipeline: event.target.checked
                                }))
                              }
                              type="checkbox"
                            />
                            Funil principal
                          </label>
                          <div className="board-checkbox-grid">
                            {channels.length === 0 ? (
                              <span className="board-empty-inline">Sem canais configurados</span>
                            ) : null}
                            {channels.map((channel) => (
                              <label key={channel.id}>
                                <input
                                  checked={boardEditForm.channelIds.includes(channel.id)}
                                  disabled={!selectedBoard || isBoardSaving}
                                  onChange={(event) =>
                                    toggleBoardChannel("edit", channel.id, event.target.checked)
                                  }
                                  type="checkbox"
                                />
                                {channel.displayName ?? channel.phoneNumber ?? channel.provider}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <div className="board-management-actions">
                          <button
                            className="secondary-button icon-button-label"
                            disabled={!selectedBoard || isBoardSaving || !boardEditForm.name.trim()}
                            type="submit"
                          >
                            <Save size={16} aria-hidden="true" />
                            Salvar
                          </button>
                          <button
                            className="secondary-button danger-button icon-button-label"
                            disabled={!selectedBoard || isBoardSaving}
                            onClick={() => void handleDeleteBoard()}
                            type="button"
                          >
                            <Trash2 size={16} aria-hidden="true" />
                            Apagar
                          </button>
                        </div>
                      </form>
                    ) : null}

                    {boardPanelMode === "create-stage" ? (
                      <form className="board-stage-form" onSubmit={handleCreateStage}>
                        <label>
                          Nome
                          <input
                            disabled={!selectedBoard || isBoardSaving}
                            onChange={(event) =>
                              setNewStageForm((current) => ({
                                ...current,
                                name: event.target.value
                              }))
                            }
                            placeholder="Ex: Qualificado"
                            value={newStageForm.name}
                          />
                        </label>
                        <label>
                          Cor
                          <input
                            disabled={!selectedBoard || isBoardSaving}
                            onChange={(event) =>
                              setNewStageForm((current) => ({
                                ...current,
                                color: event.target.value
                              }))
                            }
                            type="color"
                            value={newStageForm.color}
                          />
                        </label>
                        <div className="stage-tag-picker" aria-label="Tags que movem para esta etapa">
                          {tags.length === 0 ? (
                            <span className="board-empty-inline">Sem tags criadas</span>
                          ) : null}
                          {tags.map((tag) => (
                            <label key={tag.id}>
                              <input
                                checked={newStageForm.tagIds.includes(tag.id)}
                                disabled={!selectedBoard || isBoardSaving}
                                onChange={(event) => toggleStageTag("new", tag.id, event.target.checked)}
                                type="checkbox"
                              />
                              <span style={{ backgroundColor: tag.color }} aria-hidden="true" />
                              {tag.name}
                            </label>
                          ))}
                        </div>
                        <button
                          className="secondary-button icon-button-label"
                          disabled={!selectedBoard || isBoardSaving || !newStageForm.name.trim()}
                          type="submit"
                        >
                          <Plus size={16} aria-hidden="true" />
                          Criar etapa
                        </button>
                        {boardStages.length > 0 ? (
                          <div className="stage-management-list">
                            {boardStages.map((stage, stageIndex) => (
                              <div className="stage-management-row" key={stage.id}>
                                <label>
                                  Nome
                                  <input
                                    disabled={isBoardSaving}
                                    onChange={(event) =>
                                      setStageEditForms((current) => ({
                                        ...current,
                                        [stage.id]: {
                                          ...(current[stage.id] ?? {
                                            name: stage.name,
                                            color: stage.color,
                                            tagIds: stage.tagTriggers.map((tag) => tag.id)
                                          }),
                                          name: event.target.value
                                        }
                                      }))
                                    }
                                    value={stageEditForms[stage.id]?.name ?? stage.name}
                                  />
                                </label>
                                <label>
                                  Cor
                                  <input
                                    disabled={isBoardSaving}
                                    onChange={(event) =>
                                      setStageEditForms((current) => ({
                                        ...current,
                                        [stage.id]: {
                                          ...(current[stage.id] ?? {
                                            name: stage.name,
                                            color: stage.color,
                                            tagIds: stage.tagTriggers.map((tag) => tag.id)
                                          }),
                                          color: event.target.value
                                        }
                                      }))
                                    }
                                    type="color"
                                    value={stageEditForms[stage.id]?.color ?? stage.color}
                                  />
                                </label>
                                <div className="stage-tag-picker">
                                  {tags.map((tag) => (
                                    <label key={tag.id}>
                                      <input
                                        checked={(stageEditForms[stage.id]?.tagIds ?? []).includes(tag.id)}
                                        disabled={isBoardSaving}
                                        onChange={(event) =>
                                          toggleStageTag(stage.id, tag.id, event.target.checked)
                                        }
                                        type="checkbox"
                                      />
                                      <span style={{ backgroundColor: tag.color }} aria-hidden="true" />
                                      {tag.name}
                                    </label>
                                  ))}
                                </div>
                                <div className="stage-management-actions">
                                  <button
                                    aria-label="Mover etapa para esquerda"
                                    disabled={stageIndex === 0 || isBoardSaving}
                                    onClick={() => void handleReorderStage(stage, -1)}
                                    type="button"
                                  >
                                    <ChevronLeft size={15} aria-hidden="true" />
                                  </button>
                                  <button
                                    aria-label="Mover etapa para direita"
                                    disabled={stageIndex === boardStages.length - 1 || isBoardSaving}
                                    onClick={() => void handleReorderStage(stage, 1)}
                                    type="button"
                                  >
                                    <ChevronRight size={15} aria-hidden="true" />
                                  </button>
                                  <button
                                    aria-label="Salvar etapa"
                                    disabled={isBoardSaving || !stageEditForms[stage.id]?.name.trim()}
                                    onClick={() => void handleUpdateStage(stage.id)}
                                    type="button"
                                  >
                                    <Save size={15} aria-hidden="true" />
                                  </button>
                                  <button
                                    aria-label="Apagar etapa"
                                    disabled={isBoardSaving || (membershipsByStage.get(stage.id) ?? []).length > 0}
                                    onClick={() => void handleDeleteStage(stage)}
                                    type="button"
                                  >
                                    <Trash2 size={15} aria-hidden="true" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </form>
                    ) : null}

                    {boardPanelMode === "add-contact" ? (
                      <form className="board-add-form" onSubmit={handleAddContactToBoard}>
                        <label>
                          Contato
                          <select
                            disabled={
                              !loadedBoardContacts ||
                              availableBoardContacts.length === 0 ||
                              isBoardLoading ||
                              isBoardSaving
                            }
                            onChange={(event) => setAddContactId(event.target.value)}
                            value={addContactId}
                          >
                            {availableBoardContacts.map((contact) => (
                              <option key={contact.id} value={contact.id}>
                                {contactName(contact)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Etapa
                          <select
                            disabled={
                              !loadedBoardContacts ||
                              loadedBoardStages.length === 0 ||
                              isBoardLoading ||
                              isBoardSaving
                            }
                            onChange={(event) => setAddStageId(event.target.value)}
                            value={addStageId}
                          >
                            {loadedBoardStages.map((stage) => (
                              <option key={stage.id} value={stage.id}>
                                {stage.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="secondary-button icon-button-label"
                          disabled={!canSubmitBoardAdd}
                          type="submit"
                        >
                          <Plus size={16} aria-hidden="true" />
                          Adicionar
                        </button>
                      </form>
                    ) : null}

                    {boardPanelMode === "sync-rules" ? (
                      <form className="board-sync-form" onSubmit={handleSyncBoardRules}>
                        <label>
                          Escopo
                          <select
                            disabled={!selectedBoard || isBoardSaving}
                            onChange={(event) => setSyncScope(event.target.value as BoardSyncScope)}
                            value={syncScope}
                          >
                            <option value="active">Ativas</option>
                            <option value="closed">Finalizadas</option>
                            <option value="all">Todas</option>
                          </select>
                        </label>
                        <button
                          className="secondary-button icon-button-label"
                          disabled={!selectedBoard || isBoardSaving}
                          type="submit"
                        >
                          <RefreshCw size={16} aria-hidden="true" />
                          Sincronizar agora
                        </button>
                        {syncResult ? (
                          <p className="board-sync-result">
                            {syncResult.evaluated} avaliados, {syncResult.added} adicionados,{" "}
                            {syncResult.moved} movidos, {syncResult.ignored} sem mudança.
                          </p>
                        ) : null}
                      </form>
                    ) : null}
                  </div>
                ) : null}

                {isBoardLoading ? <p className="list-note">Carregando board...</p> : null}

                {!isBoardLoading && boards.length === 0 ? (
                  <div className="board-empty-state">
                    <Columns3 size={28} aria-hidden="true" />
                    <div>
                      <h3>Nenhum board encontrado</h3>
                      <p>Crie o primeiro board para organizar contatos em etapas.</p>
                    </div>
                  </div>
                ) : null}

                {!isBoardLoading && selectedBoard && boardStages.length === 0 ? (
                  <div className="board-empty-state">
                    <Columns3 size={28} aria-hidden="true" />
                    <div>
                      <h3>Board sem etapas</h3>
                      <p>Crie uma etapa para começar a mover contatos.</p>
                    </div>
                    <button
                      className="secondary-button icon-button-label"
                      onClick={() => setBoardPanelMode("create-stage")}
                      type="button"
                    >
                      <Plus size={16} aria-hidden="true" />
                      Criar etapa
                    </button>
                  </div>
                ) : null}

                {boardStages.length > 0 ? (
                  <DndContext
                    collisionDetection={closestCorners}
                    onDragEnd={(event) => void handleBoardDragEnd(event)}
                    onDragStart={handleBoardDragStart}
                    sensors={sensors}
                  >
                    <div className="contacts-board" aria-label="Board de contatos">
                      {boardStages.map((stage, stageIndex) => {
                        const memberships = membershipsByStage.get(stage.id) ?? [];

                        return (
                          <section className="board-column" key={stage.id}>
                            <header>
                              <div className="stage-rich-heading">
                                <span
                                  className="stage-color-swatch"
                                  style={{ backgroundColor: stage.color }}
                                  aria-hidden="true"
                                />
                                <div>
                                  <strong>{stage.name}</strong>
                                  <div className="stage-tag-chips">
                                    {stage.tagTriggers.length > 0 ? (
                                      stage.tagTriggers.map((tag) => (
                                        <span key={tag.id}>{tag.name}</span>
                                      ))
                                    ) : (
                                      <span className="is-muted">Manual</span>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <span className="stage-count-pill">{memberships.length}</span>
                              <div className="stage-actions" aria-label={`Acoes da etapa ${stage.name}`}>
                                <button
                                  aria-label="Mover etapa para esquerda"
                                  disabled={stageIndex === 0 || isBoardSaving}
                                  onClick={() => void handleReorderStage(stage, -1)}
                                  type="button"
                                >
                                  <ChevronLeft size={15} aria-hidden="true" />
                                </button>
                                <button
                                  aria-label="Mover etapa para direita"
                                  disabled={stageIndex === boardStages.length - 1 || isBoardSaving}
                                  onClick={() => void handleReorderStage(stage, 1)}
                                  type="button"
                                >
                                  <ChevronRight size={15} aria-hidden="true" />
                                </button>
                                <button
                                  aria-label="Apagar etapa"
                                  disabled={isBoardSaving || memberships.length > 0}
                                  onClick={() => void handleDeleteStage(stage)}
                                  type="button"
                                >
                                  <Trash2 size={15} aria-hidden="true" />
                                </button>
                              </div>
                            </header>
                            <SortableContext
                              items={memberships.map((membership) => membership.id)}
                              strategy={verticalListSortingStrategy}
                            >
                              <BoardStageDropZone stageId={stage.id}>
                                {memberships.length === 0 ? (
                                  <p className="board-empty-note">Sem contatos nesta etapa.</p>
                                ) : null}
                                {memberships.map((membership) => (
                                  <SortableBoardContact key={membership.id} membership={membership}>
                                    <button
                                      className="board-contact-body"
                                      onClick={() => setSelectedContactId(membership.contactId)}
                                      type="button"
                                    >
                                      <strong>{contactName(membership.contact)}</strong>
                                      <span>{membership.contact.company ?? membership.contact.phone}</span>
                                    </button>
                                    <div className="board-card-actions" aria-label="Mover contato">
                                      <button
                                        aria-label="Mover para etapa anterior"
                                        disabled={stageIndex === 0 || isBoardLoading || isBoardSaving}
                                        onClick={() => void handleMoveMembership(membership, -1)}
                                        type="button"
                                      >
                                        <ChevronLeft size={16} aria-hidden="true" />
                                      </button>
                                      <button
                                        aria-label="Mover para proxima etapa"
                                        disabled={
                                          stageIndex === boardStages.length - 1 ||
                                          isBoardLoading ||
                                          isBoardSaving
                                        }
                                        onClick={() => void handleMoveMembership(membership, 1)}
                                        type="button"
                                      >
                                        <ChevronRight size={16} aria-hidden="true" />
                                      </button>
                                      <button
                                        aria-label="Remover do board"
                                        disabled={isBoardLoading || isBoardSaving}
                                        onClick={() => void handleRemoveMembership(membership)}
                                        type="button"
                                      >
                                        <Trash2 size={16} aria-hidden="true" />
                                      </button>
                                    </div>
                                  </SortableBoardContact>
                                ))}
                              </BoardStageDropZone>
                            </SortableContext>
                          </section>
                        );
                      })}
                    </div>
                    <DragOverlay>
                      {activeBoardMembership ? (
                        <article className="board-contact board-contact-overlay">
                          <strong>{contactName(activeBoardMembership.contact)}</strong>
                          <span>
                            {activeBoardMembership.contact.company ?? activeBoardMembership.contact.phone}
                          </span>
                        </article>
                      ) : null}
                    </DragOverlay>
                  </DndContext>
                ) : null}
              </div>
            ) : null}
          </section>
      {/* Drawer de contato */}
      {drawerContact ? (
        <>
          <div
            className="contact-drawer-overlay"
            onClick={closeDrawer}
            aria-hidden="true"
          />
          <aside
            className="contact-drawer is-open"
            aria-label="Detalhes do contato"
          >
            <header className="contact-drawer-header">
              <span className="context-card-title">Contato</span>
              <button
                className="drawer-close"
                onClick={closeDrawer}
                type="button"
                aria-label="Fechar"
              >
                ✕
              </button>
            </header>
            <div className="contact-drawer-body">
              {/* Card identidade */}
              <div className="context-card context-card--identity">
                <div className="context-identity-avatar" aria-hidden="true">
                  {initials(drawerContact)}
                </div>
                <div>
                  <div className="context-identity-name">{contactName(drawerContact)}</div>
                  {drawerContact.company ? (
                    <div className="context-identity-sub">{drawerContact.company}</div>
                  ) : null}
                </div>
              </div>
              <div className="context-card">
                <div className="context-card-title">Atendimento</div>
                <div className="drawer-action-stack">
                  {channels.length > 1 ? (
                    <label className="drawer-field">
                      <span>Canal</span>
                      <select
                        onChange={(event) => setStartChannelId(event.target.value)}
                        value={startChannelId}
                      >
                        {channels.map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            {channel.displayName ?? channel.phoneNumber ?? `Canal ${channel.id.slice(0, 8)}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <button
                    className="primary-button"
                    disabled={!startChannelId || isStartingConversation}
                    onClick={() => void handleStartConversation()}
                    type="button"
                    style={{ width: "100%", justifyContent: "center" }}
                  >
                    <MessageSquarePlus size={15} aria-hidden="true" />
                    Iniciar conversa
                  </button>
                  {channels.length === 0 ? (
                    <p className="context-empty-label">Crie um canal WhatsApp antes de iniciar conversa.</p>
                  ) : null}
                </div>
              </div>
              {/* Card detalhes */}
              <div className="context-card">
                <div className="context-card-title">Detalhes</div>
                <dl className="context-rows">
                  <div className="context-row">
                    <dt>Telefone</dt>
                    <dd>{drawerContact.phone}</dd>
                  </div>
                  {drawerContact.email ? (
                    <div className="context-row">
                      <dt>Email</dt>
                      <dd>{drawerContact.email}</dd>
                    </div>
                  ) : null}
                  {drawerContact.company ? (
                    <div className="context-row">
                      <dt>Empresa</dt>
                      <dd>{drawerContact.company}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>
              {/* Card editar */}
              <div className="context-card">
                <div className="context-card-title">Editar contato</div>
                <form className="drawer-edit-form" onSubmit={handleUpdateContact}>
                  <label className="drawer-field">
                    <span>Nome</span>
                    <input
                      onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))}
                      placeholder="Nome do contato"
                      type="text"
                      value={editForm.name}
                    />
                  </label>
                  <label className="drawer-field">
                    <span>Telefone</span>
                    <input
                      onChange={(event) => setEditForm((current) => ({ ...current, phone: event.target.value }))}
                      placeholder="+5511999990000"
                      required
                      type="tel"
                      value={editForm.phone}
                    />
                  </label>
                  <label className="drawer-field">
                    <span>Email</span>
                    <input
                      onChange={(event) => setEditForm((current) => ({ ...current, email: event.target.value }))}
                      placeholder="nome@empresa.com"
                      type="email"
                      value={editForm.email}
                    />
                  </label>
                  <label className="drawer-field">
                    <span>Empresa</span>
                    <input
                      onChange={(event) => setEditForm((current) => ({ ...current, company: event.target.value }))}
                      placeholder="Empresa"
                      type="text"
                      value={editForm.company}
                    />
                  </label>
                  {saveMessage ? <p className="success-note compact">{saveMessage}</p> : null}
                  {error ? <p className="error-note compact">{error}</p> : null}
                  <button
                    className="primary-button"
                    disabled={isSaving}
                    type="submit"
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    <Save size={15} aria-hidden="true" />
                    Salvar
                  </button>
                </form>
              </div>
            </div>
          </aside>
        </>
      ) : null}
      {/* Drawer criar contato */}
      {createDrawerOpen ? (
        <>
          <div
            className="contact-drawer-overlay"
            onClick={() => { setCreateDrawerOpen(false); }}
            aria-hidden="true"
          />
          <aside
            className="contact-drawer is-open"
            aria-label="Novo contato"
          >
            <header className="contact-drawer-header">
              <span className="context-card-title">Novo contato</span>
              <button
                className="drawer-close"
                onClick={() => setCreateDrawerOpen(false)}
                type="button"
                aria-label="Fechar"
              >
                ✕
              </button>
            </header>
            <div className="contact-drawer-body">
              <div className="context-card">
                <form className="drawer-edit-form" onSubmit={(e) => { void handleCreateContact(e).then(() => setCreateDrawerOpen(false)); }}>
                  <label className="drawer-field">
                    <span>Nome</span>
                    <input
                      onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                      placeholder="Nome do contato"
                      type="text"
                      value={createForm.name}
                    />
                  </label>
                  <label className="drawer-field">
                    <span>Telefone</span>
                    <input
                      onChange={(event) => setCreateForm((current) => ({ ...current, phone: event.target.value }))}
                      placeholder="+5511999990000"
                      required
                      type="tel"
                      value={createForm.phone}
                    />
                  </label>
                  <label className="drawer-field">
                    <span>Email</span>
                    <input
                      onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))}
                      placeholder="nome@empresa.com"
                      type="email"
                      value={createForm.email}
                    />
                  </label>
                  <label className="drawer-field">
                    <span>Empresa</span>
                    <input
                      onChange={(event) => setCreateForm((current) => ({ ...current, company: event.target.value }))}
                      placeholder="Empresa"
                      type="text"
                      value={createForm.company}
                    />
                  </label>
                  {saveMessage ? <p className="success-note compact">{saveMessage}</p> : null}
                  {error ? <p className="error-note compact">{error}</p> : null}
                  <button
                    className="primary-button"
                    disabled={isSaving}
                    type="submit"
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    <Plus size={15} aria-hidden="true" />
                    Criar contato
                  </button>
                </form>
              </div>
            </div>
          </aside>
        </>
      ) : null}
    </section>
  );
}
