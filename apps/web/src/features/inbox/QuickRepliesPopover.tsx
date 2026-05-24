import { Plus, Pencil, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import type { QuickReplyDto } from "../../app/api";

export function quickReplyMatchesQuery(reply: QuickReplyDto, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [reply.title, reply.body, reply.category ?? ""].some((value) =>
    value.toLowerCase().includes(normalizedQuery)
  );
}

export function quickReplyMutationErrorMessage(error: unknown, fallbackMessage: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallbackMessage;
}

interface QuickRepliesPopoverProps {
  replies: QuickReplyDto[];
  isLoading: boolean;
  error: string | null;
  onInsert: (body: string) => void;
  onCreate: (input: { title: string; body: string; category?: string | null }) => Promise<void>;
  onUpdate: (id: string, input: Partial<{ title: string; body: string; category: string | null }>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function QuickRepliesPopover({
  replies,
  isLoading,
  error,
  onInsert,
  onCreate,
  onUpdate,
  onDelete
}: QuickRepliesPopoverProps) {
  const [query, setQuery] = useState("");
  const [editingReply, setEditingReply] = useState<QuickReplyDto | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingReplyId, setDeletingReplyId] = useState<string | null>(null);
  const isMutating = isSubmitting || deletingReplyId !== null;

  const filteredReplies = useMemo(
    () => replies.filter((reply) => quickReplyMatchesQuery(reply, query)),
    [query, replies]
  );

  function startCreate() {
    setMutationError(null);
    setEditingReply(null);
    setTitle("");
    setBody("");
    setCategory("");
  }

  function startEdit(reply: QuickReplyDto) {
    setMutationError(null);
    setEditingReply(reply);
    setTitle(reply.title);
    setBody(reply.body);
    setCategory(reply.category ?? "");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (isSubmitting) return;

    setMutationError(null);
    setIsSubmitting(true);
    try {
      if (editingReply) {
        await onUpdate(editingReply.id, { title, body, category: category || null });
      } else {
        await onCreate({ title, body, category: category || null });
      }
      startCreate();
    } catch (submitError) {
      setMutationError(quickReplyMutationErrorMessage(submitError, "Nao foi possivel salvar mensagem padrao."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (deletingReplyId) return;

    setMutationError(null);
    setDeletingReplyId(id);
    try {
      await onDelete(id);
    } catch (deleteError) {
      setMutationError(quickReplyMutationErrorMessage(deleteError, "Nao foi possivel apagar mensagem padrao."));
    } finally {
      setDeletingReplyId(null);
    }
  }

  return (
    <div className="quick-replies-popover" aria-label="Mensagens padrao">
      <div className="quick-replies-header">
        <strong>Mensagens padrao</strong>
        <button
          type="button"
          className="composer-tool"
          onClick={startCreate}
          aria-label="Nova mensagem padrao"
          disabled={isMutating}
        >
          <Plus size={15} aria-hidden="true" />
        </button>
      </div>
      <input
        className="quick-replies-search"
        placeholder="Buscar por titulo, texto ou categoria"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? <p className="error-note">{error}</p> : null}
      {mutationError ? <p className="error-note">{mutationError}</p> : null}
      {isLoading ? <p className="list-note">Carregando mensagens...</p> : null}
      <div className="quick-replies-list">
        {filteredReplies.map((reply) => (
          <article className="quick-reply-item" key={reply.id}>
            <button
              type="button"
              className="quick-reply-insert"
              onClick={() => onInsert(reply.body)}
              disabled={isMutating}
            >
              <strong>{reply.title}</strong>
              <span>{reply.body}</span>
              {reply.category ? <small>{reply.category}</small> : null}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => startEdit(reply)}
              aria-label="Editar mensagem padrao"
              disabled={isMutating}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button danger"
              onClick={() => void handleDelete(reply.id)}
              aria-label="Apagar mensagem padrao"
              disabled={isMutating}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
      <form className="quick-reply-form" onSubmit={submit}>
        <input
          required
          placeholder="Titulo"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={isSubmitting}
        />
        <input
          placeholder="Categoria"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          disabled={isSubmitting}
        />
        <textarea
          required
          placeholder="Mensagem"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          disabled={isSubmitting}
        />
        <button className="primary-button" type="submit" disabled={isMutating}>
          {editingReply ? "Salvar" : "Criar"}
        </button>
      </form>
    </div>
  );
}
