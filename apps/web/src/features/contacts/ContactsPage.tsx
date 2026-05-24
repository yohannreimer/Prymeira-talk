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
import type { ChannelDto, ContactDto, RealtimeEvent } from "@prymeira-talk/shared";
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  MessageSquarePlus,
  Pencil,
  Plus,
  Save,
  Search,
  Users
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  apiAddContactToBoard,
  apiCreateContact,
  apiGetBoardContacts,
  apiGetBoards,
  apiGetChannels,
  apiGetContacts,
  apiMoveBoardMembership,
  apiStartContactConversation,
  apiUpdateContact,
  type BoardContactCardDto,
  type BoardContactsDto,
  type ContactBoardWithStagesDto
} from "../../app/api";
import { useRealtimeEvents } from "../inbox/useRealtimeEvents";

type ViewMode = "list" | "board";

interface ContactFormState {
  name: string;
  phone: string;
  email: string;
  company: string;
}

const emptyForm: ContactFormState = {
  name: "",
  phone: "",
  email: "",
  company: ""
};

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
  const [addContactId, setAddContactId] = useState("");
  const [addStageId, setAddStageId] = useState("");
  const [realtimeToken, setRealtimeToken] = useState<string | null>(null);
  const [drawerContact, setDrawerContact] = useState<ContactDto | null>(null);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [activeBoardMembershipId, setActiveBoardMembershipId] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
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
        setError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar contatos.");
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
        setBoardError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar boards.");
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
        setBoardError(loadError instanceof Error ? loadError.message : "Nao foi possivel carregar o board.");
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
  const boardStages = loadedBoardContacts?.stages ?? selectedBoard?.stages ?? [];
  const loadedBoardStages = loadedBoardContacts?.stages ?? [];
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
      setError(createError instanceof Error ? createError.message : "Nao foi possivel criar o contato.");
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
      setError(updateError instanceof Error ? updateError.message : "Nao foi possivel atualizar o contato.");
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
      setError(startError instanceof Error ? startError.message : "Nao foi possivel iniciar a conversa.");
    } finally {
      setIsStartingConversation(false);
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
      setSaveMessage("Contato adicionado ao board.");
    } catch (addError) {
      setBoardError(addError instanceof Error ? addError.message : "Nao foi possivel adicionar ao board.");
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
      setBoardError(moveError instanceof Error ? moveError.message : "Nao foi possivel mover no board.");
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
        <div className="segmented-control" aria-label="Visualizacao de contatos">
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
                <div className="board-toolbar">
                  <label>
                    Board
                    <select
                      disabled={isBoardLoading || boards.length === 0}
                      onChange={(event) => setSelectedBoardId(event.target.value)}
                      value={selectedBoardId ?? ""}
                    >
                      {boards.map((board) => (
                        <option key={board.id} value={board.id}>
                          {board.name}
                        </option>
                      ))}
                    </select>
                  </label>

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
                </div>

                {isBoardLoading ? <p className="list-note">Carregando board...</p> : null}

                {!isBoardLoading && boards.length === 0 ? (
                  <div className="empty-panel">
                    <Columns3 size={28} aria-hidden="true" />
                    <h3>Nenhum board encontrado</h3>
                    <p>Crie um board pela API para organizar contatos em etapas.</p>
                  </div>
                ) : null}

                {!isBoardLoading && selectedBoard && boardStages.length === 0 ? (
                  <div className="empty-panel">
                    <Columns3 size={28} aria-hidden="true" />
                    <h3>Board sem etapas</h3>
                    <p>Adicione etapas pela API para iniciar este fluxo.</p>
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
                              <span className="stage-color" style={{ backgroundColor: stage.color }} aria-hidden="true" />
                              <strong>{stage.name}</strong>
                              <span>{memberships.length}</span>
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
